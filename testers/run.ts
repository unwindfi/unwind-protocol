/*
 * The fleet, forever.
 *
 * CONCURRENCY workers, each with its own headless Chrome, take personas in
 * turn (with jitter), give each a fresh browser context for one session of
 * one to three journeys, and write what they saw to the store. Chrome is
 * relaunched every RECYCLE_EVERY sessions so a slow leak cannot grow. When
 * the site or the API stops answering, the fleet records one outage and
 * waits, longer each time, instead of filing the same failure from every
 * session. Once an hour the survey (survey.ts) borrows a worker's turn for a
 * chunk of route captures, and the checks (checks/index.ts) take turns the
 * same way; the API pinger and the deploy watcher run beside the workers
 * with no browser. SIGTERM finishes the current journeys' steps and exits.
 *
 *   npx ts-node --transpile-only -P testers/tsconfig.json testers/run.ts
 */
import crypto from "crypto";
import { execFileSync } from "child_process";
import { chromium, type Browser } from "playwright-core";
import { config } from "./config";
import { activePersonas, loadKeys, type Persona } from "./personas";
import { plan } from "./journeys";
import { Ctx, StepError } from "./session";
import * as store from "./store";
import { normalize } from "./detectors";
import * as survey from "./survey";
import * as checks from "./checks";

let stopping = false;
const started = Date.now();
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ------------------------------------------------------------ health

const health = { down: false, until: 0, backoff: 30_000, why: "" };

async function fetchText(url: string, ms = 15_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "unwind-testers/1" } });
    return { status: r.status, text: await r.text() };
  } finally { clearTimeout(t); }
}

/// Whether the site and the API answer; also notes which build is live (the
/// hashed script names in the page), which is what "a new deploy" means to
/// the dashboard's fixed/ignore toggle.
async function checkHealth(): Promise<boolean> {
  if (health.down && Date.now() < health.until) return false;
  let why = "";
  try {
    const site = await fetchText(config.baseUrl + "/");
    if (site.status >= 400 || !site.text.includes('id="root"')) why = `site answered ${site.status}`;
    else {
      const scripts = [...site.text.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).sort().join(",");
      const build = crypto.createHash("sha1").update(scripts).digest("hex").slice(0, 10);
      if (store.getMeta("build") !== build) { store.setMeta("build", build); log(`build ${build}`); }
    }
    if (!why) {
      const api = await fetchText(config.apiUrl + "/api/markets");
      if (api.status === 429) why = "API rate limited the fleet (429)";
      else if (api.status >= 400) why = `API answered ${api.status}`;
      else if (!Array.isArray(JSON.parse(api.text))) why = "API's market list is not a list";
    }
  } catch (e: any) {
    why = `unreachable: ${e?.cause?.code ?? e?.message ?? e}`;
  }
  if (!why) {
    if (health.down) log(`back up after: ${health.why}`);
    health.down = false; health.backoff = 30_000; health.why = "";
    return true;
  }
  if (!health.down || health.why !== why) {
    // One issue per outage, however long it lasts.
    store.recordIssue({
      type: "outage", severity: "high", route: "/", message: why, signature: `outage-${crypto.createHash("sha1").update(normalize(why)).digest("hex").slice(0, 10)}`,
      persona: "fleet", device: "-", theme: "-", step: "health check",
    });
    log(`down: ${why}; waiting ${health.backoff / 1000}s`);
  }
  health.down = true; health.why = why;
  health.until = Date.now() + health.backoff;
  health.backoff = Math.min(health.backoff * 2, 10 * 60_000);
  return false;
}

/// Rests the whole fleet, e.g. after the API answered 429.
function restFleet(ms: number, why: string) {
  if (health.down && health.until > Date.now() + ms) return;
  health.down = true; health.why = why; health.until = Date.now() + ms;
  log(`resting ${ms / 1000}s: ${why}`);
}

// ------------------------------------------------------------ memory

/// Resident memory of every Chrome process this runner started, in MB.
export function chromeMb(): number {
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" });
    const rows = out.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map<number, number[]>();
    for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
    const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
    let total = 0;
    const walk = (p: number) => { for (const k of kids.get(p) ?? []) { total += rss.get(k) ?? 0; walk(k); } };
    walk(process.pid);
    return Math.round(total / 1024);
  } catch { return 0; }
}

// ------------------------------------------------------------ sessions

const personas = activePersonas();
let turn = 0;
/// Round robin, with the starting point shuffled per run so a restart does
/// not always begin with the same person.
const offset = Math.floor(Math.random() * personas.length);
const nextPersona = (): Persona => personas[(offset + turn++) % personas.length];

async function session(browser: Browser, worker: number, p: Persona) {
  const id = store.startSession({ persona: p.id, role: p.role, device: p.device.name, theme: p.theme, worker });
  const ctx = new Ctx(p, id, worker);
  const results: string[] = [];
  let passed = 0, failed = 0, error: string | undefined;
  const t0 = Date.now();
  let issues = 0;
  try {
    await ctx.open(browser);
    ctx.rec.onIssue = () => { issues++; };
    const journeys = plan(p.role, ctx.rng);
    const sessionEnd = t0 + config.sessionTimeoutMs;
    for (const j of journeys) {
      if (stopping || Date.now() > sessionEnd - 10_000) break;
      const js = Date.now();
      ctx.deadline = Math.min(sessionEnd, js + j.budgetMs);
      let ok = true, err: string | undefined;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          j.run(ctx),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new StepError(`over its ${j.budgetMs / 1000}s budget`)), ctx.deadline - js + 5_000); }),
        ]);
      } catch (e: any) {
        ok = false;
        err = `${ctx.rec.step}: ${String(e?.message ?? e).split("\n")[0]}`;
        // A step that could not be done is a finding: the control moved,
        // or the page never got where it should. Harness bugs land here too;
        // the step name says which.
        await ctx.rec.issue("step-failed", "medium", `${j.name} / ${err}`, {
          key: `${j.name} ${ctx.rec.step} ${normalize(String(e?.message ?? e).split("\n")[0]).replace(/locator\([^)]*\)/g, "")}`.slice(0, 200),
          detail: String(e?.stack ?? e).slice(0, 4000),
        }).catch(() => undefined);
      } finally { if (timer) clearTimeout(timer); }
      store.recordJourney({ session: id, persona: p.id, name: j.name, started: js, ok, error: err, steps: ctx.steps });
      results.push(`${j.name} ${ok ? "ok" : `FAIL (${err})`}`);
      if (ok) passed++; else failed++;
      if (ctx.rec.responses429 > 0) { restFleet(60_000, "the API answered 429"); break; }
      if (ctx.rec.apiFailures > 5) { health.until = 0; break; }
    }
    if (ctx.rec.responses429 > 0) {
      await ctx.rec.issue("rate-limited", "medium", `The API answered 429 to the fleet (${ctx.rec.responses429} times in one session)`, { key: "429", shot: false });
    }
  } catch (e: any) {
    error = String(e?.message ?? e).split("\n")[0];
    failed++;
  } finally {
    const mb = chromeMb();
    await ctx.close();
    store.endSession(id, { ok: failed === 0 && !error, passed, failed, error, chromeMb: mb });
    log(`[w${worker}] ${p.id} ${p.role}/${p.device.name}/${p.theme} ${((Date.now() - t0) / 1000).toFixed(0)}s ` +
      `${results.join(", ") || error || "nothing run"}; ${issues} issue sightings; chrome ${mb}MB` +
      `${ctx.wallet?.log.signed.length ? `; signed ${ctx.wallet.log.signed.map((s) => s.kind + (s.dry ? " (dry)" : "")).join(", ")}` : ""}`);
  }
}

async function launch(): Promise<Browser> {
  return chromium.launch({
    headless: config.headless,
    executablePath: config.chromePath,
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--mute-audio",
      "--disable-background-networking", "--disable-extensions", "--js-flags=--max-old-space-size=384"],
  });
}

async function worker(n: number) {
  // Staggered so two Chromes do not start and load at the same moment.
  await new Promise((r) => setTimeout(r, n * 7_000));
  let browser: Browser | null = null;
  let count = 0;
  let surveyedLast = false;
  while (!stopping) {
    if (config.runForMs && Date.now() - started > config.runForMs) break;
    if (!(await checkHealth())) {
      await new Promise((r) => setTimeout(r, Math.max(2_000, Math.min(30_000, health.until - Date.now()))));
      continue;
    }
    if (!browser || !browser.isConnected()) browser = await launch();
    // A survey chunk takes this worker's turn when one is due, but never two
    // turns running, so a single worker still alternates with journeys. A
    // deploy's smoke pass goes first whatever ran last; the other checks
    // (checks/index.ts) take turns as the survey does.
    let task = checks.urgent();
    if (!task && !surveyedLast && !(await survey.due())) task = checks.next();
    if (task) {
      log(`[w${n}] ${await checks.run(task, browser, n)}`);
      surveyedLast = task.kind === "check";
    } else if (!surveyedLast && await survey.due()) {
      log(`[w${n}] ${await survey.chunk(browser, () => stopping)}`);
      surveyedLast = true;
    } else {
      await session(browser, n, nextPersona());
      surveyedLast = false;
    }
    count++;
    if (count % config.recycleEvery === 0) {
      await browser.close().catch(() => undefined);
      browser = null;
    }
    if (count % 50 === 0) store.prune();
    const gap = config.gapMs + Math.random() * config.jitterMs;
    const until = Date.now() + gap;
    while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
  }
  await browser?.close().catch(() => undefined);
}

async function main() {
  store.open();
  loadKeys(); // fail now, not in the first session
  store.prune();
  log(`unwind testers: ${personas.length} personas, ${config.concurrency} at a time, against ${config.baseUrl}` +
    `${config.dryTx ? " (DRY_TX: signs, never sends)" : ""}`);
  const stop = (sig: string) => {
    if (stopping) { log("second signal, exiting now"); process.exit(1); }
    stopping = true;
    log(`${sig}: finishing the current steps`);
    // Anything still running after the grace period is cut off.
    setTimeout(() => process.exit(0), 45_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  // The API pinger and the deploy watcher: no browser.
  checks.start(() => stopping || (!!config.runForMs && Date.now() - started > config.runForMs));
  await Promise.all(Array.from({ length: config.concurrency }, (_, i) => worker(i + 1)));
  log("stopped");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
