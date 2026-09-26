// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { CrossPermit } from "../src/CrossPermit.sol";
import { ICrossPermit } from "../src/interfaces/ICrossPermit.sol";
import { IPoolManagerLiquidity, LiquidityDesk } from "../src/LiquidityDesk.sol";
import { MockUSDC } from "../src/mocks/MockUSDC.sol";
import { ModifyLiquidityParams, PoolKey } from "../src/V4PoolSeeder.sol";
import { Test } from "forge-std/Test.sol";

/**
 * @notice A PoolManager that does nothing but ask for money.
 * @dev    The real v4 core is not the thing under test here: what matters is that `unlockCallback`
 *         reaches `_settle` with a negative delta, which is the step that pulls the owner's tokens
 *         through CrossPermit. Stubbing it keeps this suite offline. Runs without FORK=1.
 */
contract DemandingPoolManager is IPoolManagerLiquidity {
    int128 internal immutable OWED0;
    int128 internal immutable OWED1;

    constructor(int128 owed0, int128 owed1) {
        OWED0 = owed0;
        OWED1 = owed1;
    }

    function unlock(bytes calldata data) external override returns (bytes memory) {
        return LiquidityDesk(msg.sender).unlockCallback(data);
    }

    /// @dev A BalanceDelta: amount0 in the high 128 bits, amount1 in the low, negative = owed to us.
    function modifyLiquidity(PoolKey memory, ModifyLiquidityParams memory, bytes calldata)
        external
        view
        override
        returns (int256 callerDelta, int256 feesAccrued)
    {
        callerDelta = (int256(OWED0) << 128) | int256(uint256(uint128(OWED1)));
        feesAccrued = 0;
    }

    function sync(address) external override { }

    function settle() external payable override returns (uint256) {
        return 0;
    }

    function take(address, address, uint256) external override { }
}

/**
 * @notice `LiquidityDesk.add` takes both the owner AND the pool from its caller, so an ungated
 *         `add` is a drain: a stranger names a pool of their own making and settles the victim's
 *         whole CrossPermit allowance into it. Regression test for that.
 */
contract LiquidityDeskAuthTest is Test {
    uint160 constant ALLOWED = 1000e6;
    uint128 constant OWED = 400e6;

    CrossPermit crossPermit;
    LiquidityDesk desk;
    MockUSDC token0;
    MockUSDC token1;
    DemandingPoolManager poolManager;
    PoolKey key;

    address victim = address(0xC11E27);
    address attacker = address(0xA77ACE);
    address manager = address(0xDE5);

    function setUp() public {
        crossPermit = new CrossPermit();
        poolManager = new DemandingPoolManager(-int128(OWED), -int128(OWED));
        desk = new LiquidityDesk(ICrossPermit(address(crossPermit)), address(poolManager));

        MockUSDC a = new MockUSDC();
        MockUSDC b = new MockUSDC();
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
        // The attacker's pool, not the victim's: the whole point is that `key` is caller-supplied.
        key = PoolKey(address(token0), address(token1), 3000, 60, address(0));

        token0.mint(victim, ALLOWED);
        token1.mint(victim, ALLOWED);
        vm.startPrank(victim);
        token0.approve(address(crossPermit), type(uint256).max);
        token1.approve(address(crossPermit), type(uint256).max);
        // The mandate: the desk may spend this much, and nothing says where.
        crossPermit.approve(address(token0), address(desk), ALLOWED, 0);
        crossPermit.approve(address(token1), address(desk), ALLOWED, 0);
        vm.stopPrank();
    }

    function test_strangerCannotAddOnSomeoneElsesBehalf() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(LiquidityDesk.NotAuthorised.selector, victim, attacker));
        desk.add(victim, key, -600, 600, 1e8, OWED, OWED);

        assertEq(token0.balanceOf(victim), ALLOWED, "not a token moved");
        (uint160 left,,) = crossPermit.allowance(victim, address(token0), address(desk));
        assertEq(left, ALLOWED, "and not a unit of the writ consumed");
    }

    /// @dev Revoking has to bite, or `setOperator` is decoration.
    function test_revokedOperatorCannotAdd() public {
        vm.prank(victim);
        desk.setOperator(manager, true);
        vm.prank(manager);
        desk.add(victim, key, -600, 600, 1e8, OWED, OWED);
        assertEq(token0.balanceOf(victim), ALLOWED - OWED, "a registered manager can still work the book");

        vm.prank(victim);
        desk.setOperator(manager, false);
        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(LiquidityDesk.NotAuthorised.selector, victim, manager));
        desk.add(victim, key, -600, 600, 1e8, OWED, OWED);
    }

    function test_ownerCanAddForThemselves() public {
        vm.prank(victim);
        desk.add(victim, key, -600, 600, 1e8, OWED, OWED);
        assertEq(token0.balanceOf(address(poolManager)), OWED, "the tokens went to the pool, not the desk");
        assertEq(token0.balanceOf(address(desk)), 0, "the desk custodies nothing");
    }
}
