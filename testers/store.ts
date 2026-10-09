/*
 * Where the fleet writes what it saw: one SQLite file under TESTERS_DATA,
 * screenshots beside it. The runner writes, the dashboard reads; WAL lets
 * both have it open at once.
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { config, paths } from "./config";

export type Severity = "high" | "medium" | "low";

export interface IssueInput {
  type: string;
  severity: Severity;
  route: string;
  message: string;
  detail?: string;
  persona: string;
  device: string;
  theme: string;
  step: string;
  /// Stable across occurrences: what the dashboard groups by.
  signature: string;
  build?: string;
}

export interface IssueRow {
  sig: string; type: string; severity: Severity; route: string; message: string; detail: string | null;
  first_seen: number; last_seen: number; count: number;
  personas: string; devices: string; themes: string; last_step: string;
  screenshot: string | null; status: "open" | "fixed" | "ignored"; status_at: number | null;
  status_build: string | null; first_build: string | null; last_build: string | null;
}

let db: Database.Database | null = null;

export function open(): Database.Database {
  if (db) return db;
  fs.mkdirSync(paths.shots, { recursive: true });
  db = new Database(paths.db);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      sig TEXT PRIMARY KEY, type TEXT, severity TEXT, route TEXT, message TEXT, detail TEXT,
      first_seen INTEGER, last_seen INTEGER, count INTEGER,
      personas TEXT, devices TEXT, themes TEXT, last_step TEXT,
      screenshot TEXT, status TEXT DEFAULT 'open', status_at INTEGER, status_build TEXT,
      first_build TEXT, last_build TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      t INTEGER, sig TEXT, persona TEXT, device TEXT, theme TEXT, step TEXT
    );
    CREATE INDEX IF NOT EXISTS events_t ON events(t);
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, persona TEXT, role TEXT, device TEXT, theme TEXT,
      started INTEGER, ended INTEGER, ok INTEGER, passed INTEGER, failed INTEGER,
      error TEXT, chrome_mb INTEGER, worker INTEGER, build TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started);
    CREATE TABLE IF NOT EXISTS journeys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session INTEGER, persona TEXT, name TEXT,
      started INTEGER, ms INTEGER, ok INTEGER, error TEXT, steps INTEGER
    );
    CREATE INDEX IF NOT EXISTS journeys_started ON journeys(started);
    CREATE TABLE IF NOT EXISTS txs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, persona TEXT, kind TEXT, status TEXT,
      ms INTEGER, message TEXT, sig TEXT
    );
    CREATE INDEX IF NOT EXISTS txs_t ON txs(t);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

export const now = () => Date.now();

function addTo(list: string, v: string, max = 12) {
  const xs: string[] = list ? JSON.parse(list) : [];
  if (!xs.includes(v)) xs.push(v);
  return JSON.stringify(xs.slice(-max));
}

/// Records one sighting. Returns whether a screenshot should be taken: the
/// first sighting of a signature, or the first after it was reopened.
export function recordIssue(i: IssueInput): { fresh: boolean; reopened: boolean } {
  const d = open();
  const t = now();
  const build = i.build ?? getMeta("build") ?? null;
  const row = d.prepare("SELECT * FROM issues WHERE sig = ?").get(i.signature) as IssueRow | undefined;
  d.prepare("INSERT INTO events (t, sig, persona, device, theme, step) VALUES (?,?,?,?,?,?)")
    .run(t, i.signature, i.persona, i.device, i.theme, i.step);
  if (!row) {
    d.prepare(`INSERT INTO issues (sig, type, severity, route, message, detail, first_seen, last_seen, count,
      personas, devices, themes, last_step, status, first_build, last_build)
      VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,'open',?,?)`)
      .run(i.signature, i.type, i.severity, i.route, i.message.slice(0, 2000), i.detail?.slice(0, 8000) ?? null,
        t, t, JSON.stringify([i.persona]), JSON.stringify([i.device]), JSON.stringify([i.theme]), i.step, build, build);
    return { fresh: true, reopened: false };
  }
  // Marked fixed: stays hidden while the same build is live, and comes back
  // once a new deploy still shows it. Ignored stays hidden for good.
  const reopen = row.status === "fixed" && build != null && row.status_build !== build;
  d.prepare(`UPDATE issues SET last_seen = ?, count = count + 1, personas = ?, devices = ?, themes = ?,
      last_step = ?, message = ?, detail = COALESCE(?, detail), last_build = ?,
      status = CASE WHEN ? THEN 'open' ELSE status END,
      status_at = CASE WHEN ? THEN ? ELSE status_at END
    WHERE sig = ?`)
    .run(t, addTo(row.personas, i.persona), addTo(row.devices, i.device), addTo(row.themes, i.theme),
      i.step, i.message.slice(0, 2000), i.detail?.slice(0, 8000) ?? null, build,
      reopen ? 1 : 0, reopen ? 1 : 0, t, i.signature);
  return { fresh: false, reopened: reopen };
}

export function setScreenshot(sig: string, file: string) {
  open().prepare("UPDATE issues SET screenshot = ? WHERE sig = ?").run(file, sig);
}

export function setStatus(sig: string, status: "open" | "fixed" | "ignored") {
  open().prepare("UPDATE issues SET status = ?, status_at = ?, status_build = ? WHERE sig = ?")
    .run(status, now(), getMeta("build") ?? null, sig);
}

export function getMeta(key: string): string | undefined {
  const r = open().prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value;
}
export function setMeta(key: string, value: string) {
  open().prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export function startSession(s: { persona: string; role: string; device: string; theme: string; worker: number }) {
  const r = open().prepare(`INSERT INTO sessions (persona, role, device, theme, started, worker, build)
    VALUES (?,?,?,?,?,?,?)`).run(s.persona, s.role, s.device, s.theme, now(), s.worker, getMeta("build") ?? null);
  return Number(r.lastInsertRowid);
}
export function endSession(id: number, s: { ok: boolean; passed: number; failed: number; error?: string; chromeMb?: number }) {
  open().prepare("UPDATE sessions SET ended = ?, ok = ?, passed = ?, failed = ?, error = ?, chrome_mb = ? WHERE id = ?")
    .run(now(), s.ok ? 1 : 0, s.passed, s.failed, s.error?.slice(0, 1000) ?? null, s.chromeMb ?? null, id);
}
export function recordJourney(j: { session: number; persona: string; name: string; started: number; ok: boolean; error?: string; steps: number }) {
  open().prepare("INSERT INTO journeys (session, persona, name, started, ms, ok, error, steps) VALUES (?,?,?,?,?,?,?,?)")
    .run(j.session, j.persona, j.name, j.started, now() - j.started, j.ok ? 1 : 0, j.error?.slice(0, 1000) ?? null, j.steps);
}
export function recordTx(t: { persona: string; kind: string; status: string; ms?: number; message?: string; sig?: string }) {
  open().prepare("INSERT INTO txs (t, persona, kind, status, ms, message, sig) VALUES (?,?,?,?,?,?,?)")
    .run(now(), t.persona, t.kind, t.status, t.ms ?? null, t.message?.slice(0, 500) ?? null, t.sig ?? null);
}
/// The last transaction any persona (or this one) put up for signing, so the
/// rate limits survive a restart.
export function lastTxAt(persona?: string): number {
  const d = open();
  const r = (persona
    ? d.prepare("SELECT MAX(t) AS t FROM txs WHERE persona = ? AND status = 'requested'").get(persona)
    : d.prepare("SELECT MAX(t) AS t FROM txs WHERE status = 'requested'").get()) as { t: number | null };
  return r?.t ?? 0;
}
export function countTx(kind: string, sinceMs: number): number {
  const r = open().prepare("SELECT COUNT(*) AS n FROM txs WHERE kind = ? AND t > ? AND status IN ('sent','confirmed','failed','timeout')")
    .get(kind, now() - sinceMs) as { n: number };
  return r.n;
}

/// Old rows go, so the file stays small on a box that runs for months.
export function prune(days = 21) {
  const cut = now() - days * 86_400_000;
  const d = open();
  d.prepare("DELETE FROM events WHERE t < ?").run(cut);
  d.prepare("DELETE FROM journeys WHERE started < ?").run(cut);
  d.prepare("DELETE FROM sessions WHERE started < ?").run(cut);
  d.prepare("DELETE FROM txs WHERE t < ?").run(cut);
  // Screenshots of issues nobody has seen in the window.
  const stale = d.prepare("SELECT sig, screenshot FROM issues WHERE last_seen < ? AND screenshot IS NOT NULL").all(cut) as { sig: string; screenshot: string }[];
  for (const s of stale) {
    try { fs.unlinkSync(path.join(paths.shots, s.screenshot)); } catch { /* already gone */ }
    d.prepare("UPDATE issues SET screenshot = NULL WHERE sig = ?").run(s.sig);
  }
}

export const dataDir = () => config.dataDir;
