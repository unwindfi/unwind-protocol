/// Puts the local validator into a tradeable state: a pool with deep liquidity,
/// one market per xStock, a funded account, and a live price posted for every
/// feed. Nothing that reads an oracle can run before that last step, so it
/// happens before the seeding deposit.
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { MARKETS as ALL_MARKETS, feedIdFor } from "./markets";
import { createLookupTable, loadLookupTable, sendV0 } from "./alt";
import { ensureCustodies } from "./custodies";
import { fetchQuotes, fetchSessions, Session } from "./prices";
import { MOCK_PYTH_ID, mockPythProgram, postQuotes, priceAccountFor, relayKeypair } from "./mock-pyth";

const ROOT = path.join(__dirname, "..");
/// Defaults to the local validator; `RPC_URL` points it at another cluster.
/// Devnet is slower and charges for every account, so the market list is
/// trimmed there rather than standing up all twelve.
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";

/// Where the chain's share of every fee goes, off localnet. Required: the pool
/// fixes it for life at creation, so a forgotten variable must stop the run
/// rather than send the chain's revenue to a demo key.
function chainFeeDestination(): PublicKey {
  const v = process.env.CHAIN_FEE_DESTINATION;
  if (!v) throw new Error("set CHAIN_FEE_DESTINATION to the address the chain's fee share goes to");
  return new PublicKey(v);
}
const IS_LOCAL = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const MARKET_LIMIT = Number(process.env.MARKET_LIMIT ?? (IS_LOCAL ? 99 : 3));
const MARKETS = ALL_MARKETS.slice(0, MARKET_LIMIT);

/// A public RPC is a shared resource and throttles hard. Local runs pace at
/// zero; anywhere else waits between transactions rather than retrying into a
/// rate limit it caused.
const PACE_MS = Number(process.env.PACE_MS ?? (IS_LOCAL ? 0 : 900));
const pace = () => new Promise((r) => setTimeout(r, PACE_MS));

/// Retries a call a public RPC throttled. web3.js backs off on a 429 by
/// itself, but gives up after a few, which on a public devnet is not enough.
async function retry<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f(); }
    catch (e) {
      if (i >= 6) throw e;
      await new Promise((r) => setTimeout(r, 3_000 * (i + 1)));
    }
  }
}

/// `getOrCreateAssociatedTokenAccount`, retried. On a public cluster it can
/// create the account and then read it back from a node that has not seen the
/// creation yet, and fail on an account that exists. A second look finds it.
async function ataFor(...args: Parameters<typeof getOrCreateAssociatedTokenAccount>) {
  for (let i = 0; ; i++) {
    try { return await getOrCreateAssociatedTokenAccount(...args); }
    catch (e) {
      if (i >= 5) throw e;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}
const USD = (n: number) => new BN(Math.round(n * 1e6));

const STATE_PATH = path.join(__dirname, "..",
  IS_LOCAL ? ".localnet-state.json" : ".devnet-state.json");

/// Picks up where a previous run stopped.
///
/// A public RPC will throttle partway through, and starting over then throws
/// away every account already paid for — and creates a second orphaned pool on
/// a chain that keeps them. Resuming reuses the same keypairs and mint, so the
/// pool and market addresses come out identical and the work already done is
/// still the work that counts.
function priorRun() {
  if (process.env.FRESH === "1" || !fs.existsSync(STATE_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); }
  catch { return null; }
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const prior = priorRun();
  const kp = (a: number[]) => Keypair.fromSecretKey(Uint8Array.from(a));
  const authority = prior ? kp(prior.keys.authority) : Keypair.generate();
  const lp = prior ? kp(prior.keys.lp) : Keypair.generate();
  const trader = prior ? kp(prior.keys.trader) : Keypair.generate();
  if (prior) console.log(`resuming ${STATE_PATH.split("/").pop()}`);
  // A public cluster has no faucet worth relying on, so the deployer funds the
  // demo accounts out of its own balance instead of airdropping to each.
  if (IS_LOCAL) {
    for (const kp of [authority, lp, trader]) {
      await conn.confirmTransaction(
        await conn.requestAirdrop(kp.publicKey, 500e9), "confirmed");
    }
  } else {
    const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
      fs.readFileSync(process.env.DEPLOYER ??
        `${process.env.HOME}/.config/solana/id.json`, "utf8"))));
    // Only top up what is actually short. A resumed run would otherwise pay
    // the demo accounts again out of a balance that has to cover rent.
    const tx = new Transaction();
    for (const kp of [authority, lp, trader]) {
      const have = await conn.getBalance(kp.publicKey);
      if (have >= 0.2e9) continue;
      tx.add(SystemProgram.transfer({
        fromPubkey: payer.publicKey, toPubkey: kp.publicKey,
        lamports: 0.35e9 - have,
      }));
      await pace();
    }
    if (tx.instructions.length) {
      await conn.sendTransaction(tx, [payer]);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(authority), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(
    fs.readFileSync(path.join(ROOT, "target/idl/unwind.json"), "utf8"));
  const program: any = new Program(idl, provider);
  const pyth = mockPythProgram(provider);

  // Fetched first: a market whose oracle has never been written cannot take a
  // deposit, and there is no fallback price to fall back to.
  const quotes = await fetchQuotes();
  const missing = MARKETS.filter((m) => !quotes[m.symbol]).map((m) => m.symbol);
  if (missing.length) throw new Error(`no live quote for ${missing.join(", ")}`);
  // Off localnet only the relay key may post (programs/mock-pyth, `devnet`).
  await postQuotes(pyth, IS_LOCAL ? authority : relayKeypair(), quotes);
  for (const m of MARKETS) {
    const q = quotes[m.symbol];
    console.log(
      `  price  ${m.symbol.padEnd(6)} $${q.price.toFixed(2)}` +
      `  conf ${q.confBps.toFixed(1)}bp`);
  }

  await pace();
  // Resuming only holds while the ledger the state file describes is still
  // there. `solana-test-validator --reset` wipes the chain and leaves the file
  // untouched, so a mint named here can be a pubkey nothing lives at -- and
  // every PDA below hangs off it, which is why the failure surfaces as a pool
  // complaining its mint is uninitialised. Check before trusting it.
  const priorMint = prior ? new PublicKey(prior.usdcMint) : null;
  const priorMintLives = priorMint ? !!(await conn.getAccountInfo(priorMint)) : false;
  if (priorMint && !priorMintLives) {
    console.log(`  ${priorMint.toBase58()} is gone from this ledger — minting a new USDC`);
  }
  const usdcMint = priorMintLives
    ? priorMint!
    : await createMint(conn, authority, authority.publicKey, null, 6);
  await pace();
  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  const pool = pda([Buffer.from("pool"), usdcMint.toBuffer()]);
  const usdcVault = pda([Buffer.from("pool_vault"), pool.toBuffer()]);
  const lpMint = pda([Buffer.from("lp_mint"), pool.toBuffer()]);

  const poolExists = !!(await conn.getAccountInfo(pool));
  if (!poolExists) await program.methods
    .initializePool({
        pythReceiver: MOCK_PYTH_ID,
        // Fixed for the life of the pool. On localnet the authority stands in
        // for it; a real deployment sets a chain-aligned address here and can
        // never change it afterwards -- which is the point of the field.
        // Write-once, so off localnet it is never a default: the pool is not
        // created until someone has said where the chain's share goes.
        chainFeeDestination: IS_LOCAL ? authority.publicKey : chainFeeDestination(),
      addLiquidityFeeBps: 0,
      removeLiquidityFeeBps: 5,
      protocolFeeShareBps: 2000,
        insuranceFeeShareBps: 1000,
      maxUtilizationBps: 8000,
    })
    .accounts({
      authority: authority.publicKey, pool, usdcMint, usdcVault, lpMint,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  // Saved now, not only at the end: everything after this is resumable from
  // the keys and the mint, and a run the RPC cuts off halfway would otherwise
  // start again from new ones, orphaning a pool and the SOL that funded it.
  if (!prior) {
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      rpc: RPC, programId: program.programId.toBase58(), usdcMint: usdcMint.toBase58(),
      pool: pool.toBase58(), markets: {}, partial: true,
      keys: {
        authority: Array.from(authority.secretKey),
        lp: Array.from(lp.secretKey),
        trader: Array.from(trader.secretKey),
      },
    }, null, 2));
  }

  /// A market with no batch cannot be traded: every order goes into one, and
  /// the clearing price is a function of what a batch holds. Creating it is
  /// permissionless, so the bootstrap just makes sure one exists.
  const batchPda = (market: PublicKey) =>
    pda([Buffer.from("batch"), market.toBuffer()]);

  const ensureBatch = async (market: PublicKey, symbol: string) => {
    const batch = batchPda(market);
    if (await conn.getAccountInfo(batch)) return batch;
    await program.methods
      .createBatch()
      .accounts({
        payer: authority.publicKey, pool, market, batch,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
    console.log(`  batch  ${symbol.padEnd(6)} ${batch.toBase58()}`);
    return batch;
  };

  const markets: Record<string, any> = {};
  for (const m of MARKETS) {
    const feedId = feedIdFor(m.symbol);
    const market = pda([Buffer.from("market"), pool.toBuffer(), feedId]);
    if (await conn.getAccountInfo(market)) {
      markets[m.symbol] = {
        market: market.toBase58(), feedId: m.feedId,
        batch: batchPda(market).toBase58(),
      };
      await ensureBatch(market, m.symbol);
      console.log(`  market ${m.symbol.padEnd(6)} ${market.toBase58()} (already there)`);
      continue;
    }
    await program.methods
      .addMarket({
        symbol: Array.from(
          Buffer.concat([Buffer.from(m.symbol), Buffer.alloc(16)]).subarray(0, 16)),
        feedId: Array.from(feedId),
        // Real seconds, because `publish_time` is now the source's own
        // timestamp rather than whenever a fixture was generated. The server
        // reposts far more often than this; if it stops, trading stops.
        maxPriceAgeSec: 90,
        maxConfBps: m.maxConfBps,
        maxLeverageBps: m.maxLeverageBps,
        maintenanceMarginBps: m.maintenanceMarginBps,
        liquidationFeeBps: Math.min(100, m.maintenanceMarginBps - 1),
        openFeeBps: 6,
        closeFeeBps: 6,
        minPositionUsd: USD(10),
        maxOiLongUsd: USD(2_000_000),
        maxOiShortUsd: USD(2_000_000),
        pnlReserveBps: 10_000,
        baseSpreadBps: 4,
        confSpreadMultBps: 10_000,
        maxSpreadBps: 500,
        closedSessionLeverageBps: 20_000,
        closedSessionOiMultBps: 2_500,
        maxFundingRateBpsPerHour: 100,
        fundingKBps: 8_000,
        borrowRateBpsPerHour: 1,
        // Pyth, with no observation account. A market on an asset Pyth does
        // not cover points at one of those instead.
        priceSource: 0,
        observation: PublicKey.default,
      })
      .accounts({
        payer: authority.publicKey, pool, market,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Listing is permissionless and arrives unfunded; underwriting is a
    // separate act by whoever owns the risk. Localnet seeds every market with
    // the same budget, where a real one derives it from what it costs to move
    // that asset's price.
    await program.methods
      .setMarketBudget(USD(250_000))
      .accounts({ authority: authority.publicKey, pool, market })
      .rpc();
    markets[m.symbol] = {
      market: market.toBase58(),
      feedId: m.feedId,
      priceUpdate: priceAccountFor(feedId).toBase58(),
      batch: batchPda(market).toBase58(),
    };
    await ensureBatch(market, m.symbol);
    console.log(`  market ${m.symbol.padEnd(6)} ${market.toBase58()}`);
  }

  // The token trades around the clock but the equity behind it does not, and
  // the program already prices that difference -- tighter leverage and open
  // interest caps while the underlying is shut. Nothing used to set it, so it
  // sat on `Regular` forever. The calendar comes from Pyth's feed metadata.
  const sessions = await fetchSessions();
  for (const m of MARKETS) {
    const s = sessions[m.symbol];
    if (s === undefined) continue;
    await program.methods
      .setSession(s)
      .accounts({
        authority: authority.publicKey, pool,
        market: new PublicKey(markets[m.symbol].market),
      })
      .rpc();
    console.log(`  session ${m.symbol.padEnd(6)} ${Session[s]}`);
  }

  const lpUsdc = (await ataFor(conn, lp, usdcMint, lp.publicKey)).address;
  const lpLp = (await ataFor(conn, lp, lpMint, lp.publicKey)).address;
  const traderUsdc = (await ataFor(conn, trader, usdcMint, trader.publicKey)).address;
  const traderLp = (await ataFor(conn, trader, lpMint, trader.publicKey)).address;
  const liquidatorUsdc = (await ataFor(conn, authority, usdcMint, authority.publicKey)).address;

  // Up to a target rather than by a fixed amount, so a resumed run tops up
  // what an interrupted one did not get to, and mints nothing twice.
  const topUp = async (to: PublicKey, target: number) => {
    const have = Number((await retry(() => conn.getTokenAccountBalance(to))).value.amount);
    if (have < target) {
      await retry(() => mintTo(conn, authority, usdcMint, to, authority.publicKey, target - have));
    }
  };
  await topUp(lpUsdc, 20_000_000e6);
  await topUp(traderUsdc, 250_000e6);

  // Only markets with open interest count toward the pool's value
  // (`Pool::markets_with_oi`); keep a pair only while its market has some.
  const oiOnly = async (pairs: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[]) => {
    const out: typeof pairs = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const m: any = await program.account.market.fetchNullable(pairs[i].pubkey);
      if (m && (!m.longSizeUsd.isZero() || !m.shortSizeUsd.isZero())) out.push(pairs[i], pairs[i + 1]);
    }
    return out;
  };

  const remaining = MARKETS.flatMap((m) => [
    { pubkey: new PublicKey(markets[m.symbol].market), isWritable: false, isSigner: false },
    { pubkey: priceAccountFor(feedIdFor(m.symbol)), isWritable: false, isSigner: false },
  ]);

  // Every market's pair goes in a lookup table so the liquidity instructions
  // reference them by 1-byte index instead of 32-byte key. Measured at 66 bytes
  // per market, eight is the most a legacy transaction holds — below that the
  // table is pure overhead, and on a throttled public RPC it is several round
  // trips bought for nothing.
  const needsTable = MARKETS.length > 8;
  let lookupTable: PublicKey | null = null;
  let table = null;
  if (needsTable) {
    lookupTable = await createLookupTable(conn, authority, remaining.map((a) => a.pubkey));
    table = await loadLookupTable(conn, lookupTable);
    console.log(`  lookup ${lookupTable.toBase58()}  (${remaining.length} addresses)`);
  }
  await pace();

  const already = await program.account.pool.fetch(pool);
  const seeded = already.liquidityUsd.toNumber() > 0;
  if (seeded) {
    console.log(`  liquidity  already ${(already.liquidityUsd.toNumber() / 1e6).toLocaleString()} USD`);
  }

  const seedIx = await program.methods
    .addLiquidity(USD(10_000_000), new BN(0))
    .accounts({
      owner: lp.publicKey, pool, usdcMint, usdcVault, lpMint,
      ownerUsdc: lpUsdc, ownerLp: lpLp, tokenProgram: TOKEN_PROGRAM_ID,
    })
    // Priced against the markets somebody holds a position in, which on a
    // fresh pool is none of them. A resumed run may find some.
    .remainingAccounts(await oiOnly(remaining))
    .instruction();

  // Pricing every market in one instruction costs more than the default budget
  // once the list grows past a handful.
  if (!seeded) {
    await sendV0(conn, lp, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      seedIx,
    ], table ? [table] : []);
  }

  // After the seed, which prices LP shares against every custody the pool
  // has: a fresh pool seeds with none, and the custodies start empty.
  const usdtMint = await ensureCustodies(program, conn, authority, pool,
    prior?.usdtMint ? new PublicKey(prior.usdtMint) : null);
  if (!prior?.usdtMint) {
    const traderUsdt = (await ataFor(
      conn, trader, usdtMint, trader.publicKey)).address;
    await retry(() => mintTo(conn, authority, usdtMint, traderUsdt, authority.publicKey, 250_000e6));
  }

  fs.writeFileSync(path.join(ROOT, IS_LOCAL ? ".localnet-state.json" : ".devnet-state.json"), JSON.stringify({
    rpc: RPC,
    programId: program.programId.toBase58(),
    usdcMint: usdcMint.toBase58(),
    usdtMint: usdtMint.toBase58(),
    pool: pool.toBase58(),
    usdcVault: usdcVault.toBase58(),
    lpMint: lpMint.toBase58(),
    lookupTable: lookupTable?.toBase58() ?? null,
    markets,
    lpUsdc: lpUsdc.toBase58(),
    lpLp: lpLp.toBase58(),
    traderUsdc: traderUsdc.toBase58(),
    traderLp: traderLp.toBase58(),
    liquidatorUsdc: liquidatorUsdc.toBase58(),
    keys: {
      authority: Array.from(authority.secretKey),
      lp: Array.from(lp.secretKey),
      trader: Array.from(trader.secretKey),
    },
  }, null, 2));

  console.log("bootstrapped: $10M pool liquidity, $250k account balance");
}

main().catch((e) => { console.error(e); process.exit(1); });
