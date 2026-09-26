// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { MockUSDC } from "../src/mocks/MockUSDC.sol";
import { PoolKey, V4PoolSeeder } from "../src/V4PoolSeeder.sol";
import { Test } from "forge-std/Test.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { CrossPermit } from "../src/CrossPermit.sol";
import { ICrossPermit } from "../src/interfaces/ICrossPermit.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @dev v4-periphery src/interfaces/IV4Router.sol, on the pin the deployed router decodes with.
struct ExactInSingle {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}

/**
 * @notice The real v4 swap, against the LIVE contracts on each of the three testnets: Uniswap's own
 *         PoolManager, the deployed CrossPermit, and the deployed the CrossPermit router. Only the pool and its two
 *         tokens are new.
 *
 * This is the check `PERMIT2_TRANSFER_FROM` cannot make: `V4_SWAP` pays the pool through
 * `V4SwapRouter._payStandard -> payOrPermit2Transfer -> PERMIT2.transferFrom`, so a swap that
 * settles proves the router's `PERMIT2` immutable is our CrossPermit *on the path a dApp actually uses*.
 *
 * It costs no gas — forks simulate — so it is the pre-flight for `ts/e2e-testnet.ts`, which then
 * does the same thing for real. It needs a network, so it is opt-in and stays out of `script/test.sh`:
 *
 *   FORK=1 forge test --match-contract RouterFork -vv
 */
contract RouterForkTest is Test {
    using stdJson for string;

    // universal-router script/deployParameters/Deploy*.s.sol -> v4PoolManager.
    address constant PM_SEPOLIA = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address constant PM_BASE_SEPOLIA = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;
    address constant PM_UNICHAIN_SEPOLIA = 0x00B036B58a818B1BC34d502D3fE730Db729e62AC;

    bytes constant COMMAND_V4_SWAP = hex"10";
    bytes constant ACTIONS_EXACT_IN_SINGLE = hex"060c0f"; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL

    uint24 constant FEE = 3000;
    int24 constant TICK_SPACING = 60;
    uint160 constant SQRT_PRICE_1_1 = 79_228_162_514_264_337_593_543_950_336; // 2**96
    int24 constant TICK_LOWER = -600;
    int24 constant TICK_UPPER = 600;
    uint128 constant LIQUIDITY = 1e12; // ~29.5k of each 6-decimal token, so 1 USDC barely moves the price
    uint256 constant SEED_FUNDING = 1e14;

    uint128 constant SWAP_IN = 1e6;
    uint128 constant MIN_OUT = 0.99e6; // 0.3% fee plus a sliver of price impact

    uint256 ownerPk = 0xA11CE;
    address owner = vm.addr(ownerPk);

    CrossPermit crossPermit;
    IUniversalRouter router;
    V4PoolSeeder seeder;
    MockUSDC tokenIn;
    MockUSDC tokenOut;
    PoolKey key;

    function setUp() public {
        if (!vm.envOr("FORK", false)) vm.skip(true);
    }

    function test_v4Swap_ethereumSepolia() public {
        _swapThroughCrossPermit("RPC_ETH_SEPOLIA", 11_155_111, PM_SEPOLIA, "Sepolia");
    }

    function test_v4Swap_baseSepolia() public {
        _swapThroughCrossPermit("RPC_BASE_SEPOLIA", 84_532, PM_BASE_SEPOLIA, "BaseSepolia");
    }

    function test_v4Swap_unichainSepolia() public {
        _swapThroughCrossPermit("RPC_UNI_SEPOLIA", 1301, PM_UNICHAIN_SEPOLIA, "UnichainSepolia");
    }

    /**
     * @notice Seeding a pool that already exists tops up its liquidity instead of reverting.
     * @dev    `seed` swallows exactly `PoolAlreadyInitialized()` and bubbles everything else. Nothing
     *         else reaches that branch — both callers create fresh token addresses, or seed once —
     *         so without this the catch would rest on the selector alone.
     */
    function test_seedingAnExistingPoolIsIdempotent() public {
        vm.createSelectFork(vm.envString("RPC_BASE_SEPOLIA"));
        _bootstrapPool(PM_BASE_SEPOLIA, "BaseSepolia");
        seeder.seed(key, SQRT_PRICE_1_1, TICK_LOWER, TICK_UPPER, LIQUIDITY);
    }

    /// @notice One signature -> a CrossPermit allowance -> the live router swaps through a live v4 pool.
    function _swapThroughCrossPermit(string memory rpcEnv, uint256 chainId, address poolManager, string memory deployment)
        internal
    {
        vm.createSelectFork(vm.envString(rpcEnv));
        assertEq(block.chainid, chainId, string.concat(rpcEnv, " must serve chainId"));
        _bootstrapPool(poolManager, deployment);

        uint48 ts = uint48(block.timestamp);
        uint48 deadline = ts + 1 hours;

        // No allowance anywhere yet, so the swap cannot settle: SETTLE_ALL has nothing to pull from.
        vm.prank(owner);
        vm.expectRevert();
        router.execute(COMMAND_V4_SWAP, _v4SwapInputs(), deadline);

        ICrossPermit.ChainPermits memory cp;
        cp.chainId = uint64(chainId);
        cp.permits = new ICrossPermit.AllowanceOrTransfer[](1);
        cp.permits[0] = ICrossPermit.AllowanceOrTransfer({
            modeOrExpiration: deadline, // > 3 => increase allowance, and the value is its expiry
            tokenKey: bytes32(uint256(uint160(address(tokenIn)))),
            account: address(router),
            amountDelta: SWAP_IN
        });

        // Single-chain bundle, so the tree is one leaf and the proof is empty. The three-chain shape
        // is covered by CrossChainUniswapFlow and by ts/e2e-testnet.ts.
        bytes32 salt = keccak256("v4-fork");
        bytes memory sig = _sign(salt, deadline, ts, crossPermit.hashChainPermits(cp));
        crossPermit.permit(owner, salt, deadline, ts, cp, new bytes32[](0), sig);

        (uint160 allowed,,) = crossPermit.allowance(owner, address(tokenIn), address(router));
        assertEq(allowed, SWAP_IN, "CrossPermit allowance for the CrossPermit router");
        assertEq(tokenIn.allowance(owner, address(router)), 0, "the router has NO plain ERC20 approval");

        uint256 inBefore = tokenIn.balanceOf(owner);
        uint256 outBefore = tokenOut.balanceOf(owner);

        vm.prank(owner);
        router.execute(COMMAND_V4_SWAP, _v4SwapInputs(), deadline);

        assertEq(inBefore - tokenIn.balanceOf(owner), SWAP_IN, "the pool was paid out of the CrossPermit allowance");
        uint256 received = tokenOut.balanceOf(owner) - outBefore;
        assertGe(received, MIN_OUT, "TAKE_ALL delivered the output token to the swapper");
        emit log_named_uint(string.concat(deployment, ": received"), received);

        (uint160 left,,) = crossPermit.allowance(owner, address(tokenIn), address(router));
        assertEq(left, 0, "the allowance was consumed, not bypassed");
    }

    /// @dev Two fresh tokens, a pool holding them, and an owner funded and approved to CrossPermit.
    function _bootstrapPool(address poolManager, string memory deployment) internal {
        crossPermit = CrossPermit(vm.readFile("../deployments/crosspermit.json").readAddress(".address"));
        router = IUniversalRouter(
            vm.readFile(string.concat("../deployments/router-", deployment, ".json")).readAddress(".universalRouter")
        );
        assertGt(address(crossPermit).code.length, 0, "CrossPermit not deployed on this chain");
        assertGt(address(router).code.length, 0, "the CrossPermit router not deployed on this chain");
        assertGt(poolManager.code.length, 0, "no v4 PoolManager at the address from deployParameters");

        MockUSDC a = new MockUSDC();
        MockUSDC b = new MockUSDC();
        (tokenIn, tokenOut) = (a, b);
        // v4 requires currency0 < currency1; the swap direction follows from which one we pay in.
        key = address(a) < address(b)
            ? PoolKey(address(a), address(b), FEE, TICK_SPACING, address(0))
            : PoolKey(address(b), address(a), FEE, TICK_SPACING, address(0));

        seeder = new V4PoolSeeder(poolManager);
        a.mint(address(seeder), SEED_FUNDING);
        b.mint(address(seeder), SEED_FUNDING);
        seeder.seed(key, SQRT_PRICE_1_1, TICK_LOWER, TICK_UPPER, LIQUIDITY);

        tokenIn.mint(owner, 100e6);
        vm.prank(owner);
        tokenIn.approve(address(crossPermit), type(uint256).max); // one-time, exactly like Permit2
    }

    function _v4SwapInputs() internal view returns (bytes[] memory inputs) {
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInSingle({
                poolKey: key,
                zeroForOne: address(tokenIn) == key.currency0,
                amountIn: SWAP_IN,
                amountOutMinimum: MIN_OUT,
                minHopPriceX36: 0,
                hookData: ""
            })
        );
        params[1] = abi.encode(address(tokenIn), uint256(SWAP_IN)); // SETTLE_ALL: a maximum to pull
        params[2] = abi.encode(address(tokenOut), uint256(MIN_OUT)); // TAKE_ALL: a minimum to deliver

        inputs = new bytes[](1);
        inputs[0] = abi.encode(ACTIONS_EXACT_IN_SINGLE, params);
    }

    function _sign(bytes32 salt, uint48 deadline, uint48 ts, bytes32 root) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(crossPermit.SIGNED_CROSSPERMIT_TYPEHASH(), owner, salt, deadline, ts, root));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", crossPermit.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 vs) = vm.sign(ownerPk, digest);
        return abi.encodePacked(r, vs, v);
    }
}
