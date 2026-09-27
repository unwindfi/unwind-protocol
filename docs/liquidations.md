# Liquidations

## Overview

A position whose equity has fallen through its maintenance margin may be
closed by any account. Liquidation is permissionless, and the account that
performs it is paid out of the liquidation fee configured by that market.

The fee is split like every other fee. The protocol, insurance and chain cuts
(20, 10 and 10 percent) stay in the pool, and the account that performs the
liquidation receives the remaining 60 percent, the share the liquidity pool
takes on other fees. The fee comes out of the position's remaining equity and
never out of pool capital, so a position already through zero pays none.

## Why liquidation is permissionless

The operation accepts no price and no discretionary input. It reads the
market's mark, evaluates whether the position's equity has fallen below the
maintenance margin, and closes it if so.

Restricting that to a designated keeper would therefore add a dependency
without adding a safeguard: a keeper cannot produce a better outcome than an
arbitrary caller, but a keeper that stops running prevents the outcome
entirely. Clearing and settlement are permissionless on the same grounds.

The consequence is that a stalled crank cannot produce an incorrect outcome.
The worst it can do is leave orders resting where their owners placed them.

## When liquidation is insufficient

A liquidation can complete at a price past zero equity, leaving the
position's collateral short of its losses. Equity is floored at zero: the
position loses its collateral, pays no fee, and the pool books a smaller gain
than the mark implied. Nothing is owed after that.

A liquidated position that is in profit is never paid past its market's
budget. See [Auto-deleveraging](auto-deleveraging.md).
