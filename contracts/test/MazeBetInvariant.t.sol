// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MazeBet} from "../src/MazeBet.sol";
import {MazeBetBase} from "./helpers/BaseTest.sol";
import {Handler} from "./helpers/Handler.sol";

/// @notice Invariants of the liability accounting (AC-C7, X20) under random sequences of games, settlements,
/// reclaims, withdrawals, house funding, time travel and forced ETH, with hostile player contracts among the
/// players. Every run ends with `Handler.drain`, which must be able to pay everybody and empty the contract.
contract MazeBetInvariantTest is MazeBetBase {
    Handler internal handler;

    function setUp() public {
        vm.warp(1_750_000_000);
        _deployFrom(FIXTURE_TABLE);
        handler = new Handler(bet, owner, SIGNER_KEY, table.mazeVersion);

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = Handler.createGame.selector;
        selectors[1] = Handler.settle.selector;
        selectors[2] = Handler.reclaim.selector;
        selectors[3] = Handler.refinalize.selector;
        selectors[4] = Handler.withdrawPending.selector;
        selectors[5] = Handler.fund.selector;
        selectors[6] = Handler.withdrawHouse.selector;
        selectors[7] = Handler.warp.selector;
        selectors[8] = Handler.forceEther.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev The reserved payouts and the pending withdrawals never exceed the balance, and the books of the
    /// contract agree with an independent count of every wei that went in and out.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_AC_C7_balanceCoversReservedAndPending() public view {
        uint256 balance = address(bet).balance;
        uint256 liabilities = bet.totalReserved() + bet.totalPending();
        assertGe(balance, liabilities, "balance >= totalReserved + totalPending");
        assertEq(bet.availableLiquidity(), balance - liabilities, "availableLiquidity");
        assertEq(balance, handler.ghostIn() - handler.ghostOut(), "every wei is accounted for");

        assertEq(bet.totalPending(), handler.sumOfPendingWithdrawals(), "totalPending == sum of pendingWithdrawals");
        assertEq(
            bet.totalPending(),
            handler.ghostDeferred() - handler.ghostPendingWithdrawn(),
            "pending == deferred - withdrawn"
        );
        assertEq(
            handler.ghostEntitled(),
            handler.ghostPaidDirect() + handler.ghostDeferred(),
            "players were credited exactly what they were owed"
        );
    }

    /// @dev The reserve of every active game is counted in `totalReserved` exactly once, and the reserve of a
    /// finalized game was released exactly once.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_AC_C7_totalReservedIsTheSumOverActiveGames() public view {
        uint256 sum = 0;
        uint256 count = handler.activeCount();
        for (uint256 i = 0; i < count; ++i) {
            MazeBet.Game memory game = bet.getGame(handler.activeIds(i));
            assertEq(uint8(game.status), uint8(MazeBet.Status.Active), "tracked as active");
            sum += game.reserved;
        }
        assertEq(bet.totalReserved(), sum, "totalReserved == sum of reserved over active games");
        assertEq(
            bet.totalReserved(),
            handler.ghostReservedOpened() - handler.ghostReservedReleased(),
            "every reserve is released exactly once"
        );
    }

    /// @dev Checked once per run, after `drain`: every game the run created ended in exactly one of the two final
    /// states and was finalized exactly once.
    function afterInvariant() public {
        handler.drain();

        assertEq(handler.activeCount(), 0);
        uint256 count = handler.closedCount();
        for (uint256 i = 0; i < count; ++i) {
            bytes32 gameId = handler.closedIds(i);
            MazeBet.Status status = bet.getGame(gameId).status;
            assertTrue(status == MazeBet.Status.Settled || status == MazeBet.Status.Reclaimed, "final state");
            assertEq(handler.finalizations(gameId), 1, "settled or reclaimed exactly once");
        }

        assertEq(address(bet).balance, 0, "the contract can always be emptied");
        assertEq(bet.totalReserved(), 0);
        assertEq(bet.totalPending(), 0);
        assertEq(handler.ghostIn(), handler.ghostOut(), "everything that came in went out");
        assertEq(handler.ghostEntitled(), handler.ghostPaidDirect() + handler.ghostPendingWithdrawn());
    }
}
