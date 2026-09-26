// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Minimal mirror of the v4-core surface this contract touches, so the repo needs no v4 submodule.
// Layouts pinned to Uniswap/v4-core @ 59d3ecf (the commit v4-periphery @ a7af5b34 builds against).
// `Currency` and `IHooks` are user-defined value types over `address`, so they are ABI-identical.

/// @dev v4-core src/types/PoolKey.sol
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @dev v4-core src/types/PoolOperation.sol
struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPoolManagerMinimal {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function unlock(bytes calldata data) external returns (bytes memory);
    /// @dev Returns `(callerDelta, feesAccrued)`; `BalanceDelta` is an int256 of two packed int128s.
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
}

/**
 * @notice Creates a v4 pool and funds it, so a swap has something to swap against.
 * @dev    Test/dev only: anyone may call `seed`, and it spends whatever tokens this contract holds.
 *         Liquidity is provisioned straight through `PoolManager.unlock` rather than through
 *         `PositionManager`, which keeps the NFT, its Permit2 approvals and its own action encoding
 *         out of the picture — none of that is what the CrossPermit router is trying to prove.
 */
contract V4PoolSeeder {
    using SafeERC20 for IERC20;

    IPoolManagerMinimal public immutable POOL_MANAGER;

    /// @dev v4-core libraries/Pool.sol — the only revert `seed` is allowed to swallow.
    bytes4 constant POOL_ALREADY_INITIALIZED = 0x7983c051;

    error NotPoolManager(address caller);

    constructor(address poolManager) {
        POOL_MANAGER = IPoolManagerMinimal(poolManager);
    }

    /**
     * @notice Initialise `key` at `sqrtPriceX96` if it is new, then add `liquidity` over the range.
     * @dev    Idempotent on the initialise step only: a pool this contract already created is
     *         reused, but any other revert propagates. Re-running adds more liquidity.
     */
    function seed(PoolKey calldata key, uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper, uint128 liquidity)
        external
    {
        try POOL_MANAGER.initialize(key, sqrtPriceX96) { }
        catch (bytes memory err) {
            if (bytes4(err) != POOL_ALREADY_INITIALIZED) _bubble(err);
        }
        POOL_MANAGER.unlock(abi.encode(key, tickLower, tickUpper, liquidity));
    }

    /// @notice Pool manager callback: the only place `modifyLiquidity` may be called from.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager(msg.sender);

        (PoolKey memory key, int24 tickLower, int24 tickUpper, uint128 liquidity) =
            abi.decode(data, (PoolKey, int24, int24, uint128));

        (int256 callerDelta,) = POOL_MANAGER.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        // BalanceDelta packs amount0 in the high 128 bits, amount1 in the low; negative = we owe it.
        _pay(key.currency0, int128(callerDelta >> 128));
        _pay(key.currency1, int128(callerDelta));
        return "";
    }

    /// @dev The ERC20 settle dance: `sync` snapshots the manager's balance, `settle` credits the delta.
    function _pay(address currency, int128 delta) private {
        if (delta >= 0) return;
        uint256 owed = uint256(uint128(-delta));
        POOL_MANAGER.sync(currency);
        IERC20(currency).safeTransfer(address(POOL_MANAGER), owed);
        POOL_MANAGER.settle();
    }

    function _bubble(bytes memory err) private pure {
        assembly {
            revert(add(err, 0x20), mload(err))
        }
    }
}
