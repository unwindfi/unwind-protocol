use crate::constants::*;
use crate::errors::PerpError;
use crate::state::custody::MAX_CUSTODIES;
use anchor_lang::prelude::*;

/// LP shares on their way out of the pool.
///
/// A withdrawal is two steps. `request_withdraw` moves the shares out of the
/// owner's wallet into an escrow token account the pool controls and stamps
/// the slot. `claim_withdraw` burns them only once `WITHDRAW_COOLDOWN_SLOTS`
/// have passed and pays their part of the pool then: USDC, and the LP-held
/// tokens in kind (`LpTokenClaim`).
///
/// The shares are not burned on request, so they stay in the LP mint's supply
/// and keep taking their part of every loss the pool books while they wait.
/// That is the point: an LP who sees a loss coming cannot step out in front of
/// it, because what they leave with is priced after it lands. They sit in
/// escrow rather than in the wallet because LP tokens move freely: a timer on
/// the wallet would be reset by sending the tokens to another one.
///
/// One per owner per pool. Escrowing more while a request is open adds to it
/// and starts the cooldown again for all of it.
#[account]
#[derive(InitSpace)]
pub struct WithdrawRequest {
    pub bump: u8,
    pub escrow_bump: u8,
    pub pool: Pubkey,
    pub owner: Pubkey,
    /// Shares held in escrow.
    pub shares: u64,
    /// Slot of the last escrow; the cooldown runs from here.
    pub request_slot: u64,
    /// The LP points stake taken off the owner's record with these shares,
    /// put back if they cancel. Points stop accruing on shares in escrow.
    pub points_usd: u64,
}

impl WithdrawRequest {
    /// First slot at which the escrowed shares can be claimed.
    pub fn ready_slot(&self) -> u64 {
        self.request_slot.saturating_add(WITHDRAW_COOLDOWN_SLOTS)
    }

    pub fn is_ready(&self, slot: u64) -> bool {
        slot >= self.ready_slot()
    }

    /// Adds `shares` to the request at `slot`. The cooldown restarts for every
    /// share in escrow, so topping up cannot ride an older request's clock.
    pub fn escrow(&mut self, shares: u64, points_usd: u64, slot: u64) -> Result<()> {
        require!(shares > 0, PerpError::ZeroAmount);
        self.shares = self.shares.checked_add(shares).ok_or(PerpError::MathOverflow)?;
        self.points_usd = self
            .points_usd
            .checked_add(points_usd)
            .ok_or(PerpError::MathOverflow)?;
        self.request_slot = slot;
        Ok(())
    }

    /// Takes `shares` out of the request, returning their part of the points
    /// stake. Refuses more than is escrowed.
    pub fn release(&mut self, shares: u64) -> Result<u64> {
        require!(shares > 0, PerpError::ZeroAmount);
        require!(shares <= self.shares, PerpError::InsufficientLiquidity);
        let points = ((self.points_usd as u128) * (shares as u128) / (self.shares as u128)) as u64;
        self.shares -= shares;
        self.points_usd -= points;
        Ok(points)
    }
}

/// LP-held tokens a withdrawal claim is owed in kind, waiting to be pulled.
///
/// `claim_withdraw` pays USDC and takes the claim's part of every custody's
/// LP tokens off `Custody::lp_amount` at the same time, but sending each one
/// would mean carrying every custody's vault and the owner's token accounts
/// in the claim. So the amounts are recorded here and pulled one custody at a
/// time with `claim_withdraw_tokens`. They are fixed at the claim: nothing
/// anyone does afterwards changes them. One per owner per pool; it closes when
/// the last token is pulled.
#[account]
#[derive(InitSpace)]
pub struct LpTokenClaim {
    pub bump: u8,
    pub pool: Pubkey,
    pub owner: Pubkey,
    /// Tokens owed from each custody, by `Custody::index`.
    pub owed: [u64; MAX_CUSTODIES],
}

impl LpTokenClaim {
    pub fn is_empty(&self) -> bool {
        self.owed.iter().all(|&t| t == 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> WithdrawRequest {
        WithdrawRequest {
            bump: 0,
            escrow_bump: 0,
            pool: Pubkey::default(),
            owner: Pubkey::default(),
            shares: 0,
            request_slot: 0,
            points_usd: 0,
        }
    }

    #[test]
    fn a_request_is_claimable_only_after_the_cooldown() {
        let mut r = request();
        r.escrow(100, 0, 1_000).unwrap();
        assert!(!r.is_ready(1_000));
        assert!(!r.is_ready(1_000 + WITHDRAW_COOLDOWN_SLOTS - 1));
        assert!(r.is_ready(1_000 + WITHDRAW_COOLDOWN_SLOTS));
    }

    #[test]
    fn topping_up_restarts_the_cooldown_for_everything_in_escrow() {
        let mut r = request();
        r.escrow(100, 0, 1_000).unwrap();
        let later = 1_000 + WITHDRAW_COOLDOWN_SLOTS - 1;
        r.escrow(1, 0, later).unwrap();
        assert_eq!(r.shares, 101);
        assert!(!r.is_ready(1_000 + WITHDRAW_COOLDOWN_SLOTS));
        assert!(r.is_ready(later + WITHDRAW_COOLDOWN_SLOTS));
    }

    #[test]
    fn a_slot_near_the_top_does_not_wrap_into_the_past() {
        let mut r = request();
        r.escrow(1, 0, u64::MAX - 1).unwrap();
        assert_eq!(r.ready_slot(), u64::MAX);
        assert!(!r.is_ready(u64::MAX - 1));
    }

    #[test]
    fn releasing_part_returns_its_share_of_the_points_stake() {
        let mut r = request();
        r.escrow(100, 1_000, 5).unwrap();
        assert_eq!(r.release(40).unwrap(), 400);
        assert_eq!((r.shares, r.points_usd), (60, 600));
        assert!(r.release(61).is_err());
        assert!(r.release(0).is_err());
        assert_eq!(r.release(60).unwrap(), 600);
        assert_eq!((r.shares, r.points_usd), (0, 0));
    }

    #[test]
    fn nothing_is_escrowed_for_zero() {
        assert!(request().escrow(0, 0, 1).is_err());
    }
}
