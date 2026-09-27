# Margining

## Overview

Margin on unwind is isolated. Every position posts its own collateral, risks
only that collateral, and is liquidated independently of any other position
held by the same account. There is no cross margin mode and no portfolio
margining.

Collateral is escrowed when an order is submitted rather than when it fills,
because an order resting against a batch is a commitment to trade at that
batch's clearing price. Any portion of the order that does not fill returns
its escrowed collateral at settlement.

## Leverage and maintenance margin

Each market configures a maximum leverage and a maintenance margin, and the
two are constrained relative to each other. The maintenance margin must sit
below the initial margin implied by the maximum leverage, because a position
opened at the maximum permitted leverage would otherwise be liquidatable at
the moment it was opened. The program rejects a configuration in which this
does not hold.

Both parameters are per market. While the tracked asset's session is closed,
maximum leverage and the open interest cap tighten; the maintenance margin
does not change.

## Leverage follows depth

A market priced off a spot pool may carry only the leverage that pool's depth
supports. Depth is what it costs to move the pool one percent. Higher leverage
means a smaller move reaches a liquidation, and a move is what an attacker has
to pay for, so a pool that is cheap to push gets less leverage.

| Sustained depth | Maximum leverage |
| --- | --- |
| Under 10,000 USD | 2x |
| 10,000 to 50,000 USD | 3x |
| 50,000 to 250,000 USD | 4x |
| 250,000 USD and above | 5x |

The depth used is sustained depth, not the last reading. It falls to any lower
reading at once and rises toward a higher one by a tenth of the gap, at most
once every twenty seconds however often the pool is observed, and never past
the next tier in one rise. Liquidity parked in a pool for a moment, even a
very large amount, buys at most one tier until the next reading takes it
back, and a new market opens at 2x and earns its tier over depth that stayed. When the pool
thins, the cap falls on the next reading, before the next order is accepted.

The cap is written onto the market by every observation and checked on every
open. It never lifts a market past the leverage it was listed with, and it
does not apply to a market priced off a Pyth feed.

## Position valuation

Open positions are valued against the market's reference mark rather than
against the last clearing price. The mark is the market's price source, which
is a Pyth feed or an observed spot pool depending on how the market was
opened.
