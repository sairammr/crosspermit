// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ICrossPermit } from "../interfaces/ICrossPermit.sol";
import { IAaveV4Hub, IAaveV4Spoke } from "./interfaces/IAaveV4.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title YieldRouter
 * @notice Deploys idle treasury cash into an Aave v4 Spoke, funded by the SAME single CrossPermit
 *         signature that granted every other permission in the intent.
 *
 * @dev Why this contract holds the Aave position rather than the depositor:
 *      `ISpoke.supply(reserveId, amount, onBehalfOf)` requires the caller to be `onBehalfOf` or an
 *      authorised position manager for it. Making each depositor authorise this router on the Spoke
 *      would cost a second signature per user — which is precisely the thing CrossPermit exists to
 *      remove. So the router supplies on behalf of itself and tracks each depositor's claim in
 *      shares here.
 *
 *      That is a real trade-off, stated plainly: this is a pooled position, so depositors share one
 *      Aave risk surface and a bug in the share maths below is a shared loss rather than an
 *      individual one. The share maths is therefore deliberately boring, and `test/YieldRouter*`
 *      covers the rounding cases.
 *
 * ponytail: one pooled position per (spoke, reserve). Per-depositor Aave positions become worth the
 * extra signature only if a depositor needs their own liquidation perimeter.
 */
contract YieldRouter {
    using SafeERC20 for IERC20;

    /// @notice CrossPermit, the only way principal enters this contract.
    ICrossPermit public immutable CROSS_PERMIT;

    address public immutable admin;

    struct Market {
        IAaveV4Spoke spoke;
        IAaveV4Hub hub;
        IERC20 asset;
        uint256 assetId;
        uint256 reserveId;
        /// @notice Hard ceiling on principal this router will place in this market.
        uint256 cap;
        bool enabled;
    }

    /// @notice marketId => market. Allowlisted, because a mispriced spoke must not absorb the book.
    mapping(bytes32 => Market) public markets;

    /// @notice marketId => total shares issued by this router.
    mapping(bytes32 => uint256) public totalShares;

    /// @notice marketId => depositor => shares.
    mapping(bytes32 => mapping(address => uint256)) public sharesOf;

    /// @notice marketId => principal this router has placed, for the cap check.
    mapping(bytes32 => uint256) public principal;

    event MarketSet(bytes32 indexed marketId, address spoke, address asset, uint256 reserveId, uint256 cap);
    event MarketDisabled(bytes32 indexed marketId);
    event Deposited(bytes32 indexed marketId, address indexed owner, uint256 assets, uint256 shares);
    event Withdrawn(bytes32 indexed marketId, address indexed owner, uint256 assets, uint256 shares);

    error NotAdmin();
    error UnknownMarket(bytes32 marketId);
    error MarketNotEnabled(bytes32 marketId);
    error CapExceeded(bytes32 marketId, uint256 attempted, uint256 cap);
    error ZeroAmount();
    error InsufficientShares(uint256 have, uint256 want);
    error NothingSupplied();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(ICrossPermit crossPermit, address admin_) {
        CROSS_PERMIT = crossPermit;
        admin = admin_;
    }

    /// @notice Deterministic id so off-chain callers can address a market without an on-chain lookup.
    function marketId(address spoke, address asset, uint256 reserveId) public pure returns (bytes32) {
        return keccak256(abi.encode(spoke, asset, reserveId));
    }

    function setMarket(
        IAaveV4Spoke spoke,
        IAaveV4Hub hub,
        IERC20 asset,
        uint256 assetId,
        uint256 reserveId,
        uint256 cap
    ) external onlyAdmin returns (bytes32 id) {
        id = marketId(address(spoke), address(asset), reserveId);
        markets[id] = Market({
            spoke: spoke,
            hub: hub,
            asset: asset,
            assetId: assetId,
            reserveId: reserveId,
            cap: cap,
            enabled: true
        });
        emit MarketSet(id, address(spoke), address(asset), reserveId, cap);
    }

    /// @notice Stop new deposits. Withdrawals stay open — disabling a market must never trap funds.
    function disableMarket(bytes32 id) external onlyAdmin {
        if (address(markets[id].spoke) == address(0)) revert UnknownMarket(id);
        markets[id].enabled = false;
        emit MarketDisabled(id);
    }

    /**
     * @notice Pull `amount` from `owner` through CrossPermit and supply it to the market.
     *
     * @dev The pull uses the allowance the owner's single cross-chain signature already granted to
     *      this router, so depositing needs no further approval and no further signature.
     *
     *      `msg.sender` is not trusted to name someone else's `owner` for free: CrossPermit's own
     *      `transferFrom` only moves funds the owner allowed THIS contract to spend, so the worst a
     *      stranger can do is deposit an owner's already-authorised funds into an allowlisted market
     *      and credit the shares to that same owner. No value leaves the owner's control.
     */
    function deposit(bytes32 id, address owner, uint160 amount) external returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        Market memory m = _enabled(id);

        if (principal[id] + amount > m.cap) revert CapExceeded(id, principal[id] + amount, m.cap);

        // Shares are priced BEFORE the new assets land, or the depositor would dilute themselves.
        uint256 supplied = m.spoke.getUserSuppliedAssets(m.reserveId, address(this));
        uint256 supply_ = totalShares[id];
        shares = supply_ == 0 || supplied == 0 ? amount : (uint256(amount) * supply_) / supplied;

        // Mint before the external calls, the same way `withdraw` burns before its own: the token
        // and the Spoke are the reentry points, and a second deposit landing while `totalShares`
        // still held the cached pre-mint figure would overwrite the first one's shares.
        totalShares[id] = supply_ + shares;
        sharesOf[id][owner] += shares;
        principal[id] += amount;

        CROSS_PERMIT.transferFrom(owner, address(this), amount, address(m.asset));

        // forceApprove, not approve: some tokens revert on a non-zero-to-non-zero allowance change.
        m.asset.forceApprove(address(m.spoke), amount);
        m.spoke.supply(m.reserveId, amount, address(this));

        emit Deposited(id, owner, amount, shares);
    }

    /**
     * @notice Burn `shares` and return the underlying to `msg.sender`.
     * @dev Only the share owner can withdraw. Unlike `deposit`, this MOVES value out, so there is no
     *      on-behalf-of form — the check is `msg.sender`'s own balance and nobody else's.
     */
    function withdraw(bytes32 id, uint256 shares) external returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        Market memory m = markets[id];
        if (address(m.spoke) == address(0)) revert UnknownMarket(id);

        uint256 have = sharesOf[id][msg.sender];
        if (have < shares) revert InsufficientShares(have, shares);

        uint256 supplied = m.spoke.getUserSuppliedAssets(m.reserveId, address(this));
        if (supplied == 0) revert NothingSupplied();

        uint256 supply_ = totalShares[id];
        assets = (shares * supplied) / supply_;

        // Burn before the external call: the Spoke is trusted, but re-entering with stale share
        // state is the one way this pooled accounting could be drained.
        sharesOf[id][msg.sender] = have - shares;
        totalShares[id] = supply_ - shares;
        principal[id] = principal[id] > assets ? principal[id] - assets : 0;

        (, uint256 got) = m.spoke.withdraw(m.reserveId, assets, address(this));
        // Aave may return marginally less than asked on a rounding boundary; pay out what arrived.
        m.asset.safeTransfer(msg.sender, got);

        emit Withdrawn(id, msg.sender, got, shares);
        return got;
    }

    // ---------- views ----------

    /// @notice What `owner`'s shares are worth in underlying right now, accrued interest included.
    function balanceOf(bytes32 id, address owner) external view returns (uint256) {
        Market memory m = markets[id];
        uint256 supply_ = totalShares[id];
        if (supply_ == 0) return 0;
        return (sharesOf[id][owner] * m.spoke.getUserSuppliedAssets(m.reserveId, address(this))) / supply_;
    }

    /**
     * @notice Utilisation of the asset, in ray (1e27 == 100%), measured at the HUB.
     *
     * @dev Measured at the Hub and not at the Spoke, because in Aave v4 the Hub is where liquidity
     *      lives. A Spoke can carry debt against zero local supply — on Ethereum today the Bluechip,
     *      Gold and Ethena spokes each borrow USDC while supplying none of it, drawing on shared hub
     *      liquidity. Dividing a Spoke's debt by its own supply is a v3 habit that reads as infinite
     *      utilisation on exactly those markets.
     *
     *      `drawnShares` are share-denominated, so they are converted through `drawnIndex` before
     *      being compared with `liquidity`, which is already in asset terms.
     */
    function utilisationRay(bytes32 id) public view returns (uint256) {
        Market memory m = _known(id);
        IAaveV4Hub.Asset memory a = m.hub.getAsset(m.assetId);
        uint256 drawn = (uint256(a.drawnShares) * uint256(a.drawnIndex)) / RAY;
        uint256 total = uint256(a.liquidity) + drawn;
        if (total == 0) return 0;
        return (drawn * RAY) / total;
    }

    /// @notice Assets supplied to, and debt drawn from, this market's reserve on its Spoke.
    function reserveTotals(bytes32 id) external view returns (uint256 supplied, uint256 debt) {
        Market memory m = _known(id);
        return (m.spoke.getReserveSuppliedAssets(m.reserveId), m.spoke.getReserveTotalDebt(m.reserveId));
    }

    /**
     * @notice Supply APR, in ray. This is DERIVED, not read.
     *
     * @dev Aave v4's Hub exposes only `getAssetDrawnRate` — the borrow rate. A supplier earns that
     *      rate on the borrowed fraction only, less the protocol's cut:
     *
     *          supplyAPR = drawnRate * utilisation * (1 - liquidityFee)
     *
     *      Stated as a derivation rather than presented as a protocol figure, because a treasury
     *      that reports a borrow rate as its own yield overstates its returns.
     */
    function apr(bytes32 id) public view returns (uint256) {
        Market memory m = _known(id);
        uint256 drawn = m.hub.getAssetDrawnRate(m.assetId);
        uint256 fee = m.hub.getAsset(m.assetId).liquidityFee; // basis points
        uint256 net = (drawn * (BPS - fee)) / BPS;
        return (net * utilisationRay(id)) / RAY;
    }

    /**
     * @notice Supply APY, in ray: the APR compounded per second over a year.
     *
     * @dev Third-order binomial expansion of (1 + r/n)^n - 1, the same approximation Aave uses for
     *      compounded interest. It is an approximation and is named one; at realistic rates the
     *      error is far below a basis point, and truncating always rounds the quoted yield DOWN,
     *      which is the safe direction for a number a treasury reports.
     *
     *      APR and APY are separate functions on purpose. Collapsing them into one "rate" is how a
     *      treasury ends up misreporting its own returns.
     */
    function apy(bytes32 id) external view returns (uint256) {
        uint256 ratePerSecond = apr(id) / SECONDS_PER_YEAR;
        uint256 base2 = (ratePerSecond * ratePerSecond) / RAY;
        uint256 base3 = (base2 * ratePerSecond) / RAY;

        uint256 n = SECONDS_PER_YEAR;
        uint256 second = (n * (n - 1)) / 2;
        uint256 third = (n * (n - 1) * (n - 2)) / 6;

        return ratePerSecond * n + second * base2 + third * base3;
    }

    uint256 internal constant RAY = 1e27;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    function _known(bytes32 id) internal view returns (Market memory m) {
        m = markets[id];
        if (address(m.spoke) == address(0)) revert UnknownMarket(id);
    }

    function _enabled(bytes32 id) internal view returns (Market memory m) {
        m = _known(id);
        if (!m.enabled) revert MarketNotEnabled(id);
    }
}
