// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";

// Mirrors Uniswap/universal-router @ 543e1a19 and its pinned lib/v4-periphery @ a7af5b34.
// v4-core types/PoolKey.sol
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

// v4-periphery src/interfaces/IV4Router.sol — `minHopPriceX36` is part of this pin.
// The on-chain decoder demands a 0x160-byte payload, so the older 5-field struct reverts.
struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/**
 * @notice Decodes the calldata the TypeScript client actually produces, using the Solidity structs
 *         the deployed router actually decodes with. If the client's ABI encoding drifts from the
 *         pinned layout, this test fails instead of a testnet swap reverting.
 * @dev    Run `bun run ts/gen-fixtures.ts` first — it writes out/swap-calldata.txt and out/permit2-transfer.txt.
 */
contract SwapEncodingTest is Test {
    bytes constant COMMAND_V4_SWAP = hex"10";
    bytes constant COMMAND_PERMIT2_TRANSFER_FROM = hex"02";
    bytes constant ACTIONS_EXACT_IN_SINGLE = hex"060c0f"; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL

    address constant CURRENCY0 = 0x1111111111111111111111111111111111111111;
    address constant CURRENCY1 = 0x2222222222222222222222222222222222222222;
    uint256 constant DEADLINE = 1_900_000_000;
    uint128 constant AMOUNT_IN = 5e6;
    uint128 constant MIN_OUT = 123;

    /**
     * The dispatcher reads this command's three words with bare `calldataload` at +0x00/0x20/0x40
     * and does no type or length checking at all, so a transposed argument would encode cleanly and
     * only fail on-chain. Decoding it back as a typed tuple here is the check that catches that.
     */
    function test_permit2TransferFromCalldataDecodesToPinnedLayout() public view {
        bytes memory cd = vm.parseBytes(vm.trim(vm.readFile("fixtures/permit2-transfer.txt")));
        (bytes memory commands, bytes[] memory inputs, uint256 deadline) = _decodeExecute(cd);
        assertEq(commands, COMMAND_PERMIT2_TRANSFER_FROM);
        assertEq(inputs.length, 1);
        assertEq(deadline, DEADLINE);
        assertEq(inputs[0].length, 0x60, "exactly three words, nothing to read past");

        (address token, address recipient, uint160 amount) = abi.decode(inputs[0], (address, address, uint160));
        assertEq(token, 0x3333333333333333333333333333333333333333);
        assertEq(recipient, 0x4444444444444444444444444444444444444444);
        assertEq(amount, 7e6);
    }

    function test_clientCalldataDecodesToPinnedLayout() public view {
        bytes memory cd = vm.parseBytes(vm.trim(vm.readFile("fixtures/swap-calldata.txt")));

        (bytes memory commands, bytes[] memory inputs, uint256 deadline) = _decodeExecute(cd);
        assertEq(commands, COMMAND_V4_SWAP, "commands = V4_SWAP");
        assertEq(inputs.length, 1, "one input per command");
        assertEq(deadline, DEADLINE);

        (bytes memory actions, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        assertEq(actions, ACTIONS_EXACT_IN_SINGLE);
        assertEq(params.length, 3, "one param per action");

        ExactInputSingleParams memory p = abi.decode(params[0], (ExactInputSingleParams));
        assertEq(p.poolKey.currency0, CURRENCY0);
        assertEq(p.poolKey.currency1, CURRENCY1);
        assertEq(p.poolKey.fee, 500);
        assertEq(p.poolKey.tickSpacing, 10);
        assertEq(p.poolKey.hooks, address(0));
        assertTrue(p.zeroForOne);
        assertEq(p.amountIn, AMOUNT_IN);
        assertEq(p.amountOutMinimum, MIN_OUT);
        assertEq(p.minHopPriceX36, 0, "0 disables the per-hop price check");
        assertEq(p.hookData.length, 0);

        // Strongest form of the check: byte-for-byte equality with what solc itself would emit.
        // `decodeSwapExactInSingleParams` reads a head offset and then guards `length >= 0x160`,
        // so a hand-rolled or stale-layout encoding fails here rather than on-chain.
        assertEq(params[0], abi.encode(p), "client encoding == solc abi.encode(ExactInputSingleParams)");
        assertGe(params[0].length, 0x160, "clears the decoder's SliceOutOfBounds floor");

        (address settleCurrency, uint256 maxIn) = abi.decode(params[1], (address, uint256));
        assertEq(settleCurrency, CURRENCY0, "SETTLE_ALL pays the input currency");
        assertEq(maxIn, AMOUNT_IN, "SETTLE_ALL amount is a maximum");

        (address takeCurrency, uint256 minOut) = abi.decode(params[2], (address, uint256));
        assertEq(takeCurrency, CURRENCY1, "TAKE_ALL receives the output currency");
        assertEq(minOut, MIN_OUT, "TAKE_ALL amount is a minimum");
    }

    function _decodeExecute(bytes memory cd)
        internal
        pure
        returns (bytes memory commands, bytes[] memory inputs, uint256 deadline)
    {
        bytes4 selector;
        assembly {
            selector := mload(add(cd, 32))
        }
        assertEq(selector, IUniversalRouter.execute.selector, "execute(bytes,bytes[],uint256)");
        bytes memory args = new bytes(cd.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = cd[i + 4];
        }
        return abi.decode(args, (bytes, bytes[], uint256));
    }
}
