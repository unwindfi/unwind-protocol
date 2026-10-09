# Devnet

## Overview

Devnet is the full venue on Solana's devnet cluster: the same program, the
same site, the same rules mainnet will run. Everything settles in test USDC,
which has no value.

The site shows a Devnet label beside the wordmark while it is connected to
the devnet server. Set your wallet to devnet to connect.

## Season 2

Season 2 started October 6, 2026, on a new pool.

1. **New pool, new test USDC.** Balances, positions and markets from the old
   pool do not carry over. The venue relisted its own markets; anything else
   has to be listed again.
2. **Points counted from zero.** The program keeps an all-time total per
   wallet. At the start of a season the server stores every wallet's total
   as a baseline, and the rewards page, the leaderboard, the weekly view and
   the creator ranking show only what was earned since.
3. **Old stakes earn nothing this season.** Backing or LP left in the old
   pool keeps accruing on chain, and the server takes that accrual off.

## Test funds

| | |
| --- | --- |
| Per claim | 10,000 test USDC, plus 0.2 devnet SOL if the wallet holds under 0.1 SOL |
| Per wallet | 1 claim per 24 hours |
| Per IP address | 3 claims per 24 hours |
| SOL, all wallets | 10 SOL per 24 hours. Past that, USDC only; take SOL from devnet's own faucet. |
| USDC, all wallets | 2,000,000 test USDC per rolling 24 hours. Past that, claims are refused until the oldest one ages out. |
| Human check | Cloudflare Turnstile before every claim |

**Get test funds** shows on the order ticket when the wallet has nothing to
trade with, and above the form on List and Earn when it has no test USDC or
too little SOL for rent. A wallet whose USDC is all in margin, backing or LP
is told how much is placed there instead. After a claim, the button is
replaced by when the next claim opens. The faucet also stops sending SOL when
the venue's own wallet falls under 1 SOL, which it needs to clear batches.

A claim is kept with the caller's IP address for a day, to count it toward
the limits, then dropped; a devnet copy keeps its requester's address for a
day too. The site's [Privacy Policy](https://www.unwindfi.xyz/privacy) lists
everything the site and server keep.

## Markets

1. **Equities.** SPYx, CRCLx and COINx. A relay posts Jupiter quotes on
   chain in Pyth's format, every 20 seconds. Outside US trading hours they
   run in their closed session at lower leverage (see
   [Sessions](sessions.md)).
2. **15 popular Solana tokens.** SOL, JUP, BONK (as 1MBONK, per million),
   WIF, JTO, PYTH, RAY, TRUMP, PENGU (as 1KPENGU, per thousand), FARTCOIN,
   POPCAT, RENDER, HNT, ORCA, DRIFT. Each is a devnet test token under the
   real ticker, in a Meteora DLMM pool against test USDC, listed through the
   ordinary permissionless path.
3. **Any other Solana token, through a mirror.** Search it on the list page
   and pick its pool as on mainnet. The preview reads the real mainnet pool,
   so leverage, open interest caps and budget come from that pool's depth.
   Listing it makes a mirror: a devnet test token with the real ticker and
   decimals, in a Meteora DLMM pool against test USDC at the real price, with
   liquidity laid so its depth (USD to move it 1%) matches the mainnet pool's.
   The program then reads the mirror's depth on chain, as it would on
   mainnet.

| Mirror limit | |
| --- | --- |
| Least mainnet depth | $1,000 |
| Most depth reproduced | about $55,000 |
| Mirrors, all addresses | 50 a day |
| Mirrors, one address | 8 a day |
| Mirrors per token | 1, reused by every later listing |

The mirror is built while the form is filled in, so List rarely waits for
it. A token listed on devnet is not the mainnet token, and the listing does
not carry over.

### How copies and mirrors are priced

1. **Mark at the mainnet price.** The mark keeper marks every copy and
   mirror at the real token's Jupiter price. It reads every 25 seconds and
   pushes when the price has moved 5 bps or 55 seconds have passed.
2. **Jupiter down.** The last real price stands for up to 5 minutes. After
   that the mark falls back to the devnet pool's own price.
3. **Circuit breaker.** A move over 10% between pushes is held for one push.
   If the next push still sees it, the mark walks toward it 10% a push, so
   positions on the way are liquidated while they still have margin.
4. **Pools kept near the real price.** A server process swaps in every copy
   and mirror pool every 2 minutes. The pools still supply the depth that
   sets leverage and budgets.
5. **Charts** start with the real token's history (Jupiter's chart data) and
   continue with the venue's own prints.

A market listed on mainnet is priced from its own pool (see
[Price sources](price-sources.md)).

### Hidden tokens

| Token | On devnet |
| --- | --- |
| WIND, KITE, YAK | Invented test tokens with their own pools. Cannot be listed. Left off every list. |
| A token with no name and no logo | Left off every list. |

A hidden market still trades by direct link, and positions and backing in it
still show in the account, so a holder can always close. Hidden markets are
left out of the creator ranking.

### Circle's devnet USDC

Real tokens' devnet pools are quoted in Circle's devnet USDC
(`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), not the venue's test USDC.
Devnet builds accept it as a listing's quote: paste a Raydium CLMM or Meteora
DLMM pool address on the list page. It prices the market like any USDC; the
market still settles in test USDC.

## Listing on devnet

Listing runs the mainnet rules (see
[How to open a market](how-to-open-a-market.md)). One difference: the list
page starts the backing at $2,000 instead of the $100 minimum. The pool
quotes 5% of a market's remaining budget into each batch, so $100 would fill
a tester's first orders $5 at a time.

## The devnet maker

unwind runs one market maker on devnet. Nobody else is quoting yet, and
without a maker every taker would fill against the pool at its own quote.
The maker is a single wallet run by the devnet server, under the same rules
as any other maker. It has no access the program gives nobody else.

1. **Where it quotes.** SOL, JUP, HYPE, WIF and TRUMP always have a quote
   resting. Every other market gets a quote only when a taker is already
   waiting in the batch.
2. **What it quotes.** 10 bps either side of the mark, up to $10,000 a side,
   sized to the room under the market's open-interest cap. It holds at most
   $100,000 in a market. Flat, it can rest one side only, and it alternates.
3. **How it prices.** From the mark alone. It never prices off the orders it
   can see resting, and it never trades with itself.
4. **Requotes.** When the mark moves 5 bps away from a resting quote, the
   quote is cancelled and placed again, at most once every 30 seconds. A
   quote that fills is replaced in the next batch.
5. **Labeled.** Its orders show as **house** in the book and its fills as
   **house** on the tape.
6. **Counted apart.** The batch panel splits each clear into makers, house
   and pool. The pool share and the house share are each reported as their
   own figure. What is left is makers unwind does not run.
7. **Never ranked.** It is left off the leaderboard and counts toward no
   creator's score.

Anyone can quote against it. A tighter quote fills first.

## Rewards for devnet creators

The markets do not carry over. The work does. People who list and grow
markets on devnet get two things at mainnet launch:

1. **Points,** credited from a snapshot of their devnet markets.
2. **A fee discount** on mainnet trading.

The server counts a creator's score from the fills it settles:

1. A market's traders are the wallets with $100 or more of filled volume in
   it, maker or taker, opens and closes together. Liquidations do not count.
2. Each wallet counts once per market, however much it trades there.
3. The deployer never counts in their own market. Neither do the server's
   own wallets: the pool authority, the market maker, the demo trader and the
   price relay.
4. A creator's score is the sum of their markets' traders.

The rewards page shows each of your markets' traders and your score, and
ranks every creator under the points leaderboard. The points per trader, the
discount and its length are published here before mainnet.

## Points on devnet

Test USDC is free, so a round trip between two of your own wallets would
otherwise be free points. Devnet runs the mainnet rules (see
[Referrals and points](rewards.md)):

1. 0 points for an open. 2 points per $1 closed after 10 minutes held, 0
   before.
2. 250,000 trading points per wallet per UTC day.
3. A referrer earns points from a referee only after the referee has $1,000
   of held volume.
4. A deployer earns 10% of the trading points on their market, nothing on
   their own trades.
5. Liquidations earn 0.
6. A pool earns points only if the program's upgrade authority switched them
   on. The devnet pool has them on.

Wallets from before these rules have their `Trader` account grown once by
`resize_trader`, which anyone may send; `scripts/resize-markets.ts` does it
for all of them after a deploy.

## Your wallet signs everything

Every order, close, deposit, withdrawal and backing is signed by the wallet
you connect. Without one, the site shows prices, charts and markets, and the
trade buttons ask you to connect. There is no shared demo account to trade.

Every transaction gets a toast:

1. **Confirming** once the wallet has signed.
2. **Done** once the transaction reaches `confirmed` (about a second), not
   finalized, with a Solscan link. It closes after 6 seconds.
3. **Failed** if it lands and fails or the server cannot be reached, with a
   Solscan link when there is a signature. It stays until dismissed.
4. **Rejected** if you close the wallet without signing, as one quiet line.

Program errors read as one short line (for example "Price moved, try again"
for `SlippageExceeded`). The full list is in `web/src/lib/errors.ts`, and the
web build fails if it no longer matches the program's errors. A balance the
site could not read shows as unavailable with a retry, never as zero.

## Addresses

| Address | Opens |
| --- | --- |
| `/trade/SYM` | The trade screen on that market, for example `/trade/SOL` |
| `/vault/ID` | A vault page: a market's backing (`/vault/SOL`) or the pool (`/vault/pool`) |
| `/list/Q` | The list page searched for `Q`, for example `/list/bonk` |
| `/r/CODE` | The front page with that referral code |
| `/portfolio?wallet=ADDRESS` | Any wallet's portfolio, read only |

The old query forms (`/trade?symbol=`, `/vault?id=`, `/list?q=`, `/?ref=`)
still work and are rewritten to the paths above.

## First connection

The first time a wallet connects, the site shows three screens once: what
the venue is, the two ways in (trading, or backing a market and the pool),
and the risks (liquidation, backing's first loss, the price feed). The last
screen asks the wallet to sign a short message recording that these were
read. It is a message, not a transaction: it costs nothing and moves nothing.
The acceptance is kept in that browser for that wallet. Closing the screens
without signing is kept too, so they are not shown again. The text is in
`web/src/components/Welcome.tsx`.

The site also tells the server a wallet's address when it connects (once a
browser session) and sends the signed message once it is signed, so
connected wallets can be counted. The server keeps only the address, when it
was first and last seen, and when it signed; it checks the signature against
the wallet's key. One IP address can add at most 10 unsigned wallets a day.
`GET /api/wallets` returns `connected`, `signed`, `active24h`, `active7d`,
and `since`, the time of the first record.

## The API

The site reads and builds every transaction through
`https://api.unwindfi.xyz`. Anyone can call it. Every route is public, and
nothing it does moves funds without the wallet's own signature.

Per IP address, per minute:

1. 100 RPC calls caused by its requests. Reads served from the server's
   cache cost none; a trade costs about 10 to build, send and confirm.
2. 1,200 requests of any kind.

Past either, the API answers `429` with `Retry-After` until the minute is
up. The faucet and devnet mirrors keep their own daily limits instead.

Token logos come from the API too. `GET /api/icon/<mint>` takes a mainnet
mint and returns the logo Jupiter lists for it, fetched once by the server.
Most logos live on IPFS gateways that browsers refuse to show on another
site, so the server tries the logo's own URL, then the same file on public
gateways, and keeps the first real image it gets for 7 days. A token with no
logo answers `404`, and the server does not look again for an hour. The site
shows the token's initial until a logo loads, and keeps it if none does.

## What differs from mainnet

1. **Equity prices** come from a relay that posts Jupiter quotes in Pyth's
   format, because Pyth's own feeds need a paid key. Only the trading
   calendar comes from Pyth. Mainnet reads Pyth directly.
2. **Token marks** are the mainnet Jupiter price, not the devnet pool's.
3. **Pools are moved by one process,** not by organic trading.
4. **A market maker quotes** on the devnet markets so orders have something
   to meet besides the pool (see [The auction](auction.md)). Its wallet earns
   points like any other and is left off every ranking.
5. **Anyone can create a pool** on a devnet build, in a token of their own.
   Such a pool earns no points unless the upgrade authority switches them on.
