# Clearing

## Overview

Orders submitted to a market accumulate for five seconds in a set that
carries no ordering. When the window closes, the batch is cleared as a dual
flow batch auction: two separate auctions, each at its own single price.

Every order is either a **maker** or a **taker**. A maker rests as liquidity
and names the price it will trade at. A taker comes to trade against it.

* The **buy flow** matches takers who are buying against makers who are
  selling.
* The **sell flow** matches takers who are selling against makers who are
  buying.

Takers only ever trade with makers, and makers only ever trade with takers.
Two takers never trade with each other, and neither do two makers.

Within each flow, the batch is cleared at the single price that crosses the
greatest volume, and every order that trades in that flow trades at that
price regardless of the limit it carried. A taker whose limit was well above
the buy flow's price pays the buy flow's price. Every order fills at its limit
or better.

Because arrival time carries no weight inside the window, there is no
advantage to submitting early and no priority that can be purchased. Ties are
resolved the way an opening auction resolves them.

## Why two flows

With one price for the whole batch, a taker's price was set as much by other
takers as by anyone offering liquidity, and a maker could be filled by
another maker who had simply crossed further. Splitting the flows means a
taker only ever pays a price some maker asked for, and a maker only ever
trades against flow that came to it. A maker can quote knowing exactly who it
will meet.

## Technical details

Each flow's clearing price is selected by the following rules, applied in
order:

```
price  = argmax   volume crossed
tie    -> argmin   |demand - supply|
tie    -> argmin   |price - reference mark|
```

The third rule is reached only when the book is indifferent across a range of
candidate prices, which occurs on thin markets with a wide gap between the
best bid and the best offer. It is the only point at which the oracle
influences a clearing price.

Fills are allocated within each flow by price priority and then pro rata at
the marginal price. Allocation is deliberately not first come, because time
priority at the clearing price would restore a reason to submit earlier and
reintroduce the race the batch exists to remove.

Nothing clears outside a band around the oracle mark, in either flow. The
band is the narrower of the market's widest spread and half its maintenance
margin. Without it, two accounts belonging to one person could cross each other
at any price they liked, far from the market, and the one marked in profit
would be paid by the pool. Half the maintenance margin means a position opened
at either edge of the band is never already past its own liquidation.

No order fills more than its own size, and each side of a flow is allocated
only what that side trades. These rules, and the others the clearing relies
on, are proven for every input within bounds; see [Verification](verification.md).

The [pool](pool.md) fills takers that the makers leave standing, and never
fills a maker. A maker whose quote nobody took is refunded when the batch
seals and quotes again into the next one.

## Numerical example

Consider a batch containing the following orders:

* Taker bids: 100 at 10.05, 200 at 10.00
* Maker asks: 150 at 9.95, 100 at 10.00, 100 at 10.10
* Taker asks: 120 at 9.85
* Maker bids: 80 at 9.90, 60 at 9.80

The buy flow holds the taker bids and the maker asks:

1. At 10.00, taker demand is 300 and maker supply is 250, so 250 crosses.
2. At 9.95, taker demand is 300 and maker supply is 150, so 150 crosses.
3. At 10.05, taker demand is 100 and maker supply is 250, so 100 crosses.

The buy flow clears at 10.00. The taker bidding 10.05 fills all 100 at 10.00
and the taker bidding 10.00 fills 150 of its 200. Both makers asking at or
below 10.00 fill in full at 10.00. The maker asking 10.10 does not trade. If
the pool is quoting, it may sell the second taker its remaining 50 at 10.00.

The sell flow holds the taker ask and the maker bids:

1. At 9.90, maker demand is 80 and taker supply is 120, so 80 crosses.
2. At 9.85, maker demand is 80 and taker supply is 120, so 80 crosses, with
   the same imbalance. The tie goes to the price nearer the reference mark.

With the mark at 10.00, the sell flow clears at 9.90. The taker selling fills
80 of its 120 at 9.90, above its 9.85 limit, and the maker bidding 9.80 does
not trade. If the pool is quoting, it may buy the taker's remaining 40 at
9.90.

## Opening auction

A market the mark keeper prices trades from its first price, so it has no
opening auction. One only happens without a keeper, while the `observe` crank
builds a mark: orders submitted then rest, and all of them clear together in
the market's first batch, by the same rules as any other batch. See
[Price sources](price-sources.md).
