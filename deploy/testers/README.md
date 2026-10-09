# Tester fleet

Sixty personas, each with its own devnet wallet, drive the live site in
headless Chrome around the clock and file what goes wrong (console and page
errors, failed requests, error toasts, stuck transactions, slow pages, layout
breaks, dead clicks, figures that disagree with the API) on a dashboard.

Two at a time by default, rotating through every persona. The fleet's unit is
capped at 110% CPU and 3 GB so the devnet server keeps its room.

## Install on the box

All as root on 187.127.105.40, after `deploy/testnet/push.sh` has shipped a
main that includes `testers/`.

1. Chromium and its libraries:

       cd /opt/unwind && npx playwright install --with-deps chromium

   Chromium lands in /root/.cache; copy it where `unwind` can read it, or set
   `CHROME_PATH` in the env file to the installed binary.

2. Data directory and settings:

       mkdir -p /opt/unwind-testers/data && chown -R unwind:unwind /opt/unwind-testers
       cp /opt/unwind/deploy/testers/testers.env.example /etc/unwind/testers.env
       chown unwind /etc/unwind/testers.env && chmod 600 /etc/unwind/testers.env

   Set `TESTERS_PASS` to a real password.

3. Wallets (prints public keys only; the key file is mode 600):

       cd /opt/unwind && sudo -u unwind TESTERS_KEYS=/etc/unwind/testers.json \
         node_modules/.bin/ts-node --transpile-only -P testers/tsconfig.json testers/keygen.ts

4. Funding. A dry run lists every wallet, what it holds and what it would get;
   nothing moves without `--send`:

       sudo -u unwind TESTERS_KEYS=/etc/unwind/testers.json TESTERS_STATE=/opt/unwind/.devnet-state.json \
         node_modules/.bin/ts-node --transpile-only -P testers/tsconfig.json testers/fund.ts

   Defaults: 0.05 SOL and 1,000 test USDC a wallet (2,500 for listers), never
   taking the authority below 2 SOL. Rerun with `--send` to fund, and again
   whenever wallets run low.

5. Services:

       cp /opt/unwind/deploy/testers/*.service /etc/systemd/system/
       systemctl daemon-reload
       systemctl enable --now unwind-testers-dash unwind-testers

6. Dashboard through Caddy (in the api.unwindfi.xyz site block, before the
   default proxy):

       handle_path /testers/* {
           reverse_proxy 127.0.0.1:3100
       }

   then `systemctl reload caddy`. Open https://api.unwindfi.xyz/testers/ and
   sign in with TESTERS_USER / TESTERS_PASS.

## Day to day

- Logs: `journalctl -u unwind-testers -f`
- Pause: `systemctl stop unwind-testers` (the dashboard stays up)
- More or fewer browsers: change `CONCURRENCY` in the env file, restart.

## Dashboard

https://api.unwindfi.xyz/testers/ (basic auth) opens on a status bar: a
health grade with its reason, whether the fleet is up, the build, and a
24h / 48h / 7d range switch. Below it, six tiles with sparklines, six
charts drawn as inline SVG (sessions, transaction outcomes, journey success
by journey, step and order durations, new issues by severity, Chrome
memory), a live activity feed, the latest survey captures, and the issues
table with its Fixed / Ignore / Reopen actions. The page refreshes every
30 seconds and makes no request outside the dashboard.

The grade, from the last hour:

- Down: nothing started, ended or sent a transaction in `FLEET_DOWN_MIN`
  minutes (15 by default), or at least half of 4 or more sessions failed.
- Degraded: session failures above 10% (4 or more sessions), transaction
  failures above 10% (5 or more settled), journey failures above 15% (10 or
  more runs), or a new high-severity issue.
- Healthy: none of those.

Every route below sits behind the same basic auth and only reads, except
the status change.

| Route | What it returns |
| --- | --- |
| `GET /api/status` | The grade and its reasons, fleet up or down, minutes since the last activity, active workers, build, last-hour and 24h success rates for sessions, journeys and transactions, open issues by severity, the 5 most failing journeys and steps in 24h |
| `GET /api/timeseries?hours=48` | Hourly buckets for the last N hours (at most 168): sessions ok, failed, cut short and running; journeys ok and failed by name; settled transactions by kind (confirmed, failed, timeout); new issues by severity; median and p90 journey, per-step and confirmed-order durations; average Chrome memory; survey captures and changed pages |
| `GET /api/activity?limit=50` | The latest finished journeys, settled transactions and new issues as one feed, newest first (at most 200) |
| `GET /api/survey` | The latest capture of each surveyed page, with a `changed` flag when its last capture moved |
| `GET /survey/<file>.jpg` | A survey capture |
| `GET /api/health`, `/api/summary`, `/api/issues`, `/api/issue/<sig>` | The 24h tables, new issues and the issues table, as before |
| `POST /api/issues/<sig>/status` | `{ "status": "open" \| "fixed" \| "ignored" }` |
| `GET /shots/<file>.jpg` | An issue screenshot |

## Multi-visit journeys

Some flows outlast a session: a close held 10 minutes for points, a
withdrawal's 150 slots, a trigger that may fire in the next 20 minutes, and
the three minutes between one persona's transactions. These journeys do one
stage per visit and write the next stage, with its due time, to the store's
`meta` table (`fu:<persona>:<journey>`, see `testers/journeys/followup.ts`).
No browser waits: once a stage is due, the next worker turn goes to that
persona before the round robin. A persona in the middle of a plan sits the
round robin out, so no other journey trades over it. Plans older than 12
hours are dropped. Results that are not issues (a take profit that did not
fire, a market that did not move) are logged and kept as `note:<journey>:<persona>`.

| Journey | Who | Stages | Checked against the API |
| --- | --- | --- | --- |
| `lifecycle` | scalper, swing, power | open $30, add $20, close $20, close the rest | Positions row (value, entry, PnL, margin, funding) vs `/api/account`; the entry after adding lies between the old entry and the fill; a partial close leaves it; each fill on Trade history vs `/api/fills`; fee vs the market's bps (or 90% referred, 50% lister); one price per flow per batch on `/api/trades/:sym` |
| `tpsl` | limit, swing, power | open $20, set TP, set SL, cancel TP, set TP 0.2% from the mark, cancel SL, watch up to `TRIGGER_WATCH_MS`, close if it did not fire | each trigger in `orders` (price, direction), in the ticket's Triggers box and on Open orders; a fired TP's close in history and gone from Open orders; closing in full cancels what stands |
| `liquidation` | `LIQ_PERSONA` only | open `LIQ_COLLATERAL_USD` at the top leverage of the market most likely to move that far, watch the API up to `LIQ_WATCH_MS`, close if it did not move | "Position liquidated" once, with symbol, side and returned amount; nothing after a reload (#139); the Liquidations tab row |
| `makers` | limit, power (not on phones) | limit 3% away, moved to 0.4% (replaced in one transaction), canceled, then a post-only quote at the mid | the limit in `orders` and on Open orders; escrow out and back in USDC; a fired limit fills no worse than its price at the batch's price; the maker quote seen resting in `/api/batch/:sym?owner=`, then filled at its flow's clearing price or refunded |
| `newmarket` | lister | list one token with $100 backing, then one $10 order, then close it | the new market in `/api/markets` and on `/markets`; its first price within `LIST_PRICE_WINDOW_MS` (or the opening auction's stated minutes) |
| `backing` | lp, backer | pool deposit, back a market, request a withdrawal, claim once ready | USDC, xLP minted, `/api/backings`, "Your backing now", the pending shares, the stated wait vs `secondsLeft`, Claim disabled until ready, the claim's payout less the fee |
| `referral` | referrer, then a persona that has never filled | A claims `ut-<id>`; B arrives by `/r/<code>`, opens $520, closes after 10 min, opens $260, closes after 10 min; A checks | B's referrer and code; B's points are 2 per $1 closed; A gets nothing from the close that took B past $1,000 held, then 10% of B's next close; A's USDC is 10% of B's fees; the Referred card |
| `faucet` | new | a throwaway wallet claims on Earn; then deposits it all and claims again from a fresh browser | the prompt for an empty wallet; USDC and SOL arrive; the over-limit claim is refused in words that say when |

The faucet sits behind Cloudflare Turnstile. The journey never answers the
check. When it does not pass by itself within 30 seconds, the fleet records
one low issue, "faucet needs human check", and does not try again for
`FAUCET_HUMAN_BACKOFF_MS`.

Settings, all optional:

| Variable | Default | |
| --- | --- | --- |
| `LIQ_PERSONA` | `t52` | the only persona that runs `liquidation`, and nothing else |
| `LIQ_COLLATERAL_USD` | 12 | its stake per attempt |
| `LIQ_WATCH_MS` | 1200000 | how long it waits for a liquidation |
| `TRIGGER_WATCH_MS` | 1200000 | how long a moved take profit is watched |
| `LIST_PRICE_WINDOW_MS` | 90000 | a "Live at listing" market's first price, at most this late |
| `LIST_CANDIDATES` | `cbBTC,PUMP,MELANIA,ZEC,ME` | tokens `newmarket` may list, in order (each read "Live at listing" on October 10, 2026); one whose preview reads too thin is skipped from then on |
| `LISTINGS_PER_DAY` | 1 | shared by `list` and `newmarket`; raise to 2 or 3 for both to list |
| `FAUCET_CLAIMS_PER_DAY` | 1 | each spends the faucet's daily budget, which real users share |
| `FAUCET_HUMAN_BACKOFF_MS` | 86400000 | wait after the human check stopped a claim |
| `REFERRAL_HOLD_MS` | 630000 | a referee's hold before it closes (600s on chain) |

Funding: nothing new for `fund.ts`.

- `LIQ_PERSONA` needs only `LIQ_COLLATERAL_USD` plus fees per attempt. It
  runs nothing else, and positions are margined one by one, so its stake,
  not its balance, bounds what it can lose: the default top up is enough.
- The referee B needs $260 of USDC (it checks $260 before it is picked) and
  must never have filled: a wallet names its referrer only before its first
  fill. The lp and backer personas qualify until each has been used once
  (`ref:used` in `meta`). After that `referral` logs "no persona left" and
  stops; new keys for those personas would make them eligible again.
- `newmarket` uses the lister's existing 2,500 USDC and its SOL for the
  listing's rent, the same as `list`'s real listing.
- `faucet` uses throwaway wallets the faucet funds; the over-limit step
  leaves that one claim (10,000 test USDC) in the pool.

## Survey

Every `SURVEY_EVERY_MIN` minutes (60 by default, 0 turns it off) the fleet
captures each main route as an anonymous visitor with no wallet: `/`,
`/markets`, `/trade/<a keeper-priced coin>`, `/trade/<an xStock>`, `/list`,
`/list/bonk`, `/earn`, `/portfolio`, `/rewards` and the not-found page. Each
one is taken in dark and light, at 1440x900 and 390x844: 40 captures, about
four minutes in all.

Each capture keeps a JPEG (full page, capped at 3,000px tall, quality 70),
the page's aria snapshot trimmed to 6 KB, the console errors seen while it
loaded, and an 8x8 average hash of the picture. Only the latest per (route,
theme, device) is kept, in the `survey` table and `$TESTERS_DATA/survey/`.
`changed_at` moves only when the hash moves more than `SURVEY_HASH_BITS`
bits (4 of 64 by default), the snapshot's text changes beyond its figures,
or the capture starts or stops failing.

The survey takes a worker's turn between sessions, in chunks of
`SURVEY_CHUNK` captures (10), never on two workers at once and never two
turns running on one worker. It adds no browsers, so the unit's CPU and
memory caps hold.

## Checks

Beside the journeys, the fleet runs checks (`testers/checks/`). The API
pinger and the deploy watcher run in the fleet's own process with no
browser. The rest take a worker's turn between sessions, the way the survey
does, so they add no browsers and the unit's CPU and memory caps hold. Each
is cut off after `CHECK_TIMEOUT_MS` (8 minutes), and each periodic run is a
row in `check_runs`.

| Check | When | What it files |
| --- | --- | --- |
| API health | every `API_HEALTH_EVERY_SEC` (300) | `api-health`, high |
| Deploy watch and smoke | every `DEPLOY_POLL_SEC` (60); smoke on a change | `deploy-smoke`, high |
| Speed, errors, layout | in every survey capture (hourly) | `slow-lcp`, `layout-shift`, `console-error`, `broken-image`, `horizontal-overflow`, `container-overflow`, `text-overlap`, `small-tap-target`, `clipped-button` |
| UI numbers vs API | every `NUMBERS_EVERY_MIN` (30) | `number-mismatch` |
| Stale and paused markets | every `STALE_EVERY_MIN` (30) | `stale-not-blocked`, `stale-no-reason`, `stale-unflagged` |
| Wallet edge cases | every `WALLET_EDGES_EVERY_MIN` (240) | `wallet-edge` |
| Links, SEO, share cards | every `LINKS_EVERY_HOURS` (24) | `broken-link`, `seo-missing`, `seo-duplicate`, `share-card` |

Every check reads the API at `CHECKS_API_URL` (https://api.unwindfi.xyz),
the host the site itself reads.

**API health.** Every route the site reads, one request at a time, 300 ms
apart: `/api/markets` (and `?all=1`), `/api/rewards?owner=<t01>`,
`/api/leaderboard`, `/api/creators`, `/api/backings`, `/api/apy`,
`/api/account?owner=<t01>`, `/api/batch/SOL`, `/api/trades/SOL`,
`/api/candles/SOL`, `/api/fills`, `/api/wallets`, `/api/testnet-pools`,
`/api/icon/<a listed mint>` and the site's root. Status and time to the end
of the body go in `api_checks`, each route's current state in `api_routes`.
A route that answers 4xx or 5xx, answers 200 with an `error` field or a body
that is not JSON, or takes longer than `API_SLOW_MS` (3,000) gets one high
issue with the body's first line, so a stale IDL's "Cannot read properties
of undefined" on `/api/rewards` shows within one pass. When the route answers
well again the issue is marked fixed; a relapse reopens it. The dashboard
reads it at `GET /api/api-health?hours=24` (basic auth): each route's
state, its pings, and the last 20 deploys.

**Deploy watch.** A deploy is any of:

- the site: the hashed script names in `www.unwindfi.xyz/`'s HTML (the build
  id the fleet already stamps on issues) or the page's ETag changed;
- the server: a build header on `/api/markets` (`x-build`,
  `x-server-build`, `x-revision` or `x-server-started`) changed. The server
  sends none today, so the watcher falls back to the shape of its answers
  (the sorted field names of `/api/markets`, `/api/rewards` and
  `/api/leaderboard`), which moves when a server deploy changes what the site
  reads. A server deploy that changes no answer is seen only through the next
  rule; adding one of those headers to `scripts/server.ts` makes it exact;
- a restart: the pinger found nearly every route unreachable or 502, then
  the API answered again (what `deploy/testnet/push.sh` does).

The first reading after the fleet starts is a baseline (kept in the store,
so a deploy while the fleet was stopped is still seen). On a change a row
goes in `deploys` and two smoke tasks are queued, taken by the next free
workers ahead of the survey and the sessions: browse, trade (open and
close), list (to the preview) as the first of `DEPLOY_PERSONAS`, then
rewards, earn and trade as the second, on its own device. Each journey's
pass or fail lands on the deploy's row (`results`, `status` pass or fail);
any failure files a high `deploy-smoke` issue.

**Speed, errors and layout** ride on the survey's loads (no extra captures).
Per capture, into `page_metrics`: time to first byte, DOMContentLoaded,
load, LCP and CLS (a PerformanceObserver installed before the page's
scripts), bytes on the wire and request count (DevTools protocol, which
counts the API too), failed requests, console errors and broken images
(complete, with a source, `naturalWidth` 0). Filed: LCP over `PERF_LCP_MS`
(4,000), CLS over `PERF_CLS` (0.25), any console error, any broken image.
The layout checks run at both sizes in both themes: the session's own page
checks (page wider than the screen, controls off screen, clipped labels),
an element running out of its bordered or filled box, two interactive text
boxes in the page's flow that cross, tap targets under 44 by 44 CSS px on a
touch screen (one issue for the header and footer, one for the page), and
button text cut by an overflow-hidden box. `SURVEY_QUALITY=0` turns these
off.

**UI numbers vs API.** As a visitor, then connected as the first of
`NUMBERS_PERSONAS` that holds a position: `/markets` (each row's price, open
interest, 24h change, 24h volume, per-batch fill), two trade pages (the
header's mark, spread, 24h volume, open interest, 1h funding and leverage
cap; each market's cap and price in the list beside the chart; the
Liquidity panel's bid, ask, caps, per-batch fill and pool; the batch number
and phase, the last clear and the resting book against `/api/batch/:sym`),
then `/portfolio`'s available USDC, margin and each position's side, size,
entry and margin against `/api/account`. Tolerance is half a unit of the
last printed place. A field that disagrees is read again, page and API both,
three seconds later, and filed only if it still does, with the field, both
values, both reads and the route.

**Stale and paused markets.** Markets in `/api/markets` that are paused, or
whose `priceAgeMs` is past 80% of `maxPriceAgeSec` (at most three), are
opened connected as `STALE_PERSONA`. A market still stale or paused when its
page is open must be flagged in the header, and the ticket must refuse an
opening order and say why under its button. With none in that state the run
is a pass.

**Wallet edge cases**, on the terminal, desktop, as the first of
`WALLET_EDGE_PERSONAS`: a signature rejected in the wallet (the wallet
refuses before signing, so nothing is signed or sent; needs a persona with
test USDC); a disconnect from the site's menu and one from the wallet's side,
each with an order typed, then a reconnect; a switch of the wallet's account
to the second persona in the same context. Then a trade from a wallet with
no SOL: set `UNFUNDED_KEY` to a secret key file (a JSON array, mode 600,
outside the repo) for a wallet holding test USDC and no SOL, and the order is
sent (unless `DRY_TX`) and must fail with a message about SOL. Without it a
fresh key is made each run, holding nothing, and the ticket must refuse with
a reason. `fund.ts` never funds that key; give it USDC once by hand. In
every case the page must leave no "Confirming…" behind and take the next
order.

**Links, SEO and share cards**, daily: a breadth-first crawl from the site's
main routes and the docs' front page, internal addresses only (the site, the
docs, the API), at most `LINKS_MAX` (300). Site pages are rendered (the app
draws its links and its not-found page); docs pages are fetched and read as
HTML; files are asked with HEAD, then GET when HEAD is refused. A 404, a 5xx,
or the not-found page is filed with the page that linked it. Each main
route's title, meta description, og:title, og:description and og:image
must be there, titles and descriptions should differ between routes, and the
og:image must load as an image. Each listed market's card must load from
`/api/og/trade/<SYM>.png`, and the page a link previewer (Twitterbot) gets for
`/trade/<SYM>` must point its og:image at that card, which must load too.

To try one check by hand (prints what it filed):

    DRY_TX=1 npx ts-node --transpile-only -P testers/tsconfig.json testers/check.ts <name>

Names: `numbers`, `stale`, `wallet-edges`, `links`, `api-health`, `deploy`
(one look at the fingerprints), `smoke` (the smoke pass now), `survey
<route>` (one route's captures with the speed and layout checks).
`VERBOSE=1` prints every figure the numbers check compares.

New settings (all optional; defaults in brackets):

| Variable | Meaning |
| --- | --- |
| `CHECKS_API_URL` | API the checks read [https://api.unwindfi.xyz] |
| `DOCS_URL` | Docs site the link crawl starts from [https://docs.unwindfi.xyz] |
| `API_HEALTH_EVERY_SEC` | Seconds between API passes [300] |
| `API_SLOW_MS` | A route slower than this is failing [3000] |
| `API_TIMEOUT_MS` | A request is given up after this [10000] |
| `DEPLOY_POLL_SEC` | Seconds between deploy looks; 0 turns the watcher off [60] |
| `DEPLOY_SMOKE` | 0: record deploys without the smoke pass [1] |
| `DEPLOY_PERSONAS` | The smoke pass's two personas [t10,t09] |
| `NUMBERS_EVERY_MIN` | Minutes between number checks; 0 never [30] |
| `NUMBERS_PERSONAS` | Personas the number check may read as [t02,t10,t12,t20] |
| `NUMBERS_VIEW_WALLET` | Also compare this wallet's `/portfolio?wallet=` (local runs) [unset] |
| `STALE_EVERY_MIN` | Minutes between stale market checks; 0 never [30] |
| `STALE_PERSONA` | Persona for the stale check [t30] |
| `WALLET_EDGES_EVERY_MIN` | Minutes between wallet edge runs; 0 never [240] |
| `WALLET_EDGE_PERSONAS` | The persona, then the one switched to [t20,t30] |
| `UNFUNDED_KEY` | Secret key file for the zero-SOL trade [a fresh key each run] |
| `LINKS_EVERY_HOURS` | Hours between link, SEO and card passes; 0 never [24] |
| `LINKS_MAX` | Addresses the crawl visits at most [300] |
| `PERF_LCP_MS`, `PERF_CLS` | Speed thresholds [4000, 0.25] |
| `SURVEY_QUALITY` | 0 turns the survey's speed and layout checks off [1] |
| `CHECK_TIMEOUT_MS` | A check is cut off after this [480000] |

## Review feed

A read-only JSON feed for a scheduled reviewer that has HTTPS but no SSH and
no dashboard password. It answers to a bearer token, not basic auth.

1. Generate a token and put it in `/etc/unwind/testers.env`:

       openssl rand -hex 32

   as `REVIEW_TOKEN=<that>`. Under 32 characters, the feed refuses every
   request. Then `systemctl restart unwind-testers-dash unwind-testers`.

2. Caddy needs no change. Its `handle_path /testers/*` block only proxies;
   basic auth is enforced by the dashboard itself, which exempts
   `/api/review` and `/api/review/shot/*` and checks the token there
   instead. Every other path still asks for the password.

3. Give the reviewer the token and these two endpoints:

       GET https://api.unwindfi.xyz/testers/api/review?since=<ms>
       GET https://api.unwindfi.xyz/testers/api/review/shot/<survey|shots>/<file>.jpg

   both with `Authorization: Bearer <token>`. Anything else is a 401.

`since` is a Unix time in milliseconds (two hours ago when left out). The
reviewer passes the previous response's `now` as the next `since`, so each
run sees only what is new:

- `issues`: open issues first seen or seen again since then, newest first,
  at most 60, with a `shot` link when there is a screenshot.
- `pages`: survey captures that changed since then, newest first, at most
  40, with the snapshot, console errors and a `shot` link.
- `txFailures`: failed and timed-out transactions since then, grouped by
  kind, status and message, with counts.
- `build`: the live site build the fleet last saw. `now`: server time.
- `truncated`: true when issues or pages went past their cap; ask again
  with a later `since`, or look at the dashboard.

Shot links are absolute when the request came through Caddy (it sets
`X-Forwarded-Host`; `REVIEW_PREFIX`, `/testers` by default, is the path in
front). They serve only files the fleet wrote under `survey/` and `shots/`.

To rotate the token, replace it in the env file and restart the dashboard.
