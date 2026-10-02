// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title MazeBet
/// @notice Escrow for the maze betting game (plan §7.4, §7.5). A player stakes ETH on a ticket signed by the
/// game server; the contract reserves the largest amount the game can pay out, and releases it when the server's
/// signed result is submitted (`settle`) or, if no result arrives before the deadline, when anyone calls `reclaim`.
/// @dev Design rules that the money-safety of the contract rests on:
/// - Payouts are checked against the multiplier and refund tables stored at construction, so a signature alone
///   never decides an amount.
/// - Every game reserves `max(bet, maxPayout)`; `balance >= totalReserved + totalPending` holds at all times.
/// - Player payments are a gas-capped call that copies no return data. A failed payment is credited to
///   `pendingWithdrawals` instead of reverting, so a player contract cannot make `settle` revert and thereby force
///   the full-refund `reclaim` path.
/// - `settle` is valid up to and including the deadline, `reclaim` strictly after it: the two windows are disjoint.
contract MazeBet {
    enum Status {
        None,
        Active,
        Settled,
        Reclaimed
    }

    struct Game {
        address player;
        uint8 tier;
        Status status;
        uint64 createdAt; // block timestamp, unix seconds
        uint64 settleDeadline; // block timestamp, unix seconds
        uint128 bet;
        uint128 maxPayout;
        uint128 reserved; // max(bet, maxPayout), fixed at creation
        bytes32 commitment;
        bytes32 clientSeed;
    }

    struct TierInit {
        uint8 n;
        uint32 multiplierBps;
        uint16[] refundBps;
    }

    event GameCreated(
        bytes32 indexed gameId,
        address indexed player,
        uint8 tier,
        uint256 bet,
        uint256 maxPayout,
        bytes32 commitment,
        bytes32 clientSeed,
        uint64 settleDeadline
    );
    event GameSettled(
        bytes32 indexed gameId, address indexed player, uint8 outcome, uint16 steps, uint256 payout, bytes32 serverSeed
    );
    event GameReclaimed(bytes32 indexed gameId, address indexed player, uint256 amount);
    event PayoutDeferred(address indexed player, uint256 amount);
    event HouseFunded(address indexed from, uint256 amount);
    event HouseWithdrawn(address indexed to, uint256 amount);
    event ServerSignerChanged(address indexed signer);

    error InvalidSignature();
    error TicketExpired();
    error GameExists();
    error BetOutOfRange();
    error InvalidTier();
    error InsufficientLiquidity();
    /// @dev Part of the frozen ABI. No code path raises it: a ticket is bound to `msg.sender` through the
    /// signature (a foreign ticket fails with `InvalidSignature`) and `reclaim` is open to any caller.
    error NotPlayer();
    error GameNotActive();
    error DeadlinePassed();
    error DeadlineNotReached();
    error CommitmentMismatch();
    error PayoutMismatch();
    error InvalidOutcome();
    error InvalidSteps();
    error NothingToWithdraw();
    error ExceedsAvailable();
    error NotOwner();
    error InvalidTable();

    /// @dev Gas forwarded to a payment recipient. Fixed, so that the cost of `settle` and `reclaim` is bounded.
    uint256 internal constant PAYOUT_GAS = 30_000;
    uint256 private constant BPS = 10_000;

    uint8 private constant OUTCOME_EXIT = 0;
    uint8 private constant OUTCOME_CASH_OUT = 1;
    uint8 private constant OUTCOME_LOSS = 2;

    /// @dev Domain tag of the seed commitment (plan §3.5).
    bytes32 private constant COMMIT_TAG = keccak256("MazeBet.commit.v1");

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("MazeBet");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant TICKET_TYPEHASH =
        keccak256("Ticket(bytes32 gameId,address player,uint8 tier,bytes32 commitment,uint64 expiry)");
    bytes32 private constant SETTLEMENT_TYPEHASH = keccak256(
        "Settlement(bytes32 gameId,address player,uint8 outcome,uint16 steps,uint256 payout,bytes32 serverSeed)"
    );

    address public immutable owner;
    bytes32 public immutable tableHash;
    uint8 public immutable tierCount;
    uint256 public immutable minBet;
    uint256 public immutable maxBet;
    uint64 public immutable settleWindow;

    uint16 private immutable _mazeVersion;
    uint256 private immutable _deployChainId;
    bytes32 private immutable _deployDomainSeparator;

    address public serverSigner;
    /// @notice Sum of `reserved` over all active games.
    uint256 public totalReserved;
    /// @notice Sum of `pendingWithdrawals` over all accounts.
    uint256 public totalPending;
    /// @notice Payments that could not be delivered and wait for `withdrawPending`.
    mapping(address => uint256) public pendingWithdrawals;

    mapping(bytes32 => Game) private _games;
    TierInit[] private _tiers;

    bool private transient _entered;

    /// @dev Reverts with empty data on re-entry: the frozen ABI has no dedicated error for it.
    modifier nonReentrant() {
        if (_entered) revert();
        _entered = true;
        _;
        _entered = false;
    }

    /// @param tiers_ One entry per maze size. `refundBps[k]` is the cash-out refund after `k` moves.
    /// @dev Reverts with `InvalidTable` unless, for every tier, `refundBps.length == n * n`, the refund table is
    /// strictly decreasing and starts below 100%, and the multiplier is at least 1x. Also rejects `n < 2` (the
    /// step bounds in `settle` need at least two cells per side), an empty or oversized tier list, an empty bet
    /// range, and a `maxBet_` above `type(uint96).max` (keeps `bet * multiplierBps` within `uint128`).
    constructor(
        address owner_,
        address serverSigner_,
        uint32 tableVersion_,
        uint16 mazeVersion_,
        TierInit[] memory tiers_,
        uint256 minBet_,
        uint256 maxBet_,
        uint64 settleWindow_
    ) {
        uint256 count = tiers_.length;
        if (count == 0 || count > type(uint8).max) revert InvalidTable();
        if (minBet_ > maxBet_ || maxBet_ > type(uint96).max) revert InvalidTable();

        for (uint256 i = 0; i < count; ++i) {
            TierInit memory tier = tiers_[i];
            uint256 cells = uint256(tier.n) * tier.n;
            if (tier.n < 2 || tier.multiplierBps < BPS || tier.refundBps.length != cells || tier.refundBps[0] >= BPS)
            {
                revert InvalidTable();
            }
            for (uint256 k = 1; k < cells; ++k) {
                if (tier.refundBps[k] >= tier.refundBps[k - 1]) revert InvalidTable();
            }

            TierInit storage stored = _tiers.push();
            stored.n = tier.n;
            stored.multiplierBps = tier.multiplierBps;
            stored.refundBps = tier.refundBps;
        }

        owner = owner_;
        serverSigner = serverSigner_;
        // casting to 'uint8' is safe because `count <= type(uint8).max` was checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        tierCount = uint8(count);
        minBet = minBet_;
        maxBet = maxBet_;
        settleWindow = settleWindow_;
        tableHash = keccak256(abi.encode(tableVersion_, mazeVersion_, tiers_, minBet_, maxBet_, settleWindow_));

        _mazeVersion = mazeVersion_;
        _deployChainId = block.chainid;
        _deployDomainSeparator = _buildDomainSeparator();
    }

    receive() external payable {
        emit HouseFunded(msg.sender, msg.value);
    }

    // ----- views -----

    function tiers(uint8 tier) external view returns (uint8 n, uint32 multiplierBps) {
        if (tier >= tierCount) revert InvalidTier();
        TierInit storage stored = _tiers[tier];
        return (stored.n, stored.multiplierBps);
    }

    function refundBps(uint8 tier, uint16 step) external view returns (uint16) {
        if (tier >= tierCount) revert InvalidTier();
        uint16[] storage table = _tiers[tier].refundBps;
        if (step >= table.length) revert InvalidSteps();
        return table[step];
    }

    function getGame(bytes32 gameId) external view returns (Game memory) {
        return _games[gameId];
    }

    /// @notice Balance that backs neither an active game nor a pending withdrawal.
    function availableLiquidity() public view returns (uint256) {
        uint256 liabilities = totalReserved + totalPending;
        uint256 balance = address(this).balance;
        return balance > liabilities ? balance - liabilities : 0;
    }

    function quoteExitPayout(uint8 tier, uint256 bet) external view returns (uint256) {
        if (tier >= tierCount) revert InvalidTier();
        return bet * _tiers[tier].multiplierBps / BPS;
    }

    // ----- state-changing -----

    /// @notice Stakes `msg.value` on a server-signed ticket. The ticket binds `msg.sender`, so nobody else can
    /// use it, and `gameId` can be used only once.
    function createGame(
        bytes32 gameId,
        uint8 tier,
        bytes32 commitment,
        uint64 expiry,
        bytes32 clientSeed,
        bytes calldata serverSig
    ) external payable {
        if (block.timestamp > expiry) revert TicketExpired();
        if (_games[gameId].status != Status.None) revert GameExists();
        if (tier >= tierCount) revert InvalidTier();
        if (msg.value < minBet || msg.value > maxBet) revert BetOutOfRange();
        _verify(keccak256(abi.encode(TICKET_TYPEHASH, gameId, msg.sender, tier, commitment, expiry)), serverSig);

        // `msg.value <= maxBet <= type(uint96).max` and `multiplierBps < 2**32`, so `maxPayout` and `reserved`
        // are below 2**128.
        uint256 maxPayout = msg.value * _tiers[tier].multiplierBps / BPS;
        uint256 reserved = maxPayout > msg.value ? maxPayout : msg.value;
        // The balance already includes `msg.value`.
        if (address(this).balance < totalReserved + totalPending + reserved) revert InsufficientLiquidity();
        uint64 settleDeadline = uint64(block.timestamp) + settleWindow;

        _games[gameId] = Game({
            player: msg.sender,
            tier: tier,
            status: Status.Active,
            createdAt: uint64(block.timestamp),
            settleDeadline: settleDeadline,
            bet: uint128(msg.value),
            // casting to 'uint128' is safe because `maxPayout < 2**128` (see above)
            // forge-lint: disable-next-line(unsafe-typecast)
            maxPayout: uint128(maxPayout),
            // casting to 'uint128' is safe because `reserved < 2**128` (see above)
            // forge-lint: disable-next-line(unsafe-typecast)
            reserved: uint128(reserved),
            commitment: commitment,
            clientSeed: clientSeed
        });
        totalReserved += reserved;

        emit GameCreated(gameId, msg.sender, tier, msg.value, maxPayout, commitment, clientSeed, settleDeadline);
    }

    /// @notice Settles a game with the server-signed result. Callable by anyone, up to and including the deadline.
    /// @param outcome 0 = Exit, 1 = CashOut, 2 = Loss.
    function settle(
        bytes32 gameId,
        uint8 outcome,
        uint16 steps,
        uint256 payout,
        bytes32 serverSeed,
        bytes calldata serverSig
    ) external nonReentrant {
        Game storage game = _games[gameId];
        if (game.status != Status.Active) revert GameNotActive();
        if (block.timestamp > game.settleDeadline) revert DeadlinePassed();

        address player = game.player;
        TierInit storage tier = _tiers[game.tier];
        uint8 side = tier.n;
        uint256 n = side;
        uint256 cells = n * n;
        if (outcome == OUTCOME_EXIT) {
            if (steps < 2 * (n - 1) || steps > cells - 1) revert InvalidSteps();
            if (payout != game.maxPayout) revert PayoutMismatch();
        } else if (outcome == OUTCOME_CASH_OUT) {
            if (steps > cells - 2) revert InvalidSteps();
            if (payout != uint256(game.bet) * tier.refundBps[steps] / BPS) revert PayoutMismatch();
        } else if (outcome == OUTCOME_LOSS) {
            if (steps < 1) revert InvalidSteps();
            if (payout != 0) revert PayoutMismatch();
        } else {
            revert InvalidOutcome();
        }

        _verify(
            keccak256(abi.encode(SETTLEMENT_TYPEHASH, gameId, player, outcome, steps, payout, serverSeed)), serverSig
        );
        // 67 bytes: COMMIT_TAG(32) ‖ uint16be(mazeVersion) ‖ uint8(n) ‖ serverSeed(32)
        if (sha256(abi.encodePacked(COMMIT_TAG, _mazeVersion, side, serverSeed)) != game.commitment) {
            revert CommitmentMismatch();
        }

        game.status = Status.Settled;
        totalReserved -= game.reserved;
        emit GameSettled(gameId, player, outcome, steps, payout, serverSeed);

        _pay(player, payout);
    }

    /// @notice Returns the full bet of a game that was not settled in time. Callable by anyone, strictly after
    /// the deadline; the money always goes to the player.
    function reclaim(bytes32 gameId) external nonReentrant {
        Game storage game = _games[gameId];
        if (game.status != Status.Active) revert GameNotActive();
        if (block.timestamp <= game.settleDeadline) revert DeadlineNotReached();

        address player = game.player;
        uint256 amount = game.bet;
        game.status = Status.Reclaimed;
        totalReserved -= game.reserved;
        emit GameReclaimed(gameId, player, amount);

        _pay(player, amount);
    }

    /// @notice Pays out the caller's deferred payments. The only transfer without a gas cap: if the caller
    /// cannot receive it, the call reverts (with empty data) and the balance stays pending.
    function withdrawPending() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender] = 0;
        totalPending -= amount;

        bool ok;
        assembly ("memory-safe") {
            ok := call(gas(), caller(), amount, 0, 0, 0, 0)
        }
        if (!ok) revert();
    }

    function fund() external payable {
        emit HouseFunded(msg.sender, msg.value);
    }

    /// @notice Withdraws house funds that back neither an active game nor a pending withdrawal.
    function withdrawHouse(uint256 amount, address to) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        if (amount > availableLiquidity()) revert ExceedsAvailable();
        emit HouseWithdrawn(to, amount);

        _pay(to, amount);
    }

    function setServerSigner(address signer) external {
        if (msg.sender != owner) revert NotOwner();
        serverSigner = signer;
        emit ServerSignerChanged(signer);
    }

    // ----- internals -----

    /// @dev Never reverts and never copies return data: the recipient gets `PAYOUT_GAS` (plus the EVM's value
    /// stipend) and nothing it does can cost the caller more than that. A failed payment becomes a pending
    /// withdrawal, which keeps the money reserved for the recipient.
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        bool ok;
        assembly ("memory-safe") {
            ok := call(PAYOUT_GAS, to, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            pendingWithdrawals[to] += amount;
            totalPending += amount;
            emit PayoutDeferred(to, amount);
        }
    }

    function _verify(bytes32 structHash, bytes calldata signature) private view {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != serverSigner) revert InvalidSignature();
    }

    /// @dev Rebuilt when the chain id differs from the one at deployment, so signatures do not carry over a fork.
    function _domainSeparator() private view returns (bytes32) {
        return block.chainid == _deployChainId ? _deployDomainSeparator : _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }
}
