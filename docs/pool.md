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
On top of the cap, the pool takes trades that shrink the position it already
holds against traders, up to the imbalance between longs and shorts: those
cost it no budget, and capping them made exits from a thinly backed market
wait batch after batch.

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
has counted all of them. A deposit or a withdrawal claim accepts only a
completed checkpoint under a minute old, taken while the same set of markets carried
open interest; the pool records a version that changes whenever that set
does, so a checkpoint from before a market gained or lost its positions is
refused. The venue's server runs a pass every twenty seconds, and before
building a deposit or claim if the last one is older than 45 seconds.

Each pass keeps two sums from the same readings, because a market's risk
price (see [Price sources](price-sources.md)) can trail its oracle after a
move. The deposit sum counts each market at whichever of the two leaves the
pool worth more, so a depositor buys fewer shares; the claim sum counts it at
whichever leaves the pool worth less, so a leaver is paid less. Neither side
can time its move against the gap.

### Withdrawing takes two steps

There is no instant withdrawal. Leaving the pool is a request, a wait, and a
claim:

1. `request_withdraw` moves the xLP into an escrow account the pool controls.
   Nothing is paid yet.
2. The shares wait 150 slots, about one minute.
3. `claim_withdraw` burns them and pays their part of the pool at the claim,
   less the withdrawal fee: USDC, and the same part of any tokens the pool
   holds in kind (see below).

Escrowed shares are not burned until the claim, so they stay in the share
supply and take their part of every gain and loss for the whole wait. Example:
50,000 of 1,000,000 shares are requested while the pool is worth $1,000,000.
Traders go up $100,000 before the claim. The claim pays 5% of $900,000, which
is $45,000, not the $50,000 the shares were worth at the request.

That is what the wait is for. With an instant withdrawal, an LP who could see a
loss coming (a feed about to update, a mark about to catch up) could leave at
the old value and leave the loss with everyone who stayed. A move takes longer
than a few slots to reach the price, so a few slots would protect nothing; 150
covers it without locking anyone in.

The shares are escrowed rather than timed in the wallet because xLP moves
freely. A timer on the wallet would reset by sending the tokens to another one.

The claim runs every check a withdrawal always ran: the pool must not be
paused, only free liquidity can leave, the pool keeps its minimum while
positions are open, and a market that cannot be priced counts at its worst.
A claim may take part of what is escrowed; the rest stays claimable. Adding
to an open request restarts the 150 slots for all of it.

`cancel_withdraw` returns every escrowed share at any time, paused or not.
Escrowed shares earn no points; a cancel puts them back on the wallet's
points stake.

### Tokens are paid out in kind

When a market's losses run past its USDC backing, the backing pays the LPs in
the tokens it was posted in (see
[How to underwrite a market](how-to-underwrite-a-market.md)). Those tokens
count in the pool's value, and they leave the pool the same way they came in:
as tokens. A claim of `f` of the share supply is paid:

1. USDC: `f` of what the pool is worth without those tokens, its USDC less
   what traders are up.
2. Tokens: `f` of what the LPs hold in each token, rounded down.

Example: the pool holds $1,000,000 USDC and 2,000 SOL for 1,000,000 shares.
A claim of 50,000 shares (5%) is paid $50,000 USDC and 100 SOL. Paid all in
USDC, it took $50,000 plus the SOL's value out of the USDC, and the last LPs
to leave were left with tokens and no USDC.

The tokens owed are fixed at the claim, against the share supply that claim
burns, and leave the pool's holdings with it. The next claim takes the same
part per share of what remains; rounding leaves dust with the LPs who stay,
never takes it from them. The last claim, of every share left, takes every
token. The withdrawal fee comes off the tokens as it does off the USDC, and
stays with the pool.

If traders are up by more than the pool's USDC, the excess is a claim on the
tokens too, and the tokens owed are cut by the same proportion, so a claim
never takes more than its part of the pool's whole value. A claim that pays
no USDC (all of the value is in tokens) still pays its tokens.

Sending each token in the claim would mean carrying every token's vault in
one transaction, so the claim records what it is owed instead and
`claim_withdraw_tokens` sends one token at a time. Earn shows each one with a
claim button. Only the owner can pull them, and nothing done after the claim
changes the amounts.

A deposit still pays for the tokens. Shares are priced against the USDC and
the tokens together, at the price that makes the pool worth more, so a new LP
buys into the tokens rather than being handed part of them.

## Batch reporting

Each batch publishes the portion of the fill taken by the pool. Where makers
fill every taker, that figure is zero. On a market nobody is making yet, it is
all of the fill, and the price is the pool's quote. The figure is shown per
market so that difference is visible.
