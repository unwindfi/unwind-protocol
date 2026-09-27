/*
 * The tokens backing may be held in besides USDC, and how to set them up.
 *
 * One custody per token, the way Jupiter's JLP pool holds each asset: its own
 * vault, priced by oracle, nothing swapped on the way in. Read by the
 * bootstrap that creates them, the server that builds transactions against
 * them, and `add-custodies.ts` for a pool that predates them.
 */
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createMint } from "@solana/spl-token";

/// Pyth `Crypto.SOL/USD`.
export const SOL_USD_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export interface CustodyDef {
  symbol: "SOL" | "USDT";
  isStable: boolean;
  /// Hex Pyth feed id; empty for a stable.
  feedId: string;
  maxPriceAgeSec: number;
  maxConfBps: number;
  /// Share of the token's value that counts toward a market's loss budget.
  /// SOL counts at 80%: a backer's share is priced at what the SOL is worth,
  /// but the budget it buys has to survive the SOL falling while it stands
  /// behind a market. JLP has no such haircut because its pool is not
  /// first-loss money; this is.
  budgetWeightBps: number;
}

/// In index order: the order they are created in is the order every
/// instruction expects them.
export const CUSTODIES: CustodyDef[] = [
  { symbol: "SOL", isStable: false, feedId: SOL_USD_FEED,
    maxPriceAgeSec: 90, maxConfBps: 200, budgetWeightBps: 8_000 },
  { symbol: "USDT", isStable: true, feedId: "",
    maxPriceAgeSec: 0, maxConfBps: 0, budgetWeightBps: 10_000 },
];

export const custodyPda = (programId: PublicKey, pool: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("custody"), pool.toBuffer(), mint.toBuffer()], programId)[0];

export const custodyVaultPda = (programId: PublicKey, custody: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("custody_vault"), custody.toBuffer()], programId)[0];

export const backingBookPda = (programId: PublicKey, market: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("backing_book"), market.toBuffer()], programId)[0];

/// Creates whichever custodies the pool is missing. SOL is the native mint;
/// USDT is `usdtMint` if given, or a stand-in minted here, since a local or
/// test chain has no real USDT. Returns the USDT mint either way.
export async function ensureCustodies(
  program: any,
  conn: Connection,
  authority: Keypair,
  pool: PublicKey,
  usdtMint?: PublicKey | null,
): Promise<PublicKey> {
  const usdt = usdtMint && (await conn.getAccountInfo(usdtMint))
    ? usdtMint
    : await createMint(conn, authority, authority.publicKey, null, 6);

  const p: any = await program.account.pool.fetch(pool);
  for (const [i, def] of CUSTODIES.entries()) {
    const mint = def.symbol === "SOL" ? NATIVE_MINT : usdt;
    const custody = custodyPda(program.programId, pool, mint);
    if (await conn.getAccountInfo(custody)) continue;
    // Indices are positional; a pool that somehow has a later custody but
    // not an earlier one cannot be fixed by adding the earlier one now.
    if (p.numCustodies > i) throw new Error(`custody ${i} exists under another mint`);
    await program.methods
      .addCustody({
        isStable: def.isStable,
        feedId: Array.from(def.feedId ? Buffer.from(def.feedId, "hex") : Buffer.alloc(32)),
        maxPriceAgeSec: def.maxPriceAgeSec,
        maxConfBps: def.maxConfBps,
        budgetWeightBps: def.budgetWeightBps,
      })
      .accounts({
        authority: authority.publicKey, pool, mint, custody,
        vault: custodyVaultPda(program.programId, custody),
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
    p.numCustodies = i + 1;
    console.log(`  custody ${def.symbol.padEnd(5)} ${custody.toBase58()}`);
  }
  return usdt;
}

/// `amount` whole tokens in base units.
export const baseUnits = (amount: number, decimals: number) =>
  new BN(Math.floor(amount * 10 ** decimals).toString());
