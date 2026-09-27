import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

/*
 * Driving the batch auction from off-chain.
 *
 * Nothing here decides anything. `clear_batch` takes no price and `settle_order`
 * takes no discretion, so this is a liveness service rather than an operator:
 * if it stops, batches stop clearing and every order's collateral stays
 * escrowed exactly where its owner put it. Anyone can run a second copy and
 * the only cost of two of them racing is a wasted transaction.
 */

export const BATCH_INTERVAL_SEC = 5;

export const batchPda = (programId: PublicKey, market: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("batch"), market.toBuffer()], programId)[0];

export const positionPda = (programId: PublicKey, market: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), owner.toBuffer()], programId)[0];

export interface MarketRefs {
  symbol: string;
  market: PublicKey;
  priceUpdate: PublicKey;
}

export interface PoolRefs {
  pool: PublicKey;
  usdcMint: PublicKey;
  usdcVault: PublicKey;
}

/// Places an order into the collecting batch. `price` is a limit — the worst
/// price the order will take — and it fills at the batch's clearing price,
/// which is never worse.
export async function submitOrder(
  program: Program<any>,
  refs: PoolRefs,
  m: MarketRefs,
  owner: PublicKey,
  o: { price: number; sizeUsd: number; collateralUsd: number; isBid: boolean;
       /// Closes existing size instead of opening new size. Escrows nothing.
       reduceOnly?: boolean;
       /// Rests as liquidity: trades only against takers on the other side.
       isMaker?: boolean },
  signers: any[] = []
) {
  const USD = (n: number) => new BN(Math.round(n * 1e6));
  return program.methods
    .submitOrder(USD(o.price), USD(o.sizeUsd), USD(o.collateralUsd), o.isBid,
                 !!o.reduceOnly, !!o.isMaker)
    .accounts({
      owner,
      pool: refs.pool,
      market: m.market,
      batch: batchPda(program.programId, m.market),
      usdcMint: refs.usdcMint,
      usdcVault: refs.usdcVault,
      ownerUsdc: getAssociatedTokenAddressSync(refs.usdcMint, owner),
      position: positionPda(program.programId, m.market, owner),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers(signers)
    .rpc();
}

/// Seals a batch if it is due, then settles every order it filled.
///
/// Settlement is a separate transaction per order on purpose: each one touches
/// only that trader's position, so a batch of sixty-four does not have to fit
/// in one transaction's account list, and one failing settlement cannot hold
/// up the other sixty-three.
export async function clearAndSettle(
  program: Program<any>,
  refs: PoolRefs,
  m: MarketRefs,
  payer: PublicKey,
  signers: any[] = []
): Promise<{ cleared: boolean; buyPrice: number; sellPrice: number; settled: number }> {
  const batch = batchPda(program.programId, m.market);
  const state: any = await program.account.batch.fetch(batch);

  const now = Math.floor(Date.now() / 1000);
  const open = Number(state.clearedTs) === 0;
  if (open) {
    if (now < state.openedTs.toNumber() + BATCH_INTERVAL_SEC) {
      return { cleared: false, buyPrice: 0, sellPrice: 0, settled: 0 };
    }
    await program.methods
      .clearBatch()
      .accounts({
        pool: refs.pool,
        market: m.market,
        batch,
        priceUpdate: m.priceUpdate,
      })
      .signers(signers)
      .rpc();
  }

  // Re-read: clearing may have found no crossing at all, in which case the
  // batch already rolled and there is nothing to settle.
  const sealed: any = await program.account.batch.fetch(batch);
  // One price per flow; zero for a flow that did not trade.
  const buyPrice = Number(sealed.buyPrice) / 1e6;
  const sellPrice = Number(sealed.sellPrice) / 1e6;
  if (Number(sealed.clearedTs) === 0) return { cleared: true, buyPrice: 0, sellPrice: 0, settled: 0 };

  let settled = 0;
  for (let i = 0; i < sealed.orders.length; i++) {
    const order = sealed.orders[i];
    if (!order.active) continue;
    const owner = new PublicKey(order.owner);
    try {
      await program.methods
        .settleOrder(i)
        .accounts({
          pool: refs.pool,
          market: m.market,
          batch,
          owner,
          position: positionPda(program.programId, m.market, owner),
          usdcMint: refs.usdcMint,
          usdcVault: refs.usdcVault,
          ownerUsdc: getAssociatedTokenAddressSync(refs.usdcMint, owner),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers(signers)
        .rpc();
      settled++;
    } catch (e: any) {
      // One order that cannot settle must not strand the rest of the batch.
      console.warn(`settle ${m.symbol}#${i}: ${e?.message ?? e}`);
    }
  }
  return { cleared: true, buyPrice, sellPrice, settled };
}

/// Runs the crank for every market, forever. Returns a stop function.
export function runAuction(
  program: Program<any>,
  refs: PoolRefs,
  markets: MarketRefs[],
  payer: PublicKey,
  signers: any[] = []
) {
  let alive = true;
  (async () => {
    while (alive) {
      for (const m of markets) {
        if (!alive) break;
        try {
          const r = await clearAndSettle(program, refs, m, payer, signers);
          if (r.cleared && (r.buyPrice > 0 || r.sellPrice > 0)) {
            console.log(`  ${m.symbol} cleared buy @ ${r.buyPrice.toFixed(4)}` +
                        ` sell @ ${r.sellPrice.toFixed(4)} (${r.settled} settled)`);
          }
        } catch (e: any) {
          console.warn(`clear ${m.symbol}: ${e?.message ?? e}`);
        }
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  })();
  return () => { alive = false; };
}
