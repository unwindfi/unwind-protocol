/*
 * The fleet's dashboard: what the testers found, and whether the fleet
 * itself is healthy. Reads the store the runner writes.
 *
 * Listens on 127.0.0.1:3100 (TESTERS_HOST, TESTERS_PORT) behind HTTP basic
 * auth (TESTERS_USER, TESTERS_PASS); it refuses to start without both. The
 * box's Caddy puts it under a path; every URL in the page is relative, so it
 * works under any prefix.
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

if (!config.dashUser || !config.dashPass) {
  console.error("Set TESTERS_USER and TESTERS_PASS: the dashboard does not run without a password.");
  process.exit(1);
}

const db = store.open();
const app = express();
app.disable("x-powered-by");

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
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

app.get("/api/summary", (_req, res) => {
  const since = Date.now() - DAY;
  const fresh = db.prepare(`SELECT sig, type, severity, route, message, count, first_seen, screenshot FROM issues
      WHERE first_seen > ? AND status != 'ignored'
      ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, count DESC LIMIT 10`).all(since);
  const total = db.prepare("SELECT COUNT(*) AS n FROM issues WHERE first_seen > ?").get(since) as { n: number };
  res.json({ since, total: total.n, top: fresh });
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
