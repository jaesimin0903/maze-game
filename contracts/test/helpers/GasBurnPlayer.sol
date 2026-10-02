// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A player contract whose receive function spins in an infinite loop, burning all the gas it is given.
contract GasBurnPlayer {
    bool public burning = true;

    function setBurning(bool on) external {
        burning = on;
    }

    receive() external payable {
        if (burning) {
            for (;;) {}
        }
    }
}
