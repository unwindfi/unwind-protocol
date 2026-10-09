/*
 * Every knob the fleet reads, from the environment, with the defaults the
 * box runs on. Nothing here is secret: the keys live in the file named by
 * TESTERS_KEYS, outside the repo, and only this process reads it.
 */
import path from "path";

const num = (v: string | undefined, d: number) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const flag = (v: string | undefined) => v === "1" || v === "true" || v === "yes";

export const config = {
  /// The site the testers drive. Production by default; a local dev server
  /// (http://localhost:5185) while working on the harness.
  baseUrl: (process.env.BASE_URL ?? "https://www.unwindfi.xyz").replace(/\/$/, ""),
  /// Where the harness itself reads the API to cross-check numbers. The site
  /// serves /api on its own origin in both production and dev, so this is
  /// the site unless set.
  apiUrl: (process.env.API_URL ?? process.env.BASE_URL ?? "https://www.unwindfi.xyz").replace(/\/$/, ""),
  keysFile: process.env.TESTERS_KEYS ?? "/etc/unwind/testers.json",
  dataDir: process.env.TESTERS_DATA ?? "/opt/unwind-testers/data",
  concurrency: Math.max(1, num(process.env.CONCURRENCY, 2)),
  /// Only these persona ids (comma separated), for local runs.
  only: (process.env.PERSONAS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  /// Signs, then refuses to hand the signed transaction back, so nothing is
  /// ever broadcast. Also stubs the welcome report and blocks /api/tx/send.
  dryTx: flag(process.env.DRY_TX),
  /// One trade per persona per this many ms, and one transaction from the
  /// whole fleet per `fleetTxGapMs`.
  personaTxGapMs: num(process.env.PERSONA_TX_GAP_MS, 3 * 60_000),
  fleetTxGapMs: num(process.env.FLEET_TX_GAP_MS, 10_000),
  /// Real listings by the lister personas, fleet wide, per day. Each one
  /// creates a market and posts backing, so it is kept rare.
  listingsPerDay: num(process.env.LISTINGS_PER_DAY, 1),
  /// A session (one persona, one fresh context) is cut off after this long.
  sessionTimeoutMs: num(process.env.SESSION_TIMEOUT_MS, 6 * 60_000),
  /// Pause between sessions on one worker, plus up to `jitterMs` at random.
  gapMs: num(process.env.SESSION_GAP_MS, 5_000),
  jitterMs: num(process.env.SESSION_JITTER_MS, 20_000),
  /// A worker's Chrome is closed and relaunched after this many sessions.
  recycleEvery: Math.max(1, num(process.env.RECYCLE_EVERY, 12)),
  /// Detector thresholds.
  slowNavMs: num(process.env.SLOW_NAV_MS, 4_000),
  slowStepMs: num(process.env.SLOW_STEP_MS, 8_000),
  deadClickMs: num(process.env.DEAD_CLICK_MS, 2_500),
  txTimeoutMs: num(process.env.TX_TIMEOUT_MS, 75_000),
  /// Screenshots: at most one per this many ms, and this many an hour.
  shotGapMs: num(process.env.SHOT_GAP_MS, 15_000),
  shotsPerHour: num(process.env.SHOTS_PER_HOUR, 60),
  /// Dashboard.
  dashHost: process.env.TESTERS_HOST ?? "127.0.0.1",
  dashPort: num(process.env.TESTERS_PORT, 3100),
  dashUser: process.env.TESTERS_USER ?? "",
  dashPass: process.env.TESTERS_PASS ?? "",
  /// Stop after this many ms (0: forever). Used for local verification runs.
  runForMs: num(process.env.RUN_FOR_MS, 0),
  headless: process.env.HEADFUL !== "1",
  /// The Chromium binary, when not the one Playwright installed.
  chromePath: process.env.CHROME_PATH || undefined,
};

export const paths = {
  db: path.join(config.dataDir, "testers.db"),
  shots: path.join(config.dataDir, "shots"),
};
