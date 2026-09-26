// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ICrossPermit } from "../interfaces/ICrossPermit.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title IComplianceGate
 * @notice Whether an account may hold or trade a given tokenized equity.
 * @dev Tokenized equities are access-gated instruments (Reg D / Reg S, jurisdictional allowlists),
 *      and the issuer's own token usually enforces its own transfer restrictions. This interface
 *      does not replace that; it makes the desk's position explicit and auditable on its own terms,
 *      so a refusal is a documented decision rather than an opaque revert from a third party.
 *
 *      Implementations MUST default to deny. Who may trade is the operator's decision; the
 *      contract's job is to make that decision explicit and enforced.
 */
interface IComplianceGate {
    function mayTrade(address account, address equityToken) external view returns (bool);
}

/**
 * @title IEquityVenue
 * @notice One way to turn cash into a tokenized equity, and back.
 * @dev Two shapes exist in practice: an issuer mint/redeem window (Ondo, Backed) and an AMM route.
 *      They differ enough in settlement that the desk talks to neither directly.
 */
interface IEquityVenue {
    /// @notice Spend exactly `amountIn` of `cashToken`, deliver at least `minOut` of `equityToken`.
    function buy(address cashToken, address equityToken, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 amountOut);

    /// @notice Sell exactly `amountIn` of `equityToken` for at least `minOut` of `cashToken`.
    function sell(address equityToken, address cashToken, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 amountOut);
}

/**
 * @title IPriceOracle
 * @notice Reference price for an equity token, with the timestamp it was observed.
 */
interface IPriceOracle {
    /// @return price Cash units per whole equity token, scaled by 1e18.
    /// @return updatedAt Unix seconds when the price was last written.
    function priceOf(address equityToken) external view returns (uint256 price, uint256 updatedAt);
}

/**
 * @title EquityDesk
 * @notice Institutional desk for tokenized equities — NVIDIA and peers — funded by the same single
 *         CrossPermit signature that carries the rest of an intent, so a cross-chain rebalance into
 *         equity exposure is still one signature.
 *
 * @dev Every fill is bounded three ways, because a desk that fills at any price is not a desk:
 *      a caller-supplied `minOut`, an oracle refPrice price with a staleness bound, and a maximum
 *      deviation from that refPrice. Reject rather than fill wide.
 */
contract EquityDesk {
    using SafeERC20 for IERC20;

    ICrossPermit public immutable CROSS_PERMIT;
    address public immutable admin;

    IComplianceGate public gate;
    IPriceOracle public oracle;

    /// @notice Oldest price this desk will trade against.
    uint256 public maxPriceAge = 1 hours;

    /// @notice Maximum tolerated deviation of the achieved price from the oracle, in basis points.
    uint256 public maxDeviationBps = 200;

    struct Listing {
        IEquityVenue venue;
        IERC20 cash;
        bool enabled;
    }

    /// @notice equityToken => how this desk trades it.
    mapping(address => Listing) public listings;

    event Listed(address indexed equityToken, address venue, address cash);
    event Delisted(address indexed equityToken);
    event Bought(address indexed owner, address indexed equityToken, uint256 cashIn, uint256 equityOut);
    event Sold(address indexed owner, address indexed equityToken, uint256 equityIn, uint256 cashOut);
    event RiskParamsSet(uint256 maxPriceAge, uint256 maxDeviationBps);

    error NotAdmin();
    error NotListed(address equityToken);
    error ComplianceDenied(address account, address equityToken);
    error NoGate();
    error StalePrice(address equityToken, uint256 updatedAt, uint256 nowTs);
    error PriceOutOfBand(uint256 achieved, uint256 refPrice, uint256 maxDeviationBps);
    error ZeroAmount();
    error SlippageTooHigh(uint256 got, uint256 minOut);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(ICrossPermit crossPermit, address admin_) {
        CROSS_PERMIT = crossPermit;
        admin = admin_;
        // gate and oracle start unset, and every trading path reverts until they are configured.
        // Defaulting to deny is the point; a desk that trades before it is configured is the bug.
    }

    function setGate(IComplianceGate gate_) external onlyAdmin {
        gate = gate_;
    }

    function setOracle(IPriceOracle oracle_) external onlyAdmin {
        oracle = oracle_;
    }

    function setRiskParams(uint256 maxPriceAge_, uint256 maxDeviationBps_) external onlyAdmin {
        maxPriceAge = maxPriceAge_;
        maxDeviationBps = maxDeviationBps_;
        emit RiskParamsSet(maxPriceAge_, maxDeviationBps_);
    }

    function list(address equityToken, IEquityVenue venue, IERC20 cash) external onlyAdmin {
        listings[equityToken] = Listing({ venue: venue, cash: cash, enabled: true });
        emit Listed(equityToken, address(venue), address(cash));
    }

    function delist(address equityToken) external onlyAdmin {
        listings[equityToken].enabled = false;
        emit Delisted(equityToken);
    }

    /**
     * @notice Buy `equityToken` for `owner`, funded by pulling cash through CrossPermit.
     * @dev The equity lands with `owner`, never with this desk — a desk that custodies the position
     *      would be a different regulated thing entirely.
     */
    function buy(address equityToken, address owner, uint160 cashIn, uint256 minOut)
        external
        returns (uint256 equityOut)
    {
        if (cashIn == 0) revert ZeroAmount();
        Listing memory l = _listed(equityToken);
        _checkCompliance(owner, equityToken);

        (uint256 refPrice,) = _freshPrice(equityToken);

        CROSS_PERMIT.transferFrom(owner, address(this), cashIn, address(l.cash));
        l.cash.forceApprove(address(l.venue), cashIn);
        equityOut = l.venue.buy(address(l.cash), equityToken, cashIn, minOut, owner);

        if (equityOut < minOut) revert SlippageTooHigh(equityOut, minOut);
        // Achieved price in cash per whole equity token, same 1e18 scale as the oracle.
        _checkBand((uint256(cashIn) * 1e18) / equityOut, refPrice);

        emit Bought(owner, equityToken, cashIn, equityOut);
    }

    /**
     * @notice Sell `equityToken` held by `msg.sender`, returning cash to them.
     * @dev No on-behalf-of form: this moves the caller's own equity, so the balance checked is
     *      theirs. The equity is pulled with a plain ERC20 `transferFrom`, because the issuer's
     *      token is the thing being moved and it enforces its own transfer rules.
     */
    function sell(address equityToken, uint256 equityIn, uint256 minOut) external returns (uint256 cashOut) {
        if (equityIn == 0) revert ZeroAmount();
        Listing memory l = _listed(equityToken);
        _checkCompliance(msg.sender, equityToken);

        (uint256 refPrice,) = _freshPrice(equityToken);

        IERC20(equityToken).safeTransferFrom(msg.sender, address(this), equityIn);
        IERC20(equityToken).forceApprove(address(l.venue), equityIn);
        cashOut = l.venue.sell(equityToken, address(l.cash), equityIn, minOut, msg.sender);

        if (cashOut < minOut) revert SlippageTooHigh(cashOut, minOut);
        _checkBand((cashOut * 1e18) / equityIn, refPrice);

        emit Sold(msg.sender, equityToken, equityIn, cashOut);
    }

    // ---------- guards ----------

    function _listed(address equityToken) internal view returns (Listing memory l) {
        l = listings[equityToken];
        if (!l.enabled) revert NotListed(equityToken);
    }

    /// @dev An unset gate denies everything. Deny-by-default is not a config option.
    function _checkCompliance(address account, address equityToken) internal view {
        if (address(gate) == address(0)) revert NoGate();
        if (!gate.mayTrade(account, equityToken)) revert ComplianceDenied(account, equityToken);
    }

    function _freshPrice(address equityToken) internal view returns (uint256 price, uint256 updatedAt) {
        (price, updatedAt) = oracle.priceOf(equityToken);
        // A price from the future is as broken as one that is too old; both mean a bad feed.
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxPriceAge) {
            revert StalePrice(equityToken, updatedAt, block.timestamp);
        }
        if (price == 0) revert StalePrice(equityToken, updatedAt, block.timestamp);
    }

    function _checkBand(uint256 achieved, uint256 refPrice) internal view {
        uint256 diff = achieved > refPrice ? achieved - refPrice : refPrice - achieved;
        if ((diff * 10_000) / refPrice > maxDeviationBps) {
            revert PriceOutOfBand(achieved, refPrice, maxDeviationBps);
        }
    }
}
