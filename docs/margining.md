# Margining

Margin is isolated. Each position posts its own collateral, risks only that
collateral, and is liquidated on its own. There is no cross margin and no
portfolio margin.

## Key figures

| | Site listing | Permissionless bounds |
| --- | --- | --- |
| Maximum leverage | up to 5x, and never past the depth tier | at most 5x |
| Maintenance margin | 1,000 bps (10%) | at least 500 bps |
| Liquidation fee | 100 bps | below maintenance |
| Maintenance floor | 120 bps + liquidation fee | same, on every market |
| Minimum position | $10 | at least $10 |

## Opening

```
leverage = size / (collateral - open fee)       must be ≤ effective max
```

Collateral is escrowed when the order is submitted. The part an unfilled
order does not use comes back at settlement.

Adding to a position checks the grown position on collateral net of the
funding it already owes. So an add to a position near the cap fits only at
a lower leverage than the market's maximum, and an add to a position already
past it (the cap fell after it opened) fits only once the order is large
enough to bring the whole position back under. The trade ticket caps its
leverage slider at what the grown position allows and says when that is
below the market's maximum. When a market's maximum falls while the ticket is
open, the ticket lowers the chosen leverage to it and says so. The entry blends as the notional-weighted harmonic
mean:

```
entry = (s1 + s2) / (s1 / p1 + s2 / p2)
```

Example: $1,000 at $100 and $1,000 at $200 is 10 + 5 = 15 units for $2,000,
an entry of $133.33. The arithmetic mean, $150, would pay a short more than
its lots made and a long less. With the harmonic mean the position's PnL
equals the PnL of its fills taken one by one.

## Effective maximum leverage

```
effective max = min(listed max, closed-session max if closed, depth tier)
```

The depth tier applies only to markets priced off a spot pool.

### Leverage follows depth

Depth is what it costs to move the tracked pool 1%. Higher leverage means a
smaller move reaches a liquidation, and the move is what an attacker pays for.

| Sustained depth | Maximum leverage |
| --- | --- |
| under $10,000 | 2x |
| $10,000 to $50,000 | 3x |
| $50,000 to $250,000 | 4x |
| $250,000 and above | 5x |

Sustained depth:

1. falls to any lower reading at once,
2. rises toward a higher reading by 10% of the gap, at most once every 20
   seconds, however often the pool is read,
3. never passes the next tier's floor in one rise.

Liquidity parked in a pool for one reading, however large, buys at most one
tier, and the next honest reading takes it back. A new market opens at 2x and
earns its tier over depth that stayed. When the pool thins, the tier falls on
the next reading, before the next order is accepted.

## Maintenance margin

A position is liquidatable when its equity, at the risk price, falls below
its maintenance margin:

```
equity      = collateral + PnL - funding owed
PnL         = size × (exit / entry - 1)        long
              size × (1 - exit / entry)        short
exit        = risk price less the spread, on the closing side
liquidate   if equity < size × maintenance_bps / 10,000
```

Two constraints on every market, checked at listing and on every parameter
change:

1. **Maintenance below initial margin.** Initial margin, 1 / max leverage,
   must exceed maintenance: 5x is 20%, above 10%. A position opened at full
   leverage is not already liquidatable.
2. **Maintenance covers one risk price step plus the fee.** The risk price
   moves at most 120 bps per step (40 a slot, 3 slots; see
   [Price sources](price-sources.md#the-risk-price)). So maintenance must be
   at least 120 bps above the liquidation fee. A position healthy before a
   step still has its fee left after it, and a liquidation is paid out of the
   position, not out of the pool.

A site listing at 1,000 bps maintenance and a 100 bps fee clears the floor of
220 bps by 780.

The auction's band is at most half the maintenance margin, so a position
opened at either edge of the band starts with at least half its maintenance
margin standing.

## Sessions

While a tokenized stock's exchange is closed, its maximum leverage and open
interest cap tighten. Maintenance does not change. See
[Sessions](sessions.md).

## On the trade screen

The header and each position row show one mark, the pool mid. PnL is taken at
the price a close would fill at: the bid for a long, the ask for a short. The
two differ by half the spread, shown in the header as its own figure.
