/*
 * When the checks run.
 *
 * Two loops in the fleet's process, with no browser: the API pinger
 * (api-health.ts, every API_HEALTH_EVERY_SEC) and the deploy watcher
 * (deploy.ts, every DEPLOY_POLL_SEC). The rest take a worker's turn between
 * sessions, the way the survey does, so the fleet's browser count and its
 * CPU and memory caps stay as they are:
 *
 *   deploy smoke   right after a deploy, ahead of anything else
 *   numbers        every NUMBERS_EVERY_MIN (30)
 *   stale          every STALE_EVERY_MIN (30)
 *   wallet edges   every WALLET_EDGES_EVERY_MIN (240)
 *   links          every LINKS_EVERY_HOURS (24)
 *
 * A periodic check is due when its last start (kept in the store, so a
 * restart does not rerun everything) is older than its period. One worker
 * runs a given check at a time; each is cut off after CHECK_TIMEOUT_MS.
 */
import type { Browser } from "playwright-core";
import { config } from "../config";
import * as store from "../store";
import * as apiHealth from "./api-health";
import { prune, recordRun } from "./common";
import * as deploy from "./deploy";
import * as links from "./links";
import * as numbers from "./numbers";
import * as stale from "./stale";
import * as walletEdges from "./wallet-edges";

type Run = (browser: Browser) => Promise<{ ok: boolean; summary: string }>;

interface Periodic { name: string; everyMs: number; run: Run }

const PERIODIC: Periodic[] = [
  { name: "numbers", everyMs: config.numbersEveryMin * 60_000, run: numbers.run },
  { name: "stale", everyMs: config.staleEveryMin * 60_000, run: stale.run },
  { name: "wallet-edges", everyMs: config.walletEdgesEveryMin * 60_000, run: walletEdges.run },
  { name: "links", everyMs: config.linksEveryHours * 3_600_000, run: links.run },
];

export const byName = (name: string) => PERIODIC.find((p) => p.name === name);
export const names = () => PERIODIC.map((p) => p.name);

export type Task =
  | { kind: "deploy"; task: deploy.SmokeTask }
  | { kind: "check"; check: Periodic };

const running = new Set<string>();
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

/// A deploy's smoke task, if one is waiting: taken before the survey.
export function urgent(): Task | null {
  const t = deploy.nextTask();
  return t ? { kind: "deploy", task: t } : null;
}

/// A periodic check that is due, marked started so no other worker takes it.
export function next(): Task | null {
  for (const c of PERIODIC) {
    if (c.everyMs <= 0 || running.has(c.name)) continue;
    const last = Number(store.getMeta(`check_last:${c.name}`) ?? 0);
    if (Date.now() - last < c.everyMs) continue;
    store.setMeta(`check_last:${c.name}`, String(Date.now()));
    return { kind: "check", check: c };
  }
  return null;
}

/// Runs one task in a worker's turn. Returns a line for the log.
export async function run(task: Task, browser: Browser, worker: number): Promise<string> {
  if (task.kind === "deploy") return deploy.runTask(browser, task.task, worker);
  const c = task.check;
  running.add(c.name);
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const r = await Promise.race([
      c.run(browser),
      new Promise<{ ok: boolean; summary: string }>((res) => {
        timer = setTimeout(() => res({ ok: false, summary: `${c.name}: cut off after ${config.checkTimeoutMs / 1000}s` }), config.checkTimeoutMs);
      }),
    ]);
    recordRun(c.name, t0, r.ok, r.summary);
    return `${r.summary} (${((Date.now() - t0) / 1000).toFixed(0)}s)`;
  } catch (e: any) {
    const why = `${c.name} failed: ${String(e?.message ?? e).split("\n")[0]}`;
    recordRun(c.name, t0, false, why);
    return why;
  } finally {
    if (timer) clearTimeout(timer);
    running.delete(c.name);
  }
}

/// Starts the browserless loops. They stop when `stopping` turns true.
export function start(stopping: () => boolean) {
  deploy.restore();
  let apiDown: boolean | undefined;
  void (async () => {
    // Staggered from the workers' start.
    await new Promise((r) => setTimeout(r, 15_000));
    let pruned = 0;
    while (!stopping()) {
      const t = Date.now();
      try {
        const r = await apiHealth.ping();
        apiDown = r.down;
        if (r.failed) log(`api health: ${r.failed} of ${r.total} routes failing`);
      } catch (e: any) { log(`api health: ${e?.message ?? e}`); }
      if (Date.now() - pruned > 86_400_000) { try { prune(); } catch { /* next day */ } pruned = Date.now(); }
      const until = t + config.apiHealthEverySec * 1000;
      while (!stopping() && Date.now() < until) await new Promise((r) => setTimeout(r, 1_000));
    }
  })();
  if (config.deployPollSec > 0) {
    void (async () => {
      await new Promise((r) => setTimeout(r, 20_000));
      while (!stopping()) {
        const t = Date.now();
        try {
          const seen = await deploy.poll(apiDown);
          if (seen) log(seen);
        } catch (e: any) { log(`deploy watch: ${e?.message ?? e}`); }
        const until = t + config.deployPollSec * 1000;
        while (!stopping() && Date.now() < until) await new Promise((r) => setTimeout(r, 1_000));
      }
    })();
  }
}
