/*
 * The fleet's dashboard: what the testers found, and whether the fleet
 * itself is healthy. Reads the store the runner writes.
 *
 * Listens on 127.0.0.1:3100 (TESTERS_HOST, TESTERS_PORT) behind HTTP basic
 * auth (TESTERS_USER, TESTERS_PASS); it refuses to start without both. The
 * box's Caddy puts it under a path; every URL in the page is relative, so it
 * works under any prefix. The review feed (/api/review) is the one
 * exception to the password: it answers to a bearer token (REVIEW_TOKEN).
 *
 *   npx ts-node --transpile-only -P testers/tsconfig.json testers/dashboard.ts
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import express from "express";
import { config, paths } from "./config";
import { PERSONAS } from "./personas";
import * as store from "./store";
import * as apiHealth from "./checks/api-health";

if (!config.dashUser || !config.dashPass) {
  console.error("Set TESTERS_USER and TESTERS_PASS: the dashboard does not run without a password.");
  process.exit(1);
}

if (config.reviewToken.length < 32) {
  console.warn("REVIEW_TOKEN is unset or shorter than 32 characters: /api/review refuses every request.");
}

const db = store.open();
const app = express();
app.disable("x-powered-by");

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/*
 * The review feed: read-only, for a scheduled reviewer that has HTTPS and a
 * bearer token (REVIEW_TOKEN) but never the dashboard password. Mounted
 * before basic auth, so /api/review and /api/review/shot/* answer to the
 * token alone; every other path still needs the password.
 */
const REVIEW_PAGES = 40, REVIEW_ISSUES = 60;
const digest = (s: string) => crypto.createHash("sha256").update(s).digest();
const review = express.Router();
review.use((req, res, next) => {
  const h = req.headers.authorization ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  // Hashed first, so the compare is constant time whatever the lengths.
  const ok = config.reviewToken.length >= 32 && token.length > 0
    && crypto.timingSafeEqual(digest(token), digest(config.reviewToken));
  if (!ok) return res.set("WWW-Authenticate", 'Bearer realm="unwind testers review"').status(401).json({ error: "unauthorized" });
  res.set("Cache-Control", "no-store");
  next();
});

/// Absolute links when the request came through Caddy, else from the root.
const base = (req: express.Request) => {
  const host = req.get("x-forwarded-host");
  if (!host) return "";
  const proto = req.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host.split(",")[0].trim()}${config.reviewPrefix}`;
};

review.get("/", (req, res) => {
  const now = Date.now();
  const raw = Number(req.query.since);
  const since = Number.isFinite(raw) && raw >= 0 ? raw : now - 2 * HOUR;
  const b = base(req);
  const shot = (p: string | null, v?: number) => (p ? `${b}/api/review/shot/${p}${v ? `?v=${v}` : ""}` : null);

  const issues = db.prepare(`SELECT * FROM issues WHERE status = 'open' AND (first_seen > ? OR last_seen > ?)
      ORDER BY last_seen DESC LIMIT ?`).all(since, since, REVIEW_ISSUES + 1) as store.IssueRow[];
  const pages = db.prepare(`SELECT * FROM survey WHERE changed_at > ? ORDER BY changed_at DESC LIMIT ?`)
    .all(since, REVIEW_PAGES + 1) as store.SurveyRow[];
  const txFailures = db.prepare(`SELECT kind, status, message, COUNT(*) AS count, MAX(t) AS last FROM txs
      WHERE t > ? AND status IN ('failed', 'timeout') GROUP BY kind, status, message ORDER BY count DESC LIMIT 50`).all(since);

  res.json({
    now, since, build: store.getMeta("build") ?? null,
    truncated: issues.length > REVIEW_ISSUES || pages.length > REVIEW_PAGES,
    issues: issues.slice(0, REVIEW_ISSUES).map((r) => ({
      sig: r.sig, type: r.type, severity: r.severity, route: r.route, message: r.message,
      detail: r.detail ? r.detail.slice(0, 600) : null, count: r.count, personas: parse(r.personas).length,
      first_seen: r.first_seen, last_seen: r.last_seen, last_build: r.last_build,
      shot: r.screenshot ? shot(`shots/${r.screenshot}`) : null,
    })),
    pages: pages.slice(0, REVIEW_PAGES).map((p) => ({
      route: p.route, theme: p.theme, device: p.device, changed_at: p.changed_at, captured_at: p.captured_at,
      build: p.build, error: p.error, snapshot: p.snapshot, console: parse(p.console), shot: shot(p.shot_path, p.captured_at),
    })),
    txFailures,
  });
});

/// Only files the fleet wrote: a plain name under survey/ or shots/.
review.get("/shot/:dir/:file", (req, res) => {
  const { dir, file } = req.params as { dir: string; file: string };
  const root = dir === "survey" ? paths.survey : dir === "shots" ? paths.shots : null;
  if (!root || !/^[A-Za-z0-9][A-Za-z0-9_-]*\.jpg$/.test(file)) return res.status(404).end();
  const full = path.resolve(root, file);
  if (path.dirname(full) !== path.resolve(root)) return res.status(404).end();
  res.sendFile(full, { dotfiles: "deny" }, (e) => { if (e && !res.headersSent) res.status(404).end(); });
});
review.use((_req, res) => { res.status(404).json({ error: "not found" }); });
app.use("/api/review", review);

app.use((req, res, next) => {
  const h = req.headers.authorization ?? "";
  const [user, pass] = Buffer.from(h.replace(/^Basic /, ""), "base64").toString().split(/:(.*)/s);
  if (h.startsWith("Basic ") && same(user ?? "", config.dashUser) && same(pass ?? "", config.dashPass)) return next();
  res.set("WWW-Authenticate", 'Basic realm="unwind testers"').status(401).send("Sign in to see the testers.");
});
app.use(express.json());

const HOUR = 3_600_000, DAY = 24 * HOUR;
const parse = (s: string | null) => { try { return JSON.parse(s ?? "[]"); } catch { return []; } };

app.get("/api/issues", (req, res) => {
  const status = String(req.query.status ?? "open");
  const rows = (status === "all"
    ? db.prepare("SELECT * FROM issues ORDER BY last_seen DESC LIMIT 1000").all()
    : db.prepare("SELECT * FROM issues WHERE status = ? ORDER BY last_seen DESC LIMIT 1000").all(status)) as store.IssueRow[];
  const recent = db.prepare("SELECT sig, COUNT(*) AS n FROM events WHERE t > ? GROUP BY sig").all(Date.now() - DAY) as { sig: string; n: number }[];
  const day = new Map(recent.map((r) => [r.sig, r.n]));
  res.json(rows.map((r) => ({
    ...r, personas: parse(r.personas), devices: parse(r.devices), themes: parse(r.themes), day: day.get(r.sig) ?? 0,
  })));
});

app.get("/api/issue/:sig", (req, res) => {
  const row = db.prepare("SELECT * FROM issues WHERE sig = ?").get(req.params.sig);
  if (!row) return res.status(404).json({ error: "no such issue" });
  const events = db.prepare("SELECT * FROM events WHERE sig = ? ORDER BY t DESC LIMIT 30").all(req.params.sig);
  res.json({ ...row, events });
});

app.post("/api/issues/:sig/status", (req, res) => {
  const s = String(req.body?.status);
  if (!["open", "fixed", "ignored"].includes(s)) return res.status(400).json({ error: "status is open, fixed or ignored" });
  store.setStatus(req.params.sig, s as "open" | "fixed" | "ignored");
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => {
  const now = Date.now();
  const since = now - DAY;
  const hours = db.prepare(`SELECT CAST((started - ?) / ${HOUR} AS INTEGER) AS h, COUNT(*) AS n,
      SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok FROM sessions WHERE started > ? GROUP BY h`).all(since, since) as { h: number; n: number; ok: number }[];
  const perHour = Array.from({ length: 24 }, (_, i) => {
    const r = hours.find((x) => x.h === i);
    return { at: since + i * HOUR, n: r?.n ?? 0, ok: r?.ok ?? 0 };
  });
  const journeys = db.prepare(`SELECT name, COUNT(*) AS n, SUM(ok) AS ok, AVG(ms) AS ms FROM journeys
      WHERE started > ? GROUP BY name ORDER BY name`).all(since);
  const failures = db.prepare(`SELECT name, error, COUNT(*) AS n FROM journeys WHERE started > ? AND ok = 0
      GROUP BY name, error ORDER BY n DESC LIMIT 8`).all(since);
  const txs = db.prepare("SELECT kind, status, COUNT(*) AS n FROM txs WHERE t > ? GROUP BY kind, status").all(since) as { kind: string; status: string; n: number }[];
  const done = txs.filter((t) => ["confirmed", "failed", "timeout"].includes(t.status));
  const confirmed = done.filter((t) => t.status === "confirmed").reduce((s, t) => s + t.n, 0);
  const settled = done.reduce((s, t) => s + t.n, 0);
  const last = db.prepare(`SELECT persona, MAX(started) AS started, ok, passed, failed, chrome_mb FROM sessions GROUP BY persona`).all() as
    { persona: string; started: number; ok: number; passed: number; failed: number; chrome_mb: number }[];
  const counts = db.prepare("SELECT persona, COUNT(*) AS n FROM sessions WHERE started > ? GROUP BY persona").all(since) as { persona: string; n: number }[];
  const personas = PERSONAS.map((p) => {
    const l = last.find((x) => x.persona === p.id);
    return {
      id: p.id, name: p.name, role: p.role, device: p.device.name, theme: p.theme,
      last: l?.started ?? null, ok: l ? !!l.ok : null, sessions: counts.find((c) => c.persona === p.id)?.n ?? 0,
    };
  });
  const open = db.prepare("SELECT severity, COUNT(*) AS n FROM issues WHERE status = 'open' GROUP BY severity").all() as { severity: string; n: number }[];
  const mem = db.prepare("SELECT AVG(chrome_mb) AS avg, MAX(chrome_mb) AS max FROM sessions WHERE started > ? AND chrome_mb > 0").get(now - 6 * HOUR) as { avg: number | null; max: number | null };
  const lastSession = db.prepare("SELECT MAX(ended) AS t FROM sessions").get() as { t: number | null };
  res.json({
    now, build: store.getMeta("build") ?? null, perHour, journeys, failures,
    txs, txRate: settled ? confirmed / settled : null, txSettled: settled,
    dryRuns: txs.filter((t) => t.status === "dry-run").reduce((s, t) => s + t.n, 0),
    personas, open, mem, lastSession: lastSession.t,
    lastHour: perHour.slice(-1)[0]?.n ?? 0,
  });
});

/// The API pinger's view (checks/api-health.ts): each route's state, its
/// pings over `hours` (24 by default, at most 72), and the recent deploys.
app.get("/api/api-health", (req, res) => {
  const h = Math.min(72, Math.max(1, Number(req.query.hours) || 24));
  res.set("Cache-Control", "no-store").json(apiHealth.summary(h));
});

app.get("/api/summary", (_req, res) => {
  const since = Date.now() - DAY;
  const fresh = db.prepare(`SELECT sig, type, severity, route, message, count, first_seen, screenshot FROM issues
      WHERE first_seen > ? AND status != 'ignored'
      ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, count DESC LIMIT 10`).all(since);
  const total = db.prepare("SELECT COUNT(*) AS n FROM issues WHERE first_seen > ?").get(since) as { n: number };
  res.json({ since, total: total.n, top: fresh });
});

// ------------------------------------------------------------ charts

const SEVERITIES = ["high", "medium", "low"] as const;
type Settled = "confirmed" | "failed" | "timeout";

/// The value at fraction `q` of an ascending list (nearest rank), or null.
const quantile = (xs: number[], q: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1))] : null);
const ratio = (ok: number, n: number) => (n ? ok / n : null);
const push = (m: Map<number, number[]>, k: number, v: number) => { const xs = m.get(k); if (xs) xs.push(v); else m.set(k, [v]); };

app.get("/api/timeseries", (req, res) => {
  const raw = Number(req.query.hours);
  const hours = Math.min(168, Math.max(1, Number.isFinite(raw) ? Math.round(raw) : 48));
  // The last bucket is the hour now is in; it ends at the top of the next hour.
  const end = Math.floor(Date.now() / HOUR) * HOUR + HOUR, start = end - hours * HOUR;
  const b = (col: string) => `CAST((${col} - ${start}) / ${HOUR} AS INTEGER)`;

  const buckets = Array.from({ length: hours }, (_, i) => ({
    at: start + i * HOUR,
    sessions: { ok: 0, failed: 0, running: 0, cut: 0 },
    journeys: {} as Record<string, { ok: number; failed: number }>,
    txs: {} as Record<string, Record<Settled, number>>,
    issues: { high: 0, medium: 0, low: 0 } as Record<string, number>,
    journeyMs: { p50: null as number | null, p90: null as number | null, n: 0 },
    stepMs: { p50: null as number | null, p90: null as number | null },
    orderMs: { p50: null as number | null, p90: null as number | null, n: 0 },
    chromeMb: null as number | null,
    survey: { captured: 0, changed: 0 },
  }));
  const at = (h: number) => (h >= 0 && h < hours ? buckets[h] : null);

  // Never ended: still running when started within the runner's cutoff, else cut short by a restart.
  const live = Date.now() - config.sessionTimeoutMs - 60_000;
  const sessions = db.prepare(`SELECT ${b("started")} AS h, SUM(ok = 1) AS ok, SUM(ended IS NOT NULL AND ok = 0) AS failed,
      SUM(ended IS NULL AND started > ?) AS running, SUM(ended IS NULL AND started <= ?) AS cut,
      AVG(CASE WHEN chrome_mb > 0 THEN chrome_mb END) AS mb
      FROM sessions WHERE started >= ? GROUP BY h`).all(live, live, start) as { h: number; ok: number; failed: number; running: number; cut: number; mb: number | null }[];
  for (const r of sessions) {
    const x = at(r.h); if (!x) continue;
    x.sessions = { ok: r.ok ?? 0, failed: r.failed ?? 0, running: r.running ?? 0, cut: r.cut ?? 0 };
    x.chromeMb = r.mb == null ? null : Math.round(r.mb);
  }

  const journeys = db.prepare(`SELECT ${b("started")} AS h, name, SUM(ok = 1) AS ok, SUM(ok = 0) AS failed
      FROM journeys WHERE started >= ? GROUP BY h, name`).all(start) as { h: number; name: string; ok: number; failed: number }[];
  for (const r of journeys) { const x = at(r.h); if (x) x.journeys[r.name] = { ok: r.ok, failed: r.failed }; }

  // Percentiles need the raw values: two integers a row, a few thousand a day.
  const times = db.prepare(`SELECT ${b("started")} AS h, ms, steps FROM journeys WHERE started >= ? AND ms > 0`)
    .all(start) as { h: number; ms: number; steps: number | null }[];
  const perJourney = new Map<number, number[]>(), perStep = new Map<number, number[]>();
  for (const r of times) {
    push(perJourney, r.h, r.ms);
    if (r.steps && r.steps > 0) push(perStep, r.h, r.ms / r.steps);
  }
  const round = (v: number | null) => (v == null ? null : Math.round(v));
  for (const [h, xs] of perJourney) {
    const x = at(h); if (!x) continue;
    xs.sort((p, q) => p - q);
    x.journeyMs = { p50: quantile(xs, 0.5), p90: quantile(xs, 0.9), n: xs.length };
  }
  for (const [h, xs] of perStep) {
    const x = at(h); if (!x) continue;
    xs.sort((p, q) => p - q);
    x.stepMs = { p50: round(quantile(xs, 0.5)), p90: round(quantile(xs, 0.9)) };
  }

  const txs = db.prepare(`SELECT ${b("t")} AS h, kind, status, COUNT(*) AS n FROM txs
      WHERE t >= ? AND status IN ('confirmed', 'failed', 'timeout') GROUP BY h, kind, status`).all(start) as { h: number; kind: string; status: Settled; n: number }[];
  for (const r of txs) {
    const x = at(r.h); if (!x) continue;
    (x.txs[r.kind] ??= { confirmed: 0, failed: 0, timeout: 0 })[r.status] = r.n;
  }
  const orders = db.prepare(`SELECT ${b("t")} AS h, ms FROM txs WHERE t >= ? AND kind = 'order' AND status = 'confirmed' AND ms > 0`)
    .all(start) as { h: number; ms: number }[];
  const perOrder = new Map<number, number[]>();
  for (const r of orders) push(perOrder, r.h, r.ms);
  for (const [h, xs] of perOrder) {
    const x = at(h); if (!x) continue;
    xs.sort((p, q) => p - q);
    x.orderMs = { p50: quantile(xs, 0.5), p90: quantile(xs, 0.9), n: xs.length };
  }

  const issues = db.prepare(`SELECT ${b("first_seen")} AS h, severity, COUNT(*) AS n FROM issues WHERE first_seen >= ? GROUP BY h, severity`)
    .all(start) as { h: number; severity: string; n: number }[];
  for (const r of issues) { const x = at(r.h); if (x) x.issues[r.severity] = r.n; }

  // The survey keeps only the latest capture of each page, so an hour whose
  // captures were since replaced reads as zero.
  for (const [col, key] of [["captured_at", "captured"], ["changed_at", "changed"]] as const) {
    const rows = db.prepare(`SELECT ${b(col)} AS h, COUNT(*) AS n FROM survey WHERE ${col} >= ? GROUP BY h`).all(start) as { h: number; n: number }[];
    for (const r of rows) { const x = at(r.h); if (x) x.survey[key] = r.n; }
  }

  // Range-wide figures from every value, not a median of hourly medians.
  const allOrders = orders.map((o) => o.ms).sort((p, q) => p - q);
  const allSteps = [...perStep.values()].flat().sort((p, q) => p - q);
  res.set("Cache-Control", "no-store").json({
    now: Date.now(), start, end, hours, bucketMs: HOUR,
    names: [...new Set(journeys.map((r) => r.name))].sort(),
    kinds: [...new Set(txs.map((r) => r.kind))].sort(),
    orderMs: { p50: quantile(allOrders, 0.5), p90: quantile(allOrders, 0.9), n: allOrders.length },
    stepMs: { p50: round(quantile(allSteps, 0.5)), p90: round(quantile(allSteps, 0.9)) },
    buckets,
  });
});

/// Success rates over one window: sessions that ended, journeys, settled transactions.
function rates(since: number) {
  const s = db.prepare("SELECT SUM(ok = 1) AS ok, COUNT(*) AS n FROM sessions WHERE started > ? AND ended IS NOT NULL").get(since) as { ok: number | null; n: number };
  const j = db.prepare("SELECT SUM(ok = 1) AS ok, COUNT(*) AS n FROM journeys WHERE started > ?").get(since) as { ok: number | null; n: number };
  const t = db.prepare(`SELECT SUM(status = 'confirmed') AS ok, SUM(status = 'failed') AS failed, SUM(status = 'timeout') AS timeout, COUNT(*) AS n
      FROM txs WHERE t > ? AND status IN ('confirmed', 'failed', 'timeout')`).get(since) as { ok: number | null; failed: number | null; timeout: number | null; n: number };
  return {
    sessions: { n: s.n, ok: s.ok ?? 0, rate: ratio(s.ok ?? 0, s.n) },
    journeys: { n: j.n, ok: j.ok ?? 0, rate: ratio(j.ok ?? 0, j.n) },
    txs: { n: t.n, ok: t.ok ?? 0, failed: t.failed ?? 0, timeout: t.timeout ?? 0, rate: ratio(t.ok ?? 0, t.n) },
  };
}

/*
 * One grade for the whole picture. Down: the fleet went quiet, or most
 * sessions in the last hour failed. Degraded: a rate in the last hour past
 * its line, with enough runs to mean something, or a new high issue.
 */
function grade(idleMin: number | null, hour: ReturnType<typeof rates>, newHigh: number) {
  const down: string[] = [], degraded: string[] = [];
  const share = (x: number) => `${Math.round(x * 100)}%`;
  if (idleMin == null) down.push("no fleet activity recorded");
  else if (idleMin > config.fleetDownMin) down.push(`no fleet activity for ${Math.round(idleMin)} min`);
  const sFail = 1 - (hour.sessions.rate ?? 1), jFail = 1 - (hour.journeys.rate ?? 1), tFail = 1 - (hour.txs.rate ?? 1);
  if (hour.sessions.n >= 4 && sFail >= 0.5) down.push(`session failure ${share(sFail)} in the last hour`);
  else if (hour.sessions.n >= 4 && sFail > 0.1) degraded.push(`session failure ${share(sFail)} in the last hour`);
  if (hour.txs.n >= 5 && tFail > 0.1) degraded.push(`tx failure ${share(tFail)} in the last hour`);
  if (hour.journeys.n >= 10 && jFail > 0.15) degraded.push(`journey failure ${share(jFail)} in the last hour`);
  if (newHigh > 0) degraded.push(`${newHigh} new high ${newHigh === 1 ? "issue" : "issues"} in the last hour`);
  if (down.length) return { grade: "Down" as const, reason: down[0], reasons: [...down, ...degraded] };
  if (degraded.length) return { grade: "Degraded" as const, reason: degraded[0], reasons: degraded };
  return { grade: "Healthy" as const, reason: "every rate in the last hour is within its line", reasons: [] as string[] };
}

app.get("/api/status", (_req, res) => {
  const now = Date.now();
  // Each MAX walks an index, or the last day of one, never a whole table.
  const one = (sql: string, ...args: number[]) => (db.prepare(sql).get(...args) as { t: number | null }).t ?? 0;
  const last = Math.max(
    one("SELECT MAX(started) AS t FROM sessions"),
    one("SELECT MAX(ended) AS t FROM sessions WHERE started > ?", now - DAY),
    one("SELECT MAX(t) AS t FROM txs"),
    one("SELECT MAX(started + ms) AS t FROM journeys WHERE started > ?", now - DAY),
  ) || null;
  const idleMin = last == null ? null : Math.max(0, (now - last) / 60_000);
  // A session still open past the runner's own cutoff was cut short by a restart, not running.
  const active = db.prepare("SELECT COUNT(DISTINCT worker) AS n FROM sessions WHERE ended IS NULL AND started > ?")
    .get(now - config.sessionTimeoutMs - 60_000) as { n: number };
  const hour = rates(now - HOUR), day = rates(now - DAY);
  const open = db.prepare("SELECT severity, COUNT(*) AS n FROM issues WHERE status = 'open' GROUP BY severity").all() as { severity: string; n: number }[];
  const newHigh = (db.prepare("SELECT COUNT(*) AS n FROM issues WHERE first_seen > ? AND severity = 'high' AND status != 'ignored'").get(now - HOUR) as { n: number }).n;
  const failingJourneys = db.prepare(`SELECT name, COUNT(*) AS n, SUM(ok = 0) AS failed FROM journeys WHERE started > ?
      GROUP BY name HAVING failed > 0 ORDER BY failed DESC, n DESC LIMIT 5`).all(now - DAY) as { name: string; n: number; failed: number }[];
  // Journey errors read "<step>: <what went wrong>".
  const failingSteps = db.prepare(`SELECT name, CASE WHEN instr(error, ': ') > 0 THEN substr(error, 1, instr(error, ': ') - 1) ELSE '' END AS step,
      COUNT(*) AS n, MAX(error) AS example FROM journeys WHERE started > ? AND ok = 0
      GROUP BY name, step ORDER BY n DESC LIMIT 5`).all(now - DAY);
  res.set("Cache-Control", "no-store").json({
    now, build: store.getMeta("build") ?? null,
    fleet: {
      up: idleMin != null && idleMin <= config.fleetDownMin, downAfterMin: config.fleetDownMin,
      lastActivity: last, minutesSince: idleMin == null ? null : Math.round(idleMin * 10) / 10,
      activeWorkers: active.n, concurrency: config.concurrency,
    },
    hour, day,
    open: Object.fromEntries(SEVERITIES.map((s) => [s, open.find((o) => o.severity === s)?.n ?? 0])),
    failingJourneys: failingJourneys.map((j) => ({ ...j, rate: ratio(j.failed, j.n) })),
    failingSteps,
    ...grade(idleMin, hour, newHigh),
  });
});

app.get("/api/activity", (req, res) => {
  const raw = Number(req.query.limit);
  const limit = Math.min(200, Math.max(1, Number.isFinite(raw) ? Math.round(raw) : 50));
  const since = Date.now() - 7 * DAY;
  const names = new Map(PERSONAS.map((p) => [p.id, p.name]));
  const journeys = db.prepare(`SELECT persona, name, ok, ms, error, started + COALESCE(ms, 0) AS t FROM journeys
      WHERE started > ? ORDER BY started DESC LIMIT ?`).all(since, limit) as { persona: string; name: string; ok: number; ms: number | null; error: string | null; t: number }[];
  // A "requested" row is always followed by its outcome; showing both doubles the feed.
  const txs = db.prepare(`SELECT persona, kind, status, ms, message, t FROM txs WHERE t > ? AND status != 'requested'
      ORDER BY t DESC LIMIT ?`).all(since, limit) as { persona: string; kind: string; status: string; ms: number | null; message: string | null; t: number }[];
  const issues = db.prepare(`SELECT sig, type, severity, route, message, personas, first_seen AS t FROM issues
      WHERE first_seen > ? ORDER BY first_seen DESC LIMIT ?`).all(since, limit) as { sig: string; type: string; severity: string; route: string; message: string; personas: string; t: number }[];
  const items = [
    ...journeys.map((j) => ({ type: "journey", t: j.t, persona: j.persona, personaName: names.get(j.persona) ?? null,
      action: j.name, ok: !!j.ok, result: j.ok ? "ok" : "failed", ms: j.ms, message: j.error })),
    ...txs.map((x) => ({ type: "tx", t: x.t, persona: x.persona, personaName: names.get(x.persona) ?? null,
      action: x.kind, ok: x.status === "confirmed", result: x.status, ms: x.ms, message: x.message })),
    ...issues.map((i) => {
      const who: string | null = parse(i.personas)[0] ?? null;
      return { type: "issue", t: i.t, persona: who, personaName: who ? names.get(who) ?? null : null,
        action: `${i.type} on ${i.route}`, ok: false, result: i.severity, ms: null, message: i.message.slice(0, 300), sig: i.sig };
    }),
  ].sort((a, b) => b.t - a.t).slice(0, limit);
  res.set("Cache-Control", "no-store").json({ now: Date.now(), items });
});

app.get("/api/survey", (_req, res) => {
  const rows = db.prepare(`SELECT route, theme, device, shot_path, captured_at, changed_at, build, error FROM survey
      ORDER BY captured_at DESC LIMIT 80`).all() as Pick<store.SurveyRow, "route" | "theme" | "device" | "shot_path" | "captured_at" | "changed_at" | "build" | "error">[];
  res.set("Cache-Control", "no-store").json({
    now: Date.now(), lastRun: Number(store.getMeta("survey_last") ?? 0) || null,
    // changed_at moves to captured_at only when the page moved on that capture.
    pages: rows.map((r) => ({ ...r, changed: r.changed_at === r.captured_at })),
  });
});

// Survey captures: only the plain names the survey writes.
app.get("/survey/:file", (req, res) => {
  const f = req.params.file;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.jpg$/.test(f)) return res.status(404).end();
  res.set("Cache-Control", "private, max-age=300");
  res.sendFile(path.join(paths.survey, f), { dotfiles: "deny" }, (e) => { if (e && !res.headersSent) res.status(404).end(); });
});

// Screenshots: only names the store wrote (hex, a dash, a time).
app.get("/shots/:file", (req, res) => {
  const f = req.params.file;
  if (!/^[0-9a-f]{16}-\d+\.jpg$/.test(f)) return res.status(404).end();
  res.set("Cache-Control", "private, max-age=86400");
  res.sendFile(path.join(paths.shots, f), (e) => { if (e && !res.headersSent) res.status(404).end(); });
});

// Inter, from the repo's own copy of the font.
const fonts = path.resolve(__dirname, "../node_modules/@fontsource/inter/files");
app.use("/fonts", express.static(fonts, { maxAge: "30d" }));

const page = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8");
app.get("/", (_req, res) => { res.set("Cache-Control", "no-store").type("html").send(page); });

app.listen(config.dashPort, config.dashHost, () => {
  console.log(`testers dashboard on http://${config.dashHost}:${config.dashPort}`);
});
