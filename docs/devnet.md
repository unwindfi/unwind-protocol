# Devnet

## Overview

Devnet is the full venue running on Solana's devnet network. Orders, batches,
liquidations, listings and backing are the same program and the same site as
mainnet will use. Everything settles in test USDC, which has no value.

The site shows a Devnet label beside the wordmark while it is connected to
the devnet server. Set your wallet to devnet to connect.

## Getting test funds

Connect a devnet wallet on the trade page. With nothing to trade with, the
order ticket shows **Get test USDC**, which sends 10,000 test USDC and, when
the wallet holds too little for fees, 0.05 devnet SOL. Each wallet can use it
once a day.

## Markets

- **Equities.** SPYx, CRCLx and COINx, priced from Jupiter quotes that a relay posts on
  chain in Pyth's format. On
  weekends and outside US trading hours they run in their closed session at
  lower leverage (see [Sessions](sessions.md)).
- **Popular Solana tokens.** SOL, JUP, BONK, WIF, JTO, PYTH, RAY, TRUMP,
  PENGU, FARTCOIN, POPCAT, RENDER, HNT, ORCA and DRIFT. These are test copies:
  devnet tokens under the real tickers, each in a Meteora DLMM pool against
  test USDC. A server process reads the real token's price on mainnet
  (Jupiter) every two minutes and swaps in the devnet pool until it matches,
  so the markets move the way the real tokens do. They are listed through the
  ordinary permissionless path, priced from their pools like any market
  somebody opens (see [Price sources](price-sources.md)).
- **WIND, KITE and YAK.** Invented tokens with their own pools, left for
  testers to list and back. They follow the percentage moves of BONK, JUP and
  WIF.

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

## What differs from mainnet

- Prices for the equities come from a relay that posts Jupiter quotes on
  chain in Pyth's format, because Pyth's own feeds need a paid key. Only the
  trading calendar comes from Pyth. Mainnet reads Pyth directly.
- The popular-token pools are moved by one process, not by organic trading.
  Their depth is set by the seeding script, about 55,000 USD within the band
  depth is measured over.
- A market maker quotes on the devnet markets so orders have something to
  meet other than the pool (see [The auction](auction.md)).
