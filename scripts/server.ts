import { AsyncLocalStorage } from "node:async_hooks";
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
import { AccountInfo, Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction, createCloseAccountInstruction,
  createMintToInstruction, createSyncNativeInstruction, getAccount, getAssociatedTokenAddressSync, mintTo,
  unpackAccount, unpackMint,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Transaction, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
  TransactionExpiredBlockheightExceededError, TransactionExpiredTimeoutError,
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
import { METEORA_DLMM, RAYDIUM_CLMM, dlmmArrayKeys, isDlmmArray, readPool } from "./clmm";
import { SOURCE_KIND, clmmPrice, decodeBinArray, decodeClmm, decodeDlmmPair, dlmmPrice } from "./pools";
import { Memo, markMayRest } from "./read-cache";
import {
  BookOrder, Claim, Season, breaker, countTraders, crossOf, faucetRefusal, flowOf, fundingRates,
  indicativeCross, livePoints, markStale, markWrittenMs, notePremium, num, observedTradeable,
  payoutPct, pendingStakePoints, premiumOf, seasonStanding, weekStart,
} from "./server-logic";
import { openRefusal } from "./open-guard";
import {
  BACKER_FEE_SHARE_BPS, DEPTH_LEVERAGE_TIERS, LISTING_LEVERAGE_CEILING_BPS, MIN_LISTING_BACKING_USD, MIN_OBSERVATIONS,
  MIN_OBSERVATION_WINDOW_SEC, QUOTE_MINTS, listingLimits, unitLabel,
} from "./listing-policy";
import { GET as mainnetPoolPreview } from "../api/pool/[address]";
import { backingBookPda, baseUnits } from "./custodies";
import { readTokenMeta } from "./token-meta";
import { marketGenerationsPda, nextMarket, pickGeneration } from "./market-address";
import { marketCard } from "./og/card";
import { BROWSER_UA, IconStore, isMint } from "./token-icon";

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
/// How often every batch is checked for orders to clear. A batch is due one
/// second after it opens, so the crank runs at the same pace: any slower and
/// the crank, not the window, is what a trader waits on. One multi-account
/// read per pass, plus transactions only for batches with orders in them.
const AUCTION_MS = Number(process.env.AUCTION_MS ?? 1_000);
/// Between passes while no batch holds an order and nobody has just asked
/// for one. Polling every batch every second around the clock was the
/// largest single spend of RPC calls, and almost all of it read empty
/// batches.
const AUCTION_IDLE_MS = Number(process.env.AUCTION_IDLE_MS ?? 4_000);
/// Markets the auction is working on right now, so a pass starts each one
/// at most once.
const auctionWorking = new Set<string>();
/// How many markets the auction works at once (see `auction`). Twelve since
/// the address cache freed the CPU: at six, with twenty-odd markets due under
/// load, the rest waited for a slot, and that wait was most of the slowest
/// fills (25 to 30s at the 95th percentile).
const AUCTION_PARALLEL = Number(process.env.AUCTION_PARALLEL ?? 12);
/// How many settlement transactions one market sends at once.
const SETTLE_PARALLEL = Number(process.env.SETTLE_PARALLEL ?? 6);
/// How many marks the keeper pushes at once (see `observer`).
const MARK_PARALLEL = Number(process.env.MARK_PARALLEL ?? 8);
/// Until when the auction runs at full speed: set when a batch is seen
/// holding orders, and when this server builds an order for someone.
let auctionHotUntil = 0;
const heatAuction = (ms = 30_000) => { auctionHotUntil = Math.max(auctionHotUntil, Date.now() + ms); };
/// Set when a trader's transaction lands: the auction's next pass starts at
/// once instead of at its next tick, since an order may now be waiting.
let auctionKicked = false;
const kickAuction = () => { heatAuction(); auctionKicked = true; };
/// How often the seeded testnet pools are moved to follow their real tokens.
/// A few calls each per pass; two minutes keeps that well inside an RPC plan.
const FLOW_MS = Number(process.env.FLOW_MS ?? 120_000);
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
/// The devnet's own maker, which this process runs (see `makeMarket`). Its
/// quotes and fills are labeled as the house's wherever they are shown, so
/// nobody reads its depth or its share of the volume as somebody else's.
const HOUSE_MAKER = process.env.MAKER_BOT !== "0" ? lp.publicKey : null;
const isHouse = (owner: any) => !!HOUSE_MAKER && new PublicKey(owner).equals(HOUSE_MAKER);

/*
 * Dedicated RPCs for the testnet, without touching the state file: the
 * public devnet endpoint throttles a crank into missing batches.
 *
 * RPC_URLS takes several keys, comma separated, and requests take turns
 * across them, so a set of free plans adds up to one larger one. RPC_URL
 * alone still works as a pool of one.
 */
const RPC_ENDPOINTS = (process.env.RPC_URLS || "").split(/[\s,]+/).filter(Boolean);
const RPC_URL = RPC_ENDPOINTS[0] || process.env.RPC_URL || st.rpc;
if (!RPC_ENDPOINTS.length) RPC_ENDPOINTS.push(RPC_URL);
/*
 * Where subscriptions go. web3.js confirms every transaction over a
 * websocket it derives from the first key, and free Helius keys refuse
 * websockets with a 429: each confirm then hung for its full 30s, the price
 * posts stalled and the server never came up. On devnet the public endpoint
 * takes them, as it did before the pool; RPC_WS_URL picks another.
 */
const RPC_WS_URL = process.env.RPC_WS_URL
  || (CLUSTER === "devnet" ? "wss://api.devnet.solana.com" : undefined);
/// Where an endpoint is, without the key in its path or query, for logs.
const rpcHost = (u: string) => { try { return new URL(u).host; } catch { return "rpc"; } };
/*
 * The last resort, when every key in the pool says no.
 *
 * A dedicated provider meters by the month, and the day its cap is reached
 * every read turns into a 429 and the venue is dark until somebody notices:
 * web3.js's own retry made it worse, backing off and trying the same dead
 * endpoint again for eight seconds per call. A 429 rests that key for a
 * minute and the request moves to the next one; only with the whole pool
 * resting does it go to the fallback. The public devnet endpoint is slower
 * and throttles the crank, but a slow venue is a venue.
 */
const RPC_FALLBACK_URL = process.env.RPC_FALLBACK_URL
  || (CLUSTER === "devnet" && !RPC_URL.includes("api.devnet.solana.com")
    ? "https://api.devnet.solana.com" : "");
/// When each rate-limited key may be tried again.
const restingUntil = new Map<string, number>();
let rpcTurn = 0;
/// The next key in turn that is not resting, or null with all of them resting.
/*
 * Methods a key's plan does not serve at all. Alchemy's free tier answers
 * getProgramAccounts with a 400 rather than a 429; a refusal like that is
 * remembered for the life of the process and the method goes only to keys
 * that serve it.
 */
const refusedBy = new Map<string, Set<string>>();
const REFUSAL = /not available|not supported|not allowed|upgrade|disabled|method not found/i;
const methodsIn = (body: unknown): string[] => {
  if (typeof body !== "string") return [];
  try {
    const j = JSON.parse(body);
    return (Array.isArray(j) ? j : [j]).map((c) => String(c?.method ?? ""));
  } catch { return []; }
};

function nextEndpoint(methods: string[] = []): string | null {
  const now = Date.now();
  for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
    const at = (rpcTurn + i) % RPC_ENDPOINTS.length;
    const refused = refusedBy.get(RPC_ENDPOINTS[at]);
    if (refused && methods.some((m) => refused.has(m))) continue;
    if ((restingUntil.get(RPC_ENDPOINTS[at]) ?? 0) <= now) {
      rpcTurn = (at + 1) % RPC_ENDPOINTS.length;
      return RPC_ENDPOINTS[at];
    }
  }
  return null;
}

/*
 * The public endpoint meters connections, not only calls: a batch read
 * that fans out into thirty parallel requests is refused outright with
 * "Connection rate limits exceeded", however few calls a minute it makes.
 * Requests to it go through a short queue instead, a few in flight at a
 * time and a breath between them. A dedicated endpoint is not queued.
 */
const PUBLIC_RPC = /api\.(devnet|mainnet-beta|testnet)\.solana\.com/;
const QUEUE_WIDTH = 4;
const QUEUE_GAP_MS = 60;
let inFlight = 0;
let lastStart = 0;
const waiting: (() => void)[] = [];
async function queued<T>(run: () => Promise<T>): Promise<T> {
  if (inFlight >= QUEUE_WIDTH) await new Promise<void>((ok) => waiting.push(ok));
  inFlight++;
  const wait = lastStart + QUEUE_GAP_MS - Date.now();
  if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
  lastStart = Date.now();
  try { return await run(); } finally {
    inFlight--;
    waiting.shift()?.();
  }
}
const metered = (url: string, init?: RequestInit) =>
  PUBLIC_RPC.test(url) ? queued(() => fetch(url, init)) : fetch(url, init);

/*
 * Every call, counted by method and logged every ten minutes with a daily
 * projection, so the next time a key runs dry the log already says which
 * loop spent it.
 */
const rpcCalls = new Map<string, number>();
/// Which loop or route a call was made for, carried through its awaits.
const rpcWho = new AsyncLocalStorage<string>();
const rpcBy = new Map<string, number>();
/// The caller's address for a request's RPC calls, carried like `rpcWho`, so
/// the rate limit can charge each address for what it costs (see `limits`).
const rpcIp = new AsyncLocalStorage<string>();
const countCall = (body: unknown) => {
  if (typeof body !== "string") return;
  try {
    const j = JSON.parse(body);
    const who = rpcWho.getStore() ?? "other";
    const ip = rpcIp.getStore();
    for (const c of Array.isArray(j) ? j : [j]) {
      const m = String(c?.method ?? "?");
      rpcCalls.set(m, (rpcCalls.get(m) ?? 0) + 1);
      rpcBy.set(who, (rpcBy.get(who) ?? 0) + 1);
      if (ip) chargeRpc(ip);
    }
  } catch { /* not JSON-RPC */ }
};
/*
 * Per-address limits on the API.
 *
 * Every route is public, and most reads are served from cache for nothing,
 * but a read that misses the cache, and every transaction built, costs RPC
 * calls from a budget the crank shares. So an address is charged for the RPC
 * calls its requests make, not for the requests themselves: an open trade
 * page polls twice a second and costs almost nothing, while a script asking
 * for a fresh wallet's account in a loop costs a call each time. Past either
 * limit in a minute, the address gets 429 until the minute is up.
 */
// A trade costs about ten calls to build, send and confirm.
const RATE_RPC_PER_MIN = Number(process.env.RATE_RPC_PER_MIN ?? 100);
const RATE_REQ_PER_MIN = Number(process.env.RATE_REQ_PER_MIN ?? 1200);
const limits = new Map<string, { start: number; req: number; rpc: number; told?: boolean }>();
/// Routes with their own daily limits per address, and costly by design.
const OWN_LIMITS = new Set(["/api/faucet", "/api/devnet-copy"]);
const windowOf = (ip: string) => {
  const now = Date.now();
  let w = limits.get(ip);
  if (!w || now - w.start >= 60_000) { w = { start: now, req: 0, rpc: 0 }; limits.set(ip, w); }
  return w;
};
const chargeRpc = (ip: string) => { windowOf(ip).rpc++; };
setInterval(() => {
  for (const [ip, w] of limits) if (Date.now() - w.start >= 60_000) limits.delete(ip);
}, 60_000).unref();

const RPC_REPORT_MS = 10 * 60_000;
setInterval(() => {
  const total = [...rpcCalls.values()].reduce((a, b) => a + b, 0);
  const top = [...rpcCalls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([m, n]) => `${m} ${n}`).join(", ");
  const by = [...rpcBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([w, n]) => `${w} ${n}`).join(", ");
  console.log(`rpc: ${total} calls in 10m (~${Math.round(total * 144 / 1000)}k/day): ${top}`);
  console.log(`rpc by caller: ${by}`);
  rpcCalls.clear(); rpcBy.clear();
}, RPC_REPORT_MS).unref();

const rpcFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  countCall(init?.body);
  // web3.js always calls the first key's URL; anything else is not ours to route.
  if (!url.startsWith(RPC_URL)) return metered(url, init);
  const tail = url.slice(RPC_URL.length);
  const methods = methodsIn(init?.body);
  let last: Response | null = null;
  for (let tries = 0; tries < RPC_ENDPOINTS.length; tries++) {
    const ep = nextEndpoint(methods);
    if (!ep) break;
    const r = await metered(ep + tail, init);
    if (r.status >= 400 && r.status < 500 && r.status !== 429) {
      const text = await r.clone().text().catch(() => "");
      if (methods.length && REFUSAL.test(text)) {
        const set = refusedBy.get(ep) ?? new Set<string>();
        methods.forEach((m) => set.add(m));
        refusedBy.set(ep, set);
        console.warn(`rpc: ${rpcHost(ep)} does not serve ${methods.join(", ")} on its plan; sending it elsewhere`);
        last = r;
        continue;
      }
    }
    if (r.status !== 429) return r;
    last = r;
    restingUntil.set(ep, Date.now() + 60_000);
    console.warn(`rpc: ${rpcHost(ep)} rate limited, resting that key for 60s`);
  }
  if (RPC_FALLBACK_URL) return metered(RPC_FALLBACK_URL + tail, init);
  return last ?? metered(url, init);
};
// One try per request: a 429 is answered by the fallback or by the last
// good snapshot, never by sitting on the socket.
const conn = new Connection(RPC_URL, {
  commitment: "confirmed", fetch: rpcFetch, disableRetryOnRateLimit: true,
  wsEndpoint: RPC_WS_URL,
});
/*
 * Confirmation by polling, not by websocket. Every transaction this process
 * waits on, its own and the ones it relays, is checked in one batched
 * `getSignatureStatuses` every CONFIRM_POLL_MS, and the block height every
 * two seconds for expiry.
 *
 * web3.js confirms through a `signatureSubscribe` per transaction on the
 * websocket. Under the 100-wallet load test the free websocket endpoint
 * started closing; every confirmation then hung on a socket that would never
 * answer, piled up in memory, and the process aborted at 2.2 GB. Confirms
 * also took the 30s timeout far more often than a transaction took to land.
 * Replacing `confirmTransaction` on the shared connection covers every
 * caller: Anchor's `.rpc()`, `sendAndConfirm` and the relay endpoint.
 */
/*
 * Program addresses, derived once. `findProgramAddressSync` tries bumps from
 * 255 down, and each try is an ed25519 on-curve check; profiled under the
 * 100-wallet load test it was about 70% of this process's CPU, because the
 * same position, order, batch and token-account addresses were derived again
 * on every request and every pass (an account read alone derives two hundred
 * order slots). An address depends only on its seeds and program, so it is
 * cached for the life of the process. Patched on the class so Anchor and
 * spl-token, which call the same function, are covered too.
 */
const pdaCache = new Map<string, [PublicKey, number]>();
const derivePda = PublicKey.findProgramAddressSync.bind(PublicKey);
PublicKey.findProgramAddressSync = (seeds: Array<Buffer | Uint8Array>, programId: PublicKey) => {
  const key = programId.toBase58() + ":" + seeds.map((b) => Buffer.from(b).toString("hex")).join(",");
  let hit = pdaCache.get(key);
  if (!hit) {
    hit = derivePda(seeds, programId);
    if (pdaCache.size >= 500_000) pdaCache.clear();
    pdaCache.set(key, hit);
  }
  return hit;
};

const CONFIRM_POLL_MS = 500;
type Waiter = { resolve: (r: any) => void; reject: (e: any) => void; lastValid?: number; deadline: number };
const unconfirmed = new Map<string, Waiter[]>();
let height = { at: 0, value: 0 };
let confirming = false;
async function confirmPass() {
  if (confirming || !unconfirmed.size) return;
  confirming = true;
  try {
    const needHeight = [...unconfirmed.values()].some((ws) => ws.some((w) => w.lastValid));
    if (needHeight && Date.now() - height.at > 2_000) {
      try { height = { at: Date.now(), value: await conn.getBlockHeight("confirmed") }; } catch { /* next pass */ }
    }
    const sigs = [...unconfirmed.keys()];
    for (let k = 0; k < sigs.length; k += 256) {
      const chunk = sigs.slice(k, k + 256);
      let res: any;
      try { res = await conn.getSignatureStatuses(chunk); } catch { continue; }
      chunk.forEach((sig, i) => {
        const ws = unconfirmed.get(sig);
        if (!ws) return;
        const st = res.value[i];
        if (st && (st.err || st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
          unconfirmed.delete(sig);
          ws.forEach((w) => w.resolve({ context: { slot: res.context.slot }, value: { err: st.err ?? null } }));
          return;
        }
        const now = Date.now();
        const left = ws.filter((w) => {
          if (w.lastValid && height.value > w.lastValid) {
            w.reject(new TransactionExpiredBlockheightExceededError(sig)); return false;
          }
          if (now > w.deadline) { w.reject(new TransactionExpiredTimeoutError(sig, 60)); return false; }
          return true;
        });
        if (left.length) unconfirmed.set(sig, left); else unconfirmed.delete(sig);
      });
    }
  } finally { confirming = false; }
}
// Not unref'd: a confirmation the process is waiting on is work, and at
// startup (a session change sends a transaction before the API listens) this
// timer was the only thing keeping Node alive. Unref'd, Node saw nothing left
// to do, exited cleanly mid-await, and systemd restarted it in a loop.
setInterval(() => { void confirmPass().catch(() => { /* next pass */ }); }, CONFIRM_POLL_MS);
(conn as any).confirmTransaction = (strategy: any) => new Promise((resolve, reject) => {
  const sig: string = typeof strategy === "string" ? strategy : strategy.signature;
  const lastValid: number | undefined = typeof strategy === "string" ? undefined : strategy.lastValidBlockHeight;
  const list = unconfirmed.get(sig) ?? [];
  list.push({ resolve, reject, lastValid, deadline: Date.now() + (lastValid ? 150_000 : 60_000) });
  unconfirmed.set(sig, list);
});

/// One blockhash shared for BLOCKHASH_MS: every transaction this process
/// built or sent fetched its own, about one RPC call in nine, and a
/// blockhash stays valid for about a minute.
const BLOCKHASH_MS = 5_000;
let blockhashRead: { at: number; body: Promise<any> } | null = null;
const latestBlockhash = conn.getLatestBlockhash.bind(conn);
(conn as any).getLatestBlockhash = (commitment?: any) => {
  if (blockhashRead && Date.now() - blockhashRead.at < BLOCKHASH_MS) return blockhashRead.body;
  const body = latestBlockhash(commitment);
  blockhashRead = { at: Date.now(), body };
  body.catch(() => { blockhashRead = null; });
  return body;
};

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

/// Read at most every thirty seconds, and again after any transaction this
/// server relays (a backing in kind moves a book). Read by address, one book
/// per market of this pool, in a batched call: it was a `getProgramAccounts`
/// every ten seconds whenever a page showed backings.
let booksRead: { at: number; body: Promise<void> } | null = null;
function loadBooks(): Promise<void> {
  if (booksRead && Date.now() - booksRead.at < 30_000) return booksRead.body;
  const body = readBooks();
  booksRead = { at: Date.now(), body };
  body.catch(() => { booksRead = null; });
  return body;
}

async function readBooks() {
  const markets = new Map<string, PublicKey>();
  for (const m of Object.values(rt)) markets.set(m.address.toBase58(), m.address);
  for (const { publicKey } of poolMarketsLast?.list ?? []) markets.set(publicKey.toBase58(), publicKey);
  const keys = [...markets.values()].map((m) => backingBookPda(program.programId, m));
  const { infos } = await getMany(keys);
  const all = infos.flatMap((info) => {
    if (!info) return [];
    try { return [{ account: program.coder.accounts.decode("backingBook", info.data) }]; } catch { return []; }
  });
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
/// Twice the auction's idle pace: while it runs fast it refreshes this itself
/// every second, and while it is idle nothing in a batch changes. At exactly
/// the idle pace, a poll fell through to the chain whenever a pass was a
/// little late, which with each pass's own read on top was most of them.
const BATCH_FRESH_MS = AUCTION_IDLE_MS * 2;
/// When a batch does have to be read for a page, one read serves every
/// page asking for that market meanwhile.
const batchReads = new Memo<any>(1_000);
const accountMemo = new Map<string, { at: number; body: Promise<any> }>();
const ACCOUNT_FRESH_MS = Number(process.env.ACCOUNT_FRESH_MS ?? 4_000);
/// Wallets whose orders the auction settled since its last pass ended.
const settledOwners = new Set<string>();
/// Each wallet's last account view that was read in full, served when the
/// chain cannot be read (see /api/markets).
const accountLast = new Map<string, { at: number; body: any }>();

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
/// The market shown for each feed discovery has registered, by feed id hex.
const shownByFeed = new Map<string, string>();

/*
 * Every market of this pool, generations this process does not show
 * included, read by one `getProgramAccounts` and kept. Discovery refreshes it
 * on its own loop; the mark keeper (which prices every generation), the books
 * and the leaderboard read it from here rather than scanning again. The
 * keeper used to scan observations and markets on every pass, and the
 * leaderboard on every poll.
 */
let poolMarketsLast: { at: number; list: { publicKey: PublicKey; account: any }[] } | null = null;
let poolMarketsReading: Promise<{ publicKey: PublicKey; account: any }[]> | null = null;
function poolMarkets(maxAgeMs = DISCOVER_MS): Promise<{ publicKey: PublicKey; account: any }[]> {
  if (poolMarketsLast && Date.now() - poolMarketsLast.at < maxAgeMs) return Promise.resolve(poolMarketsLast.list);
  if (!poolMarketsReading) {
    const at = Date.now();
    // This pool's markets only, filtered on-chain. On a cluster the program has
    // been deployed to before, an unfiltered scan also returns markets from
    // older pools in older layouts, and one that fails to decode sinks the scan.
    poolMarketsReading = program.account.market.all([
      { memcmp: { offset: 9, bytes: pool.toBase58() } },
    ]).then((list: any[]) => {
      poolMarketsLast = { at, list };
      return list;
    }).finally(() => { poolMarketsReading = null; });
  }
  return poolMarketsReading!;
}

async function discoverMarkets() {
  // A fresh scan: finding what was listed is this loop's whole job.
  const all = await poolMarkets(0);
  // One feed can be listed more than once: each listing is a generation with
  // its own address (scripts/market-address.ts), so a market listed first
  // with a bad source does not hold the feed. Show one per feed, the newest
  // with backing, else the newest.
  await loadBooks().catch(() => {});
  const byFeed = new Map<string, { publicKey: PublicKey; account: any; generation: number; backed: boolean }[]>();
  for (const { publicKey, account } of all as any[]) {
    const feed = Buffer.from(account.feedId).toString("hex");
    const rows = byFeed.get(feed) ?? [];
    rows.push({ publicKey, account, generation: Number(account.generation ?? 0),
                backed: potUsd(publicKey, account.backingUsd) > 0 });
    byFeed.set(feed, rows);
  }
  for (const [feed, rows] of byFeed) {
    const { publicKey, account } = pickGeneration(rows)!;
    const symbol = symbolOf(account.symbol);
    if (!symbol) continue;
    const have = rt[symbol];
    // Already shown. A different generation of the same feed replaces it;
    // anything else holding the symbol (a catalogue market, another pool's
    // market under the same name) keeps it, as before.
    if (have && (have.address.equals(publicKey) || shownByFeed.get(feed) !== have.address.toBase58())) {
      continue;
    }

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

    if (have) console.log(`${symbol}: showing generation ${account.generation} at ${publicKey.toBase58().slice(0, 8)}`);
    shownByFeed.set(feed, publicKey.toBase58());
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
/*
 * The marks of markets with no candle source, one close a minute for two
 * days, kept in .cache (which a deploy carries over). Their chart is the tape
 * this venue keeps, and that tape lived only in memory: every restart wiped
 * it and a listed market's chart started again from nothing. Remembering our
 * own prints is not inventing history the mark lacks.
 */
const OBSERVED_TAPE_FILE = path.join(ROOT, ".cache", `${CLUSTER}-observed-tape.json`);
const OBSERVED_TAPE_MS = 48 * 3600_000;
let observedTape: Record<string, { t: number; p: number }[]> = {};
try { observedTape = JSON.parse(fs.readFileSync(OBSERVED_TAPE_FILE, "utf8")); } catch { observedTape = {}; }
setInterval(() => {
  const now = Date.now();
  const minute = Math.floor(now / 60_000) * 60_000;
  for (const m of Object.values(rt)) {
    if (m.def || !m.history.length) continue;
    const rows = observedTape[m.symbol] ?? (observedTape[m.symbol] = []);
    const p = m.history[m.history.length - 1].p;
    if (rows.length && rows[rows.length - 1].t === minute) rows[rows.length - 1].p = p;
    else rows.push({ t: minute, p });
    while (rows.length && rows[0].t < now - OBSERVED_TAPE_MS) rows.shift();
  }
  try {
    fs.mkdirSync(path.dirname(OBSERVED_TAPE_FILE), { recursive: true });
    fs.writeFileSync(OBSERVED_TAPE_FILE, JSON.stringify(observedTape));
  } catch (e: any) { console.warn(`observed tape: ${e?.message ?? e}`); }
}, 60_000).unref();

/// The kept tape as bars of `tf` seconds. Below a minute it has nothing to say.
function observedBars(m: MarketRt, tf: number): Candle[] {
  if (tf < 60) return [];
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const { t, p } of observedTape[m.symbol] ?? []) {
    const time = Math.floor(t / 1000 / tf) * tf;
    if (!cur || cur.time !== time) { cur = { time, open: p, high: p, low: p, close: p }; out.push(cur); }
    else { cur.high = Math.max(cur.high, p); cur.low = Math.min(cur.low, p); cur.close = p; }
  }
  return out;
}

/*
 * The real token's history, for a devnet market listed on a test copy of it.
 *
 * The keeper marks these copies at the real price (realPricesByPool), so the
 * real token's own chart is this market's chart before the venue's tape
 * begins. Read from Jupiter's chart data by mainnet mint, the source the
 * equities already chart from. (GeckoTerminal was tried first: its free API
 * refused most of a restart's reads, and most charts stayed empty.) A chart
 * not read yet waits up to three seconds for it, then answers with the
 * venue's own tape and keeps fetching behind the answer: a page loads its
 * history once, so a chart answered without it after a restart stayed short
 * until the page reloaded. Each is kept five minutes and answered stale while
 * it refreshes, and a failure leaves the market on its own tape.
 */
const JUP_CHARTS_URL = "https://datapi.jup.ag/v2/charts";
const JUP_FRAMES: Record<number, string> = {
  60: "1_MINUTE", 300: "5_MINUTE", 900: "15_MINUTE",
  3600: "1_HOUR", 14400: "4_HOUR", 86400: "1_DAY",
};
let jupNext = 0;
/// Mainnet mint of the real token a seeded pool copies, by the pool's address.
/// Empty off devnet: only devnet has test copies standing in for real tokens.
let shadowMints: Map<string, string> | null = null;
async function shadowMintMap(): Promise<Map<string, string>> {
  if (CLUSTER !== "devnet") return new Map();
  if (!shadowMints) {
    const { SHADOWS } = await import("./testnet-flow");
    shadowMints = new Map(seeded
      .filter((p) => p.real || SHADOWS[p.symbol]?.symbol === p.symbol)
      .map((p) => [p.pair, p.real ?? SHADOWS[p.symbol].mint]));
  }
  return shadowMints;
}
/// The real token's name, by the seeded pool's address, for the same copies.
let shadowNames: Map<string, string> | null = null;
async function shadowNameMap(): Promise<Map<string, string>> {
  if (CLUSTER !== "devnet") return new Map();
  if (!shadowNames) {
    const { SHADOWS } = await import("./testnet-flow");
    // The real token's name for a copy of one, and the seeding script's own
    // for an invented token ("Wind"), which otherwise listed as its ticker.
    shadowNames = new Map(seeded.map((p) => [p.pair,
      !p.real && SHADOWS[p.symbol]?.symbol === p.symbol && SHADOWS[p.symbol].name ? SHADOWS[p.symbol].name! : p.name]));
  }
  return shadowNames;
}

/*
 * A listed market's day, from its bars rather than from this process. Its
 * open was the first price this process saw, so its "24h change" was the
 * change since the last restart: PENGU read -0.25% on a day its chart rose
 * 8%. Every ten minutes the open, high and low come from the last day of its
 * 15-minute bars (the real token's history on devnet, the kept tape
 * otherwise). On devnet a test copy also takes the real token's name, so a
 * search for "Pudgy" finds PENGU.
 */
/// Listed markets whose token name has been looked up, so the lookup runs
/// once per market rather than every ten minutes.
const namedListings = new Set<string>();

async function refreshListedDay() {
  const names = await shadowNameMap();
  const since = Date.now() / 1000 - 86_400;
  for (const m of Object.values(rt)) {
    if (!m.observed) continue;
    const name = names.get(m.observed.source.toBase58());
    if (name) m.name = name;
    // Otherwise the token's own metadata name. A token that wrote none was
    // shown as its mint code twice ("4sqG / 4sqG"); it now reads "Unnamed
    // token", so nobody takes the code for a name.
    else if (m.name === m.symbol && !namedListings.has(m.symbol)) {
      namedListings.add(m.symbol);
      try {
        const p = await readPool(conn, m.observed.source, usdcMint);
        const meta = await readTokenMeta(conn, new PublicKey(p.base));
        m.name = meta.name?.trim() || "Unnamed token";
      } catch { namedListings.delete(m.symbol); }
    }
    const day = (await seedBars(m, 900).catch(() => [] as Candle[])).filter((b) => b.time >= since);
    if (day.length < 4) continue;
    m.open = day[0].open;
    m.high = Math.max(...day.map((b) => b.high));
    m.low = Math.min(...day.map((b) => b.low));
  }
}

async function realMintOf(m: MarketRt): Promise<string | null> {
  if (!m.observed) return null;
  return (await shadowMintMap()).get(m.observed.source.toBase58()) ?? null;
}

/// The seeded devnet pools that copy no real token (WIND, KITE, YAK from
/// scripts/seed-devnet-pools.ts), by pool address: every seeded pool that is
/// not a copy. They stay tradable by direct link but are never offered.
async function inventedPools(): Promise<Set<string>> {
  if (CLUSTER !== "devnet") return new Set();
  const copied = await shadowMintMap();
  return new Set(seeded.filter((s) => !copied.has(s.pair)).map((s) => s.pair));
}

/// Tickers with a logo file in web/public/logos, read once.
let logoFiles: Set<string> | null = null;
function hasLogoFile(symbol: string) {
  if (!logoFiles) {
    try {
      logoFiles = new Set(fs.readdirSync(path.join(ROOT, "web/public/logos"))
        .filter((f) => /\.(png|svg)$/.test(f)).map((f) => f.replace(/\.(png|svg)$/, "")));
    } catch { logoFiles = new Set(); }
  }
  // As TickerLogo reads it: `1MBONK` shows BONK's logo.
  return logoFiles.has(symbol.replace(/^1[KMB](?=[A-Z])/, ""));
}

/*
 * Markets left off every list a visitor browses: the invented devnet tokens,
 * and a listed token with no name of its own, no logo from Jupiter and no
 * file under web/public/logos. Nothing else changes for them: positions and
 * backing still show in the account, and a direct link still trades, so a
 * holder can always close.
 */
async function hiddenMarket(m: MarketRt): Promise<boolean> {
  if (!m.observed) return false;
  if ((await inventedPools()).has(m.observed.source.toBase58())) return true;
  // "Unnamed token" is what `refreshListedDay` writes once a token's
  // metadata turns out to have no name; until then the ticker stands in.
  const name = m.name.trim();
  const unnamed = !name || name === "Unnamed token" || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(name);
  if (!unnamed) return false;
  const real = await realMintOf(m);
  if (real && tokenIcons.get(real)) return false;
  return !hasLogoFile(m.symbol);
}

/// Token logos from Jupiter, by mainnet mint, for devnet copies: their own
/// mints carry no metadata, and the site has files only for a few tickers.
/// Looked up once per mint, a hundred to a request, never on the hot path.
const tokenIcons = new Map<string, string | null>();
let iconsLoading: Promise<void> | null = null;
function loadIcons(mints: (string | null | undefined)[]) {
  const missing = [...new Set(mints.filter((m): m is string => !!m && !tokenIcons.has(m)))];
  if (!missing.length || iconsLoading) return iconsLoading ?? Promise.resolve();
  iconsLoading = (async () => {
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100);
      try {
        const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${chunk.join(",")}`,
          { headers: { "user-agent": BROWSER_UA }, signal: AbortSignal.timeout(8_000) });
        if (!r.ok) continue;
        const rows = (await r.json()) as any[];
        for (const m of chunk) tokenIcons.set(m, rows.find((x) => x.id === m)?.icon ?? null);
      } catch { /* left missing: tried again on the next call */ }
    }
  })().finally(() => { iconsLoading = null; });
  return iconsLoading;
}

/*
 * GET /api/icon/:mint -- a token's logo, from our own origin.
 *
 * Pages show this rather than the URL in the token's metadata, which is
 * often an IPFS gateway the browser refuses (see token-icon.ts). Keyed by
 * mainnet mint, and never by URL, so this cannot be pointed at an arbitrary
 * address. The logo's URL comes from Jupiter, once per mint, through the
 * same map the market list fills.
 */
const icons = new IconStore(path.join(ROOT, ".cache", "icons"), async (mint) => {
  if (!tokenIcons.has(mint)) {
    const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`,
      { headers: { "user-agent": BROWSER_UA }, signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return null;
    tokenIcons.set(mint, ((await r.json()) as any[]).find((x) => x.id === mint)?.icon ?? null);
  }
  return tokenIcons.get(mint) ?? null;
});
/// Where a page finds a mint's logo, or null when Jupiter knows of none.
const iconPath = (mint: string | null | undefined) =>
  mint && tokenIcons.get(mint) ? `/api/icon/${mint}` : null;

/*
 * The real token's price, for the keeper to mark a devnet test copy at.
 *
 * Marking from the devnet pool meant a bot swapping it toward the real price
 * every few minutes and the keeper pushing a median of it: minutes behind,
 * and only as right as the last swap that landed. The mark is now the real
 * price itself (Jupiter,
 * one batched call a pass, by mainnet mint), and the devnet pool is kept
 * only for the depth the program reads on chain. A pass where Jupiter fails
 * falls back to the pool.
 */
const JUP_PRICE_URL = "https://lite-api.jup.ag/price/v3";
/*
 * One Jupiter read shared by every pass for REAL_PRICE_MS, and a minute's rest
 * after a 429. Each observer pass asked on its own, and under load (a hundred
 * wallets, discovery running on every send) that was a call every couple of
 * seconds: Jupiter answered 429 to all of them, and every devnet copy fell
 * back to its pool's price for as long as it lasted. While Jupiter is resting
 * or failing, the last good prices stand for up to REAL_PRICE_STALE_MS, which
 * is still the real price and far closer to it than the pool.
 */
const REAL_PRICE_MS = 20_000;
const REAL_PRICE_STALE_MS = 5 * 60_000;
let realGood: { at: number; prices: Map<string, number> } | null = null;
let realReading: Promise<Map<string, number>> | null = null;
let realRestUntil = 0;
async function realPricesByPool(): Promise<Map<string, number>> {
  const now = Date.now();
  if (realGood && now - realGood.at < REAL_PRICE_MS) return realGood.prices;
  const lastGood = () =>
    realGood && Date.now() - realGood.at < REAL_PRICE_STALE_MS ? realGood.prices : new Map<string, number>();
  if (now < realRestUntil) return lastGood();
  if (realReading) return realReading;
  realReading = (async () => {
    const mints = await shadowMintMap();
    const out = new Map<string, number>();
    if (!mints.size) return out;
    try {
      const r = await fetch(`${JUP_PRICE_URL}?ids=${[...new Set(mints.values())].join(",")}`,
        { signal: AbortSignal.timeout(8_000) });
      if (r.status === 429) realRestUntil = Date.now() + 60_000;
      if (!r.ok) throw new Error(`jupiter price ${r.status}`);
      const j = (await r.json()) as Record<string, { usdPrice?: number }>;
      for (const [pair, mint] of mints) {
        const p = j[mint]?.usdPrice;
        if (p && p > 0) out.set(pair, p);
      }
      realGood = { at: Date.now(), prices: out };
      return out;
    } catch (e: any) {
      const kept = lastGood();
      console.warn(`real prices: ${e?.message ?? e}; ${kept.size ? "keeping the last real prices" : "marking from the pools"}`);
      return kept;
    }
  })().finally(() => { realReading = null; });
  return realReading;
}
const realSeeds = new Map<string, { at: number; bars: Candle[] }>();
const realLoads = new Map<string, Promise<Candle[]>>();
async function fetchRealBars(mint: string, tf: number, unitExp: number): Promise<Candle[]> {
  // A breath between reads, so a restart's warm-up does not arrive at once.
  const wait = jupNext - Date.now();
  jupNext = Math.max(Date.now(), jupNext) + 300;
  if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
  const to = Date.now();
  const r = await fetch(`${JUP_CHARTS_URL}/${mint}?interval=${JUP_FRAMES[tf]}&to=${to}&candles=1000&type=price`,
    { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`jupiter charts ${r.status}`);
  const j: any = await r.json();
  const unit = 10 ** unitExp;
  return ((j?.candles ?? []) as any[])
    .map((c) => ({
      time: Number(c.time), open: Number(c.open) * unit, high: Number(c.high) * unit,
      low: Number(c.low) * unit, close: Number(c.close) * unit,
    }))
    .filter((c) => Number.isFinite(c.time) && c.close > 0)
    .sort((x, y) => x.time - y.time);
}
async function realBars(m: MarketRt, tf: number): Promise<Candle[]> {
  if (!JUP_FRAMES[tf]) return [];
  const mint = await realMintOf(m);
  if (!mint) return [];
  const key = `${mint}:${tf}`;
  const hit = realSeeds.get(key);
  const load = () => fetchRealBars(mint, tf, m.observed?.unitExp ?? 0)
    .then((bars) => { realSeeds.set(key, { at: Date.now(), bars }); return bars; })
    .catch((e: any) => { console.warn(`real candles ${m.symbol}@${tf}s: ${e?.message ?? e}`); return hit?.bars ?? []; });
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.bars;
  let pending = realLoads.get(key);
  if (!pending) {
    pending = load().finally(() => realLoads.delete(key));
    realLoads.set(key, pending);
  }
  if (hit) return hit.bars;
  const late = new Promise<Candle[]>((ok) => setTimeout(() => ok([]), 3_000));
  return Promise.race([pending, late]);
}

async function fetchSeed(m: MarketRt, tf: number, key: string): Promise<Candle[]> {
  const hit = seeds[key];
  // A market listed against a pool has no candle source of its own. Its
  // chart is the tape this venue keeps (see observedBars), and on devnet,
  // before that, the real token's history (see realBars).
  if (!m.def) {
    const [real, kept] = await Promise.all([realBars(m, tf), Promise.resolve(observedBars(m, tf))]);
    const from = kept.length ? kept[0].time : Infinity;
    return [...real.filter((c) => c.time < from), ...kept];
  }
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

/// Any number of accounts in as few calls as the RPC allows (100 a call, the
/// calls in parallel), with the slot they were read at.
async function getMany(keys: PublicKey[]): Promise<{ infos: (AccountInfo<Buffer> | null)[]; slot: number }> {
  const parts = await Promise.all(Array.from({ length: Math.ceil(keys.length / 100) }, (_, k) =>
    conn.getMultipleAccountsInfoAndContext(keys.slice(k * 100, k * 100 + 100))));
  return {
    infos: parts.flatMap((p) => p.value),
    slot: Math.min(...parts.map((p) => p.context.slot), Number.MAX_SAFE_INTEGER),
  };
}

/*
 * The accounts every page and keeper reads: the pool, the LP mint and every
 * market, held as one snapshot.
 *
 * The auction loop reads them in the same call as the batches (every second
 * while anything rests, every AUCTION_IDLE_MS otherwise) and the AUM pass in
 * the same call as its checkpoint, so in steady state nothing else reads them
 * at all: the market list, every account view, trader PnL, the liquidation
 * check and the creators page are served from here. Only when the snapshot is
 * older than SHARED_FRESH_MS does a reader go to the chain, and then one read
 * serves everyone waiting.
 */
const SHARED_FRESH_MS = Number(process.env.SHARED_FRESH_MS ?? 5_000);
type Shared = { at: number; markets: Map<string, any>; pool: any; lpSupply: bigint };
let shared: Shared | null = null;
let sharedReading: Promise<Shared> | null = null;
/// What a shared snapshot reads, in this order; callers append their own keys.
const sharedKeys = () => [pool, lpMint, ...Object.values(rt).map((m) => m.address)];
/// Keeps a snapshot read along with something else. `infos` lines up with
/// `keys`, which are `sharedKeys()` as they were when the read was made.
function noteShared(keys: PublicKey[], infos: (AccountInfo<Buffer> | null)[], at = Date.now()): Shared | null {
  if (!infos[0] || !infos[1]) return null;
  const markets = new Map<string, any>();
  for (let i = 2; i < keys.length; i++) {
    const info = infos[i];
    if (!info) continue;
    // A market in a layout this build cannot decode is left out, as a failed
    // fetchMultiple entry was.
    try { markets.set(keys[i].toBase58(), program.coder.accounts.decode("market", info.data)); } catch { /* skip */ }
  }
  const next: Shared = {
    at, markets,
    pool: program.coder.accounts.decode("pool", infos[0].data),
    lpSupply: unpackMint(lpMint, infos[1], infos[1].owner).supply,
  };
  if (!shared || next.at >= shared.at) {
    shared = next;
    for (const [k, ma] of markets) marketReads.set(k, { at, body: Promise.resolve(ma) });
  }
  return next;
}
function sharedState(maxAgeMs = SHARED_FRESH_MS): Promise<Shared> {
  if (shared && Date.now() - shared.at < maxAgeMs) return Promise.resolve(shared);
  if (!sharedReading) {
    const keys = sharedKeys();
    const at = Date.now();
    sharedReading = getMany(keys).then(({ infos }) => {
      const s = noteShared(keys, infos, at);
      if (!s) throw new Error("pool account not found");
      return s;
    }).finally(() => { sharedReading = null; });
  }
  return sharedReading;
}

/// A market account read at most once a second: the snapshot when it is that
/// fresh (it is, whenever the auction is busy), otherwise the account alone.
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

/// Every market by address, from the shared snapshot. Keyed by address:
/// markets are listed while the server runs, so a position in a list read a
/// moment ago is not a market.
function marketsByAddress(): Promise<Map<string, any>> {
  return sharedState().then((s) => s.markets);
}

/// The LP mint's supply, in the shape `getTokenSupply` answered with, from
/// the shared snapshot.
function lpSupplyRead(): Promise<{ value: { amount: string } }> {
  return sharedState().then((s) => ({ value: { amount: s.lpSupply.toString() } }));
}

/// The pool account, from the shared snapshot.
function poolAccount(): Promise<any> {
  return sharedState().then((s) => s.pool);
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
/// Copies of mainnet tokens made on request (/api/devnet-copy) join them,
/// kept in their own file so the state file stays what the scripts wrote.
type SeededPool = { symbol: string; name: string; mint: string; pair: string; real?: string; sideUsd?: number; t?: number; ip?: string };
const COPIES_FILE = path.join(ROOT, `.${CLUSTER}-copies.json`);
let copies: SeededPool[] = [];
try { copies = JSON.parse(fs.readFileSync(COPIES_FILE, "utf8")); } catch { copies = []; }
// Addresses older than a day are dropped at start too (DAY_MS is defined
// further down), so the file never keeps one past the policy's day.
for (const c of copies) if (c.ip && Date.now() - (c.t ?? 0) >= 86_400_000) delete c.ip;
const seeded: SeededPool[] = [...(st.seededPools ?? []), ...copies];

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
  return { symbol, name: meta.name ?? known?.name ?? "Unnamed token" };
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
    // 1 bp an hour per 1% of skew: only a fully one-sided book reaches the cap.
    fundingKBps: 100,
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
    // The mark is the pool mid, the figure the market header shows. PnL is
    // taken at the exit, the side of the spread a close would fill on.
    isLong: pos.isLong, size, collateral, entry, mark: (q.bid + q.ask) / 2, exit,
    leverage: collateral > 0 ? size / collateral : 0,
    pnl, funding, equity, maintenance,
    pnlPct: collateral > 0 ? (pnl / collateral) * 100 : 0,
    liqPrice: liqPrice > 0 ? liqPrice : 0,
    liquidatable: equity < maintenance,
  };
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
/*
 * The pool's AUM checkpoint (`AumCheckpoint`), which deposits and withdrawals
 * price LP shares from instead of carrying every market with open interest.
 * They used to carry them, two accounts each, and past about two dozen such
 * markets that broke Solana's 64-account lock limit: in the 100-wallet load
 * test every deposit and withdrawal failed with TooManyAccountLocks.
 *
 * A pass adds those markets in increasing address order, AUM_CHUNK a
 * transaction, and completes when it has counted all of them; the keeper
 * runs one every AUM_EVERY_MS, and a deposit that finds the last one older
 * than AUM_FRESH_MS runs one first. Anyone may run or finish a pass.
 */
const aumCheckpointPda = PublicKey.findProgramAddressSync(
  [Buffer.from("aum"), pool.toBuffer()], program.programId)[0];
const AUM_CHUNK = 12;
const AUM_EVERY_MS = 20_000;
const AUM_FRESH_MS = 45_000;
let aumPassing: Promise<void> | null = null;

/// Runs a checkpoint pass now, or joins the one running.
function refreshAum(): Promise<void> {
  if (!aumPassing) {
    aumPassing = rpcWho.run("aum", () => runAumPass(true)).finally(() => { aumPassing = null; });
  }
  return aumPassing;
}

/// The loop's pass: the same, but a checkpoint that will still be fresh at
/// the next pass is left alone. Writing one every AUM_EVERY_MS was a
/// transaction and three reads every twenty seconds whether anybody deposited
/// or not; now it is one read, and a transaction about every other pass.
/// Not registered as `aumPassing`: a deposit that asks for a checkpoint must
/// get a pass that writes one, not join a pass that decided not to.
function keepAumWarm(): Promise<void> {
  return aumPassing ?? runAumPass(false);
}

/// The checkpoint, the pool and every market in one read (and the shared
/// snapshot refreshed by it).
async function aumRead() {
  const keys = sharedKeys();
  const at = Date.now();
  const { infos } = await getMany([aumCheckpointPda, ...keys]);
  const snap = noteShared(keys, infos.slice(1), at);
  if (!snap) throw new Error("pool account not found");
  const c: any = infos[0] ? program.coder.accounts.decode("aumCheckpoint", infos[0].data) : null;
  return { c, p: snap.pool, markets: snap.markets };
}

/// Whether a checkpoint is one a deposit may be priced from for at least
/// another `marginMs`.
const aumFresh = (c: any, p: any, marginMs: number) =>
  !!c && Date.now() / 1000 - num(c.doneTs) < (AUM_FRESH_MS - marginMs) / 1000
    && c.doneVersion === p.oiVersion && c.doneMarkets === p.marketsWithOi;

async function runAumPass(force: boolean) {
  const { c, p, markets: accounts } = await aumRead();
  if (!force && aumFresh(c, p, AUM_EVERY_MS)) return;
  const withOi = Object.values(rt)
    .filter((m) => {
      const a: any = accounts.get(m.address.toBase58());
      return a && !(a.longSizeUsd.isZero() && a.shortSizeUsd.isZero());
    })
    .sort((a, b) => Buffer.compare(a.address.toBuffer(), b.address.toBuffer()));
  const now = Date.now() / 1000;
  // Continue a pass that is open, fresh and under the pool's current set of
  // markets; otherwise start one.
  const resume = c && c.passOpen && now - num(c.passStartedTs) <= 25
    && c.passVersion === p.oiVersion && c.passMarkets === p.marketsWithOi;
  const after = resume ? new PublicKey(c.passLastMarket).toBuffer() : null;
  const todo = after ? withOi.filter((m) => Buffer.compare(m.address.toBuffer(), after) > 0) : withOi;
  let restart = !resume;
  for (let k = 0; k === 0 || k < todo.length; k += AUM_CHUNK) {
    const chunk = todo.slice(k, k + AUM_CHUNK);
    await program.methods.checkpointAum(restart)
      .accounts({ payer: authority.publicKey, pool, checkpoint: aumCheckpointPda,
                  systemProgram: SystemProgram.programId } as any)
      .remainingAccounts(chunk.flatMap((m) => [
        { pubkey: m.address, isWritable: false, isSigner: false },
        { pubkey: oracleOf(m), isWritable: false, isSigner: false },
      ]))
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })])
      .rpc();
    restart = false;
  }
}

/// Before a deposit or withdrawal is built, a checkpoint the program will
/// accept: under a minute old, with the margin AUM_FRESH_MS leaves for the
/// trader to sign.
async function aumReady() {
  const { infos } = await getMany([aumCheckpointPda, pool]);
  const c: any = infos[0] ? program.coder.accounts.decode("aumCheckpoint", infos[0].data) : null;
  if (!infos[1]) throw new Error("pool account not found");
  const p: any = program.coder.accounts.decode("pool", infos[1].data);
  if (!aumFresh(c, p, 0)) await refreshAum();
}

/// What a deposit or withdrawal carries besides its named accounts: the
/// custodies, which the LPs may hold tokens in. Markets come from the AUM
/// checkpoint.
async function allMarketAccounts() {
  await aumReady();
  return [...custodyPairs(false)];
}

const batchPda = (market: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("batch"), market.toBuffer()], program.programId)[0];


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
const BATCH_INTERVAL_SEC = 1;
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

/// The batch as last read, or read now. Shared by the batch route and the
/// pre-sign check so an order build costs no extra call while the auction is
/// busy.
const batchState = async (m: MarketRt): Promise<any> => {
  const seen = batchSeen.get(m.symbol);
  return seen && Date.now() - seen.at < BATCH_FRESH_MS
    ? seen.state
    : batchReads.get(m.symbol, () => program.account.batch.fetchNullable(batchPda(m.address)));
};

/// Why the program would refuse this open, in the page's words, or null
/// (see `open-guard.ts`). Asked from the chain before the transaction is
/// built, so the trader is not handed a signature that can only fail. A
/// failed read says nothing and leaves it to the program.
const openConflict = async (m: MarketRt, owner: PublicKey, isLong: boolean, inBatch = true) => {
  const [info, state] = await Promise.all([
    conn.getAccountInfo(positionPda(m.address, owner)).catch(() => null),
    inBatch ? batchState(m).catch(() => null) : null,
  ]);
  const p: any = info ? program.coder.accounts.decode("position", info.data) : null;
  const pos = p ? { isLong: !!p.isLong, size: num(p.sizeUsd) / 1e6, closing: num(p.closingUsd) / 1e6 } : null;
  const mine = ((state?.orders ?? []) as any[])
    .filter((o) => o.active !== 0 && new PublicKey(o.owner).equals(owner))
    .map((o) => ({ isBid: o.isBid !== 0, reduceOnly: o.reduceOnly !== 0 }));
  return openRefusal(m.symbol, isLong, pos, mine, inBatch)?.message ?? null;
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


const liquidityAccounts = (owner: PublicKey) => ({
  owner, pool, usdcMint, usdcVault, lpMint, checkpoint: aumCheckpointPda,
  ownerUsdc: ata(owner, usdcMint), ownerLp: ata(owner, lpMint),
  tokenProgram: TOKEN_PROGRAM_ID,
});

/// A withdrawal waits this many slots between request and claim. Mirrors
/// `WITHDRAW_COOLDOWN_SLOTS` in the program.
const WITHDRAW_COOLDOWN_SLOTS = 150;
/// One per owner: the shares on their way out, and the token account they
/// sit in until claimed.
const withdrawRequestPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("withdraw_request"), pool.toBuffer(), owner.toBuffer()], program.programId)[0];
const withdrawEscrowPda = (request: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("withdraw_escrow"), request.toBuffer()], program.programId)[0];
const withdrawAccounts = (owner: PublicKey) => {
  const request = withdrawRequestPda(owner);
  return {
    owner, pool, usdcMint, usdcVault, lpMint,
    ownerUsdc: ata(owner, usdcMint), ownerLp: ata(owner, lpMint),
    request, escrowLp: withdrawEscrowPda(request), trader: traderPda(owner),
    tokenProgram: TOKEN_PROGRAM_ID,
  };
};

/// The instructions that withdraw: escrow shares, then after the cooldown
/// burn them for USDC at that moment's value, or hand them back.
async function requestWithdrawIx(owner: PublicKey, lp: number) {
  return program.methods.requestWithdraw(USD(lp))
    .accounts(withdrawAccounts(owner)).instruction();
}
async function claimWithdrawIx(owner: PublicKey, shares: BN, accounts: any[]) {
  return program.methods.claimWithdraw(shares, new BN(0))
    .accounts({
      ...withdrawAccounts(owner), checkpoint: aumCheckpointPda,
      tokenClaim: lpTokenClaimPda(owner), systemProgram: SystemProgram.programId,
    } as any)
    .remainingAccounts(accounts).instruction();
}
/// One per owner: the LP-held tokens a claim took in kind, waiting to be
/// pulled one custody at a time.
const lpTokenClaimPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("lp_token_claim"), pool.toBuffer(), owner.toBuffer()], program.programId)[0];
async function claimWithdrawTokensIx(owner: PublicKey, c: CustodyRt) {
  return program.methods.claimWithdrawTokens()
    .accounts({
      owner, pool, custody: c.address, mint: c.mint, vault: c.vault,
      ownerToken: ata(owner, c.mint), tokenClaim: lpTokenClaimPda(owner),
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .instruction();
}
async function cancelWithdrawIx(owner: PublicKey) {
  return program.methods.cancelWithdraw().accounts(withdrawAccounts(owner)).instruction();
}

/// Parses `owner` from a request, falling back to the demo account.
function ownerOf(req: any): PublicKey {
  const raw = req.query?.owner ?? req.body?.owner;
  if (!raw) return trader.publicKey;
  try { return new PublicKey(String(raw)); }
  catch { throw new Error(`not a public key: ${raw}`); }
}

function explain(e: any): string {
  const s = e?.toString?.() ?? String(e);
  // A failed simulation says only "Simulation failed." and keeps its reason
  // in the logs. Running short of SOL for rent was the usual one: a listing
  // needs a few accounts' worth, and the page said nothing a lister could act on.
  const logs = [...(e?.logs ?? e?.transactionLogs ?? []), s].join("\n");
  // The shortfall of one transfer: when the wallet is backing in SOL, that
  // is mostly the amount itself, not rent or fees.
  const lamports = logs.match(/insufficient lamports (\d+), need (\d+)/);
  if (lamports) {
    const short = (Number(lamports[2]) - Number(lamports[1])) / 1e9;
    return `Not enough SOL: about ${Math.max(short, 0.001).toFixed(3)} SOL more needed.`;
  }
  if (/insufficient funds|InsufficientFunds|0x1\b/.test(logs) && /Transfer|token/i.test(logs)) {
    return "Not enough funds in the wallet for this.";
  }
  if (/exceeded CUs meter|ComputationalBudgetExceeded|Computational budget exceeded/i.test(logs)) {
    return "Ran out of compute. Try again in a moment.";
  }
  const m = s.match(/Error Message: ([^.]+)\./) || s.match(/Error Code: (\w+)/)
    || logs.match(/Error Message: ([^.]+)\./);
  if (m) return m[1];
  // A failed simulation's first line is only "Simulation failed."; the
  // reason (an expired blockhash, rent, a program's code) is on the next.
  const why = e?.transactionMessage ?? s.match(/\nMessage: (.+?)\.?\s*(\n|$)/)?.[1];
  if (why) return String(why).replace(/^Transaction simulation failed:\s*/, "");
  // A plain `throw new Error("...")` stringifies with its class in front, and
  // the page prints whatever comes back verbatim. The prefix is noise to a
  // reader who was told to paste a pool address.
  return s.split("\n")[0].replace(/^Error:\s*/, "");
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
/// Fills by wallet, for the trade panel's history and liquidations. The
/// shared tape above is cut at 120 across every market, which one busy
/// wallet would push everyone else out of. Each wallet keeps its last 100,
/// in .cache so a deploy or restart carries them over.
///
/// A fill's fee and closed PnL come from the events its settlement emitted
/// (`enrichFills`), read back after it lands, so they appear a moment after
/// the fill itself.
const FILLS_FILE = path.join(ROOT, ".cache", `${CLUSTER}-fills.json`);
const fillsByOwner = new Map<string, any[]>();
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(FILLS_FILE, "utf8")))) {
    fillsByOwner.set(k, v as any[]);
  }
} catch { /* none yet */ }
let fillsDirty = false;
setInterval(() => {
  if (!fillsDirty) return;
  fillsDirty = false;
  try {
    fs.mkdirSync(path.dirname(FILLS_FILE), { recursive: true });
    fs.writeFileSync(FILLS_FILE, JSON.stringify(Object.fromEntries(fillsByOwner)));
  } catch (e: any) { console.warn(`fills: ${e?.message ?? e}`); }
}, 30_000).unref();
function recordTrade({ owner, ...t }: any) {
  trades.unshift({ t: Date.now(), ...t });
  trades.splice(120);
  const m = rt[t.symbol];
  if (m) m.volume += t.size;
  if (!owner) return null;
  const mine = fillsByOwner.get(owner) ?? [];
  const entry = { t: Date.now(), ...t };
  mine.unshift(entry);
  mine.splice(100);
  fillsByOwner.set(owner, mine);
  fillsDirty = true;
  return { owner, entry };
}

/// Every event a transaction emitted, read back from its logs, as
/// `recordClear` reads a clear's.
async function eventsOf(sig: string): Promise<{ name: string; data: any }[]> {
  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const out: { name: string; data: any }[] = [];
  for (const line of tx?.meta?.logMessages ?? []) {
    if (!line.startsWith("Program data: ")) continue;
    try {
      const ev = program.coder.events.decode(line.slice(14));
      if (ev) out.push({ name: String(ev.name).toLowerCase(), data: ev.data });
    } catch { /* another program's data */ }
  }
  return out;
}

/// Puts each settled fill's exact fee, and a close's PnL, on its row. A close
/// says both in `PositionClosed`. An open's fee is the market's rate on what
/// filled, already on the row, unless a referral or deployer discount
/// applied, in which case `FeeRewards` carries the fee actually charged.
/// Closed PnL is the price move less the funding paid, before the fee.
async function enrichFills(sig: string, recs: ({ owner: string; entry: any } | null)[]) {
  const events = await eventsOf(sig);
  const take = (owner: string, kind: string, symbol: string, done: (e: any) => boolean) =>
    recs.find((r) => r && r.owner === owner && r.entry.kind === kind && r.entry.symbol === symbol && !done(r.entry));
  for (const ev of events) {
    const owner = ev.data.owner?.toBase58?.();
    const symbol = Object.values(rt).find((m) => m.address.equals(ev.data.market))?.symbol;
    if (!owner || !symbol) continue;
    if (ev.name === "positionclosed") {
      const r = take(owner, "close", symbol, (e) => e.pnl != null);
      if (r) {
        r.entry.fee = num(ev.data.feeUsd) / 1e6;
        r.entry.pnl = (num(ev.data.pnlUsd) - num(ev.data.fundingUsd)) / 1e6;
      }
    } else if (ev.name === "feerewards") {
      const r = take(owner, "open", symbol, (e) => e.feeExact);
      if (r) { r.entry.fee = num(ev.data.feeUsd) / 1e6; r.entry.feeExact = true; }
    }
  }
  fillsDirty = true;
}
/*
 * Who has traded each market, for the devnet creator score.
 *
 * Filled USD by wallet, by market address, from the settlements this server
 * sends: every fill in a cleared batch, maker or taker, open or close.
 * Liquidations and the page's own trade notes are left out; neither is a
 * wallet choosing to trade the market. Kept in .cache, which a deploy
 * carries over, and written at most every half minute.
 */
const TRADERS_FILE = path.join(ROOT, ".cache", `${CLUSTER}-market-traders.json`);
/// Filled volume a wallet needs in a market before it counts as one of its
/// traders. Below it a wallet is dust: a fresh wallet with one tiny fill.
const CREATOR_MIN_TRADER_USD = 100;
let marketTraders: Record<string, Record<string, number>> = {};
try { marketTraders = JSON.parse(fs.readFileSync(TRADERS_FILE, "utf8")); } catch { marketTraders = {}; }
let tradersDirty = false;
function noteFill(market: string, owner: string, usd: number) {
  if (!(usd > 0)) return;
  const m = (marketTraders[market] ??= {});
  m[owner] = (m[owner] ?? 0) + usd;
  tradersDirty = true;
}
setInterval(() => {
  if (!tradersDirty) return;
  tradersDirty = false;
  try {
    fs.mkdirSync(path.dirname(TRADERS_FILE), { recursive: true });
    fs.writeFileSync(TRADERS_FILE, JSON.stringify(marketTraders));
  } catch (e: any) { console.warn(`market traders: ${e?.message ?? e}`); }
}, 30_000);
/// The wallets that count toward a market's creator score: each one once,
/// however much it traded, once it has filled $100 there. The market's own
/// deployer and the server's wallets never count.
function countedTraders(market: string, deployer: string, house: Set<string>): number {
  return countTraders(marketTraders[market] ?? {}, deployer, house, CREATOR_MIN_TRADER_USD);
}

/// Scans every open position in the program, not just one account's.
///
/// The keeper used to check the demo account's twelve PDAs. That was fine while
/// one keypair traded; with wallets connecting it would leave every other
/// trader's position unliquidated, which is the one job a keeper has.
/*
 * Every open position, kept in memory and checked against the live price
 * every few seconds, the way the trigger orders are. The scan behind it is a
 * `getProgramAccounts`, so it used to run every minute and a half and a
 * position could sit through its maintenance margin for that long before
 * anyone closed it, eating into the pool. The list is read again every minute
 * and right after any transaction this server relays; the checks between
 * reads use the batched market read and cost nothing more.
 */
let positionCache: { at: number; all: any[] } | null = null;
const POSITION_CACHE_MS = 60_000;
const LIQ_CHECK_MS = Number(process.env.LIQ_CHECK_MS ?? 3_000);
/*
 * Wallets whose positions changed since the cache was read: a transaction this
 * server relayed for them, a fill it settled, a liquidation it sent. Each
 * used to drop the whole cache, so every trade cost a `getProgramAccounts` on
 * the next check. Now the next check re-reads only those wallets' position
 * slots, one batched call for up to five wallets, and the full scan stays on
 * its minute for anything sent elsewhere.
 */
const dirtyPositions = new Set<string>();
const positionsChanged = (owner: string) => { dirtyPositions.add(owner); };
/// Past this many wallets at once, one full scan is cheaper than the slots.
const DIRTY_POSITION_OWNERS = 20;
/// A liquidation that failed is not tried again on every check.
const liqRetryAt = new Map<string, number>();

/// Re-reads `owners`' slots in `markets` and puts what is there in place of
/// what the cache held for those addresses. Entries for addresses not read
/// (markets not shown here, order slots past ORDER_SLOTS) are kept.
async function patchOwners(all: any[], keys: PublicKey[], decode: (info: AccountInfo<Buffer>) => any | null) {
  const { infos } = await getMany(keys);
  const read = new Set(keys.map((k) => k.toBase58()));
  const kept = all.filter((e) => !read.has(e.publicKey.toBase58()));
  infos.forEach((info, i) => {
    if (!info) return;
    const account = decode(info);
    if (account) kept.push({ publicKey: keys[i], account });
  });
  return kept;
}

async function openPositions(): Promise<any[]> {
  const owners = [...dirtyPositions];
  dirtyPositions.clear();
  try {
    if (!positionCache || Date.now() - positionCache.at > POSITION_CACHE_MS
      || owners.length > DIRTY_POSITION_OWNERS) {
      const at = Date.now();
      const all = (await program.account.position.all()) as any[];
      positionCache = { at, all: all.filter((e) => num(e.account.sizeUsd) !== 0) };
    } else if (owners.length) {
      const markets = Object.values(rt);
      const keys = owners.flatMap((o) => markets.map((m) => positionPda(m.address, new PublicKey(o))));
      positionCache = {
        at: positionCache.at,
        all: await patchOwners(positionCache.all, keys, (info) => {
          const pos = program.coder.accounts.decode("position", info.data);
          return num(pos.sizeUsd) !== 0 ? pos : null;
        }),
      };
    }
  } catch (e) {
    owners.forEach(positionsChanged);
    throw e;
  }
  return positionCache.all;
}

async function liquidationCheck() {
  let all: any[];
  let markets: Map<string, any>;
  try {
    all = await openPositions();
    if (!all.length) return;
    markets = await marketsByAddress();
  } catch (e: any) {
    console.warn(`liquidation scan: ${e.message}`);
    return;
  }
  const closed = new Set<string>();
  const stepped = new Set<string>();

  const byMarket = new Map<string, MarketRt>();
  for (const m of Object.values(rt)) byMarket.set(m.address.toBase58(), m);

  for (const entry of all) {
    const pos = entry.account;
    const m = byMarket.get(String(pos.market));
    const ma = m && markets.get(m.address.toBase58());
    if (!m || !m.quote || !ma) continue;
    const key = entry.publicKey.toBase58();
    if ((liqRetryAt.get(key) ?? 0) > Date.now()) continue;

    const d = describePosition(pos, ma, m);
    if (!d?.liquidatable) continue;

    // The program liquidates at the market's risk price, which walks toward
    // the oracle by at most 40 bps a slot and only when something steps it.
    // Step it once a pass for every market with a position past its margin,
    // in its own transaction, so a liquidation that is still early lands on
    // a later pass instead of waiting on someone else's trade.
    const marketKey = m.address.toBase58();
    if (!stepped.has(marketKey)) {
      stepped.add(marketKey);
      await program.methods.stepRiskPrice()
        .accounts({ pool, market: m.address, priceUpdate: oracleOf(m) })
        .rpc()
        .catch((e: any) => console.warn(`step risk price ${m.symbol}: ${explain(e)}`));
    }

    const owner = new PublicKey(String(pos.owner));
    let liqSig = "";
    try {
      liqSig = await program.methods.liquidate().accounts({
        liquidator: authority.publicKey,
        pool, market: m.address, position: entry.publicKey,
        owner,
        priceUpdate: oracleOf(m),
        usdcMint, usdcVault, ownerUsdc: ata(owner, usdcMint),
        liquidatorUsdc: new PublicKey(st.liquidatorUsdc),
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();
    } catch (e: any) {
      // Healthy at the risk price: it is still catching up, and the next
      // pass steps it again. Anything else is a race or a disagreement about
      // health, and waits.
      if (/PositionHealthy/.test(String(e?.message ?? e))) continue;
      console.warn(`liquidate ${m.symbol} (${owner.toBase58().slice(0, 4)}…): ${explain(e)}`);
      liqRetryAt.set(key, Date.now() + 30_000);
      continue;
    }

    closed.add(owner.toBase58());
    // What the program did, from its event; the estimate made before sending
    // only if the logs cannot be read back.
    const ev = await eventsOf(liqSig)
      .then((es) => es.find((e) => e.name === "positionliquidated")?.data)
      .catch(() => null);
    const liq = {
      isLong: d.isLong,
      size: ev ? num(ev.sizeUsd) / 1e6 : d.size,
      price: ev ? num(ev.fillPrice) / 1e6 : px(m),
      returned: ev ? num(ev.returnedUsd) / 1e6 : d.equity,
      // The loss before the liquidator's bounty, and the bounty itself.
      ...(ev ? { pnl: (num(ev.pnlUsd) - num(ev.fundingUsd)) / 1e6, fee: num(ev.bountyUsd) / 1e6 } : {}),
    };
    liquidations.unshift({ t: Date.now(), symbol: m.symbol, ...liq, owner: owner.toBase58() });
    liquidations.splice(20);
    recordTrade({
      symbol: m.symbol, side: d.isLong ? "sell" : "buy", kind: "liquidation", owner: owner.toBase58(), ...liq,
      // The liquidation itself, for the history's explorer link.
      sig: liqSig,
    });
    console.log(`liquidated ${m.symbol} (${owner.toBase58().slice(0, 4)}…) at ${px(m)}`);
  }
  // What closed is gone from the chain: those wallets are read again rather
  // than retried, and their pages are not shown the position.
  for (const o of closed) { positionsChanged(o); accountMemo.delete(o); }
}


/// Fires any order whose trigger the index has reached.
///
/// Scans every order in the program rather than one account's, for the same
/// reason the liquidation pass does: an order nobody executes is not an order.
/*
 * The standing orders, kept in memory and checked against the live price
 * every few seconds. Scanning the chain each pass costs a `getProgramAccounts`,
 * so it used to run every three minutes, and a take profit whose price was
 * crossed for a minute and a half was never filled: the scan stepped over it.
 * The list is read again every minute and right after any transaction this
 * server relays; the checks between reads cost nothing.
 */
let orderCache: { at: number; all: any[] } | null = null;
const ORDER_CACHE_MS = 60_000;
const ORDER_CHECK_MS = Number(process.env.ORDER_CHECK_MS ?? 3_000);
/// Wallets whose orders changed since the list was read, re-read by slot on
/// the next check; past DIRTY_ORDER_OWNERS of them, one full scan instead.
const dirtyOrders = new Set<string>();
const ordersChanged = (owner: string) => { dirtyOrders.add(owner); };
const DIRTY_ORDER_OWNERS = 4;
/// Orders that were hit but refused, and when they may be tried again: a
/// three-second check would otherwise send the same failing transaction
/// twenty times a minute.
const orderRetryAt = new Map<string, number>();

async function orderKeeper() {
  let all: any[];
  const owners = [...dirtyOrders];
  dirtyOrders.clear();
  try {
    if (!orderCache || Date.now() - orderCache.at > ORDER_CACHE_MS || owners.length > DIRTY_ORDER_OWNERS) {
      const at = Date.now();
      orderCache = { at, all: (await program.account.order.all()) as never };
    } else if (owners.length) {
      const keys = owners.flatMap((o) => orderKeysOf(new PublicKey(o)));
      orderCache = {
        at: orderCache.at,
        all: await patchOwners(orderCache.all, keys, (info) => {
          try { return program.coder.accounts.decode("order", info.data); } catch { return null; }
        }),
      };
    }
    all = orderCache.all;
  } catch (e: any) {
    owners.forEach(ordersChanged);
    console.warn(`order scan: ${e.message}`);
    return;
  }
  const fired = new Set<string>();

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
    if ((orderRetryAt.get(entry.publicKey.toBase58()) ?? 0) > Date.now()) continue;

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
      fired.add(owner.toBase58());
      console.log(
        `${expired ? "expired" : "filled"} order ${m.symbol} ` +
        `(${owner.toBase58().slice(0, 4)}…) trigger ${trigger} at ${price}`);
    } catch (e: any) {
      // A trigger that is reached but will not execute is worth knowing about:
      // the trader is watching an order that looks live and is not.
      console.warn(`order ${m.symbol} (${String(o.owner).slice(0, 4)}…): ${explain(e)}`);
      orderRetryAt.set(entry.publicKey.toBase58(), Date.now() + 60_000);
    }
  }
  // What fired is gone from the chain, and moved its owner's position: read
  // those wallets again rather than retry it.
  for (const o of fired) { ordersChanged(o); positionsChanged(o); accountMemo.delete(o); }
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
  await markBackings();
}

/// Marks down the points stake of every backer whose shares are worth less
/// than it, so a stake the market's losses drew on stops earning backing
/// points on what was lost. Permissionless; only stakes visibly above their
/// value are sent, with a cent of slack for rounding. Every ten minutes at
/// most: listing every backing is a `getProgramAccounts`.
let backingsMarkedAt = 0;
async function markBackings() {
  if (Date.now() - backingsMarkedAt < 600_000) return;
  backingsMarkedAt = Date.now();
  let all: any[];
  try { all = await program.account.backing.all(); } catch { return; }
  const markets: Record<string, any> = Object.fromEntries(await marketsByAddress().catch(() => new Map()));
  for (const { publicKey, account: b } of all) {
    const basis = num(b.pointsBasisUsd) / 1e6;
    if (basis === 0) continue;
    const key = new PublicKey(b.market);
    const m = Object.values(rt).find((x) => x.address.equals(key));
    if (!m) continue;
    const id = key.toBase58();
    try {
      markets[id] ??= await program.account.market.fetch(key);
    } catch { continue; }
    const ma = markets[id];
    const total = num(ma.backingShares);
    const worth = total === 0 ? 0 : potUsd(key, ma.backingUsd) * num(b.shares) / total;
    if (basis - worth < 0.01) continue;
    try {
      await program.methods.markBacking()
        .accounts({
          pool, market: key, book: books[id] ? backingBookPda(program.programId, key) : null,
          backing: publicKey, trader: traderPda(new PublicKey(b.owner)),
        } as any)
        .remainingAccounts(custodyPairs(false))
        .rpc();
    } catch (e: any) { console.warn(`mark backing ${m.symbol}: ${explain(e)}`); }
  }
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
/// Markets of pools this program has outlived are never pushed: the set is
/// this pool's markets, as discovery lists them, so their observations (still
/// on chain, for markets in layouts the program no longer decodes) are not
/// even read.

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

async function keeperPrice(observation: PublicKey, account: any, real: number | undefined,
                           source: AccountInfo<Buffer> | null, arrays: { info: AccountInfo<Buffer> | null }[]): Promise<number> {
  const key = observation.toBase58();
  const symbol = Object.values(rt).find((m) => m.address.equals(new PublicKey(account.market)))?.symbol ?? key.slice(0, 8);
  return breaker(key, symbol, num(account.ewmaPrice), await keeperCandidate(observation, account, real, source, arrays));
}

/// The pool's spot price, USD per single token, from accounts already read:
/// the same arithmetic `readPool` does, without its reads (the pool again,
/// a CLMM's history ring and the chain clock, a DLMM's mints), which the
/// listing preview needs and the keeper does not.
async function spotFromSource(account: any, source: AccountInfo<Buffer> | null,
                              arrays: { info: AccountInfo<Buffer> | null }[]): Promise<number> {
  const address = new PublicKey(account.source);
  if (!source) throw new Error("no account at the pool's address");
  if (account.sourceKind === SOURCE_KIND.raydiumClmm) {
    return Number(clmmPrice(decodeClmm(source.data), !!account.quoteIsToken0, 9)) / 1e15;
  }
  // A DLMM observation records its mints' decimals; one that somehow does not
  // is read the long way.
  if (account.sourceKind === SOURCE_KIND.meteoraDlmm && (account.decX || account.decY)) {
    const bins = new Map<number, any>();
    for (const a of arrays) {
      for (const [id, b] of decodeBinArray(a.info!.data, address.toBase58())) bins.set(id, b);
    }
    return Number(dlmmPrice(decodeDlmmPair(source.data), bins, account.decX, account.decY,
      !!account.quoteIsToken0, 9)) / 1e15;
  }
  return (await readPool(conn, address, usdcMint)).price;
}

async function keeperCandidate(observation: PublicKey, account: any, real: number | undefined,
                               source: AccountInfo<Buffer> | null, arrays: { info: AccountInfo<Buffer> | null }[]): Promise<number> {
  // A devnet copy of a real token is marked at the real price (see
  // realPricesByPool), unsmoothed: it is already the market's own price.
  if (real && real > 0) {
    const scaled = Math.round(real * 10 ** (account.unitExp ?? 0) * 1e6);
    if (scaled > 0) return scaled;
  }
  const spot = await spotFromSource(account, source, arrays);
  if (!(spot > 0)) throw new Error("pool reads no price");
  const key = observation.toBase58();
  const reads = [...(keeperReads.get(key) ?? []), spot].slice(-KEEPER_WINDOW);
  keeperReads.set(key, reads);
  const sorted = [...reads].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const scaled = Math.round(median * 10 ** (account.unitExp ?? 0) * 1e6);
  if (!(scaled > 0)) throw new Error("price rounds to zero at this unit");
  return scaled;
}

/*
 * What the keeper costs, kept as low as freshness allows.
 *
 * A pass reads every observed market of this pool (each generation, from the
 * list discovery keeps), its observation, the market and the pool it is priced
 * from in one batched call; a DLMM pair adds a read for its bin arrays. It
 * used to scan observations and markets with two `getProgramAccounts` a pass,
 * read each pool three or four times, and fetch each market again to check its
 * budget.
 *
 * A seasoned mark that would move less than OBSERVE_SKIP_BPS is left alone
 * while it is young (see `markMayRest`: never past OBSERVE_REFRESH_SEC, and
 * always well inside the market's own max_price_age_sec by the next pass).
 * What is pushed goes out MARK_BATCH to a transaction; a market whose push
 * fails in company is sent alone until one of its own lands, so one bad pool
 * does not sink the rest.
 */
const OBSERVE_SKIP_BPS = Number(process.env.OBSERVE_SKIP_BPS ?? 5);
const OBSERVE_REFRESH_SEC = Number(process.env.OBSERVE_REFRESH_SEC ?? 55);
const MARK_BATCH = Math.max(1, Number(process.env.MARK_BATCH ?? 6));
const pushAlone = new Set<string>();
/// Each observation's pool, which never changes, so the pass can read pools
/// in its first call.
const observedSource = new Map<string, PublicKey>();
let observePassSec = 0;

async function observer() {
  const started = Date.now();
  try { await observePass(); }
  finally { observePassSec = (Date.now() - started) / 1000; }
}

async function observePass() {
  // Observed markets only (price source 1). A market in a layout this build
  // cannot decode is not in the list at all, so it costs nothing here.
  const listed = (await poolMarkets()).filter(({ account }) => account.priceSource === 1);
  if (!listed.length) return;
  const obsKeys = listed.map(({ publicKey }) => observationPda(publicKey));
  const known = obsKeys.map((k) => observedSource.get(k.toBase58()) ?? null);
  const knownSources = known.filter((k): k is PublicKey => !!k);
  const n = listed.length;
  const first = await getMany([...obsKeys, ...listed.map((l) => l.publicKey), ...knownSources]);
  const sourceInfo = new Map<string, AccountInfo<Buffer> | null>();
  knownSources.forEach((k, i) => sourceInfo.set(k.toBase58(), first.infos[2 * n + i]));

  type Row = { market: PublicKey; observation: PublicKey; o: any; ma: any; source: PublicKey };
  const rows: Row[] = [];
  for (const [i, l] of listed.entries()) {
    const oi = first.infos[i];
    const mi = first.infos[n + i];
    // Listed but not yet pointed at a pool, or a market that closed.
    if (!oi || !mi) continue;
    try {
      const o = program.coder.accounts.decode("observation", oi.data);
      const ma = program.coder.accounts.decode("market", mi.data);
      const source = new PublicKey(o.source);
      observedSource.set(obsKeys[i].toBase58(), source);
      rows.push({ market: l.publicKey, observation: obsKeys[i], o, ma, source });
    } catch { /* an older layout */ }
  }
  // Pools first seen this pass, in one more call.
  const missing = rows.map((r) => r.source).filter((s) => !sourceInfo.has(s.toBase58()));
  if (missing.length) {
    const { infos } = await getMany(missing);
    missing.forEach((s, i) => sourceInfo.set(s.toBase58(), infos[i]));
  }

  const real = await realPricesByPool();
  const nowSec = Date.now() / 1000;
  const nextPassSec = OBSERVE_MS / 1000 + observePassSec;
  const rested: Row[] = [];
  const pushes: { r: Row; ix: TransactionInstruction; alone: boolean }[] = [];
  const isDlmm = (r: Row) => r.o.sourceKind === SOURCE_KIND.meteoraDlmm;
  const sourceOf = (r: Row) => sourceInfo.get(r.source.toBase58()) ?? null;
  const realOf = (r: Row) => real.get(r.source.toBase58());
  // Whether `price` may be left unpushed this pass (see `markMayRest`).
  const mayRest = (r: Row, price: number) => {
    const span = num(r.o.lastUpdateTs) - num(r.o.firstUpdateTs);
    return markMayRest({
      seasoned: r.o.observations >= MIN_OBSERVATIONS && span >= MIN_OBSERVATION_WINDOW_SEC,
      onChain: num(r.o.ewmaPrice), next: price,
      ageSec: nowSec - num(r.o.lastUpdateTs), maxAgeSec: Number(r.ma.maxPriceAgeSec ?? 0),
      nextPassSec, skipBps: OBSERVE_SKIP_BPS, refreshSec: OBSERVE_REFRESH_SEC,
    });
  };
  const warn = (r: Row, e: any) =>
    // A pool that cannot be read is a market that never opens, which is the
    // failure mode permissionless listing was given on purpose. Report it and
    // leave the rest of the set alone.
    console.warn(`push mark ${r.observation.toBase58().slice(0, 8)}: ${e?.message ?? e}`);

  // Priced first wherever the price needs no more reads: a real price, or a
  // CLMM pool's own account. A DLMM pair priced off its pool needs its bin
  // arrays for the price itself; one that is pushed needs them as accounts.
  const priced = new Map<Row, number>();
  for (const r of rows) {
    if (isDlmm(r) && !(realOf(r) && realOf(r)! > 0)) continue;
    try {
      const price = await keeperPrice(r.observation, r.o, realOf(r), sourceOf(r), []);
      if (mayRest(r, price)) rested.push(r); else priced.set(r, price);
    } catch (e: any) { warn(r, e); }
  }
  // Every DLMM pair's bin arrays that are still wanted, in one batched read,
  // picked fresh each pass: which ones the program needs depends on where the
  // pair is trading now.
  const needArrays = rows.filter((r) => isDlmm(r) && sourceOf(r) && (priced.has(r) || !(realOf(r)! > 0)));
  const arrayKeys = new Map<Row, PublicKey[]>();
  for (const r of needArrays) {
    try { arrayKeys.set(r, dlmmArrayKeys(r.source, sourceOf(r)!.data, !!r.o.quoteIsToken0)); }
    catch (e: any) { warn(r, e); }
  }
  const flat = [...arrayKeys.values()].flat();
  const arrayInfos = flat.length ? (await getMany(flat)).infos : [];
  const arrays = new Map<Row, { key: PublicKey; info: AccountInfo<Buffer> | null }[]>();
  let k = 0;
  for (const [r, keys] of arrayKeys) {
    arrays.set(r, keys.map((key) => ({ key, info: arrayInfos[k++] })).filter((a) => isDlmmArray(a.info)));
  }
  for (const r of rows) {
    if (!isDlmm(r) || realOf(r)! > 0) continue;
    try {
      if (!sourceOf(r)) throw new Error("no account at the pool's address");
      const price = await keeperPrice(r.observation, r.o, undefined, sourceOf(r), arrays.get(r) ?? []);
      if (mayRest(r, price)) rested.push(r); else priced.set(r, price);
    } catch (e: any) { warn(r, e); }
  }
  for (const [r, price] of priced) {
    try {
      const extra = isDlmm(r)
        ? (arrays.get(r) ?? []).map((a) => ({ pubkey: a.key, isSigner: false, isWritable: false }))
        : [];
      const ix = await program.methods.pushMark(new BN(price))
        .accounts({
          keeper: authority.publicKey, observation: r.observation, market: r.market,
          markKeeper: markKeeperPda, source: r.source,
        })
        .remainingAccounts(extra)
        .instruction();
      // About 20k compute units and five accounts of its own each (a DLMM
      // push carries two or three bin arrays), so a transaction holds four
      // to six; packing measures the size.
      pushes.push({ r, ix, alone: pushAlone.has(r.market.toBase58()) });
    } catch (e: any) { warn(r, e); }
  }

  type Push = (typeof pushes)[number];
  const groups: Push[][] = [];
  const together = pushes.filter((p) => !p.alone);
  let at = 0;
  for (const g of packInstructions(together.map((p) => p.ix), authority.publicKey, MARK_BATCH)) {
    groups.push(together.slice(at, at + g.length));
    at += g.length;
  }
  for (const p of pushes) if (p.alone) groups.push([p]);

  const landed: Push[] = [];
  const send = (g: Push[]) =>
    provider.sendAndConfirm(new Transaction().add(...withComputeLimit(g.map((p) => p.ix))));
  const sendAlone = async (p: Push) => {
    try {
      await send([p]);
      landed.push(p);
      pushAlone.delete(p.r.market.toBase58());
    } catch (e: any) {
      pushAlone.add(p.r.market.toBase58());
      console.warn(`push mark ${p.r.observation.toBase58().slice(0, 8)}: ${explain(e)}`);
    }
  };
  let nextGroup = 0;
  await Promise.all(Array.from({ length: Math.min(MARK_PARALLEL, groups.length) }, async () => {
    while (nextGroup < groups.length) {
      const g = groups[nextGroup++];
      if (g.length === 1) { await sendAlone(g[0]); continue; }
      try { await send(g); landed.push(...g); }
      // One push that fails takes its whole transaction with it: send each
      // alone, so the others land this pass and the bad one is found.
      catch { for (const p of g) await sendAlone(p); }
    }
  }));

  // Re-read: each push wrote both the mark and the depth, so the copies this
  // pass started from are one reading stale. One call for all of them.
  if (landed.length) {
    const { infos } = await getMany(landed.map((p) => p.r.observation));
    for (const [i, { r }] of landed.entries()) {
      if (!infos[i]) continue;
      const o = program.coder.accounts.decode("observation", infos[i]!.data);
      publish(r.market, o);
      await trimBudget(r.market, o, r.ma);
    }
  }
  // A mark left where it is still feeds the page's tape, at the age it has.
  for (const r of rested) publish(r.market, r.o, false);
}

/// Moves an observed market's mark onto the runtime the API serves.
///
/// An observed market has no source to poll: its price is whatever the last
/// fold left on chain, so this is the only place its quote comes from. The
/// tape is appended here for the same reason -- there are no candles to fetch
/// for a pool nobody publishes history for, and the chart draws what this
/// process has actually seen.
///
/// `fresh` is false for a mark the keeper left where it was this pass: its
/// price and depth are taken, but its age is not reset, so the page's feed
/// age stays the mark's own.
function publish(market: PublicKey, o: any, fresh = true) {
  const m = Object.values(rt).find((x) => x.address.equals(market));
  if (!m?.observed) return;

  const price = num(o.ewmaPrice) / 1e6;
  const span = num(o.lastUpdateTs) - num(o.firstUpdateTs);
  m.observed.readings = o.observations;
  m.observed.spanSec = span;
  // This process's clock, not the chain's: the page counts down against the
  // browser's, and a local validator's runs seconds behind both.
  if (fresh) m.observed.lastReadMs = Date.now();
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
  // The mark's age is the chain's: when it was last written, not when this
  // process last read it. A restart re-reads every market at once, and
  // timing from that read showed a mark refused for an hour as seconds old,
  // so a stale market kept reporting itself tradeable.
  m.lastFetch = markWrittenMs(num(o.lastUpdateTs), now, fresh ? now : m.lastFetch);
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
async function trimBudget(market: PublicKey, o: any, ma: any) {
  const observation = observationPda(market);
  const span = num(o.lastUpdateTs) - num(o.firstUpdateTs);
  if (o.observations < MIN_OBSERVATIONS || span < MIN_OBSERVATION_WINDOW_SEC) return;

  // The depth that has held (`budget_depth_usd`), which is what the program
  // cuts to; the last reading alone can be thinned for one crank.
  const depth = num(o.budgetDepthUsd ?? o.depthUsd);
  if (depth === 0) return;
  // The market as this pass read it: a push does not move its budget.
  if (depth >= num(ma.lossBudgetUsd)) return;

  await program.methods.deriveMarketBudget()
    .accounts({ pool, market, observation }).rpc();
  console.log(
    `budget ${market.toBase58().slice(0, 8)} ` +
    `$${(num(ma.lossBudgetUsd) / 1e6).toFixed(0)} -> $${(depth / 1e6).toFixed(0)}`);
}

/*
 * Whose request this is, for the per-address limits (the faucet, new devnet
 * tokens). Never a header the caller wrote.
 *
 * The site on Vercel forwards every call, so the socket is Vercel's. Its
 * forwarder sends the caller's address (from x-real-ip, which Vercel sets)
 * with FORWARD_SECRET next to it, and only that pair is believed. Caddy
 * proxies to this process on 127.0.0.1 and writes X-Forwarded-For itself:
 * without trusted_proxies it drops whatever the caller sent and puts down
 * the address it saw, so from loopback the last entry is Caddy's word.
 * Anything else is the socket's own address.
 */
const FORWARD_SECRET = process.env.FORWARD_SECRET ?? "";
if (!FORWARD_SECRET && !IS_LOCAL) {
  console.warn("FORWARD_SECRET is unset: every call through the site counts as one address (Vercel's)");
}
const secretHash = (v: string) => crypto.createHash("sha256").update(v).digest();
const LOOPBACK = new Set(["127.0.0.1", "::1"]);
function clientIp(req: express.Request): string {
  const socket = String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const sent = req.headers["x-forward-secret"];
  const ip = req.headers["x-client-ip"];
  if (FORWARD_SECRET && typeof sent === "string" && typeof ip === "string" && ip.trim()
    && crypto.timingSafeEqual(secretHash(sent), secretHash(FORWARD_SECRET))) {
    return ip.trim();
  }
  const xff = req.headers["x-forwarded-for"];
  if (LOOPBACK.has(socket) && typeof xff === "string" && xff.trim()) {
    return xff.split(",").pop()!.trim().replace(/^::ffff:/, "");
  }
  return socket;
}

const app = express();
app.use(express.json());
// Every request's RPC calls are counted under its route (ids folded away).
app.use((req, _res, next) => {
  const route = req.path.replace(/\/[A-Za-z0-9]{24,}/g, "/:id").replace(/\/[A-Z0-9]{2,12}x?$/g, "/:symbol");
  rpcWho.run(`${req.method} ${route}`, next);
});
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
//
// The site's own domains are the whole list. Preview deployments go in
// CORS_ORIGINS, one exact origin per entry, because a pattern wide enough to
// cover whichever name Vercel assigns is wide enough for somebody else to
// register a name that matches it and read this API from their own page.
const SITE_ORIGINS = ["https://unwindfi.xyz", "https://www.unwindfi.xyz"];
const ALLOWED_ORIGINS = new Set([
  ...SITE_ORIGINS,
  ...(process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean),
]);
const LOCALHOST_ORIGIN = /^http:\/\/localhost(:\d+)?$/;
const allowedOrigin = (origin: string) =>
  ALLOWED_ORIGINS.has(origin)
  || (process.env.CORS_LOCALHOST === "1" && LOCALHOST_ORIGIN.test(origin));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigin(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "content-type");
    res.set("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
// After CORS, so a page refused here can read why.
app.use((req, res, next) => {
  if (IS_LOCAL || !req.path.startsWith("/api/")) return next();
  const ip = clientIp(req);
  const w = windowOf(ip);
  w.req++;
  if (w.req > RATE_REQ_PER_MIN || w.rpc > RATE_RPC_PER_MIN) {
    // Once a minute per address, so a real user being refused shows in the log.
    if (!w.told) { w.told = true; console.warn(`rate limit: ${ip} (${w.req} requests, ${w.rpc} rpc calls this minute)`); }
    res.set("Retry-After", String(Math.max(1, Math.ceil((w.start + 60_000 - Date.now()) / 1000))));
    return res.status(429).json({ ok: false, error: "Too many requests. Try again in a minute." });
  }
  if (OWN_LIMITS.has(req.path)) return next();
  rpcIp.run(ip, next);
});
app.use(express.static(path.join(ROOT, "app"), { etag: false, lastModified: false }));
app.use("/vendor", express.static(path.join(ROOT, "node_modules/lightweight-charts/dist")));
app.use("/fonts", express.static(path.join(ROOT, "node_modules/@fontsource/inter/files")));

/// The whole market list, kept for a moment. Every open page polls it, and
/// at twenty markets a read-through cost twenty-two RPC calls a request.
/// A request never waits on the chain while a list under half a minute old
/// exists: it gets that list, and a stale one starts a single refresh behind
/// the answer. Before, the first request after each three-second window sat
/// through the whole read, about half a second on every page load.
let marketsInFlight: Promise<any> | null = null;
const MARKETS_FRESH_MS = 3_000;
const MARKETS_SERVE_MS = 30_000;
/// The last list that was read in full. When the chain cannot be read the
/// page gets this, with the time it dates from in a header, rather than an
/// error: a price a few seconds old beats a skeleton, and the page already
/// says when its figures are stale.
let marketsLast: { at: number; body: any } | null = null;

/// Every market with ?all=1, which the terminal and the account pages ask for
/// so a position or backing in a hidden market can still be closed. The
/// lists a visitor browses get the rest.
const listedOnly = (body: any, all: boolean) =>
  all || !Array.isArray(body) ? body : body.filter((m: any) => !m.hidden);

app.get("/api/icon/:mint", async (req, res) => {
  const mint = String(req.params.mint);
  // Readable from any page as an image, which a cross-origin <img> needs
  // now that browsers block opaque responses they cannot place.
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.set("X-Content-Type-Options", "nosniff");
  // An SVG opened on its own runs no script and loads nothing.
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  const icon = isMint(mint) ? await icons.get(mint) : null;
  if (!icon) {
    res.set("Cache-Control", "public, max-age=600");
    return res.status(404).end();
  }
  res.set("Content-Type", icon.type);
  res.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  res.send(icon.body);
});

app.get("/api/markets", async (req, res) => {
  const all = req.query.all === "1";
  try {
    const now = Date.now();
    if (!marketsInFlight && (!marketsLast || now - marketsLast.at >= MARKETS_FRESH_MS)) {
      const body = marketsView().then((b) => { marketsLast = { at: Date.now(), body: b }; return b; });
      marketsInFlight = body;
      body.catch(() => {}).finally(() => { if (marketsInFlight === body) marketsInFlight = null; });
    }
    if (marketsLast && now - marketsLast.at < MARKETS_SERVE_MS) return res.json(listedOnly(marketsLast.body, all));
    res.json(listedOnly(await (marketsInFlight ?? Promise.resolve(marketsLast?.body)), all));
  } catch (e: any) {
    if (marketsLast) {
      res.set("X-Stale-Since", String(marketsLast.at));
      return res.json(listedOnly(marketsLast.body, all));
    }
    res.status(500).json({ error: e.message });
  }
});


/*
 * A market's share card, for the link preview X, Telegram and Discord show.
 *
 * Read off the same snapshot /api/markets serves and drawn once per market
 * every five minutes: crawlers fetch a link's card when it is posted and
 * again whenever they please, and a card that is a few minutes old says so
 * in its own timestamp. A hidden market gets none, the same as the list.
 */
const OG_FRESH_MS = 5 * 60_000;
const ogCards = new Map<string, { at: number; png: Promise<Buffer> }>();
app.get("/api/og/trade/:file", async (req, res) => {
  const sym = String(req.params.file).replace(/\.png$/i, "");
  try {
    const body = marketsLast?.body ?? await (marketsInFlight ?? marketsView());
    const m = (listedOnly(body, false) as any[]).find((x) => x.symbol.toLowerCase() === sym.toLowerCase());
    if (!m) return res.status(404).json({ error: "no such market" });
    let hit = ogCards.get(m.symbol);
    if (!hit || Date.now() - hit.at > OG_FRESH_MS) {
      hit = { at: Date.now(), png: marketCard(m) };
      ogCards.set(m.symbol, hit);
      hit.png.catch(() => ogCards.delete(m.symbol));
    }
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=300");
    res.send(await hit.png);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

/// The program's POOL_QUOTE_BUDGET_BPS (500, in state/batch.rs) as a share.
const POOL_QUOTE_SHARE = 0.05;

async function marketsView() {
  {
    void loadIcons([...(await shadowMintMap()).values()]);
    const markets = Object.values(rt);
    // The pool and every market from the shared snapshot, which the auction
    // loop keeps fresh as it reads the batches.
    const { pool: p, markets: accounts } = await sharedState();
    const freeLiquidity = (num(p.liquidityUsd) - num(p.lockedUsd)) / 1e6;
    const out = await Promise.all(markets.map(async (m) => {
      const ma: any = accounts.get(m.address.toBase58()) ?? await marketAccount(m);
      const price = px(m);
      const q = quote(ma, m);
      const longSize = num(ma.longSizeUsd) / 1e6;
      const shortSize = num(ma.shortSizeUsd) / 1e6;
      const total = longSize + shortSize;
      const real = await realMintOf(m);
      const ageMs = m.lastFetch ? Date.now() - m.lastFetch : null;
      return {
        symbol: m.symbol, name: m.name, color: m.color, mono: m.mono, price,
        // Off the lists (see `hiddenMarket`); served only with ?all=1.
        hidden: await hiddenMarket(m),
        icon: iconPath(real),
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
        priceAgeMs: ageMs,
        maxPriceAgeSec: ma.maxPriceAgeSec,
        feedError: lastPostError || null,
        ...q,
        // `Market::effective_max_leverage_bps`: a closed session's ceiling
        // never above the market's own, and an observed market held to what
        // its pool's sustained depth supports (`depth_leverage_cap_bps`).
        maxLeverage: Math.min(
          (ma.session === 2 ? Math.min(ma.closedSessionLeverageBps, ma.maxLeverageBps) : ma.maxLeverageBps) / BPS,
          ma.priceSource === 1 ? Math.max(ma.depthLeverageX, DEPTH_LEVERAGE_TIERS[0][1]) : Infinity),
        session: ma.session,
        // Paused by the pool's authority: no new opens or backing, exits only.
        paused: !!ma.paused,
        oi: total,
        longShare: total > 0 ? (longSize / total) * 100 : 50,
        fundingLong: Number(ma.cumulativeLongFunding.toString()),
        fundingShort: Number(ma.cumulativeShortFunding.toString()),
        // The rate each side pays right now, in bps an hour, positive to pay.
        // The cumulative indices above are totals since listing and cannot
        // be read as a rate.
        // The program charges borrow on the book's imbalance against the
        // pool (`Market::utilization_bps`), not on reserved liquidity.
        ...fundingRates(ma, longSize, shortSize, num(p.liquidityUsd) > 0
          ? Math.min(10_000, (Math.abs(longSize - shortSize) * 1e6 * 10_000) / num(p.liquidityUsd))
          : (longSize === shortSize ? 0 : 10_000)),
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
        // The share of their profit winners would be paid if they all closed
        // now, from `haircut_profit_usd`: what the market can still pay over
        // the profit every winning side holds. 100 when it covers them all.
        payoutPct: payoutPct(ma, p, price),
        // Batch clears against the mark, last hour, by volume. Not charged.
        premiumBps: premiumOf(m.symbol),
        backingInKind: books[m.address.toBase58()]?.amounts ?? {},
        lossBudgetUsd: num(ma.lossBudgetUsd) / 1e6,
        // The most the pool fills on each side of one batch: its quote is
        // POOL_QUOTE_BUDGET_BPS of what is left of the budget (`clear_batch`).
        // With no makers in the book this is all an order gets; the rest of
        // it is refunded. The caps above are what open interest may reach.
        poolFillUsd: Math.max(0, num(ma.lossBudgetUsd) / 1e6 - Math.max(0, num(ma.netLossUsd) / 1e6))
          * POOL_QUOTE_SHARE,
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
          // A mark past its age limit pauses the market: the program refuses
          // every order against it until the keeper pushes again.
          stale: markStale(ageMs, ma.maxPriceAgeSec),
          tradeable: observedTradeable(m.observed.seasoned, num(ma.lossBudgetUsd), ageMs, ma.maxPriceAgeSec),
        },
        // Two hours of real minute closes, not the last two minutes of tape:
        // at a one-second tick the tape is far too zoomed in to show a shape.
        sparkline: sparklineFor(m),
      };
    }));
    // A paused market nobody holds a position in is left off the list: it
    // takes no new trades, and the load test's throwaway listings were
    // cluttering /markets. One with open interest stays, so its holders can
    // find it and close.
    return out.filter((o: any) => !(o.paused && o.oi === 0));
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
  matched: number; poolUsd: number; houseUsd: number; orders: number; t: number;
}> = {};
const shareTally: Record<string, { matched: number; pool: number; house: number }> = {};

/// Share of all volume the pool has been the counterparty to, in percent.
///
/// Null until something has traded, rather than zero: "no data yet" and "the
/// pool took none of it" are different claims and only one of them is true at
/// startup.
const poolShareOf = (symbol: string) => {
  const t = shareTally[symbol];
  return t && t.matched > 0 ? (t.pool / t.matched) * 100 : null;
};

/// Share the devnet's own maker has filled, in percent, on the same terms.
/// What is left after the pool and the house is makers nobody here runs.
const houseShareOf = (symbol: string) => {
  const t = shareTally[symbol];
  return t && t.matched > 0 ? (t.house / t.matched) * 100 : null;
};

/// Reads what a clear actually did out of its own logs.
///
/// `pool_bought` and `pool_sold` are emitted by `BatchCleared` but not stored
/// on the account, and they are exactly the figure a reader should be able to
/// hold this design to. Parsed from the transaction rather than subscribed to:
/// a dropped websocket would leave the number quietly wrong, where a failed
/// parse leaves it visibly absent.
///
/// `houseUsd` is what the house maker filled in the batch, read off the sealed
/// account by the caller; the event does not break fills down by owner.
async function recordClear(symbol: string, sig: string, houseUsd: number) {
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
    // Against the mark the clear was banded around, read as it landed.
    const live = Object.values(rt).find((x) => x.symbol === symbol);
    if (live) {
      const mark = px(live);
      notePremium(symbol, buyPrice, Number(ev.data.buyMatchedUsd) / 1e6, mark);
      notePremium(symbol, sellPrice, Number(ev.data.sellMatchedUsd) / 1e6, mark);
    }
    lastClear[symbol] = {
      buyPrice, sellPrice,
      matched, poolUsd, houseUsd,
      orders: Number(ev.data.orders),
      t: Date.now(),
    };
    // A batch that crossed nothing is still a batch; it just does not move the
    // share, because dividing by a volume of zero says nothing about anything.
    if (matched > 0) {
      const t = (shareTally[symbol] ??= { matched: 0, pool: 0, house: 0 });
      t.matched += matched;
      t.pool += poolUsd;
      t.house += houseUsd;
    }
  }
}


/// The collecting batch as the page needs to see it.
///
/// Read from the account every time rather than mirrored in this process: the
/// batch is the authority on what is resting in it, and a copy kept here would
/// go stale in precisely the second that matters.
app.get("/api/batch/:symbol", async (req, res) => {
  const m = rt[req.params.symbol];
  if (!m) return res.status(404).json({ error: "unknown market" });
  try {
    const state: any = await batchState(m);
    if (!state) return res.json({ exists: false });
    // With `?owner=`, that wallet's own orders are marked, so its ticket can
    // tell an open the program would refuse (see `openConflict`).
    let me: PublicKey | null = null;
    try { me = req.query.owner ? new PublicKey(String(req.query.owner)) : null; } catch { me = null; }

    const opened = Number(state.openedTs);
    const resting = (state.orders as any[])
      .filter((o) => o.active !== 0)
      .map((o) => ({
        price: Number(o.price) / 1e6,
        size: Number(o.sizeUsd) / 1e6,
        isBid: o.isBid !== 0,
        isMaker: o.isMaker !== 0,
        reduceOnly: o.reduceOnly !== 0,
        house: isHouse(o.owner),
        ...(me && new PublicKey(o.owner).equals(me) ? { mine: true } : {}),
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
      houseSharePct: houseShareOf(m.symbol),
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
  const accounts = await marketsByAddress();
  for (const m of markets) {
    const ma = accounts.get(m.address.toBase58());
    if (!ma) continue;
    const price = px(m);
    const pnlOf = (isLong: boolean, size: number, entry: number) =>
      entry > 0 ? size * ((price - entry) / entry) * (isLong ? 1 : -1) : 0;
    traderPnl +=
      pnlOf(true, num(ma.longSizeUsd) / 1e6, num(ma.longAvgEntryPrice) / 1e6) +
      pnlOf(false, num(ma.shortSizeUsd) / 1e6, num(ma.shortAvgEntryPrice) / 1e6);
  }
  return traderPnl;
}

/*
 * One wallet's standing orders, read by address: every market's order slots
 * 0 to ORDER_SLOTS-1 in batched calls of a hundred, about three calls in all.
 * It was a `getProgramAccounts` filtered by owner on every account read, the
 * heaviest call a key serves (only one of the free keys serves it at all),
 * and under load the reads it made were most of what rate-limited the keys.
 * The site places orders in slots 0 to 2 (take profit, stop, limit); an order
 * a wallet placed by hand past slot 7 would not be shown.
 */
const ORDER_SLOTS = 8;
/// The slots the site itself places in, which an account view reads by
/// address every time; the rest come from the trigger keeper's list.
const SITE_ORDER_SLOTS = 3;
const orderKeysOf = (owner: PublicKey, slots = ORDER_SLOTS) => Object.values(rt).flatMap((m) =>
  Array.from({ length: slots }, (_, slot) => PublicKey.findProgramAddressSync(
    [Buffer.from("order"), m.address.toBuffer(), owner.toBuffer(), Buffer.from([slot])],
    program.programId)[0]));
function decodeOrders(keys: PublicKey[], infos: (AccountInfo<Buffer> | null)[]) {
  const out: { publicKey: PublicKey; account: any }[] = [];
  infos.forEach((info, i) => {
    if (!info) return;
    try { out.push({ publicKey: keys[i], account: program.coder.accounts.decode("order", info.data) }); }
    catch { /* not an order account */ }
  });
  return out;
}
async function ordersOf(owner: PublicKey): Promise<{ publicKey: PublicKey; account: any }[]> {
  const keys = orderKeysOf(owner);
  return decodeOrders(keys, (await getMany(keys)).infos);
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
    body.then((b) => accountLast.set(key, { at: Date.now(), body: b }),
      () => accountMemo.delete(key));
    res.json(await body);
  } catch (e: any) {
    const last = accountLast.get(ownerOf(req).toBase58());
    if (last) {
      res.set("X-Stale-Since", String(last.at));
      return res.json(last.body);
    }
    res.status(500).json({ error: e.message });
  }
});

async function accountView(owner: PublicKey) {
  {
    // Everything this wallet owns, in one batched read (one call up to about
    // thirty markets): its token accounts, its SOL, its withdrawal request and
    // token claim, a position slot per market and the order slots the site
    // uses. The pool, the LP supply and the markets come from the shared
    // snapshot. It was ten or so calls a view, one per account, plus a slot
    // read. An order placed by hand in a higher slot is shown from the
    // trigger keeper's list, which is at most a minute behind.
    const markets = Object.values(rt);
    const fixed = [ata(owner, usdcMint), ata(owner, lpMint), owner,
                   withdrawRequestPda(owner), lpTokenClaimPda(owner)];
    const posKeys = markets.map((m) => positionPda(m.address, owner));
    const orderKeys = orderKeysOf(owner, SITE_ORDER_SLOTS);
    const [{ infos, slot }, snap, traderPnl] = await Promise.all([
      getMany([...fixed, ...posKeys, ...orderKeys]),
      sharedState(),
      traderPnlNow(),
    ]);
    // A wallet that has never traded has no token accounts yet; that is a
    // zero balance, not an error. A failed read throws above, so the request
    // answers with the last good view (or an error) rather than $0.
    const tokens = (i: number) => {
      const info = infos[i];
      return { amount: info ? unpackAccount(fixed[i], info, info.owner).amount : 0n };
    };
    const usdc = tokens(0);
    const lpTok = tokens(1);
    // For the faucet prompt: a wallet short of rent cannot list or back.
    const sol = (infos[2]?.lamports ?? 0) / 1e9;
    const request: any = infos[3] ? program.coder.accounts.decode("withdrawRequest", infos[3].data) : null;
    const tokenClaim: any = infos[4] ? program.coder.accounts.decode("lpTokenClaim", infos[4].data) : null;
    const p = snap.pool;
    const supply = { value: { amount: snap.lpSupply.toString() } };
    const positions: Record<string, any> = {};
    for (const [i, m] of markets.entries()) {
      const info = infos[fixed.length + i];
      if (!info) continue;
      const pos = program.coder.accounts.decode("position", info.data);
      const d = describePosition(pos, snap.markets.get(m.address.toBase58()) ?? await marketAccount(m), m);
      if (d) positions[m.symbol] = d;
    }
    const me = owner.toBase58();
    const orderAccounts = [
      ...decodeOrders(orderKeys, infos.slice(fixed.length + markets.length)),
      ...(orderCache?.all ?? []).filter((e: any) =>
        Number(e.account.slot) >= SITE_ORDER_SLOTS && String(e.account.owner) === me),
    ];
    // Tokens past claims took in kind, by custody, waiting to be pulled.
    const owed = tokenClaim
      ? custodies
        .map((c) => ({ symbol: c.symbol, mint: c.mint.toBase58(),
                       amount: num(tokenClaim.owed[c.index]) / 10 ** c.decimals }))
        .filter((o) => o.amount > 0)
      : [];
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
    // Shares in escrow are still the owner's and still in supply: they move
    // with the pool until claimed, and are paid at the value then.
    const escrowed = request ? num(request.shares) / 1e6 : 0;
    const readySlot = request ? num(request.requestSlot) + WITHDRAW_COOLDOWN_SLOTS : 0;
    const slotsLeft = request && slot != null ? Math.max(0, readySlot - slot) : 0;
    const pending = escrowed > 0 ? {
      shares: escrowed, value: escrowed * lpPrice, readySlot, slotsLeft,
      // 400ms a slot is the target; the claim checks slots, not seconds.
      secondsLeft: Math.ceil(slotsLeft * 0.4),
    } : null;

    const unrealized = Object.values(positions).reduce(
      (a: number, x: any) => a + x.pnl, 0);
    const margin = Object.values(positions).reduce(
      (a: number, x: any) => a + x.collateral, 0);

    return {
      cluster: CLUSTER,
      address: owner.toBase58(),
      usdc: Number(usdc.amount) / 1e6,
      sol,
      margin, unrealized,
      equity: Number(usdc.amount) / 1e6 + margin + unrealized + (held + escrowed) * lpPrice,
      positions,
      orders,
      // This wallet's own. These were every wallet's last twenty, so a
      // trader's Liquidations tab listed other people's.
      liquidations: (fillsByOwner.get(me) ?? []).filter((f) => f.kind === "liquidation")
        .map(({ t, symbol, isLong, size, price, returned, pnl, fee }) =>
          ({ t, symbol, isLong: isLong ?? true, size, price, returned: returned ?? 0, pnl, fee })),
      deleverages: deleverages.filter((x) => x.owner === me),
      orderFills: orderFills.filter((x) => x.owner === me),
      lp: { held, price: lpPrice, value: held * lpPrice, pending, owed },
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

/*
 * Endpoints that sign as the server's own demo trader. A local chain uses
 * them for the demo account; anywhere else they let any visitor, or anyone
 * calling the API, trade one shared account and spend the server's SOL and
 * RPC budget, so they answer 403 and the page asks for a wallet instead.
 */
const DEMO_SIGNING = CLUSTER === "localnet" || IS_LOCAL;
const demoOnly: express.RequestHandler = (_req, res, next) => {
  if (DEMO_SIGNING) return next();
  res.status(403).json({ ok: false, error: "Connect a wallet: trades are signed by your own wallet." });
};

app.post("/api/order", demoOnly, async (req, res) => {
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

app.post("/api/close", demoOnly, async (req, res) => {
  const m = rt[req.body.symbol];
  if (!m) return res.status(404).json({ ok: false, error: "unknown market" });
  try {
    const { limit, size, builder } = await closeOrder(
      m, trader.publicKey, Number(req.body.size || 0));
    const sig = await builder.signers([trader]).rpc();
    res.json({ ok: true, sig, price: limit, size, pending: true });
  } catch (e) { res.status(400).json({ ok: false, error: explain(e) }); }
});

app.post("/api/deposit", demoOnly, async (req, res) => {
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

/// Starts the demo account's withdrawal. It is claimed after the cooldown
/// through `/api/tx/withdraw-claim`, like anyone's.
app.post("/api/withdraw", demoOnly, async (req, res) => {
  try {
    const ix = await requestWithdrawIx(trader.publicKey, Number(req.body.amount));
    await sendV0(conn, trader, [ix], []);
    res.json({ ok: true, pending: true });
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
      await rpcWho.run(name, fn).catch((e: any) => console.warn(`${name}: ${e?.message ?? e}`));
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

  /// The quotes the maker would rest in `m`'s batch now.
  ///
  /// `others` is what else is resting there, and `releasing` is how much of
  /// the position the maker's own closing quotes promise that the same
  /// transaction cancels first, so a requote can offer it again.
  const quoteIxs = async (m: MarketRt, others: any[], releasing: number, flatSide: boolean | null) => {
    const mark = px(m);
    if (!(mark > 0)) return [];
    const bidPx = mark * (1 - MAKER_SPREAD_BPS / 10_000);
    const askPx = mark * (1 + MAKER_SPREAD_BPS / 10_000);
    // Read whole rather than through `closableUsd`, which reports a position
    // promised entirely to closing quotes as no position. The maker then
    // quoted an open on the other side and the program refused the pair.
    // The maker's position and the market together: a quote is on the way
    // from a taker's order landing to its clear, so one read, not two in turn.
    const [info, ma]: [AccountInfo<Buffer> | null, any] = await Promise.all([
      conn.getAccountInfo(positionPda(m.address, maker.publicKey)), marketAccount(m)]);
    const p: any = info && program.coder.accounts.decode("position", info.data);
    const open = p && num(p.sizeUsd) > 0
      ? { isLong: p.isLong as boolean, usd: (num(p.sizeUsd) - num(p.closingUsd)) / 1e6 + releasing }
      : null;
    const accounts = orderAccounts(m, maker.publicKey);
    const quote = (price: number, size: number, isBid: boolean, reduce: boolean) =>
      program.methods
        .submitOrder(USD(price), USD(size), reduce ? new BN(0) : USD(size * 0.6), isBid, reduce, true)
        .accounts(accounts).instruction();

    // Positions do not flip, so the side the maker already holds is quoted as
    // an open and the other side as a close of what it holds. Flat, it may
    // open only one way a batch (the program refuses a wallet opening both),
    // so it takes the side the takers are short of: bids under net selling,
    // asks under net buying. Quoting both refused the pair, and a flat maker
    // never quoted at all. With no takers to read, the caller picks.
    const ixs: TransactionInstruction[] = [];
    const heldUsd = Math.max(0, open?.usd ?? 0);
    let net = 0;
    for (const o of others) if (!o.isMaker) net += (o.isBid ? 1 : -1) * num(o.sizeUsd);
    const sides = open ? [true, false]
      : net > 0 ? [false] : net < 0 ? [true] : flatSide === null ? [] : [flatSide];
    // An open past the side's open-interest cap is refused, and with it the
    // whole quote, so an open is sized to the room left: the cap less the
    // side's open interest and every open already resting on that side.
    const room = (isLong: boolean) => {
      const base = num(isLong ? ma.maxOiLongUsd : ma.maxOiShortUsd) / 1e6;
      const cap = Number(ma.session) === Session.Closed ? base * Number(ma.closedSessionOiMultBps) / 10_000 : base;
      const pending = others.filter((o) => !o.reduceOnly && !!o.isBid === isLong)
        .reduce((t, o) => t + num(o.sizeUsd) / 1e6, 0);
      return cap - num(isLong ? ma.longSizeUsd : ma.shortSizeUsd) / 1e6 - pending;
    };
    for (const isBid of sides) {
      const adds = !open || open.isLong === isBid;
      if (adds) {
        // A dollar short of the room, for the rounding between here and chain.
        const size = Math.min(MAKER_SIZE_USD, MAKER_MAX_POSITION_USD - heldUsd, room(isBid) - 1);
        if (size >= Math.max(1, num(ma.minPositionUsd) / 1e6)) {
          ixs.push(await quote(isBid ? bidPx : askPx, size, isBid, false));
        }
      } else if (heldUsd >= 1) {
        ixs.push(await quote(isBid ? bidPx : askPx, Math.min(MAKER_SIZE_USD, heldUsd), isBid, true));
      }
    }
    return ixs;
  };

  const makeMarket = async (m: MarketRt, state: any) => {
    const seq = Number(state.seq);
    if (quoted.get(m.symbol) === seq) return;
    const active = (state.orders as any[]).filter((o) => o.active);
    // Only where a taker is waiting, and only once per batch. A market with
    // standing quotes already has them in the batch.
    if (!active.some((o) => !o.isMaker && !isHouse(o.owner))) return;
    if (active.some((o) => isHouse(o.owner))) return;
    if (!(px(m) > 0)) return;
    quoted.set(m.symbol, seq);
    const ixs = await quoteIxs(m, active, 0, null);
    if (ixs.length) await sendV0(conn, authority, ixs, [], [maker]);
  };

  /// Standing quotes, on the markets most people open.
  ///
  /// Everywhere else the maker quotes only into a batch a taker is already
  /// waiting in, which fills them but leaves the book empty between trades.
  /// Here it keeps a quote resting at all times. A batch holding nothing but
  /// the maker's own quotes is not cleared (there is nothing for it to cross
  /// with), so a quote rests until a taker arrives or the mark moves half the
  /// spread away from it, and then it is cancelled and placed again in one
  /// transaction. Kept to a few markets because each requote is a
  /// transaction, and on every market at once they would outrun the RPC plan.
  const MAKER_STANDING = new Set((process.env.MAKER_STANDING ?? "SOL,JUP,HYPE,WIF,TRUMP")
    .split(",").map((s) => s.trim()).filter(Boolean));
  // About 58,000 RPC calls a day across five markets at worst (a position
  // read, a market read and a send per requote), against a key pool already
  // near its free-tier total.
  const REQUOTE_MS = Number(process.env.MAKER_REQUOTE_MS ?? 30_000);
  const requotedAt = new Map<string, number>();
  const flatTurn = new Map<string, boolean>();
  const standing = (m: MarketRt) =>
    MAKER_ON && MAKER_STANDING.has(m.symbol) && !(m.observed && !m.observed.seasoned);

  const keepStanding = async (m: MarketRt, state: any) => {
    const mark = px(m);
    if (!(mark > 0)) return;
    const orders = (state.orders as any[]).map((o, i) => ({ o, i })).filter(({ o }) => o.active);
    const mine = orders.filter(({ o }) => isHouse(o.owner));
    const others = orders.filter(({ o }) => !isHouse(o.owner)).map(({ o }) => o);
    const fresh = mine.length > 0 && mine.every(({ o }) => {
      const target = mark * (1 + (o.isBid ? -1 : 1) * MAKER_SPREAD_BPS / 10_000);
      return Math.abs(num(o.price) / 1e6 / target - 1) * 10_000 <= MAKER_SPREAD_BPS / 2;
    });
    // A taker waiting on a side the resting quote does not cover (a flat
    // maker rests one side only) is requoted for at once, once a batch.
    let net = 0;
    for (const o of others) if (!o.isMaker) net += (o.isBid ? 1 : -1) * num(o.sizeUsd);
    const need = net > 0 ? false : net < 0 ? true : null;
    const covered = need === null || mine.some(({ o }) => !!o.isBid === need);
    if (fresh && covered) return;
    if (!covered) {
      const seq = Number(state.seq);
      if (quoted.get(m.symbol) === seq) return;
      quoted.set(m.symbol, seq);
    } else if (mine.length) {
      // A quote the mark has left behind is replaced at most this often. A
      // book with no quote in it (the last one filled) is quoted at once.
      if (Date.now() - (requotedAt.get(m.symbol) ?? 0) < REQUOTE_MS) return;
      requotedAt.set(m.symbol, Date.now());
    } else {
      // Timed rather than once a batch: a batch holding nothing is not
      // cleared, so its seq never moves and a failed quote would never retry.
      if (Date.now() - (requotedAt.get(m.symbol) ?? 0) < 5_000) return;
      requotedAt.set(m.symbol, Date.now());
    }

    const releasing = mine.filter(({ o }) => o.reduceOnly).reduce((t, { o }) => t + num(o.sizeUsd) / 1e6, 0);
    const cancels = await Promise.all(mine.map(({ i }) =>
      program.methods.cancelBatchOrder(i).accounts({
        owner: maker.publicKey, pool, market: m.address, batch: batchPda(m.address),
        usdcMint, usdcVault, ownerUsdc: ata(maker.publicKey, usdcMint),
        position: positionPda(m.address, maker.publicKey), tokenProgram: TOKEN_PROGRAM_ID,
      }).instruction()));
    // Flat with nobody waiting, it can rest only one side; it alternates.
    const side = !(flatTurn.get(m.symbol) ?? false);
    flatTurn.set(m.symbol, side);
    const quotes = await quoteIxs(m, others, releasing, side);
    if (cancels.length || quotes.length) await sendV0(conn, authority, [...cancels, ...quotes], [], [maker]);
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
    // The pool, the LP mint and every market ride along in the same call:
    // that is the shared snapshot the pages and the other keepers read, kept
    // fresh here for nothing.
    const markets = Object.values(rt);
    const keys = sharedKeys();
    const at = Date.now();
    const { infos: all } = await getMany([...markets.map((m) => batchPda(m.address)), ...keys]);
    try { noteShared(keys, all.slice(markets.length), at); }
    catch (e: any) { console.warn(`snapshot: ${e?.message ?? e}`); }
    const infos = all.slice(0, markets.length);
    const due: { m: MarketRt; state: any; open: boolean; quoteOnly?: boolean }[] = [];
    for (const [i, m] of markets.entries()) {
      const info = infos[i];
      // No batch yet is an answer too: the page's poll should not read it again.
      if (!info) { batchSeen.set(m.symbol, { state: null, at }); continue; }
      const state: any = program.coder.accounts.decode("batch", info.data);
      batchSeen.set(m.symbol, { state, at });
      // An open batch with nothing in it has nothing to clear. Clearing it
      // anyway only restarts its window, and cost a transaction per market
      // every second. Once an order lands the batch is already overdue
      // and clears on the next pass. The same goes for a batch holding only
      // the maker's standing quotes: they rest until a taker comes, and are
      // only looked at to see whether the mark has left them behind.
      const open = Number(state.clearedTs) === 0;
      if (open && !state.orders.some((o: any) => o.active && !isHouse(o.owner))) {
        if (standing(m)) due.push({ m, state, open, quoteOnly: true });
        continue;
      }
      due.push({ m, state, open });
    }
    if (due.some((d) => !d.quoteOnly)) heatAuction(10_000);

    /*
     * Up to AUCTION_PARALLEL markets at once, each on its own clock. Each
     * market has its own batch account, so nothing orders them against each
     * other. Worked one after another, every quote, clear and settlement
     * waited on the market before it; worked as a pass that waited for all of
     * them, every market waited on the slowest (one settling thirty orders in
     * several transactions). A market is started as soon as it is due and
     * not already being worked, and the pass does not wait for it.
     */
    const work = async ({ m, state, open, quoteOnly }: { m: MarketRt; state: any; open: boolean; quoteOnly?: boolean }) => {
      // Quote before clearing, into the batch the takers are waiting in. A
      // listing still seasoning has no mark to quote around yet.
      if (MAKER_ON && open && !(m.observed && !m.observed.seasoned)) {
        await (standing(m) ? keepStanding(m, state) : makeMarket(m, state)).catch((e: any) =>
          console.warn(`maker ${m.symbol}: ${explain(e)}`));
      }
      if (quoteOnly) return;
      // One market that cannot clear must not hold up the rest.
      try { await clearAndSettle(m, state); }
      catch (e: any) {
        // The chain's clock runs a little behind this one; a batch the
        // program says is not due yet is simply early, and is tried again
        // next second.
        // "Already processed" is a resend of a clear that landed: done, not failed.
        if (!/BatchNotDue|already been processed/.test(String(e?.message ?? e))) {
          // The reason a failed simulation carries is in its last log lines.
          // "Simulation failed." keeps its reason on later lines of the
          // message, which explain() drops.
          const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
          const rest = String(e?.message ?? "").split("\n").slice(1).join(" ").replace(/\s+/g, " ").slice(0, 300);
          console.warn(`auction ${m.symbol}: ${explain(e)}${logs.length ? ` | ${logs.slice(-3).join(" | ")}` : rest ? ` | ${rest}` : ""}`);
        }
      }
    };
    for (const d of due) {
      if (auctionWorking.size >= AUCTION_PARALLEL) break;
      if (auctionWorking.has(d.m.symbol)) continue;
      auctionWorking.add(d.m.symbol);
      void work(d).finally(() => {
        auctionWorking.delete(d.m.symbol);
        // A settlement moves positions; the next read of those wallets should
        // see them rather than a view cached before it.
        for (const o of settledOwners) accountMemo.delete(o);
        settledOwners.clear();
      });
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

      let sig: string | null = null;
      if (open) {
        sig = await program.methods
          .clearBatch()
          .accounts({ pool, market: m.address, batch, priceUpdate: oracleOf(m) })
          // A full batch (64 orders) takes about 202k compute units to clear,
          // just past the 200k default: KITE's sat full and uncleared, every
          // order in it stuck, until it was given room.
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
          .rpc();
      }

      // The sealed batch and the market's fee in one read: every call here
      // sits between a trader's order landing and their position showing.
      const { infos: [batchInfo, marketInfo] } = await getMany([batch, m.address]);
      if (!batchInfo || !marketInfo) throw new Error(`batch or market account missing for ${m.symbol}`);
      const sealed: any = program.coder.accounts.decode("batch", batchInfo.data);
      const ma: any = program.coder.accounts.decode("market", marketInfo.data);
      marketReads.set(m.address.toBase58(), { at: Date.now(), body: Promise.resolve(ma) });
      if (sig) {
        const houseUsd = (sealed.orders as any[])
          .filter((o) => o.active && o.isMaker && isHouse(o.owner))
          .reduce((t, o) => t + Number(o.filledUsd) / 1e6, 0);
        // Best effort and not waited on: the clear has already landed, and
        // reading its logs back (a getTransaction) held every settlement up
        // behind a figure only the stats use.
        void recordClear(m.symbol, sig, houseUsd).catch((e: any) =>
          console.warn(`clear log ${m.symbol}: ${e?.message ?? e}`));
      }
      if (Number(sealed.clearedTs) === 0) return;
      const openFeeBps = num(ma.openFeeBps);

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
        settledOwners.add(new PublicKey(o.owner).toBase58());
        // Now, not when the whole market's work ends: a busy batch settles
        // in several groups, and this owner's group has already landed.
        accountMemo.delete(new PublicKey(o.owner).toBase58());
        if (!(Number(o.filledUsd) > 0)) return null;
        {
          // A fill opened or resized a position the liquidation check holds.
          positionsChanged(new PublicKey(o.owner).toBase58());
          const size = Number(o.filledUsd) / 1e6;
          const rec = recordTrade({
            symbol: m.symbol,
            side: o.isBid ? "buy" : "sell",
            size,
            // An open's fee at the market's rate; a close's comes from its event.
            ...(o.reduceOnly ? {} : { fee: (size * openFeeBps) / 10_000 }),
            // Its own flow's price: the batch cleared twice.
            price: Number(flowOf({ isBid: !!o.isBid, isMaker: !!o.isMaker }) === "buy"
              ? sealed.buyPrice : sealed.sellPrice) / 1e6,
            // A reduce-only fill closed part of a position; recording every
            // fill as an open listed closes as opens in the trade history.
            kind: o.reduceOnly ? "close" : "open",
            // The devnet's own maker, labeled so the tape does not pass its
            // fills off as somebody else's.
            ...(isHouse(o.owner) ? { house: true } : {}),
            owner: new PublicKey(o.owner).toBase58(),
          });
          noteFill(m.address.toBase58(), new PublicKey(o.owner).toBase58(), Number(o.filledUsd) / 1e6);
          return rec;
        }
      };
      // Best effort, after the fact: a fill is on the tape whether or not its
      // logs can be read back.
      const enrich = (sig: string, recs: ReturnType<typeof settled>[]) => {
        // The settling transaction, so each fill in the history links to it.
        for (const r of recs) if (r) r.entry.sig = sig;
        fillsDirty = true;
        void enrichFills(sig, recs).catch((e: any) => console.warn(`fill log ${m.symbol}: ${e?.message ?? e}`));
      };
      const send = (ixs: TransactionInstruction[]) =>
        provider.sendAndConfirm(new Transaction().add(...withComputeLimit(ixs)));
      // The groups go out together, up to SETTLE_PARALLEL at a time, rather
      // than each waiting for the one before it to confirm. A batch is sealed
      // until its last order settles and refuses new orders meanwhile, so
      // settling fifty orders a group at a time held a busy market shut for
      // about a minute, and that is most of why opens took 40s and more.
      const groups: { group: TransactionInstruction[]; members: typeof pending }[] = [];
      let at = 0;
      for (const group of packInstructions(pending.map((d) => d.ix), authority.publicKey)) {
        groups.push({ group, members: pending.slice(at, at + group.length) });
        at += group.length;
      }
      const failed: typeof pending = [];
      let nextGroup = 0;
      await Promise.all(Array.from({ length: Math.min(SETTLE_PARALLEL, groups.length) }, async () => {
        while (nextGroup < groups.length) {
          const { group, members } = groups[nextGroup++];
          try { const sig = await send(group); enrich(sig, members.map((d) => settled(d.o))); }
          catch { failed.push(...members); }
        }
      }));
      if (failed.length) {
        // One order that cannot settle fails its whole transaction, so retry
        // those one at a time rather than strand the others. But a group that
        // timed out has often landed: read the batch again and retry only
        // what is still active. Retrying all of them sent a transaction per
        // settled order that could only fail (`InvalidParameter`).
        const now: any = await program.account.batch.fetch(batch).catch(() => null);
        for (const d of failed) {
          if (now && !now.orders[d.i]?.active) { settled(d.o); continue; }
          try { const sig = await send([d.ix]); enrich(sig, [settled(d.o)]); }
          catch (e: any) { console.warn(`settle ${m.symbol}#${d.i}: ${e?.message ?? e}`); }
        }
      }
    }
  };

  // Before the first tick, which prices the custodies alongside the markets.
  try { await loadCustodies(); await loadBooks(); }
  catch (e: any) { console.warn(`custodies: ${explain(e)}`); }
  loop("tick", tick, TICK_MS);
  // Its own loop rather than `loop`: the wait between passes is short while
  // anything is resting or an order was just built, and long otherwise, and
  // a long wait ends early the moment an order arrives.
  {
    const pass = async () => {
      // A kick that arrives while this pass runs is for the next one.
      auctionKicked = false;
      await rpcWho.run("auction", auction).catch((e: any) => console.warn(`auction: ${e?.message ?? e}`));
      // Each market's work clears the cached views of the wallets it settled
      // when it finishes (see `auction`), not when the pass does.
      const hot = Date.now() < auctionHotUntil;
      const until = Date.now() + (hot ? AUCTION_MS : AUCTION_IDLE_MS);
      // Checked every 100ms, so a landed order is seen within a tenth of a
      // second rather than at the next whole tick (the tick alone was up to
      // a second of every trade's wait). An idle loop also wakes when an
      // order is being built.
      const wait = () => (Date.now() >= until || auctionKicked
        || (!hot && Date.now() < auctionHotUntil - 29_000))
        ? void pass() : void setTimeout(wait, 100);
      setTimeout(wait, 100);
    };
    setTimeout(pass, AUCTION_MS);
  }
  loop("sessions", syncSessions, SESSION_MS);
  // No deleveraging pass: the program retired it. A winner its market cannot
  // pay in full is haircut at close instead, so no position is ever due.
  // Every few seconds against the cached positions (see positionCache).
  setTimeout(() => loop("liquidations", liquidationCheck, LIQ_CHECK_MS), 3_000);
  loop("balance", watchBalance, 10 * 60_000);
  if (MAKER_ON) {
    await fundMaker().catch((e: any) => console.warn(`maker funds: ${explain(e)}`));
    loop("maker funds", fundMaker, 10 * 60_000);
  }
  // The testnet's own pools shadow real tokens so their markets move. Loaded
  // only there: nothing else has pools this process is allowed to trade.
  if (CLUSTER === "devnet") {
    const { makeFlow } = await import("./testnet-flow");
    loop("flow", makeFlow(conn, authority, usdcMint, seeded), FLOW_MS);
  }
  // Offset, so the two heaviest calls in the process never coincide.
  // Every few seconds against the cached list (see orderCache).
  setTimeout(() => loop("orders", orderKeeper, ORDER_CHECK_MS), 5_000);
  loop("crank", crank, CRANK_MS);
  // The AUM checkpoint deposits and withdrawals are priced from.
  loop("aum", keepAumWarm, AUM_EVERY_MS);
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
  void rpcWho.run("listed day", refreshListedDay).catch((e: any) => console.warn(`listed day: ${e?.message ?? e}`));
  loop("listed day", refreshListedDay, 10 * 60_000);
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
  // Every mint's account in one read: a deposit checks two, and each read in
  // turn was a round trip before the wallet could even be asked.
  const addrs = mints.map((mint) => ata(owner, mint));
  const { infos } = await getMany(addrs);
  return mints.flatMap((mint, i) => infos[i]
    ? [] : [createAssociatedTokenAccountInstruction(owner, addrs[i], owner, mint)]);
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
  const real = await shadowMintMap();
  await loadIcons([...real.values()]);
  // Not the invented tokens: they copy nothing, and are not listed again.
  const invented = await inventedPools();
  res.json(seeded.filter((s) => !invented.has(s.pair)).map((s) => ({
    symbol: s.symbol, name: s.name, pool: s.pair, listed: listed.has(s.pair), real: real.get(s.pair) ?? null,
    icon: iconPath(real.get(s.pair)),
  })));
});

/*
 * A devnet mirror of a mainnet pool, made on request.
 *
 * Devnet can only list a pool that is on devnet, and every real pool is on
 * mainnet. So listing a mainnet token on devnet lists a mirror of its pool:
 * a test token under the real ticker and decimals, in a Meteora DLMM pool
 * against test USDC at the real price, with liquidity laid so its depth
 * (USD to move it 1%) matches the mainnet pool's. Leverage, open-interest
 * caps and budgets come out of that depth on chain exactly as they would on
 * mainnet. From then on the flow keeps the mirror at the real price and the
 * keeper marks it there, like the seeded copies. One mirror per mainnet mint;
 * making one does not list it.
 *
 * It spends the authority's SOL (about 0.2 a mirror), so it is capped per day
 * in all and per address, and stops above the floor the crank needs.
 */
const COPY_PER_DAY = Number(process.env.COPY_PER_DAY ?? 50);
const COPY_PER_IP_PER_DAY = Number(process.env.COPY_PER_IP_PER_DAY ?? 8);
const COPY_MIN_DEPTH_USD = 1_000;
const COPY_SOL = 0.3;
/// A side of liquidity this many times a depth gives about that depth: the
/// spot shape lays 61 bins of 0.1%, and a 1% move crosses ten of them plus
/// the fees. Measured: a $33,829 side read as $10,306.
const SIDE_PER_DEPTH = 3.3;
const MAX_SIDE_USD = 180_000;
let copying: Promise<unknown> = Promise.resolve();
app.post("/api/devnet-copy", async (req, res) => {
  try {
    if (CLUSTER !== "devnet") throw new Error("mirrors are made on devnet only");
    const real = new PublicKey(String(req.body?.mint ?? "")).toBase58();
    const mirrored = await shadowMintMap();
    const existing = seeded.find((s) => mirrored.get(s.pair) === real);
    if (existing) {
      const d = await readPool(conn, new PublicKey(existing.pair), usdcMint);
      return res.json({ pool: existing.pair, symbol: existing.symbol, depthUsd: d.depthUsd, created: false });
    }
    if (QUOTE_MINTS[real]) throw new Error("stablecoins are the quote side, not a market");

    // The mainnet pool being mirrored, read by the same preview the page
    // showed: its depth is what the mirror is built to.
    const source = new PublicKey(String(req.body?.pool ?? "")).toBase58();
    const pr = await mainnetPoolPreview(new Request(`http://localhost/api/pool/${source}`));
    const main: any = await pr.json();
    if (!pr.ok || main.error) throw new Error(main.error ?? "could not read that pool on mainnet");
    if (main.base !== real) throw new Error("that pool doesn't trade that token");
    const depthUsd = Number(main.depthUsd) || 0;
    if (depthUsd < COPY_MIN_DEPTH_USD) throw new Error("that pool is too thin to list");

    const ip = clientIp(req);
    const today = copies.filter((c) => Date.now() - (c.t ?? 0) < DAY_MS);
    if (today.length >= COPY_PER_DAY) throw new Error("devnet has mirrored all it can today; try again tomorrow");
    if (today.filter((c) => c.ip === ip).length >= COPY_PER_IP_PER_DAY) {
      throw new Error("too many new tokens from this address today");
    }
    if ((await conn.getBalance(authority.publicKey)) / 1e9 - COPY_SOL < AUTHORITY_SOL_FLOOR) {
      throw new Error("devnet is out of SOL for new tokens right now");
    }

    // Ticker, decimals and price, as Jupiter knows the token.
    const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${real}`,
      { headers: { "user-agent": BROWSER_UA }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`token lookup failed (${r.status})`);
    const t = ((await r.json()) as any[]).find((x) => x.id === real);
    if (!t || !(t.usdPrice > 0) || !Number.isInteger(t.decimals)) throw new Error("no price for that token on mainnet");
    if (t.icon) tokenIcons.set(real, t.icon);

    // One at a time: two mirrors of one token must not both be made.
    const made = copying.then(async () => {
      const again = seeded.find((s) => s.real === real);
      if (again) return again;
      const { seedPool } = await import("./testnet-flow");
      const sideUsd = Math.round(Math.min(MAX_SIDE_USD, depthUsd * SIDE_PER_DEPTH));
      const { mint, pair } = await seedPool(conn, authority, usdcMint,
        { price: t.usdPrice, decimals: t.decimals, sideUsd });
      const clean = String(t.symbol ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 12) || real.slice(0, 4);
      const symbol = seeded.some((s) => s.symbol === clean) ? `${clean.slice(0, 7)}-${real.slice(0, 4)}` : clean;
      const copy: SeededPool = {
        symbol, name: String(t.name ?? symbol), mint: mint.toBase58(), pair: pair.toBase58(),
        real, sideUsd, t: Date.now(), ip,
      };
      copies.push(copy); seeded.push(copy);
      // The address is kept only while it counts toward the daily limit; the
      // privacy policy says a day.
      for (const c of copies) if (c.ip && Date.now() - (c.t ?? 0) >= DAY_MS) delete c.ip;
      fs.writeFileSync(COPIES_FILE, JSON.stringify(copies, null, 2));
      shadowMints = null; shadowNames = null;
      console.log(`devnet mirror ${symbol} of ${source}: pool ${copy.pair}, $${sideUsd} a side for $${Math.round(depthUsd)} depth`);
      return copy;
    });
    copying = made.catch(() => {});
    const copy = await made;
    const d = await readPool(conn, new PublicKey(copy.pair), usdcMint);
    res.json({ pool: copy.pair, symbol: copy.symbol, depthUsd: d.depthUsd, created: true });
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
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
    const real = (await shadowMintMap()).get(p.address);
    if (real) await loadIcons([real]);
    res.json({
      ...p,
      // A devnet copy shows the real token's logo.
      ...(real ? { icon: iconPath(real) } : {}),
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
// An order, a close or a trigger built here will land in a batch within
// seconds: run the auction at full speed for a while.
app.use("/api/tx", (_req, _res, next) => { heatAuction(); next(); });

/// Who has a listing built and not yet sent, and when. The send that carries
/// it looks for the new market straight away: discovery runs every two
/// minutes otherwise, and the lister was told "live" while the site did not
/// show the market for that long.
///
/// Keyed by the lister. It used to be one timestamp, and for five minutes
/// after anyone built a listing every transaction anyone sent ran a full
/// discovery (three program-wide account scans). Under load that was most of
/// the server's RPC calls: 22,905 in eight minutes with a hundred wallets
/// trading, against 9,034 for every account read together, and every key
/// spent its rate limit on it.
const listingsBuilt = new Map<string, number>();

/// One discovery pass at a time. A request while one runs asks for exactly
/// one more after it, however many arrive.
let discovering: Promise<void> | null = null;
let discoverAgain = false;
function discoverSoon() {
  if (discovering) { discoverAgain = true; return; }
  discovering = rpcWho.run("discover", async () => {
    await discoverMarkets(); await observer(); await refreshListedDay();
  })
    .catch((e: any) => console.warn(`discover after listing: ${e?.message ?? e}`))
    .finally(() => {
      discovering = null;
      if (discoverAgain) { discoverAgain = false; discoverSoon(); }
    });
}

/// Whether `market` is a listing the site would have made and can trade:
/// backed, not paused, and observing with the settings `list-market` uses.
/// Anything else (an unbacked or paused market, or one listed by hand with
/// other observation settings) may be relisted from the site.
async function liveSiteListing(market: PublicKey, unitExp: number): Promise<boolean> {
  const m: any = await program.account.market.fetchNullable(market);
  if (!m || m.paused || potUsd(market, m.backingUsd) <= 0) return false;
  const o: any = await program.account.observation.fetchNullable(observationPda(market));
  return !!o && o.alphaBps === 500 && o.maxMoveBps === 100 && (o.unitExp ?? 0) === unitExp;
}

app.post("/api/tx/list-market", async (req, res) => {
  try {
    const owner = ownerOf(req);
    listingsBuilt.set(owner.toBase58(), Date.now());
    const source = new PublicKey(req.body.pool);
    if ((await inventedPools()).has(source.toBase58())) {
      return res.status(400).json({
        error: "that pool holds a made-up devnet test token; list a real token's devnet copy instead",
      });
    }
    const p = await readPool(conn, source, usdcMint);
    // The token's own name, not the request's. See `listingName`.
    const { symbol } = await listingName(p.base, p.address, p.unitExp);
    if (p.depthUsd <= 0) {
      return res.status(400).json({
        error: "that pool has no active liquidity, so a market on it could never quote",
      });
    }

    // No feed, so the id is the hash of "amm:" and the pool's raw address.
    // The program checks it (`observed_feed_id`), which keeps an AMM market
    // off any address a Pyth feed would claim.
    const feedId = crypto.createHash("sha256")
      .update(Buffer.concat([Buffer.from("amm:"), source.toBuffer()])).digest();
    // Each listing of a pool is a new generation at its own address, so a
    // bad earlier listing never blocks this one. The site still refuses to
    // list over a market it already shows as live: backed, not paused, and
    // observing this pool with the site's own settings.
    const shown = shownByFeed.get(feedId.toString("hex"));
    if (shown && await liveSiteListing(new PublicKey(shown), p.unitExp)) {
      return res.status(400).json({ error: "that pool already has a market" });
    }
    const { generation, market } = await nextMarket(program, pool, feedId);
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
      }, generation)
      .accounts({
        payer: owner, pool, generations: marketGenerationsPda(program.programId, pool, feedId),
        market, systemProgram: SystemProgram.programId,
      })
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
      generation,
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
  await seasonReady().catch((e: any) => console.warn(`season: ${explain(e)}`));
  rollWeek(traders);
  const known = new Set(traders.map((t) => t.owner.toBase58()));
  for (const t of traders) {
    if (t.referrer.equals(PublicKey.default)) continue;
    if (num(t.referrerPointsOwed) === 0 && num(t.referrerRewardsOwed) === 0) continue;
    ixs.push(await program.methods.syncReferral()
      .accounts({ referee: traderPda(t.owner), referrer: traderPda(t.referrer) })
      .instruction());
  }
  // Every market from the shared snapshot, not a read per market a minute.
  const byAddress = await marketsByAddress();
  for (const m of Object.values(rt)) {
    const acc: any = byAddress.get(m.address.toBase58());
    // A deployer with no `Trader` has nowhere to be paid; it waits on the
    // market until they make one.
    if (!acc || !known.has(acc.deployer.toBase58())) continue;
    if (num(acc.deployerRewardsUsd) === 0 && num(acc.deployerPointsOwed) === 0
      && num(acc.volumeUsd) === num(acc.deployerSyncedVolumeUsd)) continue;
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


/*
 * Seasons.
 *
 * Points are an all-time total on chain, in a `Trader` account per wallet
 * that no pool owns, so a new pool cannot start them from zero. A season is
 * a view over them instead: the first time this server runs against a pool
 * it stores every wallet's totals as the season's baseline, and everything
 * shown (the rewards page, the leaderboard, the week) is the distance from
 * it. Kept in .cache, which a deploy carries over; a restart against the
 * same pool keeps the season, and a new pool starts the next one.
 */
const SEASON_FILE = path.join(ROOT, ".cache", `${CLUSTER}-season.json`);
let season: Season | null = null;
let priorSeason: Season | null = null;
try {
  const s: Season = JSON.parse(fs.readFileSync(SEASON_FILE, "utf8"));
  if (s.pool === pool.toBase58()) season = s; else priorSeason = s;
} catch { /* none yet */ }
let seasonWork: Promise<void> | null = null;
/// Resolves once the season is known, taking its baseline if this pool has
/// none. Points are never served without one: raw totals would show the
/// last season's standings as this one's.
function seasonReady(): Promise<void> {
  if (season) return Promise.resolve();
  seasonWork ??= (async () => {
    const traders = (await program.account.trader.all()).map((r: any) => r.account);
    const now = Math.floor(Date.now() / 1000);
    const next: Season = {
      season: (priorSeason?.season ?? 1) + 1,
      pool: pool.toBase58(),
      start: now,
      base: Object.fromEntries(traders.map((t: any) => [t.owner.toBase58(), {
        points: livePoints(t, now),
        trading: num(t.tradingPoints) / 1e6,
        referrals: num(t.referralPoints) / 1e6,
        listing: num(t.listingPoints) / 1e6,
        volume: num(t.volumeUsd) / 1e6,
        given: num(t.givenToReferrerPoints) / 1e6,
        backingUsd: num(t.backingUsd) / 1e6,
        lpUsd: num(t.lpUsd) / 1e6,
      }])),
    };
    fs.mkdirSync(path.dirname(SEASON_FILE), { recursive: true });
    fs.writeFileSync(SEASON_FILE, JSON.stringify(next));
    season = next;
    console.log(`season ${next.season} started for pool ${next.pool}: ${traders.length} wallets at their baseline`);
  })().finally(() => { seasonWork = null; });
  return seasonWork;
}

/// A wallet's standing this season (`seasonStanding`).
function seasonOf(t: any, now = Math.floor(Date.now() / 1000)) {
  return seasonStanding(t, season, now);
}

/*
 * Weekly standings.
 *
 * A week is a view over the season. The first read after Monday 00:00 UTC
 * stores every wallet's season points as the week's baseline, and "this
 * week" is the distance from it. Kept on disk so a restart mid-week does not
 * reset the week.
 */
const WEEK_FILE = path.join(__dirname, "..", ".cache", "points-week.json");
let week: { start: number; base: Record<string, number>; season?: number } = { start: 0, base: {} };
try { week = JSON.parse(fs.readFileSync(WEEK_FILE, "utf8")); } catch { /* first run */ }
function rollWeek(traders: any[]) {
  const start = weekStart();
  if (!season) return;
  const saveWeek = () => {
    try {
      fs.mkdirSync(path.dirname(WEEK_FILE), { recursive: true });
      fs.writeFileSync(WEEK_FILE, JSON.stringify(week));
    } catch (e: any) { console.warn(`points week: ${e?.message ?? e}`); }
  };
  // A week begun in an earlier season is that season's: everything since
  // this one started counts as this week, as on a first run.
  if (week.season !== season.start) {
    week = { start, base: {}, season: season.start };
    saveWeek();
    return;
  }
  if (week.start === start) return;
  const now = Math.floor(Date.now() / 1000);
  week = {
    start,
    base: Object.fromEntries(traders.map((t) => [t.owner.toBase58(), seasonOf(t, now).points])),
    season: season.start,
  };
  saveWeek();
}

/// The server's own wallets: the pool authority (which also runs the flow
/// that moves the seeded pools and pays the faucet), the LP key the market
/// maker trades from, the demo trader, and the price relay. They keep the
/// venue running and are never ranked or counted.
const HOUSE = new Set([authority, lp, trader, poster].map((k) => k.publicKey.toBase58()));

const shortKey = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

/// A wallet's referral standing and points, as the program keeps them.
app.get("/api/rewards", async (req, res) => {
  try {
    const owner = ownerOf(req);
    // The wallet's own record and the two shared reads together: one after
    // another they were three round trips before the page had a figure.
    const [t, byAddress, traders]: [any, Map<string, any>, any[]] = await Promise.all([
      program.account.trader.fetchNullable(traderPda(owner)), marketsByAddress(), allTraders(), seasonReady()]) as any;
    const now = Math.floor(Date.now() / 1000);

    // The markets this wallet opened, with what each has earned it.
    const listed: {
      symbol: string; volume: number; earned: number; pending: number; pendingPoints: number;
      traders: number;
    }[] = [];
    // Every market from the batched read, not a request each: nineteen in a
    // row kept the page's points blank for seconds after the leaderboard.
    for (const m of Object.values(rt)) {
      const acc: any = byAddress.get(m.address.toBase58());
      if (!acc || !acc.deployer.equals(owner)) continue;
      listed.push({
        symbol: m.symbol,
        volume: num(acc.volumeUsd) / 1e6,
        earned: num(acc.deployerEarnedUsd) / 1e6,
        pending: num(acc.deployerRewardsUsd) / 1e6,
        pendingPoints: (num(acc.volumeUsd) - num(acc.deployerSyncedVolumeUsd)) / 1e6 * 0.1
          + num(acc.deployerPointsOwed) / 1e6,
        traders: countedTraders(m.address.toBase58(), owner.toBase58(), HOUSE),
      });
    }
    const creatorScore = listed.reduce((a, m) => a + m.traders, 0);
    const listingPending = listed.reduce((a, m) => a + m.pending, 0);
    const listingPendingPoints = listed.reduce((a, m) => a + m.pendingPoints, 0);
    const listingVolume = listed.reduce((a, m) => a + m.volume, 0);

    // Everyone who named this wallet, and what each has earned it so far.
    const referees = traders
      .filter((r) => r.referrer.equals(owner))
      .map((r) => ({
        wallet: r.owner.toBase58(),
        code: r.code[0] ? codeText(r.code) : null,
        volume: seasonOf(r, now).volume,
        points: seasonOf(r, now).given,
        usdc: num(r.givenToReferrerUsd) / 1e6,
        since: num(r.createdTs),
      }))
      .sort((a, b) => b.volume - a.volume);

    const base = {
      account: traderPda(owner).toBase58(), asOf: now, listed, listingVolume, referees, creatorScore,
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
      // A code is set once and kept, so the shared list answers for any
      // referrer it already holds; only one newer than it is read.
      const r: any = traders.find((x) => x.owner.equals(t.referrer) && x.code[0])
        ?? await program.account.trader.fetchNullable(traderPda(t.referrer));
      referrerCode = r && r.code[0] ? codeText(r.code) : null;
    }
    // This season's, not the all-time totals the program keeps.
    const mine = seasonOf(t, now);
    const points = mine.points + listingPendingPoints;
    // Where the total came from, as the program counts it: trading points
    // after the hold rule and the daily cap, referral and listing points as
    // synced, plus listing points still waiting. The stakes are the rest.
    const trading = mine.trading;
    const referrals = mine.referrals;
    const listing = mine.listing + listingPendingPoints;
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
      volume: mine.volume,
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
    await seasonReady();
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
        const { points, volume } = seasonOf(t, now);
        return {
          wallet, short: shortKey(wallet), code: t.code[0] ? codeText(t.code) : null,
          points, week: Math.max(0, points - (week.base[wallet] ?? 0)),
          volume,
        };
      })
      .filter((r) => r.points > 0);
    // What the program has paid out so far, for the page's header strip:
    // every referral share and every deployer share, claimed or not.
    // This pool's markets only: markets from pools the program has outlived
    // are still on chain, in older layouts that no longer decode.
    // As discovery last read them: a figure that moves with claims, not
    // with every poll of the page.
    const markets: any[] = (await poolMarkets()).map((m: any) => m.account);
    const paidUsd =
      traders.reduce((a, t) => a + num(t.givenToReferrerUsd), 0) / 1e6 +
      markets.reduce((a, m) => a + num(m.deployerEarnedUsd), 0) / 1e6;
    const allPoints = traders
      .filter((t) => !HOUSE.has(t.owner.toBase58()))
      .reduce((a, t) => a + seasonOf(t, now).points, 0);
    const by = req.query.period === "week" ? "week" : "points";
    rows.sort((a, b) => b[by] - a[by]);
    const total = rows.reduce((a, r) => a + r[by], 0);
    const top20 = rows.slice(0, 20).reduce((a, r) => a + r[by], 0);
    const me = req.query.owner ? String(req.query.owner) : null;
    const mine = me ? rows.findIndex((r) => r.wallet === me) : -1;
    res.json({
      period: by === "week" ? "week" : "all",
      weekStart: week.start,
      season: season?.season ?? null,
      seasonStart: season?.start ?? null,
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

/// Devnet creators, ranked by distinct traders: for each market a wallet
/// opened, the wallets that filled $100 or more there, each counted once and
/// never the deployer's own; summed over the deployer's markets. The rule is
/// in docs/devnet.md. The server's own markets are not ranked.
app.get("/api/creators", async (req, res) => {
  try {
    const byAddress = await marketsByAddress();
    const by = new Map<string, { score: number; markets: { symbol: string; traders: number }[] }>();
    for (const m of Object.values(rt)) {
      const acc: any = byAddress.get(m.address.toBase58());
      if (!acc) continue;
      const deployer = acc.deployer.toBase58();
      if (HOUSE.has(deployer) || await hiddenMarket(m)) continue;
      const traders = countedTraders(m.address.toBase58(), deployer, HOUSE);
      const row = by.get(deployer) ?? { score: 0, markets: [] };
      row.score += traders;
      row.markets.push({ symbol: m.symbol, traders });
      by.set(deployer, row);
    }
    const codes = new Map((await allTraders()).map((t) =>
      [t.owner.toBase58(), t.code[0] ? codeText(t.code) : null]));
    const rows = [...by.entries()]
      .map(([wallet, r]) => ({
        wallet, short: shortKey(wallet), code: codes.get(wallet) ?? null, score: r.score,
        markets: r.markets.sort((a, b) => b.traders - a.traders),
      }))
      .sort((a, b) => b.score - a.score || b.markets.length - a.markets.length);
    const me = req.query.owner ? String(req.query.owner) : null;
    const mine = me ? rows.findIndex((r) => r.wallet === me) : -1;
    res.json({
      minVolumeUsd: CREATOR_MIN_TRADER_USD,
      creators: rows.length,
      top: rows.slice(0, 25).map((r, i) => ({ rank: i + 1, ...r })),
      me: mine >= 0 ? { rank: mine + 1, ...rows[mine] } : null,
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
    // The token accounts are read alongside the markets, not after them.
    const [accounts, atas] = await Promise.all([allMarketAccounts(), ataIxs(owner, [usdcMint, lpMint])]);
    const ix = await program.methods
      .addLiquidity(USD(amount), new BN(0))
      .accounts(liquidityAccounts(owner))
      .remainingAccounts(accounts).instruction();
    res.json(await buildTx(owner, [LIQUIDITY_CU, ...atas, ix], await tablesFor(accounts)));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/*
 * Withdrawing is two transactions. `withdraw` moves LP tokens into escrow;
 * `withdraw-claim`, once the cooldown has passed, burns them and pays USDC at
 * what the pool is worth then; `withdraw-cancel` hands them back. The page
 * never prices the payout: the program does, at the claim.
 */

/// Takes LP tokens, not dollars. Escrows them; nothing is paid yet.
app.post("/api/tx/withdraw", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const lp = Number(req.body.lpAmount);
    if (!(lp > 0)) return res.status(400).json({ error: "amount must be positive" });
    res.json(await buildTx(owner, [await requestWithdrawIx(owner, lp)]));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/// Claims everything in escrow, priced from a fresh AUM checkpoint.
app.post("/api/tx/withdraw-claim", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const r: any = await program.account.withdrawRequest.fetchNullable(withdrawRequestPda(owner));
    if (!r || num(r.shares) === 0) return res.status(400).json({ error: "nothing waiting to be claimed" });
    // Writable: a claim takes its part of the LP-held tokens off each custody.
    await allMarketAccounts();
    const accounts = custodyPairs(true);
    const ix = await claimWithdrawIx(owner, new BN(r.shares.toString()), accounts);
    res.json(await buildTx(owner,
      [LIQUIDITY_CU, ...(await ataIxs(owner, [usdcMint])), ix],
      await tablesFor(accounts)));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/// Sends the tokens past claims took in kind from one custody (`symbol`).
app.post("/api/tx/withdraw-claim-tokens", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const c = custodies.find((x) => x.symbol === String(req.body.symbol));
    if (!c) return res.status(400).json({ error: "unknown token" });
    const t: any = await program.account.lpTokenClaim.fetchNullable(lpTokenClaimPda(owner));
    if (!t || num(t.owed[c.index]) === 0) return res.status(400).json({ error: "nothing owed in that token" });
    const ownerToken = ata(owner, c.mint);
    const sol = c.mint.equals(NATIVE_MINT);
    res.json(await buildTx(owner, [
      createAssociatedTokenAccountIdempotentInstruction(owner, ownerToken, owner, c.mint),
      await claimWithdrawTokensIx(owner, c),
      // Wrapped SOL goes back to the wallet as SOL.
      ...(sol ? [createCloseAccountInstruction(ownerToken, owner, owner)] : []),
    ]));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/// Returns every escrowed share to the wallet.
app.post("/api/tx/withdraw-cancel", async (req, res) => {
  try {
    const owner = ownerOf(req);
    res.json(await buildTx(owner,
      [...(await ataIxs(owner, [lpMint])), await cancelWithdrawIx(owner)]));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

/*
 * What one owner has put behind each market.
 *
 * A backing is a claim on a share of that market's first-loss pot, so its
 * value moves when the market pays out or earns: shares times what the pot
 * holds per share now, not what was deposited.
 */
/// Each wallet's backings, kept for BACKINGS_FRESH_MS and dropped the moment
/// a transaction of theirs lands (see /api/tx/send): pages poll this every
/// five to thirty seconds, from several components at once.
const BACKINGS_FRESH_MS = Number(process.env.BACKINGS_FRESH_MS ?? 5_000);
const backingsMemo = new Memo<any[]>(BACKINGS_FRESH_MS);

app.get("/api/backings", async (req, res) => {
  try {
    const owner = ownerOf(req);
    res.json(await backingsMemo.get(owner.toBase58(), () => backingsView(owner)));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

async function backingsView(owner: PublicKey) {
  {
    // Every market's backing account in one read, and the markets from the
    // shared snapshot. One fetch per market, in turn, took seven seconds,
    // longer than the page polls, and the section sat empty while it ran.
    const list = Object.values(rt);
    const [, { infos }, markets] = await Promise.all([
      loadBooks(),
      getMany(list.map((m) => backingPda(m.address, owner))),
      marketsByAddress(),
    ]);
    const out: any[] = [];
    for (const [i, m] of list.entries()) {
      const info = infos[i];
      if (!info) continue;
      const b: any = program.coder.accounts.decode("backing", info.data);
      if (num(b.shares) === 0) continue;
      const ma: any = markets.get(m.address.toBase58()) ?? await program.account.market.fetch(m.address);
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
        tradeable: m.observed
          ? observedTradeable(m.observed.seasoned, num(ma.lossBudgetUsd),
            m.lastFetch ? Date.now() - m.lastFetch : null, ma.maxPriceAgeSec)
          : true,
        stale: !!m.observed && markStale(m.lastFetch ? Date.now() - m.lastFetch : null, ma.maxPriceAgeSec),
        opening: !!m.observed && !m.observed.seasoned,
      });
    }
    return out;
  }
}

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
    // The shared snapshot: only markets this process shows are taped, and
    // those are exactly the snapshot's.
    const { pool: p, lpSupply: supply, markets } = await sharedState();
    const lpSupply = Number(supply) / 1e6;
    const aum = num(p.liquidityUsd) / 1e6 - (await traderPnlNow())
      + custodies.reduce((s, c) => s + c.lpAmount * (custodyPrice[c.symbol] ?? 0), 0);
    const row: TapeRow = { t: Date.now(), pool: lpSupply > 0 ? aum / lpSupply : 1, markets: {} };
    for (const m of Object.values(rt)) {
      const account = markets.get(m.address.toBase58());
      const shares = account ? num(account.backingShares) : 0;
      if (shares > 0) row.markets[m.symbol] = (potUsd(m.address, account.backingUsd) * 1e6) / shares;
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

app.get("/api/apy", (req, res) => {
  const markets: Record<string, { apy: number | null; hours: number }> = {};
  for (const m of Object.values(rt)) {
    const a = apyOf((r) => r.markets[m.symbol]);
    if (a) markets[m.symbol] = a;
  }
  const out: any = { pool: apyOf((r) => r.pool), markets };
  // `?series=1` adds the tape itself, value per share over time, for the
  // vault page's chart: at most 400 points a series, evenly thinned.
  if (req.query.series) {
    const step = Math.max(1, Math.ceil(tape.length / 400));
    const rows = tape.filter((_, i) => i % step === 0 || i === tape.length - 1);
    out.series = {
      pool: rows.map((r) => [r.t, r.pool]),
      markets: Object.fromEntries(Object.values(rt).map((m) =>
        [m.symbol, rows.filter((r) => r.markets[m.symbol] != null).map((r) => [r.t, r.markets[m.symbol]])])),
    };
  }
  res.json(out);
});

app.post("/api/tx/order", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const { symbol, isLong, collateral, size } = req.body;
    const m = rt[symbol];
    if (!m) return res.status(404).json({ error: "unknown market" });
    const maker = !!req.body.maker;
    if (maker && !Number(req.body.price)) throw new Error("a maker order needs a price");
    const conflict = await openConflict(m, owner, !!isLong);
    if (conflict) return res.status(409).json({ error: conflict });
    const limit = Number(req.body.price) || marketLimit(m, !!isLong);
    const ix = await program.methods
      .submitOrder(USD(limit), USD(Number(size)), USD(Number(collateral)), !!isLong, false, maker)
      .accounts(orderAccounts(m, owner)).instruction();
    // A wallet that arrived on a referral link names its referrer with its
    // first order, so the discount applies to that order too.
    // Read together: each is a round trip before the wallet is asked.
    const [ref, atas] = await Promise.all([
      referrerIx(owner, req.body.ref).catch(() => []), ataIxs(owner, [usdcMint])]);
    res.json(await buildTx(owner, [...atas, ...ref, ix]));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

app.post("/api/tx/close", async (req, res) => {
  try {
    const owner = ownerOf(req);
    const m = rt[req.body.symbol];
    if (!m) return res.status(404).json({ error: "unknown market" });
    const { builder, size } = await closeOrder(m, owner, Number(req.body.size || 0));
    // A full close takes the position's take profit and stop with it, in the
    // same signature. Left standing they outlived the position, sized "All",
    // and would fire against the next position opened on this market. Only
    // the owner can cancel an order, so it cannot be left to the keeper.
    const open = await closableUsd(m, owner);
    const full = !!open && size >= open.usd - 1e-6;
    const triggers = full
      ? (await ordersOf(owner))
          .filter((o: any) => String(o.account.market) === m.address.toBase58() && o.account.kind === 0)
      : [];
    const cancels = await Promise.all(triggers.map((o: any) =>
      cancelOrderIx(owner, { symbol: m.symbol, slot: o.account.slot })));
    res.json(await buildTx(owner, [await builder.instruction(), ...cancels]));
  } catch (e: any) { res.status(400).json({ error: explain(e) }); }
});

// `/api/tx/deposit` and the withdrawal routes are defined once, above.
// A second registration here never ran: Express answers with the first.

/// Submits a wallet-signed transaction. Kept server-side so the client does not
/// need its own RPC endpoint, and so failures come back already explained.
app.post("/api/tx/send", async (req, res) => {
  try {
    const raw = Buffer.from(String(req.body.tx), "base64");
    // An order that arrives while its market's batch is sealed (cleared, its
    // orders still settling) is refused by the program. The trader has
    // already signed, and the batch reopens within seconds, so hold the same
    // transaction and send it again rather than hand back "Rejected": under
    // load that refusal met one order in fifty.
    let sig = "";
    for (let tries = 0; ; tries++) {
      try { sig = await conn.sendRawTransaction(raw, { skipPreflight: false }); break; }
      catch (e: any) {
        const text = `${e?.message ?? e} ${(e?.logs ?? e?.transactionLogs ?? []).join(" ")}`;
        // A deposit or withdrawal claim reads the AUM checkpoint when it
        // runs, and the checkpoint goes out of date whenever a market gains
        // its first position or loses its last, which under load happens
        // between building and sending. The checkpoint is an account the
        // transaction names, not data it carries, so refreshing it and
        // sending the same signed transaction again succeeds.
        if (/AumCheckpointStale|valuation checkpoint is stale/.test(text) && tries < 3) {
          await refreshAum().catch(() => {});
          continue;
        }
        const sealed = /BatchSealed|sealed and awaiting settlement/.test(text);
        if (!sealed || tries >= 8) throw e;
        await new Promise((r) => setTimeout(r, 1_500));
      }
    }
    // Answers at "confirmed", not "finalized". A transaction that landed
    // but failed comes back here with its error, not as a success.
    const landed: any = await conn.confirmTransaction({
      signature: sig,
      blockhash: req.body.blockhash,
      lastValidBlockHeight: req.body.lastValidBlockHeight,
    }, "confirmed");
    const failed = landed?.value?.err;
    if (failed) {
      const custom = failed?.InstructionError?.[1]?.Custom;
      // Not a program's code: the runtime's own reason, by its name
      // ("InsufficientFundsForRent", or an instruction's "InsufficientFunds").
      const named = typeof failed === "string" ? failed
        : typeof failed?.InstructionError?.[1] === "string" ? failed.InstructionError[1]
        : Object.keys(failed ?? {})[0];
      return res.status(400).json({ ok: false, sig, error: custom != null
        ? `custom program error: 0x${Number(custom).toString(16)}` : named ?? JSON.stringify(failed) });
    }
    // Whatever it changed, the sender's page should not be shown the balance
    // from before it. Only the sender's: clearing every wallet's view on every
    // send left nothing cached under load, and every poll went to the chain.
    const keys = VersionedTransaction.deserialize(raw).message.staticAccountKeys;
    const sender = keys[0].toBase58();
    accountMemo.delete(sender);
    backingsMemo.drop(sender);
    // A new, cancelled or changed order is in the next trigger check, and an
    // opened, resized or closed position in the next liquidation check: the
    // sender's slots are read again there, not the whole program.
    ordersChanged(sender);
    positionsChanged(sender);
    // A backing in kind moves a book.
    booksRead = null;
    // Whatever landed may be an order now waiting in its batch: start the
    // auction's next pass now rather than at its next tick.
    kickAuction();
    // The tape and the market's volume come from what the sender says they
    // just did, so the transaction has to name the market they say they did
    // it on. Without that check any transaction that lands -- a transfer to
    // oneself will do -- could print a trade of any size on any symbol, and
    // the volume every page reads is whatever the last caller claimed.
    if (req.body.record?.symbol) {
      const r = req.body.record;
      const m = rt[r.symbol];
      const size = Number(r.size);
      if (m && Number.isFinite(size) && size > 0 && keys.some((k) => k.equals(m.address))) {
        recordTrade({ symbol: r.symbol, side: r.side, size, price: px(m), kind: r.kind });
      }
    }
    // The lister's own send: find the new market and give it its first price
    // straight away, not at the next pass, since the page promises it
    // tradeable within seconds of listing. Nobody else's send does this.
    const built = listingsBuilt.get(sender);
    if (built && Date.now() - built < 5 * 60_000) {
      listingsBuilt.delete(sender);
      discoverSoon();
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
      owner, pool, market: m.address, order: orderPda(m.address, owner, Number(body.slot)),
      usdcMint, usdcVault, ownerUsdc: ata(owner, usdcMint),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

app.post("/api/order/trigger", demoOnly, async (req, res) => {
  try {
    const ix = await placeOrderIx(trader.publicKey, req.body);
    await sendV0(conn, trader, [ix]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: explain(e) }); }
});

app.post("/api/order/cancel", demoOnly, async (req, res) => {
  try {
    const ix = await cancelOrderIx(trader.publicKey, req.body);
    await sendV0(conn, trader, [ix]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: explain(e) }); }
});

app.post("/api/tx/order/trigger", async (req, res) => {
  try {
    const owner = ownerOf(req);
    // Setting a take profit, stop or limit where one already stands replaces
    // it, in the same signature: cancel, then place. The program will not
    // create an order account twice, and the second "set" failed with a bare
    // "Simulation failed" (66 times in the load test).
    const m = rt[req.body.symbol];
    // A limit is an open the keeper fires later, and the program asks the
    // same question when it is placed.
    if (m && req.body.kind === "limit") {
      const conflict = await openConflict(m, owner, !!req.body.isLong, false);
      if (conflict) return res.status(409).json({ error: conflict });
    }
    const slot = m ? orderParams(req.body).slot : -1;
    const standing = m ? await conn.getAccountInfo(orderPda(m.address, owner, slot)) : null;
    const replace = standing ? [await cancelOrderIx(owner, { symbol: req.body.symbol, slot })] : [];
    res.json(await buildTx(owner, [...replace, await placeOrderIx(owner, req.body)]));
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
/// day, and the SOL and the USDC handed out across everyone are each capped
/// per day. The address is clientIp's, never a header the caller set. With
/// TURNSTILE_SECRET set, a claim also needs a Cloudflare Turnstile token the
/// page got for it, checked against that address.
const FAUCET_USDC = Number(process.env.FAUCET_USDC ?? (IS_LOCAL ? 250_000 : 10_000));
const FAUCET_SOL = Number(process.env.FAUCET_SOL ?? (IS_LOCAL ? 2 : 0.2));
const FAUCET_SOL_PER_DAY = Number(process.env.FAUCET_SOL_PER_DAY ?? 10);
/// Test USDC across every claim in the last 24 hours. Test USDC has no
/// value, but a supply anyone can mint without bound makes every balance,
/// pool and leaderboard figure on devnet meaningless.
const FAUCET_USDC_PER_DAY = Number(process.env.FAUCET_USDC_PER_DAY ?? 2_000_000);
const FAUCET_PER_IP_PER_DAY = 3;
const DAY_MS = 86_400_000;
const FAUCET_FILE = path.join(ROOT, `.${CLUSTER}-faucet.json`);
/// Below this the authority keeps its SOL for the crank's own fees: a faucet
/// that drained it would stop every batch from clearing.
const AUTHORITY_SOL_FLOOR = Number(process.env.AUTHORITY_SOL_FLOOR ?? 1);
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET ?? "";
// A faucet nobody has to be human to call is one script away from the day's
// whole supply, and CORS does not stop the call: a page anywhere can post to
// it from its visitors' addresses and read nothing back, which is all this
// needs. So the public server refuses to start without the check rather than
// starting with it skipped. Local runs mint against a validator nobody else
// can reach.
if (!TURNSTILE_SECRET && !IS_LOCAL) {
  console.error("TURNSTILE_SECRET is unset: refusing to serve a faucet with no human check");
  process.exit(1);
}
/// Cloudflare's answer on a Turnstile token. Each token is good once.
async function humanCheck(token: unknown, ip: string): Promise<boolean> {
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const form = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
  if (ip) form.set("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body: form, signal: AbortSignal.timeout(10_000),
    });
    const out: any = await r.json();
    if (!out.success) console.warn(`turnstile: ${(out["error-codes"] ?? []).join(", ") || r.status}`);
    return out.success === true;
  } catch (e: any) {
    console.warn(`turnstile: ${e?.message ?? e}`);
    return false;
  }
}
/*
 * Wallets that have connected to the site, for counting them.
 *
 * The site reports a wallet once a session when it connects, and again with
 * the welcome screen's signature once it signs. Only the address and the
 * times are kept, never the caller's address. A connect is the caller's
 * word, so one address may add at most SEEN_NEW_PER_IP_PER_DAY wallets a
 * day; a signed one is checked against the wallet's own key, so `signed` is
 * the figure nobody can inflate. GET /api/wallets gives the counts.
 */
type Seen = { first: number; last: number; signed?: number };
const SEEN_FILE = path.join(ROOT, ".cache", `${CLUSTER}-wallets.json`);
const SEEN_NEW_PER_IP_PER_DAY = 10;
let seen: Record<string, Seen> = {};
try { seen = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")); } catch { seen = {}; }
const seenByIp = new Map<string, number[]>();
let seenSaving: NodeJS.Timeout | null = null;
const saveSeen = () => {
  seenSaving ??= setTimeout(() => {
    seenSaving = null;
    try {
      fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
      fs.writeFileSync(SEEN_FILE, JSON.stringify(seen));
    } catch (e: any) { console.warn(`wallets: ${e?.message ?? e}`); }
  }, 5_000);
};
/// An ed25519 signature by `wallet` over `message`, both as the site sends them.
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
function signedBy(wallet: PublicKey, message: string, signature: string) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI, wallet.toBuffer()]), format: "der", type: "spki",
    });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature, "base64"));
  } catch { return false; }
}

app.post("/api/seen", (req, res) => {
  let wallet: PublicKey;
  try { wallet = new PublicKey(String(req.body?.wallet ?? "")); }
  catch { return res.status(400).json({ ok: false, error: "not a wallet address" }); }
  const key = wallet.toBase58();
  const now = Date.now();
  const { message, signature } = req.body ?? {};
  const signed = typeof message === "string" && typeof signature === "string"
    && message.length < 1_000 && message.includes(`Wallet: ${key}`) && signedBy(wallet, message, signature);
  if (!seen[key]) {
    if (!signed) {
      const ip = clientIp(req);
      const recent = (seenByIp.get(ip) ?? []).filter((t) => now - t < DAY_MS);
      if (recent.length >= SEEN_NEW_PER_IP_PER_DAY) return res.json({ ok: true });
      seenByIp.set(ip, [...recent, now]);
    }
    seen[key] = { first: now, last: now };
  }
  seen[key].last = now;
  if (signed) seen[key].signed ??= now;
  saveSeen();
  res.json({ ok: true });
});

app.get("/api/wallets", (_req, res) => {
  const all = Object.values(seen);
  const since = (ms: number) => all.filter((w) => Date.now() - w.last < ms).length;
  res.json({
    connected: all.length,
    signed: all.filter((w) => w.signed).length,
    active24h: since(DAY_MS),
    active7d: since(7 * DAY_MS),
    since: all.length ? Math.min(...all.map((w) => w.first)) : null,
  });
});

let claims: Claim[] = [];
try { claims = JSON.parse(fs.readFileSync(FAUCET_FILE, "utf8")); } catch { claims = []; }
// Only the last day counts toward a limit, and the privacy policy keeps an
// address no longer than that.
claims = claims.filter((c) => Date.now() - c.t < DAY_MS);
setInterval(() => {
  const kept = claims.filter((c) => Date.now() - c.t < DAY_MS);
  if (kept.length !== claims.length) {
    claims = kept;
    if (!IS_LOCAL) fs.writeFileSync(FAUCET_FILE, JSON.stringify(claims));
  }
  // Devnet copies stay, but not the address that asked for one.
  const old = copies.filter((c) => c.ip && Date.now() - (c.t ?? 0) >= DAY_MS);
  if (old.length) {
    for (const c of old) delete c.ip;
    fs.writeFileSync(COPIES_FILE, JSON.stringify(copies, null, 2));
  }
}, 60 * 60_000).unref();

app.post("/api/faucet", async (req, res) => {
  let held: Claim | null = null;
  try {
    // `ownerOf` falls back to the demo trader, which is right for reads and
    // wrong for a faucet.
    if (!req.body?.owner) throw new Error("owner is required");
    const owner = ownerOf(req);
    const ip = clientIp(req);
    const now = Date.now();
    claims = claims.filter((c) => now - c.t < DAY_MS);
    if (!IS_LOCAL) {
      const refused = faucetRefusal(claims, owner.toBase58(), ip, now, {
        usdc: FAUCET_USDC, usdcPerDay: FAUCET_USDC_PER_DAY, perIpPerDay: FAUCET_PER_IP_PER_DAY,
      });
      if (refused) throw new Error(refused);
      // Held from here, so two claims sent at once cannot both pass the
      // checks above while the first is still minting.
      held = { owner: owner.toBase58(), ip, t: now, sol: 0, usdc: FAUCET_USDC };
      claims.push(held);
      if (TURNSTILE_SECRET && !(await humanCheck(req.body?.turnstile, ip))) {
        throw new Error("the human check did not pass; try again");
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
    if (held) held.sol = sol;

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
    const sig = await sendV0(conn, authority, ixs);
    accountMemo.delete(owner.toBase58());

    if (!IS_LOCAL) fs.writeFileSync(FAUCET_FILE, JSON.stringify(claims));
    // The signature, so the page can link the transfer on an explorer.
    res.json({ ok: true, usdc: FAUCET_USDC, sol, sig });
  } catch (e: any) {
    // A claim that sent nothing does not count against the wallet.
    if (held) claims = claims.filter((c) => c !== held);
    res.status(400).json({ ok: false, error: explain(e) });
  }
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
  setInterval(() => rpcWho.run("vault tape", recordTape), TAPE_EVERY_MS);
    console.log(`unwind (${CLUSTER}) on http://localhost:${PORT}`);
  // The query string is where RPC providers put the API key.
  // Hosts only: an Alchemy key sits in the path, a Helius one in the query.
  console.log(`  rpc ${RPC_ENDPOINTS.length} key(s): ${[...new Set(RPC_ENDPOINTS.map(rpcHost))].join(", ")}`);
    console.log(`  ${LIVE.length} markets, live prices every ${TICK_MS}ms, liquidation checks every ${LIQ_CHECK_MS}ms`);
    for (const m of Object.values(rt)) {
      console.log(m.quote
        ? `  ${m.symbol.padEnd(6)} $${px(m).toFixed(2)}` +
          `  conf ${m.quote.confBps.toFixed(1)}bp  ${Session[m.session]}`
        : `  ${m.symbol.padEnd(6)} no price yet`);
    }
  });
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
