# Stateful fuzzing findings

What the stateful fuzzer (`tests/stateful_fuzz.rs`) found in the program,
kept apart from what it found wrong with itself. All three are fixed. Each
has a regression test, once ignored and now part of the suite, and the
invariant that caught it fails a run again (it was counted in
`KNOWN_FINDINGS` in `tests/support/model.rs` while open).

```
cargo test --release --test stateful_fuzz finding -- --nocapture
```

After the fixes: 3 seeds of 1,000 cases of up to 120 actions on each
fixture with `FUZZ_STRICT=1`, 361,960 actions, no invariant failed.

## 1. The in-kind sync repays the LPs for losses the insurance fund paid (fixed)

**Invariant:** `in_kind_sync_repays_fund_losses_to_lps`. The fund ranks after
the backers, in kind included, so when backing tokens pay for a loss past the
USDC backing, they may repay the LPs only what the LPs paid.

**Regression:** `finding_in_kind_sync_repays_the_lps_for_the_funds_loss`, on
the thin fixture ($20k of LP capital, ALPHA backed $2,000 in USDC and $10,000
in the oracle-priced custody, a $5,000 fund).

**Sequence** (`insurance_draw_actions`, then one sync):

1. Four traders short ALPHA, $3,500 each at 2x. A 60% gap; all four are
   liquidated. The LPs collect their collateral.
2. Trader 5 builds a $2,500 long at 5x, a batch at a time.
3. Both LPs withdraw everything the pool lets go. LP liquidity is $2.66.
4. ALPHA goes up about fourfold. The long closes. Its profit is paid from
   the USDC backing ($2,000.79), then LP liquidity ($2.66), then the fund
   ($4,998.86, from $5,000.27 to $1.41). This much is the documented order.
5. `sync_backing` on ALPHA.

**Numbers after the sync:** net loss $6,002.25, USDC backing drawn
$2,000.79, so `lp_borne_usd` is $4,001.46. The sync moves SOLX worth
$4,001.46 to the LPs. The LPs had paid $2.66 of the loss; the fund paid
$4,998.86 and is repaid nothing. The fund is $4,998.86 down and the LPs
$3,998.80 up on a loss the backers' tokens were there to cover first.

**Root cause:** `plan_sync` in `state/custody.rs` is fed
`lp_borne_usd(net_loss_usd, backing_drawn_usd)`, which takes every loss past
the USDC backing to be the LPs'. `apply_settlement_to_pool` pays that part
through `Pool::pay_out`, which takes what liquidity cannot cover from
`insurance_usd`, and nothing records the fund's share per market. So the
sync reimburses the LPs for the fund's part too. Reachable only once LP
liquidity has run out, and bounded by the fund.

**Fix.** `Market::insurance_drawn_usd` (from reserved bytes) records what
the fund paid toward the market and has not been repaid.
`plan_sync_with_fund` (`state/custody.rs`) has the tokens repay the fund
first and the LPs only what is left: the reverse of the order the two were
drawn, since the docs gave no order between them (docs/loss-budget.md now
does). The fund holds the tokens (`Custody::insurance_amount`, from reserved
bytes) until the LPs buy them at the oracle with free liquidity, on every
sync. Tokens the LPs were handed for a loss a later gain repaid them go to
the fund in USDC while it is owed, before any refund to the backers.
`BackingBook::fund_reimbursed_usd` (from reserved bytes) keeps the fund's
part of what the tokens paid, so a recovery refunds it to the backers like
the rest. No account grew.

**After:** the same sequence moves $4,001.46 of SOLX to the fund and none to
the LPs. The fund is still owed $997.40, which the tokens do not owe: the
market's loss past its USDC backing is $4,001.46. The harness ledger now
nets the fund's repayments, and the invariant compares the LPs' own part
(`reimbursed_usd - fund_reimbursed_usd`).

## 2. The order a batch is settled in moves value between backers and LPs (fixed)

**Invariant:** `settlement_order_moves_value_between_backers_and_lps`. Every
sealed batch the fuzzer cranks with `reorder` is also settled in reverse on a
copy of the world. What each trader holds and what the pool holds must match;
this checks that the split of the pool's part between the LPs and the
market's backers does too.

**Regression:** `finding_settlement_order_moves_value_between_backers_and_lps`,
thin fixture.

**Sequence:**

1. Trader 0 sells and trader 1 buys ALPHA against each other, $2,000 at 2x.
2. ALPHA up 3%.
3. Both close in the same batch. The batch clears.
4. On two copies, settle the two closes in index order and in reverse.

**Numbers:** in index order, LP liquidity $20,016.22 and ALPHA's backing
$1,987.02; in reverse, $20,002.34 and $2,000.90. $13.88 moves between the
backers and the LPs depending on which order a settler chose. Traders are paid
the same either way.

**Root cause:** `apply_settlement_to_pool` (`instructions/trade.rs`) books
each close on its own. A winner draws the market's backing first
(`draw_backing`); a loser's loss repays the backing only up to what has been
drawn (`restore_backing`) and the rest goes to the LPs. Winner first, the
loser's loss repays what the winner just drew. Loser first, nothing has been
drawn yet, so the whole loss goes to the LPs, and the winner then draws the
backing for good. `settle_order` is permissionless and the settler picks the
order, so whoever cranks decides who pays. The program's comments call
settlement free of discretion: prices and fills are, this split is not.

**Fix.** A close settled out of a sealed batch goes through
`apply_batch_settlement_to_pool`, which moves the backing to where the
batch's running net would leave it as one close
(`Market::settle_backing_in_batch`): drawn up to what the backing held when
the batch began, less fees the batch has paid the backers, or restored up to
what was drawn before it, and never against the close's own direction. A
loser's gain also puts back what the fund paid a winner earlier in the same
batch. Liquidations and deleveraging still settle on their own. The running
figures are four fields at the end of `Market`, zeroed when a batch seals and
when its last order settles: the account grew by 32 bytes, so a market
listed before needs `resize_market`.

**After:** both orders leave LP liquidity at $20,002.34 and the backing at
$2,000.90, where the winner-first order used to. Unit tests settle batches
of up to four closes in every order, with and without LP liquidity, and get
the same backing, liquidity and fund every time.

Two order effects remain and are counted, not failed: haircuts under a
binding budget, and close fee cuts clamped to LP liquidity that is nearly
gone (both below). The comparison now looks at the backers' value, with the
same rounding allowance per blended fill as the traders'.

A related case is by design and only counted: a wallet that closes and opens
in one batch. The order decides how much of its PnL is realized (to the LPs,
past what backing was drawn) and how much stays in a position, owed from
backing first. Its value at the mark is the same either way.

## 3. A split that rounds an entry to zero blocks settlement (fixed)

**Invariant:** `settlement_never_refused`, reported under
`split_rounds_an_entry_to_zero` when that is the cause.

**Regression:** `finding_split_to_a_zero_entry_blocks_settlement`, thin
fixture.

**Sequence:**

1. BETA marked at five millionths of a dollar (five price units).
2. Trader 0 buys $10 of BETA. Entry: 5 units.
3. A 1-for-10 split (`apply_corporate_action(1, 10)`). The entry rebases to
   0.5 units, which rounds to 0.
4. Trader 0 closes. The batch clears. `settle_order` is refused with
   `InvalidOraclePrice`, and the sealed batch cannot roll.

**Root cause:** `rescale_market` moves the risk and last prices through
`rescale_price`, which floors at one unit, but a position's entry is rebased
lazily by `Market::adjust_entry_price`, which has no floor, and the side's
average entry by `mul_div_u64`, which has none either. `position_pnl_usd`
refuses a zero entry. Any entry under `denominator` units rebases to zero.
Low impact: corporate actions are for tokenized equities, priced in dollars,
and observed markets quote small tokens per `10^unit_exp` to keep the digits.

**Fix.** `Market::adjust_entry_price` floors a set entry at one unit, and
`rescale_market` moves the side averages through `rescale_price`, which
already did. The regression's close now settles and the batch rolls.

## Documented behavior the fuzzer measured, not counted as findings

- **After a split, the moment sums are emptied** (`rescale_market`) and the
  side aggregates are the old rule until the positions open across it are
  gone: winners are counted at their side's net profit, so a loser hides a
  winner on the same side from the haircut; funding owed is left out of the
  LPs' valuation (`Market::trader_net_usd`), so deposits and claims priced
  then do not count funding positions owe; and the average entry drifts from
  the positions by up to a few basis points once a large position leaves.
  The fuzzer checks the bounds only where a side is tracked and values books
  from the positions.
- **A cut a fee cannot take from LP liquidity is not taken.** Close and
  liquidation cuts are clamped to liquidity (`take_fee_cuts`), and so is the
  backers' share of a close fee. With liquidity at zero the protocol, chain
  and fund get nothing from that fee.
- **A budget cut below what a market already lost** (`set_market_budget`, or
  `derive_market_budget` on a drained pool) leaves nothing remaining and
  charges nothing.
- **Under a binding budget, settlement order decides haircuts**
  (docs/loss-budget.md).

## Harness assumption errors, fixed in the harness

Each was a failure the fuzzer reported that turned out to be the harness's
model, not the program:

- A trigger's escrow was counted only after the transaction that placed it.
- The winners bound was checked on sides a split had untracked.
- The trade-only value check valued books from the side aggregates, which
  after a split omit funding.
- Aggregate rounding after a reverse split, and the drift a large position
  leaves when it closes after a split, needed their own slack.
- A rebased trigger carries its placement's rounding through every ratio.
- Settling in another order was compared line by line, which flags a wallet
  that closes and opens in one batch, and entry rounding per blended fill.
- The backers' close fee is clamped to the liquidity left at that moment.
- The loss budget was checked as a state invariant, which a budget cut
  legitimately breaks; it is now checked when a loss is charged.
- A budget can bind on funding a winner is owed, not only its price PnL.
- The settlement-order split check compared the LPs' value with no
  allowance for blended entry rounding, which lands on the LPs through the
  book they hold. It now compares the backers' value with the traders'
  rounding allowance.
- The same check took close fee cuts clamped to nearly empty LP liquidity
  for finding 2. Those are now counted as the documented clamp.
