# Funding

## Overview

Funding on unwind is not a mechanism for closing a basis between the
perpetual and an index, because the clearing price is produced by the book
rather than by a pricing function anchored to the oracle. It exists to keep
open interest balanced, so that the liquidity pool is not left holding the
net delta of the traders it has filled.

Two separate charges are accrued and folded into a single cumulative index
per side.

| Leg | Paid by | Received by | Scales with |
| --- | --- | --- | --- |
| Borrow | Both sides | The pool | Pool utilization |
| Skew | The heavier side | The lighter side | Open interest imbalance |

The borrow leg is charged to both sides because both sides are renting the
pool's balance sheet. The skew leg transfers between traders and is
conserved, so no value is created by it.

## Technical details

The borrow rate scales linearly with utilization from a configured rate at
full utilization:

```
borrow_rate = borrow_rate_per_hour * utilization
```

The skew rate is a configured sensitivity applied to the imbalance between
the two sides, subject to a per market ceiling:

```
skew      = (heavy - light) / (heavy + light)
skew_rate = min(funding_k * skew, max_funding_rate_per_hour)
```

The heavier side is charged the skew rate on its notional. The lighter side
receives the same total amount, which means its per dollar credit is the
heavy side's per dollar charge scaled by the ratio of the two sides:

```
credit_per_dollar = skew_rate * heavy / light
```

When one side is empty the skew leg is skipped, because there is no
counterparty to receive the transfer. Utilization is necessarily high in that
state, so the borrow leg is already charging for the exposure the pool
carries.

## Numerical example

Take a market with a borrow rate of 5 basis points per hour at full
utilization, a skew sensitivity of 20, and the following state:

1. Long open interest: 300,000 USDC
2. Short open interest: 100,000 USDC
3. Pool utilization: 60 percent

The borrow rate is 5 × 0.60 = 3 basis points per hour, charged to both sides.

The imbalance is (300,000 − 100,000) / 400,000 = 50 percent, so the skew rate
is 20 × 0.50 = 10 basis points per hour, charged to longs.

Longs therefore pay 13 basis points per hour in total, being 3 borrow and 10
skew. Shorts pay 3 basis points of borrow and receive 10 × 300,000 / 100,000
= 30 basis points of skew, for a net receipt of 27 basis points per hour.

In absolute terms, longs pay 300 USDC of skew per hour and shorts receive 300
USDC of skew per hour, confirming that the leg transfers rather than mints.
The pool receives 90 USDC from longs and 30 USDC from shorts in borrow.

## Partial closes

Funding is owed in proportion to size. Closing part of a position settles the
funding on the part that closes, and the rest keeps owing from where it
started. A small close therefore never clears the funding the remainder has
built up.

## On the trade screen

The Funding tab beside Positions lists each open position with its side's
current rate per hour, what the next hour costs or pays at that rate, and the
funding it has paid so far. With no position open, it shows the rates longs
and shorts pay in the market on screen.
