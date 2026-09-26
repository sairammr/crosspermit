// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { MockUSDC } from "../src/mocks/MockUSDC.sol";
import { LiquidityDesk } from "../src/LiquidityDesk.sol";
import { PoolKey, V4PoolSeeder } from "../src/V4PoolSeeder.sol";
import { Test } from "forge-std/Test.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { CrossPermit } from "../src/CrossPermit.sol";
import { ICrossPermit } from "../src/interfaces/ICrossPermit.sol";

/**
 * @notice Liquidity provided into the LIVE v4 PoolManager on each testnet, funded by nothing but a
 *         CrossPermit signature — the same primitive the swap path uses, on the same live contracts.
 *
 * The claim under test is the one a treasury actually cares about: a desk it has never funded, and
 * to which it has never granted an ERC-20 approval, can put its capital to work in a pool, and can
 * still not take a single token out. So the test has three distinct actors — the client who signs,
 * the desk who calls, and an outsider — and asserts what each of them can and cannot do.
 *
 *   FORK=1 forge test --match-contract LiquidityFork -vv
 */
contract LiquidityForkTest is Test {
    using stdJson for string;

    address constant PM_SEPOLIA = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant PM_BASE_SEPOLIA = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;
    address constant PM_OP_SEPOLIA = 0xf7F5aB3DcA35e17dE187b459159BC643853B3c67;

    uint24 constant FEE = 3000;
    int24 constant TICK_SPACING = 60;
    uint160 constant SQRT_PRICE_1_1 = 79_228_162_514_264_337_593_543_950_336; // 2**96
    int24 constant TICK_LOWER = -600;
    int24 constant TICK_UPPER = 600;
    uint128 constant SEED_LIQUIDITY = 1e12;
    uint256 constant SEED_FUNDING = 1e14;

    /// @dev ~2.9 of each 6-decimal token at a 1:1 price over this range. Small on purpose: the
    ///      point is the settle path, not the size.
    uint128 constant CLIENT_LIQUIDITY = 1e8;
    uint128 constant MAX_PULL = 10e6;
    uint128 constant FUNDED = 100e6;

    uint256 clientPk = 0xC11E27;
    address client = vm.addr(clientPk);
    address desk = address(0xDE5);
    address outsider = address(0x0157DE4);

    CrossPermit crossPermit;
    LiquidityDesk liquidityDesk;
    V4PoolSeeder seeder;
    MockUSDC token0;
    MockUSDC token1;
    PoolKey key;

    function setUp() public {
        if (!vm.envOr("FORK", false)) vm.skip(true);
    }

    function test_provideLiquidity_baseSepolia() public {
        _run("RPC_BASE_SEPOLIA", 84_532, PM_BASE_SEPOLIA, "BaseSepolia");
    }

    function test_provideLiquidity_ethereumSepolia() public {
        _run("RPC_ETH_SEPOLIA", 11_155_111, PM_SEPOLIA, "Sepolia");
    }

    function test_provideLiquidity_optimismSepolia() public {
        _run("RPC_OP_SEPOLIA", 11_155_420, PM_OP_SEPOLIA, "OPSepolia");
    }

    function _run(string memory rpcEnv, uint256 chainId, address poolManager, string memory deployment) internal {
        vm.createSelectFork(vm.envString(rpcEnv));
        assertEq(block.chainid, chainId, string.concat(rpcEnv, " must serve chainId"));
        _bootstrap(poolManager, deployment);

        uint48 ts = uint48(block.timestamp);
        uint48 deadline = ts + 1 hours;

        // 1. Before the writ exists, the desk can do nothing with the client's money.
        vm.prank(desk);
        vm.expectRevert();
        liquidityDesk.add(client, key, TICK_LOWER, TICK_UPPER, CLIENT_LIQUIDITY, MAX_PULL, MAX_PULL);

        // 2. One signature, two tokens, one chain: the liquidity writ.
        _signLiquidityWrit(chainId, deadline, ts);

        (uint160 allowed0,,) = crossPermit.allowance(client, address(token0), address(liquidityDesk));
        (uint160 allowed1,,) = crossPermit.allowance(client, address(token1), address(liquidityDesk));
        assertEq(allowed0, MAX_PULL, "writ covers currency0");
        assertEq(allowed1, MAX_PULL, "writ covers currency1");
        assertEq(token0.allowance(client, address(liquidityDesk)), 0, "the desk holds NO plain ERC20 approval");

        uint256 before0 = token0.balanceOf(client);
        uint256 before1 = token1.balanceOf(client);
        uint256 pool0 = token0.balanceOf(poolManager);

        // 3. The desk — not the client — puts the client's capital into the pool.
        vm.prank(desk);
        liquidityDesk.add(client, key, TICK_LOWER, TICK_UPPER, CLIENT_LIQUIDITY, MAX_PULL, MAX_PULL);

        uint256 spent0 = before0 - token0.balanceOf(client);
        uint256 spent1 = before1 - token1.balanceOf(client);
        assertGt(spent0, 0, "currency0 left the client");
        assertGt(spent1, 0, "currency1 left the client");
        assertEq(token0.balanceOf(poolManager) - pool0, spent0, "and landed on the PoolManager, not the desk");
        assertEq(token0.balanceOf(address(liquidityDesk)), 0, "the desk custodies nothing");
        assertEq(token1.balanceOf(address(liquidityDesk)), 0, "the desk custodies nothing");
        assertEq(token0.balanceOf(desk), 0, "the caller received nothing");
        emit log_named_uint(string.concat(deployment, ": currency0 into the pool"), spent0);
        emit log_named_uint(string.concat(deployment, ": currency1 into the pool"), spent1);

        (uint160 left0,,) = crossPermit.allowance(client, address(token0), address(liquidityDesk));
        assertEq(left0, MAX_PULL - uint160(spent0), "the writ was consumed, not bypassed");

        // 4. The desk cannot pull the position back out. `remove` credits msg.sender's own salt,
        //    so the desk withdrawing "the client's" liquidity is not a permission check that could
        //    be misconfigured — there is simply no position under the desk's key to withdraw.
        vm.prank(desk);
        vm.expectRevert();
        liquidityDesk.remove(key, TICK_LOWER, TICK_UPPER, CLIENT_LIQUIDITY);
        vm.prank(outsider);
        vm.expectRevert();
        liquidityDesk.remove(key, TICK_LOWER, TICK_UPPER, CLIENT_LIQUIDITY);

        // 5. The client can, and the proceeds go to the client.
        uint256 held0 = token0.balanceOf(client);
        vm.prank(client);
        liquidityDesk.remove(key, TICK_LOWER, TICK_UPPER, CLIENT_LIQUIDITY);
        uint256 back0 = token0.balanceOf(client) - held0;
        assertGt(back0, 0, "the position paid back to the client");
        // v4 rounds withdrawals down by a wei or two against the withdrawer, by design.
        assertLe(back0, spent0, "never more than went in, absent fees");
        assertGe(back0 + 2, spent0, "and no more than dust was lost to rounding");
        assertEq(token0.balanceOf(address(liquidityDesk)), 0, "the desk still custodies nothing");
        emit log_named_uint(string.concat(deployment, ": currency0 returned to the client"), back0);
    }

    /// @dev One signed root covering both currencies on this chain: the liquidity writ.
    function _signLiquidityWrit(uint256 chainId, uint48 deadline, uint48 ts) internal {
        ICrossPermit.ChainPermits memory cp;
        cp.chainId = uint64(chainId);
        cp.permits = new ICrossPermit.AllowanceOrTransfer[](2);
        cp.permits[0] = ICrossPermit.AllowanceOrTransfer({
            modeOrExpiration: deadline, // > 3 => increase, and the value is the expiry
            tokenKey: bytes32(uint256(uint160(address(token0)))),
            account: address(liquidityDesk),
            amountDelta: MAX_PULL
        });
        cp.permits[1] = ICrossPermit.AllowanceOrTransfer({
            modeOrExpiration: deadline,
            tokenKey: bytes32(uint256(uint160(address(token1)))),
            account: address(liquidityDesk),
            amountDelta: MAX_PULL
        });

        bytes32 salt = keccak256("v4-liquidity-fork");
        bytes32 root = crossPermit.hashChainPermits(cp);
        bytes32 structHash =
            keccak256(abi.encode(crossPermit.SIGNED_CROSSPERMIT_TYPEHASH(), client, salt, deadline, ts, root));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", crossPermit.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 vs) = vm.sign(clientPk, digest);
        crossPermit.permit(client, salt, deadline, ts, cp, new bytes32[](0), abi.encodePacked(r, vs, v));
    }

    /// @dev Two fresh tokens, a live pool holding them, and a client funded and approved to CrossPermit.
    function _bootstrap(address poolManager, string memory deployment) internal {
        deployment; // the pool here is ours; the deployment name is kept for log parity with RouterFork
        crossPermit = CrossPermit(vm.readFile("../deployments/crosspermit.json").readAddress(".address"));
        assertGt(address(crossPermit).code.length, 0, "CrossPermit not deployed on this chain");
        assertGt(poolManager.code.length, 0, "no v4 PoolManager at the address from deployParameters");

        MockUSDC a = new MockUSDC();
        MockUSDC b = new MockUSDC();
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);
        key = PoolKey(address(token0), address(token1), FEE, TICK_SPACING, address(0));

        seeder = new V4PoolSeeder(poolManager);
        token0.mint(address(seeder), SEED_FUNDING);
        token1.mint(address(seeder), SEED_FUNDING);
        seeder.seed(key, SQRT_PRICE_1_1, TICK_LOWER, TICK_UPPER, SEED_LIQUIDITY);

        liquidityDesk = new LiquidityDesk(ICrossPermit(address(crossPermit)), poolManager);

        token0.mint(client, FUNDED);
        token1.mint(client, FUNDED);
        vm.startPrank(client);
        token0.approve(address(crossPermit), type(uint256).max); // one-time, exactly like Permit2
        token1.approve(address(crossPermit), type(uint256).max);
        vm.stopPrank();
    }
}
