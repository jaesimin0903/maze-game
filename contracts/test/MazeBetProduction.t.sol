// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {MazeBet} from "../src/MazeBet.sol";
import {MazeBetBase} from "./helpers/BaseTest.sol";
import {SigUtils} from "./helpers/SigUtils.sol";

/// @notice The contract deployed with the production table (packages/shared/src/tuning.json) against the values
/// TypeScript pins for the same table: packages/shared/test/vectors/contract-vectors.json, which
/// packages/shared/test/contract-vectors.test.ts compares with `tableHash`, `commitmentOf`, `exitPayoutWei` and
/// `refundWei`. A change of the arithmetic or of an encoding on either side fails one of the two suites.
/// @dev The vectors are keyed by table hash and hold every certified table, so the suite follows
/// `pnpm tuning:apply`. A table without an entry fails in `setUp`: add it with make-contract-vectors.ts.
/// The production multipliers are not multiples of 10000, which is what makes the rounding direction visible.
contract MazeBetProductionTest is MazeBetBase {
    string internal constant VECTORS = "../packages/shared/test/vectors/contract-vectors.json";
    /// @dev The certified base table (packages/sim/reports/tuning.candidate.json): 5x5 / 7x7 / 9x9.
    bytes32 internal constant BASE_TABLE_HASH = 0xd07642f3561163900d1c90b74a8e4acce618f5d58e51750f4061486d57777caf;

    string internal vectors;
    /// @dev JSON path of the entry for the deployed table.
    string internal pinned;
    uint256 internal wager;
    bytes32 internal seed;

    function setUp() public {
        vm.warp(1_750_000_000);
        _deployFrom(PRODUCTION_TABLE);
        vectors = vm.readFile(VECTORS);
        wager = vm.parseJsonUint(vectors, ".betWei");
        seed = vm.parseJsonBytes32(vectors, ".serverSeed");
        pinned = _entryOf(bet.tableHash());
    }

    // ----- helpers -----

    function _entryOf(bytes32 hash) internal view returns (string memory key) {
        for (uint256 i = 0;; ++i) {
            key = string.concat(".tables[", vm.toString(i), "]");
            require(
                vm.keyExistsJson(vectors, key),
                "contract-vectors.json has no entry for this table hash: add it with make-contract-vectors.ts"
            );
            if (vm.parseJsonBytes32(vectors, string.concat(key, ".tableHash")) == hash) return key;
        }
    }

    function _tierKey(string memory entry, uint256 tier, string memory field) internal pure returns (string memory) {
        return string.concat(entry, ".tiers[", vm.toString(tier), "].", field);
    }

    function _pinnedUint(uint256 tier, string memory field) internal view returns (uint256) {
        return vm.parseJsonUint(vectors, _tierKey(pinned, tier, field));
    }

    // ----- table hash, tiers, commitment -----

    /// @dev The entry was found by `bet.tableHash()`, so the contract's hash is one TypeScript also computes;
    /// the tiers behind that hash are the ones deployed.
    function test_AC_C8_tableHashAndTiersAreTheOnesTypeScriptPins() public view {
        assertEq(vm.parseJsonBytes32(vectors, string.concat(pinned, ".tableHash")), bet.tableHash());
        assertEq(vm.parseJsonUint(vectors, string.concat(pinned, ".mazeVersion")), table.mazeVersion);
        assertFalse(vm.keyExistsJson(vectors, _tierKey(pinned, table.tiers.length, "n")), "no tier beyond the table");
        for (uint8 tier = 0; tier < table.tiers.length; ++tier) {
            (uint8 n, uint32 multiplierBps) = bet.tiers(tier);
            assertEq(_pinnedUint(tier, "n"), n, "n");
            assertEq(_pinnedUint(tier, "multiplierBps"), multiplierBps, "multiplierBps");
        }
    }

    /// @dev The commitment TypeScript computes for (mazeVersion, n, seed) is the one the contract recomputes at
    /// settlement: a game created with the pinned commitment settles with the pinned seed, and with no other.
    function test_AC_M4_commitmentsMatchTheTypeScriptVectors() public {
        for (uint8 tier = 0; tier < table.tiers.length; ++tier) {
            bytes32 commitment = vm.parseJsonBytes32(vectors, _tierKey(pinned, tier, "commitment"));
            assertEq(SigUtils.commitmentOf(table.mazeVersion, table.tiers[tier].n, seed), commitment, "commitment");

            Ticket memory tk = _ticket(alice, tier);
            tk.commitment = commitment;
            tk.sig = _signTicket(bet, SIGNER_KEY, tk.gameId, alice, tier, commitment, tk.expiry);
            _create(tk, wager);
            // Still carrying the random seed of `_ticket`: not the committed one.
            _expectSettleRevert(MazeBet.CommitmentMismatch.selector, tk, LOSS, 1, 0);
            tk.serverSeed = seed;
            _settle(tk, LOSS, 1, 0);
            assertEq(uint8(_status(tk.gameId)), uint8(MazeBet.Status.Settled));
        }
    }

    // ----- amounts -----

    function test_AC_C3_AC_R2_exitPayoutIsThePinnedFloor() public {
        for (uint8 tier = 0; tier < table.tiers.length; ++tier) {
            uint256 floor = _pinnedUint(tier, "exitPayoutWei");
            uint256 remainder = _pinnedUint(tier, "exitRemainder");
            assertGt(remainder, 0, "the bet must leave a remainder, or the rounding direction is not tested");
            assertEq(wager * table.tiers[tier].multiplierBps - floor * BPS, remainder, "the vector is the floor");

            assertEq(bet.quoteExitPayout(tier, wager), floor, "quoteExitPayout");
            Ticket memory tk = _open(alice, tier, wager);
            assertEq(bet.getGame(tk.gameId).maxPayout, floor, "maxPayout");
            assertEq(bet.getGame(tk.gameId).reserved, floor, "reserved");

            _expectSettleRevert(MazeBet.PayoutMismatch.selector, tk, EXIT, _shortestPath(tier), floor + 1);
            uint256 before = alice.balance;
            _settle(tk, EXIT, _shortestPath(tier), floor);
            assertEq(alice.balance - before, floor, "the exit pays the floor");
        }
        assertEq(bet.totalReserved(), 0);
    }

    function test_AC_C3_AC_R3_cashOutRefundIsThePinnedFloorAtEveryStep() public {
        for (uint8 tier = 0; tier < table.tiers.length; ++tier) {
            uint256[] memory refunds = vm.parseJsonUintArray(vectors, _tierKey(pinned, tier, "refundWei"));
            uint16 cells = _cells(tier);
            assertEq(refunds.length, cells, "one refund per step");

            uint256 withRemainder = 0;
            for (uint16 k = 0; k < cells; ++k) {
                // The vector is the floor of the bet times the on-chain refundBps.
                uint256 exact = wager * bet.refundBps(tier, k);
                assertLe(refunds[k] * BPS, exact, "not above the exact amount");
                assertLt(exact - refunds[k] * BPS, BPS, "less than one wei below it");
                if (exact != refunds[k] * BPS) ++withRemainder;
                if (k > cells - 2) continue; // no cash-out after the last possible move

                Ticket memory tk = _open(alice, tier, wager);
                _expectSettleRevert(MazeBet.PayoutMismatch.selector, tk, CASH_OUT, k, refunds[k] + 1);
                uint256 before = alice.balance;
                _settle(tk, CASH_OUT, k, refunds[k]);
                assertEq(alice.balance - before, refunds[k], "the cash-out pays the floor");
            }
            assertGt(withRemainder, cells / 2, "most steps must leave a remainder");
        }
        assertEq(bet.totalReserved(), 0);
        assertEq(bet.totalPending(), 0);
    }

    /// @dev The literals of the review for the base table, bet 12345678901234567 wei. The exit amounts drop
    /// remainders of 3896 / 3504 / 2065; packages/shared/test/contract-vectors.test.ts holds the same literals.
    function test_AC_R2_AC_R3_theBaseTableVectorsAreTheReviewedLiterals() public view {
        string memory base = _entryOf(BASE_TABLE_HASH);
        assertEq(wager, 12_345_678_901_234_567);

        uint256[3] memory exits = [uint256(32_207_407_117_540_738), 81_619_752_351_841_969, 228_018_516_466_351_835];
        uint256[3] memory remainders = [uint256(3896), 3504, 2065];
        // Refunds after 0, 1 and 2 moves and at the last cash-out step n*n - 2.
        uint256[4][3] memory refunds = [
            [uint256(11_728_394_956_172_838), 9_012_345_597_901_233, 8_264_197_456_486_419, 1_339_506_160_783_950],
            [uint256(11_728_394_956_172_838), 9_012_345_597_901_233, 8_506_172_762_950_616, 632_098_759_743_209],
            [uint256(11_728_394_956_172_838), 9_012_345_597_901_233, 8_358_024_616_135_801, 24_691_357_802_469]
        ];
        uint256[3] memory lastStep = [uint256(23), 47, 79];

        for (uint256 tier = 0; tier < 3; ++tier) {
            assertEq(vm.parseJsonUint(vectors, _tierKey(base, tier, "exitPayoutWei")), exits[tier], "exit");
            assertEq(vm.parseJsonUint(vectors, _tierKey(base, tier, "exitRemainder")), remainders[tier], "remainder");
            uint256[] memory pinnedRefunds = vm.parseJsonUintArray(vectors, _tierKey(base, tier, "refundWei"));
            assertEq(pinnedRefunds[0], refunds[tier][0], "refund after 0 moves");
            assertEq(pinnedRefunds[1], refunds[tier][1], "refund after 1 move");
            assertEq(pinnedRefunds[2], refunds[tier][2], "refund after 2 moves");
            assertEq(pinnedRefunds[lastStep[tier]], refunds[tier][3], "refund at the last cash-out step");
        }
    }

    function testFuzz_AC_C3_exitIsTheFloor_productionTable(uint256 wagerSeed, uint256 tierSeed) public {
        uint8 tier = SafeCast.toUint8(tierSeed % table.tiers.length);
        uint256 amount = bound(wagerSeed, table.minBet, table.maxBet);
        uint256 exact = amount * table.tiers[tier].multiplierBps;

        Ticket memory tk = _open(alice, tier, amount);
        uint256 maxPayout = bet.getGame(tk.gameId).maxPayout;
        assertLe(maxPayout * BPS, exact, "never above the exact amount");
        assertLt(exact - maxPayout * BPS, BPS, "less than one wei below it");
        assertEq(bet.quoteExitPayout(tier, amount), maxPayout, "the quote is what is reserved and paid");

        _expectSettleRevert(MazeBet.PayoutMismatch.selector, tk, EXIT, _shortestPath(tier), maxPayout + 1);
        uint256 before = alice.balance;
        _settle(tk, EXIT, _shortestPath(tier), maxPayout);
        assertEq(alice.balance - before, maxPayout);
    }

    // ----- step bounds -----

    function test_AC_C3_settleStepBounds_productionTable() public {
        bytes4 invalid = MazeBet.InvalidSteps.selector;
        for (uint8 tier = 0; tier < table.tiers.length; ++tier) {
            uint16 n = table.tiers[tier].n;
            uint16 cells = n * n;
            uint16 shortest = 2 * (n - 1);
            uint256 exit = _exitPayout(tier, wager);

            // CashOut: n*n - 1 is refused, n*n - 2 is allowed.
            Ticket memory tk = _open(alice, tier, wager);
            _expectSettleRevert(invalid, tk, CASH_OUT, cells - 1, _refund(tier, cells - 1, wager));
            _settle(tk, CASH_OUT, cells - 2, _refund(tier, cells - 2, wager));

            // Exit: 2(n - 1) - 1 is refused, 2(n - 1) is allowed.
            tk = _open(alice, tier, wager);
            _expectSettleRevert(invalid, tk, EXIT, shortest - 1, exit);
            _settle(tk, EXIT, shortest, exit);

            // Exit: n*n is refused, n*n - 1 is allowed.
            tk = _open(alice, tier, wager);
            _expectSettleRevert(invalid, tk, EXIT, cells, exit);
            _settle(tk, EXIT, cells - 1, exit);
        }
        assertEq(bet.totalReserved(), 0);
    }
}
