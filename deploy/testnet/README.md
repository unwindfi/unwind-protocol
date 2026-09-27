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
| `target/idl/unwind.json`, `target/idl/mock_pyth.json` | `anchor build` locally, then `scp` (gitignored) |
| `.devnet-state.json` in `/opt/unwind` | your machine (gitignored, holds the pool authority key) |
| `/etc/unwind/relay.json` | `~/.config/unwind/relay.json` on your machine |
| `/etc/unwind/testnet.env` | `testnet.env.example`, with a dedicated devnet RPC |

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

## Expose it

Vercel has to reach the server over HTTPS. Point a DNS name at the box, put
`Caddyfile` (with that name) at `/etc/caddy/Caddyfile`, and reload Caddy; it
fetches the certificate itself. Then in the Vercel project set:

```
TESTNET_API_URL=https://<that name>
VITE_RPC_URL=https://api.devnet.solana.com
```

and redeploy. With `TESTNET_API_URL` unset the site goes back to read-only.
The browser only uses `VITE_RPC_URL` for the wallet, so the public endpoint is
fine there and the dedicated RPC key stays on the server.

## Money

The pool authority in `.devnet-state.json` pays for every crank transaction
and the faucet's SOL. At the default limits the faucet spends at most 5 devnet
SOL a day. Check it with `solana balance <authority> --url devnet` and top it
up from the deployer key when it runs low. Below `AUTHORITY_SOL_FLOOR` (1 SOL)
the faucet stops sending SOL, the log warns every ten minutes, and
`ALERT_WEBHOOK_URL`, if set, gets the warning at most every six hours.
