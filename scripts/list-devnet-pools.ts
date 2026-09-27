/// Lists and backs a market on each seeded devnet pool, as the venue.
///
/// A fresh devnet pool starts with none of the popular-token markets: the
/// DLMM pairs `seed-devnet-pools.ts` made are still there, but a market is
/// per pool, so each has to be listed again. This lists them the way anyone
/// does, through the server's `/api/tx/list-market` (the transaction the /list
/// page asks a wallet to sign), signed by the pool authority. That wallet is
/// one the rewards ranking leaves out, so the house does not top its own
/// leaderboard. Each market seasons on its own after listing: the server
/// cranks every observation, and trading opens once it has 30 readings over
/// 15 minutes.
///
/// WIND, KITE and YAK are skipped by default: they are left for testers to
/// list (docs/devnet.md). Idempotent: a pool that already has a market on
/// this pool is left alone.
///
///   RPC_URL=https://api.devnet.solana.com npx ts-node scripts/list-devnet-pools.ts
///
/// API (default https://api.unwindfi.xyz), BACKING (USD per market, default
/// 2000) and SKIP (comma-separated symbols, default WIND,KITE,YAK) override.
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..");
const st = JSON.parse(fs.readFileSync(path.join(ROOT, ".devnet-state.json"), "utf8"));
const kp = (a: number[]) => Keypair.fromSecretKey(Uint8Array.from(a));

const API = process.env.API ?? "https://api.unwindfi.xyz";
const BACKING = Number(process.env.BACKING ?? 2_000);
const SKIP = new Set((process.env.SKIP ?? "WIND,KITE,YAK").split(",").filter(Boolean));

(async () => {
  // RPC_URL, so a run can stay off the key the devnet server is using.
  const conn = new Connection(process.env.RPC_URL ?? st.rpc, "confirmed");
  const authority = kp(st.keys.authority);
  const usdc = new PublicKey(st.usdcMint);

  const seeded: { symbol: string; pair: string }[] = st.seededPools ?? [];
  const r = await fetch(`${API}/api/testnet-pools`);
  if (!r.ok) throw new Error(`${API}/api/testnet-pools: ${r.status}`);
  const listed = new Set(
    ((await r.json()) as { pool: string; listed: boolean }[]).filter((p) => p.listed).map((p) => p.pool));
  const todo = seeded.filter((p) => !SKIP.has(p.symbol) && !listed.has(p.pair));
  console.log(`${todo.length} to list: ${todo.map((p) => p.symbol).join(", ") || "none"}`);
  if (!todo.length) return;

  // The backing, in test USDC. The authority minted it, so it can top itself up.
  const account = await getOrCreateAssociatedTokenAccount(conn, authority, usdc, authority.publicKey);
  const need = BigInt(Math.round(BACKING * 1e6)) * BigInt(todo.length);
  if (account.amount < need) {
    const mint = await getMint(conn, usdc);
    if (!mint.mintAuthority?.equals(authority.publicKey)) {
      throw new Error(`the authority holds ${account.amount} test USDC base units and cannot mint more`);
    }
    await mintTo(conn, authority, usdc, account.address, authority, need - account.amount);
  }

  for (const p of todo) {
    const res = await fetch(`${API}/api/tx/list-market`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: authority.publicKey.toBase58(), pool: p.pair, payWith: "USDC", backing: BACKING,
      }),
    });
    const body: any = await res.json();
    if (!res.ok) {
      console.log(`${p.symbol}: ${body.error ?? res.status}`);
      continue;
    }
    const tx = VersionedTransaction.deserialize(Buffer.from(body.tx, "base64"));
    tx.sign([authority]);
    try {
      const sig = await conn.sendTransaction(tx);
      await conn.confirmTransaction(
        { signature: sig, blockhash: body.blockhash, lastValidBlockHeight: body.lastValidBlockHeight },
        "confirmed");
      console.log(`${p.symbol}: listed as ${body.symbol}, $${body.backedUsd} backing, ${sig}`);
    } catch (e: any) {
      console.log(`${p.symbol}: ${e?.message ?? e}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
