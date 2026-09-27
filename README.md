# unwind

**Permissionless perpetual futures on Solana, cleared by dual flow batch auction.**

Anyone can open a perp market on any token with an on-chain price. Orders
collect for five seconds and clear together, so arriving first earns nothing.
Each market is backed by first-loss capital from whoever wants it to exist.

[Documentation](https://unwind.gitbook.io/unwind-docs) ·
[X](https://x.com/unwindfi)

> **Status:** live on Solana devnet. Unaudited. Do not use with real funds.

---

## Contents

- [Overview](#overview)
- [How it works](#how-it-works)
- [Verification](#verification)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Testing](#testing)
- [Security and limitations](#security-and-limitations)
- [Regulatory notice](#regulatory-notice)
- [License](#license)

## Overview

Most perp venues decide which markets exist, and match orders one at a time,
so the fastest order wins. unwind changes both.

| | Conventional perp venue | unwind |
| --- | --- | --- |
| Listing | Chosen by the venue | Any account, one transaction |
| Price source | Integrated oracle feed | Pyth feed, or the token's own Raydium CLMM or Meteora DLMM pool |
| Matching | Continuous, first come first served | Five-second batches, one price per flow |
| New-market risk | Carried by the venue or its LPs | First loss carried by the market's backers |

## How it works

### Clearing: dual flow batch auction

Orders submitted during a five-second window are held, not filled. When the
window closes, the batch is split into two independent auctions:

- **Buy flow:** takers buying against makers selling.
- **Sell flow:** takers selling against makers buying.

Each flow clears at the single price that crosses the most volume, and every
order that trades in a flow trades at that price. Takers only meet makers, and
makers only meet takers. Arrival time inside the window carries no weight, so
there is no latency edge to buy and nothing to front-run.

The liquidity pool fills only the takers that makers leave standing, inside a
two-sided quote whose spread widens with the price source's uncertainty. It
never trades with a maker, and above a confidence threshold it stops quoting.
The oracle enters clearing only as a final tie-break. Nothing clears outside a
band around the oracle mark.

See [`auction.rs`](programs/unwind/src/auction.rs) and
[Clearing](docs/auction.md).

### Price sources

A market is priced by one of:

- **A Pyth feed**, validated in full: owner, discriminator, full Wormhole
  verification, feed id, staleness and confidence.
- **An observed pool**, for assets with no feed: a USDC or USDT pool on
  Raydium CLMM or Meteora DLMM. The mark keeper reads the pool off-chain and
  pushes the price (`push_mark`), so the market trades from
  its first push. Depth is still read on-chain in the same transaction. Without
  a keeper, the permissionless `observe` crank builds an EWMA mark that is not
  served until it holds thirty readings across fifteen minutes.

Confidence for an observed market comes from what it costs to move the pool
one percent, so a thin pool quotes wide and eventually halts rather than
serving a price that can be pushed.

See [`observation.rs`](programs/unwind/src/state/observation.rs) and
[Price sources](docs/price-sources.md).

### Listing and backing

Opening a market needs no approval, and confers no rights over it afterwards.
A new market cannot take positions until someone posts backing: USDC, USDT or
SOL that absorbs the market's losses first, before any liquidity provider's
capital. Backers earn half of the pool's share of that market's fees.

A market's loss budget rises with what has been posted, and anyone can cut it
to what its source pool costs to move. The most a permissionless market can cost the pool
is therefore bounded by the cost of manipulating the asset that prices it.

See [`backing.rs`](programs/unwind/src/instructions/backing.rs),
[Opening a market](docs/how-to-open-a-market.md) and
[Underwriting a market](docs/how-to-underwrite-a-market.md).

### Liquidity pool

- **AUM** is `liquidity − unrealized trader PnL`. Trader profit is a liability
  from the moment it exists, and LP deposits and withdrawals must price every
  market in the pool; completeness is enforced on chain.
- **Trader collateral and backing** are tracked separately and excluded from
  AUM, so a withdrawal is never paid from someone's margin or from first-loss
  capital.
- **Reserves.** Each open position locks a share of pool liquidity to cover its
  profit, and a utilization cap bounds how much can be locked at once.

See [Pool](docs/pool.md) and [Loss budget](docs/loss-budget.md).

### Risk engine

- **Margin.** `equity = collateral + pnl − funding`, liquidatable below
  maintenance margin. Parameter sets where a max-leverage position would open
  already under maintenance are rejected.
- **Leverage from depth.** For observed markets, maximum leverage follows the
  pool's sustained depth, which falls at once and recovers slowly. The open
  interest cap is set at listing.
- **Funding.** A borrow leg paid to the pool, scaling with utilization, and a
  conserved skew leg paid from the heavier side to the lighter one. A single
  accrual is capped at eight hours.
- **Liquidation** is permissionless. The liquidator's bounty comes from the
  position's remaining equity, never from pool capital, and liquidation stays
  available while a market is paused.
- **Backstops.** A market's losses are paid from its backing, then pool
  liquidity, then the insurance fund. A winner the market's budget cannot pay
  is deleveraged at the mark.

See [Margining](docs/margining.md), [Funding](docs/funding.md),
[Liquidations](docs/liquidations.md) and
[Auto-deleveraging](docs/auto-deleveraging.md).

### Tokenized equities

xStocks are Token-2022 with the `ScaledUiAmount` extension, so dividends and
splits change what a raw balance means. The program never custodies them:
margin and settlement are in stablecoins, and the xStock is only a price
reference. Market sessions follow the underlying's trading calendar, tightening
leverage and open interest while it is closed, and splits are applied through
`apply_corporate_action` on a paused market.

See [Sessions](docs/sessions.md) and [Corporate actions](docs/corporate-actions.md).

## Verification

The clearing arithmetic is checked with [Kani](https://model-checking.github.io/kani/),
a model checker for Rust. Rather than testing chosen inputs, each proof covers
every input within its bounds. Proven properties include:

- No order fills more than its own size.
- Every fill is at or better than the order's limit.
- No batch clears outside the band around the oracle.
- The pool never exceeds its quote, never fills both sides, and fills takers only.
- Every order clears in exactly its own flow.

```bash
cd programs/unwind && cargo kani
```

The proofs live in [`proofs/`](programs/unwind/src/proofs/) and are
never compiled into the deployed program. Bounds and scope are documented in
[Verification](docs/verification.md).

## Repository layout

```
programs/unwind/          the on-chain program (Anchor)
programs/mock-pyth/       localnet stand-in for the Pyth receiver
web/                      site and trading app (Vite, React, Tailwind)
  src/site/               markets, list, earn, waitlist pages
  src/components/         trading terminal, chart, order ticket
scripts/                  keepers, API server, listing, bootstrap, generators
tests/                    integration tests against a local validator
docs/                     GitBook documentation
```

Inside `programs/unwind/src/`:

| File | Purpose |
| --- | --- |
| `auction.rs` | Dual flow batch clearing |
| `proofs/` | Kani proofs, one file per part of the program |
| `amm.rs` | Raydium CLMM and Meteora DLMM readers |
| `oracle.rs` | Pyth `PriceUpdateV2` reader and validation |
| `math.rs`, `aum.rs` | PnL, funding, equity and pool AUM |
| `state/` | Pool, market, observation, batch, order, position, custody |
| `instructions/` | Admin, observe, backing, batch, trade, orders, liquidity, liquidate, ADL, crank |

## Getting started

### Prerequisites

- Rust and the Solana CLI 2.3.0
- Anchor 0.31.1
- Node.js and npm

### Run locally

```bash
npm install && npm --prefix web install
anchor build
./scripts/localnet.sh                       # validator with both programs
npx ts-node scripts/bootstrap-localnet.ts   # pool, markets, liquidity, demo account
npm --prefix web run build
npx ts-node scripts/server.ts               # http://localhost:3000
```

The server runs the price poller, the batch keeper, the observation crank, the
liquidation keeper and the funding crank, and serves the API and the app.
Bootstrap and the server need network access: they refuse to start without a
live price for every market.

For front-end work, `npm --prefix web run dev` serves the app with hot reload
and proxies the API to the server above.

### Open a market from the command line

```bash
npx ts-node scripts/clmm.ts <pool>                  # what the program will read
npx ts-node scripts/list-market.ts <pool> <SYMBOL>
```

## Testing

```bash
npm run test:unit            # program unit tests, no validator needed
npm run test:integration     # full lifecycle on a local validator
```

Integration tests use fixed Pyth fixtures written by
`scripts/gen-oracle-accounts.ts`, regenerated on each run because their publish
times go stale after an hour. They cover clearing and settlement, LP accounting,
oracle rejection cases, liquidation, the insurance fund, auto-deleveraging,
limit and trigger orders, corporate actions and permissionless underwriting.

If `cargo build-sbf` fails with `feature edition2024 is required` or an MSRV
above 1.84, run `scripts/pin-msrv.sh` to pin transitive dependencies to
versions the SBF toolchain's Cargo can parse.

The program reads `PriceUpdateV2` accounts directly rather than through
`pyth-solana-receiver-sdk`, whose versions conflict with Anchor 0.31's `borsh`.
Every check the SDK performs is reproduced, and partially verified updates are
rejected outright.

## Security and limitations

This code has **not been audited**. Beyond the Kani proofs of the clearing, it
has not been fuzzed or formally reviewed, and it has not run against real
funds.

Known limitations:

- **Observation.** The per-update clamp bounds how fast a mark can move, not
  where it ends up. Holding a thin pool off its true price for long enough can
  still walk the mark; the loss budget bounds what that is worth, but nothing
  yet bounds its duration.
- **Batch capacity.** A batch holds up to 64 orders and clearing is quadratic in
  the order count. A full batch refuses new orders until it clears, which is
  correct but is an unpriced denial-of-service surface.
- **Positions** are one-way: switching sides requires closing first.
- **Sessions** for equity markets are set by the authority rather than a
  market-hours oracle.
- **Gap risk.** An equity that gaps beyond a position's reserve in one tick falls
  to backing, the insurance fund and auto-deleveraging, and past all three, to
  the pool.
- **Stack limits.** Account contexts are boxed to fit the 4 KB SBF stack frame.
  After changing `Liquidate` or `Trade`, check the build output for
  `Stack offset ... exceeded max offset`, which is reported as a warning but
  fails at runtime.

To report a vulnerability, please contact the maintainers privately via
[X](https://x.com/unwindfi) rather than opening a public issue.

## Regulatory notice

A perpetual future referencing an equity is treated as a security-based swap in
the United States and is restricted in several other jurisdictions. This
repository implements no access controls for that purpose. Nothing here is an
offer or investment advice.

## License

[MIT](package.json)
