/*
 * Listing a market on an asset Pyth has never heard of.
 *
 * The whole path, in the order it has to happen:
 *
 *   1. point an Observation at an AMM pool
 *   2. crank it until it has enough history to be worth anything
 *   3. list the market against that observation — permissionless
 *   4. back it: post collateral that takes the market's first loss
 *
 * Every step is permissionless. A market that has done only the first three
 * can be quoted and watched and cannot open a position, which is the safe
 * state for something nobody has put capital behind.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { SOL_USD_FEED, backingBookPda, custodyPda } from "./custodies";
import { priceAccountFor } from "./mock-pyth";

const ROOT = path.join(__dirname, "..");
const S = JSON.parse(fs.readFileSync(path.join(ROOT, ".localnet-state.json"), "utf8"));
const kp = (a: number[]) => Keypair.fromSecretKey(Uint8Array.from(a));
const USD = (n: number) => new BN(Math.round(n * 1e6));

/// The cloned mainnet Raydium CLMM pool. SOL is token 0 at 9dp, USDC token 1
/// at 6dp, so readings come out USD-per-SOL and need no inverting.
const SOURCE = new PublicKey("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");
const SYMBOL = process.argv[2] ?? "SOLp";

/// Seasoning, from the program: 30 readings spanning 15 minutes. Both, because
/// thirty crank calls in one block observe nothing.
const MIN_OBSERVATIONS = 30;
const MIN_WINDOW_SEC = 900;

(async () => {
  const conn = new Connection(S.rpc, "confirmed");
  const authority = kp(S.keys.authority);
  const provider = new anchor.AnchorProvider(
    conn, new anchor.Wallet(authority), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(
    fs.readFileSync(path.join(ROOT, "target/idl/unwind.json"), "utf8"));
  const program: any = new Program(idl, provider);

  const pool = new PublicKey(S.pool);
  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  // A market's address is keyed by its feed id. There is no Pyth feed here, so
  // the id is the hash of "amm:" and the pool's raw address, which the
  // program checks (`observed_feed_id`).
  const feedId = crypto.createHash("sha256")
    .update(Buffer.concat([Buffer.from("amm:"), SOURCE.toBuffer()])).digest();
  const market = pda([Buffer.from("market"), pool.toBuffer(), feedId]);
  const observation = pda([Buffer.from("observation"), market.toBuffer()]);
  const batch = pda([Buffer.from("batch"), market.toBuffer()]);

  console.log(`\nlisting ${SYMBOL}`);
  console.log(`  source      ${SOURCE.toBase58()}`);
  console.log(`  market      ${market.toBase58()}`);
  console.log(`  observation ${observation.toBase58()}`);

  // 3 first: the observation account is a PDA of the market, so the market has
  // to exist before anything can be pointed at it.
  if (!(await conn.getAccountInfo(market))) {
    await program.methods
      .addMarket({
        symbol: Array.from(
          Buffer.concat([Buffer.from(SYMBOL), Buffer.alloc(16)]).subarray(0, 16)),
        feedId: Array.from(feedId),
        maxPriceAgeSec: 120,
        // Wide, because a depth-derived confidence on a pool this size is
        // wide. Too tight and the market simply never quotes.
        maxConfBps: 5_000,
        maxLeverageBps: 30_000,
        maintenanceMarginBps: 1_000,
        liquidationFeeBps: 100,
        openFeeBps: 10,
        closeFeeBps: 10,
        minPositionUsd: USD(10),
        maxOiLongUsd: USD(50_000),
        maxOiShortUsd: USD(50_000),
        pnlReserveBps: 10_000,
        baseSpreadBps: 20,
        confSpreadMultBps: 10_000,
        maxSpreadBps: 2_000,
        closedSessionLeverageBps: 30_000,
        closedSessionOiMultBps: 10_000,
        maxFundingRateBpsPerHour: 100,
        fundingKBps: 8_000,
        borrowRateBpsPerHour: 1,
        priceSource: 1, // observed, not Pyth
        observation,
      })
      .accounts({
        payer: authority.publicKey, pool, market,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  listed (unfunded — it cannot open a position yet)");
  }

  if (!(await conn.getAccountInfo(observation))) {
    await program.methods
      .createObservation({
        source: SOURCE,
        sourceKind: 0, // Raydium CLMM
        quoteIsToken0: false,
        alphaBps: 500,
        maxMoveBps: 100,
        // SOL is priced a token at a time; a memecoin would take 6 here and
        // be marked per million.
        unitExp: 0,
      })
      .accounts({
        payer: authority.publicKey, pool, market, observation, source: SOURCE,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  observing");
  }

  if (!(await conn.getAccountInfo(batch))) {
    await program.methods
      .createBatch()
      .accounts({ payer: authority.publicKey, pool, market, batch,
                  systemProgram: SystemProgram.programId })
      .rpc();
  }

  // 2. Crank. There is no shortcut: the window is wall-clock, and shortening
  // it for a demo would be shortening the only thing that makes the mark cost
  // anything to move.
  const started = Date.now();
  for (;;) {
    await program.methods
      .observe()
      .accounts({ observation, market, source: SOURCE })
      .rpc();
    const o: any = await program.account.observation.fetch(observation);
    const span = o.lastUpdateTs.toNumber() - o.firstUpdateTs.toNumber();
    const seasoned = o.observations >= MIN_OBSERVATIONS && span >= MIN_WINDOW_SEC;

    process.stdout.write(
      `\r  mark $${(Number(o.ewmaPrice) / 1e6).toFixed(4)}` +
      `  spot $${(Number(o.lastSpot) / 1e6).toFixed(4)}` +
      `  ${o.observations} readings over ${span}s` +
      `  ${seasoned ? "SEASONED" : `(needs ${MIN_OBSERVATIONS}/${MIN_WINDOW_SEC}s)`}   `);

    if (seasoned) break;
    if (Date.now() - started > 25 * 60_000) throw new Error("gave up waiting");
    await new Promise((r) => setTimeout(r, 20_000));
  }
  console.log("\n  seasoned — the mark is now tradeable");

  // 4. Back it. The authority posts here like any backer would; the budget is
  // what backing covers. Every custody rides along, in index order.
  const usdcMint = new PublicKey(S.usdcMint);
  const ownerToken = (await getOrCreateAssociatedTokenAccount(
    conn, authority, usdcMint, authority.publicKey)).address;
  await mintTo(conn, authority, usdcMint, ownerToken, authority.publicKey, 25_000e6);
  const custodies = [
    { custody: custodyPda(program.programId, pool, NATIVE_MINT),
      price: priceAccountFor(Buffer.from(SOL_USD_FEED, "hex")) },
    { custody: custodyPda(program.programId, pool, new PublicKey(S.usdtMint)),
      price: SystemProgram.programId },
  ];
  await program.methods
    .backMarket(USD(25_000))
    .accounts({
      owner: authority.publicKey, pool, market,
      backing: pda([Buffer.from("backing"), market.toBuffer(), authority.publicKey.toBuffer()]),
      book: backingBookPda(program.programId, market),
      depositMint: usdcMint, depositVault: new PublicKey(S.usdcVault), ownerToken,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(custodies.flatMap((c) => [
      { pubkey: c.custody, isWritable: true, isSigner: false },
      { pubkey: c.price, isWritable: false, isSigner: false },
    ]))
    .rpc();
  console.log("  backed with $25,000; the budget is what that covers");

  S.markets[SYMBOL] = {
    market: market.toBase58(),
    feedId: feedId.toString("hex"),
    priceUpdate: observation.toBase58(),
    batch: batch.toBase58(),
    observation: observation.toBase58(),
    source: SOURCE.toBase58(),
  };
  fs.writeFileSync(path.join(ROOT, ".localnet-state.json"), JSON.stringify(S, null, 2));
  console.log(`  recorded as ${SYMBOL}\n`);
})().catch((e) => { console.error(e); process.exit(1); });
