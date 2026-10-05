# The pool

## Overview

The liquidity pool fills takers that makers leave standing. In the buy flow
it sells to takers who are buying, and in the sell flow it buys from takers
who are selling, at the price the makers set when there is one and at its own
quote when there is not. It never trades with a maker. It is a backstop in the
auction rather than the mechanism that prices it, and a flow in which makers
fill every taker allocates none of that fill to the pool.

The pool never sells below its ask or buys above its bid. When makers leave
takers standing at a price inside the pool's quote, the flow clears at the
pool's quote instead if that crosses more volume with the pool counted in.
With 10,000 of takers buying and one maker asking 10 at the mark, the flow
clears at the pool's ask: the maker sells its 10 there and the pool sells
up to its cap. Without this, a small maker quoting inside the spread every
batch kept the pool out of the flow.

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
* If every LP has withdrawn, any USDC left behind (a last withdrawal's fee, a
  trader's later loss) belongs to
  nobody. It is moved to the insurance fund before the next deposit lands,
  so the next depositor gets exactly what they paid for.

Open positions count at what can actually change hands. Traders down count
for no more than the collateral they posted, less what a close would hand back
to backers drawn on earlier. Traders up count for no more than their market's
remaining budget, less the backing that pays them first. Example: a $50,000
short with $5,000 posted, after the mark doubles, adds $5,000 to the pool's
value, not $50,000.

If a market with open positions cannot be priced (a stale feed, or a pool
drained until its quote halts), a deposit waits. A withdrawal does not: it
counts that market as if its winners took all its remaining budget past its
backing, so the LPs who stay are never short and one market cannot lock the
pool.

Withdrawals pay a share of the pool's value, never more. Nothing is reserved
for open positions: a winner is paid only out of its market's remaining
budget, so LP liquidity that leaves is not owed to anyone's open profit.

What traders are up is read from the pool's valuation checkpoint rather than
from every market inside the deposit itself. A deposit or withdrawal that
carried every market with open interest stopped fitting in a Solana
transaction once about two dozen markets had positions, and then nobody could
enter or leave the pool. The checkpoint is a pass anyone may run
(`checkpoint_aum`): it adds the markets with open interest in increasing
address order over as many transactions as it needs, and completes when it
has counted all of them. A deposit or withdrawal accepts only a completed
checkpoint under a minute old, taken while the same set of markets carried
open interest; the pool records a version that changes whenever that set
does, so a checkpoint from before a market gained or lost its positions is
refused. The venue's server runs a pass every twenty seconds, and before
building a deposit or withdrawal if the last one is older than 45 seconds.

## Batch reporting

Each batch publishes the portion of the fill taken by the pool. Where makers
fill every taker, that figure is zero. On a market nobody is making yet, it is
all of the fill, and the price is the pool's quote. The figure is shown per
market so that difference is visible.
