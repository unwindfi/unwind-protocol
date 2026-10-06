# Devnet

## Overview

Devnet is the full venue running on Solana's devnet network. Orders, batches,
liquidations, listings and backing are the same program and the same site as
mainnet will use. Everything settles in test USDC, which has no value.

The site shows a Devnet label beside the wordmark while it is connected to
the devnet server. Set your wallet to devnet to connect.

## Season 2

Season 2 started 6 October 2026: new pool, points from zero.

The new pool settles in a new test USDC, so balances, positions and markets
from the old pool do not carry over. The venue relisted its own markets on
it; anything else has to be listed again. Points on chain are an all-time
total per wallet, so the leaderboard, the weekly view, the rewards page and
the creator ranking count only what each wallet has earned since the season
began. Backing or LP left in the old pool earns nothing this season.

## Getting test funds

Connect a devnet wallet. With nothing to trade with, the order ticket shows
**Get test funds**, and the list and earn pages show it above the form when
the wallet has no test USDC or too little SOL for rent. A wallet whose USDC
is all in backing, margin or LP is told how much is placed there rather than
that it has no funds. Once a wallet has claimed, the page drops the button
and says when the next claim opens. It sends 10,000 test
USDC and, when the wallet holds under 0.1 SOL, 0.2 devnet SOL: enough to
list a few markets and trade for a day. Each wallet can use it once a day,
and one address three times a day. Before it sends, the page shows a short
human check (Cloudflare Turnstile). The faucet gives out 10 SOL a day in all;
past that it still sends USDC, and SOL comes from devnet's own faucet. It
gives out 2,000,000 test USDC a day in all; past that it refuses until the
oldest claim of the last 24 hours is a day old.

## Markets

- **Equities.** SPYx, CRCLx and COINx, priced from Jupiter quotes that a relay posts on
  chain in Pyth's format. On
  weekends and outside US trading hours they run in their closed session at
  lower leverage (see [Sessions](sessions.md)).
- **Popular Solana tokens.** 15 of them: SOL, JUP, BONK (traded per million
  as 1MBONK), WIF, JTO, PYTH, RAY, TRUMP, PENGU (per thousand as 1KPENGU),
  FARTCOIN, POPCAT, RENDER, HNT, ORCA and DRIFT. These are test copies:
  devnet tokens under the real tickers, each in a Meteora DLMM pool against
  test USDC. They are listed through the ordinary permissionless path, but
  on devnet their mark is the real token's price on mainnet (Jupiter), pushed
  every minute by the server's mark keeper, so they trade at the real price.
  If Jupiter is unavailable or limits the server, the last real price stands
  for up to five minutes before the mark falls back to the devnet pool.
  A move of more than 10% between pushes is held for one push, so one bad
  reading cannot move the mark. If the next push still sees it, the mark
  walks toward it 10% a push, so positions on the way are liquidated while
  they still have margin rather than after the whole move.
  Their devnet pools still supply the depth that sets leverage and budgets,
  and a server process swaps in them every ten minutes to keep them near the
  real price. Their charts start with the real token's history (Jupiter's
  chart data), then continue with the venue's own prints. A market somebody lists on mainnet is priced from its own pool
  (see [Price sources](price-sources.md)).
- **Any other Solana token, listed from its mainnet pool.** Search any token
  on the list page and pick its pool as on mainnet: the preview reads the
  real pool on mainnet, so the leverage, open-interest caps and budget it
  shows come from that pool's depth. Listing it on devnet lists a mirror of
  that pool: a devnet test token under the real ticker and decimals, in a
  Meteora DLMM pool against test USDC at the real price, with liquidity laid
  so its depth (USD to move it 1%) matches the mainnet pool's, up to about
  $55,000. The program derives the limits from the mirror's depth on chain,
  the same way it would on mainnet, and the mirror is then held at the real
  price and marked at it like the copies above. The mirror is built while
  the form is filled in, so List rarely waits for it. A pool needs $1,000 of
  depth. Devnet makes one mirror per token, up to 50 a day in all and 8 a
  day from one address.
- **WIND, KITE and YAK.** Invented tokens with their own pools. They can't
  be listed, and markets already on them are left off every list, though a
  holder can still close by direct link.

A market on a token with no name and no logo is left off the lists the same
way.

Real tokens' devnet pools are quoted in Circle's devnet USDC
(`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), not in the venue's test
USDC, and devnet accepts it as a listing's quote: paste a Raydium CLMM or
Meteora DLMM pool address on the list page to list one. It prices the market
like any USDC; the market still settles in test USDC.

A token listed on devnet is not the mainnet token. Its mint is a devnet
test mint and the listing does not carry over.

## Rewards for devnet creators

The markets don't carry over, but the work does. People who list and grow
markets on devnet get two things at mainnet launch:

- **Points,** credited from a snapshot of their devnet markets.
- **A fee discount** on mainnet trading.

A creator's score is counted by the devnet server from the fills it settles:

1. A market's traders are the wallets with $100 or more of filled volume in
   it, maker or taker, opens and closes together. Liquidations don't count.
2. Each wallet counts once per market, however much it trades there.
3. The market's deployer never counts in its own market, and neither do the
   server's own wallets (the market maker, the pool authority).
4. A creator's score is the sum of their markets' traders.

The rewards page shows each of your markets' traders and your score, and
ranks every creator under the points leaderboard. The points per trader,
the discount and its length are published here before mainnet.

## Your wallet signs everything

Every order, close, deposit, withdrawal and backing is signed by the wallet
you connect. Without one, the site shows prices, charts and markets, and the
trade buttons ask you to connect; there is no shared demo account to trade.

A transaction's notice turns to done once the transaction is confirmed (the
`confirmed` commitment, about a second), not finalized, and links it on
Solscan. A transaction that lands but fails says so. Program errors are
shown as one short line (for example "Price moved, try again" for
`SlippageExceeded`); the full list is in `web/src/lib/errors.ts`, and the
web build fails if it no longer matches the program's errors. A balance the
site could not read shows as unavailable with a retry, never as zero.

## First connection

The first time a wallet connects, the site shows three screens once: what
the venue is, the two ways in (trading, or backing a market and the pool),
and the risks: liquidation, backing's first loss, and the price feed. The
last screen asks the wallet to sign a short message recording that these
were read. It is a message, not a transaction, so it costs nothing and moves
nothing. The acceptance is kept in that browser for that wallet; closing the
screens without signing is kept too, so they are not shown again. The text
is in `web/src/components/Welcome.tsx`.

The site also tells the server a wallet's address when it connects (once a
browser session) and sends the signed message once it is signed, so
connected wallets can be counted. The server keeps only the address, when it
was first and last seen, and when it signed; it checks the signature against
the wallet's key. One caller can add at most 10 unsigned wallets a day.
`GET /api/wallets` returns the counts: `connected`, `signed`, `active24h`,
`active7d`, and `since`, the time of the first record.

## Points on devnet

Devnet USDC comes from a faucet, so trading fees cost nothing real and a
round trip between two of your own wallets would otherwise be free points.
Devnet runs the same rules as mainnet (see [Referrals and points](rewards.md)):

1. 0 points for an open. 2 points per $1 closed after 10 minutes held, 0
   before.
2. 250,000 trading points per wallet per UTC day.
3. Referrers earn points only after a referee has $1,000 of held volume.
4. Deployers earn nothing on their own trades.

Wallets from before these rules have their `Trader` account grown once by
`resize_trader`, which anyone may send; `scripts/resize-markets.ts` does it
for all of them after a deploy.

## What differs from mainnet

- Prices for the equities come from a relay that posts Jupiter quotes on
  chain in Pyth's format, because Pyth's own feeds need a paid key. Only the
  trading calendar comes from Pyth. Mainnet reads Pyth directly.
- The popular-token pools are moved by one process, not by organic trading.
  Their depth is set by the seeding script, about 55,000 USD within the band
  depth is measured over.
- A market maker quotes on the devnet markets so orders have something to
  meet other than the pool (see [The auction](auction.md)).
