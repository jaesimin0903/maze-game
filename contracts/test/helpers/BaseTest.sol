// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {MazeBet} from "../../src/MazeBet.sol";
import {SigUtils} from "./SigUtils.sol";

/// @notice Shared setup: loads a tuning table the way the TypeScript encoder does (plan §7.2: tiers in order as
/// `(n, multiplierBps, refundBps)`, limits from `limits`, the settle window from `timing`), deploys `MazeBet`
/// with it, and signs tickets and settlements as the game server.
abstract contract MazeBetBase is Test {
    string internal constant PRODUCTION_TABLE = "../packages/shared/src/tuning.json";
    string internal constant FIXTURE_TABLE = "../packages/shared/test/fixtures/tuning.fixture.json";

    uint8 internal constant EXIT = 0;
    uint8 internal constant CASH_OUT = 1;
    uint8 internal constant LOSS = 2;
    uint256 internal constant BPS = 10_000;

    uint256 internal constant HOUSE_FUNDS = 100 ether;
    uint256 internal constant SIGNER_KEY = 0x5e12e5;

    /// @dev The relayer sends `settle` with a fixed gas limit (plan §3.6). What is left for execution is the limit
    /// minus the 21,000 intrinsic gas and the calldata, priced here as if all 324 bytes were non-zero.
    uint256 internal constant RELAYER_GAS_LIMIT = 300_000;
    uint256 internal constant SETTLE_TX_OVERHEAD = 21_000 + 324 * 16;
    uint256 internal constant RELAYER_EXEC_GAS = RELAYER_GAS_LIMIT - SETTLE_TX_OVERHEAD;

    struct Table {
        uint32 tableVersion;
        uint16 mazeVersion;
        MazeBet.TierInit[] tiers;
        uint256 minBet;
        uint256 maxBet;
        uint64 settleWindow;
    }

    struct Ticket {
        bytes32 gameId;
        address player;
        uint8 tier;
        bytes32 serverSeed;
        bytes32 commitment;
        uint64 expiry;
        bytes32 clientSeed;
        bytes sig;
    }

    address internal signer = vm.addr(SIGNER_KEY);
    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MazeBet internal bet;
    Table internal table;

    uint256 private _ticketNonce;

    // ----- tables and deployment -----

    function _loadTable(string memory path) internal view returns (Table memory t) {
        string memory json = vm.readFile(path);
        t.tableVersion = SafeCast.toUint32(vm.parseJsonUint(json, ".tableVersion"));
        t.mazeVersion = SafeCast.toUint16(vm.parseJsonUint(json, ".mazeVersion"));
        t.minBet = vm.parseJsonUint(json, ".limits.minBetWei");
        t.maxBet = vm.parseJsonUint(json, ".limits.maxBetWei");
        t.settleWindow = SafeCast.toUint64(vm.parseJsonUint(json, ".timing.settleWindowSec"));

        uint256 count = 0;
        while (vm.keyExistsJson(json, _tierKey(count))) ++count;
        t.tiers = new MazeBet.TierInit[](count);
        for (uint256 i = 0; i < count; ++i) {
            string memory key = _tierKey(i);
            // The contract addresses a tier by its position; the server addresses it by `id`.
            assertEq(vm.parseJsonUint(json, string.concat(key, ".id")), i, "tier id must equal its index");

            uint256[] memory raw = vm.parseJsonUintArray(json, string.concat(key, ".refundBps"));
            uint16[] memory refunds = new uint16[](raw.length);
            for (uint256 k = 0; k < raw.length; ++k) {
                refunds[k] = SafeCast.toUint16(raw[k]);
            }
            t.tiers[i] = MazeBet.TierInit({
                n: SafeCast.toUint8(vm.parseJsonUint(json, string.concat(key, ".n"))),
                multiplierBps: SafeCast.toUint32(vm.parseJsonUint(json, string.concat(key, ".multiplierBps"))),
                refundBps: refunds
            });
        }
    }

    function _tierKey(uint256 index) private pure returns (string memory) {
        return string.concat(".tiers[", vm.toString(index), "]");
    }

    function _deploy(Table memory t) internal returns (MazeBet) {
        return new MazeBet(owner, signer, t.tableVersion, t.mazeVersion, t.tiers, t.minBet, t.maxBet, t.settleWindow);
    }

    /// @dev Deploys `bet` with the table at `path`, keeps the table in `table`, and funds the house.
    function _deployFrom(string memory path) internal {
        Table memory t = _loadTable(path);

        delete table;
        table.tableVersion = t.tableVersion;
        table.mazeVersion = t.mazeVersion;
        table.minBet = t.minBet;
        table.maxBet = t.maxBet;
        table.settleWindow = t.settleWindow;
        for (uint256 i = 0; i < t.tiers.length; ++i) {
            table.tiers.push(t.tiers[i]);
        }

        bet = _deploy(t);
        vm.deal(owner, HOUSE_FUNDS);
        vm.prank(owner);
        bet.fund{value: HOUSE_FUNDS}();
    }

    // ----- expected amounts, straight from the table -----

    function _cells(uint8 tier) internal view returns (uint16) {
        uint16 n = table.tiers[tier].n;
        return n * n;
    }

    function _shortestPath(uint8 tier) internal view returns (uint16) {
        return 2 * (uint16(table.tiers[tier].n) - 1);
    }

    function _exitPayout(uint8 tier, uint256 wager) internal view returns (uint256) {
        return wager * table.tiers[tier].multiplierBps / BPS;
    }

    function _refund(uint8 tier, uint16 steps, uint256 wager) internal view returns (uint256) {
        return wager * table.tiers[tier].refundBps[steps] / BPS;
    }

    /// @dev Chain time through the cheatcode: with `via_ir` the optimizer may reuse an earlier `block.timestamp`
    /// read after `vm.warp`. `vm.getChainId()` is used for the same reason.
    function _now() internal view returns (uint64) {
        return SafeCast.toUint64(vm.getBlockTimestamp());
    }

    /// @dev Gas spent by the most recent call (the callee frame, without intrinsic gas). Read with a raw call and
    /// decoded by position: the `Gas` struct of the vendored forge-std 1.17.0 has one field more than forge 1.5.1
    /// returns, so the typed `vm.lastCallGas()` reverts while decoding.
    function _lastCallGasUsed() internal view returns (uint256) {
        (bool ok, bytes memory data) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok && data.length >= 64, "lastCallGas failed");
        (, uint64 gasTotalUsed) = abi.decode(data, (uint64, uint64));
        return gasTotalUsed;
    }

    // ----- signing -----

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signTicket(
        MazeBet c,
        uint256 key,
        bytes32 gameId,
        address player,
        uint8 tier,
        bytes32 commitment,
        uint64 expiry
    ) internal view returns (bytes memory) {
        bytes32 domain = SigUtils.domainSeparator(vm.getChainId(), address(c));
        return _sign(key, SigUtils.ticketDigest(domain, gameId, player, tier, commitment, expiry));
    }

    function _signSettlement(
        MazeBet c,
        uint256 key,
        bytes32 gameId,
        address player,
        uint8 outcome,
        uint16 steps,
        uint256 payout,
        bytes32 serverSeed
    ) internal view returns (bytes memory) {
        bytes32 domain = SigUtils.domainSeparator(vm.getChainId(), address(c));
        return _sign(key, SigUtils.settlementDigest(domain, gameId, player, outcome, steps, payout, serverSeed));
    }

    // ----- game flow -----

    /// @dev A fresh server ticket for `player` on contract `c`: random ids and seeds, 120 s validity (plan §3.6).
    function _ticketFor(MazeBet c, address player, uint8 tier, uint8 n, uint16 mazeVersion)
        internal
        returns (Ticket memory tk)
    {
        tk.gameId = keccak256(abi.encode("gameId", ++_ticketNonce));
        tk.player = player;
        tk.tier = tier;
        tk.serverSeed = keccak256(abi.encode("serverSeed", tk.gameId));
        tk.commitment = SigUtils.commitmentOf(mazeVersion, n, tk.serverSeed);
        tk.expiry = _now() + 120;
        tk.clientSeed = keccak256(abi.encode("clientSeed", tk.gameId));
        tk.sig = _signTicket(c, SIGNER_KEY, tk.gameId, player, tier, tk.commitment, tk.expiry);
    }

    function _ticket(address player, uint8 tier) internal returns (Ticket memory) {
        return _ticketFor(bet, player, tier, table.tiers[tier].n, table.mazeVersion);
    }

    /// @dev Gives the player the wager and submits the ticket as the player.
    function _createOn(MazeBet c, Ticket memory tk, uint256 wager) internal {
        vm.deal(tk.player, tk.player.balance + wager);
        vm.prank(tk.player);
        c.createGame{value: wager}(tk.gameId, tk.tier, tk.commitment, tk.expiry, tk.clientSeed, tk.sig);
    }

    function _create(Ticket memory tk, uint256 wager) internal {
        _createOn(bet, tk, wager);
    }

    function _open(address player, uint8 tier, uint256 wager) internal returns (Ticket memory tk) {
        tk = _ticket(player, tier);
        _create(tk, wager);
    }

    function _settlementSig(MazeBet c, Ticket memory tk, uint8 outcome, uint16 steps, uint256 payout)
        internal
        view
        returns (bytes memory)
    {
        return _signSettlement(c, SIGNER_KEY, tk.gameId, tk.player, outcome, steps, payout, tk.serverSeed);
    }

    /// @dev Signs the result as the server and submits it as the relayer.
    function _settleOn(MazeBet c, Ticket memory tk, uint8 outcome, uint16 steps, uint256 payout) internal {
        bytes memory sig = _settlementSig(c, tk, outcome, steps, payout);
        vm.prank(relayer);
        c.settle(tk.gameId, outcome, steps, payout, tk.serverSeed, sig);
    }

    function _settle(Ticket memory tk, uint8 outcome, uint16 steps, uint256 payout) internal {
        _settleOn(bet, tk, outcome, steps, payout);
    }

    /// @dev A correctly signed result that the contract must nevertheless reject with `selector`.
    function _expectSettleRevert(bytes4 selector, Ticket memory tk, uint8 outcome, uint16 steps, uint256 payout)
        internal
    {
        bytes memory sig = _settlementSig(bet, tk, outcome, steps, payout);
        vm.expectRevert(selector);
        vm.prank(relayer);
        bet.settle(tk.gameId, outcome, steps, payout, tk.serverSeed, sig);
    }

    function _status(bytes32 gameId) internal view returns (MazeBet.Status) {
        return bet.getGame(gameId).status;
    }
}
