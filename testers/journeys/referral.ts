/*
 * A referral from link to reward, between two personas.
 *
 * A (a referrer persona) holds its code, `ut-<id>` (claimed here if it has
 * none). It picks B: a persona that has never filled, so it can still name a
 * referrer, with the USDC for the trades below. B then has its own turns:
 *
 *   b-arrive   opens /r/<code> in a fresh browser, connects, opens $520
 *   b-close1   10+ minutes later closes it: B earns 2 points per $1 closed,
 *              and now has $1,040 of held volume, so A is owed nothing yet
 *   b-open2    opens $260
 *   b-close2   10+ minutes later closes it: A is owed 10% of these points
 *
 * and A's last turn (a-check) reads its referee row on /rewards and in
 * /api/rewards: the points share, and 10% of every fee B paid, in USDC.
 * The rules are docs/rewards.md's. The holds are follow-ups: no browser
 * waits for them.
 */
import { config } from "../config";
import { PERSONAS, keyOf } from "../personas";
import * as store from "../store";
import { live, openTrade, parseMoney, type Journey } from "./common";
import * as fu from "./followup";
import { codeOf } from "./rewards";
import { closeVia, fillsOf, freshMarkets, marketOrder, settled, until, type Fill, connected } from "./venue";
import type { Ctx } from "../session";

const NAME = "referral";
const FIRST_USD = 520;
const SECOND_USD = 260;
const USED_KEY = "ref:used";

interface Rewards {
  account: string; exists: boolean; code: string | null; referrer: string | null; referrerCode: string | null;
  canSetReferrer: boolean; points: number; feesSaved: number;
  breakdown: { trading: number; referrals: number };
  earned: { referrals: number };
  referees: { wallet: string; code: string | null; volume: number; points: number; usdc: number }[];
}
interface State {
  a: string; b: string; code: string;
  sym?: string; openAt?: number; since?: number;
  close1?: number; pointsBefore?: number; refPointsBefore?: number; aReferralsBefore?: number;
  expectRefPoints?: number; checks?: number; misses?: number;
}

const addr = (id: string) => keyOf(PERSONAS.find((p) => p.id === id)!).publicKey.toBase58();
const rewardsOf = (ctx: Ctx, owner: string) => ctx.api<Rewards>(`/api/rewards?owner=${owner}`);
const used = (): string[] => { try { return JSON.parse(store.getMeta(USED_KEY) ?? "[]"); } catch { return []; } };

export const referral: Journey = {
  name: NAME,
  budgetMs: 200_000,
  wallet: true,
  async run(ctx) {
    const id = ctx.persona.id;
    const plan = fu.get<State>(id, NAME);
    if (!plan) return ctx.persona.role === "referrer" ? start(ctx) : undefined;
    const s = plan.data;
    switch (plan.stage) {
      case "b-arrive": return arrive(ctx, s);
      case "b-close1": return closeLeg(ctx, s, 1);
      case "b-open2": await openLeg(ctx, s, 2); return;
      case "b-close2": return closeLeg(ctx, s, 2);
      case "a-check": return check(ctx, s);
      default: fu.clear(id, NAME);
    }
  },
};

/// A: make sure of the code, then hand B its first turn.
async function start(ctx: Ctx) {
  const page = ctx.page;
  // One referee at a time per referrer: the never-filled personas are few.
  if (fu.all().some((p) => p.journey === NAME && (p.data as Partial<State>).a === ctx.persona.id)) return;
  let r = await rewardsOf(ctx, ctx.owner);
  let code = r?.code ?? null;
  if (!code) {
    if (!live()) return;
    const mine = codeOf(ctx.persona.id);
    await ctx.step("open /rewards", () => ctx.goto("/rewards", (p) => p.getByRole("tab", { name: "Leaderboard" })));
    await connected(ctx);
    const res = await ctx.step("claim a code", async () => {
      await ctx.click(page.getByRole("tab", { name: "Referrals" }), "the Referrals tab");
      const field = page.getByPlaceholder("yourname");
      await ctx.ready(field, "the code field");
      await ctx.type(field, mine);
      const hint = page.getByText(/^(Available\.|Taken\.)$/);
      await hint.first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
      if ((await hint.first().innerText({ timeout: 1_000 }).catch(() => "")) !== "Available.") return "taken";
      return ctx.tx("referral-code", () => ctx.click(page.getByRole("button", { name: "Claim", exact: true }), "Claim"));
    });
    if (res !== "confirmed") return;
    const owner = await until(ctx, async () => (await ctx.api<{ valid: boolean; owner?: string }>(`/api/referral-code/${mine}`))?.owner, 30_000, 2_000);
    if (owner !== ctx.owner) {
      await ctx.rec.issue("referral-code", "high", `${NAME}: claimed ${mine} (confirmed); /api/referral-code says ${owner ?? "nobody"} holds it`, { key: `${NAME} code owner` });
      return;
    }
    code = mine;
    r = await rewardsOf(ctx, ctx.owner);
  }

  // B: never filled (so it can still name a referrer), funded, not busy.
  const taken = new Set(used());
  const pool = PERSONAS.filter((p) => p.id !== ctx.persona.id && p.id !== config.liqPersona && !taken.has(p.id) && !fu.holds(p.id))
    .sort((x, y) => Number(["lp", "backer"].includes(y.role)) - Number(["lp", "backer"].includes(x.role)));
  for (const p of pool.slice(0, 12)) {
    const owner = keyOf(p).publicKey.toBase58();
    const [rb, ab] = [await rewardsOf(ctx, owner), await ctx.api<{ usdc: number }>(`/api/account?owner=${owner}`)];
    if (!rb || rb.referrer || !rb.canSetReferrer || (ab?.usdc ?? 0) < FIRST_USD / 2) continue;
    store.setMeta(USED_KEY, JSON.stringify([...taken, p.id]));
    fu.next<State>(p.id, NAME, "b-arrive", Date.now(), { a: ctx.persona.id, b: p.id, code }, Date.now());
    fu.note(NAME, ctx.persona.id, `code ${code}: ${p.id} will arrive by the link`);
    return;
  }
  fu.note(NAME, ctx.persona.id, "no persona left that can still name a referrer");
}

/// B: the link, the wallet, the first order (which carries the code).
async function arrive(ctx: Ctx, s: State) {
  const page = ctx.page;
  await ctx.step("open /r/:code", async () => {
    await ctx.goto(`/r/${s.code}`, (p) => p.getByPlaceholder("Search ticker or name"));
    const u = new URL(page.url());
    const stored = await page.evaluate(() => localStorage.getItem("unwind.ref")).catch(() => null);
    if (u.pathname !== "/" || u.searchParams.get("ref") !== s.code || stored !== s.code) {
      await ctx.rec.issue("referral-link", "high", `${NAME}: /r/${s.code} landed on ${u.pathname}${u.search} with ${stored ?? "nothing"} stored`, { key: `${NAME} link` });
    }
  });
  const ok = await openLeg(ctx, s, 1);
  if (!ok) return;
  const r = await ctx.step("watch the referrer get set", () => until(ctx, async () => (await rewardsOf(ctx, ctx.owner))?.referrer ? rewardsOf(ctx, ctx.owner) : null, 30_000, 3_000));
  if (!r || r.referrerCode !== s.code) {
    await ctx.rec.issue("referral-not-set", "high",
      `${NAME}: arrived by /r/${s.code} and filled, but the wallet's referrer is ${r?.referrerCode ?? r?.referrer ?? "unset"}`, { key: `${NAME} referrer unset` });
    fu.clear(ctx.persona.id, NAME);
  }
}

/// B opens a leg; the close is due once it has been held long enough.
async function openLeg(ctx: Ctx, s: State, leg: 1 | 2): Promise<boolean> {
  const id = ctx.persona.id;
  const usd = leg === 1 ? FIRST_USD : SECOND_USD;
  const ms = await freshMarkets(ctx);
  const m = s.sym ? ms.find((x) => x.symbol === s.sym)
    : ms.filter((x) => x.observed?.tradeable && !x.paused && !x.hidden && (x.poolFillUsd ?? 0) >= usd).sort((a, b) => (b.poolFillUsd ?? 0) - (a.poolFillUsd ?? 0))[0];
  if (!m) { fu.clear(id, NAME); return false; }
  await openTrade(ctx, m);
  await connected(ctx);
  const [r, why] = await marketOrder(ctx, m, "long", usd, Math.min(4, m.maxLeverage), "order");
  if (r === "skipped") { fu.next<State>(id, NAME, leg === 1 ? "b-arrive" : "b-open2", fu.txReadyAt(id), s); return false; }
  if (r !== "confirmed") {
    if (r === "blocked") await ctx.rec.issue("order-blocked", "medium", `${NAME}: $${usd} on ${m.symbol} not accepted: ${why}`, { key: `${NAME} open blocked` });
    if (r !== "dry") fu.clear(id, NAME);
    return false;
  }
  const a = await ctx.step("watch it settle", () => settled(ctx, (x) => !!x.positions[m.symbol]));
  if (!a) { fu.clear(id, NAME); return false; }
  const openAt = Date.now();
  fu.next<State>(id, NAME, leg === 1 ? "b-close1" : "b-close2", Math.max(fu.txReadyAt(id), openAt + config.referralHoldMs),
    { ...s, sym: m.symbol, openAt, since: s.since ?? openAt - 60_000 });
  return true;
}

/// B closes a leg held 10 minutes, and its points are counted.
async function closeLeg(ctx: Ctx, s: State, leg: 1 | 2) {
  const id = ctx.persona.id;
  const m = (await freshMarkets(ctx)).find((x) => x.symbol === s.sym);
  if (!m) return fu.clear(id, NAME);
  const [rb, ra] = [await rewardsOf(ctx, ctx.owner), await rewardsOf(ctx, addr(s.a))];
  const refBefore = ra?.referees.find((x) => x.wallet === ctx.owner)?.points ?? 0;
  await openTrade(ctx, m);
  await connected(ctx);
  const r = await closeVia(ctx, m.symbol, null);
  if (r === "skipped") { fu.next<State>(id, NAME, `b-close${leg}`, fu.txReadyAt(id), s); return; }
  if (r !== "confirmed") return;
  const sent = ctx.lastSend?.at ?? Date.now();
  await settled(ctx, (x) => !x.positions[m.symbol]);
  const fill = await until(ctx, async () => (await fillsOf(ctx)).find((f) => f.symbol === m.symbol && f.kind === "close" && f.t >= sent - 5_000), 20_000);
  if (!fill || !rb) return fu.clear(id, NAME);
  const want = 2 * fill.size;
  const after = await until(ctx, async () => {
    const x = await rewardsOf(ctx, ctx.owner);
    return x && x.breakdown.trading > rb.breakdown.trading + 1e-6 ? x : null;
  }, 45_000, 3_000);
  const got = (after?.breakdown.trading ?? rb.breakdown.trading) - rb.breakdown.trading;
  if (Math.abs(got - want) > Math.max(1, want * 0.01)) {
    await ctx.rec.issue("points-mismatch", "high",
      `${NAME}: closing $${fill.size} held ${Math.round((fill.t - (s.openAt ?? fill.t)) / 1000)}s credited ${got.toFixed(2)} trading points; the rules give ${want.toFixed(2)}`,
      { key: `${NAME} close${leg} points` });
  }
  if (leg === 1) {
    // B's held volume was under $1,000 before this close: A is owed nothing.
    await ctx.page.waitForTimeout(5_000);
    const ra2 = await rewardsOf(ctx, addr(s.a));
    const refNow = ra2?.referees.find((x) => x.wallet === ctx.owner)?.points ?? 0;
    if (refNow > refBefore + 0.01) {
      await ctx.rec.issue("points-mismatch", "high", `${NAME}: referrer credited ${(refNow - refBefore).toFixed(2)} points from a close before $1,000 of held volume`, { key: `${NAME} early share` });
    }
    fu.next<State>(id, NAME, "b-open2", fu.txReadyAt(id), { ...s, close1: fill.size });
    return;
  }
  // The share is moved to A by sync_referral, every minute on devnet.
  fu.clear(id, NAME);
  fu.next<State>(s.a, NAME, "a-check", Date.now() + 150_000, {
    ...s, refPointsBefore: refBefore, aReferralsBefore: ra?.breakdown.referrals ?? 0,
    // Owed only if B already had $1,000 held before this close.
    expectRefPoints: (s.close1 ?? 0) * 2 >= 1_000 ? got * 0.1 : 0, checks: 0,
  }, s.since);
}

/// A: its referee row, on the API and on /rewards.
async function check(ctx: Ctx, s: State) {
  const id = ctx.persona.id;
  const bWallet = addr(s.b);
  const ra = await rewardsOf(ctx, ctx.owner);
  const row = ra?.referees.find((x) => x.wallet === bWallet);
  if (!ra || !row) {
    await ctx.rec.issue("referral-missing", "high", `${NAME}: ${s.b} arrived by ${s.code} and traded, but is not among the referrer's referees`, { key: `${NAME} referee missing` });
    return fu.clear(id, NAME);
  }
  const share = row.points - (s.refPointsBefore ?? 0);
  const want = s.expectRefPoints ?? 0;
  if (Math.abs(share - want) > Math.max(0.5, want * 0.02)) {
    if ((s.checks ?? 0) < 3) { fu.next<State>(id, NAME, "a-check", Date.now() + 120_000, { ...s, checks: (s.checks ?? 0) + 1 }); return; }
    await ctx.rec.issue("points-mismatch", "high", `${NAME}: referrer's share of ${s.b}'s close is ${share.toFixed(2)} points; 10% is ${want.toFixed(2)}`, { key: `${NAME} share points` });
  }
  // 10% of every fee the referee paid, from its first fill.
  const fees = (await ctx.api<Fill[]>(`/api/fills?owner=${bWallet}`)) ?? [];
  const paid = fees.filter((f) => f.t >= (s.since ?? 0) && f.fee != null).reduce((a, f) => a + f.fee!, 0);
  if (fees.length >= 4 && Math.abs(row.usdc - paid * 0.1) > Math.max(0.02, paid * 0.002)) {
    await ctx.rec.issue("referral-usdc", "high", `${NAME}: referrer earned $${row.usdc.toFixed(4)} from ${s.b}; 10% of its $${paid.toFixed(4)} in fees is $${(paid * 0.1).toFixed(4)}`, { key: `${NAME} share usdc` });
  }
  await ctx.step("open /rewards", () => ctx.goto("/rewards", (p) => p.getByRole("tab", { name: "Leaderboard" })));
  await connected(ctx);
  await ctx.step("watch the Referred row", async () => {
    await ctx.click(ctx.page.getByRole("tab", { name: "Referrals" }), "the Referrals tab");
    const label = row.code ?? `${bWallet.slice(0, 4)}…${bWallet.slice(-4)}`;
    const line = ctx.page.getByRole("link", { name: label, exact: true }).locator("xpath=..");
    if (!(await line.first().waitFor({ state: "visible", timeout: 12_000 }).then(() => true, () => false))) {
      await ctx.rec.issue("referral-missing", "high", `${NAME}: ${label} is a referee in the API but not in the Referred card`, { key: `${NAME} referred row` });
      return;
    }
    const text = await line.first().innerText().catch(() => "");
    const usdc = [...text.matchAll(/\$[\d,.]+/g)].map((x) => parseMoney(x[0])).filter((x): x is number => x != null);
    if (!usdc.some((v) => Math.abs(v - row.usdc) <= 0.011)) {
      await ctx.rec.issue("number-mismatch", "high", `${NAME}: Referred row reads "${text.replace(/\s+/g, " ")}"; the API $${row.usdc.toFixed(2)} earned`, { key: `${NAME} referred usdc` });
    }
  });
  fu.note(NAME, id, `${s.b} by ${s.code}: share ${share.toFixed(2)} points (want ${want.toFixed(2)}), $${row.usdc.toFixed(4)} USDC`);
  fu.clear(id, NAME);
}
