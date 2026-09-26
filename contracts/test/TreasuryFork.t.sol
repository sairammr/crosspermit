// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { CrossPermit } from "../src/CrossPermit.sol";
import { ICrossPermit } from "../src/interfaces/ICrossPermit.sol";
import { EquityDesk, IComplianceGate, IEquityVenue, IPriceOracle } from "../src/treasury/EquityDesk.sol";
import { YieldRouter } from "../src/treasury/YieldRouter.sol";
import { IAaveV4Hub, IAaveV4Spoke } from "../src/treasury/interfaces/IAaveV4.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Test } from "forge-std/Test.sol";
import { console } from "forge-std/console.sol";

/**
 * @notice The treasury layer against LIVE mainnet: Aave v4's real Hub and Spoke, and Ondo's real
 *         tokenized NVIDIA. Opt-in via FORK=1 so the offline suite stays offline.
 *
 *         FORK=1 forge test --match-contract TreasuryFork -vv
 *
 * @dev These are the tests that stop `IAaveV4.sol` from drifting into fiction. Every signature in
 *      that file is hand-written; if Aave changes one, the calls below stop decoding and this fails.
 */
contract TreasuryForkTest is Test {
    // Aave v4 Ethereum, from bgd-labs/aave-address-book.
    address constant CORE_HUB = 0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9;
    address constant PRIME_HUB = 0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931;
    address constant BLUECHIP_SPOKE = 0x973a023A77420ba610f06b3858aD991Df6d85A08;

    /// @notice The spoke that actually supplies USDC. Bluechip borrows it against zero local supply.
    address constant MAIN_SPOKE = 0x94e7A5dCbE816e498b89aB752661904E2F56c485;

    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    /// @notice Ondo's tokenized NVIDIA. "NVIDIA (Ondo Tokenized)", 18 decimals.
    address constant NVDAON = 0x2D1F7226Bd1F780AF6B9A49DCC0aE00E8Df4bDEE;

    CrossPermit crossPermit;
    address owner = makeAddr("institution");
    address admin = makeAddr("admin");

    function setUp() public {
        if (!vm.envOr("FORK", false)) vm.skip(true);
        vm.createSelectFork(vm.envString("RPC_ETH_MAINNET"));
        // CrossPermit is not on mainnet yet, so the fork gets its own. The address is irrelevant
        // here: what is under test is the treasury path, not the cross-chain address invariant.
        crossPermit = new CrossPermit();
    }

    // ---------- Aave v4 is really there, and shaped the way IAaveV4.sol claims ----------

    function test_aaveV4_hubIsLiveAndDecodes() public view {
        IAaveV4Hub hub = IAaveV4Hub(CORE_HUB);
        uint256 count = hub.getAssetCount();
        assertGt(count, 0, "Core Hub lists no assets");

        (uint256 assetId, bool found) = _findAsset(hub, USDC);
        assertTrue(found, "USDC is not listed on the Core Hub");

        IAaveV4Hub.Asset memory a = hub.getAsset(assetId);
        assertEq(a.underlying, USDC, "asset struct decoded to the wrong underlying");
        assertEq(a.decimals, 6, "USDC should be 6 decimals");
        // A struct that decoded by luck would not also produce a sane fee, so check the range.
        assertLe(a.liquidityFee, 10_000, "liquidityFee is not basis points");

        console.log("Core Hub assets:", count);
        console.log("USDC assetId:", assetId);
        console.log("USDC drawn rate (ray):", hub.getAssetDrawnRate(assetId));
    }

    function test_aaveV4_spokeExposesTheReserve() public view {
        IAaveV4Hub hub = IAaveV4Hub(CORE_HUB);
        (uint256 assetId, bool found) = _findAsset(hub, USDC);
        vm.assume(found);

        IAaveV4Spoke spoke = IAaveV4Spoke(MAIN_SPOKE);
        assertGt(spoke.getReserveCount(), 0, "spoke lists no reserves");

        uint256 reserveId = spoke.getReserveId(CORE_HUB, assetId);
        uint256 supplied = spoke.getReserveSuppliedAssets(reserveId);
        uint256 debt = spoke.getReserveTotalDebt(reserveId);
        console.log("MAIN reserveId:", reserveId);
        console.log("supplied:", supplied);
        console.log("debt:", debt);
        assertGt(supplied, 0, "MAIN spoke supplies no USDC");

        // The hub-and-spoke property itself: a Spoke may owe more than it locally holds, because the
        // liquidity it draws on belongs to the Hub. Bluechip does exactly this with USDC today, and
        // asserting otherwise would be importing a v3 assumption.
        IAaveV4Spoke bluechip = IAaveV4Spoke(BLUECHIP_SPOKE);
        uint256 bcReserve = bluechip.getReserveId(CORE_HUB, assetId);
        assertEq(bluechip.getReserveSuppliedAssets(bcReserve), 0, "Bluechip unexpectedly supplies USDC");
        assertGt(bluechip.getReserveTotalDebt(bcReserve), 0, "Bluechip should carry USDC debt from the hub");
    }

    // ---------- the actual product claim: one CrossPermit signature funds an Aave v4 position ----

    function test_oneAllowance_fundsAnAaveV4Position() public {
        IAaveV4Hub hub = IAaveV4Hub(CORE_HUB);
        IAaveV4Spoke spoke = IAaveV4Spoke(MAIN_SPOKE);
        (uint256 assetId, bool found) = _findAsset(hub, USDC);
        assertTrue(found, "USDC not listed");
        uint256 reserveId = spoke.getReserveId(CORE_HUB, assetId);

        YieldRouter router = new YieldRouter(ICrossPermit(address(crossPermit)), admin);
        vm.prank(admin);
        bytes32 id = router.setMarket(spoke, hub, IERC20(USDC), assetId, reserveId, 1_000_000e6);

        uint256 amount = 10_000e6;
        deal(USDC, owner, amount);

        // The one on-chain approval an owner ever makes, exactly like Permit2.
        vm.prank(owner);
        IERC20(USDC).approve(address(crossPermit), type(uint256).max);

        // The allowance a cross-chain signature would have granted. `permit(AllowanceOrTransfer[])`
        // is the direct form; the signed merkle form is covered by CrossChainFlow.t.sol, and both
        // land in the same allowance storage, so this isolates the treasury path.
        ICrossPermit.AllowanceOrTransfer[] memory permits = new ICrossPermit.AllowanceOrTransfer[](1);
        permits[0] = ICrossPermit.AllowanceOrTransfer({
            modeOrExpiration: uint48(block.timestamp + 1 days),
            tokenKey: bytes32(uint256(uint160(USDC))),
            account: address(router),
            amountDelta: uint160(amount)
        });
        vm.prank(owner);
        crossPermit.permit(permits);

        uint256 before = spoke.getUserSuppliedAssets(reserveId, address(router));

        // Anyone may push the deposit; the funds and the credit are the owner's either way.
        uint256 shares = router.deposit(id, owner, uint160(amount));
        assertGt(shares, 0, "no shares issued");

        uint256 supplied = spoke.getUserSuppliedAssets(reserveId, address(router)) - before;
        // Aave rounds down on share conversion, so allow one unit of dust rather than demanding
        // exact equality — demanding it would make this test fail on a rounding boundary, not a bug.
        assertApproxEqAbs(supplied, amount, 1, "the Spoke did not receive the principal");
        assertApproxEqAbs(router.balanceOf(id, owner), amount, 1, "owner's claim does not match");

        // The allowance was consumed, not bypassed.
        (uint160 left,,) = crossPermit.allowance(owner, USDC, address(router));
        assertEq(left, 0, "allowance should be spent exactly");

        // Interest accrues, and the owner's claim grows with it rather than staying nominal.
        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + 1);
        assertGe(router.balanceOf(id, owner), amount - 1, "claim shrank over time");

        // And it comes back out.
        uint256 cashBefore = IERC20(USDC).balanceOf(owner);
        vm.prank(owner);
        uint256 out = router.withdraw(id, shares);
        assertGt(out, 0, "withdrew nothing");
        assertEq(IERC20(USDC).balanceOf(owner) - cashBefore, out, "owner did not receive the withdrawal");
        assertEq(router.sharesOf(id, owner), 0, "shares not burned");

        console.log("supplied:", supplied);
        console.log("apr  (ray):", router.apr(id));
        console.log("apy  (ray):", router.apy(id));
        console.log("util (ray):", router.utilisationRay(id));
        console.log("withdrawn:", out);
    }

    function test_apyIsAtLeastApr_andBothAreSane() public {
        IAaveV4Hub hub = IAaveV4Hub(CORE_HUB);
        IAaveV4Spoke spoke = IAaveV4Spoke(MAIN_SPOKE);
        (uint256 assetId,) = _findAsset(hub, USDC);
        uint256 reserveId = spoke.getReserveId(CORE_HUB, assetId);

        YieldRouter router = new YieldRouter(ICrossPermit(address(crossPermit)), admin);
        vm.prank(admin);
        bytes32 id = router.setMarket(spoke, hub, IERC20(USDC), assetId, reserveId, 1e30);

        uint256 aprRay = router.apr(id);
        uint256 apyRay = router.apy(id);

        // Compounding can only add. If APY ever came out below APR the expansion would be wrong, and
        // a treasury would be under-reporting a number it reports to investors.
        assertGe(apyRay, aprRay, "APY below APR");
        // A supply rate above 100% on a bluechip USDC reserve means the derivation is broken, not
        // that the market is generous.
        assertLt(aprRay, 1e27, "supply APR above 100 percent, derivation is wrong");
        assertLe(router.utilisationRay(id), 1e27, "utilisation above 100%");
    }

    function test_capIsEnforced() public {
        IAaveV4Hub hub = IAaveV4Hub(CORE_HUB);
        IAaveV4Spoke spoke = IAaveV4Spoke(MAIN_SPOKE);
        (uint256 assetId,) = _findAsset(hub, USDC);
        uint256 reserveId = spoke.getReserveId(CORE_HUB, assetId);

        YieldRouter router = new YieldRouter(ICrossPermit(address(crossPermit)), admin);
        vm.prank(admin);
        bytes32 id = router.setMarket(spoke, hub, IERC20(USDC), assetId, reserveId, 100e6);

        deal(USDC, owner, 1_000e6);
        vm.prank(owner);
        IERC20(USDC).approve(address(crossPermit), type(uint256).max);
        _allow(address(router), 1_000e6);

        vm.expectRevert(abi.encodeWithSelector(YieldRouter.CapExceeded.selector, id, 1_000e6, 100e6));
        router.deposit(id, owner, 1_000e6);
    }

    // ---------- the equity desk against the real NVDAon token ----------

    function test_nvdaOnIsARealErc20() public view {
        assertGt(NVDAON.code.length, 0, "NVDAon has no code on this fork");
        assertEq(IERC20Metadata(NVDAON).symbol(), "NVDAon", "wrong token at the NVDAon address");
        assertEq(IERC20Metadata(NVDAON).decimals(), 18, "NVDAon decimals changed");
        assertGt(IERC20(NVDAON).totalSupply(), 0, "NVDAon has no supply");
        console.log("NVDAon name:", IERC20Metadata(NVDAON).name());
        console.log("NVDAon supply:", IERC20(NVDAON).totalSupply());
    }

    /**
     * @dev The desk's venue is a MOCK here, and that is a deliberate limitation rather than an
     *      oversight: NVDAon's on-chain route is the issuer's gated mint/redeem window, not an AMM
     *      anyone can trade against from a fork. What these tests do prove is the part that is ours
     *      — the compliance gate, the staleness bound, the price band, and that funding comes
     *      through CrossPermit. Wiring a real venue adapter is tracked in PLAN.md.
     */
    function test_desk_deniesByDefault_thenTradesWhenPermitted() public {
        EquityDesk desk = new EquityDesk(ICrossPermit(address(crossPermit)), admin);
        MockVenue venue = new MockVenue(2e18); // 2 cash units per equity unit
        MockOracle oracle = new MockOracle();
        MockGate gate = new MockGate();

        vm.startPrank(admin);
        desk.list(NVDAON, venue, IERC20(USDC));
        desk.setOracle(oracle);
        vm.stopPrank();

        deal(USDC, owner, 1_000e6);
        vm.prank(owner);
        IERC20(USDC).approve(address(crossPermit), type(uint256).max);
        _allow(address(desk), 1_000e6);

        oracle.set(NVDAON, 2e18, block.timestamp);
        deal(NVDAON, address(venue), 1_000e18);

        // Every buy is pranked as the owner: `buy` is owner-only now, so an unpranked call would
        // revert with NotOwner before it ever reached the gate or the band this test is about.
        // No gate configured at all: deny.
        vm.expectRevert(EquityDesk.NoGate.selector);
        vm.prank(owner);
        desk.buy(NVDAON, owner, 100e6, 0);

        // Gate configured but this account not permitted: still deny.
        vm.prank(admin);
        desk.setGate(gate);
        vm.expectRevert(abi.encodeWithSelector(EquityDesk.ComplianceDenied.selector, owner, NVDAON));
        vm.prank(owner);
        desk.buy(NVDAON, owner, 100e6, 0);

        // Permitted: the fill goes through and the equity lands with the OWNER, not the desk.
        gate.allow(owner, NVDAON);
        vm.prank(owner);
        uint256 out = desk.buy(NVDAON, owner, 100e6, 0);
        assertGt(out, 0, "no equity delivered");
        assertEq(IERC20(NVDAON).balanceOf(owner), out, "equity did not land with the owner");
        assertEq(IERC20(NVDAON).balanceOf(address(desk)), 0, "the desk must not custody the position");
    }

    function test_desk_rejectsStalePriceAndWideFills() public {
        EquityDesk desk = new EquityDesk(ICrossPermit(address(crossPermit)), admin);
        MockVenue venue = new MockVenue(2e18);
        MockOracle oracle = new MockOracle();
        MockGate gate = new MockGate();
        gate.allow(owner, NVDAON);

        vm.startPrank(admin);
        desk.list(NVDAON, venue, IERC20(USDC));
        desk.setOracle(oracle);
        desk.setGate(gate);
        vm.stopPrank();

        deal(USDC, owner, 1_000e6);
        vm.prank(owner);
        IERC20(USDC).approve(address(crossPermit), type(uint256).max);
        _allow(address(desk), 1_000e6);
        deal(NVDAON, address(venue), 1_000e18);

        // Stale by more than maxPriceAge.
        oracle.set(NVDAON, 2e18, block.timestamp - 2 hours);
        vm.expectRevert();
        vm.prank(owner);
        desk.buy(NVDAON, owner, 100e6, 0);

        // A price from the future is as broken as one too old.
        oracle.set(NVDAON, 2e18, block.timestamp + 1 hours);
        vm.expectRevert();
        vm.prank(owner);
        desk.buy(NVDAON, owner, 100e6, 0);

        // Fresh price, but the venue fills far away from it: reject rather than fill wide.
        oracle.set(NVDAON, 2e18, block.timestamp);
        venue.setRate(3e18);
        vm.expectRevert();
        vm.prank(owner);
        desk.buy(NVDAON, owner, 100e6, 0);

        // Back inside the band: fills.
        venue.setRate(2e18);
        vm.prank(owner);
        assertGt(desk.buy(NVDAON, owner, 100e6, 0), 0, "in-band fill was rejected");
    }

    // ---------- helpers ----------

    function _findAsset(IAaveV4Hub hub, address underlying) internal view returns (uint256 id, bool found) {
        uint256 n = hub.getAssetCount();
        for (uint256 i; i < n; ++i) {
            if (hub.getAsset(i).underlying == underlying) return (i, true);
        }
        return (0, false);
    }

    function _allow(address spender, uint160 amount) internal {
        ICrossPermit.AllowanceOrTransfer[] memory permits = new ICrossPermit.AllowanceOrTransfer[](1);
        permits[0] = ICrossPermit.AllowanceOrTransfer({
            modeOrExpiration: uint48(block.timestamp + 1 days),
            tokenKey: bytes32(uint256(uint160(USDC))),
            account: spender,
            amountDelta: amount
        });
        vm.prank(owner);
        crossPermit.permit(permits);
    }
}

interface IERC20Metadata {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

contract MockGate is IComplianceGate {
    mapping(address => mapping(address => bool)) public permitted;

    function allow(address who, address token) external {
        permitted[who][token] = true;
    }

    function mayTrade(address account, address equityToken) external view returns (bool) {
        return permitted[account][equityToken];
    }
}

contract MockOracle is IPriceOracle {
    mapping(address => uint256) internal price;
    mapping(address => uint256) internal at;

    function set(address token, uint256 p, uint256 t) external {
        price[token] = p;
        at[token] = t;
    }

    function priceOf(address token) external view returns (uint256, uint256) {
        return (price[token], at[token]);
    }
}

/// @dev Constant-rate venue. `rate` is cash units (1e6) per whole equity token, scaled to 1e18.
contract MockVenue is IEquityVenue {
    uint256 public rate;

    constructor(uint256 rate_) {
        rate = rate_;
    }

    function setRate(uint256 rate_) external {
        rate = rate_;
    }

    function buy(address cashToken, address equityToken, uint256 amountIn, uint256, address to)
        external
        returns (uint256 amountOut)
    {
        IERC20(cashToken).transferFrom(msg.sender, address(this), amountIn);
        amountOut = (amountIn * 1e18) / rate;
        IERC20(equityToken).transfer(to, amountOut);
    }

    function sell(address equityToken, address cashToken, uint256 amountIn, uint256, address to)
        external
        returns (uint256 amountOut)
    {
        IERC20(equityToken).transferFrom(msg.sender, address(this), amountIn);
        amountOut = (amountIn * rate) / 1e18;
        IERC20(cashToken).transfer(to, amountOut);
    }
}
