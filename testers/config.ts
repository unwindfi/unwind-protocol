/*
 * Every knob the fleet reads, from the environment, with the defaults the
 * box runs on. Nothing here is secret: the keys live in the file named by
 * TESTERS_KEYS, outside the repo, and only this process reads it.
 */
import path from "path";

const num = (v: string | undefined, d: number) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const flag = (v: string | undefined) => v === "1" || v === "true" || v === "yes";
const list = (v: string | undefined, d: string[]) => {
  const xs = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return xs.length ? xs : d;
};

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
  /// The multi-visit journeys (journeys/followup.ts and the stages after it).
  /// Liquidation: one dedicated persona, a small stake at the market's top
  /// leverage, watched this long before it is closed as "did not move".
  liqPersona: process.env.LIQ_PERSONA ?? "t52",
  liqCollateralUsd: num(process.env.LIQ_COLLATERAL_USD, 12),
  liqWatchMs: num(process.env.LIQ_WATCH_MS, 20 * 60_000),
  /// How long a moved take profit is watched for firing before it is closed.
  triggerWatchMs: num(process.env.TRIGGER_WATCH_MS, 20 * 60_000),
  /// A new listing must have its first price within this (the keeper's pass
  /// is every 25s), and tokens the listing journey may list, in order, when
  /// none the fleet listed before can be listed again.
  listPriceWindowMs: num(process.env.LIST_PRICE_WINDOW_MS, 90_000),
  listCandidates: (process.env.LIST_CANDIDATES ?? "cbBTC,PUMP,MELANIA,ZEC,ME")
    .split(",").map((s) => s.trim()).filter(Boolean),
  /// Faucet claims through the site, fleet wide, per day (each spends the
  /// faucet's shared daily budget), and how long a claim stopped by the human
  /// check waits before it is tried again.
  faucetClaimsPerDay: num(process.env.FAUCET_CLAIMS_PER_DAY, 1),
  faucetHumanBackoffMs: num(process.env.FAUCET_HUMAN_BACKOFF_MS, 24 * 3_600_000),
  /// A referee's hold before its close earns points (600s on chain, plus a
  /// margin for the batch and the clock).
  referralHoldMs: num(process.env.REFERRAL_HOLD_MS, 630_000),
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
  /// The survey: every main route in both themes on a desktop and a phone,
  /// once per this many minutes (0: never), at most `surveyChunk` captures
  /// per worker turn so journeys keep their slots. A capture counts as
  /// changed when its fingerprint moves more than `surveyHashBits` of 64.
  surveyEveryMin: num(process.env.SURVEY_EVERY_MIN, 60),
  surveyChunk: Math.max(1, num(process.env.SURVEY_CHUNK, 10)),
  surveyHashBits: num(process.env.SURVEY_HASH_BITS, 4),
  /// The checks in testers/checks/ (see deploy/testers/README.md). They read
  /// the API at its own host, the way the site does, and the docs site for
  /// the link crawl.
  checksApiUrl: (process.env.CHECKS_API_URL ?? "https://api.unwindfi.xyz").replace(/\/$/, ""),
  docsUrl: (process.env.DOCS_URL ?? "https://docs.unwindfi.xyz").replace(/\/$/, ""),
  /// Minutes between runs of each browser check (0: never). The link, SEO
  /// and share card pass counts in hours.
  numbersEveryMin: num(process.env.NUMBERS_EVERY_MIN, 30),
  staleEveryMin: num(process.env.STALE_EVERY_MIN, 30),
  walletEdgesEveryMin: num(process.env.WALLET_EDGES_EVERY_MIN, 240),
  linksEveryHours: num(process.env.LINKS_EVERY_HOURS, 24),
  linksMax: Math.max(20, num(process.env.LINKS_MAX, 300)),
  /// A check that runs past this is cut off, like a session.
  checkTimeoutMs: num(process.env.CHECK_TIMEOUT_MS, 8 * 60_000),
  /// Personas the checks borrow (ids, comma separated).
  numbersPersonas: list(process.env.NUMBERS_PERSONAS, ["t02", "t10", "t12", "t20"]),
  walletEdgePersonas: list(process.env.WALLET_EDGE_PERSONAS, ["t20", "t30"]),
  stalePersona: process.env.STALE_PERSONA ?? "t30",
  deployPersonas: list(process.env.DEPLOY_PERSONAS, ["t10", "t09"]),
  /// A secret key (JSON array) holding test USDC and no SOL, for the zero-SOL
  /// trade. Unset: a fresh key each run, which holds neither.
  unfundedKey: process.env.UNFUNDED_KEY ?? "",
  /// Local runs: read this wallet's /portfolio (?wallet=) as well.
  numbersViewWallet: process.env.NUMBERS_VIEW_WALLET ?? "",
  /// Page speed thresholds for the survey's measurements.
  lcpMs: num(process.env.PERF_LCP_MS, 4_000),
  cls: num(process.env.PERF_CLS, 0.25),
  /// Layout and speed checks in the survey pass (0 turns them off).
  surveyQuality: process.env.SURVEY_QUALITY !== "0",
  /// The API pinger: every route once per this many seconds, slow past
  /// `apiSlowMs`. No browser.
  apiHealthEverySec: num(process.env.API_HEALTH_EVERY_SEC, 300),
  apiSlowMs: num(process.env.API_SLOW_MS, 3_000),
  apiTimeoutMs: num(process.env.API_TIMEOUT_MS, 10_000),
  /// The deploy watcher: how often it reads the site's build and the
  /// server's answer, and whether a change runs the smoke pass.
  deployPollSec: num(process.env.DEPLOY_POLL_SEC, 60),
  deploySmoke: process.env.DEPLOY_SMOKE !== "0",
  /// Dashboard.
  dashHost: process.env.TESTERS_HOST ?? "127.0.0.1",
  dashPort: num(process.env.TESTERS_PORT, 3100),
  dashUser: process.env.TESTERS_USER ?? "",
  dashPass: process.env.TESTERS_PASS ?? "",
  /// The bearer token for the read-only review feed (/api/review). Unset or
  /// shorter than 32 characters, the feed refuses every request.
  reviewToken: process.env.REVIEW_TOKEN ?? "",
  /// The dashboard calls the fleet down when nothing started, ended or sent
  /// a transaction in this many minutes.
  fleetDownMin: Math.max(1, num(process.env.FLEET_DOWN_MIN, 15)),
  /// The path Caddy serves the dashboard under, for absolute shot links.
  reviewPrefix: (process.env.REVIEW_PREFIX ?? "/testers").replace(/\/$/, ""),
  /// Stop after this many ms (0: forever). Used for local verification runs.
  runForMs: num(process.env.RUN_FOR_MS, 0),
  headless: process.env.HEADFUL !== "1",
  /// The Chromium binary, when not the one Playwright installed.
  chromePath: process.env.CHROME_PATH || undefined,
};

export const paths = {
  db: path.join(config.dataDir, "testers.db"),
  shots: path.join(config.dataDir, "shots"),
  survey: path.join(config.dataDir, "survey"),
};
