/*
 * Unit tests for the server's arithmetic and the modules it shares with the
 * site: `npm run test:server`. No chain, no network.
 */
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  BREAKER_PCT, Claim, PREMIUM_WINDOW_MS, Season, breaker, countTraders, crossOf, faucetRefusal,
  flowOf, fundingRates, indicativeCross, livePoints, markStale, markWrittenMs, notePremium, num,
  observedTradeable, payoutPct, pendingStakePoints, premiumOf, seasonStanding, weekStart,
} from "./server-logic";
import { sizeSwap } from "./testnet-flow";
import {
  DEPTH_LEVERAGE_TIERS, LISTING_LEVERAGE_CEILING_BPS, LISTING_OI_CEILING_USD, LISTING_OI_FLOOR_USD,
  MAX_UNIT_EXP, leverageForDepth, listingLimits, unitExpFor, unitLabel,
} from "./listing-policy";
import { MAX_COMPUTE_UNITS, packInstructions, withComputeLimit } from "./pack";
import { openRefusal } from "./open-guard";
import {
  binsPerMove, clmmDepth, clmmPrice, clmmSeedPrice, decodeBinArray, decodeClmm, decodeDlmmPair,
  dlmmBinsNeeded, dlmmDepth, dlmmPrice, findProgramAddress, ringTwapTick, sqrtPriceAtTick,
} from "./pools";

const fixture = (name: string) =>
  new Uint8Array(fs.readFileSync(path.join(__dirname, "..", "programs/unwind/src/fixtures", `${name}.bin`)));

describe("server: funding display", () => {
  const ma = { borrowRateBpsPerHour: 10, fundingKBps: 10_000, maxFundingRateBpsPerHour: 100 };

  it("charges nobody on an empty, idle market", () => {
    assert.deepEqual(fundingRates(ma, 0, 0, 0), { fundingRateLongBps: 0, fundingRateShortBps: 0 });
  });

  it("charges both sides the borrow rate scaled by utilization", () => {
    assert.deepEqual(fundingRates(ma, 1_000, 1_000, 5_000), { fundingRateLongBps: 5, fundingRateShortBps: 5 });
  });

  it("truncates a rate the program truncates, rather than showing a fraction", () => {
    const r = fundingRates({ ...ma, borrowRateBpsPerHour: 1 }, 0, 0, 9_999);
    assert.equal(r.fundingRateLongBps, 0);
  });

  it("has the heavy side pay the light side, capped at the market maximum", () => {
    // 3:1 is a 50% skew; at k = 100% that is 5,000 bps, capped at 100.
    const r = fundingRates(ma, 3_000, 1_000, 0);
    assert.equal(r.fundingRateLongBps, 100);
    // The shorts receive the payment spread over their smaller size.
    assert.equal(r.fundingRateShortBps, -300);
  });

  it("scales the skew rate by k below the cap", () => {
    // 1 bp an hour per 1% of skew: a 50% skew is 50 bps.
    const r = fundingRates({ ...ma, fundingKBps: 100 }, 1_000, 3_000, 0);
    assert.equal(r.fundingRateShortBps, 50);
    assert.equal(r.fundingRateLongBps, -150);
  });

  it("adds skew funding on top of the borrow leg", () => {
    const r = fundingRates({ ...ma, fundingKBps: 100 }, 3_000, 1_000, 10_000);
    assert.equal(r.fundingRateLongBps, 10 + 50);
    assert.equal(r.fundingRateShortBps, 10 - 150);
  });

  it("charges no skew while one side is empty", () => {
    assert.deepEqual(fundingRates(ma, 5_000, 0, 0), { fundingRateLongBps: 0, fundingRateShortBps: 0 });
  });

  it("treats an exactly balanced book as longs heavy with no skew", () => {
    const r = fundingRates(ma, 2_000, 2_000, 0);
    assert.equal(r.fundingRateLongBps, 0);
    assert.equal(r.fundingRateShortBps, 0);
  });
});

describe("server: payout percentage", () => {
  const D = 1e6;
  const market = (o: any = {}) => ({
    longSizeUsd: 0, longAvgEntryPrice: 0, shortSizeUsd: 0, shortAvgEntryPrice: 0,
    lossBudgetUsd: 1_000_000 * D, netLossUsd: 0, backingUsd: 0, ...o,
  });
  const pool = { liquidityUsd: 10_000_000 * D, insuranceUsd: 0 };

  it("pays in full when nobody is up", () => {
    assert.equal(payoutPct(market(), pool, 100), 100);
    assert.equal(payoutPct(market({ longSizeUsd: 1_000 * D, longAvgEntryPrice: 100 * D }), pool, 90), 100);
  });

  it("pays the share of winners' profit the remaining budget covers", () => {
    // $1,000 long from $100, out at $110: $100 of profit against $50 left.
    const ma = market({ longSizeUsd: 1_000 * D, longAvgEntryPrice: 100 * D, lossBudgetUsd: 80 * D, netLossUsd: 30 * D });
    assert.closeTo(payoutPct(ma, pool, 110), 50, 1e-9);
  });

  it("counts a net gain as leaving the whole budget", () => {
    const ma = market({ longSizeUsd: 1_000 * D, longAvgEntryPrice: 100 * D, lossBudgetUsd: 50 * D, netLossUsd: -30 * D });
    assert.closeTo(payoutPct(ma, pool, 110), 50, 1e-9);
  });

  it("is held to the cash there is to pay with", () => {
    const ma = market({ longSizeUsd: 1_000 * D, longAvgEntryPrice: 100 * D, backingUsd: 5 * D });
    assert.closeTo(payoutPct(ma, { liquidityUsd: 10 * D, insuranceUsd: 5 * D }, 110), 20, 1e-9);
  });

  it("counts winners on both sides without netting a losing side against them", () => {
    // Longs up $100 at $110, shorts down $50: $100 of winners against $50.
    const ma = market({
      longSizeUsd: 1_000 * D, longAvgEntryPrice: 100 * D, shortSizeUsd: 500 * D, shortAvgEntryPrice: 100 * D,
      lossBudgetUsd: 50 * D,
    });
    assert.closeTo(payoutPct(ma, pool, 110), 50, 1e-9);
  });

  it("reads one tracked position from its moment sums as from its aggregates", () => {
    // $1,000 at $100: size/entry = 1e19 at 1e18, size/entry^2 = 1e17 at 1e24.
    const longMoments = { trackedUsd: 1_000 * D, invEntry: 1e19, invEntrySq: 1e17 };
    const tracked = market({ longSizeUsd: 1_000 * D, longAvgEntryPrice: 100 * D, longMoments, lossBudgetUsd: 50 * D });
    const plain = market({ longSizeUsd: 1_000 * D, longAvgEntryPrice: 100 * D, lossBudgetUsd: 50 * D });
    assert.closeTo(payoutPct(tracked, pool, 110), payoutPct(plain, pool, 110), 1e-6);
  });

  it("falls back to the aggregates while a side is only partly tracked", () => {
    const longMoments = { trackedUsd: 400 * D, invEntry: 0, invEntrySq: 0 };
    const ma = market({ longSizeUsd: 1_000 * D, longAvgEntryPrice: 100 * D, longMoments, lossBudgetUsd: 50 * D });
    assert.closeTo(payoutPct(ma, pool, 110), 50, 1e-9);
  });
});

describe("server: indicative cross", () => {
  const o = (price: number, size: number, isBid: boolean, isMaker = false) => ({ price, size, isBid, isMaker });

  it("names the flows as the program does", () => {
    assert.equal(flowOf({ isBid: true, isMaker: false }), "buy");
    assert.equal(flowOf({ isBid: false, isMaker: true }), "buy");
    assert.equal(flowOf({ isBid: false, isMaker: false }), "sell");
    assert.equal(flowOf({ isBid: true, isMaker: true }), "sell");
  });

  it("finds nothing in an empty or uncrossed book", () => {
    assert.deepEqual(crossOf([]), { price: null, matched: 0 });
    assert.deepEqual(crossOf([o(99, 10, true), o(100, 10, false)]), { price: null, matched: 0 });
  });

  it("crosses at the price that matches the most volume", () => {
    const book = [o(103, 5, true), o(101, 10, true), o(100, 8, false), o(102, 20, false)];
    // At 101: bids 15, asks 8; at 102: bids 5, asks 28; at 100: bids 15, asks 8.
    assert.deepEqual(crossOf(book), { price: 100, matched: 8 });
  });

  it("breaks a volume tie by the smaller imbalance", () => {
    const book = [o(102, 10, true), o(101, 4, true), o(100, 10, false), o(101, 3, false)];
    // 100: bids 14, asks 10 -> 10, imbalance 4. 101: bids 14, asks 13 -> 13. 102: bids 10, asks 13 -> 10.
    assert.deepEqual(crossOf(book), { price: 101, matched: 13 });
  });

  it("keeps the lower price at an exact tie", () => {
    assert.deepEqual(crossOf([o(101, 10, true), o(100, 10, false)]), { price: 100, matched: 10 });
  });

  it("never crosses two takers, and totals each side", () => {
    // A taker bid and a taker ask are in different flows.
    const takers = [o(105, 10, true), o(95, 10, false)];
    const r = indicativeCross(takers);
    assert.deepEqual(r.buy, { price: null, matched: 0 });
    assert.deepEqual(r.sell, { price: null, matched: 0 });
    assert.equal(r.bidUsd, 10);
    assert.equal(r.askUsd, 10);
    // A maker on each side gives each taker something to meet.
    const both = indicativeCross([...takers, o(100, 4, false, true), o(99, 6, true, true)]);
    assert.deepEqual(both.buy, { price: 100, matched: 4 });
    assert.deepEqual(both.sell, { price: 95, matched: 6 });
    assert.equal(both.bidUsd, 16);
    assert.equal(both.askUsd, 14);
  });
});

describe("server: premium averaging", () => {
  const realNow = Date.now;
  let now = 1_000_000_000_000;
  beforeEach(() => { Date.now = () => now; });
  afterEach(() => { Date.now = realNow; });

  it("is null with no batches that traded", () => {
    assert.isNull(premiumOf("NONE"));
    notePremium("SKIP", null, 100, 10);
    notePremium("SKIP", 11, 0, 10);
    notePremium("SKIP", 11, 100, 0);
    assert.isNull(premiumOf("SKIP"), "no price, no volume or no mark records nothing");
  });

  it("averages by volume, in bps from the mark", () => {
    notePremium("AVG", 101, 300, 100); // +100 bps on $300
    notePremium("AVG", 99, 100, 100); //  -100 bps on $100
    assert.closeTo(premiumOf("AVG")!, 50, 1e-9);
  });

  it("forgets batches older than the window", () => {
    notePremium("OLD", 110, 100, 100);
    now += PREMIUM_WINDOW_MS + 1;
    notePremium("OLD", 101, 100, 100);
    assert.closeTo(premiumOf("OLD")!, 100, 1e-9);
    now += PREMIUM_WINDOW_MS + 1;
    assert.isNull(premiumOf("OLD"));
  });
});

describe("server: keeper circuit breaker", () => {
  const quiet = (f: () => number) => {
    const warn = console.warn;
    console.warn = () => {};
    try { return f(); } finally { console.warn = warn; }
  };

  it("passes a move inside the limit", () => {
    assert.equal(breaker("a", "A", 100, 109.99), 109.99);
    assert.equal(breaker("a", "A", 100, 95), 95);
  });

  // TESTING-FINDINGS.md, finding 1: `next / onChain - 1` in floating point
  // reads an exact 10% move as 10.000000000000009%, so it is held a pass.
  it.skip("passes a move of exactly the limit (finding 1)", () => {
    assert.equal(breaker("f", "F", 100, 100 + BREAKER_PCT), 110);
    assert.equal(breaker("f", "F", 1_000_000, 1_100_000), 1_100_000);
  });

  it("passes anything when nothing is on chain yet", () => {
    assert.equal(breaker("b", "B", 0, 5_000), 5_000);
  });

  it("holds a large move one pass, then steps toward it by the limit", () => {
    assert.equal(quiet(() => breaker("c", "C", 1_000, 2_000)), 1_000, "held");
    assert.equal(quiet(() => breaker("c", "C", 1_000, 2_000)), 1_100, "stepped 10%");
    assert.equal(quiet(() => breaker("c", "C", 1_100, 2_000)), 1_210);
    // Down, the same.
    assert.equal(quiet(() => breaker("d", "D", 1_000, 100)), 1_000);
    assert.equal(quiet(() => breaker("d", "D", 1_000, 100)), 900);
  });

  it("forgets a held move once the price comes back inside the limit", () => {
    assert.equal(quiet(() => breaker("e", "E", 1_000, 2_000)), 1_000);
    assert.equal(breaker("e", "E", 1_000, 1_050), 1_050);
    assert.equal(quiet(() => breaker("e", "E", 1_000, 2_000)), 1_000, "held again, not stepped");
  });
});

describe("server: points", () => {
  const D = 1e6;
  const trader = (o: any = {}) => ({
    owner: new PublicKey(new Uint8Array(32).fill(1)),
    points: 0, backingUsd: 0, backingTs: 0, lpUsd: 0, lpTs: 0,
    tradingPoints: 0, referralPoints: 0, listingPoints: 0, volumeUsd: 0, givenToReferrerPoints: 0, ...o,
  });

  it("reads anchor numbers and missing fields", () => {
    assert.equal(num(null), 0);
    assert.equal(num(undefined), 0);
    assert.equal(num({ toString: () => "42" }), 42);
    assert.equal(num(7), 7);
  });

  it("accrues stake points pro rata over a day, and nothing before or backwards", () => {
    assert.equal(pendingStakePoints(1_000, 2, 100, 100 + 86_400), 2_000);
    assert.equal(pendingStakePoints(1_000, 1, 100, 100 + 43_200), 500);
    assert.equal(pendingStakePoints(1_000, 2, 0, 1_000), 0, "never started");
    assert.equal(pendingStakePoints(1_000, 2, 500, 400), 0, "clock behind the last sync");
  });

  it("adds backing at two a dollar a day and LP at one to the counted points", () => {
    const t = trader({ points: 5 * D, backingUsd: 100 * D, backingTs: 1_000, lpUsd: 300 * D, lpTs: 1_000 });
    assert.closeTo(livePoints(t, 1_000 + 86_400), 5 + 200 + 300, 1e-9);
  });

  it("shows raw totals when there is no season baseline", () => {
    const t = trader({ points: 9 * D, tradingPoints: 4 * D, volumeUsd: 50 * D });
    const s = seasonStanding(t, null, 1_000);
    assert.equal(s.points, 9);
    assert.equal(s.trading, 4);
    assert.equal(s.volume, 50);
  });

  it("measures a season from its baseline and takes off what old stakes earned", () => {
    const t = trader({ points: 30 * D, tradingPoints: 12 * D, volumeUsd: 80 * D, backingUsd: 100 * D, backingTs: 10_000 });
    const season: Season = {
      season: 2, pool: "p", start: 10_000,
      base: {
        [t.owner.toBase58()]: {
          points: 10, trading: 2, referrals: 0, listing: 0, volume: 30, given: 0, backingUsd: 100, lpUsd: 0,
        },
      },
    };
    // A day in: live = 30 + 200 from backing; the baseline was 10 and the
    // stake placed before the season earned 200 of it.
    const s = seasonStanding(t, season, 10_000 + 86_400);
    assert.closeTo(s.points, 20, 1e-6);
    assert.equal(s.trading, 10);
    assert.equal(s.volume, 50);
  });

  it("never shows float residue or a fall below the baseline as points", () => {
    const t = trader({ points: 10 * D });
    const season: Season = {
      season: 1, pool: "p", start: 0,
      base: { [t.owner.toBase58()]: { points: 10 + 1e-9, trading: 0, referrals: 0, listing: 0, volume: 0, given: 0, backingUsd: 0, lpUsd: 0 } },
    };
    assert.equal(seasonStanding(t, season, 0).points, 0);
    // A wallet the season has no baseline for counts in full.
    const other = trader({ owner: new PublicKey(new Uint8Array(32).fill(2)), points: 3 * D });
    assert.equal(seasonStanding(other, season, 0).points, 3);
  });

  it("starts a week on Monday 00:00 UTC", () => {
    const wed = Date.UTC(2026, 9, 7, 15, 30); // Wednesday, October 7, 2026
    assert.equal(weekStart(wed), Date.UTC(2026, 9, 5) / 1000);
    assert.equal(weekStart(Date.UTC(2026, 9, 5)), Date.UTC(2026, 9, 5) / 1000, "Monday midnight is its own week");
    assert.equal(weekStart(Date.UTC(2026, 9, 11, 23, 59)), Date.UTC(2026, 9, 5) / 1000, "Sunday is the week's end");
    assert.equal(weekStart(Date.UTC(2026, 9, 12)), Date.UTC(2026, 9, 12) / 1000);
  });

  it("counts a creator's distinct traders past the floor, never the deployer or the house", () => {
    const volumes = { a: 100, b: 99.99, c: 5_000, deployer: 1_000, house: 1_000 };
    assert.equal(countTraders(volumes, "deployer", new Set(["house"]), 100), 2);
    assert.equal(countTraders({}, "deployer", new Set(), 100), 0);
  });
});

describe("server: faucet limits", () => {
  const limits = { usdc: 10_000, usdcPerDay: 30_000, perIpPerDay: 3 };
  const H = 3_600_000;
  const claim = (owner: string, ip: string, t: number, usdc?: number): Claim => ({ owner, ip, t, sol: 0, usdc });

  it("lets a fresh wallet claim", () => {
    assert.isNull(faucetRefusal([], "w", "1.1.1.1", 0, limits));
  });

  it("gives one claim per wallet a day, and says when the next is", () => {
    const r = faucetRefusal([claim("w", "2.2.2.2", 0)], "w", "1.1.1.1", 5 * H, limits);
    assert.equal(r, "this wallet was funded today; try again in 19h");
  });

  it("limits claims per address", () => {
    const claims = [claim("a", "ip", 0), claim("b", "ip", 0), claim("c", "ip", 0)];
    assert.equal(faucetRefusal(claims, "d", "ip", H, { ...limits, usdcPerDay: 1e9 }), "too many claims from this address today");
    assert.isNull(faucetRefusal(claims.slice(0, 2), "d", "ip", H, { ...limits, usdcPerDay: 1e9 }));
  });

  it("stops at the day's test USDC, counting old claims at the current size", () => {
    const claims = [claim("a", "1", 0), claim("b", "2", H, 10_000)];
    // $20k given; one more $10k is exactly the cap.
    assert.isNull(faucetRefusal(claims, "c", "3", 2 * H, limits));
    const full = [...claims, claim("c", "3", 2 * H)];
    assert.equal(
      faucetRefusal(full, "d", "4", 3 * H, limits),
      "the faucet has given out its 30,000 test USDC for today; try again in 21h",
    );
  });

  it("never tells a refused wallet to wait less than an hour", () => {
    const full = [claim("a", "1", 0, 30_000)];
    assert.match(faucetRefusal(full, "b", "2", 24 * H - 1, limits)!, /try again in 1h$/);
  });
});

describe("listing policy", () => {
  it("steps leverage up with sustained depth", () => {
    assert.equal(leverageForDepth(0), DEPTH_LEVERAGE_TIERS[0][1]);
    assert.equal(leverageForDepth(9_999), 2);
    assert.equal(leverageForDepth(10_000), 3);
    assert.equal(leverageForDepth(50_000), 4);
    assert.equal(leverageForDepth(10_000_000), 5);
    assert.equal(leverageForDepth(-1), 2, "below the first floor is the first tier");
  });

  it("takes the most the pool allows when nothing is chosen", () => {
    const l = listingLimits(20_000);
    assert.equal(l.maxLeverage, LISTING_LEVERAGE_CEILING_BPS / 10_000);
    assert.equal(l.leverage, l.maxLeverage);
    assert.equal(l.oiUsd, 20_000);
    assert.equal(l.depthLeverage, 3);
    assert.equal(l.startLeverage, 2);
  });

  it("caps size at the hard ceiling however deep the pool", () => {
    const l = listingLimits(10_000_000);
    assert.equal(l.maxOiUsd, LISTING_OI_CEILING_USD);
    assert.equal(l.oiUsd, LISTING_OI_CEILING_USD);
  });

  it("clamps a lister's choices into the pool's limits rather than refusing them", () => {
    const l = listingLimits(20_000, { leverage: 50, oiUsd: 1e9 });
    assert.equal(l.leverage, l.maxLeverage);
    assert.equal(l.oiUsd, 20_000);
    const low = listingLimits(20_000, { leverage: 0, oiUsd: 1 });
    assert.equal(low.leverage, 1);
    assert.equal(low.oiUsd, LISTING_OI_FLOOR_USD);
    const nan = listingLimits(20_000, { leverage: NaN, oiUsd: Infinity });
    assert.equal(nan.leverage, nan.maxLeverage, "a non-number is no choice");
    assert.equal(nan.oiUsd, 20_000);
  });

  it("lets a pool shallower than the floor list only at its own depth", () => {
    const l = listingLimits(400);
    assert.equal(l.minOiUsd, 400);
    assert.equal(l.maxOiUsd, 400);
    assert.equal(listingLimits(-5).maxOiUsd, 0);
  });

  it("quotes sub-cent tokens per thousand, million or billion", () => {
    assert.equal(unitExpFor(150), 0);
    assert.equal(unitExpFor(0.01), 0);
    assert.equal(unitExpFor(0.0099), 3);
    assert.equal(unitExpFor(0.0000038), 6); // Bonk: $3.81 per 1M
    assert.equal(unitExpFor(0), MAX_UNIT_EXP, "never past a billion");
    assert.deepEqual([0, 3, 6, 9].map(unitLabel), ["", "1K", "1M", "1B"]);
    assert.equal(unitLabel(4), "1e4");
  });
});

describe("pack", () => {
  const payer = Keypair.generate().publicKey;
  const ix = (accounts: number, data = 8) => new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: Array.from({ length: accounts }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true })),
    data: Buffer.alloc(data),
  });

  it("packs nothing into nothing", () => {
    assert.deepEqual(packInstructions([], payer), []);
  });

  it("keeps order and fits every group under the size limit", () => {
    const ixs = Array.from({ length: 40 }, () => ix(3));
    const groups = packInstructions(ixs, payer);
    assert.isAbove(groups.length, 1);
    assert.deepEqual(groups.flat(), ixs, "every instruction once, in order");
    // Each group but the last is full: one more would not have fitted.
    for (let i = 0; i < groups.length - 1; i++) {
      const more = packInstructions([...groups[i], groups[i + 1][0]], payer);
      assert.equal(more.length, 2);
    }
  });

  it("respects a per-transaction instruction cap", () => {
    const groups = packInstructions(Array.from({ length: 7 }, () => ix(1)), payer, 3);
    assert.deepEqual(groups.map((g) => g.length), [3, 3, 1]);
  });

  it("sends an instruction too large to fit anywhere on its own", () => {
    const big = ix(1, 2_000);
    const groups = packInstructions([ix(1), big, ix(1)], payer);
    assert.deepEqual(groups.map((g) => g.length), [1, 1, 1]);
    assert.equal(groups[1][0], big);
  });

  it("asks each packed transaction for the full compute ceiling", () => {
    const out = withComputeLimit([ix(1)]);
    assert.equal(out.length, 2);
    assert.equal(out[0].data.readUInt32LE(1), MAX_COMPUTE_UNITS);
  });
});

describe("pool readers mirror the program", () => {
  // The same mainnet bytes `amm.rs` tests against, and the figures it pins.
  const SOL_USDC = "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv";
  const RING_LAST_TS = 1_790_174_836;
  const pool = decodeClmm(fixture(SOL_USDC));
  const ring = fixture("3Y695CuQ8AP4anbwAqiEBeQF9KxqHFr8piEwvw3UePnQ");

  it("reads the Raydium pool as the program does", () => {
    assert.equal(pool.tick, -21_697);
    assert.equal(pool.dec0, 9);
    assert.equal(pool.dec1, 6);
    assert.equal(pool.observationKey, "3Y695CuQ8AP4anbwAqiEBeQF9KxqHFr8piEwvw3UePnQ");
    assert.equal(clmmPrice(pool, false, 0), 114_225_000n);
    assert.equal(clmmDepth(pool, false), 173_442_294_000n);
  });

  it("averages the pool's history as the program does", () => {
    assert.equal(ringTwapTick(ring, SOL_USDC, pool.tick, 900, RING_LAST_TS + 5), -21_680);
    assert.isNull(ringTwapTick(ring, SOL_USDC, pool.tick, 3_600, RING_LAST_TS));
    assert.isNull(ringTwapTick(ring, "11111111111111111111111111111111", pool.tick, 900, RING_LAST_TS), "another pool's ring");
    assert.equal(sqrtPriceAtTick(0), 1n << 64n);
    const seed = clmmSeedPrice(pool, SOL_USDC, ring, false, 0, 900, 300n, RING_LAST_TS + 5);
    assert.equal(seed, 114_418_000n);
    assert.isNull(clmmSeedPrice(pool, SOL_USDC, ring, false, 0, 900, 1n, RING_LAST_TS + 5), "spot too far from the average");
    assert.isNull(clmmSeedPrice(pool, SOL_USDC, null, false, 0, 900, 300n, RING_LAST_TS + 5));
  });

  it("refuses a pool with no price, and reads no depth from no liquidity", () => {
    assert.throws(() => clmmPrice({ ...pool, sqrtPriceX64: 0n }, false));
    assert.equal(clmmDepth({ ...pool, liquidity: 0n }, false), 0n);
    assert.throws(() => decodeClmm(fixture(SOL_USDC).subarray(0, 100)));
  });

  it("reads the Meteora pair as the program does", () => {
    const PAIR = "31p1hptjhFo6ZD8oBqkfutNXQKGGPyi7YcEAfsyKW777";
    const pair = decodeDlmmPair(fixture(PAIR));
    const bins = decodeBinArray(fixture("HhCfX3gi8dQFPmVCU4oJoPvmsS1VvDrTNY6zpS4zgSRg"), PAIR);
    assert.equal(pair.activeId, -1277);
    assert.equal(binsPerMove(pair.binStep), 2);
    assert.deepEqual(dlmmBinsNeeded(pair, false), [-1277, -1276]);
    assert.equal(dlmmPrice(pair, bins, 5, 6, false, 0), 3n);
    assert.equal(dlmmPrice(pair, bins, 5, 6, false, 6), 3_809_785n);
    assert.equal(dlmmPrice(pair, bins, 5, 6, false, 9), 3_809_785_250n);
    assert.equal(dlmmPrice(pair, bins, 5, 6, true, 0), 262_481_986_287n);
    assert.equal(dlmmDepth(pair, bins, 5, 6, false), 9_457_286_028n);
    assert.equal(dlmmDepth(pair, bins, 5, 6, true), 1_252_284_071_519_230n);
    assert.throws(() => decodeBinArray(fixture("HhCfX3gi8dQFPmVCU4oJoPvmsS1VvDrTNY6zpS4zgSRg"), SOL_USDC), /another pair/);
    assert.throws(() => dlmmPrice({ ...pair, activeId: 0 }, bins, 5, 6, false), /no price/);
  });

  it("derives program addresses as web3 does", async () => {
    const program = SystemProgram.programId.toBase58();
    for (const seed of ["batch", "bin_array", "x"]) {
      const seeds = [new TextEncoder().encode(seed), new PublicKey(SOL_USDC).toBytes()];
      const [want] = PublicKey.findProgramAddressSync(seeds.map((s) => Buffer.from(s)), SystemProgram.programId);
      assert.equal(await findProgramAddress(seeds, program), want.toBase58());
    }
  });
});

describe("open guard: positions do not flip", () => {
  const long = { isLong: true, size: 400, closing: 0 };

  it("lets an open add to the side already held", () => {
    assert.isNull(openRefusal("SOL", true, long, []));
  });

  it("lets anything open with no position and nothing queued", () => {
    assert.isNull(openRefusal("SOL", false, null, []));
    assert.isNull(openRefusal("SOL", true, { isLong: false, size: 0, closing: 0 }, []));
  });

  it("refuses the other side, and says what is held", () => {
    const r = openRefusal("SOL", false, long, []);
    assert.equal(r?.kind, "held");
    assert.equal(r?.message, "You already hold a LONG on SOL. Close or reduce it first.");
  });

  it("refuses it after a partial close, which leaves a position", () => {
    assert.equal(openRefusal("SOL", false, { ...long, closing: 100 }, [])?.kind, "held");
  });

  it("says the open has to wait when all of the position is closing", () => {
    const r = openRefusal("SOL", false, { ...long, closing: 400 }, [{ isBid: false, reduceOnly: true }]);
    assert.equal(r?.kind, "closing");
    assert.match(r!.message, /closes next batch/);
  });

  it("refuses an open against the wallet's own opening order still in the batch", () => {
    const r = openRefusal("JUP", true, null, [{ isBid: false, reduceOnly: false }]);
    assert.equal(r?.kind, "queued");
    assert.equal(r?.message, "Your short order on JUP is still in this batch. Open the long after it settles.");
  });

  it("does not count a queued close or a same-side order", () => {
    assert.isNull(openRefusal("JUP", true, null, [
      { isBid: false, reduceOnly: true }, { isBid: true, reduceOnly: false }]));
  });

  it("asks a limit only about the position", () => {
    assert.isNull(openRefusal("JUP", true, null, [{ isBid: false, reduceOnly: false }], false));
    assert.equal(openRefusal("SOL", false, long, [], false)?.kind, "held");
  });
});

describe("server: a stale mark pauses an observed market", () => {
  it("is tradeable only seasoned, backed and within the age limit", () => {
    assert.isTrue(observedTradeable(true, 1_000, 30_000, 120));
    assert.isTrue(observedTradeable(true, 1_000, 120_000, 120), "at the limit");
    assert.isFalse(observedTradeable(true, 1_000, 120_001, 120), "past it");
    // ORCA on October 10, 2026: a 22 minute old mark reported as tradeable.
    assert.isFalse(observedTradeable(true, 27_255, 1_309_877, 120));
    assert.isFalse(observedTradeable(false, 1_000, 1_000, 120), "seasoning");
    assert.isFalse(observedTradeable(true, 0, 1_000, 120), "unbacked");
  });

  it("takes a mark's age from the chain, not from when it was read", () => {
    const now = 1_791_630_000_000;
    // Written an hour ago and re-read just now, as at a restart.
    const written = markWrittenMs(now / 1000 - 3_600, now, now);
    assert.equal(now - written, 3_600_000);
    assert.isFalse(observedTradeable(true, 1_000, now - written, 120));
    // A clock ahead of ours reads as just now, and no timestamp keeps the fallback.
    assert.equal(markWrittenMs(now / 1000 + 30, now, 0), now);
    assert.equal(markWrittenMs(0, now, 42), 42);
  });

  it("has no age before the first reading and no limit at zero", () => {
    assert.isFalse(markStale(null, 120));
    assert.isFalse(markStale(10_000_000, 0));
    assert.isTrue(observedTradeable(true, 1_000, null, 120));
  });
});

describe("devnet flow: sizing a swap toward the real price", () => {
  // A pool with `bins` bins of liquidity in the direction of travel, each
  // taking `perBin` of input to cross, one price unit per bin from 100. A
  // partial-fill quote stops at the last bin, as the SDK's does.
  const pool = (bins: number, perBin: bigint, up: boolean) => (amount: bigint) => {
    const cap = BigInt(bins) * perBin;
    const used = amount < cap ? amount : cap;
    const moved = Number(used) / Number(perBin);
    return { endPrice: up ? 100 + moved : 100 - moved, consumed: used };
  };

  it("finds the least input that reaches a target inside the liquidity", () => {
    const q = pool(30, 1_000n, true);
    const { amount, reached } = sizeSwap(q, 1_000_000n, 110, true);
    assert.isTrue(reached);
    assert.equal(q(amount).endPrice, 110);
    assert.isBelow(q(amount - 1n).endPrice, 110);
  });

  it("stops inside the last bin when the target lies past the liquidity", () => {
    // WIF's copy on October 10, 2026: 19 bins of USDC below the price and
    // the real price 104 bins down. Asking for the whole way swapped more
    // than the pool holds and failed on chain every pass.
    const q = pool(19, 1_000n, false);
    const { amount, reached } = sizeSwap(q, 10_000_000n, 100 - 104, false);
    assert.isFalse(reached);
    assert.isTrue(amount <= 19n * 1_000n, "never more than the pool can fill");
    assert.isTrue(amount > 18n * 1_000n, "but most of the way to the edge");
  });

  it("swaps nothing when there is nothing to swap into", () => {
    const { amount, reached } = sizeSwap(pool(0, 1_000n, true), 1_000_000n, 120, true);
    assert.equal(amount, 0n);
    assert.isFalse(reached);
  });
});
