/*
 * Adds the SOL and USDT custodies to a pool bootstrapped before they existed,
 * and gives the demo trader some USDT to back with.
 *
 *   CLUSTER=localnet npx ts-node scripts/add-custodies.ts
 *
 * Idempotent: a custody already there is left alone. The program must be the
 * build that has `add_custody`; deploy it first.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { ensureCustodies } from "./custodies";

const ROOT = path.join(__dirname, "..");
const CLUSTER = process.env.CLUSTER ?? "localnet";
const STATE = path.join(ROOT, `.${CLUSTER}-state.json`);

(async () => {
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const kp = (k: number[]) => Keypair.fromSecretKey(Uint8Array.from(k));
  const authority = kp(st.keys.authority);
  const trader = kp(st.keys.trader);
  const conn = new Connection(st.rpc, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(authority), {
    commitment: "confirmed",
  });
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/unwind.json"), "utf8"));
  const program: any = new anchor.Program(idl, provider);

  const usdt = await ensureCustodies(program, conn, authority, new PublicKey(st.pool),
    st.usdtMint ? new PublicKey(st.usdtMint) : null);

  // The stand-in USDT is ours to mint, so the demo account gets some the
  // first time round. Not on a chain where it is somebody else's token.
  if (!st.usdtMint) {
    const to = await getOrCreateAssociatedTokenAccount(conn, authority, usdt, trader.publicKey);
    await mintTo(conn, authority, usdt, to.address, authority, 250_000e6);
  }
  st.usdtMint = usdt.toBase58();
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
  console.log(`custodies ready; USDT ${usdt.toBase58()}`);
})().catch((e) => { console.error(e); process.exit(1); });
