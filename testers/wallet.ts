/*
 * The tester's wallet, as the site sees it: one more Wallet Standard wallet
 * called "unwind tester", registered by hand in the page before the app's
 * own scripts run.
 *
 * The page half (SHIM below) knows only the public key. Every signature is a
 * call through a Playwright binding into this process, which holds the
 * persona's Keypair, checks there is a ticket for it (txgate.ts), signs, and
 * hands back bytes. The secret key never enters the page.
 *
 * With DRY_TX=1 the transaction is still signed here, which proves the
 * whole path up to the wallet, and then refused the way a user closing the
 * popup refuses it, so nothing is ever broadcast.
 */
import crypto from "crypto";
import type { BrowserContext } from "playwright-core";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { config } from "./config";
import type { Ticket } from "./txgate";
import * as store from "./store";

export const WALLET_NAME = "unwind tester";

/// A small square mark for the picker: violet, as a data URL (Wallet
/// Standard requires a data: icon).
const ICON = "data:image/svg+xml;base64," + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="8" fill="#7c5cff"/><rect x="9" y="9" width="14" height="14" rx="3" fill="#fff"/></svg>',
).toString("base64");

/*
 * The page half. Plain JavaScript, no bundler: it implements the two events
 * of the Wallet Standard registration handshake itself. The app announces
 * itself with `wallet-standard:app-ready` (detail: { register }); a wallet
 * announces itself with `wallet-standard:register-wallet` (detail: a
 * callback that receives { register }). Whichever runs first, the other
 * side's listener catches it.
 */
const SHIM = (cfg: { name: string; icon: string; address: string; publicKey: number[] }) => {
  const w = window as any;
  if (w.top !== w || w.__unwindTesterWallet) return;
  const SIGN = "__unwindTesterSign";
  const pk = new Uint8Array(cfg.publicKey);
  const FEATURES = ["solana:signTransaction", "solana:signAndSendTransaction", "solana:signMessage"];
  const account = Object.freeze({
    address: cfg.address, publicKey: pk, chains: ["solana:devnet"], features: FEATURES,
    label: cfg.name, icon: cfg.icon,
  });
  let connected = false;
  const listeners = new Set<(p: unknown) => void>();
  const emit = () => listeners.forEach((fn) => { try { fn({ accounts: connected ? [account] : [] }); } catch { /* app's */ } });
  const toB64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
  const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const call = async (kind: string, payload: Record<string, unknown>) => {
    const r = await w[SIGN](kind, payload);
    if (r && r.error) throw new Error(r.error);
    return r ?? {};
  };
  const wallet = {
    version: "1.0.0",
    name: cfg.name,
    icon: cfg.icon,
    chains: ["solana:devnet"],
    get accounts() { return connected ? [account] : []; },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async (input?: { silent?: boolean }) => {
          if (!connected) {
            await call("connect", { silent: !!input?.silent });
            connected = true;
            emit();
          }
          return { accounts: [account] };
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: async () => { connected = false; emit(); await call("disconnect", {}); },
      },
      "standard:events": {
        version: "1.0.0",
        on: (event: string, fn: (p: unknown) => void) => {
          if (event !== "change") return () => {};
          listeners.add(fn);
          return () => { listeners.delete(fn); };
        },
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs: { transaction: Uint8Array; chain?: string }[]) => {
          const out = [];
          for (const i of inputs) {
            const r = await call("signTransaction", { tx: toB64(i.transaction), chain: i.chain ?? null, batch: inputs.length });
            out.push({ signedTransaction: fromB64(r.tx) });
          }
          return out;
        },
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signAndSendTransaction: async (...inputs: { transaction: Uint8Array; chain?: string }[]) => {
          const out = [];
          for (const i of inputs) {
            const r = await call("signAndSendTransaction", { tx: toB64(i.transaction), chain: i.chain ?? null });
            out.push({ signature: fromB64(r.signature) });
          }
          return out;
        },
      },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async (...inputs: { message: Uint8Array }[]) => {
          const out = [];
          for (const i of inputs) {
            const r = await call("signMessage", { message: toB64(i.message) });
            out.push({ signedMessage: i.message, signature: fromB64(r.signature) });
          }
          return out;
        },
      },
    },
  };
  const register = (api: { register: (w: unknown) => unknown }) => { try { api.register(wallet); } catch { /* twice */ } };
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
  } catch { /* no listener yet: the app-ready event below catches it */ }
  window.addEventListener("wallet-standard:app-ready", (e: Event) => register((e as CustomEvent).detail));
  w.__unwindTesterWallet = true;
};

/// What the signer saw, for the session's report.
export interface WalletLog {
  connects: number;
  messages: number;
  signed: { kind: string; at: number; dry: boolean }[];
  refused: { reason: string; at: number }[];
}

export interface WalletHandle {
  log: WalletLog;
  /// The next transaction the page asks to sign is signed against this.
  allow(ticket: Ticket): void;
  /// Drops an unused ticket (the journey gave up before the wallet was asked).
  revoke(): void;
  /// Resolves when the page has asked for a signature (or not, after `ms`).
  waitForSign(ms: number): Promise<boolean>;
  pending(): Ticket | null;
}

/// Ed25519 over a message, with Node's own crypto: the seed is the first 32
/// bytes of a Solana secret key.
function signBytes(kp: Keypair, msg: Uint8Array): Uint8Array {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(kp.secretKey.slice(0, 32))]);
  const key = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return new Uint8Array(crypto.sign(null, Buffer.from(msg), key));
}

export const REJECT = "User rejected the request.";

export async function installWallet(
  context: BrowserContext,
  persona: { id: string },
  kp: Keypair,
  hooks: { onRefused?: (reason: string) => void; onSigned?: (kind: string, dry: boolean) => void } = {},
): Promise<WalletHandle> {
  const log: WalletLog = { connects: 0, messages: 0, signed: [], refused: [] };
  let ticket: Ticket | null = null;
  let waiters: (() => void)[] = [];
  const wake = () => { const w = waiters; waiters = []; w.forEach((f) => f()); };
  const owner = kp.publicKey.toBase58();

  const refuse = (reason: string) => {
    log.refused.push({ reason, at: Date.now() });
    hooks.onRefused?.(reason);
    wake();
    return { error: REJECT };
  };

  const signTx = (b64: string) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());
    if (!signers.includes(owner)) throw new Error(`transaction does not ask ${owner.slice(0, 4)} to sign`);
    tx.sign([kp]);
    return tx;
  };

  await context.exposeFunction("__unwindTesterSign", async (kind: string, payload: any) => {
    try {
      if (kind === "connect") { log.connects++; return { ok: true }; }
      if (kind === "disconnect") return { ok: true };
      if (kind === "signMessage") {
        log.messages++;
        const sig = signBytes(kp, Buffer.from(String(payload.message), "base64"));
        return { signature: Buffer.from(sig).toString("base64") };
      }
      if (kind === "signTransaction" || kind === "signAndSendTransaction") {
        const t = ticket;
        if (!t) return refuse("asked to sign without a ticket");
        ticket = null;
        const tx = signTx(String(payload.tx));
        const dry = config.dryTx;
        log.signed.push({ kind: t.kind, at: Date.now(), dry });
        hooks.onSigned?.(t.kind, dry);
        wake();
        if (dry) {
          store.recordTx({ persona: persona.id, kind: t.kind, status: "dry-run", ms: Date.now() - t.at,
            message: `${tx.message.compiledInstructions.length} instructions, ${tx.serialize().length} bytes` });
          return { error: `${REJECT} (dry run)` };
        }
        if (kind === "signAndSendTransaction") {
          // The site never asks for this (it sends through its own server);
          // implemented for completeness, against the RPC the site uses.
          const conn = new Connection(process.env.TESTERS_RPC ?? "https://api.devnet.solana.com", "confirmed");
          await conn.sendRawTransaction(tx.serialize());
          return { signature: Buffer.from(tx.signatures[0]).toString("base64") };
        }
        return { tx: Buffer.from(tx.serialize()).toString("base64") };
      }
      return { error: `unknown wallet call ${kind}` };
    } catch (e: any) {
      return refuse(`signing failed: ${e?.message ?? e}`);
    }
  });

  const cfg = { name: WALLET_NAME, icon: ICON, address: owner, publicKey: Array.from(kp.publicKey.toBytes()) };
  await context.addInitScript(SHIM, cfg);

  return {
    log,
    allow(t) { ticket = t; },
    revoke() { ticket = null; },
    pending: () => ticket,
    waitForSign(ms) {
      return new Promise((resolve) => {
        const done = () => { clearTimeout(timer); resolve(true); };
        const timer = setTimeout(() => { waiters = waiters.filter((f) => f !== done); resolve(false); }, ms);
        waiters.push(done);
      });
    },
  };
}
