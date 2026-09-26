// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/**
 * @title Aave v4 Hub and Spoke, the slice CrossPermit's treasury uses
 * @notice Hand-written against aave/aave-v4 rather than imported, so this repo does not inherit
 *         Aave's whole build (its own solc pin, its own OpenZeppelin, its own submodules). The
 *         signatures below are the ones the fork tests exercise against the LIVE mainnet contracts,
 *         which is what keeps this file honest: if Aave changes them, the fork tests fail.
 * @dev Aave v4 went live on Ethereum on 2026-03-30 with a Hub-and-Spoke design: a Liquidity Hub
 *      holds the assets, and Spokes are independent markets with their own collateral set and risk
 *      parameters drawing on shared hub liquidity.
 */
interface IAaveV4Hub {
    /// @dev Field order and widths must match IHub.Asset exactly — this is decoded from live state.
    struct Asset {
        uint120 liquidity;
        uint120 realizedFees;
        uint8 decimals;
        uint120 addedShares;
        uint120 swept;
        int200 premiumOffsetRay;
        uint120 drawnShares;
        uint120 premiumShares;
        uint16 liquidityFee;
        uint120 drawnIndex;
        uint96 drawnRate;
        uint40 lastUpdateTimestamp;
        address underlying;
        address irStrategy;
        address reinvestmentController;
        address feeReceiver;
        uint200 deficitRay;
    }

    function getAssetCount() external view returns (uint256);
    function getAsset(uint256 assetId) external view returns (Asset memory);

    /// @notice The BORROW rate, in ray. There is no direct supply-rate getter; see `YieldRouter.apr`.
    function getAssetDrawnRate(uint256 assetId) external view returns (uint256);
}

interface IAaveV4Spoke {
    /**
     * @notice Supply underlying to a reserve.
     * @dev The Spoke pulls the asset from the CALLER, so the caller must have approved it first.
     *      `onBehalfOf` must be the caller, or the caller must be an authorised position manager
     *      for it — which is why `YieldRouter` holds the position itself. See the note there.
     */
    function supply(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);

    /// @notice Withdraw underlying. An amount above the maximum withdrawable signals a full exit.
    function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) external returns (uint256, uint256);

    function getReserveId(address hub, uint256 assetId) external view returns (uint256);
    function getReserveCount() external view returns (uint256);
    function getReserveSuppliedAssets(uint256 reserveId) external view returns (uint256);
    function getReserveTotalDebt(uint256 reserveId) external view returns (uint256);
    function getUserSuppliedAssets(uint256 reserveId, address user) external view returns (uint256);
    function getUserSuppliedShares(uint256 reserveId, address user) external view returns (uint256);
}
