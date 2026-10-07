# Verification

## Overview

| | |
| --- | --- |
| Kani harnesses | 126, in 9 files under `programs/unwind/src/proofs/` |
| Rust unit tests | 432 `#[test]` functions in `programs/unwind/src` |
| Integration tests | `tests/unwind.ts` and `tests/system.ts`, against a local validator |
| Audit | None |

[Kani](https://model-checking.github.io/kani/) is a model checker for Rust. A
test checks the inputs somebody wrote down. A Kani harness makes its inputs
symbolic, states what they may be, and checks a property for every input
inside those bounds, or produces the input that breaks it.

The harnesses compile only under Kani, never into the deployed program. Run
them with:

```
cd programs/unwind
cargo kani                                   # all 126
cargo kani --harness proofs::money::pnl_refuses_a_zero_entry --exact   # one
```

Each file states its bounds at the top, and each harness repeats any bound
of its own in its doc comment. The tables below are those doc comments, one
row per property.

## The auction: `auction.rs` (9) and `clearing.rs` (9)

Three orders (four where one is split), any mix of bids and asks, makers and
takers, four price levels, sizes up to 15, any pool quote and any band.

| Property | Harnesses |
| --- | --- |
| No order fills past its own size, on either side, whatever the pool absorbs | `no_order_fills_past_its_size` |
| Everyone in a clearing trades at one price, never worse than their limit | `fills_respect_every_limit` |
| A banded batch clears inside the band | `a_banded_batch_clears_inside_the_band` |
| In a flow, no order fills past its size, outside the band or worse than its limit | `a_flow_fills_every_order_within_its_size_limit_and_band` |
| Neither side is allocated more than it trades; the pool's share goes only to the side it fills | `each_side_fills_at_most_what_it_trades`, `each_side_of_a_flow_fills_at_most_what_it_trades` |
| The pool never takes more than its quote, never both sides at once | `the_pool_stays_inside_its_quote` |
| The pool fills takers only: it sells in the buy flow and buys in the sell flow | `the_pool_fills_only_takers_within_its_quote` |
| Every order lands in exactly its own flow; nothing lost or added | `the_split_puts_every_order_in_its_own_flow` |
| The clearing price crosses at least as much volume as any price at all, then least imbalance, then nearest the reference | `the_clearing_price_is_the_documented_argmax` |
| Without the pool, a batch trades exactly when some bid meets some ask | `a_book_trades_on_its_own_exactly_when_it_crosses` |
| Fills add up to what trades, losing at most one unit of rounding per order | `fills_conserve_what_trades` |
| Submission order changes nothing: whether it trades, the price, the volume, the pool's take, any fill | `the_clearing_is_independent_of_submission_order`, `submission_order_never_changes_the_price`, `submission_order_does_not_change_the_pools_take`, `submission_order_does_not_change_any_fill` |
| A better limit fills in full before the margin fills anything; at one limit, a larger order never fills less | `a_better_price_fills_first_and_size_never_hurts` |
| Splitting an order wins nothing and loses at most one unit | `splitting_an_order_wins_nothing` |

## Batches, marks and Pyth: `feeds.rs` (14)

Batch harnesses run over the real 64-slot array with every slot's liveness
symbolic. Harnesses that divide in u128 bound their values, as each says.

| Property | Harnesses |
| --- | --- |
| An insert takes the lowest free slot and moves nobody; it is refused only for the wallet limit or a full batch | `inserting_takes_the_first_free_slot_and_nothing_else` |
| A full batch refuses and overwrites nothing; a sealed batch takes no orders | `a_full_batch_refuses_and_overwrites_nothing`, `a_sealed_batch_takes_no_orders` |
| A batch is due exactly 1 second after it opens and stays due | `a_batch_is_due_exactly_after_its_interval` |
| Reopening keeps standing orders, rolling clears them, both start a fresh window | `a_new_window_opens_clean` |
| One `observe` reading moves the folded mark at most its clamp (or one unit), only toward the reading, never to zero | `the_mark_moves_at_most_its_clamp_and_toward_the_reading` |
| A reading counts toward seasoning once; a rejected one not at all | `a_reading_counts_once_and_a_rejected_one_not_at_all` |
| Sustained depth falls at once and rises by at most a tenth of the gap, once per 20 seconds | `sustained_depth_falls_at_once_and_rises_slowly` |
| An observed confidence never overflows or exceeds the price | `observed_confidence_never_exceeds_the_price` |
| A Pyth reading is rescaled exactly or refused when scaled up, truncated or refused when scaled down; never wrapped or served as zero | `scaling_a_reading_up_is_exact_or_refused`, `scaling_a_reading_down_truncates_or_refuses` |
| `conf_bps` is the floor of the true ratio, and a wider confidence never reads as narrower | `conf_bps_is_the_floor_of_the_true_ratio`, `a_wider_confidence_never_reads_as_narrower` |
| One step of the risk price lands between where it was and the oracle, never at zero, never past its cap | `the_risk_price_never_overshoots_or_passes_its_cap` |

## Budget, backing, prices and funding: `budget.rs` (16)

Most run over the full width of their types.

| Property | Harnesses |
| --- | --- |
| A checked loss books exactly when it fits the remaining budget; the market never loses past it | `a_checked_loss_never_spends_past_the_budget` |
| A loss shrinks the remaining budget by at most itself; an equal gain undoes it exactly | `a_loss_shrinks_the_remaining_budget_by_at_most_itself`, `a_gain_undoes_a_loss_exactly` |
| Liquidation books its loss whatever the budget says, and the same as the checked path when it fits | `the_unchecked_loss_is_never_blocked_by_the_budget` |
| Backing is drawn at most the loss and what it holds, restored at most what was drawn, and not at all with no shares held | `a_draw_takes_no_more_than_the_loss_or_the_backing`, `a_restore_repays_only_what_was_drawn`, `a_draw_and_an_equal_restore_leave_backing_as_it_was` |
| A wiped-out pot with shares outstanding refuses new backing | `a_backer_into_a_wiped_out_market_is_not_diluted` |
| A payout is made in full or not at all; the insurance fund pays only what liquidity cannot | `a_payout_is_paid_in_full_or_not_at_all` |
| A losing close is paid once: backers, then LPs, then insurance | `a_losing_close_is_paid_once_backers_first` |
| A winning close repays backers up to what they lost, then LPs | `a_winning_close_repays_backers_then_lps` |
| Pool value never rises as trader profit rises, and never wraps | `aum_falls_as_trader_profit_rises` |
| A market only acts on prices that move forward in time | `a_market_never_goes_back_to_an_older_price` |
| Session and depth caps only tighten the listed leverage | `leverage_caps_only_tighten` |
| Skew funding moves money from the heavy side to the light side and creates none | `skew_funding_is_paid_by_the_heavy_side_to_the_light_side` |
| Borrow charges both sides alike, never credits, and accrues at most 8 hours per crank | `borrow_charges_both_sides_alike_and_is_capped_in_time` |

## LP deposits and withdrawals: `liquidity.rs` (14)

Amounts 0 to 31 and PnL from -32 to 31 unless a harness says otherwise.

| Property | Harnesses |
| --- | --- |
| A deposit mints every whole share it paid for and no more, losing under one share to rounding | `a_deposit_mints_every_whole_share_it_paid_for_and_no_more`, `a_depositor_loses_less_than_one_share_to_rounding` |
| A deposit then withdrawal returns at most the deposit | `a_deposit_then_withdrawal_returns_at_most_the_deposit` |
| A deposit never lowers the share price, under water included | `a_deposit_never_lowers_the_share_price`, `a_deposit_into_an_underwater_pool_is_not_diluted` |
| The first deposit mints one share per dollar and needs at least 1 USDC; leftover USDC goes to insurance first | `the_first_deposit_mints_one_share_per_dollar_above_the_minimum`, `the_first_depositor_gets_only_what_they_paid_for` |
| A deposit raises pool value by at most itself | `a_deposit_raises_aum_by_at_most_itself` |
| A withdrawal pays at most its share, lowers value by at most what it pays, and never lowers the share price | `a_withdrawal_pays_at_most_its_share`, `a_withdrawal_lowers_aum_by_at_most_what_it_pays`, `a_withdrawal_never_lowers_the_share_price` |
| An allowed withdrawal is paid only from free LP liquidity; locked capital and other money stay put | `an_allowed_withdrawal_leaves_locked_capital_and_other_money_in_place` |
| The same shares withdraw for no more when traders are further up | `a_withdrawal_is_worth_less_when_traders_are_further_up` |
| In-kind holdings are valued at holdings times price, rounded down | `in_kind_value_is_holdings_times_price_rounded_down` |

## Listing and depth: `listing.rs` (14)

Validation harnesses take every parameter at full width.

| Property | Harnesses |
| --- | --- |
| Market parameters are accepted exactly when consistent; no accepted market opens a position already liquidatable | `validate_accepts_exactly_the_consistent_markets` |
| A non-authority listing is accepted exactly inside the listing bounds | `validate_listing_accepts_exactly_the_listing_bounds` |
| Pool fee shares fit one fee; a custody never counts a token above its value | `pool_params_accept_exactly_a_split_that_fits_the_fee`, `custody_params_never_count_a_token_above_its_value` |
| Leverage is the documented depth tier (2x, 3x from $10k, 4x from $50k, 5x from $250k), never falls as depth grows, never passes 5x | `leverage_is_the_documented_tier`, `leverage_never_falls_as_depth_grows`, `no_depth_tier_passes_the_listing_cap` |
| One crank raises leverage by at most one tier, never above its reading, at most once per 20 seconds, by at most a tenth of the gap | `one_crank_raises_leverage_by_at_most_one_tier`, `a_crank_never_grants_more_leverage_than_its_reading`, `a_burst_of_cranks_rises_at_most_once`, `a_rise_is_at_most_a_tenth_of_the_gap` |
| The depth a budget may be cut to moves at most a tenth of the gap per crank | `one_crank_cuts_budget_depth_by_a_tenth_at_most` |
| Anyone may cut a budget to measured depth, never raise it; more depth never leaves a smaller budget | `a_derived_budget_only_ever_cuts_to_depth`, `a_deeper_pool_never_leaves_a_smaller_budget` |

## Money math: `money.rs` (26)

Amounts and prices below 2^8, or 0 to 15 where a harness divides by a
quotient. Harnesses that only add, subtract or compare run full range.

| Property | Harnesses |
| --- | --- |
| `mul_div` rounds down and never panics; a fraction at most one never grows an amount; 100% is the whole; two cuts never exceed it | `mul_div_is_floor_and_never_panics`, `mul_div_by_at_most_one_never_grows`, `bps_of_everything_is_everything`, `two_bps_cuts_never_exceed_the_whole` |
| Signed balance changes are exact or saturate at zero; a credit then the matching debit is the identity | `apply_signed_adds_exactly_or_saturates`, `apply_signed_credit_then_debit_is_identity` |
| Long and short PnL are exact negatives, follow the price, and refuse a zero entry | `long_and_short_pnl_are_exact_negatives`, `pnl_sign_and_size_follow_the_price`, `pnl_refuses_a_zero_entry` |
| Funding flips with the index and is never rounded toward the payer | `funding_is_antisymmetric_and_signed_by_the_index` |
| Equity is collateral plus PnL less funding, floored at zero | `equity_is_exact_and_floored_at_zero` |
| A blended entry lies between the two prices; adding nothing keeps it | `blended_entry_lies_between_the_two_prices`, `adding_nothing_keeps_the_entry_price` |
| Tokens paid to LPs for a loss cover it by at most one base unit, fit inside the holding, and refuse a zero price | `tokens_for_usd_covers_the_loss_by_at_most_one_unit`, `a_partial_take_fits_inside_the_holding`, `tokens_for_usd_refuses_a_zero_price` |
| Syncing in-kind backing never takes more than a custody holds or the LPs are owed | `sync_never_takes_more_than_held_or_owed` |
| New backing never dilutes, gets every whole share it paid for, and is refused into a pot worth nothing | `new_backing_never_dilutes_existing_backers`, `new_backing_gets_every_whole_share_it_paid_for`, `shares_into_a_wiped_pot_keep_their_value` |
| The LPs' share of a market's loss is between zero and the loss, past `i64::MAX` too | `lp_borne_is_between_zero_and_the_net_loss`, `lp_borne_past_i64_max` |
| Pool price reading never panics; the square-root price rises with the tick | `apply_decimals_never_panics`, `to_usd_scale_never_panics_and_rounds_down`, `sqrt_price_rises_with_the_tick`, `sqrt_price_never_panics` |

## Orders and liquidation: `orders.rs` (11)

Sizes, collateral and prices 0 to 255 or narrower; funding in quarter-steps.

| Property | Harnesses |
| --- | --- |
| An accepted open is inside the leverage cap, closed session included | `an_accepted_open_is_inside_the_leverage_cap` |
| An accepted add is inside the cap net of owed funding, and never flips a position | `an_accepted_add_is_inside_the_leverage_cap_net_of_funding` |
| An accepted open stays inside the open interest cap | `an_accepted_open_is_inside_the_open_interest_cap` |
| An open reserves nothing; profit is held to what the market can pay at close | `an_accepted_open_reserves_nothing` |
| Whatever `check_open` accepts, `book_open` books, exactly | `an_accepted_open_always_books_exactly` |
| An add books exactly and blends entry and funding index between old and new | `an_add_books_exactly_and_blends_between` |
| The open fee is booked exactly once, however it is split | `an_open_fee_is_booked_exactly_once` |
| A position is liquidatable exactly when equity is under maintenance | `only_a_position_under_maintenance_is_liquidated` |
| The liquidator gets at most the fee, out of the position, never LP capital | `a_liquidator_is_paid_at_most_the_fee` |
| A liquidation costs the pool at most the position's profit and the remaining budget | `a_liquidation_costs_the_pool_at_most_the_profit_and_the_budget` |
| No wallet holds more than 4 live orders in a batch, or opens both ways | `no_wallet_holds_more_than_four_orders_in_a_batch` |

## Settlement and fees: `settlement.rs` (13)

Balances up to 2^20, payouts up to 2^21, fees up to 2^10.

| Property | Harnesses |
| --- | --- |
| Fee cuts never exceed the fee, move money without creating any, and give each line its share: 20% protocol, 10% chain, 10% insurance | `fee_cuts_never_exceed_the_fee`, `fee_cuts_move_money_without_creating_any`, `each_fee_line_gets_its_documented_share` |
| A forced close pays what is owed up to the budget, settles inside it, and moves exactly the payout out of the vault | `a_forced_close_pays_what_is_owed_up_to_the_budget`, `a_forced_close_settles_inside_the_budget`, `a_forced_close_moves_exactly_the_payout_out_of_the_vault` |
| A haircut never pays more than the profit owed, the remaining budget or the money there is | `a_haircut_pays_no_more_than_the_market_can` |
| Every close books inside the budget, whatever it costs | `every_close_books_inside_the_budget` |
| A close that costs the pool nothing is never haircut | `a_close_that_costs_the_pool_nothing_is_never_haircut` |
| Deleveraging is retired: no position is ever due | `no_position_is_ever_due_for_deleveraging` |
| Close reservations never promise more than the position holds; a release gives back exactly what was reserved | `reservations_never_promise_more_than_the_position_holds`, `a_release_gives_back_exactly_what_was_reserved` |
| A settling close takes only what is there, on its own side | `a_settling_close_takes_only_what_is_there_on_its_own_side` |

## Where harnesses stub, and what covers it

A stub replaces a function with a stand-in so the solver finishes. Every
harness stubs the text of Anchor errors and the event log; no property reads
either. These stubs replace logic:

| Stub | Harnesses | What it replaces | Covered instead by |
| --- | --- | --- | --- |
| `any_retrack`, `any_retrack_funding`, `any_side_avg` | `an_accepted_open_always_books_exactly`, `an_add_books_exactly_and_blends_between`, `an_open_fee_is_booked_exactly_once` | Side tracking: the market's moment sums, funding sums and side average. Any value is returned, so the harness asserts nothing about them. | Randomised tests in `instructions/trade.rs`: `the_sums_match_the_positions_and_no_winner_is_paid_past_its_share` and `the_funding_sums_match_the_positions_and_bound_their_bad_debt` (60 seeds of 250 random opens, closes and price moves each) |
| `close_side_sizes_only` | `every_close_books_inside_the_budget`, `a_close_that_costs_the_pool_nothing_is_never_haircut` | `Market::close_side`. Open interest comes off exactly; the side average is left as any value and the moment sums untouched. | The same randomised tests, and `a_close_takes_its_own_entry_off_the_side_average` |
| `winners_bound_unreached` | `a_haircut_pays_no_more_than_the_market_can`, `every_close_books_inside_the_budget`, `a_close_that_costs_the_pool_nothing_is_never_haircut` | The moment bound on a side's winners. Every position in these harnesses is untracked, so each side counts at its net profit, and the stand-in fails the harness if it is ever called. The haircut bound for tracked sides is not proven. | `the_sums_match_the_positions_and_no_winner_is_paid_past_its_share`, `the_bound_is_exact_with_one_entry_and_close_on_the_repro`, `a_side_holding_an_untracked_position_counts_net_until_it_is_gone`, `isqrt_ceil_is_the_smallest_root` |

Two more limits:

1. **`liquidity.rs` mirrors the handlers.** `add_liquidity` and
   `claim_withdraw` are Anchor handlers, so the harnesses check helpers that
   repeat their share arithmetic line for line. A change to the handler has
   to be carried into the helper. Unit tests in `instructions/liquidity.rs`
   run the real two-step round trip.
2. **Pure products are left to tests.** Share prices, the utilization cap,
   the fill spread and the band multiply unknowns in 128 bits, which the
   solver does not finish. Exhaustive unit tests cover them.

## What the proofs found

12 real bugs. Each is fixed, and the check that would catch it again stays in
the suite.

| Bug | Fix | Checked by |
| --- | --- | --- |
| When the pool filled leftover demand, both sides of the book got its share; an order could fill 3x its size, the extra collateral taken from the pool | The pool's share goes only to the side it fills | `no_order_fills_past_its_size` |
| An exact tie between two prices went to whichever came first in submission order | The lower price wins | `submission_order_never_changes_the_price` |
| A deposit into backing drawn to zero was shared with the worthless shares: 1,000 old shares and a 1,000 deposit handed the old holders 500 | Refused | `a_backer_into_a_wiped_out_market_is_not_diluted` |
| After every backer left, a gain refilled the pot for whoever backed next | The gain stays with the LPs | `a_restore_repays_only_what_was_drawn` |
| A position up only on funding, in a market with its budget spent, could not close, deleverage or be liquidated | Fixed then; deleveraging has since been retired and such a winner leaves at a haircut | unit test `a_winner_by_funding_leaves_with_its_collateral_when_the_budget_is_spent` |
| Trader profit was taken from USDC before in-kind tokens were added, so a deposit into an underwater pool was diluted: 1,000,000 in, 499,997 out | Profit comes off everything the pool holds; a pool worth nothing refuses deposits | `a_deposit_into_an_underwater_pool_is_not_diluted` |
| After the last LP left, the fee they paid went to the next depositor | Swept to insurance before a first deposit | `the_first_depositor_gets_only_what_they_paid_for` |
| One crank with parked liquidity (a flash loan is enough) lifted a new market from 2x to 5x | At most one tier per crank | `one_crank_raises_leverage_by_at_most_one_tier` |
| `conf_bps` wrapped for an absurd confidence and read as narrow | Saturates | `a_wider_confidence_never_reads_as_narrower` |
| A tiny observed mark froze: the clamp's step rounded to zero | Step of at least one unit | `the_mark_moves_at_most_its_clamp_and_toward_the_reading` |
| A tick of `i32::MIN` panicked instead of being refused | Refused | `sqrt_price_never_panics` |
| Three casts from u64 to i64 could wrap past about $9.2 trillion | Checked | `lp_borne_past_i64_max` |

## Stateful fuzzing

`fuzz/` runs the compiled program in a local Solana VM and sends it random
sequences of actions: opens, closes, cancels, clears, settles, trader
crosses, price walks and gaps of up to 90%, clock jumps, funding accruals,
liquidations, LP deposits and withdrawals, and backing changes. Rejected
instructions are fine. After every one that lands, it checks:

1. **Solvency, exactly.** The vault holds liquidity, backing, protocol,
   chain and insurance balances, trader collateral, escrow and rewards, to
   the unit.
2. **Supply.** USDC and LP tokens are conserved.
3. **Totals.** Open interest, collateral, escrow, close reservations and
   backing on the pool and each market equal the sums over positions.
4. **Budget.** A market's net loss never exceeds its loss budget, and the
   bounds behind haircuts and LP claims never understate.
5. **Settlement.** An order in a sealed batch can always be settled.

Around specific actions it also checks that funding creates no money and
that a deposit or claim never dilutes the remaining LPs. About 270,000
actions have run with no failure. Failing sequences shrink to the shortest
case and are kept as regressions.

Not yet driven by the fuzzer: trigger orders, splits, in-kind backing,
referral rewards, and a draw on the insurance fund.

## What is not proven

1. **Whole instructions.** Account validation, token transfers and the
   instruction handlers end to end are covered by unit and integration
   tests and by the stateful fuzzer, not by proofs.
2. **Keeper marks.** `push_mark` sets a market's mark to whatever the keeper
   key sends. The clamp proof covers the permissionless `observe` fold, not
   keeper pushes. What bounds a pushed mark's effect is the risk price,
   which is proven.
3. **Large batches and prices.** The properties are about structure, not
   magnitude, so small bounds cover every ordering, every tie and the pool on
   either side. Unit tests run larger values, including a full 64-slot batch.
4. **The server and the site.** Keepers, the faucet, seasons and the creator
   score are off-chain and untested by Kani.

The program has not been audited.
