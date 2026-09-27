/// Opens and closes a real position on the devnet pool, end to end.
///
/// Submits a long into SPYx's batch, waits for the crank (scripts/server.ts,
/// which must be running) to clear and settle it, then closes it the same way.
/// It checks the parts a smoke test can only answer on a live cluster: the
/// deployed program takes the order, the crank clears it against the relay's
/// price, and the pool's count of markets with open interest follows.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { feedIdFor } from "./markets";

const ROOT = path.join(__dirname, "..");
const st = JSON.parse(fs.readFileSync(`${ROOT}/.devnet-state.json`, "utf8"));
const USD = (n: number) => new BN(Math.round(n * 1e6));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SYMBOL = process.env.SYMBOL ?? "SPYx";
const SETTLE_TIMEOUT_MS = 240_000;
// Slow enough to share the public RPC with a running crank.
const POLL_MS = 8_000;

(async () => {
  const conn = new Connection(st.rpc, "confirmed");
  const trader = Keypair.fromSecretKey(Uint8Array.from(st.keys.trader));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(trader), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(`${ROOT}/target/idl/unwind.json`, "utf8"));
  const program: any = new Program(idl, provider);

  const pool = new PublicKey(st.pool);
  const market = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), pool.toBuffer(), Buffer.from(feedIdFor(SYMBOL))], program.programId)[0];
  const position = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), trader.publicKey.toBuffer()], program.programId)[0];
  const batch = PublicKey.findProgramAddressSync(
    [Buffer.from("batch"), market.toBuffer()], program.programId)[0];
  const accounts = {
    owner: trader.publicKey, pool, market, batch, position,
    usdcMint: new PublicKey(st.usdcMint),
    usdcVault: new PublicKey(st.usdcVault),
    ownerUsdc: new PublicKey(st.traderUsdc),
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  };

  const size = async () => {
    const p = await program.account.position.fetchNullable(position);
    return p ? p.sizeUsd.toNumber() / 1e6 : 0;
  };
  // An order only rests in the batch; the position exists once the crank has
  // cleared the batch and settled the order.
  const settled = async (want: (s: number) => boolean, label: string) => {
    const t0 = Date.now();
    while (Date.now() - t0 < SETTLE_TIMEOUT_MS) {
      const s = await size();
      if (want(s)) {
        console.log(`  ${label} settled after ${((Date.now() - t0) / 1000).toFixed(0)}s, size $${s}`);
        return;
      }
      await sleep(POLL_MS);
    }
    throw new Error(`${label} did not settle; is scripts/server.ts running against devnet?`);
  };
  const withOi = async () => (await program.account.pool.fetch(pool)).marketsWithOi;

  if ((await size()) > 0) throw new Error(`the trader already holds ${SYMBOL}; close it first`);
  console.log(`${SYMBOL} on pool ${pool.toBase58()}`);

  // A bid far above the market, so it crosses whatever the relay has posted.
  await program.methods.submitOrder(USD(100_000), USD(800), USD(500), true, false, false)
    .accounts(accounts).rpc();
  await settled((s) => s >= 800, "open");
  const p = await program.account.position.fetch(position);
  console.log(`  entry $${(p.entryPrice.toNumber() / 1e6).toFixed(2)}, collateral $${(p.collateralUsd.toNumber() / 1e6).toFixed(2)}`);
  console.log(`  markets with open interest: ${await withOi()}`);

  await program.methods.submitOrder(USD(1), USD(800), USD(0), false, true, false)
    .accounts(accounts).rpc();
  await settled((s) => s === 0, "close");
  console.log(`  markets with open interest: ${await withOi()}`);
})().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
