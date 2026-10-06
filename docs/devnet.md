# Devnet

## Overview

Devnet is the full venue running on Solana's devnet network. Orders, batches,
liquidations, listings and backing are the same program and the same site as
mainnet will use. Everything settles in test USDC, which has no value.

The site shows a Devnet label beside the wordmark while it is connected to
the devnet server. Set your wallet to devnet to connect.

## Getting test funds

Connect a devnet wallet. With nothing to trade with, the order ticket shows
**Get test funds**, and the list and earn pages show it above the form when
the wallet has no test USDC or too little SOL for rent. It sends 10,000 test
USDC and, when the wallet holds under 0.1 SOL, 0.2 devnet SOL: enough to
list a few markets and trade for a day. Each wallet can use it once a day. The
faucet gives out 10 SOL a day in all; past that it still sends USDC, and SOL
comes from devnet's own faucet.

## Markets

- **Equities.** SPYx, CRCLx and COINx, priced from Jupiter quotes that a relay posts on
  chain in Pyth's format. On
  weekends and outside US trading hours they run in their closed session at
  lower leverage (see [Sessions](sessions.md)).
- **Popular Solana tokens.** 47 of them: SOL, JUP, BONK, WIF, JTO, PYTH, RAY,
  TRUMP, PENGU, FARTCOIN, POPCAT, RENDER, HNT, ORCA, DRIFT, PUMP, STONK, ZEC,
  cbBTC, HYPE, USELESS, BP, wNEAR, ETH, CARDS, ANSEM, MET, JLP, CATE, JitoSOL,
  GRASS, ORE, ANTFUN, ZCAT, KMNO, GEOD, NOS, MPLX, neet, DBR, BOME and ZBCN,
  plus the xStocks SPCXx, NVDAx, GLDx, TSLAx and AAPLx. These are test copies:
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
- **Any other Solana token, copied on request.** Search a mainnet token on
  the list page and devnet offers **Copy to devnet** for anything it has no
  pool for. The copy is made like the 47 above: a devnet test token under the
  real ticker and decimals, in a Meteora DLMM pool against test USDC at the
  real price, held there and marked at it the same way. Its liquidity is
  scaled to the real token's: half its mainnet liquidity a side, between
  $5,000 and $180,000, so the depth limits a listing gets are about the ones
  it would get on mainnet. The copy is not listed; listing it is the same
  permissionless step as any other pool. The token needs $10,000 of mainnet
  liquidity and a Jupiter price. Devnet makes one copy per token, up to 30 a
  day in all and 5 a day from one address.
- **WIND, KITE and YAK.** Invented tokens with their own pools, left for
  testers to list and back. They follow the percentage moves of BONK, JUP and
  WIF.

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

A market scores by the number of different wallets that traded it, each
wallet counted once and capped, so trading your own market from many
wallets adds little. The exact scoring, the discount and its length are
published here before mainnet.

## Your wallet signs everything

Every order, close, deposit, withdrawal and backing is signed by the wallet
you connect. Without one, the site shows prices, charts and markets, and the
trade buttons ask you to connect; there is no shared demo account to trade.

## First connection

The first time a wallet connects, the site shows three screens once: what
the venue is, the two ways in (trading, or backing a market and the pool),
and the risks: liquidation, backing's first loss, and the price feed. The
last screen asks the wallet to sign a short message recording that these
were read. It is a message, not a transaction, so it costs nothing and moves
nothing. The acceptance is kept in that browser for that wallet; closing the
screens without signing is kept too, so they are not shown again. The text
is in `web/src/components/Welcome.tsx`.

## What differs from mainnet

- Prices for the equities come from a relay that posts Jupiter quotes on
  chain in Pyth's format, because Pyth's own feeds need a paid key. Only the
  trading calendar comes from Pyth. Mainnet reads Pyth directly.
- The popular-token pools are moved by one process, not by organic trading.
  Their depth is set by the seeding script, about 55,000 USD within the band
  depth is measured over.
- A market maker quotes on the devnet markets so orders have something to
  meet other than the pool (see [The auction](auction.md)).
