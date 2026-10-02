// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A player contract that answers every ETH transfer with `returnSize` bytes of return data. A caller that
/// copies return data pays for the memory; `returnSize` is an immutable so the bomb itself costs no storage read.
contract ReturnBombPlayer {
    uint256 public immutable returnSize;

    constructor(uint256 returnSize_) {
        returnSize = returnSize_;
    }

    receive() external payable {
        uint256 size = returnSize;
        assembly {
            return(0, size)
        }
    }
}
