/*
 * Tops up the fleet's sixty wallets with devnet SOL (for fees and rent) and
 * test USDC (to trade, deposit and back), from the devnet authority in the
 * server's state file. The faucet is not used: it sits behind a human check.
 *
 * A dry run by default: it reads every balance and prints what it would send
 * and the command that sends it. Only `--send` moves anything.
 *
 *   TESTERS_KEYS=/etc/unwind/testers.json TESTERS_STATE=/opt/unwind/.devnet-state.json \
 *     npx ts-node --transpile-only -P testers/tsconfig.json testers/fund.ts [--send]
 *
 * Env: SOL_TARGET (default 0.05 SOL a wallet), USDC_TARGET (default 1000),
 * LISTER_USDC_TARGET (default 2500, listers post backing), TESTERS_RPC
 * (default the public devnet endpoint), AUTHORITY_SOL_FLOOR (default 2: the
 * authority never goes below this, it also pays the faucet and the crank).
 */
import fs from "fs";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  AccountLayout, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  getAssociatedTokenAddressSync, getMint,
} from "@solana/spl-token";
import { config } from "./config";
import { PERSONAS, loadKeys } from "./personas";

const SEND = process.argv.includes("--send");
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
const SOL_TARGET = num(process.env.SOL_TARGET, 0.05);
const USDC_TARGET = num(process.env.USDC_TARGET, 1_000);
const LISTER_USDC_TARGET = num(process.env.LISTER_USDC_TARGET, 2_500);
const FLOOR = num(process.env.AUTHORITY_SOL_FLOOR, 2);
const STATE = process.env.TESTERS_STATE ?? "/opt/unwind/.devnet-state.json";
const RPC = process.env.TESTERS_RPC ?? "https://api.devnet.solana.com";
/// Wallets per transaction: a transfer, an idempotent account create and a
/// mint each, which keeps a transaction well under the size limit.
const PER_TX = 6;

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const authority = Keypair.fromSecretKey(Uint8Array.from(state.keys.authority));
  const mint = new PublicKey(state.usdcMint);
  const conn = new Connection(RPC, "confirmed");
  if (!/devnet/.test(RPC) && !process.env.TESTERS_RPC) throw new Error("refusing: RPC is not devnet");

  const owners = loadKeys().map((k) => k.publicKey);
  const atas = owners.map((o) => getAssociatedTokenAddressSync(mint, o));
  const [solInfos, tokenInfos] = await Promise.all([
    conn.getMultipleAccountsInfo(owners), conn.getMultipleAccountsInfo(atas),
  ]);
  const mintInfo = await getMint(conn, mint);
  const decimals = mintInfo.decimals;
  const canMint = mintInfo.mintAuthority?.equals(authority.publicKey) ?? false;
  const authSol = (await conn.getBalance(authority.publicKey)) / LAMPORTS_PER_SOL;

  type Need = { i: number; owner: PublicKey; ata: PublicKey; sol: number; usdc: number; addSol: number; addUsdc: number; hasAta: boolean };
  const needs: Need[] = owners.map((owner, i) => {
    const sol = (solInfos[i]?.lamports ?? 0) / LAMPORTS_PER_SOL;
    const t = tokenInfos[i];
    const usdc = t ? Number(AccountLayout.decode(t.data).amount) / 10 ** decimals : 0;
    const target = PERSONAS[i].role === "lister" ? LISTER_USDC_TARGET : USDC_TARGET;
    return {
      i, owner, ata: atas[i], sol, usdc, hasAta: !!t,
      addSol: sol < SOL_TARGET / 2 ? Math.round((SOL_TARGET - sol) * 1e4) / 1e4 : 0,
      addUsdc: usdc < target / 2 ? Math.round(target - usdc) : 0,
    };
  });

  console.log(`RPC ${new URL(RPC).host}, test USDC mint ${mint.toBase58()} (${decimals} decimals)`);
  console.log(`Authority ${authority.publicKey.toBase58()}: ${authSol.toFixed(3)} SOL, ${canMint ? "is" : "is NOT"} the mint authority\n`);
  console.log("persona  role      wallet                                         SOL       USDC   top up");
  for (const n of needs) {
    const p = PERSONAS[n.i];
    const add = [n.addSol ? `+${n.addSol} SOL` : "", n.addUsdc ? `+${n.addUsdc} USDC` : ""].filter(Boolean).join(", ") || "ok";
    console.log(`${p.id.padEnd(8)} ${p.role.padEnd(9)} ${n.owner.toBase58().padEnd(46)} ${n.sol.toFixed(4).padStart(8)} ${n.usdc.toFixed(2).padStart(10)}   ${add}`);
  }
  const todo = needs.filter((n) => n.addSol || n.addUsdc);
  const totalSol = todo.reduce((s, n) => s + n.addSol, 0);
  const totalUsdc = todo.reduce((s, n) => s + n.addUsdc, 0);
  const rent = todo.filter((n) => !n.hasAta && n.addUsdc).length * 0.00204;
  const txs = Math.ceil(todo.length / PER_TX);
  console.log(`\nPlan: ${todo.length} wallets, ${txs} transactions from the authority.`);
  console.log(`  SOL: ${totalSol.toFixed(4)} transferred, plus about ${rent.toFixed(4)} in token account rent and ${(txs * 0.000005).toFixed(6)} in fees.`);
  console.log(`  USDC: ${totalUsdc.toLocaleString("en-US")} test USDC minted by the mint authority.`);
  if (!todo.length) { console.log("Nothing to do."); return; }
  if (!canMint && totalUsdc > 0) throw new Error("the state file's authority cannot mint this USDC; nothing sent");
  if (authSol - totalSol - rent < FLOOR) {
    throw new Error(`the authority would end under its ${FLOOR} SOL floor (has ${authSol.toFixed(3)}); lower SOL_TARGET or top up the authority. Nothing sent.`);
  }
  if (!SEND) {
    console.log("\nDry run: nothing was sent. To send exactly this plan:");
    console.log(`  TESTERS_KEYS=${config.keysFile} TESTERS_STATE=${STATE}${process.env.TESTERS_RPC ? ` TESTERS_RPC=${RPC}` : ""} \\`);
    console.log("    npx ts-node --transpile-only -P testers/tsconfig.json testers/fund.ts --send");
    return;
  }

  for (let k = 0; k < todo.length; k += PER_TX) {
    const batch = todo.slice(k, k + PER_TX);
    const tx = new Transaction();
    for (const n of batch) {
      if (n.addSol) tx.add(SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: n.owner, lamports: Math.round(n.addSol * LAMPORTS_PER_SOL) }));
      if (n.addUsdc) {
        tx.add(createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, n.ata, n.owner, mint));
        tx.add(createMintToInstruction(mint, n.ata, authority.publicKey, BigInt(n.addUsdc) * 10n ** BigInt(decimals)));
      }
    }
    const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
    console.log(`sent ${batch.map((n) => PERSONAS[n.i].id).join(", ")}: ${sig}`);
  }
  console.log("Done. Run again without --send to see the new balances.");
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
