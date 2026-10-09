/*
 * Every API route the site reads, plus the site's root, once every
 * API_HEALTH_EVERY_SEC (five minutes), from the fleet's own process with no
 * browser: one request at a time, a few dozen kilobytes in all.
 *
 * Each answer goes in api_checks (status and time to the end of the body).
 * A route that answers 4xx or 5xx, takes longer than API_SLOW_MS, or answers
 * 200 with an `error` field or a body that is not JSON, gets one
 * high-severity issue for as long as it stays that way, with the body's
 * first line (so "Cannot read properties of undefined" from a stale IDL
 * shows on the first ping after it starts). When it answers well again the
 * issue is marked fixed; a relapse reopens it.
 */
import { config } from "../config";
import { keyOf, PERSONAS } from "../personas";
import * as store from "../store";
import { db, fileIssue, pause, sigOf, timed } from "./common";

interface Probe { route: string; url: string; json: boolean; image?: boolean }

/// A wallet to ask about: a persona's, or a known address when the keys are
/// not on this box.
function owner(): string {
  try { return keyOf(PERSONAS[0]).publicKey.toBase58(); } catch { return "So11111111111111111111111111111111111111112"; }
}

let icon: string | null = null;
let sym = "SOL";

function probes(): Probe[] {
  const a = config.checksApiUrl;
  const o = owner();
  const out: Probe[] = [
    { route: "/api/markets", url: `${a}/api/markets`, json: true },
    { route: "/api/markets?all=1", url: `${a}/api/markets?all=1`, json: true },
    { route: "/api/rewards?owner=", url: `${a}/api/rewards?owner=${o}`, json: true },
    { route: "/api/leaderboard", url: `${a}/api/leaderboard`, json: true },
    { route: "/api/creators", url: `${a}/api/creators`, json: true },
    { route: "/api/backings", url: `${a}/api/backings?owner=${o}`, json: true },
    { route: "/api/apy", url: `${a}/api/apy`, json: true },
    { route: "/api/account?owner=", url: `${a}/api/account?owner=${o}`, json: true },
    { route: "/api/batch/:sym", url: `${a}/api/batch/${sym}`, json: true },
    { route: "/api/trades/:sym", url: `${a}/api/trades/${sym}`, json: true },
    { route: "/api/candles/:sym", url: `${a}/api/candles/${sym}?tf=60`, json: true },
    { route: "/api/fills", url: `${a}/api/fills?owner=${o}`, json: true },
    { route: "/api/wallets", url: `${a}/api/wallets`, json: true },
    { route: "/api/testnet-pools", url: `${a}/api/testnet-pools`, json: true },
    { route: "site /", url: `${config.baseUrl}/`, json: false },
  ];
  if (icon) out.push({ route: "/api/icon/:mint", url: `${a}${icon}`, json: false, image: true });
  return out;
}

/// What is wrong with one answer, or "" when nothing is.
function verdict(p: Probe, r: Awaited<ReturnType<typeof timed>>): string {
  const first = (r.text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  if (r.status === 0) return r.error ?? "no answer";
  if (r.status >= 400) return `answered ${r.status}${first ? `: ${first}` : ""}`;
  if (p.json) {
    try {
      const j = JSON.parse(r.text);
      if (j && typeof j === "object" && !Array.isArray(j) && typeof j.error === "string") return `answered ${r.status} with error: ${j.error.slice(0, 200)}`;
    } catch { return `answered ${r.status} with a body that is not JSON: ${first.slice(0, 120)}`; }
  }
  if (p.image && !/^image\//.test(r.type)) return `answered ${r.status} as ${r.type || "no type"}, not an image`;
  if (!p.json && !p.image && !r.text.includes('id="root"')) return `answered ${r.status} without the app's root element`;
  if (r.ms > config.apiSlowMs) return `took ${(r.ms / 1000).toFixed(1)}s (over ${config.apiSlowMs / 1000}s)`;
  return "";
}

interface State { route: string; ok: number; since: number; sig: string | null }

/// One pass over every route. Returns how many failed.
export async function ping(): Promise<{ failed: number; total: number; down: boolean }> {
  const d = db();
  let failed = 0, unreachable = 0;
  if (!icon) {
    // The first pass needs a mint for the icon route.
    try {
      const ms = JSON.parse((await timed(`${config.checksApiUrl}/api/markets`, { accept: "application/json" })).text) as { icon?: string | null }[];
      icon = ms.find((m) => m.icon?.startsWith("/api/icon/"))?.icon ?? null;
    } catch { /* the pass below says why */ }
  }
  const list = probes();
  for (const p of list) {
    const r = await timed(p.url, { accept: p.json ? "application/json" : "*/*", ms: config.apiTimeoutMs });
    const why = verdict(p, r);
    const t = Date.now();
    d.prepare("INSERT INTO api_checks (t, route, status, ms, ok, error) VALUES (?,?,?,?,?,?)")
      .run(t, p.route, r.status, r.ms, why ? 0 : 1, why || null);
    if (p.route === "/api/markets" && !why) {
      // The icon and the market to ask about, for the next pass.
      try {
        const ms = JSON.parse(r.text) as { symbol: string; icon?: string | null; hidden?: boolean }[];
        icon = ms.find((m) => m.icon?.startsWith("/api/icon/"))?.icon ?? icon;
        sym = ms.find((m) => m.symbol === "SOL" && !m.hidden)?.symbol ?? ms.find((m) => !m.hidden)?.symbol ?? sym;
      } catch { /* checked above */ }
    }
    const prev = d.prepare("SELECT * FROM api_routes WHERE route = ?").get(p.route) as State | undefined;
    const sig = sigOf("api-health", p.route, `api ${p.route}`);
    if (why) {
      failed++;
      if (r.status === 0 || r.status === 502 || r.status === 503) unreachable++;
      const since = prev && !prev.ok ? prev.since : t;
      await fileIssue({
        type: "api-health", severity: "high", route: p.route,
        message: `${p.route} ${why}${since < t ? ` (failing since ${new Date(since).toISOString().slice(11, 16)} UTC)` : ""}`,
        key: `api ${p.route}`, detail: `${p.url.replace(/owner=[^&]+/, "owner=<persona>")}\n${r.text.slice(0, 2000)}`,
        step: "api health",
      });
      // Marked fixed by an earlier recovery, on this same build: open again.
      const row = d.prepare("SELECT status FROM issues WHERE sig = ?").get(sig) as { status: string } | undefined;
      if (row?.status === "fixed") store.setStatus(sig, "open");
      d.prepare(`INSERT INTO api_routes (route, ok, since, sig, status, ms, t) VALUES (?,0,?,?,?,?,?)
          ON CONFLICT(route) DO UPDATE SET ok = 0, since = excluded.since, sig = excluded.sig, status = excluded.status, ms = excluded.ms, t = excluded.t`)
        .run(p.route, since, sig, r.status, r.ms, t);
    } else {
      if (prev && !prev.ok && prev.sig) {
        const row = d.prepare("SELECT status FROM issues WHERE sig = ?").get(prev.sig) as { status: string } | undefined;
        if (row?.status === "open") store.setStatus(prev.sig, "fixed");
      }
      d.prepare(`INSERT INTO api_routes (route, ok, since, sig, status, ms, t) VALUES (?,1,?,NULL,?,?,?)
          ON CONFLICT(route) DO UPDATE SET ok = 1, since = CASE WHEN api_routes.ok = 1 THEN api_routes.since ELSE excluded.since END,
            sig = NULL, status = excluded.status, ms = excluded.ms, t = excluded.t`)
        .run(p.route, t, r.status, r.ms, t);
    }
    // Spread out, so the pass never looks like a burst to the rate limit.
    await pause(300);
  }
  return { failed, total: list.length, down: unreachable >= list.length - 1 };
}

/// For the dashboard: each route's state, and its last `hours` of pings.
export function summary(hours = 24) {
  const d = db();
  const since = Date.now() - hours * 3_600_000;
  const routes = d.prepare("SELECT * FROM api_routes ORDER BY route").all() as (State & { status: number; ms: number; t: number })[];
  const stats = d.prepare(`SELECT route, COUNT(*) AS n, SUM(ok) AS passed, AVG(ms) AS avg_ms, MAX(ms) AS max_ms
      FROM api_checks WHERE t > ? GROUP BY route`).all(since) as { route: string; n: number; passed: number; avg_ms: number; max_ms: number }[];
  const series = d.prepare("SELECT t, route, status, ms, ok, error FROM api_checks WHERE t > ? ORDER BY t").all(since) as
    { t: number; route: string; status: number; ms: number; ok: number; error: string | null }[];
  const lastError = d.prepare(`SELECT route, MAX(t) AS t, error FROM api_checks WHERE ok = 0 AND t > ? GROUP BY route`).all(since);
  return {
    now: Date.now(), everySec: config.apiHealthEverySec, slowMs: config.apiSlowMs,
    routes: routes.map((r) => ({
      route: r.route, ok: !!r.ok, since: r.since, status: r.status, ms: r.ms, last: r.t,
      ...(stats.find((s) => s.route === r.route) ?? {}),
    })),
    lastError,
    series,
    deploys: d.prepare("SELECT * FROM deploys ORDER BY t DESC LIMIT 20").all(),
  };
}
