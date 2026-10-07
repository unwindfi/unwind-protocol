# Verification

## Overview

| | |
| --- | --- |
| Kani harnesses | 190, in 15 files under `programs/unwind/src/proofs/` |
| Rust unit tests | 536 `#[test]` functions in `programs/unwind/src` |
| Integration tests | `tests/unwind.ts`, `tests/system.ts` and `tests/coverage.ts`, against a local validator |
| Server unit tests | 57 in `scripts/server-logic.test.ts`, run with `npm run test:server` |
| Audit | None |

[Kani](https://model-checking.github.io/kani/) is a model checker for Rust. A
test checks the inputs somebody wrote down. A Kani harness makes its inputs
symbolic, states what they may be, and checks a property for every input
inside those bounds, or produces the input that breaks it.

The harnesses compile only under Kani, never into the deployed program. Run
them with:

```
cd programs/unwind
cargo kani                                   # all 190
cargo kani --harness proofs::money::pnl_refuses_a_zero_entry --exact   # one
```

Each file states its bounds at the top, and each harness repeats any bound
of its own in its doc comment. The tables below are those doc comments, one
row per property.

The whole suite takes about two and a half hours on one core. The slowest
harnesses take ten to eleven minutes each; most take under a minute. A
128-bit division by a symbolic value is what costs the solver time, so the
newer files keep each harness to a few of them and say which bounds that
forced.

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

## Side tracking: `tracking.rs` (16)

The contracts the stubs in `orders.rs` and `settlement.rs` rely on. Sums
any value; sizes and entries 0 to 15, or 0 to 7 where a harness takes four
moment terms or runs a whole `close_side`.

| Property | Harnesses |
| --- | --- |
| A moment term rounds `size / entry` down and `size / entry^2` up, the direction the winners bound needs | `moment_terms_round_the_way_the_bound_needs` |
| A term put into a side's sums and taken out leaves them exactly as they were; a replacement takes out exactly the old term and puts in exactly the new | `a_moment_term_put_in_and_taken_out_leaves_the_sums_as_they_were`, `a_retrack_replaces_one_term_exactly` |
| The same for the funding sums, whose least cover and worst entry only move toward the worse value | `a_funding_term_put_in_and_taken_out_leaves_the_sums_as_they_were`, `min_cover_and_worst_entry_only_move_toward_the_worse_value` |
| `retrack` and `retrack_funding` never fail or panic, whatever the sums | `retrack_never_fails_or_panics`, `retrack_funding_never_fails_or_panics` |
| The side average answers only for a fully tracked side, never zero; one position averages at its entry, two between theirs | `the_side_average_answers_only_for_a_fully_tracked_side`, `one_tracked_position_averages_at_its_entry`, `two_tracked_positions_average_between_their_entries` |
| `close_side` takes exactly the closed size off an untracked side and leaves every sum alone; on a tracked position it takes its own terms out | `close_side_takes_exactly_the_closed_size_off_an_untracked_side`, `closing_a_tracked_position_takes_its_own_terms_out` |
| The winners bound is reached only for a fully tracked side; an untracked side counts at its net profit | `the_winners_bound_is_reached_only_for_a_fully_tracked_side` |
| `isqrt_ceil` is the smallest root, below 2^16 | `isqrt_ceil_is_the_smallest_root` |
| The winners bound never falls below what one or two tracked positions hold, a winner beside a loser included, and for one is above it only by rounding, at most four units | `the_winners_bound_covers_one_tracked_position`, `the_winners_bound_covers_two_tracked_positions` |

## Funding: `funding.rs` (13)

`funding_k` and the hourly cap any u16 in every harness. Books are concrete
or 1 to 15 a side, as each harness says: an accrual is half a dozen 128-bit
divisions, and the solver finishes two to four of them.

| Property | Harnesses |
| --- | --- |
| The heavy side's index never falls | `the_heavy_side_index_never_falls` |
| The light side is never credited more than the heavy side pays, on every book of 1 to 15 a side; settled position by position, funding never mints | `the_light_side_is_never_credited_more_than_the_heavy_side_pays`, `positions_settling_funding_never_mint` |
| Borrow is one non-negative charge on both sides, added to the skew leg without changing it | `the_borrow_leg_is_one_non_negative_charge_on_both_sides` |
| One accrual charges at most 8 hours, whatever the clock; a clock that stands still or runs back charges nothing; a second accrual in the same second changes nothing | `elapsed_time_is_clamped_to_the_accrual_window`, `a_clock_that_stands_still_or_runs_back_accrues_nothing`, `a_second_accrual_at_the_same_time_changes_nothing` |
| The skew rate is the linear curve up to its cap, and more skew never lowers it | `the_skew_rate_is_the_linear_curve_up_to_its_cap`, `more_skew_never_lowers_the_rate` |
| A one-sided or balanced book pays only borrow | `a_one_sided_or_balanced_book_pays_no_skew_funding` |
| Accrual never fails on any book, up to sizes near `u64::MAX` | `accrual_never_fails_on_any_book` |
| Cranking more often never charges the heavy side more | `cranking_more_often_never_charges_the_heavy_side_more` |
| A position owes nothing at its entry index, and otherwise the index move times its size, rounded toward zero | `funding_owed_starts_at_zero_and_is_the_index_move_rounded_toward_zero` |

## Conservation: `conservation.rs` (14)

Full width where a harness only adds, subtracts or compares; 0 to 15, or
below 2^16 or 2^32, where it divides by a symbolic value.

| Property | Harnesses |
| --- | --- |
| Fee cuts move money from liquidity to their lines and create none, on every split the pool accepts | `fee_cuts_move_money_without_creating_any_on_every_split` |
| A backer fee is half the LPs' part, rounded down, and only with shares held | `a_backer_fee_is_half_the_lp_part_and_only_with_shares` |
| Draws and restores conserve held plus drawn backing | `drawing_and_restoring_backing_conserve_held_plus_drawn` |
| New backing never dilutes, counting what is owed back; two backers are worth at most the pot; an exit takes at most its part less what is held back; in and straight out never profits | `new_backing_never_dilutes_counting_what_is_owed_back`, `two_backers_together_are_worth_at_most_the_pot`, `an_exit_takes_at_most_its_part_less_what_is_held_back`, `backing_in_and_straight_out_never_profits` |
| An allowed LP claim leaves locked capital in place; its escrow burns at least the claim and empties on the last; released shares return their part of the points | `an_allowed_claim_leaves_locked_capital_in_place`, `an_escrow_burns_the_claim_and_empties_on_the_last`, `releasing_escrowed_shares_returns_their_part_of_the_points` |
| A payout takes exactly the amount, from liquidity then insurance; the ownerless sweep moves money to insurance and creates none | `a_payout_takes_exactly_the_amount_from_liquidity_then_insurance`, `sweeping_ownerless_liquidity_moves_it_to_insurance_and_creates_nothing` |
| The pool can always lock its headroom and never past its cap; a market locked to its headroom stays under its cap | `the_pool_can_always_lock_its_headroom_and_never_past_its_cap`, `a_market_locked_to_its_headroom_stays_under_its_cap` |

## Liquidation: `liquidation.rs` (6)

Settlement figures and close sizes up to 2^10, any fee and margin, the
documented fee split; 0 to 15 where a harness runs `settle`.

| Property | Harnesses |
| --- | --- |
| A liquidation splits what is left exactly: fee plus owner is the payable equity, and only the cuts stay in the pool | `a_liquidation_splits_what_is_left_exactly` |
| The fee never exceeds what is left; a position through zero pays nobody | `the_liquidation_fee_never_exceeds_what_is_left` |
| Liquidating never leaves the pool worse than a close at the same price | `liquidating_never_leaves_the_pool_worse_than_a_close` |
| The liquidator keeps at least the LPs' 60% of the fee | `the_liquidator_keeps_the_lps_share_of_the_fee` |
| A liquidation fails only on a healthy position | `a_liquidation_fails_only_on_a_healthy_position` |
| Equity never rises as the fill gets worse for the position, so the close never finds healthy what the trigger found failing | `equity_never_rises_as_the_fill_gets_worse_for_the_position` |

## Loss budget and haircut: `haircut.rs` (9)

Budget arithmetic at full width; 0 to 15 where a harness prices a side or
divides by the winners.

| Property | Harnesses |
| --- | --- |
| The haircut is the documented fair share, monotone in what is owed | `the_haircut_is_the_documented_fair_share`, `more_owed_is_never_paid_less` |
| Closing first wins nothing: a later closer is paid at least the share it would have had first, and the two never exceed what was available | `closing_first_wins_nothing` |
| The remaining budget never grows past the budget; a raise never falls or passes its cover; a cap at the cover leaves at most the cover | `the_remaining_budget_never_grows_past_the_budget`, `a_raised_budget_never_falls_and_never_passes_its_cover`, `a_budget_capped_at_its_cover_leaves_at_most_the_cover_remaining` |
| The LPs never count a market past its worst case, and what they owe rises with trader profit | `the_lps_never_count_a_market_past_its_worst_case`, `what_the_lps_owe_rises_with_trader_profit` |
| Backing held back is at most the budget and the profit | `backing_held_back_is_at_most_the_budget_and_the_profit` |

## Positions and pool value: `positions.rs` (6)

| Property | Harnesses |
| --- | --- |
| A trigger closes only what is closable; an order never closes a position opened after its batch | `a_trigger_closes_only_what_is_closable`, `an_order_never_closes_a_position_opened_after_its_batch` |
| Escrowing more restarts the cooldown for everything | `escrowing_more_restarts_the_cooldown_for_everything` |
| Utilization is zero when balanced and never past full | `utilization_is_zero_when_balanced_and_never_past_full` |
| LP value counts profit against USDC and tokens together | `lp_value_counts_profit_against_usdc_and_tokens_together` |
| The AUM drift reads nothing without a price or open interest | `the_drift_reads_nothing_without_a_price_or_open_interest` |

## Where harnesses stub, and what covers it

A stub replaces a function with a stand-in so the solver finishes. Every
harness stubs the text of Anchor errors and the event log; no property reads
either. These stubs replace logic:

| Stub | Harnesses | What it replaces | Covered instead by |
| --- | --- | --- | --- |
| `any_retrack`, `any_retrack_funding`, `any_side_avg` | `an_accepted_open_always_books_exactly`, `an_add_books_exactly_and_blends_between`, `an_open_fee_is_booked_exactly_once` | Side tracking: the market's moment sums, funding sums and side average. Any value is returned, so the harness asserts nothing about them. | Proven: none of the three fails or panics (`retrack_never_fails_or_panics`, `retrack_funding_never_fails_or_panics`, `the_side_average_answers_only_for_a_fully_tracked_side`), and their only reader in `book_open` reads nothing in these markets (`the_drift_reads_nothing_without_a_price_or_open_interest`). Also randomised tests in `instructions/trade.rs`: `the_sums_match_the_positions_and_no_winner_is_paid_past_its_share` and `the_funding_sums_match_the_positions_and_bound_their_bad_debt` (60 seeds of 250 random opens, closes and price moves each) |
| `close_side_sizes_only` | `every_close_books_inside_the_budget`, `a_close_that_costs_the_pool_nothing_is_never_haircut` | `Market::close_side`. Open interest comes off exactly; the side average is left as any value and the moment sums untouched. | Proven: on an untracked position the real function does exactly this and never fails (`close_side_takes_exactly_the_closed_size_off_an_untracked_side`). Also the same randomised tests, and `a_close_takes_its_own_entry_off_the_side_average` |
| `winners_bound_unreached` | `a_haircut_pays_no_more_than_the_market_can`, `every_close_books_inside_the_budget`, `a_close_that_costs_the_pool_nothing_is_never_haircut`, and in `haircut.rs` `the_haircut_is_the_documented_fair_share`, `more_owed_is_never_paid_less` | The moment bound on a side's winners. Every position in these harnesses is untracked, so each side counts at its net profit, and the stand-in fails the harness if it is ever called. | Proven: the bound is reached only for a fully tracked side (`the_winners_bound_is_reached_only_for_a_fully_tracked_side`), and for one or two tracked positions it is never below what they hold (`the_winners_bound_covers_one_tracked_position`, `the_winners_bound_covers_two_tracked_positions`). Also `the_sums_match_the_positions_and_no_winner_is_paid_past_its_share`, `the_bound_is_exact_with_one_entry_and_close_on_the_repro`, `a_side_holding_an_untracked_position_counts_net_until_it_is_gone`, `isqrt_ceil_is_the_smallest_root` |
| `mul_div_u128_when_it_fits` | Every `tracking.rs` harness that reaches `mul_div_u128` | `math::mul_div_u128`. Returns the same floor on the path where the product fits in 128 bits, and fails the harness if it is ever called on the wide path. Every product in those bounds fits. | Exact by construction on the path it allows; `mul_div_is_floor_and_never_panics` and unit tests for the wide path |
| `isqrt_ceil_by_contract` | `the_winners_bound_covers_one_tracked_position`, `the_winners_bound_covers_two_tracked_positions` | `isqrt_ceil`. Returns the smallest root, and fails the harness for an input of 2^16 or more. | `isqrt_ceil_is_the_smallest_root`, every input below 2^16 |

Two more limits:

1. **`liquidity.rs` mirrors the handlers.** `add_liquidity` and
   `claim_withdraw` are Anchor handlers, so the harnesses check helpers that
   repeat their share arithmetic line for line. A change to the handler has
   to be carried into the helper. Unit tests in `instructions/liquidity.rs`
   run the real two-step round trip. `conservation.rs` proves the pieces of
   `claim_withdraw` that are functions of their own
   (`check_withdrawal_allowed`, `escrow_burn`, `WithdrawRequest::release`)
   directly. `split_claim` is not proven: it is a dozen 128-bit divisions by
   symbolic values, which did not finish in ten minutes even at three bits.
2. **Pure products are left to tests.** Share prices, the utilization cap,
   the fill spread and the band multiply unknowns in 128 bits, which the
   solver does not finish. Exhaustive unit tests cover them.

## What the proofs found

The 64 harnesses added with `tracking.rs`, `funding.rs`, `conservation.rs`,
`liquidation.rs`, `haircut.rs` and `positions.rs` found no new bug. One
claim turned out looser than written: the winners bound on a single tracked
position is above the profit by up to four units at small sizes, not one,
all of it rounding up, which only ever pays a winner less.

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
sequences of actions. It sends 50 of the program's 52 instructions mid-run;
`initialize_pool` and `add_custody` run once, in the fixture. Rejected
instructions are fine. A panic, an overflow trap or running out of compute
is not.

Two fixtures:

| | Main | Thin |
| --- | --- | --- |
| LP capital | $1,250,000 | $20,000 |
| Markets | 3 Pyth, 1 keeper-priced, 1 folded from a pool | 2 Pyth |
| Backing | $8,000 to $100,000 USDC each, $20,000 in kind behind one | $1,000 and $2,000 USDC, $10,000 in kind behind one |
| Insurance fund | from fees | $5,000 |
| Custodies | a stable and an oracle-priced token | the same |

Observed markets read fake Raydium CLMM pool accounts: the right owner and
the fields the program reads, written directly. Seasoning, keeper pushes and
depth tracking run in the program.

### What it drives

1. **Trading.** Opens, closes, cancels, clears and settles; traders crossing
   each other; price walks and gaps of up to 99%; clock jumps; funding;
   liquidations; the retired deleverage path, which must refuse.
2. **Trigger orders.** Limits, stops and take-profits placed, fired, expired
   and cancelled, including after gaps, size changes and liquidations.
3. **Splits.** Price ratios from a tenth to five times, applied to every
   market on the feed with positions, resting limits and triggers standing.
4. **LPs and backers.** Deposits, two-step withdrawals, claims paid in kind
   and the tokens pulled after; backing in USDC and in kind, withdrawals,
   syncs and marks; price moves of the oracle-priced custody.
5. **Referrals and points.** Codes, referrers, syncs to referrers and
   listers, reward claims, points.
6. **The authority, mid-flight.** Budget cuts, market and pool pauses,
   sessions, parameter changes (funding, fees, margin, leverage, caps), fee
   collection, funding the insurance fund, handing the authority over and
   back, the points switch, the mark keeper, resizes.
7. **Observed markets.** Readings, keeper pushes, a pool thinned until the
   budget is cut to its depth, a new generation seasoned from nothing.
8. **Listings and batches.** New generations of a feed, by the authority or
   by a trader within the listing bounds; 64-order batches, the fifth order
   from one wallet and the 65th in a batch.

### What it checks

After every transaction that lands:

1. **Solvency, exactly.** The vault holds liquidity, backing, protocol,
   chain and insurance balances, trader collateral, escrow and rewards, to
   the unit.
2. **Supply.** USDC, LP shares and both custody tokens are conserved. Each
   custody's vault holds its backers' tokens, the LPs', what claims are
   owed and the insurance fund's, and each of the first three is the sum of
   the accounts behind it.
3. **Totals.** Open interest, collateral, escrow (orders and open triggers),
   close reservations and backing equal the sums over the accounts. The
   rewards line equals what wallets may claim plus what referees and
   markets owe.
4. **Bounds.** The bounds behind haircuts and LP claims never understate
   where a side is tracked. After a split a side's aggregates are the old
   rule until the positions open across it close (`rescale_market`); there
   their drift from the positions is measured, not enforced.

Against the state before it:

1. **Fees, to the unit.** Every open, close and liquidation splits as
   [Fees](fees.md) says: 20% protocol, 10% chain, 10% insurance, half the
   rest to backers on a backed market, the discounts, and the liquidator's
   60%.
2. **Rewards.** Only out of the protocol's 20%, exactly what the referrer
   and the lister are owed, and a claim pays exactly what was owed.
3. **Who pays a loss.** The insurance fund falls only in a settlement or a
   liquidation, only with LP liquidity at zero and the market's backing
   gone. A loss is charged only within the budget. In-kind backing repays
   the LPs no more than they bore of a market's loss past its USDC backing,
   after what the fund paid of it, by a ledger of the fund's draws and
   repayments built from the program's events.
4. **Points** never fall.

Around particular actions: funding creates no money; a deposit or claim
never dilutes the LPs who stay; trading alone never raises the LPs' value
without someone losing it; a split keeps every position's value and moves
limits, triggers and the risk price with it; settlement is never refused;
and every settle, claim, trigger, cancel, sync and liquidation sent a
second time is refused or moves nothing.

Ordering, on a copy of the world: a batch cleared with its orders reversed
in their slots clears at the same prices and fills every order the same,
and a sealed batch settled in reverse leaves every trader, the pool and the
market's backers holding the same, to within a unit of rounding per blended
fill. Counted rather than failed, as documented: a wallet that closes and
opens in one batch, haircuts under a binding budget, and fee cuts clamped to
LP liquidity that is nearly gone.

### Runs

The last campaign, 12 seeds of 2,000 cases of up to 120 actions each:
1,455,419 actions, 728,543 on the main fixture and 726,876 on the thin one,
in 29 minutes of CPU. No invariant failed apart from the three findings
below. Every instruction it sends landed at least once, except
`auto_deleverage`, which refuses every position by design. Some of what it
reached:

| | Main | Thin |
| --- | --- | --- |
| Settlements | 459,453 | 374,323 |
| Batches compared cleared in reverse / settled in reverse | 7,636 / 7,910 | 8,766 / 9,190 |
| Transactions replayed, refused or a no-op | 498,482 | 414,125 |
| Splits applied | 6,304 | 5,054 |
| Triggers fired / expired | 2,336 / 247 | 3,178 / 272 |
| Liquidations | 3,003 | 11,499 |
| Full 64-order batches | 5,740 | 3,960 |
| Rewards claimed | 685 | 723 |
| Budgets cut to a pool's depth | 293 | |
| New observed marks seasoned | 83 | |
| Insurance fund draws | | 62 |
| In-kind payments to the LPs / token claims | | 94 / 34 |

A clearing with the orders reversed never moved a price, a matched total or
a single order's fill.

Defaults run in seconds. A long run:

```
cd fuzz
FUZZ_CASES=2000 FUZZ_STEPS=120 FUZZ_SEED=7 cargo test --release --test stateful_fuzz stateful_fuzz -- --nocapture
```

`stateful_fuzz_thin` is the thin fixture. Failing sequences shrink to the
shortest case and are kept as regressions.

### Findings

Three, in `fuzz/FINDINGS.md`, all fixed. Each regression test now runs with
the rest:

1. The in-kind sync repaid the LPs for losses the insurance fund paid. The
   fund is now repaid first, in tokens (see
   [Loss budget](loss-budget.md#backing-held-in-tokens)).
2. The order a sealed batch was settled in moved value between the market's
   backers and the LPs. A batch's closes are now netted (see
   [Loss budget](loss-budget.md#a-batch-is-settled-as-one)).
3. A split that rounded a position's entry to zero blocked settlement.
   Rebased entries now floor at one unit (see
   [Corporate actions](corporate-actions.md)).

After the fixes, 3 seeds of 1,000 cases of up to 120 actions on each
fixture with `FUZZ_STRICT=1`, which fails on any finding too: 361,960
actions, no invariant failed.

### Not yet driven

1. **Meteora DLMM pools** and seeding a mark from a Raydium pool's history:
   observed markets here read CLMM pools only.
2. **More than one pool**: rewards tied to a pool, and claims from another.
3. **Accounts from older layouts**: `resize_*` runs only on accounts already
   at full size.
4. **New custodies or pools mid-run**: both are created in the fixture.
5. **Token-2022 mints.**

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
   either side. Unit tests run larger values, including a full 64-slot batch,
   and the stateful fuzzer clears and settles full batches.
4. **The server and the site.** Keepers, the faucet, seasons and the creator
   score are off-chain and untested by Kani.
5. **Side tracking beyond two positions.** The winners bound is proven for
   one or two tracked positions with values to 15 and 7. The bad debt bound
   (`side_bad_debt_bound_usd`), which `lp_claim_pnl_usd` adds, is not proven;
   randomised tests cover both.
6. **Funding over symbolic books.** Every funding harness takes any curve and
   cap, but most run on concrete books: a symbolic book is a 128-bit
   division by a symbolic size, and only the no-mint property is proven
   over every book (1 to 15 a side).
7. **LP claim splitting and backing at scale.** `split_claim` and the
   chained share arithmetic of backing are proven only in parts, at four
   bits; unit tests cover the rest.
8. **Resource-limited.** These were written and did not finish in 15
   minutes at the smallest bounds that keep them meaningful, so they are
   not in the suite: a close that carries its own fee
   (`apply_settlement_to_pool` with a nonzero fee; the fee-free close and
   the fee cuts are proven separately), `split_claim` alone and two claims
   in a row, corporate-action entry adjustment (`adjust_entry_price`), and
   the size-weighted held clock (`Position::add_held`).

The program has not been audited.
