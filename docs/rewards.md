# Referrals and points

## Overview

unwind rewards the people who make a market worth trading: the traders, the
people who open markets, the people who back them, and the people who bring
others in. There are two kinds of reward.

* **Points**, counted by the program on chain as they are earned. Points are a
  record of use, not a token and not a promise of one. The tally is the one
  the program kept, and anyone can check any wallet's on its `Trader` account.
* **USDC**, paid to referrers and to whoever opened a market, out of the
  protocol's share of each trading fee. It is claimable at any time from
  [Rewards](https://unwindfi.xyz/rewards).

Every wallet has a `Trader` account that holds both. It is made the first time
the wallet places an order, backs a market, adds liquidity, or takes a
referral code.

## Earning points

| Activity | Points |
| --- | --- |
| Trading | 2 points per $1 closed, for a position held 10 minutes or more |
| Referring | 10 percent of a referee's trading points, once they have $1,000 of held volume |
| Opening a market | 10 percent of the trading points earned on a market you opened, except your own |
| Backing a market | 2 points per $1 of backing, per day |
| Providing liquidity | 1 point per $1 deposited in the pool, per day |

A referee keeps all of their own points. The referrer's share is extra, not
taken from them.

## Trading points

1. **An open earns nothing when it fills.** Points are paid on the close, for
   both legs: $1,000 closed earns 2,000 points.
2. **10 minutes.** The size closed must have been open at least 600 seconds.
   A close sooner than that earns 0 points, and the open it closes earned 0
   too.
3. **Adding moves the clock.** A position's held time is size-weighted:
   adding $1,000 to $1,000 held for 10 minutes puts it at 5 minutes held, so
   the whole position needs 5 more. A partial close leaves the clock alone.
   A position emptied and opened again starts from zero.
4. **Liquidations and deleveraging earn 0.**
5. **250,000 points a day.** Trading points credited to one wallet stop at
   250,000 per UTC day, which is $125,000 closed. What a close would earn past
   that is not credited and is not carried over. The count starts again at
   00:00 UTC.

Volume still counts every fill, opens and closes, for the wallet and the
market. Only points follow the rules above. The program keeps each wallet's
count on its `Trader`: `trading_points`, `points_today` and `held_volume_usd`,
the round trip notional of closes held 10 minutes or more.

Backing earns twice the pool's rate because backing takes first loss on its
market (see [How to underwrite a market](how-to-underwrite-a-market.md)).
Backing points are counted on what was posted, in dollars at the time, and
stop in proportion to the shares withdrawn. They never count more than the
stake is still worth: when the market's losses draw on the backing, the stake
is marked down to its share of what is left at the next deposit, withdrawal
or `mark_backing`, which anyone may send.

Pool points are counted on the xLP a wallet minted and still holds. xLP can be
moved to another wallet without the program seeing it, so tokens sent away
stop earning at the next update and do not start again if they come back, and
tokens received from someone else earn nothing. xLP in escrow waiting to be
claimed (see [The pool](pool.md)) earns nothing, and a cancelled withdrawal
earns again from the cancel.

## Referrals

A wallet takes a referral code once: 3 to 16 characters of `a` to `z`, `0` to
`9`, `_` and `-`, first come, permanent. Its link is
`unwindfi.xyz/?ref=<code>`.

A wallet that arrives on a link names that code's holder as its referrer with
its first order. It can also do so from the Rewards page before trading. The
referrer can be set once, only before the wallet's first fill, and never to
the wallet itself.

Once referred, a wallet:

* pays **10 percent less** on every open and close fee, and
* its referrer is owed **10 percent of every fee it pays**, in USDC, and
* once it has **$1,000 of held volume** (a $500 position held 10 minutes and
  closed is $1,000), 10 percent of the trading points it earns from then on.
  Points it earned before that owe the referrer nothing, then or later. The
  USDC share does not wait.

Liquidation fees are not discounted and carry no referral share.

## Opening a market

Whoever opens a market (its `deployer`, see
[How to open a market](how-to-open-a-market.md)) is owed:

* **10 percent of every fee** paid on that market, in USDC, and
* 10 percent of the trading points its traders are credited.

Neither is paid on the deployer's own trades. The deployer earns trading
points on them like anyone else, and nothing as the deployer.

They also trade their own market at **half the fee**. The discount applies
only to the market they opened: a discount on every market would make opening
a throwaway market the cheapest way to trade everything else. On their own
market a deployer takes the discount instead of the fee share, and the
deployer discount and the referral discount do not stack; the larger applies.

## Where the USDC comes from

Referral and listing rewards are taken from the protocol's share of each fee
and from nothing else. On the default split (see [Fees](fees.md)) the protocol
receives 20 percent of every fee, so on a fee paid by a referred trader on a
market somebody else opened, 10 percent goes to the referrer, 10 percent to
the deployer, and the protocol keeps nothing. The liquidity pool, backers,
insurance fund and chain are paid exactly what they would be without any
referral.

When the protocol's share of a fee is smaller than the rewards on it, the
referrer is paid first and the deployer's share is cut to fit. The USDC sits in the pool's vault
on its own line, `rewards_usd`, until it is claimed, so it is never counted as
LP capital.

## Syncing

Settlement never needs a referrer's or a deployer's account, which keeps the
number of orders that fit in one settlement transaction as high as possible.
What a trade earns them is left on the referee's `Trader` account and on the
market, and two permissionless instructions move it across:

* `sync_referral` moves a referee's owed points and USDC to their referrer.
* `sync_deployer` moves a market's owed USDC and points (`deployer_points_owed`)
  to its deployer.

Neither can pay anyone but the account the program says is owed. The devnet
server runs both every minute, and claiming from the Rewards page syncs the
wallet's own markets first. Backing and pool points are brought up to date
whenever the stake changes, or by the wallet itself calling `accrue_points`.
A wallet with pool tokens it minted must show its pool token account when it
does, since the stake is cut to what that account holds.

## One pool per wallet

USDC rewards sit in one pool's vault, so each wallet's rewards are tied to
one pool, the first one that credits it USDC. After that:

1. `claim_rewards` pays only from that pool.
2. `sync_deployer` moves a market's USDC only to a deployer tied to the
   market's pool, and `sync_referral` only to a referrer tied to the same pool
   as the referee. Anything else stays owed where it is.
3. A referred wallet is tied to the first pool it trades in. A fill in any
   other pool keeps its discount but carves nothing for its referrer.
4. The tie moves once nothing is left in the old pool's books: no USDC
   waiting to be claimed and no referrer's cut waiting to be synced. So USDC
   owed from a second pool is never stuck. Claim what the first pool holds,
   then sync, and the wallet is tied to the pool that pays it.

## Pools that earn no points

Only a pool created by the program's upgrade authority earns points. On
devnet anyone may create a pool, in a token of their own, so a deposit,
backing or fill there costs nothing real. Such a pool is marked when it is
created (`Pool::no_points`) and earns nobody anything: no trading points or
volume, no referrer's cut, no points to the market's deployer, and no pool or
backing points. `accrue_points` refuses its pool token account.

The upgrade authority can switch a pool's points on or off with
`set_pool_points`. The devnet bootstrap creates its pool from a fresh key and
then switches points on with the deployer key, so devnet pools set up that way
earn points.

## Numerical example

A referred trader opens $10,000 on a market with a 10 basis point open fee,
which somebody else opened.

1. The full fee would be $10. With the referral discount it is $9.
2. The open earns 0 points.
3. The protocol's 20 percent of $9 is $1.80. Of it, $0.90 goes to the
   referrer and $0.90 to the market's deployer.
4. The chain ($0.90), insurance fund ($0.90) and pool ($5.40, shared with
   backers if the market has any) are paid as usual.
5. 20 minutes later the trader closes all $10,000. The close earns 20,000
   points. The trader already has $1,000 of held volume from earlier trades,
   so the referrer is owed 2,000 and the deployer 2,000.
6. Closed after 5 minutes instead, it would earn 0, and so would they.

## Leaderboard

The Rewards page ranks every wallet with points, all time and for the current
week (Monday 00:00 UTC onwards), and pins the viewer's own row. It also
publishes the share of points the top 20 wallets hold, so concentration is
visible rather than something to work out. Wallets the venue runs itself, such
as devnet's market maker, earn points like anyone else but are left off
the ranking.

## Rules changelog

Rules change only going forward. Points already earned are never recounted,
and every change is listed here with the date it took effect.

| Version | From | Change |
| --- | --- | --- |
| v1 | Season 1 | 1 point per $1 filled, opens and closes; 10 percent to referrers and deployers. |
| v2 | 2026-10-06 | Points on closes only, 2 per $1 closed after 10 minutes held. 250,000 trading points per wallet per UTC day. Referrers earn points only once a referee has $1,000 of held volume. Deployers earn 10 percent of trading points credited, nothing on their own trades. |
