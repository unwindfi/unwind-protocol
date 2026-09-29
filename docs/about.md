# About

## Overview

unwind is a perpetual futures venue whose two defining decisions are that
markets are opened rather than listed, and that price is determined by
crossing orders rather than by a pricing function over deposits. Neither
decision is a feature added to a conventional design; each removes a
component that conventional designs require.

## Markets are opened, not listed

Opening a market is a signed transaction that any account may send, against
any asset whose price is readable on chain. A market with a Pyth feed uses
that feed directly. A market without one is pointed at a Raydium or Meteora
spot pool, and trades from the mark keeper's first price push, seconds after
opening.

The defence against spam is cost rather than permission. A newly opened
market earns its opener nothing and cannot be traded against until somebody
has posted the collateral it is permitted to lose, and that budget is capped
at what the tracked asset's own liquidity can absorb. Whoever posts it is paid
for carrying that first loss, with half of the liquidity pool's share of the
market's fees.

## Price is determined by the batch

Orders accumulate for one second and clear as two auctions: takers buying
against makers selling, and takers selling against makers buying, each at the
single price that crosses the most volume. The liquidity pool fills only the
takers makers leave standing, and never trades with a maker.

Because the clearing price is produced by the book, there is no perpetual to
index basis for funding to close. Funding exists solely to keep open interest
balanced so that the pool does not accumulate directional exposure.

## Consequences

Arrival time within a window carries no weight, so latency confers no
advantage and no priority lane exists to be sold. Liquidation is
permissionless, which removes the dependency on a keeper remaining
available. A market's loss budget may be lowered by anyone as liquidity
drains. It rises only when somebody posts backing; the pool authority can lower it
but never raise it. Depth alone never raises it, because depth
is temporarily purchasable and an account able to mint a budget from depth
would be authorising its own allowance.
