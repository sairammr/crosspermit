// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// Uniswap's REAL Permit2 interface — the one Universal Router compiles against.
import { IAllowanceTransfer } from "permit2/src/interfaces/IAllowanceTransfer.sol";

/**
 * @notice Mirrors Universal Router's `Permit2Payments` spending path.
 * @dev    The router only ever pulls from its own caller (`payerIsUser = true` -> `payer = msgSender()`),
 *         through the `IAllowanceTransfer` interface. Here that interface points at CrossPermit instead of
 *         Permit2 — which is exactly the substitution the CrossPermit router makes at deploy time. If this contract can
 *         pull through CrossPermit, so can the real router.
 */
contract RouterPaymentsMirror {
    IAllowanceTransfer public immutable PERMIT2;

    error FromAddressIsNotOwner();

    constructor(address permit2OrCrossPermit) {
        PERMIT2 = IAllowanceTransfer(permit2OrCrossPermit);
    }

    /// @dev Mirrors `Payments.payOrPermit2Transfer` with payer == msg.sender.
    function pull(address token, address to, uint160 amount) external {
        PERMIT2.transferFrom(msg.sender, to, amount, token);
    }

    /// @dev Mirrors `Permit2Payments.permit2TransferFrom(batch, owner)`, including the owner check.
    function pullBatch(IAllowanceTransfer.AllowanceTransferDetails[] calldata details) external {
        for (uint256 i; i < details.length; ++i) {
            if (details[i].from != msg.sender) revert FromAddressIsNotOwner();
        }
        PERMIT2.transferFrom(details);
    }
}
