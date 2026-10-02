// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A player contract that calls back into `target` whenever it receives ETH.
/// @dev The attack calldata lives in the code of a data contract, so loading it costs one account access instead
/// of one storage read per word. That keeps even a full `settle` call affordable inside the 30,000 gas a payout
/// forwards. The flags share one storage slot for the same reason.
contract ReentrantPlayer {
    uint8 public constant NOT_ATTEMPTED = 0;
    uint8 public constant REVERTED = 1;
    uint8 public constant SUCCEEDED = 2;

    address public immutable target;

    address private _payload;
    /// @notice Result of the most recent nested call.
    uint8 public lastResult;
    /// @notice When set, a failed nested call makes the receive function revert as well.
    bool public bubble;
    uint32 public attempts;

    uint256 public attackValue;

    constructor(address target_) {
        target = target_;
    }

    /// @param attack Calldata sent to `target` from the receive function.
    /// @param value ETH sent along with the nested call.
    function arm(bytes calldata attack, uint256 value, bool bubble_) external {
        // Init code that returns `0x00 ‖ attack` as runtime code:
        // PUSH2 size, DUP1, PUSH1 12, PUSH1 0, CODECOPY, PUSH1 0, RETURN
        bytes memory initCode =
            abi.encodePacked(hex"61", uint16(attack.length + 1), hex"80600c6000396000f3", hex"00", attack);
        address payload;
        assembly {
            payload := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(payload != address(0), "ReentrantPlayer: payload deployment failed");

        _payload = payload;
        lastResult = NOT_ATTEMPTED;
        bubble = bubble_;
        attempts = 0;
        attackValue = value;
    }

    function disarm() external {
        _payload = address(0);
    }

    receive() external payable {
        address payload = _payload;
        if (payload == address(0)) return;

        uint256 size = payload.code.length - 1;
        bytes memory attack = new bytes(size);
        assembly {
            extcodecopy(payload, add(attack, 0x20), 1, size)
        }

        (bool ok,) = target.call{value: attackValue}(attack);
        lastResult = ok ? SUCCEEDED : REVERTED;
        ++attempts;
        if (!ok && bubble) revert("ReentrantPlayer: nested call failed");
    }
}
