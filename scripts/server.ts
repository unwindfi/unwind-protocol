/// Backend for the local unwind product.
///
/// Four jobs: post live prices into each market's oracle, serve the front-end,
/// run a liquidation keeper, and keep each market's session in step with the
/// trading calendar of the equity behind it.
///
/// Trading is owner-parameterised. A connected wallet gets unsigned transactions
/// from `/api/tx/*` and signs them itself; the server never holds its key. The
/// demo keypair in `.localnet-state.json` remains as a signed-server-side path,
/// because a browser wallet pointed at a throwaway localnet is a poor first
/// five minutes.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction, createCloseAccountInstruction,
  createMintToInstruction, createSyncNativeInstruction, getAccount, getAssociatedTokenAddressSync, mintTo,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Transaction, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { createLookupTable, extendLookupTable, loadLookupTable, sendV0 } from "./alt";
import express from "express";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { MARKETS, MarketDef } from "./markets";
import { Candle, LiveQuote, Session, fetchCandles, fetchQuotes, fetchSessions } from "./prices";
import { packInstructions, withComputeLimit } from "./pack";
import { mockPythProgram, postQuotes, priceAccountFor, relayKeypair } from "./mock-pyth";
import { METEORA_DLMM, RAYDIUM_CLMM, dlmmObserveAccounts, readPool } from "./clmm";
import { SOURCE_KIND } from "./pools";
import {
  BACKER_FEE_SHARE_BPS, DEPTH_LEVERAGE_TIERS, LISTING_LEVERAGE_CEILING_BPS, MIN_LISTING_BACKING_USD, MIN_OBSERVATIONS,
  MIN_OBSERVATION_WINDOW_SEC, listingLimits, unitLabel,
} from "./listing-policy";
import { GET as mainnetPoolPreview } from "../api/pool/[address]";
import { backingBookPda, baseUnits } from "./custodies";
import { readTokenMeta } from "./token-meta";

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT || 3000);

/// Which bootstrap to serve. `CLUSTER=devnet` picks the devnet pool; anything
/// else is the local validator.
const CLUSTER = process.env.CLUSTER ?? "localnet";
const STATE_FILE = CLUSTER === "localnet" ? ".localnet-state.json" : `.${CLUSTER}-state.json`;
const st = JSON.parse(fs.readFileSync(path.join(ROOT, STATE_FILE), "utf8"));
const IS_LOCAL = String(st.rpc).includes("127.0.0.1") || String(st.rpc).includes("localhost");

const BPS = 10_000;
/// How often the live source is polled and reposted on chain. Jupiter's quotes
/// move with the pools behind them, so polling faster than this mostly reposts
/// the same number.
// Jupiter's keyless lite endpoint allows roughly a request a second across all
// callers, and a 1s poll sat right on that ceiling — every 429 skips a post, and
// after `maxPriceAgeSec` of skips the program starts rejecting orders as stale.
// The markets tolerate 90s, so 4s is frequent enough with room to spare.
// A public RPC throttles and every price post costs a transaction, so the
// cadence off localnet is an order of magnitude slower. The markets tolerate
// 90s of staleness, which is what sets the ceiling.
const TICK_MS = Number(process.env.TICK_MS ?? (IS_LOCAL ? 4_000 : 20_000));
// The keeper scans every position and every order in the program — two
// `getProgramAccounts` calls, which a public RPC prices far above an ordinary
// read. Off localnet it runs on a much longer leash; the binding constraint is
// how long an underwater position may sit, not how fast the loop can spin.
/// How often every batch is checked for orders to clear. A batch is due five
/// seconds after it opens, so two seconds late at worst is still inside the
/// next window, and it halves what the crank costs against an RPC plan's
/// monthly request allowance.
/// How often the seeded testnet pools are moved to follow their real tokens.
/// A few calls each per pass; two minutes keeps that well inside an RPC plan.
const FLOW_MS = Number(process.env.FLOW_MS ?? 120_000);
const AUCTION_MS = Number(process.env.AUCTION_MS ?? (IS_LOCAL ? 1_000 : 2_000));
const KEEPER_MS = Number(process.env.KEEPER_MS ?? (IS_LOCAL ? 2_500 : 90_000));
const CRANK_MS = Number(process.env.CRANK_MS ?? (IS_LOCAL ? 20_000 : 300_000));
/// Trading calendars change a few times a day; checking every minute is ample.
const SESSION_MS = Number(process.env.SESSION_MS ?? (IS_LOCAL ? 60_000 : 600_000));
/// How often each observed market's pool is read and its price pushed.
///
/// The markets tolerate 90s of staleness, and this process is the only thing
/// moving a keeper-priced mark, so this has to sit well under that.
const OBSERVE_MS = Number(process.env.OBSERVE_MS ?? 25_000);
/// How often the chain is scanned for markets this process was not told about.
const DISCOVER_MS = Number(process.env.DISCOVER_MS ?? (IS_LOCAL ? 30_000 : 120_000));
/// How often referral and listing rewards are moved to who is owed them.
const REWARDS_MS = Number(process.env.REWARDS_MS ?? 60_000);
/// How long to keep trying for a first price before serving a degraded page.
const STARTUP_PRICE_WAIT_MS = 45_000;
/// Samples of sub-minute tape kept per market — several hours at `TICK_MS`.
/// The minute-and-up charts read real candles from the source instead.
const HISTORY = 4000;

/// Depth the observed confidence is measured against, and the band a pool of
/// exactly that size is quoted at. Both mirrored from the program: confidence
/// sets the spread, so a rounded copy of this arithmetic would show the page a
/// market the program would not actually quote.
const DEPTH_REF_USD = 10_000 * 1e6;
const DEPTH_CONF_REFERENCE_BPS = 50;

/*
 * The listing ceilings and the seasoning bounds come from `listing-policy.ts`,
 * which the listing page and the deployed preview read too. They used to be
 * copied here, and a copy is a preview that can quietly disagree with the
 * listing. Seasoning is only used to decide when a budget is worth deriving;
 * the program enforces both bounds regardless of what this process believes.
 */

const idl = JSON.parse(
  fs.readFileSync(path.join(ROOT, "target/idl/unwind.json"), "utf8"));

const kp = (a: number[]) => Keypair.fromSecretKey(Uint8Array.from(a));
const authority = kp(st.keys.authority);
const lp = kp(st.keys.lp);
const trader = kp(st.keys.trader);

/// A dedicated RPC for the testnet, without touching the state file: the
/// public devnet endpoint throttles a crank into missing batches.
const RPC_URL = process.env.RPC_URL || st.rpc;
const conn = new Connection(RPC_URL, "confirmed");
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(authority), {
  commitment: "confirmed",
});
const program: any = new Program(idl, provider);
const pyth = mockPythProgram(provider);
/// Who posts prices. On localnet anyone may; off it, only the relay key.
const poster = CLUSTER === "localnet" ? authority : relayKeypair();

const pool = new PublicKey(st.pool);
const usdcMint = new PublicKey(st.usdcMint);
const usdcVault = new PublicKey(st.usdcVault);
const lpMint = new PublicKey(st.lpMint);
const traderUsdc = new PublicKey(st.traderUsdc);
const traderLp = new PublicKey(st.traderLp);

const USD = (n: number) => new BN(Math.round(n * 1e6));
const num = (v: any) => (v == null ? 0 : Number(v.toString()));

interface MarketRt {
  /// Null for a market nobody wrote a definition for -- one somebody listed
  /// against a pool. Only the candle source needs it, and an observed market
  /// has none: its history is the tape this process keeps.
  def: MarketDef | null;
  symbol: string;
  name: string;
  color: string;
  mono: string;
  address: PublicKey;
  position: PublicKey;
  /// The one account this market is priced from. A Pyth `PriceUpdateV2` for a
  /// market with a feed, and the `Observation` for a market without one --
  /// `market_price` takes either in the same slot and decides which it expects
  /// from the market rather than from us, so nothing downstream branches.
  priceUpdate: PublicKey;
  /// Last reading the source served. Null only before the first poll lands.
  quote: LiveQuote | null;
  /// When the source last answered, for reporting how live the price is.
  lastFetch: number;
  /// When this process's own first tick landed. Everything in `history` before
  /// it is seeded minute data, which must not be served as sub-minute bars.
  liveFrom: number;
  /// Real 24h open, derived from the source's own 24h change.
  open: number;
  high: number;
  low: number;
  history: { t: number; p: number }[];
  session: Session;
  /// Rolling notional traded, for the 24h volume stat.
  volume: number;
  /// Set when the market is priced off a pool instead of a feed. Carries the
  /// readings behind its mark, which is what the listing page counts down.
  observed: {
    observation: PublicKey;
    source: PublicKey;
    readings: number;
    spanSec: number;
    seasoned: boolean;
    /// When this process last saw a reading land.
    lastReadMs: number;
    /// USD to move the source pool one percent -- the ceiling on what this
    /// market is ever allowed to cost the LPs.
    depthUsd: number;
    /// Which AMM the source is, as `SOURCE_KIND`, and whether its quote is
    /// token 0: a DLMM crank has to pass the pair's bin arrays, and which
    /// ones depends on the direction a rising price walks.
    sourceKind: number;
    quoteIsToken0: boolean;
    /// The mark is USD per `10^unitExp` tokens. Zero for anything priced a
    /// token at a time.
    unitExp: number;
  } | null;
}

/// Positions are per (market, owner), so every path that touches one has to be
/// told whose it is rather than assuming the demo account.
const positionPda = (market: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), owner.toBuffer()],
    program.programId
  )[0];

const ata = (owner: PublicKey, mint: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true);

const rt: Record<string, MarketRt> = {};
// Only what this pool actually has. The market list is the full catalogue; a
// bootstrap may have created a subset of it, and a cluster where accounts cost
// money usually has.
const LIVE = MARKETS.filter((d) => st.markets[d.symbol]);
if (LIVE.length !== MARKETS.length) {
  console.log(`serving ${LIVE.length} of ${MARKETS.length} markets: ` +
    LIVE.map((d) => d.symbol).join(", "));
}

const backingPda = (market: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("backing"), market.toBuffer(), owner.toBuffer()], program.programId)[0];

/*
 * The pool's custodies: the tokens besides USDC that backing is held in,
 * JLP-style, each in its own vault and priced by oracle. Read from the chain,
 * in index order, because that is the order every instruction wants them in.
 */
interface CustodyRt {
  index: number;
  symbol: "SOL" | "USDT";
  address: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  decimals: number;
  isStable: boolean;
  feedId: Buffer;
  /// The price account the program reads. A stable has none, and the program
  /// ignores whatever sits in its place, so the custody itself stands in
  /// rather than spending another key.
  priceAccount: PublicKey;
  /// Tokens the LPs hold, whole.
  lpAmount: number;
}
let custodies: CustodyRt[] = [];
/// USD per whole token, from the last tick. Stables are a dollar.
const custodyPrice: Record<string, number> = { USDT: 1 };

async function loadCustodies() {
  const all = await program.account.custody.all([
    { memcmp: { offset: 10, bytes: pool.toBase58() } },
  ]);
  custodies = all
    .map(({ publicKey, account: c }: any): CustodyRt => ({
      index: c.index,
      symbol: new PublicKey(c.mint).equals(NATIVE_MINT) ? "SOL" : "USDT",
      address: publicKey,
      mint: new PublicKey(c.mint),
      vault: new PublicKey(c.vault),
      decimals: c.decimals,
      isStable: c.isStable,
      feedId: Buffer.from(c.feedId),
      priceAccount: c.isStable ? publicKey : priceAccountFor(Buffer.from(c.feedId)),
      lpAmount: num(c.lpAmount) / 10 ** c.decimals,
    }))
    .sort((a: CustodyRt, b: CustodyRt) => a.index - b.index);
}

/// `(custody, price)` for every custody, as the backing instructions and the
/// AUM both take them.
const custodyPairs = (writable: boolean) =>
  custodies.flatMap((c) => [
    { pubkey: c.address, isWritable: writable, isSigner: false },
    { pubkey: c.priceAccount, isWritable: false, isSigner: false },
  ]);

/// Each market's backing held in kind, by custody symbol, in whole tokens.
/// Refreshed by the crank and after anything that moves it.
const books: Record<string, { amounts: Record<string, number>; reimbursedUsd: number }> = {};

async function loadBooks() {
  const all = await program.account.backingBook.all();
  for (const { account: b } of all as any[]) {
    const amounts: Record<string, number> = {};
    for (const c of custodies) amounts[c.symbol] = num(b.amounts[c.index]) / 10 ** c.decimals;
    books[new PublicKey(b.market).toBase58()] = {
      amounts, reimbursedUsd: num(b.reimbursedUsd) / 1e6,
    };
  }
}

/// USD value of a market's in-kind backing at the last prices.
const inKindUsd = (market: PublicKey) => {
  const b = books[market.toBase58()];
  if (!b) return 0;
  return Object.entries(b.amounts)
    .reduce((s, [sym, amt]) => s + amt * (custodyPrice[sym] ?? 0), 0);
};

/// What a market's whole backing pot is worth, in dollars: its USDC plus
/// everything held in kind.
const potUsd = (market: PublicKey, backingUsdRaw: any) =>
  num(backingUsdRaw) / 1e6 + inKindUsd(market);

/*
 * Reads a page polls, answered from memory where the chain has not moved.
 *
 * Every open page asks for its batch once a second and its account every
 * three. Read through to the RPC, two or three visitors were enough to put
 * the testnet past its plan's rate limit, and then the crank, the relay and
 * the pages all stalled together. The auction loop already reads every batch
 * every pass, so the batch endpoint serves that; an account is kept for a
 * moment and dropped whenever a transaction lands.
 */
const batchSeen = new Map<string, { state: any; at: number }>();
const BATCH_FRESH_MS = 3_000;
const accountMemo = new Map<string, { at: number; body: Promise<any> }>();
const ACCOUNT_FRESH_MS = 2_500;

const observationPda = (market: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("observation"), market.toBuffer()], program.programId)[0];

/// A market's on-chain symbol, which is sixteen bytes and rarely sixteen
/// characters.
const symbolOf = (bytes: number[] | Buffer): string =>
  Buffer.from(bytes).toString("utf8").replace(/\0+$/, "").trim();

/// A stable badge colour for a market nobody designed one for.
///
/// Derived from the symbol so it survives restarts and is the same in every
/// client -- a listed market that changed colour on refresh would look broken
/// in exactly the place the product is asking to be trusted.
function paletteFor(symbol: string) {
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) % 360;
  return { color: `hsl(${h} 42% 42%)`, mono: symbol[0]?.toUpperCase() ?? "?" };
}

function register(def: MarketDef | null, symbol: string, address: PublicKey,
                  priceUpdate: PublicKey, observed: MarketRt["observed"]) {
  const pal = paletteFor(symbol);
  rt[symbol] = {
    def,
    symbol,
    name: def?.name ?? symbol,
    color: def?.color ?? pal.color,
    mono: def?.mono ?? pal.mono,
    address,
    position: positionPda(address, trader.publicKey),
    priceUpdate,
    quote: null,
    lastFetch: 0,
    liveFrom: 0,
    open: 0,
    high: 0,
    low: 0,
    history: [],
    session: Session.Regular,
    volume: 0,
    observed,
  };
}

for (const def of LIVE) {
  const address = new PublicKey(st.markets[def.symbol].market);
  register(def, def.symbol, address,
    priceAccountFor(Buffer.from(def.feedId, "hex")), null);
}

/// Picks up markets this process was never told about.
///
/// The catalogue in `markets.ts` is what *we* listed. Listing is a signed
/// transaction anyone can send, so it cannot be the whole set, and a market
/// that only appears after a restart is a market the lister watches fail. The
/// scan is a `getProgramAccounts` and therefore not cheap, which is why it
/// runs on its own slow loop rather than inside the price tick.
async function discoverMarkets() {
  // This pool's markets only, filtered on-chain. On a cluster the program has
  // been deployed to before, an unfiltered scan also returns markets from
  // older pools in older layouts, and one that fails to decode sinks the scan.
  const all = await program.account.market.all([
    { memcmp: { offset: 9, bytes: pool.toBase58() } },
  ]);
  for (const { publicKey, account } of all) {
    const symbol = symbolOf(account.symbol);
    if (!symbol || rt[symbol]) continue;

    // Priced off a feed but absent from the catalogue: we have no name, no
    // calendar and no candle source for it, and inventing them is worse than
    // leaving it out. An observed market needs none of those.
    const observed = account.priceSource === 1;
    if (!observed) continue;

    const observation = observationPda(publicKey);
    const o: any = await program.account.observation.fetchNullable(observation);
    // Listed, but not yet pointed at a pool. The listing transaction creates
    // both at once, so this is a half-finished market rather than a state the
    // product produces -- pick it up whenever the second half lands.
    if (!o) continue;

    register(null, symbol, publicKey, observation, {
      observation,
      source: new PublicKey(o.source),
      readings: 0, spanSec: 0, seasoned: false, depthUsd: 0, lastReadMs: 0,
      sourceKind: o.sourceKind, quoteIsToken0: o.quoteIsToken0, unitExp: o.unitExp ?? 0,
    });
    // Through the same path a crank would take, rather than filling the fields
    // in here. A market discovered after a restart is fully seasoned more often
    // than not, and registering it as unseasoned with no price made every one
    // of them report "Seasoning 795/30" until the next observe landed.
    publish(publicKey, o);
    console.log(`discovered ${symbol} ${publicKey.toBase58().slice(0, 8)} (observed)`);
  }
}

const px = (m: MarketRt) => m.quote?.price ?? 0;
const oracleOf = (m: MarketRt) => m.priceUpdate;

/// Real OHLC from the source, cached per timeframe.
///
/// Only the minute-and-up timeframes have a source; below that the chart fills
/// from live ticks. The old build warmed every timeframe up by running four
/// thousand steps of a random walk before serving, which is exactly the kind of
/// invented data this replaced.
const SEED_TTL_MS = 60_000;
const seeds: Record<string, { at: number; bars: Candle[] }> = {};

async function seedBars(m: MarketRt, tf: number): Promise<Candle[]> {
  const key = `${m.symbol}:${tf}`;
  const hit = seeds[key];
  if (hit && Date.now() - hit.at < SEED_TTL_MS) return hit.bars;
  // Stale but present: answer with it now and refresh behind the answer, so
  // a chart never waits on the candle source once it has been read once.
  if (hit) {
    if (!refreshing.has(key)) {
      refreshing.add(key);
      void fetchSeed(m, tf, key).finally(() => refreshing.delete(key));
    }
    return hit.bars;
  }
  return fetchSeed(m, tf, key);
}

const refreshing = new Set<string>();
async function fetchSeed(m: MarketRt, tf: number, key: string): Promise<Candle[]> {
  const hit = seeds[key];
  // A market listed against a pool has no candle source at all. Its chart is
  // the tape this process keeps, and an empty seed is what says so -- inventing
  // bars for it would be inventing the history the mark deliberately lacks.
  if (!m.def) return [];
  try {
    const bars = await fetchCandles(m.def, tf);
    seeds[key] = { at: Date.now(), bars };
    return bars;
  } catch (e: any) {
    console.warn(`candles ${m.symbol}@${tf}s: ${e.message}`);
    return hit?.bars ?? [];
  }
}

/// Two hours of minute closes for the ticker list's inline chart, straight off
/// the cached seed so it costs no extra request.
function sparklineFor(m: MarketRt): number[] {
  const bars = seeds[`${m.symbol}:60`]?.bars ?? [];
  if (bars.length) return bars.slice(-120).map((c) => c.close);
  return m.history.slice(-120).map((h) => h.p);
}

/// Polls the source and posts what it says on chain.
///
/// The price the UI shows and the price the program liquidates against are the
/// same number by construction: the server reads it back off the account it
/// just wrote, so a post that fails leaves the previous price standing for both
/// rather than letting the display drift away from the chain.
let lastPostError = "";
/// Set when the source rate-limits us, so a 429 does not become a hot loop that
/// keeps us limited. Doubles per consecutive rejection, up to a minute.
let backoffUntil = 0;
let backoffMs = TICK_MS;

/// Custodies priced by a feed, as quote definitions: the same source and the
/// same poster as the markets, so SOL backing is valued off a price exactly
/// as fresh as everything else.
const custodyFeeds = (): MarketDef[] =>
  custodies.filter((c) => !c.isStable).map((c) => ({
    symbol: `custody:${c.symbol}`, name: c.symbol, mint: c.mint.toBase58(),
    feedId: c.feedId.toString("hex"),
  }) as MarketDef);

async function tick() {
  if (Date.now() < backoffUntil) return;

  let quotes: Record<string, LiveQuote>;
  try {
    quotes = await fetchQuotes([...LIVE, ...custodyFeeds()]);
    backoffMs = TICK_MS;
  } catch (e: any) {
    lastPostError = `source: ${e.message}`;
    if (/\b429\b/.test(e.message ?? "")) {
      backoffMs = Math.min(60_000, backoffMs * 2);
      backoffUntil = Date.now() + backoffMs;
      console.warn(`rate limited; backing off ${backoffMs / 1000}s`);
    }
    return;
  }

  try {
    await postQuotes(pyth, poster, quotes, [...LIVE, ...custodyFeeds()]);
    for (const c of custodies) {
      const q = quotes[`custody:${c.symbol}`];
      if (q) custodyPrice[c.symbol] = q.price;
    }
    lastPostError = "";
  } catch (e: any) {
    // The price stays where it was. If the outage outlasts `max_price_age_sec`
    // the program starts rejecting trades on its own, which is the correct
    // outcome and not something this loop should paper over.
    lastPostError = `post: ${explain(e)}`;
    return;
  }

  const now = Date.now();
  for (const m of Object.values(rt)) {
    const q = quotes[m.symbol];
    if (!q) continue;
    m.quote = q;
    m.lastFetch = now;
    if (!m.liveFrom) m.liveFrom = now;
    m.open = q.change24h !== 0 ? q.price / (1 + q.change24h) : m.open || q.price;
    m.high = Math.max(m.high || q.price, q.price);
    m.low = Math.min(m.low || q.price, q.price);
    // Every poll is recorded, including the ones that came back unchanged. A
    // thin market can sit on the same price for minutes, and dropping those
    // samples leaves the sub-minute chart with no bars at all rather than the
    // flat stretch that actually happened.
    m.history.push({ t: now, p: q.price });
    if (m.history.length > HISTORY) m.history.shift();
  }
}

/// Seeds the tape and the 24h range from real history, so the chart and the
/// header stats are populated on the first paint rather than after an hour of
/// watching.
async function warmUp() {
  await Promise.all(
    Object.values(rt).map(async (m) => {
      const [minutes, quarters] = await Promise.all([
        seedBars(m, 60),
        seedBars(m, 900),
      ]);
      m.history = minutes.map((c) => ({ t: c.time * 1000, p: c.close }));
      const day = quarters.filter((c) => c.time * 1000 >= Date.now() - 86_400_000);
      if (day.length) {
        m.high = Math.max(...day.map((c) => c.high));
        m.low = Math.min(...day.map((c) => c.low));
      }
    })
  );
}

/// Keeps each market's `Session` in step with its underlying equity's calendar.
async function syncSessions() {
  let sessions: Record<string, Session>;
  try {
    sessions = await fetchSessions(LIVE);
  } catch (e: any) {
    console.warn(`sessions: ${e.message}`);
    return;
  }
  for (const m of Object.values(rt)) {
    // An observed market tracks a token, not an exchange listing. There is no
    // calendar to be in step with, so it stays open.
    if (!m.def) continue;
    const want = sessions[m.symbol];
    if (want === undefined || want === m.session) continue;
    try {
      await program.methods
        .setSession(want)
        .accounts({ authority: authority.publicKey, pool, market: m.address })
        .rpc();
      m.session = want;
      console.log(`${m.symbol} session -> ${Session[want]}`);
      // A calendar change moves every market at once, so off localnet these go
      // out spaced rather than as a burst of twelve transactions.
      if (!IS_LOCAL) await new Promise((r) => setTimeout(r, 1_500));
    } catch (e) {
      console.warn(`${m.symbol} session: ${explain(e)}`);
    }
  }
}

/// A market account read at most once a second. The account view, trader
/// PnL and positions each read every market, and a page polls them all, so
/// the same account was fetched from the RPC several times a second.
const marketReads = new Map<string, { at: number; body: Promise<any> }>();
async function marketAccount(m: MarketRt) {
  const key = m.address.toBase58();
  const hit = marketReads.get(key);
  if (hit && Date.now() - hit.at < 1_000) return hit.body;
  const body = program.account.market.fetch(m.address);
  marketReads.set(key, { at: Date.now(), body });
  body.catch(() => marketReads.delete(key));
  return body;
}

/// The pool account, on the same one-second terms.
let poolRead: { at: number; body: Promise<any> } | null = null;
function poolAccount() {
  if (poolRead && Date.now() - poolRead.at < 1_000) return poolRead.body;
  const body = program.account.pool.fetch(pool);
  poolRead = { at: Date.now(), body };
  body.catch(() => { poolRead = null; });
  return body;
}

/// Mirrors `Market::spread_bps` / `fill_price`.
///
/// The confidence is the live one, not a constant: with real quotes it moves
/// between a couple of basis points and tens of them, and a hardcoded figure
/// here would quote the page a spread the program would not actually charge.
/// The integer truncation matches `conf_bps()` and the on-chain division, so
/// the number shown is the number the fill uses.
function quote(ma: any, m: MarketRt) {
  const price = px(m);
  const confBps = Math.floor(m.quote?.confBps ?? 0);
  const spreadBps = Math.min(
    ma.baseSpreadBps + Math.floor((confBps * ma.confSpreadMultBps) / BPS),
    ma.maxSpreadBps
  );
  return { spreadBps, bid: price * (1 - spreadBps / BPS), ask: price * (1 + spreadBps / BPS) };
}

/// Risk parameters a market gets when somebody lists it from the site.
///
/// Fixed rather than offered, because the thing a lister is actually choosing
/// is the pool, and everything dangerous about the market follows from that
/// one choice. The open-interest caps are the exception: they are read off the
/// pool's own depth, so a market on a shallow pool comes out small without
/// anyone having to decide that it should.
///
/// What is deliberately absent is the loss budget. `add_market` sets it to
/// zero and only the pool's authority can raise it, so a market listed this
/// way can be observed, quoted and watched but cannot open a position until
/// somebody whose capital is at risk agrees to underwrite it. That separation
/// is the reason listing itself can be open to anyone.
/// The most a listing may ask for is `listingLimits` in `listing-policy.ts`:
/// leverage is a flat ceiling for anything priced off an AMM, and size is the
/// pool's depth, up to a hard cap.

/*
 * What a market is listed with, and what its lister may change.
 *
 * The lister chooses leverage and size, but only downward from what the pool
 * supports: the ceilings below are the same figures the preview reports, and
 * anything asked for above them is quietly held at them rather than rejected,
 * so a slider dragged to the end simply means "the most this pool allows".
 *
 * None of this is where the LPs are protected. `add_market` pins the loss
 * budget at zero whatever is passed here, and only backing and
 * `derive_market_budget` -- which caps at depth on chain -- ever raise it. A
 * lister who went round this server and asked the program for 9x on a thin
 * pool would get a market nobody can lose the LPs' money on. These clamps
 * exist to keep the listing honest, not to keep it safe.
 */
/*
 * A listing's ticker is the token's own, not something typed.
 *
 * It used to be a free-text field, which meant anybody could list a pool of
 * anything and call it anything. Reading it from the base mint's metadata
 * does not make the name trustworthy -- metadata is whatever its authority
 * wrote -- but it makes it the token's claim rather than the lister's, and
 * the market still carries the mint address, which is the part that is.
 *
 * Cleaned to what a ticker can hold: `$WIF` is `WIF`. When the chain has no
 * name for it (a localnet with no metadata accounts loaded, or a token that
 * never wrote any) the known mints below answer, and failing that the first
 * characters of the mint do. When the name is already taken the pool's own
 * address breaks the tie, which is deterministic, so the preview and the
 * listing always agree on it.
 */
/// The testnet's own pools (scripts/seed-devnet-pools.ts): made-up tokens
/// with no metadata account, named here instead.
const seeded: { symbol: string; name: string; mint: string; pair: string }[] = st.seededPools ?? [];

const KNOWN_TOKENS: Record<string, { symbol: string; name: string }> = {
  So11111111111111111111111111111111111111112: { symbol: "SOL", name: "Wrapped SOL" },
};

/// A market quoted per `10^unitExp` tokens carries the unit in its name, the
/// way exchanges list 1000BONK: `1MBONK` is priced per million, and a ticker
/// that said `BONK` over a price of $3.81 would be lying about what it marks.
async function listingName(base: string, poolAddress: string, unitExp = 0) {
  const meta = await readTokenMeta(conn, new PublicKey(base));
  const known = KNOWN_TOKENS[base] ?? seeded.find((s) => s.mint === base);
  const clean = (meta.symbol ?? known?.symbol ?? "").replace(/[^A-Za-z0-9._-]/g, "");
  let symbol = (unitLabel(unitExp) + (clean || base.slice(0, 4))).slice(0, 16);
  if (rt[symbol]) symbol = `${symbol.slice(0, 11)}-${poolAddress.slice(0, 4).toUpperCase()}`;
  return { symbol, name: meta.name ?? known?.name ?? symbol };
}

function listingParams(depthUsd: number, choice: { leverageBps?: number; oiUsd?: number } = {}) {
  const limits = listingLimits(depthUsd, {
    leverage: Number.isFinite(choice.leverageBps) ? choice.leverageBps! / BPS : undefined,
    oiUsd: choice.oiUsd,
  });
  const leverageBps = Math.min(Math.round(limits.leverage * BPS), LISTING_LEVERAGE_CEILING_BPS);
  const cap = USD(limits.oiUsd);
  return {
    maxPriceAgeSec: 120,
    // Wide, because a confidence derived from pool depth is wide. A ceiling
    // tight enough for a Pyth feed would halt this market permanently.
    maxConfBps: 5_000,
    maxLeverageBps: leverageBps,
    maintenanceMarginBps: 1_000,
    liquidationFeeBps: 100,
    openFeeBps: 10,
    closeFeeBps: 10,
    minPositionUsd: USD(10),
    maxOiLongUsd: cap,
    maxOiShortUsd: cap,
    pnlReserveBps: 10_000,
    baseSpreadBps: 20,
    confSpreadMultBps: 10_000,
    maxSpreadBps: 2_000,
    // No exchange behind it, so there is no closed session to tighten into.
    closedSessionLeverageBps: leverageBps,
    closedSessionOiMultBps: 10_000,
    maxFundingRateBpsPerHour: 100,
    fundingKBps: 8_000,
    borrowRateBpsPerHour: 1,
  };
}

/// Mirrors `Observation::conf_usd`, truncation included.
///
/// Confidence is the fraction of the reference size the pool cannot absorb: a
/// pool deep enough to take it without moving quotes near zero, a pool a tenth
/// that size quotes ten times the band. Unmeasured depth reads as no depth,
/// which halts the market rather than quoting into the dark.
function observedConfBps(o: any): number {
  const depth = num(o.depthUsd);
  if (depth === 0) return BPS;
  const ratio = Math.floor((DEPTH_REF_USD * BPS) / depth);
  return Math.min(BPS, Math.floor((ratio * DEPTH_CONF_REFERENCE_BPS) / BPS));
}

function describePosition(pos: any, ma: any, m: MarketRt) {
  const price = px(m);
  const size = num(pos.sizeUsd) / 1e6;
  if (size === 0) return null;
  const collateral = num(pos.collateralUsd) / 1e6;
  const factorNow = Number(ma.priceFactor.toString());
  const factorAt = Number(pos.entryPriceFactor.toString());
  const entry = (num(pos.entryPrice) / 1e6) * (factorAt > 0 ? factorNow / factorAt : 1);
  const q = quote(ma, m);
  const exit = pos.isLong ? q.bid : q.ask;
  const pnl = entry > 0 ? size * ((exit - entry) / entry) * (pos.isLong ? 1 : -1) : 0;
  const idx = pos.isLong ? ma.cumulativeLongFunding : ma.cumulativeShortFunding;
  const funding =
    ((Number(idx.toString()) - Number(pos.entryFunding.toString())) * num(pos.sizeUsd)) /
    1e12 / 1e6;
  const equity = Math.max(0, collateral + pnl - funding);
  const maintenance = (size * ma.maintenanceMarginBps) / BPS;

  // Price at which equity falls to the maintenance requirement, solved from
  // equity = collateral + size*(P-entry)/entry*dir - funding.
  const move = (maintenance - collateral + funding) / size;
  const liqPrice = pos.isLong ? entry * (1 + move) : entry * (1 - move);

  return {
    isLong: pos.isLong, size, collateral, entry, mark: exit,
    leverage: collateral > 0 ? size / collateral : 0,
    pnl, funding, equity, maintenance,
    pnlPct: collateral > 0 ? (pnl / collateral) * 100 : 0,
    liqPrice: liqPrice > 0 ? liqPrice : 0,
    liquidatable: equity < maintenance,
  };
}

async function loadPositions(owner: PublicKey) {
  const out: Record<string, any> = {};
  const infos = await conn.getMultipleAccountsInfo(
    Object.values(rt).map((m) => positionPda(m.address, owner)));
  await Promise.all(
    Object.values(rt).map(async (m, i) => {
      if (!infos[i]) return;
      const pos = program.coder.accounts.decode("position", infos[i]!.data);
      const d = describePosition(pos, await marketAccount(m), m);
      if (d) out[m.symbol] = d;
    })
  );
  return out;
}

/// Every liquidity instruction must see all markets, so the pool's liability is
/// priced in full.
/// The table the liquidity instructions compress their accounts through.
///
/// A deposit or withdrawal carries two accounts for every market with open
/// interest, and past about eight of them a plain transaction no longer fits.
/// Markets are listed by anyone, so a table made once at bootstrap goes stale;
/// the server owns this one, creates it on first need, and adds any account a
/// liquidity transaction is about to use that it does not hold yet. Its address
/// is kept in .cache, which a deploy carries over.
let lookupTable: AddressLookupTableAccount | null = null;
const TABLE_FILE = path.join(ROOT, ".cache", `${CLUSTER}-lookup-table.json`);
let tableWork: Promise<unknown> = Promise.resolve();

async function tablesFor(accounts: { pubkey: PublicKey }[]): Promise<AddressLookupTableAccount[]> {
  const run = tableWork.then(async () => {
    const have = new Set((lookupTable?.state.addresses ?? []).map((a) => a.toBase58()));
    const missing = [...new Set(accounts.map((a) => a.pubkey.toBase58()))]
      .filter((k) => !have.has(k)).map((k) => new PublicKey(k));
    if (!missing.length) return;
    let key = lookupTable?.key;
    if (key) {
      await extendLookupTable(conn, authority, key, missing);
    } else {
      key = await createLookupTable(conn, authority, missing);
      fs.mkdirSync(path.dirname(TABLE_FILE), { recursive: true });
      fs.writeFileSync(TABLE_FILE, JSON.stringify({ address: key.toBase58() }));
      console.log(`lookup table ${key.toBase58()} created`);
    }
    lookupTable = await loadLookupTable(conn, key);
  });
  tableWork = run.catch(() => {});
  // A table that cannot be made or grown is not fatal: with few markets the
  // transaction fits without it, and with many the wallet says it is too large.
  await run.catch((e) => console.warn(`lookup table: ${explain(e)}`));
  return lookupTable ? [lookupTable] : [];
}

/// Then every custody, because tokens the LPs hold in kind are part of what
/// their shares are worth.
/// The accounts a deposit or withdrawal prices against: every market somebody
/// holds a position in, then every custody. Only those markets, and all of
/// them -- the program counts them (`Pool::markets_with_oi`) and refuses a list
/// that is short or padded with empty ones. Read fresh each time, because a
/// position opened a second ago changes the answer.
async function allMarketAccounts() {
  const listed: any[] = await program.account.market.all([
    { memcmp: { offset: 9, bytes: pool.toBase58() } },
  ]);
  const pairs = [];
  for (const { publicKey, account } of listed) {
    if (account.longSizeUsd.isZero() && account.shortSizeUsd.isZero()) continue;
    const m = Object.values(rt).find((r) => r.address.equals(publicKey));
    if (!m) throw new Error(`market ${publicKey.toBase58()} has open interest but no known price account`);
    pairs.push(
      { pubkey: m.address, isWritable: false, isSigner: false },
      { pubkey: oracleOf(m), isWritable: false, isSigner: false },
    );
  }
  return [...pairs, ...custodyPairs(false)];
}

const batchPda = (market: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("batch"), market.toBuffer()], program.programId)[0];

/// The hourly funding each side pays at the current open interest and pool
/// utilization, mirroring `Market::accrue_funding`: both sides pay a borrow
/// rate scaled by utilization, the heavier side pays a skew rate capped at the
/// market's maximum, and the lighter side receives that payment spread over
/// its smaller size. Positive is paid, negative received, both in bps an hour.
function fundingRates(ma: any, longSize: number, shortSize: number, utilizationBps: number) {
  const borrow = (ma.borrowRateBpsPerHour * utilizationBps) / 10_000;
  let long = borrow, short = borrow;
  const total = longSize + shortSize;
  if (longSize > 0 && shortSize > 0) {
    const longsHeavy = longSize >= shortSize;
    const heavy = longsHeavy ? longSize : shortSize;
    const light = longsHeavy ? shortSize : longSize;
    const skewBps = ((heavy - light) * 10_000) / total;
    const rate = Math.min((ma.fundingKBps * skewBps) / 10_000, ma.maxFundingRateBpsPerHour);
    const recv = (rate * heavy) / light;
    if (longsHeavy) { long += rate; short -= recv; } else { short += rate; long -= recv; }
  }
  return { fundingRateLongBps: long, fundingRateShortBps: short };
}

/// Accounts for putting an order into a market's collecting batch.
const orderAccounts = (m: MarketRt, owner: PublicKey) => ({
  owner,
  pool, market: m.address, batch: batchPda(m.address),
  usdcMint, usdcVault, ownerUsdc: ata(owner, usdcMint),
  position: positionPda(m.address, owner),
  tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
});

/// The limit to send for an order the trader asked to fill "at market".
///
/// There is no market order any more — every order is a limit into a batch and
/// fills at whatever that batch crosses at. So a market order becomes a limit
/// placed far enough through the index to cross whatever the batch finds,
/// which is the same intent expressed in the only terms the program has. The
/// tolerance is the trader's slippage budget, not a prediction.
const BATCH_INTERVAL_SEC = 5;
const MARKET_ORDER_TOLERANCE_BPS = 100; // 1%
const marketLimit = (m: MarketRt, isLong: boolean) => {
  const p = px(m);
  return isLong
    ? p * (1 + MARKET_ORDER_TOLERANCE_BPS / 10_000)
    : p * (1 - MARKET_ORDER_TOLERANCE_BPS / 10_000);
};

/// Reads back how much of a position is not already promised to a resting
/// closing order, so "close all" means what is left rather than what the
/// screen last showed.
const closableUsd = async (m: MarketRt, owner: PublicKey) => {
  const info = await conn.getAccountInfo(positionPda(m.address, owner));
  if (!info) return null;
  const p = program.coder.accounts.decode("position", info.data);
  const open = num(p.sizeUsd) - num(p.closingUsd);
  return open <= 0 ? null : { isLong: p.isLong as boolean, usd: open / 1e6 };
};

/// A wallet's referral and points record. Named for what it holds, because
/// `trader` is already the demo keypair.
const traderPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("trader"), owner.toBuffer()], program.programId)[0];

/// A referral code as the program stores it: 16 bytes, zero-padded.
const CODE_RE = /^[a-z0-9_-]{3,16}$/;
const codeBytes = (code: string) =>
  Array.from(Buffer.concat([Buffer.from(code), Buffer.alloc(16)]).subarray(0, 16));
const codeText = (bytes: number[]) =>
  Buffer.from(bytes).toString("utf8").replace(/\0+$/, "");
const referralCodePda = (code: string) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("referral_code"), Buffer.from(codeBytes(code))], program.programId)[0];

/// The instruction that names `code`'s holder as `owner`'s referrer, or none
/// when it would be refused: no such code, the wallet's own code, or a wallet
/// that already has a referrer or has already traded. A bad or stale `?ref=`
/// must never stop the order it rides along with.
async function referrerIx(owner: PublicKey, code: unknown) {
  const c = String(code ?? "").toLowerCase();
  if (!CODE_RE.test(c)) return [];
  const rc: any = await program.account.referralCode.fetchNullable(referralCodePda(c));
  if (!rc || rc.owner.equals(owner)) return [];
  const t: any = await program.account.trader.fetchNullable(traderPda(owner));
  if (t && (!t.referrer.equals(PublicKey.default) || num(t.volumeUsd) > 0)) return [];
  return [await program.methods.setReferrer(codeBytes(c))
    .accounts({
      owner, trader: traderPda(owner), referralCode: referralCodePda(c),
      referrerTrader: traderPda(rc.owner), systemProgram: SystemProgram.programId,
    })
    .instruction()];
}

/// Points a stake has earned since it was last brought up to date, so the
/// page shows a figure that moves rather than one that jumps at each sync.
/// Mirrors `stake_points` in the program.
const pendingStakePoints = (usd: number, perDay: number, since: number, now: number) =>
  since > 0 && now > since ? (usd * perDay * (now - since)) / 86_400 : 0;

const liquidityAccounts = (owner: PublicKey) => ({
  owner, pool, usdcMint, usdcVault, lpMint,
  ownerUsdc: ata(owner, usdcMint), ownerLp: ata(owner, lpMint),
  tokenProgram: TOKEN_PROGRAM_ID,
});

/// Parses `owner` from a request, falling back to the demo account.
function ownerOf(req: any): PublicKey {
  const raw = req.query?.owner ?? req.body?.owner;
  if (!raw) return trader.publicKey;
  try { return new PublicKey(String(raw)); }
  catch { throw new Error(`not a public key: ${raw}`); }
}

function explain(e: any): string {
  const s = e?.toString?.() ?? String(e);
  const m = s.match(/Error Message: ([^.]+)\./) || s.match(/Error Code: (\w+)/);
  // A plain `throw new Error("...")` stringifies with its class in front, and
  // the page prints whatever comes back verbatim. The prefix is noise to a
  // reader who was told to paste a pool address.
  return (m ? m[1] : s.split("\n")[0]).replace(/^Error:\s*/, "");
}

/// Liquidation keeper. A venue with no keeper is not a venue: without this,
/// underwater positions would sit there until the trader chose to close.
const liquidations: any[] = [];
/// Positions closed because their profit outgrew the pool's reserve, kept
/// separate from liquidations: one is the trader running out of margin, the
/// other is the pool running out of room, and conflating them would hide which.
const deleverages: any[] = [];
/// Take-profits and stops that fired, so the trader can see what closed them.
const orderFills: any[] = [];
/// Fill tape. Only this account trades on a local validator, so it is sparse —
/// but every entry is a real settled transaction, not a simulated print.
const trades: any[] = [];
/// Fills by wallet, for the portfolio page. The shared tape above is cut at
/// 120 across every market, which one busy wallet would push everyone else
/// out of. Held in memory like the tape, so a restart starts it again.
const fillsByOwner = new Map<string, any[]>();
function recordTrade({ owner, ...t }: any) {
  trades.unshift({ t: Date.now(), ...t });
  trades.splice(120);
  if (owner) {
    const mine = fillsByOwner.get(owner) ?? [];
    mine.unshift({ t: Date.now(), ...t });
    mine.splice(50);
    fillsByOwner.set(owner, mine);
  }
  const m = rt[t.symbol];
  if (m) m.volume += t.size;
}
/// Scans every open position in the program, not just one account's.
///
/// The keeper used to check the demo account's twelve PDAs. That was fine while
/// one keypair traded; with wallets connecting it would leave every other
/// trader's position unliquidated, which is the one job a keeper has.
async function keeper() {
  let accounts: { pubkey: PublicKey; account: { data: Buffer } }[];
  try {
    accounts = (await program.account.position.all()) as never;
  } catch (e: any) {
    console.warn(`keeper scan: ${e.message}`);
    return;
  }

  const byMarket = new Map<string, MarketRt>();
  for (const m of Object.values(rt)) byMarket.set(m.address.toBase58(), m);

  for (const entry of accounts as any[]) {
    const pos = entry.account;
    if (num(pos.sizeUsd) === 0) continue;
    const m = byMarket.get(String(pos.market));
    if (!m) continue;

    try {
      const d = describePosition(pos, await marketAccount(m), m);
      if (!d?.liquidatable) continue;

      const owner = new PublicKey(String(pos.owner));
      await program.methods.liquidate().accounts({
        liquidator: authority.publicKey,
        pool, market: m.address, position: entry.publicKey,
        owner,
        priceUpdate: oracleOf(m),
        usdcMint, usdcVault, ownerUsdc: ata(owner, usdcMint),
        liquidatorUsdc: new PublicKey(st.liquidatorUsdc),
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

      liquidations.unshift({
        t: Date.now(), symbol: m.symbol, isLong: d.isLong,
        size: d.size, price: px(m), returned: d.equity,
        owner: owner.toBase58(),
      });
      liquidations.splice(20);
      recordTrade({
        symbol: m.symbol, side: d.isLong ? "sell" : "buy",
        size: d.size, price: px(m), kind: "liquidation", owner: owner.toBase58(),
      });
      console.log(`liquidated ${m.symbol} (${owner.toBase58().slice(0, 4)}…) at ${px(m)}`);
      continue;
    } catch {
      /* raced to close, or already gone */
    }

    // A position can be healthy and still be a problem: profit past the
    // liquidity reserved against it is exposure the pool never set aside for.
    // Closing it at the mark while the pool can pay is the point of ADL, so the
    // keeper has to look for it on the same pass.
    try {
      const owner = new PublicKey(String(pos.owner));
      await program.methods.autoDeleverage().accounts({
        keeper: authority.publicKey,
        pool, market: m.address, position: entry.publicKey, owner,
        priceUpdate: oracleOf(m),
        usdcMint, usdcVault, ownerUsdc: ata(owner, usdcMint),
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

      deleverages.unshift({
        t: Date.now(), symbol: m.symbol, owner: owner.toBase58(),
        size: num(pos.sizeUsd) / 1e6, price: px(m),
      });
      deleverages.splice(20);
      console.log(`deleveraged ${m.symbol} (${owner.toBase58().slice(0, 4)}…) at ${px(m)}`);
    } catch {
      /* still covered by its reserve, which is the normal case */
    }
  }
}

/// Fires any order whose trigger the index has reached.
///
/// Scans every order in the program rather than one account's, for the same
/// reason the liquidation pass does: an order nobody executes is not an order.
async function orderKeeper() {
  let all: any[];
  try {
    all = (await program.account.order.all()) as never;
  } catch (e: any) {
    console.warn(`order scan: ${e.message}`);
    return;
  }

  const byMarket = new Map<string, MarketRt>();
  for (const m of Object.values(rt)) byMarket.set(m.address.toBase58(), m);

  for (const entry of all as any[]) {
    const o = entry.account;
    const m = byMarket.get(String(o.market));
    if (!m || !m.quote) continue;

    const trigger = num(o.triggerPrice) / 1e6;
    const price = px(m);
    const hit = o.triggerAbove ? price >= trigger : price <= trigger;
    const expired = num(o.expiryTs) !== 0 && Date.now() / 1000 >= num(o.expiryTs);
    if (!hit && !expired) continue;

    try {
      const owner = new PublicKey(String(o.owner));
      await program.methods.executeOrder().accounts({
        keeper: authority.publicKey,
        pool, market: m.address, order: entry.publicKey,
        position: positionPda(m.address, owner),
        owner,
        priceUpdate: oracleOf(m),
        batch: batchPda(m.address),
        usdcMint, usdcVault, ownerUsdc: ata(owner, usdcMint),
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

      orderFills.unshift({
        t: Date.now(), symbol: m.symbol, owner: owner.toBase58(),
        trigger, price, above: o.triggerAbove, expired,
      });
      orderFills.splice(20);
      console.log(
        `${expired ? "expired" : "filled"} order ${m.symbol} ` +
        `(${owner.toBase58().slice(0, 4)}…) trigger ${trigger} at ${price}`);
    } catch (e: any) {
      // A trigger that is reached but will not execute is worth knowing about:
      // the trader is watching an order that looks live and is not.
      console.warn(`order ${m.symbol} (${String(o.owner).slice(0, 4)}…): ${explain(e)}`);
    }
  }
}

/// Keeps the funding index moving when nobody is trading.
async function crank() {
  for (const m of Object.values(rt)) {
    try {
      await program.methods.accrueFunding()
        .accounts({ pool, market: m.address }).rpc();
    } catch {}
  }
  await syncBackings();
}

/// Pays the LPs in kind for losses they covered past a market's USDC backing,
/// and trims budgets to what in-kind backing is still worth. Only a market
/// holding something in kind, or owed something back, needs it.
async function syncBackings() {
  try {
    await loadCustodies();
    await loadBooks();
  } catch { return; }
  for (const m of Object.values(rt)) {
    const b = books[m.address.toBase58()];
    if (!b || (inKindUsd(m.address) === 0 && b.reimbursedUsd === 0)) continue;
    try {
      await program.methods.syncBacking()
        .accounts({ pool, market: m.address, book: backingBookPda(program.programId, m.address) })
        .remainingAccounts(custodyPairs(true))
        .rpc();
    } catch (e: any) { console.warn(`sync backing ${m.symbol}: ${explain(e)}`); }
  }
  try { await loadBooks(); } catch {}
}

/// Prices every observed market: reads its pool here and pushes the price.
///
/// This process is the pool's mark keeper
/// (`set_mark_keeper`), and what it pushes is the mark: the market is
/// tradeable from the first push instead of after fifteen minutes of on-chain
/// readings. The program still reads the pool itself in the same transaction
/// for depth, so leverage and budgets never take this process's word.
///
/// The set is read from the chain rather than from `markets.ts`, because an
/// observed market is by definition one somebody else listed: a loop
/// configured with a list of them would price every market except the ones
/// this exists for.
/// Markets of pools this program has outlived. Their observations are still on
/// chain, but the markets are in older layouts the program no longer decodes,
/// so every `observe` on them fails, and each failure is a transaction spent
/// against the RPC's rate limit. A market never moves pools, so once found
/// they stay skipped.
const otherPoolMarkets = new Set<string>();

/// The pool's mark keeper record, and the readings each market's pushed price
/// is smoothed from.
const markKeeperPda = PublicKey.findProgramAddressSync(
  [Buffer.from("mark_keeper"), pool.toBuffer()], program.programId)[0];
const KEEPER_WINDOW = 5;
const keeperReads = new Map<string, number[]>();

/// Makes this process the pool's mark keeper if nobody is. Authority only,
/// and a no-op once the record names this key.
async function ensureMarkKeeper() {
  const k: any = await program.account.markKeeper.fetchNullable(markKeeperPda);
  if (k?.keeper && new PublicKey(k.keeper).equals(authority.publicKey)) return;
  await program.methods.setMarkKeeper(authority.publicKey)
    .accounts({ authority: authority.publicKey, pool, markKeeper: markKeeperPda })
    .rpc();
  console.log(`mark keeper set to ${authority.publicKey.toBase58().slice(0, 8)}`);
}

/// The price pushed for one market: the median of its pool's last few spot
/// reads, in the program's units (USD per `10^unit_exp` tokens, six
/// decimals). A median, so one block of someone pushing the pool around moves
/// nothing, and a real move is followed within a couple of passes. On a new
/// market the first push is the spot itself, which is what lets it open at
/// once.
async function keeperPrice(observation: PublicKey, account: any): Promise<number> {
  const read = await readPool(conn, new PublicKey(account.source), usdcMint);
  if (!(read.price > 0)) throw new Error("pool reads no price");
  const key = observation.toBase58();
  const reads = [...(keeperReads.get(key) ?? []), read.price].slice(-KEEPER_WINDOW);
  keeperReads.set(key, reads);
  const sorted = [...reads].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const scaled = Math.round(median * 10 ** (account.unitExp ?? 0) * 1e6);
  if (!(scaled > 0)) throw new Error("price rounds to zero at this unit");
  return scaled;
}

async function observer() {
  const all = await program.account.observation.all();
  // This pool's markets, filtered on chain by the pool field (offset 9), the
  // same way the rewards page reads them. An observation whose market is not
  // among them is either for a listing still seasoning (no market yet, which
  // must keep being cranked) or for another pool's market (skipped).
  const ours = new Set(
    (await program.account.market.all([{ memcmp: { offset: 9, bytes: pool.toBase58() } }]))
      .map((m: any) => m.publicKey.toBase58()),
  );
  const unknown = all
    .map(({ account }) => new PublicKey(account.market))
    .filter((m) => !ours.has(m.toBase58()) && !otherPoolMarkets.has(m.toBase58()));
  for (let i = 0; i < unknown.length; i += 100) {
    const batch = unknown.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(batch);
    infos.forEach((info, k) => { if (info) otherPoolMarkets.add(batch[k].toBase58()); });
  }
  const folded: { publicKey: PublicKey; account: any }[] = [];
  for (const { publicKey, account } of all) {
    if (otherPoolMarkets.has(new PublicKey(account.market).toBase58())) continue;
    try {
      // A DLMM pair is read bin by bin, and the bins live in their own
      // accounts, which have to be picked fresh each time: which ones the
      // program needs depends on where the pair is trading now.
      const extra = account.sourceKind === SOURCE_KIND.meteoraDlmm
        ? await dlmmObserveAccounts(conn, new PublicKey(account.source), account.quoteIsToken0)
        : [];
      const price = await keeperPrice(publicKey, account);
      await program.methods.pushMark(new BN(price))
        .accounts({
          keeper: authority.publicKey, observation: publicKey, market: account.market,
          markKeeper: markKeeperPda, source: account.source,
        })
        .remainingAccounts(extra)
        .rpc();
    } catch (e: any) {
      // A pool that cannot be read is a market that never opens, which is the
      // failure mode permissionless listing was given on purpose. Report it
      // and leave the rest of the set alone.
      console.warn(`push mark ${publicKey.toBase58().slice(0, 8)}: ${e?.message ?? e}`);
      continue;
    }
    folded.push({ publicKey, account });
  }
  // Re-read: each fold wrote both the mark and the depth, so the copies this
  // pass started from are one reading stale. One call for all of them, not
  // one per market.
  const fresh = await program.account.observation.fetchMultiple(folded.map((f) => f.publicKey));
  for (const [i, { account }] of folded.entries()) {
    const o: any = fresh[i];
    if (!o) continue;
    const market = new PublicKey(account.market);
    publish(market, o);
    await trimBudget(market, o);
  }
}

/// Moves an observed market's mark onto the runtime the API serves.
///
/// An observed market has no source to poll: its price is whatever the last
/// fold left on chain, so this is the only place its quote comes from. The
/// tape is appended here for the same reason -- there are no candles to fetch
/// for a pool nobody publishes history for, and the chart draws what this
/// process has actually seen.
function publish(market: PublicKey, o: any) {
  const m = Object.values(rt).find((x) => x.address.equals(market));
  if (!m?.observed) return;

  const price = num(o.ewmaPrice) / 1e6;
  const span = num(o.lastUpdateTs) - num(o.firstUpdateTs);
  m.observed.readings = o.observations;
  m.observed.spanSec = span;
  // This process's clock, not the chain's: the page counts down against the
  // browser's, and a local validator's runs seconds behind both.
  m.observed.lastReadMs = Date.now();
  m.observed.seasoned =
    o.observations >= MIN_OBSERVATIONS && span >= MIN_OBSERVATION_WINDOW_SEC;
  m.observed.depthUsd = num(o.depthUsd) / 1e6;
  m.observed.unitExp = o.unitExp ?? 0;
  if (price <= 0) return;

  const now = Date.now();
  m.quote = {
    price,
    // The mark's own uncertainty, not a feed's: a pool that costs little to
    // move is one whose price deserves a wide quote, and the program derives
    // the confidence it charges from exactly this.
    confBps: observedConfBps(o),
    change24h: 0,
    underlying: null,
    liquidity: m.observed.depthUsd,
  } as any;
  m.lastFetch = now;
  if (!m.liveFrom) m.liveFrom = now;
  if (!m.open) m.open = price;
  m.high = Math.max(m.high || price, price);
  m.low = Math.min(m.low || price, price);
  m.history.push({ t: now, p: price });
  if (m.history.length > HISTORY) m.history.shift();
}

/// Cuts a market's loss budget to what its own pool costs to move.
///
/// The program accepts this from anyone and only downwards, which is what
/// makes running it here uncontroversial: the worst a wrong call can do is be
/// refused. It is checked before it is sent rather than sent and allowed to
/// fail, because a refusal still costs a transaction and the common case — a
/// market whose depth has not moved — is the one that would pay it.
async function trimBudget(market: PublicKey, o: any) {
  const observation = observationPda(market);
  const span = num(o.lastUpdateTs) - num(o.firstUpdateTs);
  if (o.observations < MIN_OBSERVATIONS || span < MIN_OBSERVATION_WINDOW_SEC) return;

  const depth = num(o.depthUsd);
  if (depth === 0) return;
  const ma: any = await program.account.market.fetch(market);
  if (depth >= num(ma.lossBudgetUsd)) return;

  await program.methods.deriveMarketBudget()
    .accounts({ pool, market, observation }).rpc();
  console.log(
    `budget ${market.toBase58().slice(0, 8)} ` +
    `$${(num(ma.lossBudgetUsd) / 1e6).toFixed(0)} -> $${(depth / 1e6).toFixed(0)}`);
}

const app = express();
app.use(express.json());
// No caching for the app shell: this is a dev server, and a stale index.html or
// app.js after an edit looks exactly like a bug in the page.
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store, must-revalidate");
  next();
});

/*
 * The site calls this server directly rather than through its own /api
 * proxy, which added a round trip to a Vercel function in Washington to
 * every request. So the site's origins may read it cross-origin. The data is
 * public either way: every route here also answers a plain request.
 */
// A page served from localhost is anyone's local copy of the site, so it is
// let in only where CORS_LOCALHOST=1. Local dev never needs it: Vite
// proxies /api on the page's own origin.
const ALLOWED_ORIGIN = process.env.CORS_LOCALHOST === "1"
  ? /^https:\/\/((www\.)?unwindfi\.xyz|starboy[a-z0-9-]*\.vercel\.app)$|^http:\/\/localhost(:\d+)?$/
  : /^https:\/\/((www\.)?unwindfi\.xyz|starboy[a-z0-9-]*\.vercel\.app)$/;
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGIN.test(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "content-type");
    res.set("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(ROOT, "app"), { etag: false, lastModified: false }));
app.use("/vendor", express.static(path.join(ROOT, "node_modules/lightweight-charts/dist")));
app.use("/fonts", express.static(path.join(ROOT, "node_modules/@fontsource/inter/files")));

/// The whole market list, kept for a moment. Every open page polls it, and
/// at twenty markets a read-through cost twenty-two RPC calls a request.
let marketsMemo: { at: number; body: Promise<any> } | null = null;
const MARKETS_FRESH_MS = 2_000;

app.get("/api/markets", async (_req, res) => {
  try {
    if (!marketsMemo || Date.now() - marketsMemo.at >= MARKETS_FRESH_MS) {
      const body = marketsView();
      marketsMemo = { at: Date.now(), body };
      body.catch(() => { if (marketsMemo?.body === body) marketsMemo = null; });
    }
    res.json(await marketsMemo.body);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

async function marketsView() {
  {
    const markets = Object.values(rt);
    // Every market account in one call rather than one call each.
    const [p, accounts] = await Promise.all([
      program.account.pool.fetch(pool),
      program.account.market.fetchMultiple(markets.map((m) => m.address)),
    ]);
    const freeLiquidity = (num(p.liquidityUsd) - num(p.lockedUsd)) / 1e6;
    const utilizationBps = num(p.liquidityUsd) > 0
      ? Math.min(10_000, (num(p.lockedUsd) * 10_000) / num(p.liquidityUsd)) : 10_000;
    const out = await Promise.all(markets.map(async (m, i) => {
      const ma: any = accounts[i] ?? await marketAccount(m);
      const price = px(m);
      const q = quote(ma, m);
      const longSize = num(ma.longSizeUsd) / 1e6;
      const shortSize = num(ma.shortSizeUsd) / 1e6;
      const total = longSize + shortSize;
      return {
        symbol: m.symbol, name: m.name, color: m.color, mono: m.mono, price,
        // Null for an observed market: nobody wrote a definition for it, and
        // the pool it watches is the address that identifies it.
        mint: m.def?.mint ?? null,
        // The source's own 24h figures, not a delta from whenever this process
        // happened to start.
        change: price - m.open,
        changePct: m.open > 0 ? ((price - m.open) / m.open) * 100 : 0,
        high: m.high, low: m.low,
        // What the price actually is and how much it should be trusted.
        underlying: m.quote?.underlying ?? null,
        confBps: m.quote?.confBps ?? 0,
        poolLiquidity: m.quote?.liquidity ?? 0,
        priceAgeMs: m.lastFetch ? Date.now() - m.lastFetch : null,
        maxPriceAgeSec: ma.maxPriceAgeSec,
        feedError: lastPostError || null,
        ...q,
        // The program caps an observed market by its pool's sustained depth
        // (`Market::depth_leverage_cap_bps`); this is the same number.
        maxLeverage: Math.min(
          (ma.session === 2 ? ma.closedSessionLeverageBps : ma.maxLeverageBps) / BPS,
          ma.priceSource === 1 ? Math.max(ma.depthLeverageX, DEPTH_LEVERAGE_TIERS[0][1]) : Infinity),
        session: ma.session,
        oi: total,
        longShare: total > 0 ? (longSize / total) * 100 : 50,
        fundingLong: Number(ma.cumulativeLongFunding.toString()),
        fundingShort: Number(ma.cumulativeShortFunding.toString()),
        // The rate each side pays right now, in bps an hour, positive to pay.
        // The cumulative indices above are totals since listing and cannot
        // be read as a rate.
        ...fundingRates(ma, longSize, shortSize, utilizationBps),
        lastFundingTs: num(ma.lastFundingTs),
        maintenanceMarginBps: ma.maintenanceMarginBps,
        openFeeBps: ma.openFeeBps,
        // What bounds a fill in an oracle-priced pool: free pool liquidity and
        // the per-side open interest cap. There is no book to walk.
        volume24h: m.volume,
        freeLiquidity,
        capLong: num(ma.maxOiLongUsd) / 1e6 - longSize,
        capShort: num(ma.maxOiShortUsd) / 1e6 - shortSize,
        longSize, shortSize,
        // First-loss capital behind this market, and the loss budget it is
        // held to. Every market can be backed -- `back_market` does not care
        // where the price comes from -- so this is top-level, not inside
        // `observed`, which only exists for markets opened on a pool.
        // The whole pot at the last prices, and what of it is held in kind.
        backingUsd: potUsd(m.address, ma.backingUsd),
        backingInKind: books[m.address.toBase58()]?.amounts ?? {},
        lossBudgetUsd: num(ma.lossBudgetUsd) / 1e6,
        // Null for a market with a feed behind it. For one listed against a
        // pool this is the whole of its status: what it is watching, how far
        // through seasoning it is, and whether anyone has underwritten it yet.
        observed: m.observed && {
          source: m.observed.source.toBase58(),
          readings: m.observed.readings,
          readingsNeeded: MIN_OBSERVATIONS,
          spanSec: m.observed.spanSec,
          spanNeededSec: MIN_OBSERVATION_WINDOW_SEC,
          seasoned: m.observed.seasoned,
          depthUsd: m.observed.depthUsd,
          // A listed market starts with no budget and cannot open a position
          // until the pool underwrites it. Saying so is the difference between
          // a market that is waiting and one that is broken.
          budgetUsd: num(ma.lossBudgetUsd) / 1e6,
          // What backers have actually posted, as against what the budget
          // says. The two agree for a market nobody underwrote by authority,
          // and saying both is what makes an allowance auditable.
          backingUsd: potUsd(m.address, ma.backingUsd),
          // Backers are paid this share of the LPs' part of every fee the
          // market earns, as a rise in what each backing share is worth. What
          // they have earned so far is not kept on the account; the program
          // emits `BackerFeePaid` per fill for anyone who wants the sum.
          backerFeeShareBps: BACKER_FEE_SHARE_BPS,
          // The price above is USD for this many tokens, and the label the
          // symbol carries for it (`1M` for six).
          unitExp: m.observed.unitExp,
          unitLabel: unitLabel(m.observed.unitExp),
          tradeable: m.observed.seasoned && num(ma.lossBudgetUsd) > 0,
        },
        // Two hours of real minute closes, not the last two minutes of tape:
        // at a one-second tick the tape is far too zoomed in to show a shape.
        sparkline: sparklineFor(m),
      };
    }));
    return out;
  }
}

/// OHLC bars aggregated from the tick tape, for the chart.
app.get("/api/trades/:symbol", (req, res) => {
  res.json(trades.filter((t) => t.symbol === req.params.symbol).slice(0, 40));
});

/// One wallet's settled fills and liquidations, newest first. Only what this
/// server has settled since it started: the chain keeps positions, not a fill
/// log, so anything older is not here to give.
app.get("/api/fills", (req, res) => {
  try { res.json(fillsByOwner.get(ownerOf(req).toBase58()) ?? []); }
  catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/*
 * What the batch is doing, for the screen.
 *
 * The auction is the whole product and until now none of it was visible: the
 * page showed a price and a fill and looked exactly like every pool-priced
 * venue it is not. These are the three things that make it different — a
 * window that is counting down, real orders resting in it, and one price per
 * flow that every order in it got.
 */

/// The last clear, per market, and the running totals behind the number this
/// design has to answer for.
const lastClear: Record<string, {
  /// One per flow; null when that flow did not trade.
  buyPrice: number | null; sellPrice: number | null;
  matched: number; poolUsd: number; orders: number; t: number;
}> = {};
const shareTally: Record<string, { matched: number; pool: number }> = {};

/// Share of all volume the pool has been the counterparty to, in percent.
///
/// Null until something has traded, rather than zero: "no data yet" and "the
/// pool took none of it" are different claims and only one of them is true at
/// startup.
const poolShareOf = (symbol: string) => {
  const t = shareTally[symbol];
  return t && t.matched > 0 ? (t.pool / t.matched) * 100 : null;
};

/// Reads what a clear actually did out of its own logs.
///
/// `pool_bought` and `pool_sold` are emitted by `BatchCleared` but not stored
/// on the account, and they are exactly the figure a reader should be able to
/// hold this design to. Parsed from the transaction rather than subscribed to:
/// a dropped websocket would leave the number quietly wrong, where a failed
/// parse leaves it visibly absent.
async function recordClear(symbol: string, sig: string) {
  const tx = await conn.getTransaction(sig, {
    commitment: "confirmed", maxSupportedTransactionVersion: 0,
  });
  for (const line of tx?.meta?.logMessages ?? []) {
    if (!line.startsWith("Program data: ")) continue;
    let ev: any = null;
    try { ev = program.coder.events.decode(line.slice(14)); } catch { continue; }
    if (!ev || String(ev.name).toLowerCase() !== "batchcleared") continue;

    // Two auctions per batch: takers buying meet makers selling, takers
    // selling meet makers buying. A zero price is a flow that did not trade.
    const buyPrice = Number(ev.data.buyPrice) / 1e6 || null;
    const sellPrice = Number(ev.data.sellPrice) / 1e6 || null;
    const matched = (Number(ev.data.buyMatchedUsd) + Number(ev.data.sellMatchedUsd)) / 1e6;
    const poolUsd = (Number(ev.data.poolBought) + Number(ev.data.poolSold)) / 1e6;
    lastClear[symbol] = {
      buyPrice, sellPrice,
      matched, poolUsd,
      orders: Number(ev.data.orders),
      t: Date.now(),
    };
    // A batch that crossed nothing is still a batch; it just does not move the
    // share, because dividing by a volume of zero says nothing about anything.
    if (matched > 0) {
      const t = (shareTally[symbol] ??= { matched: 0, pool: 0 });
      t.matched += matched;
      t.pool += poolUsd;
    }
  }
}

type BookOrder = { price: number; size: number; isBid: boolean; isMaker: boolean };

/// Which of a batch's two auctions an order clears in, named for what the
/// taker in it is doing. Mirrors `auction::Flow` in the program.
const flowOf = (o: { isBid: boolean; isMaker: boolean }) =>
  o.isBid !== o.isMaker ? "buy" : "sell";

/// Where one flow's resting orders would cross right now, before the pool
/// fills any takers left over. The same rule the program clears by: the price
/// that matches the most volume, then the one that leaves the least standing.
function crossOf(orders: BookOrder[]) {
  const prices = [...new Set(orders.map((o) => o.price))].sort((a, b) => a - b);
  let best: { price: number; matched: number; imbalance: number } | null = null;
  for (const p of prices) {
    const demand = orders.filter((o) => o.isBid && o.price >= p).reduce((s, o) => s + o.size, 0);
    const supply = orders.filter((o) => !o.isBid && o.price <= p).reduce((s, o) => s + o.size, 0);
    const matched = Math.min(demand, supply);
    const imbalance = Math.abs(demand - supply);
    if (matched > 0 && (!best || matched > best.matched
        || (matched === best.matched && imbalance < best.imbalance))) {
      best = { price: p, matched, imbalance };
    }
  }
  return { price: best?.price ?? null, matched: best?.matched ?? 0 };
}

/// Where each flow of the collecting batch would cross right now. Indicative
/// only: the pool fills leftover takers at clearing, and orders can still
/// arrive.
function indicativeCross(orders: BookOrder[]) {
  const bid = orders.filter((o) => o.isBid).reduce((s, o) => s + o.size, 0);
  const ask = orders.filter((o) => !o.isBid).reduce((s, o) => s + o.size, 0);
  return {
    buy: crossOf(orders.filter((o) => flowOf(o) === "buy")),
    sell: crossOf(orders.filter((o) => flowOf(o) === "sell")),
    bidUsd: bid, askUsd: ask,
  };
}

/// The collecting batch as the page needs to see it.
///
/// Read from the account every time rather than mirrored in this process: the
/// batch is the authority on what is resting in it, and a copy kept here would
/// go stale in precisely the five seconds that matter.
app.get("/api/batch/:symbol", async (req, res) => {
  const m = rt[req.params.symbol];
  if (!m) return res.status(404).json({ error: "unknown market" });
  try {
    const seen = batchSeen.get(m.symbol);
    const state: any = seen && Date.now() - seen.at < BATCH_FRESH_MS
      ? seen.state
      : await program.account.batch.fetchNullable(batchPda(m.address));
    if (!state) return res.json({ exists: false });

    const opened = Number(state.openedTs);
    const resting = (state.orders as any[])
      .filter((o) => o.active !== 0)
      .map((o) => ({
        price: Number(o.price) / 1e6,
        size: Number(o.sizeUsd) / 1e6,
        isBid: o.isBid !== 0,
        isMaker: o.isMaker !== 0,
        reduceOnly: o.reduceOnly !== 0,
      }));

    // A market still seasoning is in its opening auction: orders rest until the
    // mark is ready, then all clear at once. When that is, is the question
    // everyone looking at it has, so it is answered here rather than left to
    // the page to derive.
    const o = m.observed;
    // Anchored to when the last reading landed, not to now: "now plus what is
    // left" moves forward with every poll between readings, and a countdown
    // that stands still for twenty-five seconds reads as broken.
    const opening = o && !o.seasoned ? {
      opensAtMs: o.lastReadMs + 1000 * Math.max(
        MIN_OBSERVATION_WINDOW_SEC - o.spanSec,
        (MIN_OBSERVATIONS - o.readings) * (OBSERVE_MS / 1000), 0),
      readings: o.readings,
      readingsNeeded: MIN_OBSERVATIONS,
    } : null;

    res.json({
      exists: true,
      seq: Number(state.seq),
      opening,
      indicative: indicativeCross(resting),
      // Past zero means the window is up and the crank has not landed yet.
      // That is a real state of the venue, not an error, and the page says so.
      clearsAtMs: (opened + BATCH_INTERVAL_SEC) * 1000,
      sealed: Number(state.clearedTs) !== 0,
      resting,
      last: lastClear[m.symbol] ?? null,
      poolSharePct: poolShareOf(m.symbol),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/// Real OHLC from the source, with bars aggregated from the live tape after it.
///
/// The source publishes nothing finer than a minute, so the 5s and 15s
/// timeframes are live-only and start sparse. That is the honest shape of the
/// data; the previous build hid it behind a synthetic warm-up.
app.get("/api/candles/:symbol", async (req, res) => {
  const m = rt[req.params.symbol];
  if (!m) return res.status(404).json({ error: "unknown market" });
  const tf = Math.max(1, Number(req.query.tf) || 5);

  // Below a minute the source has nothing, so only this process's own ticks
  // may be shown. Bucketing the seeded minute closes into 5s bars would draw a
  // minute-resolution tape as though it were second-resolution.
  const from = tf < 60 ? m.liveFrom : 0;
  const live: any[] = [];
  let cur: any = null;
  for (const h of m.history) {
    if (h.t < from) continue;
    const bucket = Math.floor(h.t / 1000 / tf) * tf;
    if (!cur || cur.time !== bucket) {
      cur = { time: bucket, open: h.p, high: h.p, low: h.p, close: h.p };
      live.push(cur);
    } else {
      cur.high = Math.max(cur.high, h.p);
      cur.low = Math.min(cur.low, h.p);
      cur.close = h.p;
    }
  }

  const seeded = await seedBars(m, tf);
  if (seeded.length === 0) return res.json(live);
  // Where the two overlap the live tape wins: it is this venue's own prints at
  // full resolution, where the seed is the source's summary of the same window.
  const cutoff = live.length ? live[0].time : Infinity;
  res.json([...seeded.filter((c) => c.time < cutoff), ...live]);
});

/// The traders' combined open PnL against every market's current mark. The
/// pool is short all of it, so this is what separates its liquidity from what
/// its shares are worth -- and the account view and the APY tape both need
/// that number, so it is written once.
async function traderPnlNow() {
  let traderPnl = 0;
  const markets = Object.values(rt);
  const accounts = await Promise.all(markets.map(marketAccount));
  for (const [i, m] of markets.entries()) {
    const ma = accounts[i];
    const price = px(m);
    const pnlOf = (isLong: boolean, size: number, entry: number) =>
      entry > 0 ? size * ((price - entry) / entry) * (isLong ? 1 : -1) : 0;
    traderPnl +=
      pnlOf(true, num(ma.longSizeUsd) / 1e6, num(ma.longAvgEntryPrice) / 1e6) +
      pnlOf(false, num(ma.shortSizeUsd) / 1e6, num(ma.shortAvgEntryPrice) / 1e6);
  }
  return traderPnl;
}

app.get("/api/account", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const key = owner.toBase58();
    const hit = accountMemo.get(key);
    if (hit && Date.now() - hit.at < ACCOUNT_FRESH_MS) return res.json(await hit.body);
    const body = accountView(owner);
    accountMemo.set(key, { at: Date.now(), body });
    // A failed read is not kept: the next poll asks the chain again.
    body.catch(() => accountMemo.delete(key));
    res.json(await body);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

async function accountView(owner: PublicKey) {
  {
    // A wallet that has never traded has no token accounts yet; that is a zero
    // balance, not an error, so it must not blank the whole view.
    const zero = { amount: 0n } as any;
    // All at once: none depends on another, and against a remote RPC each
    // round trip is hundreds of milliseconds the page polls through.
    const [usdc, lpTok, supply, p, positions, orderAccounts, traderPnl] = await Promise.all([
      getAccount(conn, ata(owner, usdcMint)).catch(() => zero),
      getAccount(conn, ata(owner, lpMint)).catch(() => zero),
      conn.getTokenSupply(lpMint),
      poolAccount(),
      loadPositions(owner),
      program.account.order.all([{ memcmp: { offset: 8 + 1, bytes: owner.toBase58() } }]),
      traderPnlNow(),
    ]);
    const orders = orderAccounts.map((e: any) => ({
      address: e.publicKey.toBase58(),
      symbol: Object.values(rt).find((m) => m.address.toBase58() === String(e.account.market))?.symbol,
      slot: e.account.slot,
      kind: e.account.kind,
      sizeUsd: num(e.account.sizeUsd) / 1e6,
      collateralUsd: num(e.account.collateralUsd) / 1e6,
      isLong: e.account.isLong,
      triggerPrice: num(e.account.triggerPrice) / 1e6,
      triggerAbove: e.account.triggerAbove,
      expiryTs: num(e.account.expiryTs),
    })).filter((o: any) => o.symbol);

    const liquidity = num(p.liquidityUsd) / 1e6;
    const locked = num(p.lockedUsd) / 1e6;
    const aum = liquidity - traderPnl;
    const lpSupply = Number(supply.value.amount) / 1e6;
    const lpPrice = lpSupply > 0 ? aum / lpSupply : 1;
    const held = Number(lpTok.amount) / 1e6;

    const unrealized = Object.values(positions).reduce(
      (a: number, x: any) => a + x.pnl, 0);
    const margin = Object.values(positions).reduce(
      (a: number, x: any) => a + x.collateral, 0);

    return {
      cluster: CLUSTER,
      address: owner.toBase58(),
      usdc: Number(usdc.amount) / 1e6,
      margin, unrealized,
      equity: Number(usdc.amount) / 1e6 + margin + unrealized + held * lpPrice,
      positions,
      orders,
      liquidations,
      deleverages,
      orderFills,
      lp: { held, price: lpPrice, value: held * lpPrice },
      pool: {
        aum, liquidity, locked, free: liquidity - locked,
        utilization: liquidity > 0 ? (locked / liquidity) * 100 : 0,
        insurance: num(p.insuranceUsd) / 1e6,
        escrow: num(p.escrowUsd) / 1e6,
        maxUtilization: p.maxUtilizationBps / 100,
        // What entering and leaving cost, in percent. Both stay with the LPs
        // who remain, so they are a transfer between depositors, not revenue.
        addFeePct: num(p.addLiquidityFeeBps ?? 0) / 100,
        removeFeePct: num(p.removeLiquidityFeeBps ?? 0) / 100,
        traderPnl, lpSupply, lpPrice,
      },
    };
  }
}

app.post("/api/order", async (req, res) => {
  const { symbol, isLong, collateral, size } = req.body;
  const m = rt[symbol];
  if (!m) return res.status(404).json({ ok: false, error: "unknown market" });
  try {
    // A maker names its own price; there is no "at market" for liquidity.
    const maker = !!req.body.maker;
    if (maker && !Number(req.body.price)) throw new Error("a maker order needs a price");
    const limit = Number(req.body.price) || marketLimit(m, !!isLong);
    const sig = await program.methods
      .submitOrder(USD(limit), USD(Number(size)), USD(Number(collateral)), !!isLong, false, maker)
      .accounts(orderAccounts(m, trader.publicKey)).signers([trader]).rpc();
    // Not a fill. The order rests until the batch clears, so the tape gets an
    // entry when it settles rather than when it was sent.
    res.json({ ok: true, sig, price: limit, pending: true });
  } catch (e) { res.status(400).json({ ok: false, error: explain(e) }); }
});

/// Closing is an order now, not an instruction of its own.
///
/// It goes into the same batch as everything else and fills at the same
/// clearing price, which is the whole point: a venue whose exits price off the
/// index is one where the index is still the price. The trade tape therefore
/// records nothing here -- there is no fill yet -- and the response says
/// `pending` for the same reason.
const closeOrder = async (m: MarketRt, owner: PublicKey, sizeUsd: number) => {
  const open = await closableUsd(m, owner);
  if (!open) throw new Error("nothing open to close");
  const size = sizeUsd > 0 ? Math.min(sizeUsd, open.usd) : open.usd;
  // Closing a long sells, closing a short buys, and the limit reaches through
  // the index far enough to cross whatever the batch finds.
  const isBid = !open.isLong;
  const limit = marketLimit(m, isBid);
  return {
    limit,
    size,
    builder: program.methods
      .submitOrder(USD(limit), USD(size), new BN(0), isBid, true, false)
      .accounts(orderAccounts(m, owner)),
  };
};

app.post("/api/close", async (req, res) => {
  const m = rt[req.body.symbol];
  if (!m) return res.status(404).json({ ok: false, error: "unknown market" });
  try {
    const { limit, size, builder } = await closeOrder(
      m, trader.publicKey, Number(req.body.size || 0));
    const sig = await builder.signers([trader]).rpc();
    res.json({ ok: true, sig, price: limit, size, pending: true });
  } catch (e) { res.status(400).json({ ok: false, error: explain(e) }); }
});

app.post("/api/deposit", async (req, res) => {
  try {
    const accounts = await allMarketAccounts();
    const ix = await program.methods
      .addLiquidity(USD(Number(req.body.amount)), new BN(0))
      .accounts(liquidityAccounts(trader.publicKey))
      .remainingAccounts(accounts).instruction();
    await sendV0(conn, trader, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ix,
    ], await tablesFor(accounts));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: explain(e) }); }
});

app.post("/api/withdraw", async (req, res) => {
  try {
    const accounts = await allMarketAccounts();
    const ix = await program.methods
      .removeLiquidity(USD(Number(req.body.amount)), new BN(0))
      .accounts(liquidityAccounts(trader.publicKey))
      .remainingAccounts(accounts).instruction();
    await sendV0(conn, trader, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ix,
    ], await tablesFor(accounts));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: explain(e) }); }
});

/// Nothing is served until a real price is on chain for every market: an empty
/// or stale oracle means every quote the page could draw would be wrong, and a
/// placeholder is worse than a wait.
(async function start() {
  // Without this the first RPC call rejects with a bare "fetch failed", which
  // names neither the endpoint nor the fact that nothing is listening on it.
  try {
    await conn.getVersion();
  } catch (e: any) {
    throw new Error(
      `no validator answering at ${st.rpc} (${e?.message ?? e})\n` +
      `  start one with scripts/localnet.sh, then scripts/bootstrap-localnet.ts`);
  }

  const savedTable = fs.existsSync(TABLE_FILE)
    ? JSON.parse(fs.readFileSync(TABLE_FILE, "utf8")).address
    : st.lookupTable;
  if (savedTable) {
    lookupTable = await loadLookupTable(conn, new PublicKey(savedTable))
      .catch((e) => { console.warn(`lookup table: ${explain(e)}`); return null; });
  }

  // Before the warm-up, so a market somebody listed while this process was
  // down is in the registry by the time anything reads it.
  await discoverMarkets().catch((e: any) =>
    console.warn(`discover: ${e?.message ?? e}`));

  await warmUp();

  // Give the source a bounded chance to answer before giving up on a first
  // price. A rate limit or a blip should not stop the app from booting: the
  // page marks a stale feed and disables ordering, and the program rejects any
  // fill priced off an oracle past `max_price_age_sec` regardless. Refusing to
  // start just hides all of that behind a dead port.
  const deadline = Date.now() + STARTUP_PRICE_WAIT_MS;
  while (Date.now() < deadline) {
    await tick();
    if (Object.values(rt).every((m) => m.quote)) break;
    await new Promise((r) => setTimeout(r, Math.max(TICK_MS, backoffUntil - Date.now())));
  }

  const dead = Object.values(rt).filter((m) => !m.quote).map((m) => m.symbol);
  if (dead.length) {
    // `tick` already knows why it bailed. Reporting only the symptom sends the
    // reader looking at the price source when the fault is often on chain — a
    // validator without the mock receiver deployed, for instance.
    console.warn(
      `starting without a price for ${dead.join(", ")}` +
      (lastPostError ? `\n  cause: ${lastPostError}` : "") +
      `\n  the page will show the feed as stale and refuse orders until it recovers;` +
      `\n  if this says the program is missing, the validator was started without it —` +
      ` run scripts/localnet.sh, then scripts/bootstrap-localnet.ts`
    );
  }
  await syncSessions();

  // Every loop is wrapped, because a public RPC throttles as a matter of
  // course and one 429 in a background task should not take the venue down.
  //
  // Each pass waits for the last one to finish. A `setInterval` fires on
  // schedule regardless, so when the RPC slowed down and web3's retries
  // stretched a pass past its interval, passes stacked up, each adding its
  // own retries, until the throttle never lifted and nothing cleared.
  const loop = (name: string, fn: () => Promise<unknown>, ms: number) => {
    const pass = async () => {
      await fn().catch((e: any) => console.warn(`${name}: ${e?.message ?? e}`));
      setTimeout(pass, ms);
    };
    setTimeout(pass, ms);
  };

  /// The testnet's market maker.
  ///
  /// In a dual flow batch two takers never trade with each other: a taker
  /// buying meets makers selling, and that is all. A market nobody is making
  /// is one where every taker fills against the pool at its oracle quote,
  /// which is pool pricing by another name. This quotes both sides of every
  /// batch a taker is waiting in, so the testnet shows the design as it is
  /// meant to run: takers priced by makers, the pool taking only what the
  /// makers leave.
  ///
  /// It quotes blind. Its prices come from the index and its sizes from the
  /// config, never from the orders it can see resting: seeing that a batch
  /// has takers in it decides whether to quote, not where. Anyone can run a
  /// better one against it, which is the point of the flag being public.
  const MAKER_ON = process.env.MAKER_BOT !== "0";
  const MAKER_SPREAD_BPS = Number(process.env.MAKER_SPREAD_BPS ?? 10);
  const MAKER_SIZE_USD = Number(process.env.MAKER_SIZE_USD ?? 2_000);
  // Past this the maker stops adding to its position and only quotes out.
  const MAKER_MAX_POSITION_USD = MAKER_SIZE_USD * 10;
  const maker = lp;
  const quoted = new Map<string, number>(); // market -> batch seq last quoted

  const fundMaker = async () => {
    const ixs: TransactionInstruction[] = [];
    // Position accounts are rent the maker pays itself, once per market.
    if ((await conn.getBalance(maker.publicKey)) < 0.05e9) {
      ixs.push(SystemProgram.transfer({
        fromPubkey: authority.publicKey, toPubkey: maker.publicKey, lamports: 0.2e9,
      }));
    }
    const addr = ata(maker.publicKey, usdcMint);
    const usdc = await getAccount(conn, addr).then((a) => Number(a.amount) / 1e6, () => 0);
    if (usdc < MAKER_SIZE_USD * 20) {
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, addr, maker.publicKey, usdcMint),
        createMintToInstruction(usdcMint, addr, authority.publicKey, BigInt(MAKER_SIZE_USD * 100) * 1_000_000n),
      );
    }
    if (ixs.length) await sendV0(conn, authority, ixs);
  };

  const makeMarket = async (m: MarketRt, state: any) => {
    const seq = Number(state.seq);
    if (quoted.get(m.symbol) === seq) return;
    const owner = maker.publicKey.toBase58();
    const active = (state.orders as any[]).filter((o) => o.active);
    // Only where a taker is waiting, and only once per batch.
    if (!active.some((o) => !o.isMaker && new PublicKey(o.owner).toBase58() !== owner)) return;
    if (active.some((o) => new PublicKey(o.owner).toBase58() === owner)) return;
    const mark = px(m);
    if (!(mark > 0)) return;
    quoted.set(m.symbol, seq);

    const bidPx = mark * (1 - MAKER_SPREAD_BPS / 10_000);
    const askPx = mark * (1 + MAKER_SPREAD_BPS / 10_000);
    const open = await closableUsd(m, maker.publicKey);
    const accounts = orderAccounts(m, maker.publicKey);
    const quote = (price: number, size: number, isBid: boolean, reduce: boolean) =>
      program.methods
        .submitOrder(USD(price), USD(size), reduce ? new BN(0) : USD(size * 0.6), isBid, reduce, true)
        .accounts(accounts).instruction();

    // Positions do not flip, so the side the maker already holds is quoted as
    // an open and the other side as a close of what it holds.
    const ixs: TransactionInstruction[] = [];
    const heldUsd = open?.usd ?? 0;
    for (const isBid of [true, false]) {
      const adds = !open || open.isLong === isBid;
      if (adds) {
        if (heldUsd + MAKER_SIZE_USD <= MAKER_MAX_POSITION_USD) {
          ixs.push(await quote(isBid ? bidPx : askPx, MAKER_SIZE_USD, isBid, false));
        }
      } else {
        ixs.push(await quote(isBid ? bidPx : askPx, Math.min(MAKER_SIZE_USD, heldUsd), isBid, true));
      }
    }
    if (ixs.length) await sendV0(conn, authority, ixs, [], [maker]);
  };

  /// Clears every market's batch once its window is up, then settles what it
  /// filled.
  ///
  /// This is liveness, not operation: `clear_batch` takes no price and
  /// `settle_order` takes no discretion, so the worst a stalled crank can do
  /// is leave orders resting with their collateral escrowed where their owners
  /// put it. Anyone can run a second one, and two racing costs a wasted
  /// transaction rather than a different outcome.
  const auction = async () => {
    // Every batch in one read. Fetching them one by one cost a request per
    // market per second, which on its own is enough for the public RPC to
    // throttle a handful of markets.
    const markets = Object.values(rt);
    const infos = await conn.getMultipleAccountsInfo(markets.map((m) => batchPda(m.address)));
    for (const [i, m] of markets.entries()) {
      const info = infos[i];
      if (!info) continue;
      const state: any = program.coder.accounts.decode("batch", info.data);
      batchSeen.set(m.symbol, { state, at: Date.now() });
      // An open batch with nothing in it has nothing to clear. Clearing it
      // anyway only restarts its window, and cost a transaction per market
      // every five seconds. Once an order lands the batch is already overdue
      // and clears on the next pass.
      const open = Number(state.clearedTs) === 0;
      if (open && !state.orders.some((o: any) => o.active)) continue;
      // Quote before clearing, into the batch the takers are waiting in. A
      // listing still seasoning has no mark to quote around yet.
      if (MAKER_ON && open && !(m.observed && !m.observed.seasoned)) {
        await makeMarket(m, state).catch((e: any) =>
          console.warn(`maker ${m.symbol}: ${explain(e)}`));
      }
      // One market that cannot clear must not hold up the rest, which is what
      // a single throw out of this loop used to do.
      try { await clearAndSettle(m, state); }
      catch (e: any) {
        // The chain's clock runs a little behind this one; a batch the
        // program says is not due yet is simply early, and is tried again
        // next second.
        if (!/BatchNotDue/.test(String(e?.message ?? e))) {
          console.warn(`auction ${m.symbol}: ${explain(e)}`);
        }
      }
    }
  };

  const clearAndSettle = async (m: MarketRt, state: any) => {
    {
      // A listed market still seasoning is running its opening auction: it
      // takes orders but has no mark to clear them against, so they rest and
      // all clear together in its first batch.
      if (m.observed && !m.observed.seasoned) return;

      const batch = batchPda(m.address);

      const open = Number(state.clearedTs) === 0;
      const due = Date.now() / 1000 >= Number(state.openedTs) + BATCH_INTERVAL_SEC;
      if (open && !due) return;

      if (open) {
        const sig = await program.methods
          .clearBatch()
          .accounts({ pool, market: m.address, batch, priceUpdate: oracleOf(m) })
          .rpc();
        // Best effort: the clear has already landed, and failing to read its
        // logs back must not stop the settlements that follow it.
        await recordClear(m.symbol, sig).catch((e: any) =>
          console.warn(`clear log ${m.symbol}: ${e?.message ?? e}`));
      }

      const sealed: any = await program.account.batch.fetch(batch);
      if (Number(sealed.clearedTs) === 0) return;

      // Settled several to a transaction: a full batch one by one was 64
      // round trips to an RPC that throttles.
      const pending: { i: number; o: any; ix: TransactionInstruction }[] = [];
      for (let i = 0; i < sealed.orders.length; i++) {
        const o = sealed.orders[i];
        if (!o.active) continue;
        const owner = new PublicKey(o.owner);
        const ix = await program.methods
          .settleOrder(i)
          .accounts({
            pool, market: m.address, batch, owner,
            position: positionPda(m.address, owner),
            usdcMint, usdcVault, ownerUsdc: ata(owner, usdcMint),
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();
        pending.push({ i, o, ix });
      }
      const settled = (o: any) => {
        if (Number(o.filledUsd) > 0) {
          recordTrade({
            symbol: m.symbol,
            side: o.isBid ? "buy" : "sell",
            size: Number(o.filledUsd) / 1e6,
            // Its own flow's price: the batch cleared twice.
            price: Number(flowOf({ isBid: !!o.isBid, isMaker: !!o.isMaker }) === "buy"
              ? sealed.buyPrice : sealed.sellPrice) / 1e6,
            // A reduce-only fill closed part of a position; recording every
            // fill as an open listed closes as opens in the trade history.
            kind: o.reduceOnly ? "close" : "open",
            owner: new PublicKey(o.owner).toBase58(),
          });
        }
      };
      const send = (ixs: TransactionInstruction[]) =>
        provider.sendAndConfirm(new Transaction().add(...withComputeLimit(ixs)));
      let at = 0;
      for (const group of packInstructions(pending.map((d) => d.ix), authority.publicKey)) {
        const members = pending.slice(at, at + group.length);
        at += group.length;
        try {
          await send(group);
          members.forEach((d) => settled(d.o));
        } catch {
          // One order that cannot settle fails its whole transaction, so
          // retry that group one at a time rather than strand the others.
          for (const d of members) {
            try { await send([d.ix]); settled(d.o); }
            catch (e: any) { console.warn(`settle ${m.symbol}#${d.i}: ${e?.message ?? e}`); }
          }
        }
      }
    }
  };

  // Before the first tick, which prices the custodies alongside the markets.
  try { await loadCustodies(); await loadBooks(); }
  catch (e: any) { console.warn(`custodies: ${explain(e)}`); }
  loop("tick", tick, TICK_MS);
  loop("auction", auction, AUCTION_MS);
  loop("sessions", syncSessions, SESSION_MS);
  loop("keeper", keeper, KEEPER_MS);
  loop("balance", watchBalance, 10 * 60_000);
  if (MAKER_ON) {
    await fundMaker().catch((e: any) => console.warn(`maker funds: ${explain(e)}`));
    loop("maker funds", fundMaker, 10 * 60_000);
  }
  // The testnet's own pools shadow real tokens so their markets move. Loaded
  // only there: nothing else has pools this process is allowed to trade.
  if (CLUSTER === "devnet" && seeded.length) {
    const { makeFlow } = await import("./testnet-flow");
    loop("flow", makeFlow(conn, authority, usdcMint, seeded), FLOW_MS);
  }
  // Offset, so the two heaviest calls in the process never coincide.
  setTimeout(() => loop("orders", orderKeeper, KEEPER_MS), KEEPER_MS / 2);
  loop("crank", crank, CRANK_MS);
  // Pushing marks needs the keeper record first. Failing here is loud but
  // not fatal: without it every push is refused, and the loop says so.
  await ensureMarkKeeper().catch((e: any) => console.warn(`mark keeper: ${e?.message ?? e}`));
  // Every listed market goes in the table now, so a deposit rarely waits on
  // an extension. Not awaited: nothing else depends on it.
  void tablesFor([
    ...Object.values(rt).flatMap((m) => [{ pubkey: m.address }, { pubkey: oracleOf(m) }]),
    ...custodyPairs(false),
  ]);
  loop("observe", observer, OBSERVE_MS);
  // Slow: a `getProgramAccounts` per scan, against a set that changes when
  // somebody lists something. A minute late to notice is a minute of the
  // lister's countdown, which is the right thing to trade for the call.
  loop("discover", discoverMarkets, DISCOVER_MS);
  loop("rewards", syncRewards, REWARDS_MS);

  /// --- connected wallets -------------------------------------------------
///
/// The server builds the transaction and the wallet signs it. It never sees a
/// private key, and the client never has to know the pool PDAs, the oracle
/// accounts or the lookup table.

/// Serialises an unsigned v0 transaction for `owner` to sign.
async function buildTx(
  owner: PublicKey,
  instructions: TransactionInstruction[],
  tables: AddressLookupTableAccount[] = []
) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: owner, recentBlockhash: blockhash, instructions,
  }).compileToV0Message(tables);
  const tx = new VersionedTransaction(msg);
  return {
    tx: Buffer.from(tx.serialize()).toString("base64"),
    blockhash,
    lastValidBlockHeight,
  };
}

/// Token accounts are created by the same transaction that needs them, so a
/// fresh wallet's first trade does not fail on a missing ATA.
async function ataIxs(owner: PublicKey, mints: PublicKey[]) {
  const ixs: TransactionInstruction[] = [];
  for (const mint of mints) {
    const addr = ata(owner, mint);
    if (await conn.getAccountInfo(addr)) continue;
    ixs.push(createAssociatedTokenAccountInstruction(owner, addr, owner, mint));
  }
  return ixs;
}

/// What a pool looks like to the program that would be listed against it.
///
/// Read before anything is signed, because the two numbers in the answer are
/// the two the lister is actually choosing: the price their market will mark
/// against, and the depth that caps what it may ever cost the LPs.
/// Pools a tester can list a market on, for the list page to offer. Empty
/// anywhere but the testnet, where every real pool is on another chain.
app.get("/api/testnet-pools", async (_req, res) => {
  const listed = new Set(Object.values(rt).map((m) => m.observed?.source?.toBase58()).filter(Boolean));
  res.json(seeded.map((s) => ({ symbol: s.symbol, name: s.name, pool: s.pair, listed: listed.has(s.pair) })));
});

app.get("/api/pool/:address", async (req, res) => {
  try {
    const address = new PublicKey(req.params.address);
    // The listing page searches mainnet, and this chain holds only the pools
    // somebody cloned onto it. A pool that is not here is answered by the
    // deployed site's mainnet preview, verbatim: same readers, same policy,
    // and `readOnly` set, which is how the page knows to describe the market
    // and hold back the signature. Only a pool this chain can actually list
    // against comes back without it.
    const info = await conn.getAccountInfo(address);
    if (!info || !(info.owner.equals(RAYDIUM_CLMM) || info.owner.equals(METEORA_DLMM))) {
      const r = await mainnetPoolPreview(
        new Request(`http://localhost/api/pool/${address.toBase58()}`));
      return res.status(r.status).json(await r.json());
    }
    const p = await readPool(conn, address, usdcMint);
    // The parameters this pool would actually get, resolved here rather than
    // recomputed in the page: the policy lives in one place, and a preview that
    // disagreed with the listing would be the worst kind of wrong.
    const params = listingParams(p.depthUsd);
    res.json({
      ...p,
      // What it will be listed as, derived exactly as the listing derives it.
      ...(await listingName(p.base, p.address, p.unitExp)),
      unitLabel: unitLabel(p.unitExp),
      // The budget a market opened against this pool would be held to. Shown
      // now rather than after listing, because it is the number that decides
      // whether the market is worth opening at all.
      budgetUsd: p.depthUsd,
      maxOiUsd: num(params.maxOiLongUsd) / 1e6,
      minOiUsd: listingLimits(p.depthUsd).minOiUsd,
      maxLeverage: params.maxLeverageBps / BPS,
      // Zero when the pool's own history opens the market at listing.
      // This process is the mark keeper, so every listing opens on the first
      // price it pushes, within one observe pass, history or not.
      opensAtListing: true,
      seasonSec: 0,
      readingsNeeded: MIN_OBSERVATIONS,
      backerFeeShareBps: BACKER_FEE_SHARE_BPS,
    });
  } catch (e: any) { res.status(400).json({ error: e.message ?? String(e) }); }
});

/// Lists and backs a market against a pool, for the connected wallet to sign.
///
/// The listing is three instructions in one transaction, because two of them
/// are useless alone: a market with no observation can never be priced, and an observation
/// with no batch has nowhere to collect orders. Sending them separately leaves
/// whichever landed as an account somebody paid rent for and nothing else.
///
/// The server signs none of it. Listing is the lister's transaction, paid for
/// and owned by them, which is the only arrangement under which "anyone can
/// list" means anything.
app.post("/api/tx/list-market", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const source = new PublicKey(req.body.pool);
    const p = await readPool(conn, source, usdcMint);
    // The token's own name, not the request's. See `listingName`.
    const { symbol } = await listingName(p.base, p.address, p.unitExp);
    if (p.depthUsd <= 0) {
      return res.status(400).json({
        error: "that pool has no active liquidity, so a market on it could never quote",
      });
    }

    // No feed, so the id is the hash of "amm:" and the pool's raw address,
    // keyed to the pool so the same pool is the same market however many
    // people try to list it. The program checks it (`observed_feed_id`), which
    // keeps an AMM market off any address a Pyth feed would claim.
    const feedId = crypto.createHash("sha256")
      .update(Buffer.concat([Buffer.from("amm:"), source.toBuffer()])).digest();
    const market = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), pool.toBuffer(), feedId], program.programId)[0];
    if (await conn.getAccountInfo(market)) {
      return res.status(400).json({ error: "that pool already has a market" });
    }
    const observation = observationPda(market);
    const batch = batchPda(market);

    const list = await program.methods
      .addMarket({
        symbol: Array.from(
          Buffer.concat([Buffer.from(symbol), Buffer.alloc(16)]).subarray(0, 16)),
        feedId: Array.from(feedId),
        // The lister's leverage and size, in the units the request carries
        // them: a multiple, and dollars.
        ...listingParams(p.depthUsd, {
          leverageBps: Number(req.body.maxLeverage) * BPS,
          oiUsd: Number(req.body.maxOiUsd),
        }),
        priceSource: 1,
        observation,
      })
      .accounts({ payer: owner, pool, market, systemProgram: SystemProgram.programId })
      .instruction();

    const observe = await program.methods
      .createObservation({
        source,
        sourceKind: p.dex === "meteora-dlmm" ? SOURCE_KIND.meteoraDlmm : SOURCE_KIND.raydiumClmm,
        quoteIsToken0: p.quoteIsToken0,
        // Slow fold and a tight per-reading clamp: the mark is meant to cost
        // time to move, and these two are the whole of what that costs.
        alphaBps: 500,
        maxMoveBps: 100,
        // Chosen from the pool's own price, so a memecoin is marked per
        // million rather than as a row of zeros. Fixed for the market's life.
        unitExp: p.unitExp,
      })
      .accounts({
        payer: owner, pool, market, observation, source,
        systemProgram: SystemProgram.programId,
      })
      // A DLMM pair records no decimals, so the program reads them off the
      // two mints, X then Y, and checks they are the pair's own. A Raydium
      // pool hands over its history ring instead, which opens the market at
      // listing when it reaches back far enough.
      .remainingAccounts(p.dex === "meteora-dlmm"
        ? [p.mint0, p.mint1].map((m) => ({
          pubkey: new PublicKey(m), isSigner: false, isWritable: false }))
        : p.history
          ? [{ pubkey: new PublicKey(p.history), isSigner: false, isWritable: false }]
          : [])
      .instruction();

    const open = await program.methods.createBatch()
      .accounts({ payer: owner, pool, market, batch,
                  systemProgram: SystemProgram.programId })
      .instruction();

    // The lister's own backing rides in the same transaction, so what lands
    // is a market that can trade once it has seasoned, or nothing at all.
    const b = await backingIxs(owner, market, req.body.payWith, req.body.backing);
    if (b.usd < MIN_LISTING_BACKING_USD) {
      return res.status(400).json({
        error: `back it with at least $${MIN_LISTING_BACKING_USD}; this is about $${b.usd.toFixed(2)}`,
      });
    }

    res.json({
      ...(await buildTx(owner, [list, observe, open, ...b.ixs])),
      symbol,
      market: market.toBase58(),
      observation: observation.toBase58(),
      budgetUsd: p.depthUsd,
      backedUsd: b.usd,
    });
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/*
 * What a backer may pay in, and where it goes.
 *
 * USDC into the pool's vault, as it always was; SOL and USDT into custodies
 * of their own, JLP-style, and held as what they are. Nothing is swapped. SOL
 * is wrapped on the way in and unwrapped on the way out, in the same
 * transaction, so to the backer it is SOL throughout.
 */
const PAY_DECIMALS: Record<string, number> = { USDC: 6, USDT: 6, SOL: 9 };

/// The instructions that post `amount` of `payWith` behind `market`, and
/// roughly what that is worth in dollars at the last price.
async function backingIxs(owner: PublicKey, market: PublicKey, payWith: unknown, amount: unknown) {
  const n = Number(amount);
  if (!(n > 0)) throw new Error("amount must be positive");
  const pay = String(payWith ?? "USDC").toUpperCase();
  if (!(pay in PAY_DECIMALS)) throw new Error("back with SOL, USDC or USDT");

  if (!custodies.length) await loadCustodies();
  const c = pay === "USDC" ? null : custodies.find((x) => x.symbol === pay);
  if (pay !== "USDC" && !c) throw new Error(`this pool does not hold ${pay} yet`);
  const mint = c ? c.mint : usdcMint;
  const units = baseUnits(n, PAY_DECIMALS[pay]);
  const ownerToken = ata(owner, mint);

  const pre: TransactionInstruction[] = [];
  const post: TransactionInstruction[] = [];
  if (pay === "SOL") {
    pre.push(
      createAssociatedTokenAccountIdempotentInstruction(owner, ownerToken, owner, NATIVE_MINT),
      SystemProgram.transfer({
        fromPubkey: owner, toPubkey: ownerToken, lamports: BigInt(units.toString()),
      }),
      createSyncNativeInstruction(ownerToken),
    );
    // Whatever wrapped SOL is left goes back to the wallet as SOL.
    post.push(createCloseAccountInstruction(ownerToken, owner, owner));
  } else {
    pre.push(createAssociatedTokenAccountIdempotentInstruction(owner, ownerToken, owner, mint));
  }

  const ix = await program.methods.backMarket(units)
    .accounts({
      owner, pool, market, backing: backingPda(market, owner),
      book: backingBookPda(program.programId, market),
      depositMint: mint, depositVault: c ? c.vault : usdcVault, ownerToken,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(custodyPairs(true))
    .instruction();

  const price = pay === "USDC" ? 1 : custodyPrice[pay] ?? 0;
  if (!(price > 0)) throw new Error(`no ${pay} price yet; try again in a few seconds`);
  return { ixs: [...pre, ix, ...post], usd: n * price };
}

/*
 * Referrals and points.
 *
 * Settlement leaves what a referrer or a market's deployer is owed on the
 * referee's `Trader` and on the market, so it never needs their accounts.
 * This moves it across on a slow loop. Both syncs are permissionless and can
 * only pay the account the program says is owed, so running them costs the
 * server fees and nothing else.
 */

async function syncRewards() {
  const ixs: TransactionInstruction[] = [];
  tradersMemo = null;
  const traders = await allTraders();
  rollWeek(traders);
  const known = new Set(traders.map((t) => t.owner.toBase58()));
  for (const t of traders) {
    if (t.referrer.equals(PublicKey.default)) continue;
    if (num(t.referrerPointsOwed) === 0 && num(t.referrerRewardsOwed) === 0) continue;
    ixs.push(await program.methods.syncReferral()
      .accounts({ referee: traderPda(t.owner), referrer: traderPda(t.referrer) })
      .instruction());
  }
  for (const m of Object.values(rt)) {
    const acc: any = await program.account.market.fetch(m.address);
    // A deployer with no `Trader` has nowhere to be paid; it waits on the
    // market until they make one.
    if (!known.has(acc.deployer.toBase58())) continue;
    if (num(acc.deployerRewardsUsd) === 0 && num(acc.volumeUsd) === num(acc.deployerSyncedVolumeUsd)) continue;
    ixs.push(await program.methods.syncDeployer()
      .accounts({ market: m.address, deployer: traderPda(acc.deployer) })
      .instruction());
  }
  for (const group of packInstructions(ixs, authority.publicKey)) {
    await provider.sendAndConfirm(new Transaction().add(...withComputeLimit(group)))
      .catch((e: any) => console.warn(`rewards: ${explain(e)}`));
  }
}

/// Every `Trader`, read at most every fifteen seconds. The rewards page, the
/// leaderboard and the sync loop all want the whole set, and it is one
/// `getProgramAccounts` a read.
let tradersMemo: { at: number; rows: any[] } | null = null;
async function allTraders(): Promise<any[]> {
  if (tradersMemo && Date.now() - tradersMemo.at < 15_000) return tradersMemo.rows;
  const rows = (await program.account.trader.all()).map((r: any) => r.account);
  tradersMemo = { at: Date.now(), rows };
  return rows;
}

/// A wallet's points as of now: what the program has counted, plus what its
/// backing and pool stakes have earned since they were last brought up to
/// date. Mirrors `stake_points` in the program.
const livePoints = (t: any, now = Math.floor(Date.now() / 1000)) =>
  num(t.points) / 1e6 +
  pendingStakePoints(num(t.backingUsd) / 1e6, 2, num(t.backingTs), now) +
  pendingStakePoints(num(t.lpUsd) / 1e6, 1, num(t.lpTs), now);

/*
 * Weekly standings.
 *
 * Points are an all-time total on chain; a week is a view over it. The first
 * read after Monday 00:00 UTC stores every wallet's total as the week's
 * baseline, and "this week" is the distance from it. Kept on disk so a
 * restart mid-week does not reset the week.
 */
const WEEK_FILE = path.join(__dirname, "..", ".cache", "points-week.json");
let week: { start: number; base: Record<string, number> } = { start: 0, base: {} };
try { week = JSON.parse(fs.readFileSync(WEEK_FILE, "utf8")); } catch { /* first run */ }
const weekStart = (ms = Date.now()) => {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday is 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day) / 1000;
};
function rollWeek(traders: any[]) {
  const start = weekStart();
  if (week.start === start) return;
  // With no week on record at all, everything so far counts as this week:
  // on a fresh pool it was all earned in it, and a baseline taken now would
  // zero out whoever arrived before the first read.
  if (week.start === 0) {
    week = { start, base: {} };
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  week = {
    start,
    base: Object.fromEntries(traders.map((t) => [t.owner.toBase58(), livePoints(t, now)])),
  };
  try {
    fs.mkdirSync(path.dirname(WEEK_FILE), { recursive: true });
    fs.writeFileSync(WEEK_FILE, JSON.stringify(week));
  } catch (e: any) { console.warn(`points week: ${e?.message ?? e}`); }
}

const HOUSE = new Set([authority, lp, trader].map((k) => k.publicKey.toBase58()));

const shortKey = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

/// A wallet's referral standing and points, as the program keeps them.
app.get("/api/rewards", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const now = Math.floor(Date.now() / 1000);
    const t: any = await program.account.trader.fetchNullable(traderPda(owner));

    // The markets this wallet opened, with what each has earned it.
    const listed: {
      symbol: string; volume: number; earned: number; pending: number; pendingPoints: number;
    }[] = [];
    for (const m of Object.values(rt)) {
      const acc: any = await program.account.market.fetch(m.address);
      if (!acc.deployer.equals(owner)) continue;
      listed.push({
        symbol: m.symbol,
        volume: num(acc.volumeUsd) / 1e6,
        earned: num(acc.deployerEarnedUsd) / 1e6,
        pending: num(acc.deployerRewardsUsd) / 1e6,
        pendingPoints: (num(acc.volumeUsd) - num(acc.deployerSyncedVolumeUsd)) / 1e6 * 0.1,
      });
    }
    const listingPending = listed.reduce((a, m) => a + m.pending, 0);
    const listingPendingPoints = listed.reduce((a, m) => a + m.pendingPoints, 0);
    const listingVolume = listed.reduce((a, m) => a + m.volume, 0);

    // Everyone who named this wallet, and what each has earned it so far.
    const referees = (await allTraders())
      .filter((r) => r.referrer.equals(owner))
      .map((r) => ({
        wallet: r.owner.toBase58(),
        code: r.code[0] ? codeText(r.code) : null,
        volume: num(r.volumeUsd) / 1e6,
        points: num(r.givenToReferrerPoints) / 1e6,
        usdc: num(r.givenToReferrerUsd) / 1e6,
        since: num(r.createdTs),
      }))
      .sort((a, b) => b.volume - a.volume);

    const base = {
      account: traderPda(owner).toBase58(), asOf: now, listed, listingVolume, referees,
    };
    if (!t) {
      return res.json({
        ...base, exists: false, code: null, referrer: null, referralCount: 0,
        points: listingPendingPoints, perDay: { backing: 0, lp: 0 },
        breakdown: { trading: 0, referrals: 0, listing: listingPendingPoints, stakes: 0 },
        volume: 0, referredVolume: 0, feesSaved: 0,
        claimable: listingPending, claimed: 0, earned: { referrals: 0, listing: 0 },
        backing: 0, lp: 0, canSetReferrer: true,
      });
    }

    let referrerCode: string | null = null;
    if (!t.referrer.equals(PublicKey.default)) {
      const r: any = await program.account.trader.fetchNullable(traderPda(t.referrer));
      referrerCode = r && r.code[0] ? codeText(r.code) : null;
    }
    const points = livePoints(t, now) + listingPendingPoints;
    // Where the total came from. Trading and referral points are exact; the
    // listing share is what has been synced plus what is waiting; the stakes
    // are the rest, which is what time in backing and the pool has earned.
    const trading = num(t.volumeUsd) / 1e6;
    const referrals = num(t.referredVolumeUsd) / 1e6 * 0.1;
    const listing = listed.reduce((a, m) => a + (m.volume * 0.1), 0);
    res.json({
      ...base,
      exists: true,
      code: t.code[0] ? codeText(t.code) : null,
      referrer: t.referrer.equals(PublicKey.default) ? null : t.referrer.toBase58(),
      referrerCode,
      referralCount: t.referralCount,
      points,
      // What the page adds per second between reads. Trading, referral and
      // listing points arrive in steps, so only the stakes tick.
      perDay: { backing: num(t.backingUsd) / 1e6 * 2, lp: num(t.lpUsd) / 1e6 },
      breakdown: {
        trading, referrals, listing,
        stakes: Math.max(0, points - trading - referrals - listing),
      },
      volume: trading,
      referredVolume: num(t.referredVolumeUsd) / 1e6,
      feesSaved: num(t.feesSavedUsd) / 1e6,
      claimable: num(t.rewardsUsd) / 1e6 + listingPending,
      claimed: num(t.rewardsClaimedUsd) / 1e6,
      earned: {
        referrals: num(t.referralEarnedUsd) / 1e6,
        listing: num(t.listingEarnedUsd) / 1e6 + listingPending,
      },
      backing: num(t.backingUsd) / 1e6,
      lp: num(t.lpUsd) / 1e6,
      // A new wallet can still name a referrer; one that has traded cannot.
      canSetReferrer: t.referrer.equals(PublicKey.default) && num(t.volumeUsd) === 0,
    });
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/// Everyone's points, ranked, with the asking wallet's own row.
///
/// `concentration` is published on purpose: the share the top twenty hold is
/// the first thing anyone suspicious of a points program asks, and it is
/// better answered here than worked out by someone else.
app.get("/api/leaderboard", async (req, res) => {
  try {
    const traders = await allTraders();
    rollWeek(traders);
    const now = Math.floor(Date.now() / 1000);
    const rows = traders
      // The server's own wallets (the testnet's market maker, the demo
      // account, the pool authority) trade and provide liquidity to keep the
      // venue running. Ranking them would put the house at the top of its own
      // leaderboard.
      .filter((t) => !HOUSE.has(t.owner.toBase58()))
      .map((t) => {
        const wallet = t.owner.toBase58();
        const points = livePoints(t, now);
        return {
          wallet, short: shortKey(wallet), code: t.code[0] ? codeText(t.code) : null,
          points, week: Math.max(0, points - (week.base[wallet] ?? 0)),
          volume: num(t.volumeUsd) / 1e6,
        };
      })
      .filter((r) => r.points > 0);
    // What the program has paid out so far, for the page's header strip:
    // every referral share and every deployer share, claimed or not.
    // This pool's markets only: markets from pools the program has outlived
    // are still on chain, in older layouts that no longer decode.
    const markets: any[] = (await program.account.market.all([
      { memcmp: { offset: 9, bytes: pool.toBase58() } },
    ])).map((m: any) => m.account);
    const paidUsd =
      traders.reduce((a, t) => a + num(t.givenToReferrerUsd), 0) / 1e6 +
      markets.reduce((a, m) => a + num(m.deployerEarnedUsd), 0) / 1e6;
    const allPoints = traders.reduce((a, t) => a + livePoints(t, now), 0);
    const by = req.query.period === "week" ? "week" : "points";
    rows.sort((a, b) => b[by] - a[by]);
    const total = rows.reduce((a, r) => a + r[by], 0);
    const top20 = rows.slice(0, 20).reduce((a, r) => a + r[by], 0);
    const me = req.query.owner ? String(req.query.owner) : null;
    const mine = me ? rows.findIndex((r) => r.wallet === me) : -1;
    res.json({
      period: by === "week" ? "week" : "all",
      weekStart: week.start,
      paidUsd,
      allPoints,
      wallets: rows.length,
      total,
      concentration: total > 0 ? top20 / total : 0,
      top: rows.slice(0, 25).map((r, i) => ({ rank: i + 1, ...r })),
      me: mine >= 0 ? { rank: mine + 1, ...rows[mine], percentile: 1 - mine / rows.length } : null,
    });
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/// Whether a code is free, and whose it is if not.
app.get("/api/referral-code/:code", async (req, res) => {
  const c = String(req.params.code).toLowerCase();
  if (!CODE_RE.test(c)) return res.json({ valid: false, owner: null });
  const rc: any = await program.account.referralCode.fetchNullable(referralCodePda(c))
    .catch(() => null);
  res.json({ valid: true, owner: rc ? rc.owner.toBase58() : null });
});

app.post("/api/tx/referral-code", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const c = String(req.body.code ?? "").toLowerCase();
    if (!CODE_RE.test(c)) throw new Error("codes are 3 to 16 of a-z, 0-9, _ and -");
    const ix = await program.methods.claimReferralCode(codeBytes(c))
      .accounts({ owner, trader: traderPda(owner), referralCode: referralCodePda(c) })
      .instruction();
    res.json(await buildTx(owner, [ix]));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/// Names a referrer without trading, for a wallet that arrived on a link.
app.post("/api/tx/set-referrer", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const ixs = await referrerIx(owner, req.body.code);
    if (!ixs.length) throw new Error("that code cannot be used by this wallet");
    res.json(await buildTx(owner, ixs));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/// Collects what the wallet's listings have earned, then pays out everything.
app.post("/api/tx/claim-rewards", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const ixs: TransactionInstruction[] = [
      await program.methods.createTrader()
        .accounts({ owner, trader: traderPda(owner) }).instruction(),
    ];
    for (const m of Object.values(rt)) {
      const acc: any = await program.account.market.fetch(m.address);
      if (!acc.deployer.equals(owner)) continue;
      ixs.push(await program.methods.syncDeployer()
        .accounts({ market: m.address, deployer: traderPda(owner) }).instruction());
    }
    ixs.push(await program.methods.claimRewards()
      .accounts({
        owner, pool, trader: traderPda(owner), usdcMint, usdcVault,
        ownerUsdc: ata(owner, usdcMint), tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction());
    res.json(await buildTx(owner, [...(await ataIxs(owner, [usdcMint])), ...ixs]));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/// Underwrites a market, for the connected wallet to sign.
///
/// The pool authority is not on this transaction. That is the point: a market
/// somebody listed used to need us to grant it an allowance before it could
/// take a position, which made "anyone can list" true only in the narrow sense
/// that anyone could create an account nobody could trade.
///
/// `payWith` is USDC, USDT or SOL, and `amount` is in that token.
app.post("/api/tx/back-market", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const m = rt[req.body.symbol];
    if (!m) return res.status(404).json({ error: "unknown market" });
    const b = await backingIxs(owner, m.address, req.body.payWith, req.body.amount);
    res.json({ ...(await buildTx(owner, b.ixs)), backedUsd: b.usd });
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/*
 * The vault, for a wallet to sign.
 *
 * Deposits and withdrawals used to exist only as `/api/deposit` and
 * `/api/withdraw`, which the server signs with the demo keypair. That was the
 * whole of it: a connected wallet had no way to put its own USDC into the pool
 * -- the ticket's Deposit button asked for `/api/tx/deposit`, which did not
 * exist. These build the same instructions with the caller as the signer, so
 * the money and the LP token are theirs.
 *
 * Every market account rides along as remaining accounts because the program
 * values the pool against open interest in all of them before it prices a
 * share. The budget is raised for the same reason: that walk is the expensive
 * part, not the transfer.
 */
const LIQUIDITY_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });

app.post("/api/tx/deposit", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const amount = Number(req.body.amount);
    if (!(amount > 0)) return res.status(400).json({ error: "amount must be positive" });
    const accounts = await allMarketAccounts();
    const ix = await program.methods
      .addLiquidity(USD(amount), new BN(0))
      .accounts(liquidityAccounts(owner))
      .remainingAccounts(accounts).instruction();
    res.json(await buildTx(owner,
      [LIQUIDITY_CU, ...(await ataIxs(owner, [usdcMint, lpMint])), ix],
      await tablesFor(accounts)));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/// Takes LP tokens, not dollars: the instruction burns shares, and what they
/// are worth is decided by the pool at the moment it runs, not by the page.
app.post("/api/tx/withdraw", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const lp = Number(req.body.lpAmount);
    if (!(lp > 0)) return res.status(400).json({ error: "amount must be positive" });
    const accounts = await allMarketAccounts();
    const ix = await program.methods
      .removeLiquidity(USD(lp), new BN(0))
      .accounts(liquidityAccounts(owner))
      .remainingAccounts(accounts).instruction();
    res.json(await buildTx(owner,
      [LIQUIDITY_CU, ...(await ataIxs(owner, [usdcMint])), ix],
      await tablesFor(accounts)));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/*
 * What one owner has put behind each market.
 *
 * A backing is a claim on a share of that market's first-loss pot, so its
 * value moves when the market pays out or earns: shares times what the pot
 * holds per share now, not what was deposited.
 */
app.get("/api/backings", async (req, res) => {
  try {
    const owner = ownerOf(req);
    await loadBooks();
    const out: any[] = [];
    for (const m of Object.values(rt)) {
      const b: any = await program.account.backing.fetchNullable(backingPda(m.address, owner));
      if (!b || num(b.shares) === 0) continue;
      const ma: any = await program.account.market.fetch(m.address);
      const total = num(ma.backingShares);
      const part = total > 0 ? num(b.shares) / total : 0;
      // What those shares are a claim on, token by token: the pot's USDC and
      // everything it holds in kind, in the proportion the shares are of it.
      // Withdrawing pays exactly this mix.
      const held: Record<string, number> = { USDC: part * num(ma.backingUsd) / 1e6 };
      for (const [sym, amt] of Object.entries(books[m.address.toBase58()]?.amounts ?? {})) {
        if (amt > 0) held[sym] = part * amt;
      }
      const value = part * potUsd(m.address, ma.backingUsd);
      const deposited = num(b.depositedUsd) / 1e6;
      out.push({
        symbol: m.symbol,
        shares: num(b.shares) / 1e6,
        value,
        // Posted, in dollars at the time of each deposit. `value - deposited`
        // is everything since: fee income, losses the market's traders took
        // out of it, and for SOL the move in its price.
        deposited,
        held,
        // The market's own state, so the row can say whether this backing is
        // doing anything yet.
        budgetUsd: num(ma.lossBudgetUsd) / 1e6,
        tradeable: m.observed ? m.observed.seasoned && num(ma.lossBudgetUsd) > 0 : true,
        opening: !!m.observed && !m.observed.seasoned,
      });
    }
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/// Withdraws backing. Asked for in dollars, sent as shares, and capped at what
/// the owner holds -- the program refuses anything the market's open
/// positions still need, and says so.
app.post("/api/tx/unback-market", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const m = rt[req.body.symbol];
    if (!m) return res.status(404).json({ error: "unknown market" });
    const b: any = await program.account.backing.fetchNullable(backingPda(m.address, owner));
    if (!b || num(b.shares) === 0) return res.status(400).json({ error: "nothing backed here" });
    const ma: any = await program.account.market.fetch(m.address);
    await loadCustodies();
    await loadBooks();
    const held = BigInt(b.shares.toString());
    const all = req.body.all === true;
    const usd = Number(req.body.amount);
    if (!all && !(usd > 0)) return res.status(400).json({ error: "amount must be positive" });
    // Priced against the whole pot, in kind included, as the program prices it.
    const pot = BigInt(Math.floor(potUsd(m.address, ma.backingUsd) * 1e6));
    const totalShares = BigInt(ma.backingShares.toString());
    const want = all || pot === 0n ? held
      : (BigInt(Math.floor(usd * 1e6)) * totalShares) / pot;
    const shares = want > held ? held : want;

    // Paid back in the mix it is held in, so every token needs somewhere to
    // land; wrapped SOL is unwrapped straight after.
    const payouts = custodies.flatMap((c) => [
      { pubkey: c.mint, isWritable: false, isSigner: false },
      { pubkey: c.vault, isWritable: true, isSigner: false },
      { pubkey: ata(owner, c.mint), isWritable: true, isSigner: false },
    ]);
    const ix = await program.methods.unbackMarket(new BN(shares.toString()))
      .accounts({
        owner, pool, market: m.address, backing: backingPda(m.address, owner),
        book: backingBookPda(program.programId, m.address),
        // Withdrawals must leave the market covering what its traders are up.
        priceUpdate: oracleOf(m),
        usdcMint, usdcVault, ownerUsdc: ata(owner, usdcMint),
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([...custodyPairs(true), ...payouts])
      .instruction();
    const atas = [usdcMint, ...custodies.map((c) => c.mint)].map((mint) =>
      createAssociatedTokenAccountIdempotentInstruction(owner, ata(owner, mint), owner, mint));
    const sol = custodies.find((c) => c.symbol === "SOL");
    res.json(await buildTx(owner, [
      ...atas, ix,
      ...(sol ? [createCloseAccountInstruction(ata(owner, NATIVE_MINT), owner, owner)] : []),
    ]));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/*
 * What each vault's share is worth, over time, and the APY that falls out.
 *
 * Neither vault has a yield to read off the chain. The pool's share price
 * moves with the fees it keeps and the PnL it absorbs; a market's backing is
 * worth `backing_usd / backing_shares`, which rises as that market credits
 * backers their cut of every fee and falls when its traders win. So the only
 * honest APY is that value per share, watched: sampled every few minutes,
 * kept for a week, written to disk so a restart does not throw the history
 * away, and annualized over whatever of that week exists.
 *
 * Simple annualization, not compounded. Over a window of hours, compounding
 * turns a single fee into a number with four digits; this states the rate the
 * window actually ran at, scaled to a year, and says how long the window was.
 * Under an hour there is not enough to scale from and it reports none.
 */
const TAPE_FILE = path.join(__dirname, "..", ".cache", "vault-tape.json");
const TAPE_EVERY_MS = 2 * 60_000;
const TAPE_KEEP_MS = 7 * 86_400_000;
const APY_MIN_HOURS = 1;
type TapeRow = { t: number; pool: number; markets: Record<string, number> };
let tape: TapeRow[] = [];
try { tape = JSON.parse(fs.readFileSync(TAPE_FILE, "utf8")); } catch { tape = []; }

async function recordTape() {
  try {
    const [p, supply, all] = await Promise.all([
      program.account.pool.fetch(pool), conn.getTokenSupply(lpMint),
      // This pool's markets only: the program also owns markets from earlier
      // pools, some in layouts this build can no longer decode.
      program.account.market.all([{ memcmp: { offset: 9, bytes: pool.toBase58() } }]),
    ]);
    const lpSupply = Number(supply.value.amount) / 1e6;
    const aum = num(p.liquidityUsd) / 1e6 - (await traderPnlNow())
      + custodies.reduce((s, c) => s + c.lpAmount * (custodyPrice[c.symbol] ?? 0), 0);
    const row: TapeRow = { t: Date.now(), pool: lpSupply > 0 ? aum / lpSupply : 1, markets: {} };
    for (const { publicKey, account } of all as any[]) {
      const m = Object.values(rt).find((r) => r.address.equals(publicKey));
      const shares = num(account.backingShares);
      if (m && shares > 0) row.markets[m.symbol] = (potUsd(publicKey, account.backingUsd) * 1e6) / shares;
    }
    tape.push(row);
    tape = tape.filter((r) => r.t >= Date.now() - TAPE_KEEP_MS);
    fs.mkdirSync(path.dirname(TAPE_FILE), { recursive: true });
    fs.writeFileSync(TAPE_FILE, JSON.stringify(tape));
  } catch (e: any) { console.warn("vault tape:", e.message ?? e); }
}

function apyOf(get: (r: TapeRow) => number | undefined) {
  const last = tape[tape.length - 1];
  const now = last && get(last);
  if (!now) return null;
  const first = tape.find((r) => (get(r) ?? 0) > 0)!;
  const hours = (last.t - first.t) / 3.6e6;
  if (hours < APY_MIN_HOURS) return { apy: null, hours };
  return { apy: (now / get(first)! - 1) * (8760 / hours) * 100, hours };
}

app.get("/api/apy", (_req, res) => {
  const markets: Record<string, { apy: number | null; hours: number }> = {};
  for (const m of Object.values(rt)) {
    const a = apyOf((r) => r.markets[m.symbol]);
    if (a) markets[m.symbol] = a;
  }
  res.json({ pool: apyOf((r) => r.pool), markets });
});

app.post("/api/tx/order", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const { symbol, isLong, collateral, size } = req.body;
    const m = rt[symbol];
    if (!m) return res.status(404).json({ error: "unknown market" });
    const maker = !!req.body.maker;
    if (maker && !Number(req.body.price)) throw new Error("a maker order needs a price");
    const limit = Number(req.body.price) || marketLimit(m, !!isLong);
    const ix = await program.methods
      .submitOrder(USD(limit), USD(Number(size)), USD(Number(collateral)), !!isLong, false, maker)
      .accounts(orderAccounts(m, owner)).instruction();
    // A wallet that arrived on a referral link names its referrer with its
    // first order, so the discount applies to that order too.
    const ref = await referrerIx(owner, req.body.ref).catch(() => []);
    res.json(await buildTx(owner, [...(await ataIxs(owner, [usdcMint])), ...ref, ix]));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

app.post("/api/tx/close", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const m = rt[req.body.symbol];
    if (!m) return res.status(404).json({ error: "unknown market" });
    const { builder } = await closeOrder(m, owner, Number(req.body.size || 0));
    res.json(await buildTx(owner, [await builder.instruction()]));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

for (const [route, method] of [["deposit", "addLiquidity"], ["withdraw", "removeLiquidity"]] as const) {
  app.post(`/api/tx/${route}`, async (req, res) => {
    try {
      const owner = ownerOf(req);
      const accounts = await allMarketAccounts();
      const ix = await (program.methods as any)[method](USD(Number(req.body.amount)), new BN(0))
        .accounts(liquidityAccounts(owner))
        .remainingAccounts(accounts).instruction();
      res.json(await buildTx(owner, [
        ...(await ataIxs(owner, [usdcMint, lpMint])),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ix,
      ], await tablesFor(accounts)));
    } catch (e: any) { res.status(400).json({ error: explain(e) }); }
  });
}

/// Submits a wallet-signed transaction. Kept server-side so the client does not
/// need its own RPC endpoint, and so failures come back already explained.
app.post("/api/tx/send", async (req, res) => {
  try {
    const raw = Buffer.from(String(req.body.tx), "base64");
    const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
    await conn.confirmTransaction({
      signature: sig,
      blockhash: req.body.blockhash,
      lastValidBlockHeight: req.body.lastValidBlockHeight,
    }, "confirmed");
    // Whatever it changed, no page should be shown the balance from before it.
    accountMemo.clear();
    if (req.body.record?.symbol) {
      const r = req.body.record;
      if (rt[r.symbol]) {
        recordTrade({ symbol: r.symbol, side: r.side, size: Number(r.size),
                      price: px(rt[r.symbol]), kind: r.kind });
      }
    }
    res.json({ ok: true, sig });
  } catch (e: any) { res.status(400).json({ ok: false, error: explain(e) }); }
});

const orderPda = (market: PublicKey, owner: PublicKey, slot: number) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("order"), market.toBuffer(), owner.toBuffer(), Buffer.from([slot])],
    program.programId
  )[0];

/// A take-profit and a stop-loss are the same instruction with the trigger on
/// opposite sides, so the client sends which one it wants and the side of the
/// position it protects.
function orderParams(body: any) {
  const isLong = !!body.isLong;
  if (body.kind === "limit") {
    // A buy limit waits for the price to come down to it, a sell limit for it
    // to come up — the mirror of how a take-profit reads.
    return {
      slot: Number(body.slot ?? 2),
      kind: 1,
      isLong,
      sizeUsd: USD(Number(body.size)),
      collateralUsd: USD(Number(body.collateral)),
      triggerPrice: USD(Number(body.triggerPrice)),
      triggerAbove: !isLong,
      expiryTs: new BN(Number(body.expiryTs ?? 0)),
    };
  }
  const takeProfit = body.kind === "tp";
  return {
    slot: takeProfit ? 0 : 1,
    kind: 0,
    isLong,
    sizeUsd: USD(Number(body.size || 0)),
    collateralUsd: new BN(0),
    triggerPrice: USD(Number(body.triggerPrice)),
    // A take-profit on a long fires above, its stop below; a short is the
    // mirror of that.
    triggerAbove: takeProfit === isLong,
    expiryTs: new BN(0),
  };
}

async function placeOrderIx(owner: PublicKey, body: any) {
  const m = rt[body.symbol];
  if (!m) throw new Error("unknown market");
  const params = orderParams(body);
  return program.methods
    .placeOrder(params)
    .accounts({
      owner, pool, market: m.address,
      order: orderPda(m.address, owner, params.slot),
      position: positionPda(m.address, owner),
      usdcMint, usdcVault, ownerUsdc: ata(owner, usdcMint),
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .instruction();
}

async function cancelOrderIx(owner: PublicKey, body: any) {
  const m = rt[body.symbol];
  if (!m) throw new Error("unknown market");
  return program.methods
    .cancelOrder()
    .accounts({
      owner, pool, order: orderPda(m.address, owner, Number(body.slot)),
      usdcMint, usdcVault, ownerUsdc: ata(owner, usdcMint),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

app.post("/api/order/trigger", async (req, res) => {
  try {
    const ix = await placeOrderIx(trader.publicKey, req.body);
    await sendV0(conn, trader, [ix]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: explain(e) }); }
});

app.post("/api/order/cancel", async (req, res) => {
  try {
    const ix = await cancelOrderIx(trader.publicKey, req.body);
    await sendV0(conn, trader, [ix]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: explain(e) }); }
});

app.post("/api/tx/order/trigger", async (req, res) => {
  try {
    const owner = ownerOf(req);
    res.json(await buildTx(owner, [await placeOrderIx(owner, req.body)]));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

app.post("/api/tx/order/cancel", async (req, res) => {
  try {
    const owner = ownerOf(req);
    res.json(await buildTx(owner, [await cancelOrderIx(owner, req.body)]));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/// Warns when the authority is running out of SOL.
///
/// It pays for every clear, settlement, price post and keeper action, so an
/// empty wallet is a venue that silently stops. Logged every pass while low,
/// and posted to `ALERT_WEBHOOK_URL` (a Discord webhook takes it as is) at
/// most every six hours, so a low balance is noticed without a flood.
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;
const ALERT_EVERY_MS = 6 * 3_600_000;
let lastAlert = 0;
async function watchBalance() {
  if (IS_LOCAL) return;
  const sol = (await conn.getBalance(authority.publicKey)) / 1e9;
  if (sol >= AUTHORITY_SOL_FLOOR) return;
  const text = `unwind ${CLUSTER}: authority ${authority.publicKey.toBase58()} has ${sol.toFixed(3)} SOL, ` +
    `below the ${AUTHORITY_SOL_FLOOR} SOL floor. The faucet has stopped sending SOL; top it up before the crank runs dry.`;
  console.warn(text);
  if (ALERT_WEBHOOK_URL && Date.now() - lastAlert >= ALERT_EVERY_MS) {
    lastAlert = Date.now();
    await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text }),
    }).catch((e: any) => console.warn(`alert: ${e?.message ?? e}`));
  }
}

/// Funds a connected wallet with test USDC, and SOL for fees.
///
/// On localnet it is unlimited, because the validator is throwaway. On the
/// testnet the USDC is still free to mint but the SOL is real devnet SOL out
/// of the authority's wallet (devnet's own airdrop is too throttled to rely
/// on), so a wallet can claim once a day, an address can make a few claims a
/// day, and the SOL handed out across everyone is capped per day. The per-IP
/// limit is soft, since the caller can set the header; the daily SOL cap is
/// what bounds the cost.
const FAUCET_USDC = Number(process.env.FAUCET_USDC ?? (IS_LOCAL ? 250_000 : 10_000));
const FAUCET_SOL = Number(process.env.FAUCET_SOL ?? (IS_LOCAL ? 2 : 0.05));
const FAUCET_SOL_PER_DAY = Number(process.env.FAUCET_SOL_PER_DAY ?? 5);
const FAUCET_PER_IP_PER_DAY = 3;
const DAY_MS = 86_400_000;
const FAUCET_FILE = path.join(ROOT, `.${CLUSTER}-faucet.json`);
/// Below this the authority keeps its SOL for the crank's own fees: a faucet
/// that drained it would stop every batch from clearing.
const AUTHORITY_SOL_FLOOR = Number(process.env.AUTHORITY_SOL_FLOOR ?? 1);
type Claim = { owner: string; ip: string; t: number; sol: number };
let claims: Claim[] = [];
try { claims = JSON.parse(fs.readFileSync(FAUCET_FILE, "utf8")); } catch { claims = []; }

app.post("/api/faucet", async (req, res) => {
  try {
    // `ownerOf` falls back to the demo trader, which is right for reads and
    // wrong for a faucet.
    if (!req.body?.owner) throw new Error("owner is required");
    const owner = ownerOf(req);
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
    const now = Date.now();
    claims = claims.filter((c) => now - c.t < DAY_MS);
    if (!IS_LOCAL) {
      const mine = claims.find((c) => c.owner === owner.toBase58());
      if (mine) {
        const hours = Math.ceil((mine.t + DAY_MS - now) / 3_600_000);
        throw new Error(`this wallet was funded today; try again in ${hours}h`);
      }
      if (claims.filter((c) => c.ip === ip).length >= FAUCET_PER_IP_PER_DAY) {
        throw new Error("too many claims from this address today");
      }
    }

    let sol = 0;
    const balance = await conn.getBalance(owner);
    if (IS_LOCAL) {
      if (balance < 0.5e9) {
        await conn.confirmTransaction(await conn.requestAirdrop(owner, FAUCET_SOL * 1e9), "confirmed");
        sol = FAUCET_SOL;
      }
    } else if (balance < (FAUCET_SOL / 2) * 1e9
      && (await conn.getBalance(authority.publicKey)) / 1e9 - FAUCET_SOL >= AUTHORITY_SOL_FLOOR) {
      const given = claims.reduce((s, c) => s + c.sol, 0);
      // Past the day's budget the wallet still gets USDC, and needs SOL from
      // devnet's own faucet to spend it.
      if (given + FAUCET_SOL <= FAUCET_SOL_PER_DAY) sol = FAUCET_SOL;
    }

    const addr = ata(owner, usdcMint);
    const ixs: TransactionInstruction[] = [];
    if (sol && !IS_LOCAL) {
      ixs.push(SystemProgram.transfer({
        fromPubkey: authority.publicKey, toPubkey: owner, lamports: Math.round(sol * 1e9),
      }));
    }
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, addr, owner, usdcMint),
      createMintToInstruction(usdcMint, addr, authority.publicKey, BigInt(FAUCET_USDC) * 1_000_000n),
    );
    await sendV0(conn, authority, ixs);
    accountMemo.delete(owner.toBase58());

    claims.push({ owner: owner.toBase58(), ip, t: now, sol: IS_LOCAL ? 0 : sol });
    if (!IS_LOCAL) fs.writeFileSync(FAUCET_FILE, JSON.stringify(claims));
    res.json({ ok: true, usdc: FAUCET_USDC, sol });
  } catch (e: any) { res.status(400).json({ ok: false, error: explain(e) }); }
});

// The web3.js connection rejects from places that are not on an await we own —
// its websocket subscriptions, most of all. Losing the process to one of those
// means losing the keeper, which is the one thing that has to stay up.
process.on("unhandledRejection", (e: any) => {
  console.warn(`unhandled: ${e?.message ?? e}`);
});
process.on("uncaughtException", (e: any) => {
  console.warn(`uncaught: ${e?.message ?? e}`);
});

/*
 * Two pages behind one bundle: `/` is the landing page, `/trade` is the app,
 * and both are that same index.html. Static assets are already served above,
 * so anything still unmatched here is a page route rather than a missing file.
 * Registered last so every API route keeps priority over it.
 */
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(ROOT, "app", "index.html"));
});

app.listen(PORT, () => {
  setTimeout(recordTape, 15_000);
  setInterval(recordTape, TAPE_EVERY_MS);
    console.log(`unwind (${CLUSTER}) on http://localhost:${PORT}`);
  // The query string is where RPC providers put the API key.
  console.log(`  rpc ${RPC_URL.split("?")[0]}`);
    console.log(`  ${LIVE.length} markets, live prices every ${TICK_MS}ms, keeper ${KEEPER_MS}ms`);
    for (const m of Object.values(rt)) {
      console.log(m.quote
        ? `  ${m.symbol.padEnd(6)} $${px(m).toFixed(2)}` +
          `  conf ${m.quote.confBps.toFixed(1)}bp  ${Session[m.session]}`
        : `  ${m.symbol.padEnd(6)} no price yet`);
    }
  });
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
