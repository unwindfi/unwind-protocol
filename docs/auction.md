# The auction

Every market clears in batches. A batch collects orders for 1 second, then
clears as a dual flow batch auction: two auctions, each at one uniform price.
Arrival order inside the window counts for nothing.

## Key figures

| | |
| --- | --- |
| Batch window | 1 second from the moment the batch opens |
| Orders per batch | 64, for everyone |
| Resting orders per wallet per batch | 4 |
| Life of an order | 1 batch |
| Price band | ± the narrower of the market's widest spread and half its maintenance margin |
| Band on a site listing | ± 5% of the mark (2,000 bps spread cap, 1,000 bps maintenance) |

## Makers, takers and the two flows

Every order is a maker or a taker.

* A **maker** rests at a price it names. It trades only with takers.
* A **taker** wants a fill this batch. It trades with makers, and with the
  [pool](pool.md) when makers leave it standing.

The batch splits into two auctions:

1. **Buy flow:** takers buying against makers selling.
2. **Sell flow:** takers selling against makers buying.

Two takers never trade with each other. Two makers never trade with each
other. The pool never fills a maker. A taker only ever pays a price some maker
asked for, or the pool's own quote.

Within a flow, every order that trades pays that flow's clearing price,
whatever limit it carried. No order fills worse than its limit.

## How a flow picks its price

Each candidate price is a limit price in the flow. The winner is chosen by
these rules, in order:

```
1. most volume crossed
2. tie -> least |demand - supply|
3. tie -> closest to the oracle mark
4. tie -> the lower price
```

Rule 3 is the only place the oracle touches a clearing price. It is reached
when the book is indifferent across a range, which happens on a thin market
with a wide gap. Rule 4 makes the result the same for every order of the book.

Fills are allocated by price priority, then pro rata at the marginal price.
There is no time priority at the margin, so submitting earlier is worth
nothing.

## The band

Before clearing, every order is held inside a band around the oracle mark:

```
band = min(max_spread_bps, maintenance_margin_bps / 2)
lo   = mark - band
hi   = mark + band
```

A bid above `hi` bids `hi`. An ask below `lo` asks `lo`. A bid below `lo` or
an ask above `hi` stays where it is and does not cross. Every price that
trades lands inside the band, the pool's included.

Without it, two accounts owned by one person could cross at any price far
from the market, and the pool would pay the one marked in profit. Half the
maintenance margin means a position opened at either edge is never already
past its own liquidation.

## Rules that keep the batch honest

1. **One direction per wallet.** A wallet cannot hold opening orders on both
   sides of one batch. Positions do not flip, so only one side could ever
   book, and the wallet could choose by settlement order which leg went home.
2. **No clear in the slot the book last changed.** Every order placed or
   cancelled records its slot. `clear_batch` is refused in that slot. Whoever
   clears cannot also be the last to change the book, in the same
   transaction, with the book and the oracle in view.
3. **Opens are checked at submit.** Side, leverage and the open interest cap
   are checked when an open enters the batch. Open interest counts every open
   already resting on the same side, so a side ends a batch at its cap at most.
4. **Settlement books every filled open.** It does not ask the caps again. A
   refusal there would depend on which order a caller settled first, and
   would leave the order it crossed booked against the pool alone.
5. **The price is fixed at the seal.** Between clearing and the last
   settlement the batch is sealed and refuses new orders and cancels.

## What happens to each order

* **Filled.** Settles at its flow's price. An open's unused collateral comes
  back at settlement.
* **Partly filled.** The filled part books. The rest goes home. Nothing rolls
  into the next batch.
* **Not filled.** Goes home at settlement with its collateral. A maker whose
  quote nobody took quotes again into the next batch.
* **Nothing crossed in either flow.** The batch still seals. Every order in it
  settles unfilled and is refunded. Without this, 64 orders priced never to
  cross could hold every slot for good.

The last settlement opens the next batch. Clearing and settlement are
permissionless and take no price from the caller.

## Numerical example

A batch on a market with the mark at 10.00:

* Taker bids: 100 at 10.05, 200 at 10.00
* Maker asks: 150 at 9.95, 100 at 10.00, 100 at 10.10
* Taker ask: 120 at 9.85
* Maker bids: 80 at 9.90, 60 at 9.80

**Buy flow** (taker bids against maker asks):

| Price | Taker demand | Maker supply | Crossed |
| --- | --- | --- | --- |
| 9.95 | 300 | 150 | 150 |
| 10.00 | 300 | 250 | 250 |
| 10.05 | 100 | 250 | 100 |

Clears at 10.00. The 10.05 bid fills 100 at 10.00. The 10.00 bid fills 150 of
200. Both asks at or under 10.00 fill in full. The 10.10 ask does not trade.
If the pool's ask is at or under 10.00, it sells the last 50 at 10.00.

**Sell flow** (taker ask against maker bids):

| Price | Maker demand | Taker supply | Crossed | Imbalance |
| --- | --- | --- | --- | --- |
| 9.85 | 80 | 120 | 80 | 40 |
| 9.90 | 80 | 120 | 80 | 40 |

Volume and imbalance tie, so rule 3 picks 9.90, nearer the 10.00 mark. The
taker sells 80 of 120 at 9.90, above its 9.85 limit. The 9.80 bid does not
trade. If the pool's bid is at or above 9.90, it buys the last 40 at 9.90.

## Opening auction

A market priced by the mark keeper trades from its first push and has no
opening auction. Without a keeper, a new observed market cannot clear until
its mark is seasoned (30 readings over at least 15 minutes, see
[Price sources](price-sources.md)). Orders placed in that time rest, and all
clear together in the first batch.

## On devnet

The venue's server runs the crank. It clears and settles every market with
orders about once a second, and checks idle markets every 4 seconds. It also
runs a small maker that quotes 10 bps either side of the mark, up to $2,000 a
quote, only in batches where a taker is waiting.

An order signed while its batch is sealed is held by the server and sent
again every 1.5 seconds, up to 8 times, so it lands in the next batch instead
of coming back rejected.

The clearing rules are proven for every input within bounds. See
[Verification](verification.md).
