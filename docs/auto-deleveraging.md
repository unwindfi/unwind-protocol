# Auto-deleveraging

## Overview

Deleveraging closes a winning position at the reference mark once its profit
outgrows the reserve locked against it, or once its market's budget can no
longer pay it. It is what keeps a market from paying its winners more than it
was underwritten for.

## The order of protections

A market's losses are paid from three places, in sequence.

1. **Backing.** Collateral posted by whoever underwrote the market is
   consumed first.
2. **Pool liquidity,** up to the market's loss budget.
3. **Insurance fund,** only for what pool liquidity cannot cover.

Two limits sit around them.

* **Utilization cap.** The pool never locks more than its configured ceiling
  against open positions, so a single market cannot commit the entire
  balance sheet.
* **Deleveraging.** A winner is never paid past its reserve or its market's
  budget. It is closed at the mark instead.

## When a position is deleveraged

A winning position may be deleveraged in either of two cases:

* Its profit has grown past the reserve locked against it.
* Its market's remaining loss budget can no longer pay what it is owed past
  its collateral, counting funding it has received as well as price profit.

The second case matters because a closing order fills only as far as the
budget can pay. Without it, a winner in a market that had spent its budget
could neither close nor be deleveraged. That includes a position that is up
only on funding, at an unchanged price: it is healthy, so it cannot be
liquidated, and the batch will not close it. Deleveraging closes it at the oracle
mark, not at a batch price, so the trader being paid cannot steer the price
it closes at.

## When the budget cannot cover the profit

A market pays its winners no more than it was underwritten for. When a
position is deleveraged, its owner receives their collateral back plus as much
of the profit as the market's remaining loss budget still covers. Any profit
beyond that is not paid.

This is the rule that keeps markets separate. Without it, a market that had
spent its budget would pay its winners from the shared pool and the insurance
fund, which is capital put up for every other market. One mispriced or
manipulated market could then drain liquidity that never underwrote it. The
same limit applies to liquidations: a liquidated position is never paid profit
past its market's budget.

The shortfall is recorded on chain with each deleveraging, so how much profit a
market could not pay is always visible.

## What deleveraging means for a trader

A deleveraged position is closed at the market's reference mark, and the
trader receives the position's value at that price, up to what the market's
budget can pay (see above). The position does not
continue, and profit that would have accrued after the close is not realised.

Deleveraging is not a penalty and does not indicate that the position was
mismanaged. It is the mechanism by which a market's losses are prevented from
propagating to capital that did not underwrite that market.
