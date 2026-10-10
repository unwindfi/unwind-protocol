# Price sources

Every market has one reference mark. The mark breaks the last tie in the
auction, sets the band orders clear inside, prices the pool's quote, values
positions, and drives liquidation through the risk price. It never sets a
clearing price on its own.

A market takes its mark from one of two sources, fixed at listing:

1. a **Pyth feed**, or
2. an **observed pool** on Raydium CLMM or Meteora DLMM.

## Key figures

| | |
| --- | --- |
| Risk price step | 40 bps of itself per slot, at most 3 slots counted: 1.2% per step |
| Pyth publish time ahead of the chain clock | at most 5 seconds |
| Pyth verification | full Wormhole verification only |
| Maximum price age on a site listing | 120 seconds |
| Observed mark, fold weight | at most 10% per reading |
| Observed mark, move per reading | at most 1% |
| Observed readings that move the mark | 1 per second |
| Seasoning without a keeper | 30 readings over at least 15 minutes |
| Keeper pass | every 25 seconds, median of the last 5 reads |
| Quiet keeper mark pushed | about every 50 seconds |
| Keeper circuit breaker | moves over 10% held one pass, then walked 10% a pass |
| Pushed mark against the pool | refused over 10% from the pool's price in the same transaction |
| Confidence from depth | 50 bps at $10,000 of depth, scaled by `10,000 / depth` |

## Prices only move forward

Every instruction that writes a market records the publish time and price it
used. Three rules follow:

1. A price older than the newest the market has acted on is refused. A price
   stays valid for a while after it is published, and without this the
   sender could pick the most favorable one in that window, for example a
   liquidator picking the one that liquidates.
2. A second, different price under a publish time already used is refused.
   The same price may be used again.
3. A Pyth price published more than 5 seconds ahead of the chain's clock is
   refused. One price from the future would hold the market to that time and
   refuse every honest price after it. The 5 seconds cover the cluster clock
   trailing wall time.

Valuing the pool for a deposit or claim only reads a market, so it records
nothing, but it still refuses a price older than the newest the market has
used. Custody tokens are held to the future rule and their maximum age, not to
the ordering rule: they are only ever read.

## The risk price

Liquidation does not read the oracle directly. Each market keeps a risk price
that follows the oracle at a capped speed:

```
step  = 40 bps × min(slots since last step, 3)
risk' = risk moved toward oracle by at most step × risk
```

That is 1% a second at 400 ms slots, and at most 1.2% per accepted price. A
market nobody holds a position in follows the oracle at once, since a jump
there liquidates nobody.

Every instruction that accepts a price steps the risk price: clearing a
batch, firing a trigger, liquidating, and the permissionless
`step_risk_price` crank. The venue's keeper calls the crank for any market
with a position past its margin.

Where the two differ, money is priced at the worse of the two for whoever
moves it:

| Action | Price used |
| --- | --- |
| Liquidation trigger | risk price |
| Liquidation close | worse of risk price and oracle, for the position |
| LP deposit | whichever values the pool higher |
| LP claim | whichever values the pool lower |

A spike that comes back moves the risk price one step at most, and a
liquidation needs the risk price itself to cross the position's margin.

Every market's maintenance margin must cover one full step plus its
liquidation fee: at least 120 bps above the fee. See
[Margining](margining.md).

## Pyth feeds

A Pyth market reads the feed on every instruction. The update must be fully
verified, match the market's feed id, be no older than the market's maximum
age, and carry a confidence no wider than the market's ceiling.

The confidence widens the pool's quote:

```
spread = min(base_spread + confidence × conf_mult, max_spread)
```

Past the ceiling the market stops quoting. The ceiling is per market. A
tokenized asset's basis against its underlying is structural, and one global
threshold would either halt some markets for good or be too loose to catch a
real decoupling elsewhere.

## Observed pools

A market with no Pyth feed reads a spot pool:

| Pool | Mark from | Depth from |
| --- | --- | --- |
| Raydium CLMM | current price | liquidity a 1% move crosses |
| Meteora DLMM | active bin | bins a 1% move crosses |

Rules fixed at listing:

1. The pool's quote side must be USDC or USDT (Circle's devnet USDC on devnet
   builds), or the token the pool settles in. A pool quoted in a token the
   lister minted is refused.
2. The kind of pool is recorded, and the pool is checked on every reading, so
   the market cannot be repointed at a pool someone just created.
3. A DLMM pair's token decimals are checked against its mints once.
4. Only the market's lister creates the observation. Its fold weight, clamp
   and unit are fixed from then on. A market observed with settings nobody
   wants can be listed again as the next generation (see
   [How to open a market](how-to-open-a-market.md)).

### Depth sets confidence

```
confidence_bps = 50 × 10,000 / depth_usd
```

| Depth (cost of a 1% move) | Confidence |
| --- | --- |
| $100,000 | 5 bps |
| $10,000 | 50 bps |
| $1,000 | 500 bps |
| $100 | 5,000 bps |

A site listing halts at 5,000 bps, a pool under about $100 deep. Unmeasured
depth reads as no depth and halts.

Depth also sets leverage (see [Margining](margining.md)) and caps the loss
budget (see [Loss budget](loss-budget.md)). Depth is read on chain in the same
transaction as every push or reading, never taken from the keeper.

### The mark keeper

The venue's mark keeper prices observed markets:

1. Every 25 seconds it reads each pool off chain and pushes the median of its
   last 5 reads. One block of someone moving the pool moves nothing.
2. A mark that would move less than 5 bps is left alone while it stays under
   55 seconds old and well inside the market's maximum age. A quiet market is
   pushed about every 50 seconds; a moving one every pass.
3. A move over 10% from the mark on chain is held for one pass, then walked
   toward the new price 10% a pass. A crash crosses each liquidation price on
   the way down instead of jumping past it.
4. A market is tradeable from the keeper's first push, seconds after listing.

On devnet, a test copy of a real token is marked at the real token's price
from Jupiter, and its devnet pool is read only for depth.

`push_mark` reads the pool's own price in the same transaction and refuses any
mark more than 10% from it. Inside that band the price is taken as given,
bounded otherwise by staleness and the confidence its depth allows. So the
keeper picks the mark and the pool decides the range it may be picked from: a
lost keeper key cannot price a market at a number the asset does not trade at,
only somewhere within 10% of where it does, and moving that range means moving
the pool, which is what the depth cap on the budget already prices.

The pool authority names the keeper with `set_mark_keeper`; setting the empty
key stops every push. A keeper that stops, or one whose prices the band
refuses, leaves its marks to go stale, and a stale mark halts its market. The
pool's spot is recorded beside every pushed mark, so any gap is on chain.
While a mark is past its market's maximum age the API reports the market as
not tradeable and the site shows it as Paused.

### Without a keeper

The permissionless `observe` crank folds pool readings into a moving average:

```
folded = mark × (1 - α) + spot × α        α ≤ 10%
mark'  = folded, clamped to mark ± 1%
```

1. Only the first reading in any second moves the mark, so many cranks in one
   transaction move it once.
2. Doubling a mark takes about 70 readings, over 70 seconds at least.
3. The mark trades only once 30 readings span 15 minutes.
4. A Raydium pool with history can start seasoned at its own 15 minute
   average, if its spot sits within 3% of that average.

Once a keeper has priced a market, `observe` updates its depth and leaves its
price alone.

## Units

A mark is kept to six decimals of a dollar, which reads a token worth a
fraction of a cent as nothing. Such a market is quoted per thousand, million
or billion tokens, fixed at listing. Bonk at 0.0000038 USD is quoted as 3.81
USD per 1M.
