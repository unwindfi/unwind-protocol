import { VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { storedRef } from "./ref";
import { apiUrl } from "./api";

export interface BuiltTx {
  tx: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/// Asks the server to build a transaction, has the wallet sign it, and sends it
/// back for submission.
///
/// The split matters: the server knows the pool PDAs, oracle accounts and
/// lookup table, so the client never has to; and the key never leaves the
/// wallet, so the server never has to either.
export async function signAndSend(
  wallet: WalletContextState,
  path: string,
  body: Record<string, unknown>,
  record?: { symbol: string; side: "buy" | "sell"; size: number; kind: string }
): Promise<{ ok: boolean; error?: string; sig?: string }> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    return { ok: false, error: "wallet not connected" };
  }
  const owner = wallet.publicKey.toBase58();

  const built = await fetch(apiUrl(`/api/tx/${path}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    // An opening order carries the code the visitor arrived with, so their
    // first fill is the one that names their referrer.
    body: JSON.stringify({ ...body, owner, ...(path === "order" ? { ref: storedRef() } : {}) }),
  });
  const b = (await built.json()) as BuiltTx & { error?: string };
  if (!built.ok) return { ok: false, error: b.error ?? "could not build transaction" };

  let signed: VersionedTransaction;
  try {
    const tx = VersionedTransaction.deserialize(
      Uint8Array.from(atob(b.tx), (c) => c.charCodeAt(0)));
    signed = await wallet.signTransaction(tx);
  } catch (e: any) {
    // A user closing the wallet popup is a decision, not a failure.
    return { ok: false, error: /reject|denied|user/i.test(String(e?.message))
      ? "Rejected in wallet" : String(e?.message ?? e) };
  }

  const sent = await fetch(apiUrl("/api/tx/send"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tx: btoa(String.fromCharCode(...signed.serialize())),
      blockhash: b.blockhash,
      lastValidBlockHeight: b.lastValidBlockHeight,
      record,
    }),
  });
  return sent.json();
}
