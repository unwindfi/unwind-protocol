# Price sources

## Overview

Every market carries a reference mark, which is used to break ties in the
auction, to value open positions for margin purposes, and to close positions
during deleveraging. It is not used to set the clearing price, which is
produced by the book.

A market takes its mark from one of two sources, fixed when the market is
opened.

A market's price only moves forward in time. Every instruction that reads a
mark records the publish time of the price it used, and refuses a price older
than one the market has already acted on. A price stays valid for a short
window after it is published, and without this rule whoever sent the
instruction could choose the most favourable price inside that window, for
example a liquidator picking the one that liquidates. With it, the newest price
is the only one there is.

Two more rules close the gaps around it. A second, different price under a
publish time the market has already used is refused, so two updates published
in the same second are not a choice either; the same price may be used again.
And a price published more than 5 seconds ahead of the chain's clock is
refused, because one accepted price from the future would hold the market to
that time and refuse every honest price after it. The 5 seconds allow for the
cluster clock trailing wall time. Valuing the pool for a deposit or a
withdrawal only reads a market, so it cannot record a price, but it still
refuses one older than the newest the market has acted on. Custody tokens are
held to the future-time rule and their maximum age, not to the ordering rule:
custodies are only ever read, never written, when they are priced.

## The risk price

Liquidation does not read the oracle directly. Each market keeps a risk price
that follows the oracle at a capped speed: every accepted price steps it
toward that price by at most 40 basis points of itself per slot since the last
step, counting at most 3 slots. That is 1 percent a second at 400ms slots, the
same speed an observed mark is clamped to, and at most 1.2 percent per step.
A market nobody holds a position in follows the oracle at once, since a jump
there can liquidate nobody.

So a price that spikes and comes back moves the risk price at most one step,
and a liquidation needs the risk price itself to have crossed the position's
margin. Every instruction that reads a market's price steps it: clearing a
batch, firing a trigger order, liquidating, deleveraging, and the
permissionless `step_risk_price` crank, which the venue's keeper calls for any
market with a position past its margin.

Where the two differ, money moving out is priced at the worse of the two for
the mover. A liquidation closes at the worse of the risk price and the oracle
for the position. A deposit values the pool at the higher of the two values,
and a withdrawal claim at the lower.

## Pyth feeds

A market opened against a Pyth feed reads that feed directly. The feed's
reported confidence interval is used to widen the pool's quote, so that a mark
the oracle is less certain about produces a less aggressive quote.

Each market configures a maximum confidence above which it stops quoting
entirely. The threshold is per market rather than global, because the basis a
tokenized asset carries against its underlying is structural rather than
incidental, and a single global threshold would either halt some markets
permanently or be too loose to detect a genuine decoupling elsewhere.

## Observed pools

A market opened without a Pyth feed is pointed at a spot pool quoted in USDC
or USDT and observed over time. Two kinds of pool can be read:

* **Raydium concentrated liquidity.** The mark is read from the pool's
  current price, and depth from the liquidity a one percent move crosses.
* **Meteora DLMM.** The mark is read from the active bin, and depth from the
  bins a one percent move crosses. The pair's token decimals are checked
  against its mints once, when the market is opened.

Which kind a market reads is recorded when it is opened, and the pool is
checked on every reading, so a market cannot be repointed at a pool someone
has just created. The quote side is checked too: it must be USDC, USDT or the
token the venue settles in, so a pool quoted in a token its lister minted is
refused at listing.

Depth also sets the confidence a pool's mark is quoted at. A pool that can
absorb 10,000 USDC is quoted at a band of 50 basis points, and one a tenth as
deep at ten times that, so the pool's quote widens, and eventually halts, as
the tracked liquidity thins.

The mark itself is pushed by the venue's mark keeper. The keeper reads the pool off-chain about every 25 seconds
and pushes the median of its last five readings, so one block of someone
moving the pool does not move the mark. A market is tradeable from the
keeper's first push, seconds after it is opened.

The program still reads the pool in the same transaction as every push. Depth,
and with it confidence, leverage and the cap on a market's budget, comes from
that on-chain reading, never from the keeper. The pool's spot is recorded
beside the pushed mark, so any gap between the two is on chain.

What this trusts is the keeper key: the mark is the price it pushes. The pool
authority names that key with `set_mark_keeper`, and setting it to the empty
key stops every push. A keeper that stops pushing leaves its marks to go
stale, and a stale mark halts its market rather than trading on an old price.

Without a keeper, the permissionless `observe` crank still folds pool readings
into a moving average with a bounded move per update, and such a mark trades
only once thirty readings span fifteen minutes. A reading counts for at most
10 percent of the mark and moves it at most 1 percent, and only the first
reading in any second moves it, so every crank in one transaction moves the
mark once. Doubling a mark takes about seventy readings, seventy seconds
apart at least. Once the keeper has priced a
market, `observe` updates its depth and leaves its price alone.

## Units

A mark is kept to six decimals of a dollar, which would read a token worth a
fraction of a cent as nothing at all. Such a market is quoted per thousand,
per million or per billion tokens instead, fixed when it is opened. Bonk at
0.0000038 USD is quoted as 3.81 USD per 1M.
