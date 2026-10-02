// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {MazeBet} from "../src/MazeBet.sol";
import {MazeBetBase} from "./helpers/BaseTest.sol";
import {RejectingPlayer} from "./helpers/RejectingPlayer.sol";
import {SigUtils} from "./helpers/SigUtils.sol";

/// @notice Unit tests: every function and every revert path of `MazeBet` (plan §7.4, §7.5, AC-C1 .. AC-C10).
contract MazeBetTest is MazeBetBase {
    uint256 internal constant WAGER = 0.01 ether;
    uint256 internal constant OTHER_KEY = 0xBADC0DE;
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    // Cross-language vectors. Produced with viem 2.57.2 (`signTypedData`, `encodeAbiParameters`) and node's sha256,
    // using `EIP712_TYPES` and `mazeBetDomain` from packages/shared/src/eip712.ts, for the table of `_tinyTable()`.
    // packages/shared/test/contract-vectors.test.ts reads these constants and `_tinyTable()` from this file and
    // reproduces the commitment, both digests and the table hash in TypeScript, so both sides pin the same vectors.
    uint256 internal constant GOLDEN_CHAIN_ID = 31337;
    uint8 internal constant GOLDEN_TIER = 0;
    uint8 internal constant GOLDEN_OUTCOME = 1; // CashOut
    uint16 internal constant GOLDEN_STEPS = 1;
    address internal constant GOLDEN_CONTRACT = 0x5FbDB2315678afecb367f032d93F642f64180aa3;
    address internal constant GOLDEN_SIGNER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant GOLDEN_PLAYER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    bytes32 internal constant GOLDEN_GAME_ID = 0x1111111111111111111111111111111111111111111111111111111111111111;
    bytes32 internal constant GOLDEN_SERVER_SEED = 0x2222222222222222222222222222222222222222222222222222222222222222;
    uint64 internal constant GOLDEN_EXPIRY = 2_000_000_000;
    uint256 internal constant GOLDEN_PAYOUT = 7_000_000_000_000_000;
    bytes32 internal constant GOLDEN_COMMITMENT = 0x98b6668db61565f0c2263dfba252ae80ec8701846d7ebf3bb929b0a9e6367365;
    bytes32 internal constant GOLDEN_TICKET_DIGEST = 0xc792f2eddbf9b28bc405ed5c984c6c9091e65b77d3bdf6ad1f9923e5c000e248;
    bytes32 internal constant GOLDEN_SETTLEMENT_DIGEST =
        0x9b171784a17c338d85f15e209a037391bdaca653b1db3658e1a313cfc158467d;
    bytes32 internal constant GOLDEN_TABLE_HASH = 0x5f6a62a3d3220445aa9c61244b0044b7048debbab07ee784d0d97e268fafeda0;
    bytes internal constant GOLDEN_TICKET_SIG =
        hex"a7ef8e11d3682a94ffc80c14e738e5919aeb166445f631398814026d38fba14d42f84b21d3a8e220f7cc43414dd291a11892bfe076bc581284d9db4f3a8e26921c";
    bytes internal constant GOLDEN_SETTLEMENT_SIG =
        hex"b4addc6b23507accbb43abdd4b487f9eb85772964b4d049a87681d52327084a0210ea349b081e9714452b8fab9fb018897639ae0c99a94375c1b6c383f7b182b1b";

    RejectingPlayer internal rejecting;

    function setUp() public {
        vm.warp(1_750_000_000);
        _deployFrom(FIXTURE_TABLE);
        rejecting = new RejectingPlayer();
    }

    // ------------------------------------------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------------------------------------------

    /// @dev One 2x2 tier: tableVersion 7, mazeVersion 1, multiplier 1.5x, refunds 95 / 70 / 50 / 20 %.
    function _tinyTable() internal pure returns (Table memory t) {
        uint16[] memory refunds = new uint16[](4);
        refunds[0] = 9500;
        refunds[1] = 7000;
        refunds[2] = 5000;
        refunds[3] = 2000;
        t.tableVersion = 7;
        t.mazeVersion = 1;
        t.tiers = new MazeBet.TierInit[](1);
        t.tiers[0] = MazeBet.TierInit({n: 2, multiplierBps: 15_000, refundBps: refunds});
        t.minBet = 0.001 ether;
        t.maxBet = 0.1 ether;
        t.settleWindow = 1800;
    }

    /// @dev A fresh memory copy of the table `bet` was deployed with.
    function _fixture() internal view returns (Table memory) {
        return table;
    }

    function _expectInvalidTable(Table memory t) internal {
        vm.expectRevert(MazeBet.InvalidTable.selector);
        _deploy(t);
    }

    /// @dev `source` cut or extended to `length`, staying strictly decreasing, so only the length is wrong.
    function _withLength(uint16[] memory source, uint256 length) internal pure returns (uint16[] memory out) {
        out = new uint16[](length);
        for (uint256 k = 0; k < length; ++k) {
            out[k] = k < source.length ? source[k] : out[k - 1] - 1;
        }
    }

    function _expectBadTicket(
        address sender,
        bytes32 gameId,
        uint8 tier,
        bytes32 commitment,
        uint64 expiry,
        bytes memory sig
    ) internal {
        vm.deal(sender, WAGER);
        vm.expectRevert(MazeBet.InvalidSignature.selector);
        vm.prank(sender);
        bet.createGame{value: WAGER}(gameId, tier, commitment, expiry, bytes32(0), sig);
    }

    /// @dev Submits a settlement with an explicit signature, as the relayer.
    function _submit(
        bytes32 gameId,
        uint8 outcome,
        uint16 steps,
        uint256 payout,
        bytes32 serverSeed,
        bytes memory sig
    ) internal {
        vm.prank(relayer);
        bet.settle(gameId, outcome, steps, payout, serverSeed, sig);
    }

    function _expectBadSettlement(
        bytes4 selector,
        bytes32 gameId,
        uint8 outcome,
        uint16 steps,
        uint256 payout,
        bytes32 serverSeed,
        bytes memory sig
    ) internal {
        vm.expectRevert(selector);
        _submit(gameId, outcome, steps, payout, serverSeed, sig);
    }

    /// @dev The second valid ECDSA signature for the same message: `(r, N - s)` with the other recovery id.
    function _malleate(bytes memory sig) internal pure returns (bytes memory twin, uint8 v, bytes32 r, bytes32 s) {
        bytes32 originalS;
        uint8 originalV;
        assembly ("memory-safe") {
            r := mload(add(sig, 0x20))
            originalS := mload(add(sig, 0x40))
            originalV := byte(0, mload(add(sig, 0x60)))
        }
        s = bytes32(SECP256K1_N - uint256(originalS));
        v = originalV == 27 ? 28 : 27;
        twin = abi.encodePacked(r, s, v);
    }

    function _assertActive(bytes32 gameId) internal view {
        assertEq(uint8(_status(gameId)), uint8(MazeBet.Status.Active), "status must be Active");
    }

    function _assertSettled(bytes32 gameId) internal view {
        assertEq(uint8(_status(gameId)), uint8(MazeBet.Status.Settled), "status must be Settled");
    }

    // ------------------------------------------------------------------------------------------------------
    // constructor
    // ------------------------------------------------------------------------------------------------------

    function test_AC_C8_productionTuningTablePassesConstructor() public {
        Table memory t = _loadTable(PRODUCTION_TABLE);
        // Fixed by plan §3.6.
        assertEq(t.minBet, 0.001 ether, "minBet");
        assertEq(t.maxBet, 0.1 ether, "maxBet");
        assertEq(t.settleWindow, 1800, "settleWindow");
        _assertConstructorStores(t);
    }

    function test_AC_C8_fixtureTablePassesConstructor() public {
        _assertConstructorStores(_loadTable(FIXTURE_TABLE));
    }

    function _assertConstructorStores(Table memory t) internal {
        MazeBet c = _deploy(t);
        assertEq(c.owner(), owner, "owner");
        assertEq(c.serverSigner(), signer, "serverSigner");
        assertGt(t.tiers.length, 0, "the table has tiers");
        assertEq(c.tierCount(), t.tiers.length, "tierCount");
        assertEq(c.minBet(), t.minBet, "minBet");
        assertEq(c.maxBet(), t.maxBet, "maxBet");
        assertEq(c.settleWindow(), t.settleWindow, "settleWindow");
        assertEq(
            c.tableHash(),
            keccak256(abi.encode(t.tableVersion, t.mazeVersion, t.tiers, t.minBet, t.maxBet, t.settleWindow)),
            "tableHash"
        );
        assertEq(c.totalReserved(), 0);
        assertEq(c.totalPending(), 0);
        assertEq(c.availableLiquidity(), 0);

        for (uint8 i = 0; i < t.tiers.length; ++i) {
            MazeBet.TierInit memory tier = t.tiers[i];
            (uint8 n, uint32 multiplierBps) = c.tiers(i);
            assertEq(n, tier.n, "n");
            assertEq(multiplierBps, tier.multiplierBps, "multiplierBps");
            assertEq(tier.refundBps.length, uint256(n) * n, "one refund per cell");
            for (uint16 k = 0; k < tier.refundBps.length; ++k) {
                assertEq(c.refundBps(i, k), tier.refundBps[k], "refundBps");
            }
        }
    }

    function test_AC_C8_tableHashMatchesViemEncoding() public {
        assertEq(_deploy(_tinyTable()).tableHash(), GOLDEN_TABLE_HASH);
    }

    function test_AC_C8_AC_R9_constructorRejectsTableThatIsNotStrictlyDecreasing() public {
        for (uint256 i = 0; i < table.tiers.length; ++i) {
            uint256 last = table.tiers[i].refundBps.length - 1;
            uint256[3] memory positions = [uint256(1), last / 2, last];
            for (uint256 p = 0; p < positions.length; ++p) {
                uint256 k = positions[p];

                Table memory flat = _fixture();
                flat.tiers[i].refundBps[k] = flat.tiers[i].refundBps[k - 1];
                _expectInvalidTable(flat);

                Table memory rising = _fixture();
                rising.tiers[i].refundBps[k] = rising.tiers[i].refundBps[k - 1] + 1;
                _expectInvalidTable(rising);
            }
        }
    }

    function testFuzz_AC_C8_AC_R9_anyFlatOrRisingStepIsRejected(uint256 tierSeed, uint256 stepSeed, uint256 value)
        public
    {
        Table memory t = _fixture();
        uint16[] memory refunds = t.tiers[tierSeed % t.tiers.length].refundBps;
        uint256 k = bound(stepSeed, 1, refunds.length - 1);
        refunds[k] = SafeCast.toUint16(bound(value, refunds[k - 1], type(uint16).max));
        _expectInvalidTable(t);
    }

    function test_AC_C8_constructorRejectsTableLengthOtherThanCellCount() public {
        for (uint256 i = 0; i < table.tiers.length; ++i) {
            uint256 cells = table.tiers[i].refundBps.length;

            Table memory short = _fixture();
            short.tiers[i].refundBps = _withLength(short.tiers[i].refundBps, cells - 1);
            _expectInvalidTable(short);

            Table memory long = _fixture();
            long.tiers[i].refundBps = _withLength(long.tiers[i].refundBps, cells + 1);
            _expectInvalidTable(long);

            Table memory empty = _fixture();
            empty.tiers[i].refundBps = new uint16[](0);
            _expectInvalidTable(empty);
        }
    }

    function test_AC_C8_constructorRejectsMultiplierBelowOne() public {
        Table memory t = _fixture();
        t.tiers[1].multiplierBps = 9_999;
        _expectInvalidTable(t);

        t.tiers[1].multiplierBps = 10_000;
        assertEq(_deploy(t).quoteExitPayout(1, 1 ether), 1 ether, "exactly 1x is the lowest accepted multiplier");
    }

    function test_AC_C8_constructorRejectsFirstRefundOfTheFullBetOrMore() public {
        Table memory t = _fixture();
        t.tiers[0].refundBps[0] = 10_000;
        _expectInvalidTable(t);

        t.tiers[0].refundBps[0] = 9_999;
        assertEq(_deploy(t).refundBps(0, 0), 9_999);
    }

    function test_constructorRejectsDegenerateConfiguration() public {
        Table memory t = _tinyTable();
        t.tiers = new MazeBet.TierInit[](0);
        _expectInvalidTable(t);

        // A 1x1 maze has no move; the step bounds of `settle` would underflow.
        t = _tinyTable();
        t.tiers[0].n = 1;
        t.tiers[0].refundBps = _withLength(t.tiers[0].refundBps, 1);
        _expectInvalidTable(t);

        t = _tinyTable();
        t.tiers[0].n = 0;
        t.tiers[0].refundBps = new uint16[](0);
        _expectInvalidTable(t);

        t = _tinyTable();
        t.minBet = t.maxBet + 1;
        _expectInvalidTable(t);

        // Above uint96 the reserve could no longer be guaranteed to fit the uint128 fields of a game.
        t = _tinyTable();
        t.maxBet = uint256(type(uint96).max) + 1;
        _expectInvalidTable(t);
        t.maxBet = type(uint96).max;
        assertEq(_deploy(t).maxBet(), type(uint96).max);

        // `tier` is a uint8: 255 tiers are addressable, 256 are not.
        MazeBet.TierInit memory tier = _tinyTable().tiers[0];
        t = _tinyTable();
        t.tiers = new MazeBet.TierInit[](256);
        for (uint256 i = 0; i < 256; ++i) {
            t.tiers[i] = tier;
        }
        _expectInvalidTable(t);
        t.tiers = new MazeBet.TierInit[](255);
        for (uint256 i = 0; i < 255; ++i) {
            t.tiers[i] = tier;
        }
        assertEq(_deploy(t).tierCount(), 255);
    }

    // ------------------------------------------------------------------------------------------------------
    // cross-language vectors
    // ------------------------------------------------------------------------------------------------------

    /// @dev A ticket and a settlement signed by viem with the frozen `eip712.ts` definitions are accepted by the
    /// contract deployed at the address and chain id they were signed for. This pins the domain separator, both
    /// type hashes and the commitment byte format to the TypeScript side.
    function test_AC_C4_AC_M4_ticketAndSettlementSignedByViemAreAccepted() public {
        vm.chainId(GOLDEN_CHAIN_ID);
        Table memory t = _tinyTable();
        deployCodeTo(
            "MazeBet.sol:MazeBet",
            abi.encode(owner, GOLDEN_SIGNER, t.tableVersion, t.mazeVersion, t.tiers, t.minBet, t.maxBet, t.settleWindow),
            GOLDEN_CONTRACT
        );
        MazeBet golden = MazeBet(payable(GOLDEN_CONTRACT));
        assertEq(golden.tableHash(), GOLDEN_TABLE_HASH);

        // The helpers the other tests sign with produce the same bytes as viem.
        assertEq(GOLDEN_OUTCOME, CASH_OUT);
        bytes32 domain = SigUtils.domainSeparator(GOLDEN_CHAIN_ID, GOLDEN_CONTRACT);
        assertEq(
            SigUtils.commitmentOf(t.mazeVersion, t.tiers[GOLDEN_TIER].n, GOLDEN_SERVER_SEED),
            GOLDEN_COMMITMENT,
            "commitment"
        );
        assertEq(
            SigUtils.ticketDigest(
                domain, GOLDEN_GAME_ID, GOLDEN_PLAYER, GOLDEN_TIER, GOLDEN_COMMITMENT, GOLDEN_EXPIRY
            ),
            GOLDEN_TICKET_DIGEST,
            "ticket digest"
        );
        assertEq(
            SigUtils.settlementDigest(
                domain, GOLDEN_GAME_ID, GOLDEN_PLAYER, GOLDEN_OUTCOME, GOLDEN_STEPS, GOLDEN_PAYOUT, GOLDEN_SERVER_SEED
            ),
            GOLDEN_SETTLEMENT_DIGEST,
            "settlement digest"
        );

        golden.fund{value: 1 ether}();
        vm.deal(GOLDEN_PLAYER, WAGER);
        vm.prank(GOLDEN_PLAYER);
        golden.createGame{value: WAGER}(
            GOLDEN_GAME_ID, GOLDEN_TIER, GOLDEN_COMMITMENT, GOLDEN_EXPIRY, keccak256("client"), GOLDEN_TICKET_SIG
        );
        golden.settle(
            GOLDEN_GAME_ID, GOLDEN_OUTCOME, GOLDEN_STEPS, GOLDEN_PAYOUT, GOLDEN_SERVER_SEED, GOLDEN_SETTLEMENT_SIG
        );

        assertEq(GOLDEN_PLAYER.balance, GOLDEN_PAYOUT, "70% of the bet after one move");
        assertEq(uint8(golden.getGame(GOLDEN_GAME_ID).status), uint8(MazeBet.Status.Settled));
    }

    // ------------------------------------------------------------------------------------------------------
    // views
    // ------------------------------------------------------------------------------------------------------

    function test_viewsRejectOutOfRangeArguments() public {
        uint8 count = bet.tierCount();

        vm.expectRevert(MazeBet.InvalidTier.selector);
        bet.tiers(count);
        vm.expectRevert(MazeBet.InvalidTier.selector);
        bet.refundBps(count, 0);
        vm.expectRevert(MazeBet.InvalidTier.selector);
        bet.quoteExitPayout(count, 1 ether);

        vm.expectRevert(MazeBet.InvalidSteps.selector);
        bet.refundBps(0, _cells(0));
        assertEq(bet.refundBps(0, _cells(0) - 1), table.tiers[0].refundBps[_cells(0) - 1]);
    }

    function test_AC_R2_quoteExitPayoutIsBetTimesMultiplier() public view {
        for (uint8 tier = 0; tier < table.tiers.length; ++tier) {
            assertEq(bet.quoteExitPayout(tier, WAGER), WAGER * table.tiers[tier].multiplierBps / BPS);
        }
    }

    /// @dev The fixture multipliers are multiples of 10000, so no bet leaves a remainder and the tests on the
    /// fixture cannot tell rounding down from rounding up. The direction is pinned here with the multipliers of
    /// the certified base table: 12345678901234567 x 26088 / 66112 / 184695 leaves 3896 / 3504 / 2065 when divided
    /// by 10000. packages/shared/test/economics.test.ts pins the same literals for `exitPayoutWei`.
    function test_AC_R2_AC_C3_exitPayoutDropsTheRemainder() public {
        uint256 wager = 12_345_678_901_234_567;
        uint32[3] memory multipliers = [uint32(26_088), 66_112, 184_695];
        uint256[3] memory floors =
            [uint256(32_207_407_117_540_738), 81_619_752_351_841_969, 228_018_516_466_351_835];
        uint256[3] memory remainders = [uint256(3896), 3504, 2065];

        Table memory t = _fixture();
        assertEq(t.tiers.length, 3);
        for (uint8 tier = 0; tier < 3; ++tier) {
            t.tiers[tier].multiplierBps = multipliers[tier];
        }
        MazeBet c = _deploy(t);
        c.fund{value: 10 ether}();

        for (uint8 tier = 0; tier < 3; ++tier) {
            assertEq(wager * multipliers[tier] - floors[tier] * BPS, remainders[tier], "the literal is the floor");
            assertEq(c.quoteExitPayout(tier, wager), floors[tier], "quoteExitPayout rounds down");

            Ticket memory tk = _ticketFor(c, alice, tier, t.tiers[tier].n, t.mazeVersion);
            _createOn(c, tk, wager);
            assertEq(c.getGame(tk.gameId).maxPayout, floors[tier], "maxPayout rounds down");
            assertEq(c.getGame(tk.gameId).reserved, floors[tier], "the reserve is the floor");

            uint16 steps = 2 * (uint16(t.tiers[tier].n) - 1);
            _expectSettleRevertOn(c, MazeBet.PayoutMismatch.selector, tk, EXIT, steps, floors[tier] + 1);

            uint256 before = alice.balance;
            _settleOn(c, tk, EXIT, steps, floors[tier]);
            assertEq(alice.balance - before, floors[tier], "the exit pays the floor");
        }
    }

    /// @dev The same bet against refunds that leave a remainder (fixture tier 0 has the curve of the base table's
    /// 5x5 tier): 9500 / 7300 / 6694 / 1085 bps leave 6500 / 9100 / 1498 / 5195.
    function test_AC_R3_AC_C3_cashOutRefundDropsTheRemainder() public {
        uint256 wager = 12_345_678_901_234_567;
        uint16[4] memory steps = [uint16(0), 1, 2, 23];
        uint16[4] memory bps = [uint16(9500), 7300, 6694, 1085];
        uint256[4] memory floors =
            [uint256(11_728_394_956_172_838), 9_012_345_597_901_233, 8_264_197_456_486_419, 1_339_506_160_783_950];
        uint256[4] memory remainders = [uint256(6500), 9100, 1498, 5195];

        for (uint256 i = 0; i < steps.length; ++i) {
            assertEq(bet.refundBps(0, steps[i]), bps[i], "refundBps of the fixture");
            assertEq(wager * bps[i] - floors[i] * BPS, remainders[i], "the literal is the floor");

            Ticket memory tk = _open(alice, 0, wager);
            _expectSettleRevert(MazeBet.PayoutMismatch.selector, tk, CASH_OUT, steps[i], floors[i] + 1);
            uint256 before = alice.balance;
            _settle(tk, CASH_OUT, steps[i], floors[i]);
            assertEq(alice.balance - before, floors[i], "the cash-out pays the floor");
        }
    }

    function test_getGameOfUnknownIdIsEmpty() public view {
        MazeBet.Game memory game = bet.getGame(keccak256("unknown"));
        assertEq(uint8(game.status), uint8(MazeBet.Status.None));
        assertEq(game.player, address(0));
        assertEq(game.bet, 0);
        assertEq(game.reserved, 0);
    }

    // ------------------------------------------------------------------------------------------------------
    // createGame
    // ------------------------------------------------------------------------------------------------------

    function test_AC_C1_createGameRecordsCommitmentAndClientSeed() public {
        Ticket memory tk = _ticket(alice, 1);
        uint256 maxPayout = _exitPayout(1, WAGER);
        uint64 deadline = _now() + table.settleWindow;

        vm.deal(alice, WAGER);
        vm.expectEmit(address(bet));
        emit MazeBet.GameCreated(tk.gameId, alice, 1, WAGER, maxPayout, tk.commitment, tk.clientSeed, deadline);
        vm.prank(alice);
        bet.createGame{value: WAGER}(tk.gameId, 1, tk.commitment, tk.expiry, tk.clientSeed, tk.sig);

        MazeBet.Game memory game = bet.getGame(tk.gameId);
        assertEq(game.player, alice);
        assertEq(game.tier, 1);
        assertEq(uint8(game.status), uint8(MazeBet.Status.Active));
        assertEq(game.createdAt, _now());
        assertEq(game.settleDeadline, deadline);
        assertEq(game.bet, WAGER);
        assertEq(game.maxPayout, maxPayout);
        assertEq(game.reserved, maxPayout);
        assertEq(game.commitment, tk.commitment);
        assertEq(game.clientSeed, tk.clientSeed);

        assertEq(alice.balance, 0);
        assertEq(address(bet).balance, HOUSE_FUNDS + WAGER);
        assertEq(bet.totalReserved(), maxPayout);
        assertEq(bet.availableLiquidity(), HOUSE_FUNDS + WAGER - maxPayout);
    }

    function test_AC_C1_createGameRejectsExpiredTicket() public {
        Ticket memory tk = _ticket(alice, 0);

        vm.warp(uint256(tk.expiry) + 1);
        vm.expectRevert(MazeBet.TicketExpired.selector);
        _create(tk, WAGER);

        vm.warp(tk.expiry);
        _create(tk, WAGER);
        _assertActive(tk.gameId);
    }

    function test_AC_C1_createGameRejectsReusedGameId() public {
        Ticket memory settled = _open(alice, 0, WAGER);
        vm.expectRevert(MazeBet.GameExists.selector);
        _create(settled, WAGER);

        _settle(settled, LOSS, 1, 0);
        vm.expectRevert(MazeBet.GameExists.selector);
        _create(settled, WAGER);

        // Even a freshly signed ticket cannot reopen the id of a reclaimed game.
        Ticket memory reclaimed = _open(alice, 0, WAGER);
        vm.warp(uint256(bet.getGame(reclaimed.gameId).settleDeadline) + 1);
        bet.reclaim(reclaimed.gameId);
        reclaimed.expiry = _now() + 120;
        reclaimed.sig =
            _signTicket(bet, SIGNER_KEY, reclaimed.gameId, alice, reclaimed.tier, reclaimed.commitment, reclaimed.expiry);
        vm.expectRevert(MazeBet.GameExists.selector);
        _create(reclaimed, WAGER);
    }

    function test_AC_C1_createGameRejectsBetOutsideLimits() public {
        Ticket memory tk = _ticket(alice, 0);

        vm.expectRevert(MazeBet.BetOutOfRange.selector);
        _create(tk, 0);
        vm.expectRevert(MazeBet.BetOutOfRange.selector);
        _create(tk, table.minBet - 1);
        vm.expectRevert(MazeBet.BetOutOfRange.selector);
        _create(tk, table.maxBet + 1);

        _create(tk, table.minBet);
        Ticket memory atMax = _open(alice, 0, table.maxBet);
        assertEq(bet.getGame(tk.gameId).bet, table.minBet);
        assertEq(bet.getGame(atMax.gameId).bet, table.maxBet);
    }

    function test_AC_C1_createGameRejectsUnknownTier() public {
        uint8 count = bet.tierCount();
        // Signed by the server, but for a tier the contract does not have.
        Ticket memory tk = _ticketFor(bet, alice, count, 5, table.mazeVersion);
        vm.expectRevert(MazeBet.InvalidTier.selector);
        _create(tk, WAGER);

        tk = _ticketFor(bet, alice, type(uint8).max, 5, table.mazeVersion);
        vm.expectRevert(MazeBet.InvalidTier.selector);
        _create(tk, WAGER);
    }

    function test_AC_C1_createGameRejectsInvalidServerSignature() public {
        Ticket memory tk = _ticket(alice, 1);

        // signed by a key that is not the server signer
        _expectBadTicket(
            alice,
            tk.gameId,
            1,
            tk.commitment,
            tk.expiry,
            _signTicket(bet, OTHER_KEY, tk.gameId, alice, 1, tk.commitment, tk.expiry)
        );
        // somebody else's ticket (X18): the ticket binds the player
        _expectBadTicket(bob, tk.gameId, 1, tk.commitment, tk.expiry, tk.sig);
        // any signed field changed
        _expectBadTicket(alice, keccak256("another game"), 1, tk.commitment, tk.expiry, tk.sig);
        _expectBadTicket(alice, tk.gameId, 0, tk.commitment, tk.expiry, tk.sig);
        _expectBadTicket(alice, tk.gameId, 1, keccak256("another commitment"), tk.expiry, tk.sig);
        _expectBadTicket(alice, tk.gameId, 1, tk.commitment, tk.expiry + 1, tk.sig);
        // malformed signatures: empty, all zero, 66 bytes, 64 bytes
        _expectBadTicket(alice, tk.gameId, 1, tk.commitment, tk.expiry, "");
        _expectBadTicket(alice, tk.gameId, 1, tk.commitment, tk.expiry, new bytes(65));
        _expectBadTicket(alice, tk.gameId, 1, tk.commitment, tk.expiry, abi.encodePacked(tk.sig, uint8(0)));
        bytes memory truncated = abi.encodePacked(tk.sig);
        assembly ("memory-safe") {
            mstore(truncated, 64)
        }
        _expectBadTicket(alice, tk.gameId, 1, tk.commitment, tk.expiry, truncated);

        // The untouched ticket still opens the game.
        vm.deal(alice, 0);
        _create(tk, WAGER);
        _assertActive(tk.gameId);
    }

    function test_AC_C4_malleatedSignatureIsRejected() public {
        Ticket memory tk = _ticket(alice, 0);
        (bytes memory twin, uint8 v, bytes32 r, bytes32 s) = _malleate(tk.sig);

        // The twin is a valid ECDSA signature by the server over the same ticket ...
        bytes32 digest = SigUtils.ticketDigest(
            SigUtils.domainSeparator(vm.getChainId(), address(bet)), tk.gameId, alice, 0, tk.commitment, tk.expiry
        );
        assertEq(ecrecover(digest, v, r, s), signer);
        // ... and the contract accepts only the canonical low-s form.
        _expectBadTicket(alice, tk.gameId, 0, tk.commitment, tk.expiry, twin);
    }

    function test_AC_C4_ticketForAnotherContractIsRejected() public {
        MazeBet other = _deploy(_fixture());
        other.fund{value: 10 ether}();

        Ticket memory tk = _ticket(alice, 0);
        vm.expectRevert(MazeBet.InvalidSignature.selector);
        _createOn(other, tk, WAGER);

        _create(tk, WAGER);
        _assertActive(tk.gameId);
    }

    function test_AC_C4_ticketForAnotherChainIsRejected() public {
        Ticket memory tk = _ticket(alice, 0);

        vm.chainId(1);
        vm.expectRevert(MazeBet.InvalidSignature.selector);
        _create(tk, WAGER);

        // After a fork the contract follows the new chain id: only a ticket bound to it is accepted.
        tk.sig = _signTicket(bet, SIGNER_KEY, tk.gameId, alice, 0, tk.commitment, tk.expiry);
        _create(tk, WAGER);
        _assertActive(tk.gameId);
    }

    function test_AC_C2_createGameReservesMaxPayoutAndReleasesItOnSettleAndReclaim() public {
        Ticket memory a = _open(alice, 0, WAGER);
        Ticket memory b = _open(bob, 2, 2 * WAGER);
        uint256 reservedA = _exitPayout(0, WAGER);
        uint256 reservedB = _exitPayout(2, 2 * WAGER);
        assertGt(reservedA, WAGER);
        assertEq(bet.getGame(a.gameId).reserved, reservedA);
        assertEq(bet.getGame(b.gameId).reserved, reservedB);
        assertEq(bet.totalReserved(), reservedA + reservedB);

        _settle(a, LOSS, 1, 0);
        assertEq(bet.totalReserved(), reservedB, "settle releases exactly the reserve of that game");

        vm.warp(uint256(bet.getGame(b.gameId).settleDeadline) + 1);
        bet.reclaim(b.gameId);
        assertEq(bet.totalReserved(), 0, "reclaim releases exactly the reserve of that game");
        assertEq(bet.availableLiquidity(), address(bet).balance);
    }

    function test_AC_C2_reservedIsTheBetWhenTheMultiplierIsExactlyOne() public {
        Table memory t = _tinyTable();
        t.tiers[0].multiplierBps = 10_000;
        MazeBet c = _deploy(t);

        // No house money at all: the bet alone backs a 1x game.
        Ticket memory tk = _ticketFor(c, alice, 0, 2, t.mazeVersion);
        _createOn(c, tk, WAGER);
        MazeBet.Game memory game = c.getGame(tk.gameId);
        assertEq(game.maxPayout, WAGER);
        assertEq(game.reserved, WAGER);
        assertEq(c.totalReserved(), address(c).balance);
    }

    function test_AC_C2_createGameRejectedWhenTheBalanceCannotCoverTheReserve() public {
        MazeBet c = _deploy(_fixture());
        uint256 wager = table.maxBet;
        uint256 reserved = _exitPayout(2, wager);
        uint256 houseShare = reserved - wager;

        c.fund{value: houseShare - 1}();
        Ticket memory tk = _ticketFor(c, alice, 2, table.tiers[2].n, table.mazeVersion);
        vm.expectRevert(MazeBet.InsufficientLiquidity.selector);
        _createOn(c, tk, wager);

        c.fund{value: 1}();
        vm.deal(alice, 0);
        _createOn(c, tk, wager);
        assertEq(c.totalReserved(), reserved);
        assertEq(address(c).balance, reserved, "balance == totalReserved: exactly enough");
        assertEq(c.availableLiquidity(), 0);

        // Everything is reserved: not even the smallest game can be added.
        Ticket memory next = _ticketFor(c, bob, 0, table.tiers[0].n, table.mazeVersion);
        vm.expectRevert(MazeBet.InsufficientLiquidity.selector);
        _createOn(c, next, table.minBet);
    }

    function test_AC_C2_pendingWithdrawalsCountAgainstLiquidity() public {
        MazeBet c = _deploy(_fixture());
        uint256 payout = _exitPayout(0, WAGER);
        c.fund{value: payout - WAGER}();

        // The payout of a won game cannot be delivered and becomes a pending withdrawal.
        Ticket memory won = _ticketFor(c, address(rejecting), 0, table.tiers[0].n, table.mazeVersion);
        _createOn(c, won, WAGER);
        _settleOn(c, won, EXIT, _shortestPath(0), payout);
        assertEq(c.totalReserved(), 0);
        assertEq(c.totalPending(), payout);
        assertEq(address(c).balance, payout);
        assertEq(c.availableLiquidity(), 0, "the balance belongs to the pending withdrawal");

        // balance + bet < totalPending + reserved
        Ticket memory next = _ticketFor(c, alice, 0, table.tiers[0].n, table.mazeVersion);
        vm.expectRevert(MazeBet.InsufficientLiquidity.selector);
        _createOn(c, next, WAGER);

        c.fund{value: payout - WAGER}();
        vm.deal(alice, 0);
        _createOn(c, next, WAGER);
        assertEq(address(c).balance, c.totalReserved() + c.totalPending());
    }

    // ------------------------------------------------------------------------------------------------------
    // settle
    // ------------------------------------------------------------------------------------------------------

    function test_AC_C3_AC_R2_exitPaysBetTimesMultiplier() public {
        for (uint8 tier = 0; tier < table.tiers.length; ++tier) {
            Ticket memory tk = _open(alice, tier, WAGER);
            uint256 payout = _exitPayout(tier, WAGER);
            uint16 steps = _shortestPath(tier);
            uint256 aliceBefore = alice.balance;
            uint256 contractBefore = address(bet).balance;

            bytes memory sig = _settlementSig(bet, tk, EXIT, steps, payout);
            vm.expectEmit(address(bet));
            emit MazeBet.GameSettled(tk.gameId, alice, EXIT, steps, payout, tk.serverSeed);
            _submit(tk.gameId, EXIT, steps, payout, tk.serverSeed, sig);

            assertEq(alice.balance - aliceBefore, payout);
            assertEq(contractBefore - address(bet).balance, payout);
            _assertSettled(tk.gameId);
            assertEq(bet.totalReserved(), 0);
            assertEq(bet.totalPending(), 0);
        }
    }

    function test_AC_C3_AC_R3_cashOutPaysTheTableRefundAtEveryStep_fixtureTable() public {
        _assertCashOutPaysTheTableRefundAtEveryStep();
    }

    function test_AC_C3_AC_R3_cashOutPaysTheTableRefundAtEveryStep_productionTable() public {
        _deployFrom(PRODUCTION_TABLE);
        _assertCashOutPaysTheTableRefundAtEveryStep();
    }

    function _assertCashOutPaysTheTableRefundAtEveryStep() internal {
        uint256 wager = 12_345_678_901_234_567;
        for (uint8 tier = 0; tier < table.tiers.length; ++tier) {
            for (uint16 k = 0; k <= _cells(tier) - 2; ++k) {
                Ticket memory tk = _open(alice, tier, wager);
                uint256 payout = wager * table.tiers[tier].refundBps[k] / BPS;
                uint256 before = alice.balance;

                _settle(tk, CASH_OUT, k, payout);

                assertEq(alice.balance - before, payout);
                assertLt(payout, wager, "a cash-out never returns the full bet");
            }
        }
        assertEq(bet.totalReserved(), 0);
        assertEq(bet.totalPending(), 0);
    }

    function test_AC_R3_cashOutBeforeTheFirstMovePaysRefundBpsZero() public {
        Ticket memory tk = _open(alice, 0, WAGER);
        uint256 payout = WAGER * table.tiers[0].refundBps[0] / BPS;
        _settle(tk, CASH_OUT, 0, payout);
        assertEq(alice.balance, payout);
    }

    function test_AC_C3_lossPaysNothing() public {
        Ticket memory tk = _open(alice, 2, WAGER);
        bytes memory sig = _settlementSig(bet, tk, LOSS, 7, 0);

        vm.expectEmit(address(bet));
        emit MazeBet.GameSettled(tk.gameId, alice, LOSS, 7, 0, tk.serverSeed);
        _submit(tk.gameId, LOSS, 7, 0, tk.serverSeed, sig);

        assertEq(alice.balance, 0);
        assertEq(address(bet).balance, HOUSE_FUNDS + WAGER, "the bet stays with the house");
        assertEq(bet.totalReserved(), 0);
        assertEq(bet.availableLiquidity(), HOUSE_FUNDS + WAGER);
    }

    /// @dev X21: the server signature does not decide the amount; the table does.
    function test_AC_C3_signedPayoutThatDisagreesWithTheTableIsRejected() public {
        Ticket memory tk = _open(alice, 1, WAGER);
        uint256 exit = _exitPayout(1, WAGER);
        uint16 shortest = _shortestPath(1);
        uint256 refund = _refund(1, 3, WAGER);
        bytes4 mismatch = MazeBet.PayoutMismatch.selector;

        _expectSettleRevert(mismatch, tk, EXIT, shortest, exit + 1);
        _expectSettleRevert(mismatch, tk, EXIT, shortest, exit - 1);
        _expectSettleRevert(mismatch, tk, EXIT, shortest, 0);
        _expectSettleRevert(mismatch, tk, CASH_OUT, 3, refund + 1);
        _expectSettleRevert(mismatch, tk, CASH_OUT, 3, refund - 1);
        _expectSettleRevert(mismatch, tk, CASH_OUT, 3, _refund(1, 2, WAGER));
        _expectSettleRevert(mismatch, tk, CASH_OUT, 3, WAGER);
        _expectSettleRevert(mismatch, tk, CASH_OUT, 3, exit);
        _expectSettleRevert(mismatch, tk, LOSS, 3, 1);
        _expectSettleRevert(mismatch, tk, LOSS, 3, refund);

        _assertActive(tk.gameId);
        assertEq(alice.balance, 0);
    }

    /// @dev X23: the refund is rounded down, so no bet size gains a wei.
    function testFuzz_AC_C3_cashOutIsTheFloorOfTheTableRefund(uint256 wagerSeed, uint256 tierSeed, uint256 stepSeed)
        public
    {
        uint8 tier = SafeCast.toUint8(tierSeed % table.tiers.length);
        uint256 wager = bound(wagerSeed, table.minBet, table.maxBet);
        uint16 steps = SafeCast.toUint16(bound(stepSeed, 0, _cells(tier) - 2));
        uint256 exact = wager * table.tiers[tier].refundBps[steps];
        uint256 payout = exact / BPS;

        Ticket memory tk = _open(alice, tier, wager);
        _expectSettleRevert(MazeBet.PayoutMismatch.selector, tk, CASH_OUT, steps, payout + 1);
        _settle(tk, CASH_OUT, steps, payout);

        assertEq(alice.balance, payout);
        assertLe(payout * BPS, exact);
        assertLt(payout, wager);
    }

    function testFuzz_AC_C3_exitIsTheFloorOfBetTimesMultiplier(uint256 wagerSeed, uint256 tierSeed) public {
        uint8 tier = SafeCast.toUint8(tierSeed % table.tiers.length);
        uint256 wager = bound(wagerSeed, table.minBet, table.maxBet);
        uint256 payout = wager * table.tiers[tier].multiplierBps / BPS;

        Ticket memory tk = _open(alice, tier, wager);
        assertEq(bet.getGame(tk.gameId).maxPayout, payout);
        _expectSettleRevert(MazeBet.PayoutMismatch.selector, tk, EXIT, _shortestPath(tier), payout + 1);
        _settle(tk, EXIT, _shortestPath(tier), payout);
        assertEq(alice.balance, payout);
    }

    function test_settleStepBounds() public {
        bytes4 invalid = MazeBet.InvalidSteps.selector;
        for (uint8 tier = 0; tier < table.tiers.length; ++tier) {
            uint16 cells = _cells(tier);
            uint16 shortest = _shortestPath(tier);
            uint256 exit = _exitPayout(tier, WAGER);

            // Exit: 2(n-1) <= steps <= n*n - 1
            Ticket memory tk = _open(alice, tier, WAGER);
            _expectSettleRevert(invalid, tk, EXIT, shortest - 1, exit);
            _expectSettleRevert(invalid, tk, EXIT, 0, exit);
            _expectSettleRevert(invalid, tk, EXIT, cells, exit);
            _settle(tk, EXIT, shortest, exit);
            tk = _open(alice, tier, WAGER);
            _settle(tk, EXIT, cells - 1, exit);

            // CashOut: steps <= n*n - 2
            tk = _open(alice, tier, WAGER);
            _expectSettleRevert(invalid, tk, CASH_OUT, cells - 1, _refund(tier, cells - 1, WAGER));
            _expectSettleRevert(invalid, tk, CASH_OUT, cells, 0);
            _expectSettleRevert(invalid, tk, CASH_OUT, type(uint16).max, 0);
            _settle(tk, CASH_OUT, cells - 2, _refund(tier, cells - 2, WAGER));

            // Loss: steps >= 1, and plan §7.4 sets no upper bound
            tk = _open(alice, tier, WAGER);
            _expectSettleRevert(invalid, tk, LOSS, 0, 0);
            _settle(tk, LOSS, 1, 0);
            tk = _open(alice, tier, WAGER);
            _settle(tk, LOSS, type(uint16).max, 0);
        }
    }

    /// @dev The same bounds with explicit numbers for a 9x9 tier (81 cells, shortest path 16), the large size of
    /// the certified base table. The tier is fixture tier 2 cut to 81 refunds.
    function test_AC_C3_settleStepBounds_nineByNine() public {
        Table memory t = _fixture();
        t.tiers[2].n = 9;
        t.tiers[2].refundBps = _withLength(t.tiers[2].refundBps, 81);
        MazeBet c = _deploy(t);
        c.fund{value: 10 ether}();
        uint256 exit = WAGER * t.tiers[2].multiplierBps / BPS;
        bytes4 invalid = MazeBet.InvalidSteps.selector;

        // CashOut: n*n - 1 = 80 is refused, n*n - 2 = 79 is allowed.
        Ticket memory tk = _ticketFor(c, alice, 2, 9, t.mazeVersion);
        _createOn(c, tk, WAGER);
        _expectSettleRevertOn(c, invalid, tk, CASH_OUT, 80, WAGER * t.tiers[2].refundBps[80] / BPS);
        _settleOn(c, tk, CASH_OUT, 79, WAGER * t.tiers[2].refundBps[79] / BPS);

        // Exit: 2(n - 1) - 1 = 15 is refused, 16 is allowed.
        tk = _ticketFor(c, alice, 2, 9, t.mazeVersion);
        _createOn(c, tk, WAGER);
        _expectSettleRevertOn(c, invalid, tk, EXIT, 15, exit);
        _settleOn(c, tk, EXIT, 16, exit);

        // Exit: n*n = 81 is refused, n*n - 1 = 80 is allowed.
        tk = _ticketFor(c, alice, 2, 9, t.mazeVersion);
        _createOn(c, tk, WAGER);
        _expectSettleRevertOn(c, invalid, tk, EXIT, 81, exit);
        _settleOn(c, tk, EXIT, 80, exit);

        assertEq(c.totalReserved(), 0);
    }

    function test_settleRejectsUnknownOutcome() public {
        Ticket memory tk = _open(alice, 0, WAGER);
        _expectSettleRevert(MazeBet.InvalidOutcome.selector, tk, 3, 1, 0);
        _expectSettleRevert(MazeBet.InvalidOutcome.selector, tk, type(uint8).max, 1, 0);
        _assertActive(tk.gameId);
    }

    function test_AC_C4_AC_S5_resettleIsRejected() public {
        Ticket memory tk = _open(alice, 0, WAGER);
        uint256 payout = _exitPayout(0, WAGER);
        uint16 steps = _shortestPath(0);
        bytes memory sig = _settlementSig(bet, tk, EXIT, steps, payout);

        _submit(tk.gameId, EXIT, steps, payout, tk.serverSeed, sig);
        assertEq(alice.balance, payout);

        // the same signature again, by the relayer and by the player
        _expectBadSettlement(MazeBet.GameNotActive.selector, tk.gameId, EXIT, steps, payout, tk.serverSeed, sig);
        vm.expectRevert(MazeBet.GameNotActive.selector);
        vm.prank(alice);
        bet.settle(tk.gameId, EXIT, steps, payout, tk.serverSeed, sig);
        // a second, different signed result for the same game
        _expectSettleRevert(MazeBet.GameNotActive.selector, tk, CASH_OUT, 0, _refund(0, 0, WAGER));

        assertEq(alice.balance, payout, "paid once");
        assertEq(address(bet).balance, HOUSE_FUNDS + WAGER - payout);
    }

    function test_settleOfUnknownGameIsRejected() public {
        Ticket memory tk = _ticket(alice, 0);
        _expectSettleRevert(MazeBet.GameNotActive.selector, tk, LOSS, 1, 0);
    }

    function test_AC_C4_AC_S3_settleRejectsInvalidServerSignature() public {
        Ticket memory tk = _open(alice, 0, WAGER);
        uint256 payout = _exitPayout(0, WAGER);
        uint16 steps = _shortestPath(0);
        bytes memory good = _settlementSig(bet, tk, EXIT, steps, payout);
        bytes4 invalid = MazeBet.InvalidSignature.selector;

        // unsigned and malformed
        _expectBadSettlement(invalid, tk.gameId, EXIT, steps, payout, tk.serverSeed, "");
        _expectBadSettlement(invalid, tk.gameId, EXIT, steps, payout, tk.serverSeed, new bytes(65));
        _expectBadSettlement(invalid, tk.gameId, EXIT, steps, payout, tk.serverSeed, abi.encodePacked(good, uint8(0)));
        (bytes memory twin,,,) = _malleate(good);
        _expectBadSettlement(invalid, tk.gameId, EXIT, steps, payout, tk.serverSeed, twin);
        // signed by any key other than the server's
        _expectBadSettlement(
            invalid,
            tk.gameId,
            EXIT,
            steps,
            payout,
            tk.serverSeed,
            _signSettlement(bet, OTHER_KEY, tk.gameId, alice, EXIT, steps, payout, tk.serverSeed)
        );
        // the ticket signature is not a settlement signature
        _expectBadSettlement(invalid, tk.gameId, EXIT, steps, payout, tk.serverSeed, tk.sig);
        // a settlement naming another recipient
        _expectBadSettlement(
            invalid,
            tk.gameId,
            EXIT,
            steps,
            payout,
            tk.serverSeed,
            _signSettlement(bet, SIGNER_KEY, tk.gameId, bob, EXIT, steps, payout, tk.serverSeed)
        );
        _assertActive(tk.gameId);
        assertEq(alice.balance, 0);

        _submit(tk.gameId, EXIT, steps, payout, tk.serverSeed, good);
        assertEq(alice.balance, payout);
    }

    /// @dev The player holds a signed Loss (or a signed late cash-out) and submits a better result with it.
    function test_AC_C4_signedResultCannotBeUpgraded() public {
        Ticket memory tk = _open(alice, 0, WAGER);
        bytes4 invalid = MazeBet.InvalidSignature.selector;

        bytes memory lossSig = _settlementSig(bet, tk, LOSS, 4, 0);
        _expectBadSettlement(invalid, tk.gameId, CASH_OUT, 0, _refund(0, 0, WAGER), tk.serverSeed, lossSig);
        _expectBadSettlement(invalid, tk.gameId, CASH_OUT, 4, _refund(0, 4, WAGER), tk.serverSeed, lossSig);
        _expectBadSettlement(invalid, tk.gameId, EXIT, _shortestPath(0), _exitPayout(0, WAGER), tk.serverSeed, lossSig);

        bytes memory lateCashOut = _settlementSig(bet, tk, CASH_OUT, 9, _refund(0, 9, WAGER));
        _expectBadSettlement(invalid, tk.gameId, CASH_OUT, 1, _refund(0, 1, WAGER), tk.serverSeed, lateCashOut);
        _expectBadSettlement(invalid, tk.gameId, CASH_OUT, 9, _refund(0, 9, WAGER), keccak256("seed"), lateCashOut);

        _assertActive(tk.gameId);
        assertEq(alice.balance, 0);
    }

    function test_AC_C4_settlementOfAnotherGameIsRejected() public {
        Ticket memory won = _open(alice, 0, WAGER);
        Ticket memory lost = _open(alice, 0, WAGER);
        uint256 payout = _exitPayout(0, WAGER);
        uint16 steps = _shortestPath(0);
        bytes memory wonSig = _settlementSig(bet, won, EXIT, steps, payout);
        bytes4 invalid = MazeBet.InvalidSignature.selector;

        // Same player, same tier, same bet: only the game id tells the two apart.
        _expectBadSettlement(invalid, lost.gameId, EXIT, steps, payout, won.serverSeed, wonSig);
        _expectBadSettlement(invalid, lost.gameId, EXIT, steps, payout, lost.serverSeed, wonSig);

        _settle(lost, LOSS, 1, 0);
        vm.prank(alice);
        bet.settle(won.gameId, EXIT, steps, payout, won.serverSeed, wonSig);
        assertEq(alice.balance, payout, "one win is paid once");
    }

    function test_AC_C4_settlementForAnotherContractIsRejected() public {
        MazeBet other = _deploy(_fixture());
        other.fund{value: 10 ether}();

        // The same game (id, seed, commitment, player, bet) exists on both contracts.
        Ticket memory tk = _open(alice, 0, WAGER);
        bytes memory otherTicketSig = _signTicket(other, SIGNER_KEY, tk.gameId, alice, 0, tk.commitment, tk.expiry);
        vm.deal(alice, WAGER);
        vm.prank(alice);
        other.createGame{value: WAGER}(tk.gameId, 0, tk.commitment, tk.expiry, tk.clientSeed, otherTicketSig);

        uint256 payout = _exitPayout(0, WAGER);
        uint16 steps = _shortestPath(0);
        bytes memory sig = _settlementSig(bet, tk, EXIT, steps, payout);

        vm.expectRevert(MazeBet.InvalidSignature.selector);
        other.settle(tk.gameId, EXIT, steps, payout, tk.serverSeed, sig);

        bet.settle(tk.gameId, EXIT, steps, payout, tk.serverSeed, sig);
        assertEq(alice.balance, payout);
        assertEq(uint8(other.getGame(tk.gameId).status), uint8(MazeBet.Status.Active));
    }

    function test_AC_C4_settlementForAnotherChainIsRejected() public {
        Ticket memory tk = _open(alice, 0, WAGER);
        uint256 payout = _exitPayout(0, WAGER);
        uint16 steps = _shortestPath(0);
        uint256 home = vm.getChainId();
        bytes memory sig = _settlementSig(bet, tk, EXIT, steps, payout);

        vm.chainId(home + 1);
        _expectBadSettlement(MazeBet.InvalidSignature.selector, tk.gameId, EXIT, steps, payout, tk.serverSeed, sig);
        _assertActive(tk.gameId);

        vm.chainId(home);
        _submit(tk.gameId, EXIT, steps, payout, tk.serverSeed, sig);
        assertEq(alice.balance, payout);
    }

    /// @dev AC-M4: the revealed seed must hash to the commitment recorded at creation.
    function test_AC_M4_settleRejectsSeedThatDoesNotMatchTheCommitment() public {
        Ticket memory tk = _open(alice, 0, WAGER);
        bytes32 wrongSeed = keccak256("not the committed seed");
        bytes memory sig = _signSettlement(bet, SIGNER_KEY, tk.gameId, alice, LOSS, 1, 0, wrongSeed);
        _expectBadSettlement(MazeBet.CommitmentMismatch.selector, tk.gameId, LOSS, 1, 0, wrongSeed, sig);

        // A commitment built for another maze size or another maze version does not match either.
        Ticket memory otherSize = _ticketFor(bet, alice, 0, table.tiers[1].n, table.mazeVersion);
        _create(otherSize, WAGER);
        _expectSettleRevert(MazeBet.CommitmentMismatch.selector, otherSize, LOSS, 1, 0);

        Ticket memory otherVersion = _ticketFor(bet, alice, 0, table.tiers[0].n, table.mazeVersion + 1);
        _create(otherVersion, WAGER);
        _expectSettleRevert(MazeBet.CommitmentMismatch.selector, otherVersion, LOSS, 1, 0);

        _settle(tk, LOSS, 1, 0);
        _assertSettled(tk.gameId);
    }

    function test_AC_C5_settleAtTheDeadlineIsAcceptedAndAfterItRejected() public {
        Ticket memory a = _open(alice, 0, WAGER);
        Ticket memory b = _open(bob, 0, WAGER);
        uint64 deadline = bet.getGame(a.gameId).settleDeadline;
        assertEq(deadline, _now() + 1800);

        vm.warp(deadline);
        _settle(a, CASH_OUT, 2, _refund(0, 2, WAGER));
        _assertSettled(a.gameId);

        vm.warp(uint256(deadline) + 1);
        _expectSettleRevert(MazeBet.DeadlinePassed.selector, b, CASH_OUT, 2, _refund(0, 2, WAGER));
        _assertActive(b.gameId);
    }

    function test_settleIsOpenToAnyCaller() public {
        Ticket memory tk = _open(alice, 0, WAGER);
        uint256 payout = _refund(0, 5, WAGER);
        bytes memory sig = _settlementSig(bet, tk, CASH_OUT, 5, payout);

        vm.prank(bob);
        bet.settle(tk.gameId, CASH_OUT, 5, payout, tk.serverSeed, sig);

        assertEq(alice.balance, payout, "the money goes to the player");
        assertEq(bob.balance, 0, "not to the caller");
    }

    // ------------------------------------------------------------------------------------------------------
    // reclaim
    // ------------------------------------------------------------------------------------------------------

    function test_AC_C5_reclaimBeforeOrAtTheDeadlineIsRejected() public {
        Ticket memory tk = _open(alice, 0, WAGER);
        uint64 deadline = bet.getGame(tk.gameId).settleDeadline;

        vm.expectRevert(MazeBet.DeadlineNotReached.selector);
        vm.prank(alice);
        bet.reclaim(tk.gameId);

        vm.warp(deadline);
        vm.expectRevert(MazeBet.DeadlineNotReached.selector);
        vm.prank(alice);
        bet.reclaim(tk.gameId);
        vm.expectRevert(MazeBet.DeadlineNotReached.selector);
        vm.prank(bob);
        bet.reclaim(tk.gameId);

        _assertActive(tk.gameId);
        assertEq(alice.balance, 0);
    }

    function test_AC_C5_anyoneCanReclaimAfterTheDeadlineAndTheBetGoesToThePlayer() public {
        Ticket memory tk = _open(alice, 2, WAGER);
        vm.warp(uint256(bet.getGame(tk.gameId).settleDeadline) + 1);

        vm.expectEmit(address(bet));
        emit MazeBet.GameReclaimed(tk.gameId, alice, WAGER);
        vm.prank(bob);
        bet.reclaim(tk.gameId);

        assertEq(alice.balance, WAGER, "the full bet returns to the player");
        assertEq(bob.balance, 0, "the caller gets nothing");
        assertEq(uint8(_status(tk.gameId)), uint8(MazeBet.Status.Reclaimed));
        assertEq(bet.totalReserved(), 0);
        assertEq(address(bet).balance, HOUSE_FUNDS);
    }

    function test_AC_C5_reclaimHappensAtMostOnce() public {
        Ticket memory tk = _open(alice, 0, WAGER);
        vm.warp(uint256(bet.getGame(tk.gameId).settleDeadline) + 1);
        bet.reclaim(tk.gameId);

        vm.expectRevert(MazeBet.GameNotActive.selector);
        bet.reclaim(tk.gameId);
        vm.expectRevert(MazeBet.GameNotActive.selector);
        vm.prank(alice);
        bet.reclaim(tk.gameId);
        _expectSettleRevert(MazeBet.GameNotActive.selector, tk, EXIT, _shortestPath(0), _exitPayout(0, WAGER));

        assertEq(alice.balance, WAGER);
        assertEq(address(bet).balance, HOUSE_FUNDS);
    }

    function test_AC_C5_reclaimOfSettledOrUnknownGameIsRejected() public {
        Ticket memory tk = _open(alice, 0, WAGER);
        _settle(tk, LOSS, 3, 0);
        vm.warp(uint256(bet.getGame(tk.gameId).settleDeadline) + 1);

        vm.expectRevert(MazeBet.GameNotActive.selector);
        bet.reclaim(tk.gameId);
        vm.expectRevert(MazeBet.GameNotActive.selector);
        bet.reclaim(keccak256("unknown"));

        assertEq(alice.balance, 0, "a settled loss cannot be turned into a refund");
    }

    // ------------------------------------------------------------------------------------------------------
    // withdrawPending
    // ------------------------------------------------------------------------------------------------------

    function test_AC_C10_withdrawPendingPaysExactlyTheDeferredAmount() public {
        address player = address(rejecting);
        uint256 first = _refund(0, 3, WAGER);
        uint256 second = _exitPayout(1, WAGER);

        Ticket memory a = _open(player, 0, WAGER);
        bytes memory sig = _settlementSig(bet, a, CASH_OUT, 3, first);
        vm.expectEmit(address(bet));
        emit MazeBet.GameSettled(a.gameId, player, CASH_OUT, 3, first, a.serverSeed);
        vm.expectEmit(address(bet));
        emit MazeBet.PayoutDeferred(player, first);
        _submit(a.gameId, CASH_OUT, 3, first, a.serverSeed, sig);

        Ticket memory b = _open(player, 1, WAGER);
        _settle(b, EXIT, _shortestPath(1), second);

        uint256 total = first + second;
        assertEq(bet.pendingWithdrawals(player), total, "deferred payouts accumulate");
        assertEq(bet.totalPending(), total);
        assertEq(bet.totalReserved(), 0);
        assertEq(player.balance, 0);
        assertEq(address(bet).balance, HOUSE_FUNDS + 2 * WAGER);
        assertEq(bet.availableLiquidity(), HOUSE_FUNDS + 2 * WAGER - total);

        // While the receiver refuses the money the withdrawal reverts and nothing changes.
        vm.expectRevert(bytes(""));
        vm.prank(player);
        bet.withdrawPending();
        assertEq(bet.pendingWithdrawals(player), total);
        assertEq(bet.totalPending(), total);

        rejecting.setAccepting(true);
        vm.prank(player);
        bet.withdrawPending();
        assertEq(player.balance, total);
        assertEq(bet.pendingWithdrawals(player), 0);
        assertEq(bet.totalPending(), 0);
        assertEq(address(bet).balance, HOUSE_FUNDS + 2 * WAGER - total);

        vm.expectRevert(MazeBet.NothingToWithdraw.selector);
        vm.prank(player);
        bet.withdrawPending();
    }

    function test_AC_C10_withdrawPendingWithNothingPendingReverts() public {
        vm.expectRevert(MazeBet.NothingToWithdraw.selector);
        vm.prank(alice);
        bet.withdrawPending();
    }

    function test_AC_C10_pendingOfOneAccountIsNotPayableToAnother() public {
        Ticket memory tk = _open(address(rejecting), 0, WAGER);
        uint256 payout = _refund(0, 0, WAGER);
        _settle(tk, CASH_OUT, 0, payout);

        vm.expectRevert(MazeBet.NothingToWithdraw.selector);
        vm.prank(bob);
        bet.withdrawPending();

        assertEq(bet.pendingWithdrawals(address(rejecting)), payout);
        assertEq(bet.totalPending(), payout);
    }

    // ------------------------------------------------------------------------------------------------------
    // house funds and administration
    // ------------------------------------------------------------------------------------------------------

    function test_fundAndReceiveEmitHouseFunded() public {
        vm.deal(bob, 3 ether);

        vm.expectEmit(address(bet));
        emit MazeBet.HouseFunded(bob, 1 ether);
        vm.prank(bob);
        bet.fund{value: 1 ether}();

        vm.expectEmit(address(bet));
        emit MazeBet.HouseFunded(bob, 2 ether);
        vm.prank(bob);
        (bool ok,) = address(bet).call{value: 2 ether}("");
        assertTrue(ok);

        assertEq(address(bet).balance, HOUSE_FUNDS + 3 ether);
        assertEq(bet.availableLiquidity(), HOUSE_FUNDS + 3 ether);
    }

    function test_withdrawHouseIsOwnerOnly() public {
        vm.expectRevert(MazeBet.NotOwner.selector);
        vm.prank(alice);
        bet.withdrawHouse(1, alice);
        vm.expectRevert(MazeBet.NotOwner.selector);
        vm.prank(signer);
        bet.withdrawHouse(1, signer);
    }

    function test_withdrawHouseIsLimitedToTheUnreservedBalance() public {
        Ticket memory active = _open(alice, 2, table.maxBet);
        Ticket memory deferred = _open(address(rejecting), 0, WAGER);
        uint256 pending = _refund(0, 1, WAGER);
        _settle(deferred, CASH_OUT, 1, pending);

        uint256 reserved = _exitPayout(2, table.maxBet);
        uint256 available = HOUSE_FUNDS + table.maxBet + WAGER - reserved - pending;
        assertEq(bet.availableLiquidity(), available);

        vm.expectRevert(MazeBet.ExceedsAvailable.selector);
        vm.prank(owner);
        bet.withdrawHouse(available + 1, owner);

        vm.expectEmit(address(bet));
        emit MazeBet.HouseWithdrawn(bob, available);
        vm.prank(owner);
        bet.withdrawHouse(available, bob);
        assertEq(bob.balance, available);
        assertEq(bet.availableLiquidity(), 0);
        assertEq(address(bet).balance, reserved + pending, "what is left backs the game and the pending withdrawal");

        vm.expectRevert(MazeBet.ExceedsAvailable.selector);
        vm.prank(owner);
        bet.withdrawHouse(1, owner);

        // Both liabilities are still paid in full.
        _settle(active, EXIT, _shortestPath(2), reserved);
        assertEq(alice.balance, reserved);
        rejecting.setAccepting(true);
        vm.prank(address(rejecting));
        bet.withdrawPending();
        assertEq(address(rejecting).balance, pending);
        assertEq(address(bet).balance, 0);
    }

    function test_withdrawHouseToARecipientThatRefusesBecomesPending() public {
        vm.expectEmit(address(bet));
        emit MazeBet.HouseWithdrawn(address(rejecting), 1 ether);
        vm.expectEmit(address(bet));
        emit MazeBet.PayoutDeferred(address(rejecting), 1 ether);
        vm.prank(owner);
        bet.withdrawHouse(1 ether, address(rejecting));

        assertEq(bet.pendingWithdrawals(address(rejecting)), 1 ether);
        assertEq(bet.totalPending(), 1 ether);
        assertEq(address(bet).balance, HOUSE_FUNDS);
        assertEq(bet.availableLiquidity(), HOUSE_FUNDS - 1 ether, "the amount cannot be withdrawn a second time");
    }

    function test_setServerSignerIsOwnerOnlyAndRotatesTheKey() public {
        address next = vm.addr(OTHER_KEY);
        vm.expectRevert(MazeBet.NotOwner.selector);
        vm.prank(alice);
        bet.setServerSigner(next);
        vm.expectRevert(MazeBet.NotOwner.selector);
        vm.prank(signer);
        bet.setServerSigner(next);

        Ticket memory tk = _ticket(alice, 0);

        vm.expectEmit(address(bet));
        emit MazeBet.ServerSignerChanged(next);
        vm.prank(owner);
        bet.setServerSigner(next);
        assertEq(bet.serverSigner(), next);

        // Tickets and settlements of the old key are void, those of the new key are accepted.
        vm.expectRevert(MazeBet.InvalidSignature.selector);
        _create(tk, WAGER);

        tk.sig = _signTicket(bet, OTHER_KEY, tk.gameId, alice, 0, tk.commitment, tk.expiry);
        vm.deal(alice, 0);
        _create(tk, WAGER);
        _expectSettleRevert(MazeBet.InvalidSignature.selector, tk, LOSS, 1, 0);
        _submit(
            tk.gameId,
            LOSS,
            1,
            0,
            tk.serverSeed,
            _signSettlement(bet, OTHER_KEY, tk.gameId, alice, LOSS, 1, 0, tk.serverSeed)
        );
        _assertSettled(tk.gameId);
    }
}
