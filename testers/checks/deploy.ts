/*
 * A deploy, and a quick pass over the core journeys right after it.
 *
 * How a deploy is seen (every DEPLOY_POLL_SEC, sixty seconds; one small GET
 * of the site's front page and a look at answers the API pinger already has):
 *
 *   site     the hashed script names in www.unwindfi.xyz's index.html (the
 *            same build id the fleet stamps on its issues), or the page's
 *            ETag, changed
 *   server   a build header on /api/markets (x-build, x-server-build,
 *            x-revision, x-server-started), when the server sends one;
 *            without one, the shape of its answers (the sorted field names
 *            of /api/markets, /api/rewards and /api/leaderboard) changed,
 *            which is what a server deploy that matters to the site looks
 *            like from outside
 *   restart  the API pinger found nearly every route unreachable or 502,
 *            then the API answered again: the server came back from a
 *            restart, which is what deploy/testnet/push.sh does
 *
 * The first reading after the fleet starts is a baseline, not a deploy. On a
 * change, a "deploy" row is written and two tasks are queued, one per
 * DEPLOY_PERSONAS persona, that the next free workers take before anything
 * else: browse, trade (open and close), list (to the preview) on the first;
 * rewards, earn and trade on the second, on its own device. Each journey's
 * pass or fail goes on the deploy's row; any failure files a high issue.
 */
import crypto from "crypto";
import type { Browser } from "playwright-core";
import { config } from "../config";
import { byName } from "../journeys";
import { PERSONAS } from "../personas";
import { Ctx, StepError } from "../session";
import * as store from "../store";
import { db, fileIssue, timed } from "./common";

const sha = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);

export interface Fingerprint { site: string | null; server: string | null }

async function siteId(): Promise<string | null> {
  const r = await timed(config.baseUrl + "/", { ms: 15_000 });
  if (r.status !== 200 || !r.text.includes('id="root"')) return null;
  const scripts = [...r.text.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).sort().join(",");
  const build = crypto.createHash("sha1").update(scripts).digest("hex").slice(0, 10);
  // The same id run.ts stamps on issues; the ETag catches a deploy that
  // moved only the page itself.
  return `${build}${r.headers.get("etag") ? `/${sha(r.headers.get("etag")!)}` : ""}`;
}

const keysOf = (v: unknown): string => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort().join(",") : Array.isArray(v) ? `[${keysOf(v[0])}]` : typeof v);

async function serverId(): Promise<string | null> {
  const m = await timed(config.checksApiUrl + "/api/markets", { accept: "application/json" });
  if (m.status !== 200) return null;
  const header = ["x-build", "x-server-build", "x-revision", "x-server-started"].map((h) => m.headers.get(h)).find(Boolean);
  if (header) return `h:${header}`;
  const r = await timed(config.checksApiUrl + "/api/rewards?owner=So11111111111111111111111111111111111111112", { accept: "application/json" });
  const l = await timed(config.checksApiUrl + "/api/leaderboard", { accept: "application/json" });
  try {
    return `s:${sha([m, r, l].map((x) => keysOf(JSON.parse(x.text))).join("|"))}`;
  } catch { return null; }
}

/// Queued smoke tasks, taken by workers ahead of anything else.
export interface SmokeTask { deploy: number; persona: string; journeys: string[] }
const queue: SmokeTask[] = [];
const pending = new Map<number, number>(); // deploy -> tasks not done yet

export const nextTask = () => queue.shift() ?? null;

function record(reason: string, f: Fingerprint) {
  const t = Date.now();
  const r = db().prepare("INSERT INTO deploys (t, site, server, reason, status, results) VALUES (?,?,?,?,?,?)")
    .run(t, f.site, f.server, reason, config.deploySmoke ? "running" : "seen", "{}");
  const id = Number(r.lastInsertRowid);
  if (!config.deploySmoke) return id;
  const [a, b] = config.deployPersonas;
  const tasks: SmokeTask[] = [
    { deploy: id, persona: a, journeys: ["browse", "trade", "list"] },
    ...(b ? [{ deploy: id, persona: b, journeys: ["rewards", "earn", "trade"] }] : []),
  ];
  // A newer deploy replaces the smoke of one not yet started.
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].deploy !== id) queue.splice(i, 1);
  queue.push(...tasks);
  pending.set(id, tasks.length);
  return id;
}

let last: Fingerprint | null = null;
let wasDown = false;

/// One look. `apiDown` is the pinger's latest verdict on the API as a whole.
export async function poll(apiDown?: boolean): Promise<string | null> {
  const [site, server] = await Promise.all([siteId(), serverId()]);
  const reasons: string[] = [];
  if (last) {
    if (site && last.site && site !== last.site) reasons.push(`site build ${last.site} to ${site}`);
    if (server && last.server && server !== last.server) reasons.push(`server ${last.server} to ${server}`);
  }
  if (apiDown != null) {
    if (apiDown) wasDown = true;
    else if (wasDown && server) { wasDown = false; reasons.push("API back after a restart"); }
  }
  // Kept through a moment when one side did not answer.
  last = { site: site ?? last?.site ?? null, server: server ?? last?.server ?? null };
  store.setMeta("deploy_fingerprint", JSON.stringify(last));
  if (!reasons.length) return null;
  const id = record(reasons.join("; "), last);
  return `deploy ${id}: ${reasons.join("; ")}`;
}

/// The baseline survives a restart of the fleet, so a deploy while it was
/// stopped is still seen.
export function restore() {
  try { last = JSON.parse(store.getMeta("deploy_fingerprint") ?? "null"); } catch { last = null; }
}

/// One persona's part of a deploy's smoke pass, in a worker's turn.
export async function runTask(browser: Browser, task: SmokeTask, worker: number): Promise<string> {
  const p = PERSONAS.find((x) => x.id === task.persona);
  if (!p) return `deploy ${task.deploy}: no persona ${task.persona}`;
  const id = store.startSession({ persona: p.id, role: "deploy-smoke", device: p.device.name, theme: p.theme, worker });
  const ctx = new Ctx(p, id, worker);
  const results: Record<string, string> = {};
  let passed = 0, failed = 0;
  try {
    await ctx.open(browser);
    for (const name of task.journeys) {
      const j = byName(name);
      if (!j) { results[name] = "no such journey"; failed++; continue; }
      const js = Date.now();
      // Tighter than a session's: a fast pass, not a long visit.
      const budget = Math.min(j.budgetMs, 150_000);
      ctx.deadline = js + budget;
      let ok = true, err: string | undefined;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          j.run(ctx),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new StepError(`over its ${budget / 1000}s budget`)), budget + 5_000); }),
        ]);
      } catch (e: any) {
        ok = false;
        err = `${ctx.rec.step}: ${String(e?.message ?? e).split("\n")[0]}`.slice(0, 300);
      } finally { if (timer) clearTimeout(timer); }
      store.recordJourney({ session: id, persona: p.id, name: `deploy:${name}`, started: js, ok, error: err, steps: ctx.steps });
      results[name] = ok ? "pass" : `fail: ${err}`;
      if (ok) passed++; else failed++;
    }
  } catch (e: any) {
    results.open = `fail: ${String(e?.message ?? e).split("\n")[0]}`;
    failed++;
  } finally {
    await ctx.close();
    store.endSession(id, { ok: failed === 0, passed, failed });
  }
  finish(task, results);
  return `deploy ${task.deploy} smoke as ${p.id}: ${Object.entries(results).map(([k, v]) => `${k} ${v.split(":")[0]}`).join(", ")}`;
}

function finish(task: SmokeTask, results: Record<string, string>) {
  const d = db();
  const row = d.prepare("SELECT results, reason FROM deploys WHERE id = ?").get(task.deploy) as { results: string; reason: string } | undefined;
  if (!row) return;
  const all = { ...(JSON.parse(row.results || "{}") as Record<string, Record<string, string>>), [task.persona]: results };
  const left = (pending.get(task.deploy) ?? 1) - 1;
  pending.set(task.deploy, left);
  const failures = Object.entries(all).flatMap(([p, rs]) => Object.entries(rs).filter(([, v]) => v !== "pass").map(([j, v]) => `${p} ${j}: ${v}`));
  const status = left > 0 ? "running" : failures.length ? "fail" : "pass";
  d.prepare("UPDATE deploys SET results = ?, status = ?, finished = ? WHERE id = ?")
    .run(JSON.stringify(all), status, left > 0 ? null : Date.now(), task.deploy);
  if (left <= 0) pending.delete(task.deploy);
  if (failures.length && left <= 0) {
    void fileIssue({
      type: "deploy-smoke", severity: "high", route: "(deploy)",
      message: `After the deploy (${row.reason}), ${failures.length} core journey(s) failed: ${failures.join("; ").slice(0, 600)}`,
      key: `deploy smoke ${failures.map((f) => f.split(":")[0]).sort().join(",")}`,
      step: "deploy smoke",
    });
  }
}
