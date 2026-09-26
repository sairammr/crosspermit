// Where the key lives.
//
// This is the one interface in the codebase with two implementations, and it earns that because the
// two differ in exactly the thing an institution audits: whether the private key is in this
// process's memory or inside a Cloud Wallet / HSM it never leaves. Everything above this line is
// identical in both modes, which is the point — nothing else has to know.
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import type { Account } from "viem/accounts";

import type { MultiBaas } from "./client.js";

export type Custody = "local" | "multibaas-cloud-wallet";

export type TxRequest = {
  to: Address;
  data: Hex;
  value?: bigint;
  /** Caller-managed nonce. Omit to let the signer's own source of truth pick one. */
  nonce?: number;
  gas?: bigint;
};

export interface Signer {
  readonly address: Address;
  readonly custody: Custody;
  /** Broadcast and return the hash. Does NOT wait for the receipt — the caller decides how to wait. */
  send(tx: TxRequest): Promise<Hex>;
}

/**
 * Key in this process.
 *
 * Optionally broadcasts through MultiBaas rather than straight to the RPC. The transaction is
 * identical either way; routing it through MultiBaas puts it in the same audit trail and the same
 * Transaction Manager as a Cloud Wallet transaction, so an operator reviewing activity sees one
 * ledger instead of two. Falls back to the RPC if that call fails — a broken control plane must not
 * be able to stop a relayer that holds its own key.
 */
export function localSigner(a: {
  account: Account;
  wallet: WalletClient;
  client: PublicClient;
  multibaas?: MultiBaas;
  onFallback?: (reason: string) => void;
}): Signer {
  return {
    address: a.account.address,
    custody: "local",
    async send(tx) {
      if (!a.multibaas) {
        return a.wallet.sendTransaction({
          account: a.account, chain: null, to: tx.to, data: tx.data,
          value: tx.value, nonce: tx.nonce, gas: tx.gas,
        });
      }
      const signed = await a.wallet.signTransaction({
        account: a.account,
        chain: null,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        nonce: tx.nonce ?? (await a.client.getTransactionCount({ address: a.account.address, blockTag: "pending" })),
        gas: tx.gas ?? (await a.client.estimateGas({ account: a.account, to: tx.to, data: tx.data, value: tx.value })),
        ...(await a.client.estimateFeesPerGas()),
        chainId: await a.client.getChainId(),
        type: "eip1559",
      });
      try {
        const res = await a.multibaas.submitSignedTransaction(signed);
        const hash = (res as { hash?: string }).hash ?? (res as { tx?: { hash?: string } }).tx?.hash;
        if (hash) return hash as Hex;
        throw new Error("MultiBaas accepted the transaction but returned no hash");
      } catch (e) {
        a.onFallback?.(e instanceof Error ? e.message : String(e));
        return a.client.sendRawTransaction({ serializedTransaction: signed });
      }
    },
  };
}

/**
 * Key inside a MultiBaas Cloud Wallet. This process never sees it, and cannot: it hands MultiBaas an
 * unsigned transaction and gets a hash back.
 *
 * Nonces are MultiBaas's to manage here — the Transaction Manager owns the wallet's nonce and will
 * resubmit a stalled transaction, so a nonce chosen out here would fight it.
 */
export function cloudWalletSigner(a: { multibaas: MultiBaas; address: Address }): Signer {
  return {
    address: a.address,
    custody: "multibaas-cloud-wallet",
    async send(tx) {
      const res = await a.multibaas.signAndSubmitTransaction({
        from: a.address,
        to: tx.to,
        data: tx.data,
        ...(tx.value === undefined ? {} : { value: tx.value.toString() }),
        ...(tx.gas === undefined ? {} : { gas: tx.gas.toString() }),
      });
      if (!res.hash) throw new Error("Cloud Wallet returned no transaction hash");
      return res.hash as Hex;
    },
  };
}
