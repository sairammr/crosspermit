// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { CrossPermit } from "../src/CrossPermit.sol";
import { ICrossPermit } from "../src/interfaces/ICrossPermit.sol";

/**
 * @notice Pins the client's local `leafOf` against the real `CrossPermit.hashChainPermits`.
 * @dev    The leaf is the only thing standing between the user and a merkle root they did not
 *         build, so the client computes it itself rather than asking an RPC. That is only safe
 *         while the local implementation matches the contract exactly — which is what this checks.
 *         Run `bun run ts/gen-fixtures.ts` first.
 */
contract LeafParityTest is Test {
    CrossPermit crossPermit;

    function setUp() public {
        crossPermit = new CrossPermit();
    }

    function test_clientLeafMatchesHashChainPermits() public view {
        string[] memory lines = vm.split(vm.trim(vm.readFile("fixtures/leaf-fixtures.txt")), "\n");
        assertGe(lines.length, 6, "expected the full fixture set");

        for (uint256 i; i < lines.length; ++i) {
            string[] memory parts = vm.split(lines[i], ":");
            assertEq(parts.length, 2, "leaf:encodedChainPermits");
            bytes32 clientLeaf = vm.parseBytes32(parts[0]);
            ICrossPermit.ChainPermits memory cp = abi.decode(vm.parseBytes(parts[1]), (ICrossPermit.ChainPermits));
            assertEq(crossPermit.hashChainPermits(cp), clientLeaf, vm.toString(i));
        }
    }
}
