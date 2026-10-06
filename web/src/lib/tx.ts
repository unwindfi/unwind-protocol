import { VersionedTransaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { storedRef } from "./ref";
import { apiUrl, knownCluster, post } from "./api";
import { toast } from "./toasts";
import { humanToken } from "./turnstile";
import { REJECTED, humanError } from "./errors";

export interface BuiltTx {
  tx: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/// What a transaction's toast says. Passing one to `signAndSend` gives that
/// transaction a toast from the moment it is signed to the moment it lands.
export interface TxToastOptions {
  /// What the transaction does, short and plain: "List BONK".
  label: string;
  /// The title once it lands. The label when not given.
  done?: string;
  /// One line under the title once it lands.
  note?: string;
  /// The next step a landed transaction opens, shown as a button.
  next?: { label: string; href: string };
}

type TxResult = { ok: boolean; error?: string; sig?: string };

/// A signature as perps venues show one: first four, last four.
export const shortSig = (sig: string) => `${sig.slice(0, 4)}…${sig.slice(-4)}`;

/// Solscan's page for a transaction, on the cluster the server serves.
/// Devnet unless the server has said mainnet: devnet is the only chain this
/// app has been served from, and the one the rest of the site links to.
export const solscanTx = (sig: string) =>
  `https://solscan.io/tx/${sig}${/mainnet/.test(knownCluster() ?? "") ? "" : "?cluster=devnet"}`;

const solscan = (sig?: string) =>
  sig ? [{ label: "View on Solscan", href: solscanTx(sig), aside: shortSig(sig) }] : [];

/*
 * A transaction's toast, in two calls: `begin` once it is signed and on its
 * way, `finish` with the result. One toast, updated in place. A success
 * leaves after a few seconds; a failure stays until dismissed, because it is
 * the one the reader may need to act on.
 */
export const txToast = {
  begin(label: string) {
    return toast.show({
      title: label, description: "Confirming…", status: "loading",
      duration: 0, dismissible: false,
    });
  },
  finish(id: string | null, r: TxResult, o: TxToastOptions) {
    // Closing the wallet is a decision, not a failure: a quiet line, gone soon.
    if (!r.ok && r.error === REJECTED) {
      if (id) toast.dismiss(id);
      toast.show({ title: REJECTED, status: "neutral", duration: 2500 });
      return;
    }
    const patch = r.ok
      ? {
          title: o.done ?? o.label, description: o.note, status: "success" as const,
          links: [...(o.next ? [{ ...o.next, primary: true }] : []), ...solscan(r.sig)],
          duration: 6000, dismissible: true,
        }
      : {
          title: `${o.label} failed`,
          description: humanError(r.error ?? ""),
          status: "error" as const, links: solscan(r.sig), duration: 0, dismissible: true,
        };
    if (id) toast.update(id, patch);
    else toast.show(patch);
  },
};

/// Asks the server to build a transaction, has the wallet sign it, and sends it
/// back for submission.
///
/// The split matters: the server knows the pool PDAs, oracle accounts and
/// lookup table, so the client never has to; and the key never leaves the
/// wallet, so the server never has to either.
///
/// With `toastOptions` the transaction also gets its toast (see `txToast`).
/// The result is the same either way, and a network failure still throws
/// after the toast has said so.
export async function signAndSend(
  wallet: WalletContextState,
  path: string,
  body: Record<string, unknown>,
  record?: { symbol: string; side: "buy" | "sell"; size: number; kind: string },
  toastOptions?: TxToastOptions
): Promise<TxResult> {
  if (!toastOptions) return readable(await send(wallet, path, body, record));
  let id: string | null = null;
  try {
    const r = readable(await send(wallet, path, body, record, () => { id = txToast.begin(toastOptions.label); }));
    txToast.finish(id, r, toastOptions);
    return r;
  } catch (e) {
    txToast.finish(id, {
      ok: false, error: "Unable to reach the server. Check your connection and try again.",
    }, toastOptions);
    throw e;
  }
}

/// A result whose error is already in the page's words (see `humanError`).
const readable = <T extends TxResult>(r: T): T =>
  r.ok || r.error == null ? r : { ...r, error: humanError(r.error) };

async function send(
  wallet: WalletContextState,
  path: string,
  body: Record<string, unknown>,
  record?: { symbol: string; side: "buy" | "sell"; size: number; kind: string },
  onSigned?: () => void
): Promise<TxResult> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    return { ok: false, error: "Connect a wallet to sign." };
  }
  const owner = wallet.publicKey.toBase58();

  const built = await fetch(apiUrl(`/api/tx/${path}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    // An opening order carries the code the visitor arrived with, so their
    // first fill is the one that names their referrer.
    body: JSON.stringify({ ...body, owner, ...(path === "order" ? { ref: storedRef() } : {}) }),
  });
  const b = (await built.json().catch(() => ({}))) as BuiltTx & { error?: string };
  if (!built.ok) return { ok: false, error: b.error ?? "Unable to build the transaction. Try again." };

  let signed: VersionedTransaction;
  try {
    const tx = VersionedTransaction.deserialize(
      Uint8Array.from(atob(b.tx), (c) => c.charCodeAt(0)));
    signed = await wallet.signTransaction(tx);
  } catch (e: any) {
    // A user closing the wallet popup is a decision, not a failure.
    return { ok: false, error: /reject|denied|user/i.test(String(e?.message))
      ? REJECTED : String(e?.message ?? e) };
  }
  onSigned?.();

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
  // A non-JSON answer (a proxy's error page) is a failure, not a crash.
  return sent.json().catch(() => ({ ok: false, error: "Unable to reach the server. Try again." }));
}

/// The faucet: test USDC, and SOL when the wallet is short of it. Every
/// "Get test funds" button comes here, so each one asks for the human check
/// first (when the build has a Turnstile key). The server signs the claim,
/// so the toast starts at "Confirming" rather than at the wallet.
export async function claimFaucet(owner: string) {
  const label = "Get test funds";
  const turnstile = await humanToken();
  // Closed without passing: nothing was asked of the server, so no toast.
  if (turnstile === null) return { ok: false, error: "cancelled" } as TxResult & { usdc?: number; sol?: number };
  const id = txToast.begin(label);
  let r: TxResult & { usdc?: number; sol?: number };
  try {
    r = await post("/faucet", turnstile ? { owner, turnstile } : { owner });
  } catch {
    r = { ok: false, error: "Unable to reach the server. Try again in a minute." };
  }
  if (!r.ok && r.error != null) r = { ...r, error: humanError(r.error) };
  txToast.finish(id, r, {
    label, done: "Funded",
    note: `${(r.usdc ?? 0).toLocaleString()} test USDC` + (r.sol ? ` and ${r.sol} SOL` : ""),
  });
  return r;
}
