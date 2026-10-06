---
cover: .gitbook/assets/unwind-hero.png
coverY: 0
---

# unwind

## What is unwind?

unwind is a perpetual futures venue on Solana. Every market clears by dual
flow batch auction, and anyone can open a market.

1. **1 second batches.** Orders sent inside one window are collected with no
   order among them. Takers buying meet makers selling, takers selling meet
   makers buying, and each of those two auctions clears at the one price that
   crosses the most volume. Everyone in a flow trades at the same price.
2. **No listings process.** Opening a market is one signed transaction
   against a Pyth feed or a Raydium or Meteora spot pool. No approval, no
   allowlist.
3. **Permissionless upkeep.** Clearing, settlement, liquidation and budget
   cuts can be sent by any account. None of them takes a price or any other
   choice from the sender.

One input does come from a key: the mark of a market priced from a spot
pool, which the venue's mark keeper reads off the pool and pushes. The
program bounds what that mark can do to positions (see
[Price sources](price-sources.md) and [Risks](risks.md)).

## Design

Two rules account for most of the system. The other pages follow from them.

1. **Price is formed in the batch.** The liquidity pool quotes into each
   auction as one participant and fills only the takers makers leave
   standing. The clearing price is a function of the orders, not of pool
   reserves. The oracle only breaks ties and sets the band.
2. **The market list is not curated.** What each market may lose is posted
   by whoever backs it and capped by the depth of the asset it tracks. No
   administrator grants it.

## Status

| | |
| --- | --- |
| Cluster | Solana devnet, test USDC only (see [Devnet](devnet.md)) |
| Audit | None. Not reviewed by an audit firm. |
| Mainnet | Off until an audit |
| Formal checks | 126 Kani harnesses plus unit and integration tests (see [Verification](verification.md)) |
| Source | [github.com/prarimz/unwind](https://github.com/prarimz/unwind): program, proofs, server, site |

{% hint style="warning" %}
Nothing in this documentation is investment advice. The program is
unaudited and holds collateral. Price that in.
{% endhint %}

The program is the specification. Where these pages and the source disagree,
the source is right.

## Risks

[Risks](risks.md) lists where losses come from: the program, leverage and
liquidation, prices and keepers, the loss order, backing and the pool,
points farming, listing and devnet. Each entry links to the page with the full
rule. The site's `/risk` address redirects there.
