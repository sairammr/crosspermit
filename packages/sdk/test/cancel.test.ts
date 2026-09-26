import { describe, expect, test } from "bun:test";
import { type Address, type Hex, type WalletClient, concat, encodeAbiParameters, keccak256, recoverAddress, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { NONCES_TO_INVALIDATE_TYPEHASH, invalidationLeaf, signCancelRoot } from "../src/cancel.js";
import { buildUnbalancedTree, lockEntry, processProof, revokeEntries, tokenKey } from "../src/crosspermit.js";
import { prepareIntent } from "../src/intent.js";

const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const XP = "0x659C6F027FC4F6b2fF7A18dF1e3C3ec78a99de1B" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const ROUTER = "0xd72f799E1af27E0d95aB4B9658A277A7811Fbcd0" as Address;
const DESK = "0xE666e3F76062d670A84b964Ca4D9B456b1531C03" as Address;

/**
 * The contract's own side, rebuilt from the Solidity source rather than from the client's encoders.
 *
 * These are copied by hand out of SaltRegistry.sol and EIP712.sol on purpose: a test that derived
 * them from `../src` would agree with any drift the client introduced, which is the one failure it
 * exists to catch.
 */
const CANCEL_TYPE_STRING = "CancelCrossPermit(address owner,uint48 deadline,bytes32 merkleRoot)"; // SaltRegistry.sol:47-48
const INVALIDATE_TYPE_STRING = "NoncesToInvalidate(uint64 chainId,bytes32[] salts)"; // SaltRegistry.sol:39-40
const DOMAIN_TYPE_STRING = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

/** `EIP712._buildDomainSeparator`, with CROSS_CHAIN_ID = 1 pinned on every chain. */
const domainSeparator = (verifyingContract: Address): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        keccak256(toBytes(DOMAIN_TYPE_STRING)),
        keccak256(toBytes("CrossPermit")),
        keccak256(toBytes("1")),
        1n,
        verifyingContract,
      ],
    ),
  );

/** `SaltRegistry.hashNoncesToInvalidate`, written the way Solidity writes it. */
const solidityInvalidationLeaf = (chainId: bigint, salts: Hex[]): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint64" }, { type: "bytes32[]" }],
      [keccak256(toBytes(INVALIDATE_TYPE_STRING)), chainId, salts],
    ),
  );

const SALT_A = `0x${"a1".repeat(32)}` as Hex;
const SALT_B = `0x${"b2".repeat(32)}` as Hex;

describe("invalidationLeaf", () => {
  /**
   * Pinned literals, not a recomputation. `invalidationLeaf` is the one hash standing between a
   * signed cancellation and a chain that will not honour it, and the encoding it uses is the
   * contract's plain `abi.encode` rather than the EIP-712 form a reader would expect — so a
   * "correction" to the spec-shaped encoding has to fail here rather than on a testnet.
   */
  test("matches fixtures taken from the contract's encoding", () => {
    const fixtures: [bigint, Hex[], Hex][] = [
      [11155111n, [SALT_A], "0xd69e08910a549748b7f81595a31cddb078a0fc1070807468624c40689f9f609a"],
      [84532n, [SALT_A, SALT_B], "0x5293b03b11b2403d05202d578bac211147d5824c52b379615ac88688065aa4d8"],
    ];
    for (const [chainId, salts, expected] of fixtures) {
      expect(invalidationLeaf({ chainId, salts })).toBe(expected);
      expect(invalidationLeaf({ chainId, salts })).toBe(solidityInvalidationLeaf(chainId, salts));
    }
  });

  test("the typehash is the one SaltRegistry declares", () => {
    expect(NONCES_TO_INVALIDATE_TYPEHASH).toBe(keccak256(toBytes(INVALIDATE_TYPE_STRING)));
  });

  test("the array contributes an offset and a length, so one salt is not two salts", () => {
    // Were the client hashing `abi.encodePacked(salts)` instead, a 64-byte encoding of two salts
    // would be indistinguishable from other groupings. This is the property that rules that out.
    expect(invalidationLeaf({ chainId: 1n, salts: [SALT_A, SALT_B] })).not.toBe(
      invalidationLeaf({ chainId: 1n, salts: [SALT_B, SALT_A] }),
    );
    expect(invalidationLeaf({ chainId: 1n, salts: [SALT_A] })).not.toBe(invalidationLeaf({ chainId: 2n, salts: [SALT_A] }));
  });
});

describe("signCancelRoot", () => {
  test("produces exactly the digest SaltRegistry recovers against", async () => {
    const leaves = [
      invalidationLeaf({ chainId: 84532n, salts: [SALT_A] }),
      invalidationLeaf({ chainId: 11155111n, salts: [SALT_A] }),
    ];
    const { root, proofs } = buildUnbalancedTree(leaves);
    const msg = { owner: OWNER.address, deadline: 1_900_000_000, merkleRoot: root };

    // A local account is exactly the `signTypedData` surface `signCancelRoot` uses.
    const signature = await signCancelRoot(OWNER as unknown as WalletClient, OWNER, XP, msg);

    // What the contract hashes: keccak(abi.encode(CANCEL_TYPEHASH, owner, deadline, merkleRoot)),
    // wrapped in \x19\x01 || domainSeparator by MessageHashUtils.toTypedDataHash.
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint48" }, { type: "bytes32" }],
        [keccak256(toBytes(CANCEL_TYPE_STRING)), msg.owner, msg.deadline, msg.merkleRoot],
      ),
    );
    const digest = keccak256(concat(["0x1901", domainSeparator(XP), structHash]));

    expect(await recoverAddress({ hash: digest, signature })).toBe(OWNER.address);
    // And every leg's proof folds back to the root that digest covered.
    leaves.forEach((leaf, i) => expect(processProof(leaf, proofs[i]!)).toBe(root));
  });

  test("the same signature does not verify against another CrossPermit deployment", async () => {
    const msg = { owner: OWNER.address, deadline: 1_900_000_000, merkleRoot: `0x${"cc".repeat(32)}` as Hex };
    const signature = await signCancelRoot(OWNER as unknown as WalletClient, OWNER, XP, msg);
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint48" }, { type: "bytes32" }],
        [keccak256(toBytes(CANCEL_TYPE_STRING)), msg.owner, msg.deadline, msg.merkleRoot],
      ),
    );
    const elsewhere = "0x51cfFca7d52fafDC464E325618043f5f78Aa8648" as Address;
    const digest = keccak256(concat(["0x1901", domainSeparator(elsewhere), structHash]));
    expect(await recoverAddress({ hash: digest, signature })).not.toBe(OWNER.address);
  });
});

describe("revokeEntries", () => {
  test("locks every spender of every token on every chain", () => {
    const chains = revokeEntries([
      { chainId: 84532, tokens: [USDC], spenders: [ROUTER, DESK] },
      { chainId: 11155111, tokens: [USDC], spenders: [ROUTER, DESK] },
    ]);
    expect(chains.map((c) => c.permits.length)).toEqual([2, 2]);
    for (const c of chains) {
      // The spender is the third field of the entry; a lock that named only the router would leave
      // the desk holding a live allowance nothing in the UI reports.
      expect(c.permits.map((p) => p.account)).toEqual([ROUTER, DESK]);
      expect(c.permits.every((p) => p.modeOrExpiration === 2 && p.tokenKey === tokenKey(USDC))).toBe(true);
      expect(c.permits[0]).toEqual(lockEntry(USDC, ROUTER));
    }
  });

  test("feeds prepareIntent directly, so revocation is one signature like the grant was", () => {
    const { intent } = prepareIntent({
      crossPermit: XP,
      owner: OWNER.address,
      now: 1_800_000_000,
      chains: revokeEntries([{ chainId: 84532, tokens: [USDC, ROUTER], spenders: [ROUTER, DESK] }]),
    });
    expect(intent.legs[0]!.bundle.permits).toHaveLength(4);
  });

  test("refuses a revocation that would name no spender, rather than signing a no-op", () => {
    expect(() => revokeEntries([{ chainId: 1, tokens: [USDC], spenders: [] }])).toThrow();
    expect(() => revokeEntries([{ chainId: 1, tokens: [], spenders: [ROUTER] }])).toThrow();
  });
});
