# Fees

## Overview

Fees are charged on opening a position, on closing one, and on liquidation.
Each is configured per market rather than globally, because a market tracking
a thin asset and one tracking a deep asset do not carry the same risk.

Makers and takers pay the same rates. Every order in a batch is one or the
other, and the distinction decides which of the batch's two auctions it
clears in (see [Clearing](auction.md)), not what it is charged.

## Rates

The program's default configuration charges the following:

| Fee | Default | Charged on |
| --- | --- | --- |
| Open | 10 basis points | Notional opened |
| Close | 10 basis points | Notional closed |
| Liquidation | 100 basis points | Notional liquidated |

Listed markets are created with these open and close fees. A referred
trader pays 10 percent less on open and close fees, and a market's own deployer
pays half on the market they opened (see [Referrals and points](rewards.md)).
Liquidation fees are never discounted. The pool charges
nothing to add liquidity and 5 basis points to remove it.

## Distribution

Every fee collected is divided as below. On a market with backers,
the liquidity pool's part is split in half with them. On a liquidation fee,
the account that performed the liquidation takes the liquidity pool's part
(and the backers' half of it) as its reward.

| Recipient | Share | Share on a backed market |
| --- | --- | --- |
| Liquidity pool | 60 percent | 30 percent |
| Backers | none | 30 percent |
| Protocol | 20 percent | 20 percent |
| Insurance fund | 10 percent | 10 percent |
| Chain | 10 percent | 10 percent |

Referral and listing rewards are paid out of the protocol's 20 percent and
nothing else: 10 percent of the fee to the trader's referrer, if they have one,
and 10 percent to whoever opened the market. See
[Referrals and points](rewards.md).

The protocol, chain and insurance cuts come first, and the backers' half is
taken from what is left, which puts backers behind those three and ahead of
the liquidity providers. The chain's share is a constant in the program with
no setter; changing it takes a new program build.

The pool's share accrues to liquidity providers as an increase in the pool's
balance. The backers' share is credited to the market's backing, so each
backing share is worth more. The protocol, chain and insurance shares
accumulate separately and are not part of the pool's assets under
management.

## Numerical example

A trader opens a position of 10,000 USDC notional in a market configured with
the default open fee.

1. The fee is 10 basis points of 10,000, or 10 USDC.
2. 2 USDC accrues to the protocol, 1 USDC to the insurance fund and 1 USDC
   to the chain.
3. Of the 6 USDC left, all of it accrues to the liquidity pool if nobody
   backs the market. If somebody does, 3 USDC accrues to the backing and 3
   USDC to the pool.
