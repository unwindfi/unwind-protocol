# The pool

## Overview

The liquidity pool fills takers that makers leave standing. In the buy flow
it sells to takers who are buying, and in the sell flow it buys from takers
who are selling, at the price the makers set when there is one and at its own
quote when there is not. It never trades with a maker. It is a backstop in the
auction rather than the mechanism that prices it, and a flow in which makers
fill every taker allocates none of that fill to the pool.

## Technical details

The pool's participation in any single window is capped at five percent of
the market's remaining loss budget. Flow in excess of that cap must find a
maker or wait for a subsequent batch. Each flow may use the whole cap: the
pool sells in one flow and buys in the other, so what it takes in one offsets
the other, and its net position from a batch never exceeds the cap.

The cap serves two purposes. It prevents the pool from becoming the effective
price for large orders, which would make the venue pool priced in practice
regardless of how the auction is specified. It also ensures that a market
whose budget has been exhausted ceases to quote rather than quoting into
exposure it cannot fund.

## Depositing and withdrawing

Liquidity providers receive shares priced against what the pool is worth:
its USDC and the tokens it holds in kind together, less what traders are
currently up. Trader profit is a claim on all of it, so it is taken from the
total, not from the USDC alone.

A deposit mints shares at that price, rounded down, so a depositor never
receives more than they paid for and rounding never costs the LPs already in.
The first deposit into an empty pool mints one share per dollar and must be at
least the pool minimum, which keeps a single share's price from being
inflated.

Two cases refuse a deposit or change what it buys:

* If traders are up more than the whole pool holds while shares are still
  outstanding, the pool is worth nothing and takes no new liquidity until that
  turns. New money cannot be priced against shares worth zero without paying
  for the hole under them.
* If every LP has withdrawn, any USDC left behind that is not reserved for
  open positions (a last withdrawal's fee, a trader's later loss) belongs to
  nobody. It is moved to the insurance fund before the next deposit lands,
  so the next depositor gets exactly what they paid for.

Withdrawals pay a share of the pool's value, never more, and only from
liquidity that is not reserved for open positions.

## Batch reporting

Each batch publishes the portion of the fill taken by the pool. Where makers
fill every taker, that figure is zero. On a market nobody is making yet, it is
all of the fill, and the price is the pool's quote. The figure is shown per
market so that difference is visible.
