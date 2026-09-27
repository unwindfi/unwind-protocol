//! Kani proofs of the program's pure arithmetic.
//!
//! Tests check the cases somebody thought of; these check every case inside
//! their bounds. Each harness makes its inputs symbolic (`kani::any`), states
//! what the inputs may be (`kani::assume`), and asserts a property the program
//! relies on. `cargo kani` explores every input that satisfies the
//! assumptions, and a harness that passes is a proof for all of them.
//!
//! Bounds are small on purpose. The properties are about the shape of the
//! arithmetic, not the magnitude of the numbers, and a model checker's cost
//! grows with both. Each file says what its bounds are.
//!
//!   cargo kani --harness <name>      # one proof
//!   cargo kani                       # all of them
//!
//! One file per part of the program.

mod auction;
mod budget;
mod clearing;
mod feeds;
mod liquidity;
mod listing;
mod money;
mod orders;
mod settlement;
