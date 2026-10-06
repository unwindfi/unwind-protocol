# Running the testnet server

One process runs the whole testnet: it posts prices through the relay, clears
and settles every batch, runs the keeper (liquidations, triggers, funding),
serves the faucet, and answers the site's API. The site on Vercel forwards its
`/api` calls here (`api/[...path].ts`), so this box is the only thing that
needs to stay up.

## What it needs

| On the box | From |
|---|---|
| The repo at `/opt/unwind`, `npm ci` run | `git clone` |
| `target/idl/unwind.json`, `target/idl/mock_pyth.json` | `anchor build -- --features devnet` locally, then `scp` (gitignored) |
| `.devnet-state.json` in `/opt/unwind` | your machine (gitignored, holds the pool authority key) |
| `/etc/unwind/relay.json` | `~/.config/unwind/relay.json` on your machine |
| `/etc/unwind/testnet.env` | `testnet.env.example`, with dedicated devnet RPC keys |

Dedicated RPCs are metered. `RPC_URLS` takes several keys, comma separated,
and requests take turns across them. A key that answers 429 rests for a
minute while the others carry on (the log says `rpc: <host> rate limited`);
only with every key resting does a read go to `RPC_FALLBACK_URL` (the public
devnet endpoint unless set). Meanwhile `/api/markets` and `/api/account`
answer with the last list they read in full, dated in an `X-Stale-Since`
header, rather than an error. The crank is slower on the fallback, so a pool
that keeps resting needs more keys. The startup log names the hosts and the
number of keys, never the keys themselves. Transaction confirmations go over
a websocket, which free Helius keys refuse; on devnet it goes to the public
endpoint unless `RPC_WS_URL` says otherwise. A key whose plan refuses a method
outright (Alchemy's free tier and `getProgramAccounts`) is remembered, and
that method goes only to keys that serve it; the log says
`rpc: <host> does not serve <method>`.

Every ten minutes the log prints how many RPC calls the server made, with a
daily projection and the busiest methods (`rpc: 4210 calls in 10m (~606k/day):
getMultipleAccounts 1800, ...`), so a key that is running out says why. The
auction reads every batch once a second only while something is resting or an
order was just built; otherwise it reads them every `AUCTION_IDLE_MS` (4
seconds by default), and wakes at once when an order arrives through this
server.

What a page polls is served from memory, so the RPC cost does not grow with
the number of visitors. The pool, the LP mint and every market ride along in
the auction's batch read and serve `/api/markets`, every account view and
the keepers; a reader only goes to the chain when that snapshot is older than
`SHARED_FRESH_MS` (5000). `/api/account` and `/api/backings` are kept per
wallet for `ACCOUNT_FRESH_MS` and `BACKINGS_FRESH_MS` (4000 and 5000), one
read serving every poll meanwhile, and dropped the moment that wallet sends a
transaction through this server. An account view is one batched read of the
wallet's own accounts. After a send, fill or liquidation the keepers re-read
only that wallet's positions and orders; the full `getProgramAccounts` scans
stay on their one-minute refresh.

The mark keeper reads every observed market, its observation and its pool in
one call a pass (`OBSERVE_MS`, 25000). It leaves a seasoned mark alone when
the new price is within `OBSERVE_SKIP_BPS` (5) of it and the mark will be
under `OBSERVE_REFRESH_SEC` (55) old at the next pass, never closer than 20
seconds to the market's `max_price_age_sec`, and sends up to `MARK_BATCH` (6)
pushes per transaction. `OBSERVE_SKIP_BPS=0` pushes every market every pass,
as before. The AUM checkpoint loop writes only when the checkpoint would
otherwise be stale by the next pass.

Node 20 or newer.

## Install

```bash
sudo useradd --system --home /opt/unwind unwind
sudo mkdir -p /etc/unwind
sudo cp deploy/testnet/testnet.env.example /etc/unwind/testnet.env
sudo chown -R unwind /opt/unwind /etc/unwind
sudo chmod 600 /etc/unwind/* /opt/unwind/.devnet-state.json
sudo cp deploy/testnet/unwind-testnet.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now unwind-testnet
journalctl -u unwind-testnet -f
```

The log should end with each market's price and session, then stay quiet
apart from clears and settlements.

## Update it

```bash
deploy/testnet/push.sh
```

Ships `origin/main` (never the working tree) and the program IDLs, keeps the
box's own files (state, faucet claims, caches), restarts the service, and puts
the previous tree back if the new one does not answer `/api/markets`. Merge
first; an unmerged branch does not ship.

## After a fresh pool

A market belongs to one pool, so a new pool starts with only the markets its
bootstrap lists. The seeded DLMM pairs survive, and this lists the popular-token
markets on them again, backed and signed by the pool authority, the same way
the /list page does:

```bash
npx ts-node --transpile-only scripts/list-devnet-pools.ts
```

It leaves WIND, KITE and YAK for testers, and skips anything already listed.
The markets season on their own and open for trading about 15 minutes later.

A new pool needs a new test USDC (the pool's address comes from its mint),
and a market can only be priced from a pool quoted in that mint, so the
seeded DLMM pairs are made again too. To keep the same authority, LP and
demo keys, so the box's configuration and the wallets the rankings hide stay
the same:

```bash
FRESH=1 KEYS_FROM=<old state file> CHAIN_FEE_DESTINATION=<address> \
  RPC_URL=<rpc> npx ts-node --transpile-only scripts/bootstrap-localnet.ts
RPC_URL=<rpc> ONLY=WIND,KITE,YAK,SOL,... npx ts-node --transpile-only scripts/seed-devnet-pools.ts
# then the listing above, against a server already running on the new state
```

On the box, beside the new `.devnet-state.json`: empty `.devnet-copies.json`
(`[]`; the mirrors are quoted in the old USDC), and remove
`.devnet-faucet.json`, `.cache/devnet-lookup-table.json`,
`.cache/devnet-market-traders.json` and `.cache/vault-tape.json`, which
describe the old pool. The first run against a new pool starts a points
season: it writes every wallet's totals to `.cache/devnet-season.json` and
shows points from there on.

## Expose it

Vercel has to reach the server over HTTPS. Point a DNS name at the box, put
`Caddyfile` (with that name) at `/etc/caddy/Caddyfile`, and reload Caddy; it
fetches the certificate itself. Then in the Vercel project set:

```
TESTNET_API_URL=https://<that name>
VITE_RPC_URL=https://api.devnet.solana.com
```

and redeploy. With `TESTNET_API_URL` unset the site goes back to read-only.

## Callers and the faucet

The faucet and new devnet tokens are limited per caller address, so the
server must know the address without believing the caller. Two settings
do it, and both go in two places:

| Variable | On the box (`/etc/unwind/testnet.env`) | In the Vercel project |
|---|---|---|
| `FORWARD_SECRET` | yes | yes, the same value |
| `TURNSTILE_SECRET` | yes | no |
| `VITE_TURNSTILE_SITE_KEY` | no | yes (read at build time, so redeploy) |
| `FAUCET_USDC_PER_DAY` | optional, 2,000,000 by default | no |

- **`FORWARD_SECRET`.** The site's forwarder (`api/_forward.ts`) sends the
  caller's address from Vercel's `x-real-ip` with this secret beside it. The
  server believes that address only when the secret matches. Otherwise it
  uses the connection's own address; from Caddy on 127.0.0.1 that is the
  last `X-Forwarded-For` entry, which Caddy writes itself (it drops what the
  caller sent unless `trusted_proxies` is set, and the Caddyfile here sets
  none). A header a caller writes is never used. Unset, the log warns at
  startup and every call through the site counts as Vercel's one address,
  so the per-address limits bind everyone together.
- **Turnstile.** Create a widget in the Cloudflare dashboard (Turnstile, add
  the site's domains, Managed mode), put the site key in Vercel as
  `VITE_TURNSTILE_SITE_KEY` and the secret key on the box as
  `TURNSTILE_SECRET`. Set the site key first and redeploy the site, then set
  the secret and restart the server: the other order refuses every claim
  until the site is rebuilt. Unset, the server warns at startup and skips
  the check.
- **Limits.** One claim a wallet a day, three an address a day,
  `FAUCET_SOL_PER_DAY` SOL and `FAUCET_USDC_PER_DAY` test USDC across
  everyone in any 24 hours. Claims are in `.devnet-faucet.json`, which a
  deploy keeps.

The devnet creator score (distinct traders per market, see `docs/devnet.md`)
is counted from the fills this server settles and kept in
`.cache/devnet-market-traders.json`, which a deploy keeps with the rest of
`.cache`.
The browser only uses `VITE_RPC_URL` for the wallet, so the public endpoint is
fine there and the dedicated RPC key stays on the server.

## Money

The pool authority in `.devnet-state.json` pays for every crank transaction
and the faucet's SOL. At the default limits the faucet spends at most 5 devnet
SOL a day. Check it with `solana balance <authority> --url devnet` and top it
up from the deployer key when it runs low. Below `AUTHORITY_SOL_FLOOR` (1 SOL)
the faucet stops sending SOL, the log warns every ten minutes, and
`ALERT_WEBHOOK_URL`, if set, gets the warning at most every six hours.
