# About

## Overview

unwind makes two choices most perpetual venues do not.

1. Markets are opened, not listed.
2. Price comes from crossing orders, not from a pricing function over
   deposits.

Each removes a component: the listings desk, and the curve.

## Markets are opened, not listed

Any account can open a market against any asset whose price is readable on
chain.

| Price source | How the market is priced |
| --- | --- |
| Pyth feed | The feed, read directly. Prices only move forward in time. |
| Raydium CLMM or Meteora DLMM pool, quoted in USDC or USDT | The mark keeper reads the pool and pushes the price. The market trades from the first push, within about 25 seconds of listing. |

Spam is held off by cost, not permission:

1. A market earns its opener nothing until people trade it.
2. A market takes no position until somebody posts the collateral it is
   allowed to lose. The site lists and backs in one transaction, with at
   least $100.
3. That budget is capped by what the tracked pool's depth can absorb.
4. Whoever posts it takes the market's first loss and is paid for it: half
   of the liquidity pool's share of the market's fees, 30% of every fee on
   the default split.

The same pool or feed can be listed again. Each listing is a new generation
at its own address, so a bad first listing blocks nobody (see
[How to open a market](how-to-open-a-market.md)).

## Price is determined by the batch

Orders collect for 1 second and clear as two auctions: takers buying against
makers selling, and takers selling against makers buying. Each clears at the
one price that crosses the most volume. The pool fills only the takers makers
leave standing, and never trades with a maker.

The book makes the price, so there is no index basis for funding to close.
Funding moves money from the heavier side of open interest to the lighter
one, so the pool does not carry the imbalance. Borrow charges both sides for
the pool capital they use (see [Funding](funding.md)).

## Consequences

1. **Arrival time inside a window carries no weight.** No latency race, no
   priority lane to sell.
2. **Liquidation is permissionless.** It does not wait on a keeper. It acts
   on the market's risk price, which moves at most 40 bps a slot toward the
   oracle, so a one-reading spike liquidates nobody.
3. **Budgets go down by anyone, up only by money.** Anyone can cut a market's
   budget to its pool's measured depth. The pool authority can lower it. Only
   a backing deposit raises it. Depth alone never does: depth can be rented
   for one transaction, and an account that could mint a budget from depth
   would be writing its own allowance.
