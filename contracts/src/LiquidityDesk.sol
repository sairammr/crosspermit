// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ICrossPermit } from "./interfaces/ICrossPermit.sol";
import { ModifyLiquidityParams, PoolKey } from "./V4PoolSeeder.sol";

/// @dev The slice of v4-core this contract touches. Layouts pinned to Uniswap/v4-core @ 59d3ecf,
///      the same pin `V4PoolSeeder` mirrors, so the two agree about `PoolKey`.
interface IPoolManagerLiquidity {
    function unlock(bytes calldata data) external returns (bytes memory);
    /// @dev Returns `(callerDelta, feesAccrued)`; a `BalanceDelta` is two packed int128s.
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

/**
 * @title LiquidityDesk
 * @notice Provides Uniswap v4 liquidity for a client, funded by the SAME CrossPermit signature that
 *         grants every other permission in their mandate. The client's tokens go straight from the
 *         client to the PoolManager, and everything the position ever pays back goes straight to
 *         the client. This contract never holds either.
 *
 * @dev Why this exists when `V4PoolSeeder` already adds liquidity: the seeder spends tokens it
 *      holds itself. That is fine for a dev fixture and useless for a mandate — a desk cannot be
 *      asked to fund a client's position out of its own balance sheet, and a client who transferred
 *      the tokens in first would have given up custody, which is the one thing the writ promises
 *      they never do. Here the settle leg is `CROSS_PERMIT.transferFrom(owner, poolManager, ...)`:
 *      the exact call the Universal Router makes when it settles a swap, so "may trade, may never
 *      withdraw" holds for liquidity on the same footing as it holds for swaps.
 *
 *      Positions are keyed by `salt = bytes32(uint256(uint160(owner)))`, so v4 core holds one
 *      position per client per range rather than one pooled position this contract has to
 *      apportion. No share maths, therefore no share-maths bug.
 *
 *      Every entry point is scoped to a caller. `remove` and `collect` take the owner from
 *      `msg.sender`, because those move value in the direction a mandate must never authorise.
 *      `add` names the owner as a parameter — a desk managing a client's book is exactly the
 *      caller it is for — so it is gated on the owner having said so: either they call it
 *      themselves, or they registered the caller through `setOperator`. It cannot be open, because
 *      `key` comes from the caller too: an open `add` lets anyone name a pool of their own making
 *      and settle the owner's entire allowance into it, which is a drain wearing a mandate's
 *      clothes.
 */
contract LiquidityDesk {
    /// @notice The only way a client's principal enters a pool through this contract.
    ICrossPermit public immutable CROSS_PERMIT;
    IPoolManagerLiquidity public immutable POOL_MANAGER;

    /// @notice owner => caller allowed to run `add` on that owner's behalf. Revocable at any time.
    mapping(address => mapping(address => bool)) public operators;

    event OperatorSet(address indexed owner, address indexed operator, bool allowed);

    event LiquidityAdded(
        address indexed owner, bytes32 indexed poolId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 amount0, uint256 amount1
    );
    event LiquidityRemoved(
        address indexed owner, bytes32 indexed poolId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 amount0, uint256 amount1
    );

    error NotPoolManager(address caller);
    error NotAuthorised(address owner, address caller);
    error PullExceedsMaximum(address currency, uint256 owed, uint256 maximum);
    error NothingToDo();

    constructor(ICrossPermit crossPermit, address poolManager) {
        CROSS_PERMIT = crossPermit;
        POOL_MANAGER = IPoolManagerLiquidity(poolManager);
    }

    /// @dev What `unlockCallback` is being asked to do. Encoded rather than stored, so a reentrant
    ///      call cannot find half-written state to work with.
    struct Job {
        address owner;
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        uint128 max0;
        uint128 max1;
    }

    /**
     * @notice Name, or unname, an address that may call `add` for you.
     * @dev    A CrossPermit allowance says how much a desk may move; it says nothing about which
     *         pool. This is where the owner says who gets to choose that.
     */
    function setOperator(address operator, bool allowed) external {
        operators[msg.sender][operator] = allowed;
        emit OperatorSet(msg.sender, operator, allowed);
    }

    /**
     * @notice Add `liquidity` over [`tickLower`, `tickUpper`] for `owner`, pulled under their writ.
     * @param  max0 Most of `currency0` this may pull. The slippage guard: the amount owed depends on
     *         the pool price at execution, which the caller cannot pin down when they sign.
     * @param  max1 The same, for `currency1`.
     * @dev    Callable by `owner`, or by an address `owner` registered through `setOperator`.
     */
    function add(
        address owner,
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint128 max0,
        uint128 max1
    ) external {
        if (msg.sender != owner && !operators[owner][msg.sender]) revert NotAuthorised(owner, msg.sender);
        if (liquidity == 0) revert NothingToDo();
        POOL_MANAGER.unlock(
            abi.encode(
                Job({
                    owner: owner,
                    key: key,
                    tickLower: tickLower,
                    tickUpper: tickUpper,
                    liquidityDelta: int256(uint256(liquidity)),
                    max0: max0,
                    max1: max1
                })
            )
        );
    }

    /**
     * @notice Withdraw `liquidity` and send both sides, plus fees earned, to the caller.
     * @dev    `msg.sender` is the owner. Not a parameter, deliberately: a desk that could name the
     *         owner here could time a client's exit, and the allowance does not authorise that.
     */
    function remove(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint128 liquidity) external {
        if (liquidity == 0) revert NothingToDo();
        POOL_MANAGER.unlock(
            abi.encode(
                Job({
                    owner: msg.sender,
                    key: key,
                    tickLower: tickLower,
                    tickUpper: tickUpper,
                    liquidityDelta: -int256(uint256(liquidity)),
                    max0: 0,
                    max1: 0
                })
            )
        );
    }

    /// @notice Sweep fees on an untouched position to the caller. A zero-delta modify does exactly that.
    function collect(PoolKey calldata key, int24 tickLower, int24 tickUpper) external {
        POOL_MANAGER.unlock(
            abi.encode(
                Job({
                    owner: msg.sender,
                    key: key,
                    tickLower: tickLower,
                    tickUpper: tickUpper,
                    liquidityDelta: int256(0),
                    max0: 0,
                    max1: 0
                })
            )
        );
    }

    /// @notice Pool manager callback: the only place `modifyLiquidity` may be called from.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager(msg.sender);
        Job memory job = abi.decode(data, (Job));

        (int256 callerDelta, int256 feesAccrued) = POOL_MANAGER.modifyLiquidity(
            job.key,
            ModifyLiquidityParams({
                tickLower: job.tickLower,
                tickUpper: job.tickUpper,
                liquidityDelta: job.liquidityDelta,
                // One position per client per range, so v4 core does the accounting and this
                // contract keeps none of its own.
                salt: bytes32(uint256(uint160(job.owner)))
            }),
            ""
        );
        feesAccrued; // credited inside callerDelta; named so the ABI reader is not left wondering

        // A BalanceDelta packs amount0 in the high 128 bits and amount1 in the low. Negative is
        // owed to the pool, positive is owed to us — and "us" is only ever a way station to the
        // client, in the same transaction.
        int128 delta0 = int128(callerDelta >> 128);
        int128 delta1 = int128(callerDelta);

        (uint256 paid0, uint256 got0) = _settle(job.key.currency0, delta0, job.owner, job.max0);
        (uint256 paid1, uint256 got1) = _settle(job.key.currency1, delta1, job.owner, job.max1);

        bytes32 poolId = keccak256(abi.encode(job.key));
        if (job.liquidityDelta > 0) {
            emit LiquidityAdded(job.owner, poolId, job.tickLower, job.tickUpper, uint128(uint256(job.liquidityDelta)), paid0, paid1);
        } else {
            emit LiquidityRemoved(
                job.owner,
                poolId,
                job.tickLower,
                job.tickUpper,
                uint128(uint256(-job.liquidityDelta)),
                got0,
                got1
            );
        }
        return "";
    }

    /**
     * @dev One side of the ledger. Owed to the pool: pull it from the owner under the writ and
     *      settle. Owed to us: take it straight to the owner.
     *
     *      `sync` before the pull and `settle` after is the ERC-20 settle dance v4 requires — the
     *      manager credits whatever arrived between the two, which is why the transfer must land
     *      on the PoolManager itself and not here.
     */
    function _settle(address currency, int128 delta, address owner, uint128 maximum)
        private
        returns (uint256 paid, uint256 received)
    {
        if (delta < 0) {
            paid = uint256(uint128(-delta));
            if (paid > maximum) revert PullExceedsMaximum(currency, paid, maximum);
            POOL_MANAGER.sync(currency);
            // The whole point: the client's tokens move client -> PoolManager, under an allowance
            // they signed, and this contract is never a balance in the path.
            CROSS_PERMIT.transferFrom(owner, address(POOL_MANAGER), uint160(paid), currency);
            POOL_MANAGER.settle();
        } else if (delta > 0) {
            received = uint256(uint128(delta));
            POOL_MANAGER.take(currency, owner, received);
        }
    }
}
