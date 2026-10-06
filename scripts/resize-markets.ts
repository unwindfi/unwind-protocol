/*
 * Grows every pool created before `Pool` gained `aum_drift_usd`, and every
 * market listed before `Market` gained its price-ordering and risk-price
 * fields, to the current size.
 *
 *   CLUSTER=devnet [RPC=https://...] npx ts-node scripts/resize-markets.ts
 *
 * Run once, right after deploying a build that grew either account: until a
 * pool or market is grown, every instruction that reads it fails to
 * deserialise it. Idempotent: an account already at the current size is
 * skipped. The authority pays the extra rent, about 0.0004 SOL a market.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..");
const CLUSTER = process.env.CLUSTER ?? "localnet";
const STATE = path.join(ROOT, `.${CLUSTER}-state.json`);

(async () => {
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const authority = Keypair.fromSecretKey(Uint8Array.from(st.keys.authority));
  // RPC overrides the state file's endpoint, which may be rate limited.
  const conn = new Connection(process.env.RPC ?? st.rpc, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(authority), {
    commitment: "confirmed",
  });
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/unwind.json"), "utf8"));
  const program: any = new anchor.Program(idl, provider);

  // Pools first: nothing that reads a market works until its pool reads.
  const poolDisc = Buffer.from(idl.accounts.find((a: any) => a.name === "Pool").discriminator);
  const poolTarget = program.account.pool.size;
  const pools = await conn.getProgramAccounts(program.programId, {
    filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(poolDisc) } }],
    dataSlice: { offset: 0, length: 0 },
  });
  for (const { pubkey } of pools) {
    const info = await conn.getAccountInfo(pubkey);
    if (!info || info.data.length >= poolTarget) continue;
    await program.methods.resizePool()
      .accounts({ payer: authority.publicKey, pool: pubkey, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`grew pool ${pubkey.toBase58()} from ${info.data.length} to ${poolTarget} bytes`);
  }

  const disc = Buffer.from(idl.accounts.find((a: any) => a.name === "Market").discriminator);
  // A fresh market's size: the discriminator plus the fields, all fixed width.
  const target = program.account.market.size;
  const found = await conn.getProgramAccounts(program.programId, {
    filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(disc) } }],
    dataSlice: { offset: 0, length: 0 },
  });

  let grown = 0;
  for (const { pubkey } of found) {
    const info = await conn.getAccountInfo(pubkey);
    if (!info || info.data.length >= target) continue;
    await program.methods.resizeMarket()
      .accounts({ payer: authority.publicKey, market: pubkey, systemProgram: SystemProgram.programId })
      .rpc();
    grown++;
    console.log(`grew ${pubkey.toBase58()} from ${info.data.length} to ${target} bytes`);
  }
  console.log(`${grown} of ${found.length} markets grown`);
})().catch((e) => { console.error(e); process.exit(1); });
