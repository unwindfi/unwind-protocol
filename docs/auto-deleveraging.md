# Profit haircuts

A market pays its winners no more than it was underwritten for. Nothing is
set aside when a position opens. When a winning position closes and its
market cannot cover every winner in full, profit is paid at a fair share and
the rest is not paid. Losses are always collected in full.

There is no auto-deleveraging. The `auto_deleverage` instruction stays on
chain so its address and accounts do not change, and refuses every position.

## Key figures

| | |
| --- | --- |
| Paid on a winning close | collateral + profit × min(1, available / winners) |
| `available` | min(remaining budget, backing + LP liquidity + insurance fund) |
| `winners` | upper bound on gross profit, both sides, at the closing price |
| Closer's own side | never counted below what this close is owed |
| Liquidated winner | at most collateral + remaining budget |
| Recorded on chain | `ProfitHaircut` event, per close |
| Shown on screen | "Profit paid" in the market header, when below 100% |

## The formula

A closing position is owed its equity, less the close fee, past the collateral
it put up:

```
owed  = max(equity - close fee - collateral, 0)
paid  = owed × min(1, available / winners)
```

* `available` is what the market can still pay: its remaining loss budget,
  or the money there is to pay with, whichever is smaller.
* `winners` is the profit every winning position in the market holds at the
  closing price, counted gross. A loser does not offset a winner, on either
  side: a loser's loss is not money the market holds until that loser closes.

Every winner is paid the same fraction, whoever closes first. Example: two
longs are each up $500 and the market has $400 left. Each is paid $200 of its
profit, in either order, and keeps its collateral.

## Counting winners without walking positions

The market keeps three sums per side over its positions: size, size over
entry, and size over entry squared. From those it reads an upper bound on the
side's gross winners:

```
winners on a side ≤ (net + sqrt(S × M2)) / 2
```

`S` is the side's size, `net` its net profit, and `M2` the sum of each
position's size times its return squared. The bound is exact when every
position on the side has the same entry, and a little high when entries
spread. It is never low, so no close is paid more than its fair share. When
it is high, winners are paid slightly less than a full share.

A winner hidden behind a loser on the same side is still counted. A side
holding a position opened before these sums existed counts at its net profit
until that position closes or is added to. A corporate action empties the sums
the same way (see [Corporate actions](corporate-actions.md)).

A close takes its own size over entry off its side, so the side's average
entry stays the harmonic mean of the positions still open.

## Worked example

At $110, with $500 available and close fees left out:

| Position | Side | Entry | Size | PnL |
| --- | --- | --- | --- | --- |
| A | long | $100 | $5,000 | +$500 |
| B | long | $120 | $6,000 | -$500 |
| C | short | $120 | $6,000 | +$500 |

The long side nets to zero, but its bound reads $502.08. Winners count as
$502.08 + $500 = $1,002.08.

| Order | First close paid | Second close paid |
| --- | --- | --- |
| A then C | A: $249.48 | C: $250.52, the rest |
| C then A | C: $249.48 | A: $249.48 |

No order pays past the budget, and neither closer is paid more than $250.

## Order of protections

A market's losses are paid from three places, in sequence, and never past its
remaining loss budget:

1. **Backing**, posted by whoever underwrote the market.
2. **LP liquidity.**
3. **Insurance fund**, only for what liquidity cannot cover.

## Why winners carry it

This keeps markets separate. Without it, a market that had spent its budget
would pay its winners from the shared pool and the insurance fund, capital
put up for every other market. One mispriced or manipulated market could drain
liquidity that never underwrote it.

Holding capital against every open position was the other way, and it froze
backing a balanced book never needed. The haircut puts the risk on unrealised
profit instead. Capital is committed only once a loss is realised.

A close is never shrunk by the haircut. It fills what the auction gives it,
and only the profit it is paid is cut. A winner in a market that has spent its
budget can always leave.
