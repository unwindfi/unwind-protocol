# Fees

Fees are charged on opening, closing and liquidation. Each is set per market.
Makers and takers pay the same rate: maker or taker decides which flow an
order clears in (see [The auction](auction.md)), not what it pays.

## Rates

| Fee | Site listing | Permissionless bounds | Charged on |
| --- | --- | --- | --- |
| Open | 10 bps | 10 to 100 bps | notional filled |
| Close | 10 bps | 10 to 100 bps | notional closed |
| Liquidation | 100 bps | below maintenance, and maintenance ≥ 120 bps + fee | notional liquidated |
| Pool deposit (devnet pool) | 0 | set per pool | amount deposited |
| Pool withdrawal (devnet pool) | 5 bps | set per pool | USDC and tokens claimed |

Discounts on open and close fees:

| Trader | Discount |
| --- | --- |
| Has a referrer | 10% |
| Trades a market they listed | 50% |
| Both | 50%; they do not stack |

Liquidation fees are never discounted. See
[Referrals and points](rewards.md).

A close fee never exceeds the position's equity, and a liquidation fee never
exceeds what the position has left. Neither is ever paid out of pool capital.

## Where a fee goes

| Recipient | Unbacked market | Backed market |
| --- | --- | --- |
| Protocol | 20% | 20% |
| Insurance fund | 10% | 10% |
| Chain | 10% | 10% |
| Backers | none | 30% |
| LP pool | 60% | 30% |

1. The protocol, chain and insurance cuts come first.
2. On a market with backers, half of what is left goes to the backers.
3. The rest stays with the LPs.

Backers rank behind the three cuts and ahead of the LPs. The chain's 10% is a
constant in the program with no setter; changing it takes a new program
build.

The LP share raises the pool's liquidity. The backers' share is credited to
the market's backing, so each backing share is worth more; it does not raise
the loss budget. The protocol, chain and insurance shares are kept on their
own lines and are not part of what the pool is worth.

Referral and listing rewards come out of the protocol's 20% and nothing else:
10% of the fee to the trader's referrer, and 10% to whoever listed the market
(not on their own trades). When the protocol's cut is smaller than the
rewards, the referrer is paid first.

### Liquidation fees

The account that liquidates takes everything after the three cuts: 60% of the
fee, on a backed market too. The cuts stay in the pool.

## Numerical example

A trader opens $10,000 of notional on a site listing, no referrer.

1. Fee: 10 bps of $10,000 = $10.
2. Protocol $2, insurance fund $1, chain $1.
3. $6 is left. Unbacked: all $6 to the LPs. Backed: $3 to the backing, $3 to
   the LPs.
4. Of the protocol's $2, $1 goes to the market's lister. With a referrer, the
   fee is $9 and the referrer is paid $0.90.
