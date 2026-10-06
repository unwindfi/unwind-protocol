use crate::constants::MARKET_SEED;
use crate::errors::PerpError;
use anchor_lang::prelude::*;

/// How many times one feed has been listed in one pool.
///
/// A market's address carries its generation, so listing a feed again is
/// always possible: a market listed first with a bad price source or bad
/// observation parameters holds its own address and nothing else. Whoever
/// lists next takes `latest + 1`, and the generation only ever goes up, so no
/// address is ever reused.
///
/// PDA: `[MARKET_GENERATION_SEED, pool, feed_id]`. Created by the first
/// listing of a feed and never closed.
#[account]
#[derive(InitSpace)]
pub struct MarketGenerations {
    pub bump: u8,
    pub pool: Pubkey,
    pub feed_id: [u8; 32],
    /// The newest generation listed. Zero before the first listing.
    pub latest: u32,
    pub _reserved: [u8; 16],
}

impl MarketGenerations {
    /// Takes the next generation, which the lister names up front because
    /// the market's address depends on it. Two listings of one feed racing
    /// each other: the second fails rather than landing somewhere its sender
    /// did not expect.
    pub fn take(&mut self, requested: u32) -> Result<u32> {
        let next = self.latest.checked_add(1).ok_or(PerpError::MathOverflow)?;
        require!(requested == next, PerpError::WrongGeneration);
        self.latest = next;
        Ok(next)
    }
}

/// The seeds of a market's address. Generation 0 is the address markets had
/// before generations existed, `[MARKET_SEED, pool, feed_id]`; a market
/// listed since carries its generation, from 1, as four little-endian bytes.
pub fn market_seeds<'a>(pool: &'a [u8], feed_id: &'a [u8], generation: &'a [u8; 4]) -> Vec<&'a [u8]> {
    if *generation == [0; 4] {
        vec![MARKET_SEED, pool, feed_id]
    } else {
        vec![MARKET_SEED, pool, feed_id, generation.as_slice()]
    }
}

/// The address of `generation` of `feed_id` in `pool`, searched. Off-chain
/// helpers and tests; on chain the stored bump is used instead.
pub fn market_address(pool: &Pubkey, feed_id: &[u8; 32], generation: u32) -> (Pubkey, u8) {
    let g = generation.to_le_bytes();
    Pubkey::find_program_address(&market_seeds(pool.as_ref(), feed_id, &g), &crate::ID)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> MarketGenerations {
        MarketGenerations { bump: 0, pool: Pubkey::default(), feed_id: [0; 32], latest: 0, _reserved: [0; 16] }
    }

    #[test]
    fn generations_start_at_one_and_only_go_up() {
        let mut g = fresh();
        assert_eq!(g.take(1).unwrap(), 1);
        assert_eq!(g.take(2).unwrap(), 2);
        assert_eq!(g.latest, 2);
    }

    #[test]
    fn a_stale_or_skipped_generation_is_refused() {
        let mut g = fresh();
        assert!(g.take(0).is_err(), "0 is the legacy address, never listed again");
        assert!(g.take(2).is_err());
        g.take(1).unwrap();
        assert!(g.take(1).is_err(), "an address is never reused");
        assert_eq!(g.latest, 1);
    }

    #[test]
    fn the_counter_cannot_wrap() {
        let mut g = fresh();
        g.latest = u32::MAX;
        assert!(g.take(0).is_err());
        assert_eq!(g.latest, u32::MAX);
    }

    #[test]
    fn every_generation_has_its_own_address() {
        let pool = Pubkey::new_unique();
        let feed = [7u8; 32];
        let legacy = Pubkey::find_program_address(&[MARKET_SEED, pool.as_ref(), &feed], &crate::ID).0;
        assert_eq!(market_address(&pool, &feed, 0).0, legacy, "generation 0 is the old address");
        let one = market_address(&pool, &feed, 1).0;
        let two = market_address(&pool, &feed, 2).0;
        assert_ne!(one, legacy);
        assert_ne!(one, two);
        let explicit = Pubkey::find_program_address(
            &[MARKET_SEED, pool.as_ref(), &feed, &1u32.to_le_bytes()], &crate::ID).0;
        assert_eq!(one, explicit);
        // Another feed's generation 1 is elsewhere again.
        assert_ne!(market_address(&pool, &[8u8; 32], 1).0, one);
    }

    #[test]
    fn a_market_knows_its_own_address_old_or_new() {
        let mut m = crate::instructions::trade::tests::market();
        m.pool = Pubkey::new_unique();
        m.feed_id = [3u8; 32];
        for generation in [0u32, 1, 7] {
            let (addr, bump) = market_address(&m.pool, &m.feed_id, generation);
            m.generation = generation;
            m.bump = bump;
            assert!(m.is_at(&addr), "generation {generation}");
            assert!(!m.is_at(&market_address(&m.pool, &m.feed_id, generation + 1).0));
        }
        // A market claiming another generation than its address is refused.
        let (addr, bump) = market_address(&m.pool, &m.feed_id, 2);
        m.generation = 3;
        m.bump = bump;
        assert!(!m.is_at(&addr));
    }
}
