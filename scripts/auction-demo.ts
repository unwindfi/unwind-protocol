/*
 * One batch, end to end, on localnet.
 *
 * Two participants put opposing orders into the same batch; the crank seals it
 * at whatever price crosses the most volume and settles both. Nothing here
 * tells the program what the price is — that is the point of the exercise.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, mintTo, createAssociatedTokenAccount } from "@solana/spl-token";
import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "..");
const S = JSON.parse(fs.readFileSync(path.join(ROOT, ".localnet-state.json"), "utf8"));
const kp = (a: number[]) => Keypair.fromSecretKey(Uint8Array.from(a));
const USD = (n: number) => new BN(Math.round(n * 1e6));
const sym = process.argv[2] ?? "SPYx";

(async () => {
  const conn = new Connection(S.rpc, "confirmed");
  const authority = kp(S.keys.authority);
  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/unwind.json"), "utf8"));
  const program: any = new Program(idl, provider);

  const trader = kp(S.keys.trader);
  const maker = kp(S.keys.lp);
  const usdcMint = new PublicKey(S.usdcMint);
  const pool = new PublicKey(S.pool);
  const usdcVault = new PublicKey(S.usdcVault);
  const m = S.markets[sym];
  const market = new PublicKey(m.market);
  const batch = new PublicKey(m.batch);
  const priceUpdate = new PublicKey(m.priceUpdate);

  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const positionOf = (owner: PublicKey) =>
    pda([Buffer.from("position"), market.toBuffer(), owner.toBuffer()]);

  // Both sides need funds of their own; the maker's USDC went into the pool.
  for (const who of [trader, maker]) {
    const ata = getAssociatedTokenAddressSync(usdcMint, who.publicKey);
    if (!(await conn.getAccountInfo(ata))) {
      await createAssociatedTokenAccount(conn, authority, usdcMint, who.publicKey);
    }
    await mintTo(conn, authority, usdcMint, ata, authority, 100_000e6);
  }

  // Reference for where to put the orders. A Pyth market is priced from its
  // feed; an observed one carries its mark on the observation account, which
  // is what `priceUpdate` points at for those.
  const mk: any = await program.account.market.fetch(market);
  let mid: number;
  if (mk.priceSource === 1) {
    const o: any = await program.account.observation.fetch(priceUpdate);
    mid = Number(o.ewmaPrice) / 1e6;
    console.log(`\n${sym}  observed mark $${mid.toFixed(4)}  (AMM, no Pyth feed)`);
  } else {
    mid = Number(mk.longAvgEntryPrice) || 0;
    const q = await fetch("http://localhost:3000/api/markets").catch(() => null);
    mid = 0;
  }
  const submit = (who: Keypair, price: number, sizeUsd: number, isBid: boolean, isMaker: boolean) =>
    program.methods
      .submitOrder(USD(price), USD(sizeUsd), USD(sizeUsd * 0.6), isBid, false, isMaker)
      .accounts({
        owner: who.publicKey, pool, market, batch,
        usdcMint, usdcVault,
        ownerUsdc: getAssociatedTokenAddressSync(usdcMint, who.publicKey),
        position: positionOf(who.publicKey),
        tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([who])
      .rpc();

  // A taker's bid above a maker's ask: these meet in the buy flow, and where
  // they cross is for the program to work out. Placed around the mark so the same script works on a
  // $108 memecoin and a $765 index alike.
  const ref = mid > 0 ? mid : Number(process.argv[3] ?? 750);
  const bidPx = Number((ref * 1.004).toFixed(4));
  const askPx = Number((ref * 0.996).toFixed(4));
  await submit(trader, bidPx, 1_000, true, false);
  console.log(`  trader bids  $${bidPx}  for $1,000`);
  await submit(maker, askPx, 1_000, false, true);
  console.log(`  maker  asks  $${askPx}  for $1,000`);

  const before: any = await program.account.batch.fetch(batch);
  console.log(`  batch holds ${before.orders.filter((o: any) => o.active).length} orders, seq ${before.seq}`);

  console.log("  waiting out the 1s window…");
  await new Promise((r) => setTimeout(r, 2_000));

  await program.methods.clearBatch()
    .accounts({ pool, market, batch, priceUpdate }).rpc();

  const sealed: any = await program.account.batch.fetch(batch);
  console.log(`\n  BUY FLOW cleared at $${(Number(sealed.buyPrice) / 1e6).toFixed(4)}` +
              `  matched $${(Number(sealed.buyMatchedUsd) / 1e6).toFixed(2)}`);

  for (let i = 0; i < sealed.orders.length; i++) {
    const o = sealed.orders[i];
    if (!o.active) continue;
    const owner = new PublicKey(o.owner);
    await program.methods.settleOrder(i)
      .accounts({
        pool, market, batch, owner,
        position: positionOf(owner),
        usdcMint, usdcVault,
        ownerUsdc: getAssociatedTokenAddressSync(usdcMint, owner),
        tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      })
      .rpc();
    const who = owner.equals(trader.publicKey) ? "trader" : "maker ";
    console.log(`  settled ${who} #${i}: filled $${(Number(o.filledUsd) / 1e6).toFixed(2)}` +
                ` of $${(Number(o.sizeUsd) / 1e6).toFixed(2)}`);
  }

  for (const [name, who] of [["trader", trader], ["maker", maker]] as const) {
    const p: any = await program.account.position.fetchNullable(positionOf(who.publicKey));
    if (p && !p.sizeUsd.isZero()) {
      console.log(`  ${name} position: ${p.isLong ? "LONG" : "SHORT"} ` +
                  `$${(Number(p.sizeUsd) / 1e6).toFixed(2)} @ $${(Number(p.entryPrice) / 1e6).toFixed(4)}`);
    }
  }

  const after: any = await program.account.batch.fetch(batch);
  console.log(`  next batch seq ${after.seq}, open: ${Number(after.clearedTs) === 0}\n`);
})().catch((e) => { console.error(e); process.exit(1); });
