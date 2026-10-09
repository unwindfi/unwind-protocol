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
