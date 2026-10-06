# Order types

There are two things a trader can send: a **batch order**, which goes into the
next auction now, and a **trigger**, which waits for a price and then becomes
a batch order.

## Key figures

| | |
| --- | --- |
| Orders per batch | 64 |
| Resting orders per wallet per batch | 4 |
| Life of a batch order | 1 batch |
| Minimum open, site listing | $10 |
| Minimum reduce-only order | the market's minimum position, unless it closes all that is left |
| Market order limit (site) | 1% through the mark |
| Fired close limit | 1% through the oracle |
| Trigger check (devnet keeper) | every 3 seconds |

## Batch orders

Every batch order is a limit. It fills at its flow's clearing price, never
worse than its limit, or not at all. See [The auction](auction.md).

| Order | Maker or taker | Limit |
| --- | --- | --- |
| Market (site) | taker | mark ± 1% |
| Limit, post only | maker | the price given |
| Close (site) | taker | mark ± 1% |
| Fired trigger | taker | see below |

**Opens** escrow their collateral at submission. Unfilled collateral comes
back at settlement.

**Closes** are reduce-only. They escrow nothing and reserve size on the
position, so the same size cannot be promised to two closing orders. A close
fills like any other taker: in full when the batch can match it, pro rata with
its flow when it cannot. What a crowded batch does not fill is not carried
over. The rest of the position stays open, and the trade screen shows how
much closed. Before a close is sent, the trade screen asks to confirm it,
with the expected close price and PnL, and says when the position is larger
than the market fills in one batch.

**Makers** rest as liquidity at their own price. A maker trades only with
takers, never with the pool and never with another maker. Set `is_maker` on
`submit_order`, or `maker: true` on the devnet API's order endpoint. A maker
order must carry a price.

## Post only

The limit tab's **Post only** box sends the order as a maker at the limit
price.

1. It never trades with the pool and never takes.
2. It fills only when a taker in the same batch crosses it, at that flow's
   clearing price.
3. It lasts one batch. Unfilled, it lapses and its collateral comes back at
   settlement. To quote again, place it again.
4. It posts the same margin and pays the same fees as any open.
5. It cannot be reduce-only and has no time in force.

## Limits that keep one wallet from filling a batch

1. A wallet may hold at most 4 resting orders in a market's batch.
2. A reduce-only order must be at least the market's minimum position size,
   unless it closes everything left. Reduce-only orders post no collateral, so
   without a floor they would cost nothing, and enough of them priced never
   to cross could block every exit.
3. A wallet cannot hold opening orders on both sides of one batch.

All three apply to orders a trigger fires as well as to orders sent by hand.

## Positions do not flip

A position is long or short. An open must be on the side the position holds,
and is refused at submission otherwise. To change sides, close first.

## Opens are checked at submission

An open entering a batch must fit, as things stand then:

1. the position's side,
2. the market's maximum leverage, on collateral net of the open fee and of
   funding the position already owes,
3. the open interest cap, counting every open already resting on that side
   of the batch.

Settlement books whatever the auction filled without checking again.

## Triggers

A trigger is one object for limit, take profit and stop loss: a price, a
direction to cross it from, and what to do on the other side. It is either:

* an **open**, which escrows its collateral when placed, or
* a **close**, which escrows nothing. A close of size zero closes the whole
  position.

A trigger fires against the oracle mark, not the fill price. What it becomes
is a taker order in the market's batch. The auction sets the price, the same
as for an order sent by hand.

| Trigger | Limit of the order it becomes |
| --- | --- |
| Open (limit) | the trigger price |
| Close (take profit, stop) | oracle - 1% for a long, oracle + 1% for a short |

The 1% is wide enough to cross the pool's quote in an ordinary market and
narrow enough that a stop in a dislocation is not filled at any price.

### Checked twice

**When placed:**

* Nothing on a paused pool. Only closes on a paused market.
* An open must fit the side, leverage and open interest cap as they stand.
* An expiry, if set, must be in the future.

**When fired:**

* Refused on a paused pool or a paused market.
* An open must pass the same checks as a submitted open, including the opens
  resting in the batch, because the position and the market may have moved.
* A close needs size still closable on the position, and keeps the
  reduce-only minimum: no smaller than the market's minimum, unless it is all
  that is left.

A trigger that fails when fired never reaches the batch, so it never moves a
clearing price. It stays in place until it fires, expires or is canceled. A
trigger that fires is spent: its account closes. If the batch it lands in
cannot fill it, it lapses with that batch, and a fired open's collateral comes
back at settlement.

An expired trigger is closed by the next attempt to fire it, and its escrow is
refunded. A canceled trigger's escrow is paid back from the vault of the pool
its market belongs to, and from no other.

### On the site

* There is one take profit, one stop and one limit per market. Setting one
  where one already stands replaces it in the same transaction.
* Closing a whole position from the site cancels its take profit and stop in
  the same transaction.
* A trigger whose position is already gone, for example after a liquidation,
  shows as "No position" under Open Orders. Cancel it: left standing, it would
  act on the next position opened on that market.
* A paused market shows "Exits only" in its header.

## Execution

Clearing, settlement, triggers and liquidation are permissionless. None of
them takes a price or a choice from the caller. On devnet the venue's server
checks every trigger against the mark every 3 seconds; one that is reached but
will not fire is tried again after 60 seconds.
