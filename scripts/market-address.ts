/*
 * Where a market lives.
 *
 * A market's address carries its generation: `["market", pool, feed id,
 * generation as four little-endian bytes]`. Each (pool, feed) pair has a
 * `MarketGenerations` account at `["market_generation", pool, feed id]`
 * holding `latest`, the newest generation listed, and listing takes
 * `latest + 1`. So nobody holds a feed for good by listing it first.
 *
 * Generation 0 is the address markets had before generations existed,
 * `["market", pool, feed id]`. Nothing lists at 0 any more; it only finds
 * markets listed before the change.
 */
import { PublicKey } from "@solana/web3.js";

export const marketGenerationsPda = (programId: PublicKey, pool: PublicKey,
                                     feedId: Buffer | Uint8Array) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("market_generation"), pool.toBuffer(), Buffer.from(feedId)], programId)[0];

export function marketPda(programId: PublicKey, pool: PublicKey,
                          feedId: Buffer | Uint8Array, generation: number) {
  const seeds = [Buffer.from("market"), pool.toBuffer(), Buffer.from(feedId)];
  if (generation !== 0) {
    const g = Buffer.alloc(4);
    g.writeUInt32LE(generation);
    seeds.push(g);
  }
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export const observationPda = (programId: PublicKey, market: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("observation"), market.toBuffer()], programId)[0];

/// The newest generation of `feedId` listed in `pool`, 0 when it has never
/// been listed since generations existed.
export async function latestGeneration(program: any, pool: PublicKey,
                                       feedId: Buffer | Uint8Array): Promise<number> {
  const g = await program.account.marketGenerations.fetchNullable(
    marketGenerationsPda(program.programId, pool, feedId));
  return g ? Number(g.latest) : 0;
}

/// The generation a new listing of `feedId` must name, and its address.
export async function nextMarket(program: any, pool: PublicKey, feedId: Buffer | Uint8Array) {
  const generation = (await latestGeneration(program, pool, feedId)) + 1;
  return { generation, market: marketPda(program.programId, pool, feedId, generation) };
}

/// Which of several generations of one feed to show: the newest that has
/// backing, else the newest. A market nobody has backed cannot open a
/// position, so a fresh, empty relisting does not hide a live one until
/// someone backs it; a squatted listing is replaced by any later one that is.
export function pickGeneration<T extends { generation: number; backed: boolean }>(rows: T[]): T | undefined {
  const newestFirst = [...rows].sort((a, b) => b.generation - a.generation);
  return newestFirst.find((r) => r.backed) ?? newestFirst[0];
}
