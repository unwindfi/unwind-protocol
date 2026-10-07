# Funding

Funding keeps open interest balanced, so the pool is not left holding the net
delta of the traders it filled. It does not close a basis to an index: the
book sets the clearing price.

Two charges fold into one cumulative index per side.

| Leg | Paid by | Received by | Driven by |
| --- | --- | --- | --- |
| Borrow | both sides | the pool | how far the book leans on the pool |
| Skew | the heavier side | the lighter side | open interest imbalance |

## Key figures

| | Site listing |
| --- | --- |
| Borrow rate at 100% utilization | 1 bp an hour |
| Skew sensitivity (`funding_k`) | 100 bps: 1 bp an hour per 1% of skew |
| Skew rate cap | 100 bps an hour |
| Permissionless cap on the skew rate | 200 bps an hour |
| Longest single accrual | 8 hours |
| Rate precision | whole bps an hour, rounded down |
| Funding crank on devnet | every 5 minutes |

## Formulas

**Borrow.** Utilization is the market's net open interest as a share of the
pool's liquidity. A balanced book leans on the pool for nothing, so it borrows
nothing.

```
utilization = min(|longs - shorts| / pool liquidity, 100%)
borrow_rate = borrow_rate_per_hour × utilization
```

Both sides pay `borrow_rate` on their notional.

**Skew.**

```
skew      = (heavy - light) / (heavy + light)
skew_rate = min(funding_k_bps × skew, max_funding_rate_per_hour)
```

The heavy side pays `skew_rate` on its notional. The light side receives the
same total, so its rate per dollar is scaled up:

```
credit_rate = skew_rate × heavy / light
```

The skew leg moves money between traders and mints none. When it does not
divide evenly, the remainder stays with the pool. When one side is empty, the
skew leg is skipped: there is nobody to pay. The borrow leg already charges
for the exposure.

Each rate is computed in whole bps an hour, rounded down. On a site listing
the borrow leg therefore reads zero until utilization reaches 100%. The skew
leg reads zero below 1% of skew, rises 1 bp an hour per whole percent, and
reaches its 100 bps cap only when one side is empty of the other.

## Numerical example

A site listing with $30,000 of longs and $10,000 of shorts on a $1,000,000
pool.

1. Utilization: $20,000 / $1,000,000 = 2%. Borrow: 1 × 2% = 0.02 bps,
   rounded down to 0.
2. Skew: ($30,000 - $10,000) / $40,000 = 50%. Skew rate: 100 × 50% = 50
   bps an hour, under the 100 bps cap.
3. Longs pay 50 bps an hour: $150.
4. Shorts receive 50 × $30,000 / $10,000 = 150 bps an hour: $150.

At that rate the heavy side pays 0.5% of its notional an hour. The pull
weakens as the book comes back to balance, and stops below 1% of skew.

## How it is charged

1. Every settled fill, fired trigger and liquidation accrues the index to now
   first. The permissionless `accrue_funding` crank keeps it moving when
   nobody trades.
2. One accrual counts at most 8 hours, so a crank that stalls (or a clock
   that jumps) cannot wipe out positions in one step.
3. A position owes `size × (index now - index at entry)`.
4. Adding to a position blends its entry index by size. The old size keeps
   owing from where it started; the new size owes from now.
5. Closing part of a position settles the funding on the part that closes.
   The rest keeps owing from where it started, so a small close never clears
   funding the remainder has built up.
6. Funding owed counts against margin: leverage on an add and equity for
   liquidation are both net of it.

Funding and borrow owed count in the pool's value before positions close. See
[The pool](pool.md).

## On the trade screen

The market header shows the 1h funding rate. The Funding tab beside Positions
lists each open position with its entry and mark, its side's rate per hour, what the next hour
costs or pays at that rate, and the funding paid so far. With nothing open, it
shows the market on screen's current rates for longs and shorts.
