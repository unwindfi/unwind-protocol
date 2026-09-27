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
has just created.

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
only once thirty readings span fifteen minutes. Once the keeper has priced a
market, `observe` updates its depth and leaves its price alone.

## Units

A mark is kept to six decimals of a dollar, which would read a token worth a
fraction of a cent as nothing at all. Such a market is quoted per thousand,
per million or per billion tokens instead, fixed when it is opened. Bonk at
0.0000038 USD is quoted as 3.81 USD per 1M.
