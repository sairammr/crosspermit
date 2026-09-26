// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { MockUSDC } from "../src/mocks/MockUSDC.sol";
import { RouterPaymentsMirror } from "../src/mocks/RouterPaymentsMirror.sol";
import { Test } from "forge-std/Test.sol";
import { IAllowanceTransfer } from "permit2/src/interfaces/IAllowanceTransfer.sol";
import { CrossPermit } from "../src/CrossPermit.sol";
import { ISaltRegistry } from "../src/interfaces/ISaltRegistry.sol";
import { IAllowanceLedger } from "../src/interfaces/IAllowanceLedger.sol";
import { ICrossPermit } from "../src/interfaces/ICrossPermit.sol";

/**
 * @notice One EIP-712 signature -> approvals and transfers on three chains, spendable by a
 *         Universal-Router-shaped caller. Each `_onChain` call resets to the post-setUp state and
 *         changes `block.chainid`, so the three chains never share state — only the signature.
 */
contract CrossChainFlowTest is Test {
    uint64 constant ETH_SEPOLIA = 11_155_111;
    uint64 constant BASE_SEPOLIA = 84_532;
    uint64 constant UNI_SEPOLIA = 1301;

    CrossPermit crossPermit;
    MockUSDC usdc;
    RouterPaymentsMirror router;
    address pool = makeAddr("poolOrPoolManager");
    address recipient = makeAddr("recipient");

    uint256 ownerPk = 0xA11CE;
    address owner;

    uint48 deadline;
    uint48 ts;
    bytes32 salt = keccak256("bundle-1");
    bytes32 tokenKey;

    ICrossPermit.ChainPermits cpEth;
    ICrossPermit.ChainPermits cpBase;
    ICrossPermit.ChainPermits cpUni;
    bytes32[] proofEth;
    bytes32[] proofBase;
    bytes32[] proofUni;
    bytes sig;
    uint256 snap;

    function setUp() public {
        owner = vm.addr(ownerPk);
        crossPermit = new CrossPermit();
        usdc = new MockUSDC();
        router = new RouterPaymentsMirror(address(crossPermit));
        usdc.mint(owner, 100e6);
        vm.prank(owner);
        usdc.approve(address(crossPermit), type(uint256).max); // one-time, exactly like Permit2

        vm.warp(1_800_000_000);
        ts = uint48(block.timestamp);
        deadline = ts + 1 hours;
        uint48 expiry = ts + 1 hours;
        tokenKey = bytes32(uint256(uint160(address(usdc))));

        // Ethereum Sepolia: approve the router 10 USDC.
        cpEth.chainId = ETH_SEPOLIA;
        cpEth.permits.push(ICrossPermit.AllowanceOrTransfer(expiry, tokenKey, address(router), 10e6));
        // Base Sepolia: approve the router 5 USDC AND transfer 2 USDC to a recipient, one signature.
        cpBase.chainId = BASE_SEPOLIA;
        cpBase.permits.push(ICrossPermit.AllowanceOrTransfer(expiry, tokenKey, address(router), 5e6));
        cpBase.permits.push(ICrossPermit.AllowanceOrTransfer(0, tokenKey, recipient, 2e6));
        // Unichain Sepolia: approve the router 7 USDC.
        cpUni.chainId = UNI_SEPOLIA;
        cpUni.permits.push(ICrossPermit.AllowanceOrTransfer(expiry, tokenKey, address(router), 7e6));

        // Leaves come from the contract's own hash function (the dApp gets them via eth_call).
        bytes32 lEth = crossPermit.hashChainPermits(cpEth);
        bytes32 lBase = crossPermit.hashChainPermits(cpBase);
        bytes32 lUni = crossPermit.hashChainPermits(cpUni);

        // Unbalanced tree: expensive L1 nearest the root (1-node proof), cheap L2s deeper (2-node proofs).
        bytes32 l2Node = _hashPair(lBase, lUni);
        bytes32 root = _hashPair(l2Node, lEth);
        proofEth.push(l2Node);
        proofBase.push(lUni);
        proofBase.push(lEth);
        proofUni.push(lBase);
        proofUni.push(lEth);

        sig = _sign(salt, deadline, ts, root);
        snap = vm.snapshotState();
    }

    // ---------- the core promise: one signature, three chains ----------

    function test_oneSignature_approvalsAndTransfers_onAllThreeChains() public {
        _onChain(ETH_SEPOLIA);
        crossPermit.permit(owner, salt, deadline, ts, cpEth, proofEth, sig);
        vm.prank(owner);
        router.pull(address(usdc), pool, 10e6);
        assertEq(usdc.balanceOf(pool), 10e6);

        _onChain(BASE_SEPOLIA);
        crossPermit.permit(owner, salt, deadline, ts, cpBase, proofBase, sig);
        assertEq(usdc.balanceOf(recipient), 2e6, "mode-0 transfer executed");
        vm.prank(owner);
        router.pull(address(usdc), pool, 5e6);
        assertEq(usdc.balanceOf(pool), 5e6);

        _onChain(UNI_SEPOLIA);
        crossPermit.permit(owner, salt, deadline, ts, cpUni, proofUni, sig);
        vm.prank(owner);
        router.pull(address(usdc), pool, 7e6);
        assertEq(usdc.balanceOf(pool), 7e6);
    }

    function test_anyoneCanSubmitPermit_butOnlyOwnerCanSpendViaRouter() public {
        _onChain(ETH_SEPOLIA);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        crossPermit.permit(owner, salt, deadline, ts, cpEth, proofEth, sig); // harmless: only sets the allowance
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAllowanceLedger.InsufficientAllowance.selector, 10e6, 0));
        router.pull(address(usdc), stranger, 10e6);
        assertEq(usdc.balanceOf(owner), 100e6, "owner funds untouched");
    }

    function test_batchPull_matchesPermit2Abi() public {
        _onChain(ETH_SEPOLIA);
        crossPermit.permit(owner, salt, deadline, ts, cpEth, proofEth, sig);
        IAllowanceTransfer.AllowanceTransferDetails[] memory d = new IAllowanceTransfer.AllowanceTransferDetails[](2);
        d[0] = IAllowanceTransfer.AllowanceTransferDetails(owner, pool, 4e6, address(usdc));
        d[1] = IAllowanceTransfer.AllowanceTransferDetails(owner, pool, 6e6, address(usdc));
        vm.prank(owner);
        router.pullBatch(d);
        assertEq(usdc.balanceOf(pool), 10e6);
    }

    function test_batchPull_rejectsPullingFromSomeoneElse() public {
        _onChain(ETH_SEPOLIA);
        crossPermit.permit(owner, salt, deadline, ts, cpEth, proofEth, sig);
        IAllowanceTransfer.AllowanceTransferDetails[] memory d = new IAllowanceTransfer.AllowanceTransferDetails[](1);
        d[0] = IAllowanceTransfer.AllowanceTransferDetails(owner, pool, 1e6, address(usdc));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(RouterPaymentsMirror.FromAddressIsNotOwner.selector);
        router.pullBatch(d);
    }

    // ---------- safety properties ----------

    function test_wrongChain_reverts() public {
        _onChain(BASE_SEPOLIA);
        vm.expectRevert(abi.encodeWithSelector(ISaltRegistry.WrongChainId.selector, BASE_SEPOLIA, ETH_SEPOLIA));
        crossPermit.permit(owner, salt, deadline, ts, cpEth, proofEth, sig);
    }

    function test_proofFromAnotherChain_reverts() public {
        _onChain(BASE_SEPOLIA);
        // CrossPermit never compares roots: a wrong proof rebuilds a different root, which simply fails
        // signature recovery. `InvalidMerkleProof` is declared upstream but never thrown.
        vm.expectRevert(abi.encodeWithSelector(ISaltRegistry.InvalidSignature.selector, owner));
        crossPermit.permit(owner, salt, deadline, ts, cpBase, proofUni, sig);
    }

    function test_replayOnSameChain_reverts() public {
        _onChain(UNI_SEPOLIA);
        crossPermit.permit(owner, salt, deadline, ts, cpUni, proofUni, sig);
        vm.expectRevert(abi.encodeWithSelector(ISaltRegistry.NonceAlreadyUsed.selector, owner, salt));
        crossPermit.permit(owner, salt, deadline, ts, cpUni, proofUni, sig);
    }

    function test_expiredSignature_reverts() public {
        _onChain(ETH_SEPOLIA);
        vm.warp(deadline + 1);
        vm.expectRevert(
            abi.encodeWithSelector(ISaltRegistry.SignatureExpired.selector, deadline, uint48(block.timestamp))
        );
        crossPermit.permit(owner, salt, deadline, ts, cpEth, proofEth, sig);
    }

    function test_tamperedBundle_reverts() public {
        _onChain(ETH_SEPOLIA);
        ICrossPermit.ChainPermits memory evil;
        evil.chainId = ETH_SEPOLIA;
        evil.permits = new ICrossPermit.AllowanceOrTransfer[](1);
        evil.permits[0] = ICrossPermit.AllowanceOrTransfer(deadline, tokenKey, address(router), 100e6); // 10 -> 100
        vm.expectRevert(abi.encodeWithSelector(ISaltRegistry.InvalidSignature.selector, owner));
        crossPermit.permit(owner, salt, deadline, ts, evil, proofEth, sig);
    }

    function test_allowanceExpiry_blocksRouterPull() public {
        _onChain(ETH_SEPOLIA);
        crossPermit.permit(owner, salt, deadline, ts, cpEth, proofEth, sig);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAllowanceLedger.AllowanceExpired.selector, deadline));
        router.pull(address(usdc), pool, 1e6);
    }

    function test_crossChainLock_blocksRouter() public {
        _onChain(ETH_SEPOLIA);
        crossPermit.permit(owner, salt, deadline, ts, cpEth, proofEth, sig);

        // Second bundle, new salt, later timestamp: LOCK (mode 2) the router as spender.
        vm.warp(block.timestamp + 60);
        uint48 ts2 = uint48(block.timestamp);
        bytes32 salt2 = keccak256("lock-bundle");
        ICrossPermit.ChainPermits memory lockEth;
        lockEth.chainId = ETH_SEPOLIA;
        lockEth.permits = new ICrossPermit.AllowanceOrTransfer[](1);
        lockEth.permits[0] = ICrossPermit.AllowanceOrTransfer(2, tokenKey, address(router), 0);
        // Single-leaf tree (empty proof) for brevity; the same pattern extends to all chains.
        bytes32 root2 = crossPermit.hashChainPermits(lockEth);
        bytes memory sig2 = _sign(salt2, ts2 + 1 hours, ts2, root2);
        crossPermit.permit(owner, salt2, ts2 + 1 hours, ts2, lockEth, new bytes32[](0), sig2);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAllowanceLedger.AllowanceLocked.selector, owner, tokenKey, address(router)));
        router.pull(address(usdc), pool, 1e6);
    }

    /**
     * @dev CrossPermit caches the domain separator against `address(this)` and never reads
     *      `block.chainid`, so comparing two calls under `vm.chainId` would pass even if the domain
     *      were chain-dependent. Recompute it instead, pinned to chainId 1, and show that the
     *      chainId-dependent form it is NOT using would have produced something else.
     */
    function test_domainPinsChainIdToOne() public {
        bytes32 typeHash = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 pinnedToOne = keccak256(
            abi.encode(typeHash, keccak256("CrossPermit"), keccak256("1"), uint256(1), address(crossPermit))
        );

        _onChain(ETH_SEPOLIA);
        assertEq(crossPermit.DOMAIN_SEPARATOR(), pinnedToOne, "domain must use chainId 1, not block.chainid");
        bytes32 wouldBeChainDependent = keccak256(
            abi.encode(typeHash, keccak256("CrossPermit"), keccak256("1"), uint256(ETH_SEPOLIA), address(crossPermit))
        );
        assertTrue(crossPermit.DOMAIN_SEPARATOR() != wouldBeChainDependent, "and it must differ from the live-chainId form");

        _onChain(UNI_SEPOLIA);
        assertEq(crossPermit.DOMAIN_SEPARATOR(), pinnedToOne, "same domain on every chain");
    }

    // ---------- helpers ----------

    /// @dev Reset to the post-setUp state and switch chain id: independent chains, one signature.
    function _onChain(uint64 id) internal {
        vm.revertToState(snap);
        vm.chainId(id);
    }

    /// @dev OpenZeppelin `MerkleProof` sorted-pair hashing, which is what CrossPermit verifies with.
    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _sign(bytes32 s, uint48 dl, uint48 t, bytes32 root) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(crossPermit.SIGNED_CROSSPERMIT_TYPEHASH(), owner, s, dl, t, root));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", crossPermit.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 vs) = vm.sign(ownerPk, digest);
        return abi.encodePacked(r, vs, v);
    }
}
