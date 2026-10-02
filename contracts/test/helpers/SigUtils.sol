// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test-side implementation of the signed messages (plan §7.5) and the seed commitment (plan §3.5).
/// It is written independently of `MazeBet.sol` and pinned to viem's output by the golden-vector test, so the
/// tests sign exactly what the TypeScript server signs.
library SigUtils {
    function domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("MazeBet"),
                keccak256("1"),
                chainId,
                verifyingContract
            )
        );
    }

    function ticketDigest(
        bytes32 domain,
        bytes32 gameId,
        address player,
        uint8 tier,
        bytes32 commitment,
        uint64 expiry
    ) internal pure returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Ticket(bytes32 gameId,address player,uint8 tier,bytes32 commitment,uint64 expiry)"),
                gameId,
                player,
                tier,
                commitment,
                expiry
            )
        );
        return keccak256(bytes.concat(hex"1901", domain, structHash));
    }

    function settlementDigest(
        bytes32 domain,
        bytes32 gameId,
        address player,
        uint8 outcome,
        uint16 steps,
        uint256 payout,
        bytes32 serverSeed
    ) internal pure returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Settlement(bytes32 gameId,address player,uint8 outcome,uint16 steps,uint256 payout,bytes32 serverSeed)"
                ),
                gameId,
                player,
                outcome,
                steps,
                payout,
                serverSeed
            )
        );
        return keccak256(bytes.concat(hex"1901", domain, structHash));
    }

    /// @dev sha256( COMMIT_TAG(32) ‖ uint16be(mazeVersion) ‖ uint8(n) ‖ serverSeed(32) ), 67 bytes.
    function commitmentOf(uint16 mazeVersion, uint8 n, bytes32 serverSeed) internal pure returns (bytes32) {
        return sha256(bytes.concat(keccak256("MazeBet.commit.v1"), bytes2(mazeVersion), bytes1(n), serverSeed));
    }
}
