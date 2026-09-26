// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { CrossPermit } from "../src/CrossPermit.sol";
import { ICrossPermit } from "../src/interfaces/ICrossPermit.sol";
import { MockUSDC } from "../src/mocks/MockUSDC.sol";
import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { Test } from "forge-std/Test.sol";

/**
 * @notice Fuzz and invariant coverage for the parts where a bug is not a local mistake.
 * @dev The leaf, the tree and the allowance transitions are shared machinery: every chain and every
 *      depositor rides the same code. Example-based tests pin the cases we thought of; these pin the
 *      ones we did not.
 */
contract InvariantsTest is Test {
    CrossPermit crossPermit;
    MockUSDC token;

    address owner;
    uint256 ownerKey;
    address spender = makeAddr("spender");

    function setUp() public {
        (owner, ownerKey) = makeAddrAndKey("owner");
        crossPermit = new CrossPermit();
        token = new MockUSDC();
        token.mint(owner, type(uint128).max);
        vm.prank(owner);
        token.approve(address(crossPermit), type(uint256).max);
    }

    // ---------- the leaf ----------

    /**
     * @notice Any change to any field changes the leaf.
     * @dev This is what makes the merkle root binding. If two different bundles could share a leaf,
     *      a signature over one would authorise the other, and every other guarantee here collapses.
     */
    function testFuzz_leafIsInjective(
        uint48 modeA,
        uint48 modeB,
        bytes32 keyA,
        bytes32 keyB,
        address acctA,
        address acctB,
        uint160 amtA,
        uint160 amtB,
        uint64 chainA,
        uint64 chainB
    ) public view {
        vm.assume(modeA != modeB || keyA != keyB || acctA != acctB || amtA != amtB || chainA != chainB);

        bytes32 a = crossPermit.hashChainPermits(_one(chainA, modeA, keyA, acctA, amtA));
        bytes32 b = crossPermit.hashChainPermits(_one(chainB, modeB, keyB, acctB, amtB));
        assertTrue(a != b, "two different bundles collided on one leaf");
    }

    /// @notice The leaf depends on order, so reordering a bundle is a different authorisation.
    function testFuzz_leafIsOrderSensitive(address a, address b, uint160 amtA, uint160 amtB) public view {
        vm.assume(a != b && a != address(0) && b != address(0));
        vm.assume(amtA != amtB);

        ICrossPermit.AllowanceOrTransfer[] memory fwd = new ICrossPermit.AllowanceOrTransfer[](2);
        fwd[0] = _entry(100, bytes32(uint256(uint160(address(token)))), a, amtA);
        fwd[1] = _entry(100, bytes32(uint256(uint160(address(token)))), b, amtB);

        ICrossPermit.AllowanceOrTransfer[] memory rev = new ICrossPermit.AllowanceOrTransfer[](2);
        rev[0] = fwd[1];
        rev[1] = fwd[0];

        assertTrue(
            crossPermit.hashChainPermits(ICrossPermit.ChainPermits({ chainId: 1, permits: fwd }))
                != crossPermit.hashChainPermits(ICrossPermit.ChainPermits({ chainId: 1, permits: rev })),
            "reordering a bundle did not change its leaf"
        );
    }

    // ---------- the tree ----------

    /**
     * @notice Every leaf's proof folds to the root, for every tree size the client can build.
     * @dev Mirrors `buildUnbalancedTree` in the SDK. The contract never compares roots — it feeds
     *      `processProof`'s output straight into the struct hash it recovers over — so a client tree
     *      that disagreed with OpenZeppelin would not fail loudly, it would produce a signature
     *      nobody can recover. That silence is why this is fuzzed rather than spot-checked.
     */
    function testFuzz_everyProofFoldsToTheRoot(uint8 rawCount, bytes32 seed) public pure {
        uint256 n = (uint256(rawCount) % 32) + 1;

        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) leaves[i] = keccak256(abi.encode(seed, i));

        // acc[i] covers leaves[0..i] — the left-leaning shape the client builds.
        bytes32[] memory acc = new bytes32[](n);
        acc[0] = leaves[0];
        for (uint256 i = 1; i < n; ++i) acc[i] = _hashPair(acc[i - 1], leaves[i]);
        bytes32 root = acc[n - 1];

        for (uint256 i; i < n; ++i) {
            bytes32[] memory proof = _proofFor(leaves, acc, i, n);
            assertEq(MerkleProof.processProof(proof, leaves[i]), root, "proof did not fold to the root");
            assertTrue(MerkleProof.verify(proof, root, leaves[i]), "OZ verify disagreed");
        }
    }

    /// @notice A proof for one leaf must not verify another. Otherwise one chain could replay another's.
    function testFuzz_aProofDoesNotCoverAnotherLeaf(uint8 rawCount, bytes32 seed, uint8 iRaw, uint8 jRaw) public pure {
        uint256 n = (uint256(rawCount) % 15) + 2;
        uint256 i = uint256(iRaw) % n;
        uint256 j = uint256(jRaw) % n;
        vm.assume(i != j);

        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 k; k < n; ++k) leaves[k] = keccak256(abi.encode(seed, k));

        bytes32[] memory acc = new bytes32[](n);
        acc[0] = leaves[0];
        for (uint256 k = 1; k < n; ++k) acc[k] = _hashPair(acc[k - 1], leaves[k]);

        bytes32[] memory proofI = _proofFor(leaves, acc, i, n);
        assertFalse(MerkleProof.verify(proofI, acc[n - 1], leaves[j]), "one leaf's proof verified another");
    }

    // ---------- allowance transitions ----------

    /**
     * @notice An allowance never exceeds the sum of what was signed.
     * @dev The property a treasury actually cares about: no sequence of permits can conjure
     *      authority nobody granted.
     */
    function testFuzz_allowanceNeverExceedsWhatWasSigned(uint96 a, uint96 b) public {
        uint48 expiry = uint48(block.timestamp + 1 days);

        _apply(_one(uint64(block.chainid), expiry, _key(address(token)), spender, a));
        (uint160 afterFirst,,) = crossPermit.allowance(owner, address(token), spender);
        assertEq(afterFirst, a, "first grant did not match");

        // A second grant must accumulate, never multiply.
        vm.warp(block.timestamp + 1);
        _apply(_one(uint64(block.chainid), uint48(block.timestamp + 1 days), _key(address(token)), spender, b));
        (uint160 total,,) = crossPermit.allowance(owner, address(token), spender);
        assertEq(total, uint256(a) + uint256(b), "allowance is not the sum of what was signed");
    }

    /// @notice A decrease can reach zero but never wraps below it.
    function testFuzz_decreaseFloorsAtZero(uint96 granted, uint96 removed) public {
        _apply(_one(uint64(block.chainid), uint48(block.timestamp + 1 days), _key(address(token)), spender, granted));

        vm.warp(block.timestamp + 1);
        _apply(_one(uint64(block.chainid), 1, _key(address(token)), spender, removed)); // mode 1 = DECREASE

        (uint160 left,,) = crossPermit.allowance(owner, address(token), spender);
        assertEq(left, removed >= granted ? 0 : granted - removed, "decrease did not floor at zero");
    }

    /**
     * @notice A locked allowance cannot be raised by any later grant, whatever its amount.
     * @dev The kill switch has to hold against an attacker who controls what gets submitted next.
     */
    function testFuzz_lockCannotBeRaisedByAGrant(uint96 amount) public {
        _apply(_one(uint64(block.chainid), 2, _key(address(token)), spender, 0)); // mode 2 = LOCK

        (, uint48 expiration,) = crossPermit.allowance(owner, address(token), spender);
        assertEq(expiration, 2, "not locked");

        vm.warp(block.timestamp + 1);
        vm.expectRevert();
        _apply(_one(uint64(block.chainid), uint48(block.timestamp + 1 days), _key(address(token)), spender, amount));

        (uint160 left, uint48 stillLocked,) = crossPermit.allowance(owner, address(token), spender);
        assertEq(left, 0, "a locked allowance gained value");
        assertEq(stillLocked, 2, "the lock was cleared by a grant");
    }

    /// @notice A burnt salt stays burnt, whatever is signed over it afterwards.
    function testFuzz_burntSaltStaysBurnt(bytes32 salt) public {
        bytes32[] memory salts = new bytes32[](1);
        salts[0] = salt;

        vm.prank(owner);
        crossPermit.invalidateNonces(salts);
        assertTrue(crossPermit.isNonceUsed(owner, salt), "salt not burned");

        vm.prank(owner);
        crossPermit.invalidateNonces(salts); // idempotent, not a revert
        assertTrue(crossPermit.isNonceUsed(owner, salt), "salt un-burned by a second call");
    }

    // ---------- helpers ----------

    function _key(address t) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(t)));
    }

    function _entry(uint48 mode, bytes32 key, address acct, uint160 amt)
        internal
        pure
        returns (ICrossPermit.AllowanceOrTransfer memory)
    {
        return ICrossPermit.AllowanceOrTransfer({
            modeOrExpiration: mode,
            tokenKey: key,
            account: acct,
            amountDelta: amt
        });
    }

    function _one(uint64 chainId, uint48 mode, bytes32 key, address acct, uint160 amt)
        internal
        pure
        returns (ICrossPermit.ChainPermits memory)
    {
        ICrossPermit.AllowanceOrTransfer[] memory p = new ICrossPermit.AllowanceOrTransfer[](1);
        p[0] = _entry(mode, key, acct, amt);
        return ICrossPermit.ChainPermits({ chainId: chainId, permits: p });
    }

    /// @dev Applies a bundle through the direct (ERC-7702) entrypoint; same allowance storage.
    function _apply(ICrossPermit.ChainPermits memory cp) internal {
        vm.prank(owner);
        crossPermit.permit(cp.permits);
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /**
     * @dev The SDK's proof shape: sibling first, then every leaf above, in fold order.
     *      A one-leaf tree is its own root, so the proof is empty — handled before the arithmetic
     *      below, which assumes a sibling exists.
     */
    function _proofFor(bytes32[] memory leaves, bytes32[] memory acc, uint256 i, uint256 n)
        internal
        pure
        returns (bytes32[] memory proof)
    {
        if (n == 1) return new bytes32[](0);

        uint256 from = (i > 1 ? i : 1) + 1;
        uint256 above = n > from ? n - from : 0;
        proof = new bytes32[](above + 1);
        proof[0] = i == 0 ? leaves[1] : acc[i - 1];
        uint256 w = 1;
        for (uint256 j = from; j < n; ++j) proof[w++] = leaves[j];
    }
}
