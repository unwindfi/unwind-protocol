/*
 * Re-sends every market's parameters with a new skew sensitivity.
 *
 * `update_market_params` takes the whole parameter set, so each market's
 * current values are read back from its account and sent unchanged apart from
 * `funding_k_bps`. Funding is accrued first in the same transaction, so the
 * time already elapsed is charged at the rate that was in force, not the new
 * one.
 *
 * Signs as the pool's authority. Prints what it would change unless --send:
 *
 *   CLUSTER=devnet npx ts-node scripts/set-funding-k.ts 100 [--send]
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..");
const cluster = process.env.CLUSTER ?? "localnet";
const S = JSON.parse(fs.readFileSync(path.join(ROOT, `.${cluster}-state.json`), "utf8"));
const k = Number(process.argv[2]);
const send = process.argv.includes("--send");
if (!Number.isInteger(k) || k < 0 || k > 65_535) throw new Error("usage: set-funding-k.ts <funding_k_bps> [--send]");

/// MarketParams, by the names the Market account stores them under.
const PARAMS = [
  "symbol", "feedId", "maxPriceAgeSec", "maxConfBps", "maxLeverageBps", "maintenanceMarginBps",
  "liquidationFeeBps", "openFeeBps", "closeFeeBps", "minPositionUsd", "maxOiLongUsd", "maxOiShortUsd",
  "pnlReserveBps", "baseSpreadBps", "confSpreadMultBps", "maxSpreadBps", "closedSessionLeverageBps",
  "closedSessionOiMultBps", "maxFundingRateBpsPerHour", "fundingKBps", "borrowRateBpsPerHour",
  "priceSource", "observation",
] as const;

async function main() {
  const rpc = process.env.RPC_URL ?? S.rpc ?? "http://127.0.0.1:8899";
  const conn = new Connection(rpc, "confirmed");
  const authority = Keypair.fromSecretKey(Uint8Array.from(S.keys.authority));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(authority), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/unwind.json"), "utf8"));
  const program: any = new Program(idl, provider);
  const pool = new PublicKey(S.pool);

  // Only this pool's markets (after the discriminator and the bump):
  // older pools' accounts keep older layouts.
  const markets = await program.account.market.all([{ memcmp: { offset: 9, bytes: pool.toBase58() } }]);
  console.log(`${markets.length} markets on pool ${pool.toBase58()} (${cluster})`);

  for (const { publicKey, account } of markets) {
    const symbol = Buffer.from(account.symbol).toString("utf8").replace(/\0+$/, "");
    if (account.fundingKBps === k) { console.log(`  ${symbol}: already ${k}`); continue; }
    console.log(`  ${symbol}: funding_k ${account.fundingKBps} -> ${k}`);
    if (!send) continue;
    const params: any = Object.fromEntries(PARAMS.map((f) => [f, account[f]]));
    params.fundingKBps = k;
    const sig = await program.methods.updateMarketParams(params)
      .accounts({ authority: authority.publicKey, pool, market: publicKey })
      .preInstructions([await program.methods.accrueFunding().accounts({ pool, market: publicKey }).instruction()])
      .rpc();
    console.log(`    ${sig}`);
  }
  if (!send) console.log("Dry run. Pass --send to sign.");
}

main().catch((e) => { console.error(e); process.exit(1); });
