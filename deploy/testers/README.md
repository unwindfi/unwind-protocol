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
