/*
 * Grows every market listed before `Market` gained its price-ordering and
 * risk-price fields to the current size.
 *
 *   CLUSTER=devnet npx ts-node scripts/resize-markets.ts
 *
 * Run once, right after deploying the build that has `resize_market`: until a
 * market is grown, every instruction that reads it fails to deserialise it.
 * Idempotent: a market already at the current size is skipped. The authority
 * pays the extra rent, about 0.0004 SOL a market.
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
  const conn = new Connection(st.rpc, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(authority), {
    commitment: "confirmed",
  });
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/unwind.json"), "utf8"));
  const program: any = new anchor.Program(idl, provider);

  const disc = Buffer.from(idl.accounts.find((a: any) => a.name === "Market").discriminator);
  // A fresh market's size: the discriminator plus the fields, all fixed width.
  const target = program.coder.accounts.size("Market");
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
