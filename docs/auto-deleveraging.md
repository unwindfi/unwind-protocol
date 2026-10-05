# Profit haircuts

## Overview

A market pays its winners no more than it was underwritten for. Nothing is
set aside when a position opens. Instead, when a winning position closes and
its market cannot cover every winner in full, profit is paid at a fair share
and the rest is not paid. Losses are always collected in full.

This replaced auto-deleveraging, which closed winners at the reference mark
once their profit outgrew a reserve held against them. No position is
deleveraged any more; the instruction stays on chain and refuses every
position.

## The order of protections

A market's losses are paid from three places, in sequence.

1. **Backing.** Collateral posted by whoever underwrote the market is
   consumed first.
2. **Pool liquidity,** up to the market's loss budget.
3. **Insurance fund,** only for what pool liquidity cannot cover.

None of it is paid past the market's remaining loss budget.

## How the share is worked out

When a winning position closes, it is owed its profit: its equity, less the
close fee, past the collateral it put up. It is paid

```
paid = owed * min(1, available / winners)
```

* `available` is what the market can still pay: its remaining loss budget, or
  the money there is to pay with (its backing, LP liquidity and the insurance
  fund), whichever is smaller.
* `winners` is the profit every winning side of the market holds at the
  closing price.

Every winner is paid the same fraction, whoever closes first. Example: two
longs are each up $500 and the market has $400 left. Each is paid $200 of its
profit, in either order, and keeps its collateral.

A close always fills in full. Before this, a winning close filled only as far
as the budget reached, so a winner in a market that had spent its budget could
not leave at all.

The haircut is recorded on chain with each close (`ProfitHaircut`), and the
trade screen shows the current rate as **Profit paid** in the market header,
and beside any winning position, whenever it is below 100%.

## Why winners carry it

This is the rule that keeps markets separate. Without it, a market that had
spent its budget would pay its winners from the shared pool and the insurance
fund, which is capital put up for every other market. One mispriced or
manipulated market could then drain liquidity that never underwrote it. The
same limit applies to liquidations: a liquidated position is never paid profit
past its market's budget.

Holding capital back against every open position was the other way to do it,
and it froze backing a balanced book never needed. The haircut puts the risk
on unrealised profit instead: capital is only committed once a loss is
realised.
