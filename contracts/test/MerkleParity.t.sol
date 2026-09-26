// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @notice Cross-checks the TypeScript merkle tree against the library CrossPermit actually verifies
 *         with. CrossPermit never compares roots — it feeds `processProof`'s output straight into the
 *         signed struct hash — so a client tree that disagrees with OpenZeppelin does not fail
 *         loudly on-chain, it just produces an unrecoverable signature.
 * @dev    Run `bun run ts/gen-fixtures.ts` first.
 */
contract MerkleParityTest is Test {
    function test_everyClientProofRebuildsTheRootUnderOpenZeppelin() public view {
        string[] memory lines = vm.split(vm.trim(vm.readFile("fixtures/merkle-fixtures.txt")), "\n");
        assertEq(lines.length, 36, "n=1..8 means 36 leaves in total");

        for (uint256 i; i < lines.length; ++i) {
            string[] memory parts = vm.split(lines[i], ":");
            assertEq(parts.length, 3, "root:leaf:proof");
            bytes32 root = vm.parseBytes32(parts[0]);
            bytes32 leaf = vm.parseBytes32(parts[1]);

            bytes32[] memory proof;
            if (keccak256(bytes(parts[2])) != keccak256("-")) {
                string[] memory nodes = vm.split(parts[2], ",");
                proof = new bytes32[](nodes.length);
                for (uint256 j; j < nodes.length; ++j) {
                    proof[j] = vm.parseBytes32(nodes[j]);
                }
            }

            assertEq(MerkleProof.processProof(proof, leaf), root, vm.toString(i));
            assertTrue(MerkleProof.verify(proof, root, leaf), "OZ verify");
        }
    }
}
