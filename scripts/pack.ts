/// Packs instructions into as few transactions as the size limit allows.
///
/// Settling a batch is one `settle_order` per filled order, and sending each
/// on its own cost a full batch of 64 orders 64 transactions and 64 round
/// trips to an RPC that throttles. The accounts every settlement shares (pool,
/// market, batch, mint, vault, token program) are written once per
/// transaction, so each order after the first costs only its owner, position
/// and token account: about 120 bytes against the 1232-byte limit.
///
/// Packing is measured, not assumed. Each transaction is grown one instruction
/// at a time and serialised, so a change in account count moves the packing
/// with it instead of silently overflowing a hardcoded number.
import {
  ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction,
} from "@solana/web3.js";

/// Solana's cap on a serialised transaction.
const MAX_TX_BYTES = 1232;
/// The per-transaction ceiling, which is what a packed transaction asks for:
/// the size limit, not compute, is meant to be what binds.
export const MAX_COMPUTE_UNITS = 1_400_000;

/// Splits `ixs` into groups that each fit one legacy transaction alongside a
/// compute-unit limit. Order is kept, so a caller can map results back.
export function packInstructions(
  ixs: TransactionInstruction[],
  feePayer: PublicKey,
  maxPerTx = Infinity,
): TransactionInstruction[][] {
  // Any blockhash serialises to the same length; only the size is measured.
  const blockhash = PublicKey.default.toBase58();
  const fits = (group: TransactionInstruction[]) => {
    const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight: 0 })
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }), ...group);
    try {
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= MAX_TX_BYTES;
    } catch {
      // web3.js throws rather than returning an oversized buffer.
      return false;
    }
  };

  const groups: TransactionInstruction[][] = [];
  let group: TransactionInstruction[] = [];
  for (const ix of ixs) {
    const next = [...group, ix];
    if (group.length && (next.length > maxPerTx || !fits(next))) {
      groups.push(group);
      group = [ix];
    } else {
      group = next;
    }
  }
  if (group.length) groups.push(group);
  return groups;
}

/// The instructions to send for one packed group.
export const withComputeLimit = (group: TransactionInstruction[]) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
  ...group,
];
