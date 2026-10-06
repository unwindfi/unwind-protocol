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
* `winners` is the profit every winning position in the market holds at the
  closing price, counted gross: a loser does not offset a winner. The closing
  position's own side is never counted below what this close is owed.

Every winner is paid the same fraction, whoever closes first. Example: two
longs are each up $500 and the market has $400 left. Each is paid $200 of its
profit, in either order, and keeps its collateral.

The market does not walk its positions. It keeps three sums per side: total
size, size over entry, and size over entry squared. From those it reads an
upper bound on each side's gross winners:

```
winners on a side <= (net + sqrt(S * M2)) / 2
```

where `S` is the side's size, `net` its net profit, and `M2` the sum of each
position's size times its return squared. The bound is exact when every
position on a side has the same entry, and a little high when entries spread.
Because it is never low, no close is paid more than its fair share of what is
left; when it is high, winners are paid slightly less than a full share.

A close takes its own size over entry off its side, so the side's average
entry stays the mean of the positions still open. It used to stay where it
was: a $100k long from $100 closed at $200 beside a $100k long opened at $200
left the side at $100k from $133.33, up $50,000 at $200 while the position
left was flat. That phantom profit counted against LP shares and as winners
here.

Example: at $110, long A (entry $100, $5,000) is up $500, long B (entry $120,
$6,000) is down $500, short C (entry $120, $6,000) is up $500, and $500 is
left. The long side nets to zero, but its bound reads $502.08. Winners count as
$1,002.08, so whoever of A and C closes first is paid $249.48. If A goes first,
C is then the only winner left and takes the remaining $250.52. If C goes
first, A is paid $249.48. No order pays past the budget, and neither closer is
paid more than $250.

Positions opened before these sums existed are not in them. A side holding
one counts net, the earlier rule, until that position closes; adding to it
brings the whole position into the sums. A split or other corporate action
empties the sums for the same reason, and the market counts net until the
positions open at the time have closed or been added to.

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
