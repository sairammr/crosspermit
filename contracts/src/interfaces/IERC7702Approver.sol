// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title IERC7702Approver
 * @notice Interface for the ERC-7702 Token Approver contract
 * @dev This interface defines the contract designed to work with ERC-7702
 *      to enable EOAs to batch approve tokens to CrossPermit
 */
interface IERC7702Approver {
    /// @notice Thrown when no tokens are provided for approval
    error NoTokensProvided();

    /// @notice Thrown when the crossPermit address is zero
    error ZeroCrossPermit();

    /// @notice Thrown when a token address is zero
    error ZeroAddress();

    /**
     * @notice The CrossPermit contract address that will receive approvals
     * @return The address of the CrossPermit contract
     */
    function CROSSPERMIT() external view returns (address);

    /**
     * @notice Approve multiple token types to CrossPermit in a single transaction
     * @dev This function is designed to be called via ERC-7702 delegatecall from an EOA
     *      - ERC20 tokens: Sets infinite allowance
     *      - ERC721 tokens: Calls setApprovalForAll
     *      - ERC1155 tokens: Calls setApprovalForAll
     * @param erc20Tokens Array of ERC20 token addresses to approve
     * @param erc721Tokens Array of ERC721 token contract addresses to approve
     * @param erc1155Tokens Array of ERC1155 token contract addresses to approve
     */
    function approve(
        address[] calldata erc20Tokens,
        address[] calldata erc721Tokens,
        address[] calldata erc1155Tokens
    ) external;
}
