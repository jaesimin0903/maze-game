// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {MazeBet} from "../../src/MazeBet.sol";
import {SigUtils} from "./SigUtils.sol";
import {RejectingPlayer} from "./RejectingPlayer.sol";
import {GasBurnPlayer} from "./GasBurnPlayer.sol";
import {ReturnBombPlayer} from "./ReturnBombPlayer.sol";
import {ReentrantPlayer} from "./ReentrantPlayer.sol";

/// @notice Drives `MazeBet` for the invariant suite. It plays the server (signs tickets and results), the
/// relayer, the house owner and seven players, four of which are hostile contracts.
/// @dev The suite runs with `fail-on-revert`, so every call below either must succeed or is preceded by an
/// explicit `expectRevert`. In particular a correctly signed `settle` before the deadline and a `reclaim` after
/// it must succeed for every kind of player, inside the relayer's gas budget.
contract Handler is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_ACTIVE = 24;
    /// @dev Relayer gas limit 300,000 minus intrinsic gas and calldata (see `MazeBetBase.RELAYER_EXEC_GAS`).
    uint256 internal constant FINALIZE_GAS = 300_000 - 21_000 - 324 * 16;

    struct Meta {
        address player;
        uint8 tier;
        uint8 n;
        uint256 wager;
        uint256 maxPayout;
        uint256 reserved;
        uint64 deadline;
        bytes32 serverSeed;
    }

    struct Balances {
        uint256 account;
        uint256 pending;
        uint256 house;
    }

    MazeBet public immutable bet;
    address public immutable owner;
    uint256 private immutable _signerKey;
    uint16 private immutable _mazeVersion;

    RejectingPlayer public rejecting;
    GasBurnPlayer public burner;
    ReturnBombPlayer public bomber;
    ReentrantPlayer public reentrant;
    address public houseSink;
    address[] public actors;

    bytes32[] public activeIds;
    bytes32[] public closedIds;
    mapping(bytes32 => Meta) private _meta;
    /// @notice How often a game was settled or reclaimed. Never above one.
    mapping(bytes32 => uint256) public finalizations;

    /// @notice ETH that entered the contract: house funds, bets and forced transfers.
    uint256 public ghostIn;
    /// @notice ETH that left the contract: delivered payouts, withdrawn pending amounts, house withdrawals.
    uint256 public ghostOut;
    uint256 public ghostReservedOpened;
    uint256 public ghostReservedReleased;
    /// @notice What players are owed in total: the signed payout of every settled game, the bet of every
    /// reclaimed one.
    uint256 public ghostEntitled;
    uint256 public ghostPaidDirect;
    uint256 public ghostDeferred;
    uint256 public ghostPendingWithdrawn;

    uint256 private _nonce;

    constructor(MazeBet bet_, address owner_, uint256 signerKey_, uint16 mazeVersion_) {
        bet = bet_;
        owner = owner_;
        _signerKey = signerKey_;
        _mazeVersion = mazeVersion_;

        rejecting = new RejectingPlayer();
        burner = new GasBurnPlayer();
        bomber = new ReturnBombPlayer(1 << 20);
        reentrant = new ReentrantPlayer(address(bet_));
        reentrant.arm(abi.encodeCall(MazeBet.withdrawPending, ()), 0, false);
        houseSink = makeAddr("houseSink");

        actors.push(makeAddr("player1"));
        actors.push(makeAddr("player2"));
        actors.push(makeAddr("player3"));
        actors.push(address(rejecting));
        actors.push(address(burner));
        actors.push(address(bomber));
        actors.push(address(reentrant));

        ghostIn = address(bet_).balance;
    }

    // ----- actions -----

    function createGame(uint256 actorSeed, uint256 tierSeed, uint256 wagerSeed, bytes32 clientSeed) external {
        if (activeIds.length >= MAX_ACTIVE) return;

        Meta memory m;
        m.player = actors[actorSeed % actors.length];
        m.tier = SafeCast.toUint8(tierSeed % bet.tierCount());
        m.wager = bound(wagerSeed, bet.minBet(), bet.maxBet());
        uint32 multiplierBps;
        (m.n, multiplierBps) = bet.tiers(m.tier);
        m.maxPayout = m.wager * multiplierBps / BPS;
        m.reserved = m.maxPayout > m.wager ? m.maxPayout : m.wager;
        m.deadline = _now() + bet.settleWindow();

        bytes32 gameId = keccak256(abi.encode("invariant game", ++_nonce));
        m.serverSeed = keccak256(abi.encode("invariant seed", gameId));
        bytes32 commitment = SigUtils.commitmentOf(_mazeVersion, m.n, m.serverSeed);
        uint64 expiry = _now() + 120;
        bytes memory sig =
            _sign(SigUtils.ticketDigest(_domain(), gameId, m.player, m.tier, commitment, expiry));

        vm.deal(m.player, m.player.balance + m.wager);
        bool backed = address(bet).balance + m.wager >= bet.totalReserved() + bet.totalPending() + m.reserved;
        if (!backed) {
            vm.expectRevert(MazeBet.InsufficientLiquidity.selector);
            vm.prank(m.player);
            bet.createGame{value: m.wager}(gameId, m.tier, commitment, expiry, clientSeed, sig);
            return;
        }
        vm.prank(m.player);
        bet.createGame{value: m.wager}(gameId, m.tier, commitment, expiry, clientSeed, sig);

        MazeBet.Game memory game = bet.getGame(gameId);
        assertEq(game.reserved, m.reserved, "reserved == max(bet, maxPayout)");
        assertEq(game.settleDeadline, m.deadline, "deadline");

        _meta[gameId] = m;
        activeIds.push(gameId);
        ghostIn += m.wager;
        ghostReservedOpened += m.reserved;
    }

    /// @dev A correctly signed result for a random active game, submitted by a random caller.
    function settle(uint256 gameSeed, uint256 outcomeSeed, uint256 stepSeed, uint256 callerSeed) external {
        if (activeIds.length == 0) return;
        uint256 index = gameSeed % activeIds.length;
        bytes32 gameId = activeIds[index];
        Meta memory m = _meta[gameId];

        (uint8 outcome, uint16 steps, uint256 payout) = _result(m, outcomeSeed, stepSeed);
        bytes memory sig =
            _sign(SigUtils.settlementDigest(_domain(), gameId, m.player, outcome, steps, payout, m.serverSeed));
        address caller = _caller(callerSeed);

        if (_now() > m.deadline) {
            vm.expectRevert(MazeBet.DeadlinePassed.selector);
            vm.prank(caller);
            bet.settle(gameId, outcome, steps, payout, m.serverSeed, sig);
            return;
        }

        Balances memory before = _balances(m.player);
        vm.prank(caller);
        bet.settle{gas: FINALIZE_GAS}(gameId, outcome, steps, payout, m.serverSeed, sig);
        _recordPayment(m.player, before, payout);
        _close(index, gameId, m.reserved);
    }

    function reclaim(uint256 gameSeed, uint256 callerSeed) external {
        if (activeIds.length == 0) return;
        uint256 index = gameSeed % activeIds.length;
        bytes32 gameId = activeIds[index];
        Meta memory m = _meta[gameId];
        address caller = _caller(callerSeed);

        if (_now() <= m.deadline) {
            vm.expectRevert(MazeBet.DeadlineNotReached.selector);
            vm.prank(caller);
            bet.reclaim(gameId);
            return;
        }

        Balances memory before = _balances(m.player);
        vm.prank(caller);
        bet.reclaim{gas: FINALIZE_GAS}(gameId);
        _recordPayment(m.player, before, m.wager);
        _close(index, gameId, m.reserved);
    }

    /// @dev A second settlement or a reclaim of a game that is already finalized.
    function refinalize(uint256 gameSeed, bool viaReclaim, uint256 callerSeed) external {
        if (closedIds.length == 0) return;
        bytes32 gameId = closedIds[gameSeed % closedIds.length];
        Meta memory m = _meta[gameId];
        address caller = _caller(callerSeed);

        if (viaReclaim) {
            vm.expectRevert(MazeBet.GameNotActive.selector);
            vm.prank(caller);
            bet.reclaim(gameId);
            return;
        }
        bytes memory sig =
            _sign(SigUtils.settlementDigest(_domain(), gameId, m.player, 0, _shortestPath(m), m.maxPayout, m.serverSeed));
        vm.expectRevert(MazeBet.GameNotActive.selector);
        vm.prank(caller);
        bet.settle(gameId, 0, _shortestPath(m), m.maxPayout, m.serverSeed, sig);
    }

    function withdrawPending(uint256 actorSeed, bool cooperate) external {
        address actor = actors[actorSeed % actors.length];
        uint256 pending = bet.pendingWithdrawals(actor);
        if (pending == 0) {
            vm.expectRevert(MazeBet.NothingToWithdraw.selector);
            vm.prank(actor);
            bet.withdrawPending();
            return;
        }

        bool refuses = !cooperate && (actor == address(rejecting) || actor == address(burner));
        if (refuses) {
            vm.expectRevert(bytes(""));
            vm.prank(actor);
            bet.withdrawPending{gas: 200_000}();
            assertEq(bet.pendingWithdrawals(actor), pending, "a failed withdrawal leaves the amount pending");
            return;
        }

        _setCooperative(true);
        uint256 accountBefore = actor.balance;
        uint256 houseBefore = address(bet).balance;
        vm.prank(actor);
        bet.withdrawPending();
        _setCooperative(false);

        assertEq(actor.balance - accountBefore, pending, "the whole pending amount is paid");
        assertEq(houseBefore - address(bet).balance, pending, "and nothing more");
        assertEq(bet.pendingWithdrawals(actor), 0);
        ghostPendingWithdrawn += pending;
        ghostOut += pending;
    }

    function fund(uint256 amount, bool viaReceive) external {
        amount = bound(amount, 0, 3 ether);
        address funder = makeAddr("funder");
        vm.deal(funder, amount);
        vm.prank(funder);
        if (viaReceive) {
            (bool ok,) = address(bet).call{value: amount}("");
            assertTrue(ok, "receive");
        } else {
            bet.fund{value: amount}();
        }
        ghostIn += amount;
    }

    function withdrawHouse(uint256 amount, bool tooMuch) external {
        uint256 available = bet.availableLiquidity();
        if (tooMuch) {
            amount = available + bound(amount, 1, 1 ether);
            vm.expectRevert(MazeBet.ExceedsAvailable.selector);
            vm.prank(owner);
            bet.withdrawHouse(amount, houseSink);
            return;
        }
        amount = bound(amount, 0, available);
        uint256 sinkBefore = houseSink.balance;
        vm.prank(owner);
        bet.withdrawHouse(amount, houseSink);
        assertEq(houseSink.balance - sinkBefore, amount, "house withdrawal");
        ghostOut += amount;
    }

    function warp(uint256 secondsForward) external {
        vm.warp(vm.getBlockTimestamp() + bound(secondsForward, 1, 900));
    }

    /// @dev ETH that arrives without calling the contract (self-destruct, block reward).
    function forceEther(uint256 amount) external {
        amount = bound(amount, 0, 1 ether);
        vm.deal(address(bet), address(bet).balance + amount);
        ghostIn += amount;
    }

    /// @dev End of a run: every open game is reclaimed, every pending amount withdrawn, the house emptied.
    function drain() external {
        vm.warp(vm.getBlockTimestamp() + bet.settleWindow() + 1);
        while (activeIds.length > 0) {
            uint256 index = activeIds.length - 1;
            bytes32 gameId = activeIds[index];
            Meta memory m = _meta[gameId];
            Balances memory before = _balances(m.player);
            bet.reclaim{gas: FINALIZE_GAS}(gameId);
            _recordPayment(m.player, before, m.wager);
            _close(index, gameId, m.reserved);
        }
        assertEq(bet.totalReserved(), 0, "no active game, nothing reserved");

        _setCooperative(true);
        for (uint256 i = 0; i < actors.length; ++i) {
            uint256 pending = bet.pendingWithdrawals(actors[i]);
            if (pending == 0) continue;
            vm.prank(actors[i]);
            bet.withdrawPending();
            ghostPendingWithdrawn += pending;
            ghostOut += pending;
        }
        assertEq(bet.totalPending(), 0, "every pending amount was withdrawable");

        uint256 rest = address(bet).balance;
        assertEq(bet.availableLiquidity(), rest, "what is left belongs to the house");
        vm.prank(owner);
        bet.withdrawHouse(rest, houseSink);
        ghostOut += rest;
        assertEq(address(bet).balance, 0, "nothing is stuck");
    }

    // ----- views for the invariants -----

    function activeCount() external view returns (uint256) {
        return activeIds.length;
    }

    function closedCount() external view returns (uint256) {
        return closedIds.length;
    }

    function sumOfPendingWithdrawals() external view returns (uint256 sum) {
        for (uint256 i = 0; i < actors.length; ++i) {
            sum += bet.pendingWithdrawals(actors[i]);
        }
        sum += bet.pendingWithdrawals(houseSink) + bet.pendingWithdrawals(owner);
    }

    // ----- internals -----

    function _result(Meta memory m, uint256 outcomeSeed, uint256 stepSeed)
        private
        view
        returns (uint8 outcome, uint16 steps, uint256 payout)
    {
        uint256 cells = uint256(m.n) * m.n;
        outcome = SafeCast.toUint8(outcomeSeed % 3);
        if (outcome == 0) {
            steps = SafeCast.toUint16(bound(stepSeed, _shortestPath(m), cells - 1));
            payout = m.maxPayout;
        } else if (outcome == 1) {
            steps = SafeCast.toUint16(bound(stepSeed, 0, cells - 2));
            payout = m.wager * bet.refundBps(m.tier, steps) / BPS;
        } else {
            steps = SafeCast.toUint16(bound(stepSeed, 1, type(uint16).max));
            payout = 0;
        }
    }

    function _shortestPath(Meta memory m) private pure returns (uint16) {
        return 2 * (uint16(m.n) - 1);
    }

    function _balances(address player) private view returns (Balances memory) {
        return Balances({
            account: player.balance,
            pending: bet.pendingWithdrawals(player),
            house: address(bet).balance
        });
    }

    /// @dev The player receives exactly `amount`, as a transfer or as a pending withdrawal, never both.
    function _recordPayment(address player, Balances memory before, uint256 amount) private {
        uint256 direct = player.balance - before.account;
        uint256 deferred = bet.pendingWithdrawals(player) - before.pending;
        assertEq(direct + deferred, amount, "the player is credited exactly the amount owed");
        assertTrue(direct == 0 || deferred == 0, "either delivered or deferred");
        assertEq(before.house - address(bet).balance, direct, "only delivered money leaves the contract");

        ghostEntitled += amount;
        ghostPaidDirect += direct;
        ghostDeferred += deferred;
        ghostOut += direct;
    }

    function _close(uint256 index, bytes32 gameId, uint256 reserved) private {
        activeIds[index] = activeIds[activeIds.length - 1];
        activeIds.pop();
        closedIds.push(gameId);
        ghostReservedReleased += reserved;
        assertEq(++finalizations[gameId], 1, "a game is finalized once");
    }

    function _setCooperative(bool on) private {
        rejecting.setAccepting(on);
        burner.setBurning(!on);
    }

    function _caller(uint256 seed) private returns (address) {
        uint256 pick = seed % (actors.length + 1);
        return pick == actors.length ? makeAddr("relayer") : actors[pick];
    }

    function _now() private view returns (uint64) {
        return SafeCast.toUint64(vm.getBlockTimestamp());
    }

    function _domain() private view returns (bytes32) {
        return SigUtils.domainSeparator(vm.getChainId(), address(bet));
    }

    function _sign(bytes32 digest) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_signerKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
