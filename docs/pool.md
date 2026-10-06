# The pool

The pool is liquidity of last resort. It fills takers the makers leave
standing, at the makers' price when there is one and at its own quote when
there is not. It never trades with a maker. In a flow where makers fill every
taker, its share is zero.

## Key figures

| | |
| --- | --- |
| Pool size per batch, per flow | 5% of the market's remaining loss budget |
| Extra size for trades that shrink the pool's position | up to the long/short imbalance |
| Pool quote | mark ± spread, held inside the band |
| Spread | `base_spread + confidence × conf_mult`, at most `max_spread` |
| Spread on a site listing | 20 bps base, 1x confidence, 2,000 bps cap |
| Deposit fee (devnet pool) | 0 |
| Withdrawal fee (devnet pool) | 5 bps |
| First deposit | at least 1 USDC, 1 share per dollar |
| Withdrawal wait | 150 slots, about 1 minute |
| Valuation checkpoint | completed, under 60 seconds old |

## How the pool fills

1. The book clears first, without the pool (see [The auction](auction.md)).
2. If takers are left standing and the clearing price is at or through the
   pool's quote, the pool fills them at the clearing price, up to its size.
   In the buy flow it sells. In the sell flow it buys.
3. If takers are left standing at a price inside the pool's quote, the flow
   clears at the pool's quote instead, when that crosses more volume with the
   pool counted in.
4. If nothing in the book crosses, the pool fills the standing takers at its
   own quote, up to its size.

Rule 3 stops a dust maker from switching the pool off. Example: 10,000 of
takers buy and one maker asks 10 at the mark, inside the pool's ask. The book
alone crosses 10 at the mark. Cleared at the pool's ask instead, the maker
sells its 10 there and the pool sells up to its size. The flow clears at the
ask.

The pool never sells below its ask and never buys above its bid.

## The size cap

The pool takes at most 5% of the market's remaining loss budget per flow per
batch. It sells in one flow and buys in the other, so its net position from
one batch never passes the cap.

On top of the cap, it takes trades that shrink the position it already holds
against traders, up to the imbalance between longs and shorts. With traders
net long, the pool is net short, and takers selling bring it back toward
flat. Those cost no budget, and capping them made exits from a thinly backed
market wait batch after batch.

Two reasons for the cap:

1. The pool cannot become the price for anything large. Flow past the cap
   has to find a maker or wait.
2. A market whose budget is spent stops quoting.

## Batch reporting

Each batch publishes what the pool bought and sold (`BatchCleared`,
`pool_bought` and `pool_sold`). On a market with real makers that figure falls
toward zero. On a market nobody is making yet it is the whole fill, and the
price is the pool's quote.

## What the pool is worth

```
pool value = USDC liquidity
           + LP-held tokens at the oracle
           - what the pool owes traders, from the checkpoint
```

What the pool owes on each market counts only what can actually change hands:

| Traders are | Counted at |
| --- | --- |
| Down | at most their collateral, less what a close repays backers drawn on earlier |
| Up | at most the market's remaining budget, less the backing that pays first |

Funding and borrow owed count before positions close. A close takes them out
of equity and leaves them with the pool, so they are the pool's as they
accrue. Skew funding, paid by one side to the other, nets out. A market
counts funding only while every position on both sides is in its tracking
sums; a corporate action empties those sums until the positions open at the
time close or are added to.

Examples:

1. A $50,000 short with $5,000 posted, after the mark doubles, adds $5,000 to
   the pool's value, not $50,000.
2. $100,000 of longs and no shorts on $1,000,000 of liquidity: utilization
   is 10%. At a 10 bps borrow rate, longs owe 1 bp an hour, $10. After 720
   hours the pool counts $7,200 owed. Closing them moves it into liquidity
   without changing what the pool is worth.

### Two sums: deposit side and claim side

Each checkpoint keeps two sums from the same readings. Each is the worse one
for the LP moving money.

| | Deposit sum | Claim sum |
| --- | --- | --- |
| Risk price vs oracle | whichever leaves the pool worth more | whichever leaves it worth less |
| Losers past their collateral | netted against other collateral | counted as bad debt, upper bound |
| Market that cannot be priced | deposit refused | counted at its worst |

A market's risk price can trail its oracle after a move (see
[Price sources](price-sources.md#the-risk-price)). Valuing at the worse of the
two means a depositor buys fewer shares and a leaver is paid less, so nobody
can time a move against the gap.

The claim side also bounds bad debt. Market wide, losers' losses are capped by
all their collateral together, so one position past its collateral would net
against another's. Each side keeps the least collateral per dollar of size,
net of funding, that any of its positions holds, and its worst entry. When
even that worst case is not past its collateral, nothing changes. When it
could be, the claim counts traders as owed an upper bound on the shortfall.

Example: two $100,000 longs from $100, one on $10,000 and one on $50,000, at
$85. Each is $15,000 down. The first can pay only $10,000.

| | Deposit counts | Claim counts |
| --- | --- | --- |
| At $85 | $30,000 owed to the pool | $20,000 |
| At $95 | $10,000 | $10,000 |

A market whose price cannot be read counts, on the claim side, as if its
winners took all its remaining budget past its backing. One stalled feed
cannot lock the pool.

## The valuation checkpoint

Deposits and claims read what traders owe from a checkpoint, not from every
market inside the transaction. Carrying every market stopped fitting in one
Solana transaction at about two dozen markets with positions.

1. `checkpoint_aum` is permissionless. It adds the markets with open interest
   in increasing address order, over as many transactions as it needs.
2. It completes when it has counted every market with open interest.
3. A pass left open for more than 30 seconds can be restarted by anyone.
4. A deposit or claim accepts only a completed checkpoint under 60 seconds
   old, taken while the same set of markets carried open interest. The pool
   keeps a version that changes whenever a market gains its first position
   or loses its last.

### Drift keeps it exact

A close after the checkpoint moves PnL into or out of liquidity while the
checkpoint still counts it as owed. So every write that changes what a market
owes the LPs books the change into a running total on the market and on the
pool, measured at the market's latest oracle price:

* a fill, a close, a liquidation
* backing in or out
* a budget cut

A pass records each market less its total at that moment. A deposit or claim
adds the pool's total back.

Example: the pool holds $1,000,000 and longs are $100,000 down at the
checkpoint, so the pool is worth $1,100,000. The longs are liquidated and
$100,000 moves into liquidity. A claim in the same transaction still values
the pool at $1,100,000, not $1,200,000.

A checkpoint counts funding up to the moment of the pass. What accrues after
counts from the next pass, the same as a price move.

### On devnet

The venue's server runs a pass every 20 seconds, and before building a deposit
or claim if the last one is older than 45 seconds. A signed deposit or claim
that meets a stale checkpoint is not handed back as an error: the server runs
a fresh pass and sends the same transaction again, up to 3 times.

## Depositing

1. Shares are priced at the deposit sum.
2. A deposit mints `net × supply / value`, rounded down. Rounding never costs
   the LPs already in.
3. The first deposit into an empty pool must be at least 1 USDC and mints one
   share per dollar.
4. A pool with shares outstanding and a value of zero or less takes no
   deposit until that turns.
5. USDC left in a pool with no shares (a last leaver's fee, a later trader
   loss) is moved to the insurance fund before the next deposit lands.
6. A deposit pays for LP-held tokens at their oracle price. A new LP buys
   into them, not a share of them for free.

## Withdrawing

There is no instant withdrawal. Leaving takes three steps:

1. `request_withdraw` moves xLP into an escrow the pool controls.
2. The shares wait 150 slots, about one minute.
3. `claim_withdraw` burns them and pays their part of the pool at the claim
   sum, less the withdrawal fee.

Escrowed shares stay in the supply until the claim, so they take their part of
every gain and loss for the whole wait. Example: 50,000 of 1,000,000 shares
are requested while the pool is worth $1,000,000. Traders go up $100,000
before the claim. The claim pays 5% of $900,000, $45,000, not $50,000.

The wait exists because a move takes longer than a few slots to reach a mark.
An LP who could see a loss coming could otherwise leave at the old value and
leave the loss with everyone who stayed.

Rules at the claim:

* The pool must not be paused.
* Only free liquidity leaves. Trader collateral and escrow are not LP money
  and are never paid out.
* A claim may take part of the escrow; the rest stays claimable.
* Adding to an open request restarts the 150 slots for all of it.
* `cancel_withdraw` returns every escrowed share at any time, paused or not.
* Escrowed shares earn no points. A cancel puts them back on the stake.

The escrow is an account rather than a timer on the wallet because xLP moves
freely. A wallet timer would reset by sending the tokens elsewhere.

### Tokens are paid in kind

When a market's losses run past its USDC backing, the backing pays the LPs in
the tokens it was posted in (see
[How to underwrite a market](how-to-underwrite-a-market.md)). Those tokens
leave the pool the way they came in. A claim of `f` of the share supply pays:

```
usdc   = f × (USDC liquidity - what traders are owed) - fee
tokens = f × LP-held tokens of each kind - fee, rounded down
```

Example: the pool holds $1,000,000 USDC and 2,000 SOL for 1,000,000 shares. A
claim of 50,000 shares (5%) is paid $50,000 USDC and 100 SOL, before the fee.
Paid all in USDC, the last LPs out would have held tokens and no USDC.

* The tokens owed are fixed at the claim and leave the pool's holdings then.
* Rounding leaves dust with the LPs who stay. The last claim, of every share
  left, takes every token.
* If traders are owed more than the USDC, the excess comes off the tokens, in
  proportion. A claim never takes more than its part of the whole pool.
* A claim that pays no USDC still pays its tokens.

`claim_withdraw_tokens` sends the tokens one kind at a time, since carrying
every token vault would not fit in the claim. Earn shows each with a claim
button. Only the owner can pull them, and nothing after the claim changes the
amounts.
