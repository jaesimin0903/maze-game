// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A player contract that refuses ETH until it is told to accept it.
contract RejectingPlayer {
    bool public accepting;

    function setAccepting(bool on) external {
        accepting = on;
    }

    receive() external payable {
        if (!accepting) revert("RejectingPlayer: no thanks");
    }
}
