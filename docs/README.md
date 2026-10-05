---
cover: .gitbook/assets/unwind-cover.png
coverY: 0
---

# unwind

## What is unwind?

unwind is a perpetual futures venue on Solana in which every market clears by
dual flow batch auction and any market can be opened by anyone. Orders
submitted inside a one second window are collected without order. Takers
buying meet makers selling, takers selling meet makers buying, and each of
those two auctions settles at the single price that crosses the most volume
in it, so that every participant who trades in a given flow trades at the same
price.

The venue has no continuous order book and no listings process. Clearing,
settlement and liquidation are each permissionless, because none of them
accepts a price or any other discretionary input from the party that runs
them. The one price the venue takes from a key is the mark of a market priced
from a spot pool, which the pool's mark keeper pushes (see
[Price sources](price-sources.md)).

## Design

Two properties account for most of the system's behaviour, and the rest of
these pages are consequences of them.

The first is that price formation happens entirely within the batch. The
liquidity pool quotes into each auction as one participant among others
rather than as a curve, so the clearing price is a function of submitted
orders and not of pool reserves or deposits. The oracle is consulted only to
break a tie when the book is indifferent across a range of prices.

The second is that the market list is not curated. Opening a market is a
signed transaction against any asset whose price can be read on chain, and
what each market is permitted to lose is derived from the liquidity of the
asset it tracks rather than granted by an administrator.

## Status

The program is unaudited. It runs on devnet with test funds (see
[Devnet](devnet.md)); mainnet trading stays off until it is audited.

The source is public at
[github.com/prarimz/unwind](https://github.com/prarimz/unwind): the program,
its proofs, the server and the site.

{% hint style="warning" %}
Nothing in this documentation is investment advice. An unaudited program
holding collateral carries risk that should be priced accordingly.
{% endhint %}

The program is the specification. Where these pages and the source disagree,
the source is correct.

## Risk Hub

The site's `/risk` page lists every parameter the program holds each market
to, read live (leverage, maintenance margin, fees, backing, budget, open
interest, price source), the pool's liquidity, utilisation and insurance
fund, and the rules behind them in short, each linked to its page here.
