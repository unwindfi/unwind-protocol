# Verification

## Overview

The program's arithmetic is checked with [Kani](https://model-checking.github.io/kani/),
a model checker for Rust: the auction, the money math, the loss budget and
backing, settlement and fees, listing and leverage tiers, and the price feeds. A test checks the inputs somebody thought to write
down. A Kani proof checks every input inside its bounds: it treats the orders,
prices, sizes and pool quote as unknowns, explores every combination that
satisfies its assumptions, and either proves the property holds for all of
them or produces the input that breaks it.

The proofs live in `programs/unwind/src/proofs/`, one file per part of the
program, and are compiled only by Kani, never into the deployed program. Run them with:

```
cd programs/unwind
cargo kani
```

## What is proven

The auction. For a batch of three orders, any mix of bids and asks, makers and takers,
over four price levels and sizes up to fifteen, with any pool quote and any
band around the oracle:

| Property | Proof |
| --- | --- |
| No order fills more than its own size | `no_order_fills_past_its_size`, `a_flow_fills_every_order_within_its_size_limit_and_band` |
| Every fill is at a price no worse than the order's limit | `fills_respect_every_limit`, `a_flow_fills_every_order_within_its_size_limit_and_band` |
| A batch never clears outside the band around the oracle | `a_banded_batch_clears_inside_the_band`, `a_flow_fills_every_order_within_its_size_limit_and_band` |
| Neither side of a flow is allocated more than it trades, and the pool's share goes only to the side it fills | `each_side_fills_at_most_what_it_trades`, `each_side_of_a_flow_fills_at_most_what_it_trades` |
| The pool never takes more than its quote, never both sides at once, and never at a worse price than it quoted | `the_pool_stays_inside_its_quote` |
| The pool fills takers only: it sells in the buy flow and buys in the sell flow | `the_pool_fills_only_takers_within_its_quote` |
| Every order is cleared in exactly its own flow | `the_split_puts_every_order_in_its_own_flow` |
| The clearing price crosses at least as much volume as any price at all, and breaks ties by least imbalance, then nearest the oracle, then the lower price, exactly as documented | `the_clearing_price_is_the_documented_argmax` |
| Without the pool, a batch trades exactly when some bid meets some ask | `a_book_trades_on_its_own_exactly_when_it_crosses` |
| Fills add up: buyers receive what sellers deliver plus the pool's net, losing at most one unit of rounding per order and never allocating what did not trade | `fills_conserve_what_trades` |
| Submission order never changes anything: whether a batch trades, the price, how much trades, the pool's take, or any order's fill | `the_clearing_is_independent_of_submission_order`, `submission_order_never_changes_the_price`, `submission_order_does_not_change_the_pools_take`, `submission_order_does_not_change_any_fill` |
| A better limit fills in full before the margin fills anything, and at one limit a larger order never fills less | `a_better_price_fills_first_and_size_never_hurts` |
| Splitting an order wins nothing: the pieces fill no more than the whole, and lose at most one unit | `splitting_an_order_wins_nothing` |

Around the auction, with the bounds each harness states:

| Property | Proof |
| --- | --- |
| An insert takes the lowest free slot and moves nobody; no wallet goes past its limit; an order is refused only for the limit or a full batch | `inserting_takes_the_first_free_slot_and_nothing_else` |
| A full or sealed batch refuses every order and changes nothing | `a_full_batch_refuses_and_overwrites_nothing`, `a_sealed_batch_takes_no_orders` |
| A batch is due exactly one second after it opens and stays due; reopening keeps every standing order, rolling clears them, both start a fresh window | `a_batch_is_due_exactly_after_its_interval`, `a_new_window_opens_clean` |
| One reading moves the observed mark at most its clamp (or one unit, so a tiny mark never freezes), only toward the reading, and never to zero | `the_mark_moves_at_most_its_clamp_and_toward_the_reading` |
| A reading counts toward seasoning exactly once, a rejected one not at all, and the seasoning window starts at the first reading | `a_reading_counts_once_and_a_rejected_one_not_at_all` |
| Sustained depth falls at once and rises by at most a tenth of the gap, once per interval | `sustained_depth_falls_at_once_and_rises_slowly` |
| An observed mark's confidence never exceeds the mark | `observed_confidence_never_exceeds_the_price` |
| Pyth readings are rescaled exactly (up) or truncated (down), or refused; never wrapped or served as zero | `scaling_a_reading_up_is_exact_or_refused`, `scaling_a_reading_down_truncates_or_refuses` |
| For a confidence inside the price, `conf_bps` is the floor of the true ratio | `conf_bps_is_the_floor_of_the_true_ratio` |

Money math, with the bounds each harness states:

| Property | Proof |
| --- | --- |
| Scaling rounds down, never panics, never grows an amount by a factor of at most one, and two fee cuts never exceed the whole | `mul_div_is_floor_and_never_panics`, `mul_div_by_at_most_one_never_grows`, `bps_of_everything_is_everything`, `two_bps_cuts_never_exceed_the_whole` |
| Signed balance changes are exact, saturate at zero, and a credit then a matching debit restores the balance | `apply_signed_adds_exactly_or_saturates`, `apply_signed_credit_then_debit_is_identity` |
| A long and a short at the same prices have exactly opposite PnL, whose sign follows the price; a zero entry is refused | `long_and_short_pnl_are_exact_negatives`, `pnl_sign_and_size_follow_the_price`, `pnl_refuses_a_zero_entry` |
| Funding flips sign with the index and is paid by the side it should be | `funding_is_antisymmetric_and_signed_by_the_index` |
| Equity is exactly collateral plus PnL minus funding, floored at zero | `equity_is_exact_and_floored_at_zero` |
| A blended entry price lies between the two prices, and adding nothing keeps it | `blended_entry_lies_between_the_two_prices`, `adding_nothing_keeps_the_entry_price` |
| Tokens paid to LPs for a loss are worth at least the loss, by at most one base unit, and never more than a custody holds | `tokens_for_usd_covers_the_loss_by_at_most_one_unit`, `a_partial_take_fits_inside_the_holding`, `tokens_for_usd_refuses_a_zero_price`, `sync_never_takes_more_than_held_or_owed` |
| New backing never dilutes existing backers, gets every whole share it paid for, and is refused into a wiped-out pot | `new_backing_never_dilutes_existing_backers`, `new_backing_gets_every_whole_share_it_paid_for`, `shares_into_a_wiped_pot_keep_their_value` |
| The LPs' share of a market's loss is between zero and the loss, for every value | `lp_borne_is_between_zero_and_the_net_loss`, `lp_borne_past_i64_max` |
| Pool price reading never panics, and the square-root price rises with the tick | `apply_decimals_never_panics`, `to_usd_scale_never_panics_and_rounds_down`, `sqrt_price_rises_with_the_tick`, `sqrt_price_never_panics` |

Loss budget, backing and funding:

| Property | Proof |
| --- | --- |
| A market never spends past its loss budget on a checked charge; a loss shrinks the remaining budget by at most itself, and a gain undoes it exactly | `a_checked_loss_never_spends_past_the_budget`, `a_loss_shrinks_the_remaining_budget_by_at_most_itself`, `a_gain_undoes_a_loss_exactly`, `the_unchecked_loss_is_never_blocked_by_the_budget` |
| Backing is drawn at most the loss and at most what it holds, restored at most what was drawn, and never refilled while nobody holds a share | `a_draw_takes_no_more_than_the_loss_or_the_backing`, `a_restore_repays_only_what_was_drawn`, `a_draw_and_an_equal_restore_leave_backing_as_it_was`, `a_backer_into_a_wiped_out_market_is_not_diluted` |
| A losing close is paid once, backers first, then LPs, then insurance; a winning close repays backers before LPs gain | `a_losing_close_is_paid_once_backers_first`, `a_winning_close_repays_backers_then_lps`, `a_payout_is_paid_in_full_or_not_at_all` |
| Pool value falls as trader profit rises and never wraps | `aum_falls_as_trader_profit_rises` |
| A market never goes back to an older price, and leverage caps only tighten | `a_market_never_goes_back_to_an_older_price`, `leverage_caps_only_tighten` |
| Skew funding is paid by the heavy side to the light side and never mints money; borrow charges both sides alike and is capped in time | `skew_funding_is_paid_by_the_heavy_side_to_the_light_side`, `borrow_charges_both_sides_alike_and_is_capped_in_time` |

Settlement and fees:

| Property | Proof |
| --- | --- |
| Fee cuts never exceed the fee, move money without creating any, and each line gets its documented share | `fee_cuts_never_exceed_the_fee`, `fee_cuts_move_money_without_creating_any`, `each_fee_line_gets_its_documented_share` |
| A forced close pays what is owed up to the budget, settles inside it, and moves exactly the payout out of the vault | `a_forced_close_pays_what_is_owed_up_to_the_budget`, `a_forced_close_settles_inside_the_budget`, `a_forced_close_moves_exactly_the_payout_out_of_the_vault` |
| A close is cut to what the market can pay, always books when it can pay, and fills in full when it costs the pool nothing | `a_close_is_cut_to_what_the_market_can_pay`, `a_close_the_market_can_pay_always_books`, `a_close_that_costs_the_pool_nothing_fills_in_full` |
| Any winner the budget holds back, from price or from funding, can be deleveraged, so no position is ever stuck | `a_price_winner_the_budget_holds_back_can_be_deleveraged`, `a_winner_the_budget_holds_back_can_be_deleveraged` |
| Close reservations never promise more than a position holds, and a release gives back exactly what was reserved | `reservations_never_promise_more_than_the_position_holds`, `a_release_gives_back_exactly_what_was_reserved`, `a_settling_close_takes_only_what_is_there_on_its_own_side` |

Listing and leverage tiers:

| Property | Proof |
| --- | --- |
| Market, listing, pool and custody parameters are accepted exactly when consistent and inside their bounds | `validate_accepts_exactly_the_consistent_markets`, `validate_listing_accepts_exactly_the_listing_bounds`, `pool_params_accept_exactly_a_split_that_fits_the_fee`, `custody_params_never_count_a_token_above_its_value` |
| Leverage follows the documented depth table, never falls as depth grows, and never passes the listing cap | `leverage_is_the_documented_tier`, `leverage_never_falls_as_depth_grows`, `no_depth_tier_passes_the_listing_cap` |
| One crank raises a market by at most one leverage tier, never above what its reading supports, at most once per interval, by at most a tenth of the gap | `one_crank_raises_leverage_by_at_most_one_tier`, `a_crank_never_grants_more_leverage_than_its_reading`, `a_burst_of_cranks_rises_at_most_once`, `a_rise_is_at_most_a_tenth_of_the_gap` |
| Anyone may cut a market's budget to its measured depth, never raise it, and a deeper pool never leaves a smaller budget | `a_derived_budget_only_ever_cuts_to_depth`, `a_deeper_pool_never_leaves_a_smaller_budget` |

LP deposits and withdrawals:

| Property | Proof |
| --- | --- |
| A deposit mints every whole share it paid for and no more, loses under one share to rounding, and never lowers the share price for LPs already in | `a_deposit_mints_every_whole_share_it_paid_for_and_no_more`, `a_depositor_loses_less_than_one_share_to_rounding`, `a_deposit_never_lowers_the_share_price` |
| A deposit then a withdrawal returns at most the deposit, underwater pools included; a deposit into a pool worth nothing is refused | `a_deposit_then_withdrawal_returns_at_most_the_deposit`, `a_deposit_into_an_underwater_pool_is_not_diluted` |
| The first deposit mints one share per dollar above the minimum, and gets back no more than it paid | `the_first_deposit_mints_one_share_per_dollar_above_the_minimum`, `the_first_depositor_gets_only_what_they_paid_for` |
| A deposit raises pool value by at most itself; a withdrawal pays at most its share, lowers value by at most what it pays, and never lowers the share price for LPs who stay | `a_deposit_raises_aum_by_at_most_itself`, `a_withdrawal_pays_at_most_its_share`, `a_withdrawal_lowers_aum_by_at_most_what_it_pays`, `a_withdrawal_never_lowers_the_share_price` |
| A withdrawal only takes free liquidity, keeps reserved capital in place, and is worth less when traders are further up | `an_allowed_withdrawal_leaves_locked_capital_and_other_money_in_place`, `a_withdrawal_is_worth_less_when_traders_are_further_up` |
| In-kind holdings are valued at holdings times price, rounded down | `in_kind_value_is_holdings_times_price_rounded_down` |

## What the proofs found

Writing these proofs found eleven real problems. Each is fixed, and the proof
that found it now passes and stays in the suite, so the bug cannot come back
unnoticed.

* **Submission order decided an exact tie.** When two prices traded the same
  volume, with the same imbalance, the same distance either side of the
  oracle, the auction kept whichever it met first. A taker bid through the top
  of the band against a maker ask through the bottom always landed here. The
  lower price now wins such a tie, whatever the order.
* **A deposit into wiped-out backing was diluted.** With a market's backing
  drawn to zero and shares still held, a new backer's deposit was shared with
  those worthless shares: 1,000 old shares and a 1,000 deposit handed the old
  holders 500. Such a deposit is now refused until a gain restores some
  backing.
* **A gain could refill a pot nobody owned.** After every backer had left, a
  gain restored to backing went to whoever backed next. It now stays with the
  LPs, and a new backer starts with no claim on earlier losses.
* **A winner on funding could be stuck.** A position up only on funding, with
  its market's budget spent, could neither close, be deleveraged nor be
  liquidated. Deleveraging now reads what it is owed past its collateral.
* **An LP deposit into an underwater pool was diluted.** Trader profit was
  taken from the pool's USDC before its in-kind tokens were added, so the
  tokens counted in full while traders' profit went partly uncovered, and a
  pool worth nothing still minted one share per dollar beside the old shares.
  A 1,000,000 deposit could withdraw for 499,997. Profit is now taken from
  everything the pool holds, and a pool worth nothing refuses deposits.
* **Leftover USDC went to the next LP.** After the last LP withdrew, the fee
  they left behind belonged to nobody, and the next depositor owned it. It is
  swept to the insurance fund before a first deposit now.
* **Parked liquidity bought the top leverage tier.** One crank with liquidity
  parked in a pool (a flash loan is enough) lifted a new market from 2x to 5x.
  A crank now raises a market by at most one tier.
* **`conf_bps` wrapped** for an absurd Pyth confidence and read as narrow. It
  saturates now.
* **A tiny observed mark froze.** The clamp's step rounded to zero below
  `10,000 / max_move_bps` units. The step is at least one unit now.
* **An extreme tick panicked** instead of being refused, and **three casts**
  from u64 to i64 could wrap past about $9.2 trillion. All are checked now.

## What the bounds mean

The properties are about the structure of the clearing, not the size of the
numbers, so small bounds cover the cases that matter: every ordering of bids
and asks, every tie at the clearing price, the pool on either side or none.
Larger batches and prices are covered by the unit and integration tests,
including a full 64-order batch.

The first auction proof found a real bug too. When the pool filled leftover
demand, the allocation handed its share to both sides of the book, and an order
resting at the clearing price could fill up to three times its own size, with
the extra collateral taken from the pool. The proof fails on the code before
the fix and passes after it.

## What is not proven

The proofs cover the program's arithmetic and the pure functions its
instructions call. They do not cover account validation, token transfers or
whole instructions end to end; those are covered by the unit and integration
tests. The program
has not been audited.
