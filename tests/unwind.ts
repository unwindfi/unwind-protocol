import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  transfer,
} from "@solana/spl-token";
import { assert } from "chai";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Unwind } from "../target/types/unwind";
import { marketGenerationsPda, marketPda } from "../scripts/market-address";

const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

const USD = (n: number) => new BN(Math.round(n * 1e6));
const PRICE = (n: number) => new BN(Math.round(n * 1e6));
const EXP = -8;

/// Prices are posted through `mock-pyth`, one account for the feed, rather
/// than swapped between fixture accounts. A market refuses a second, different
/// price under a publish time it has already acted on, and fixtures generated
/// in one run all share one, so every move here is a fresh post at a later
/// second.
const FEED_ID = createHash("sha256").update("test-feed:AAPLx").digest().subarray(0, 32);

/// A price to post: dollars, with a 1 bp confidence interval and full
/// verification unless a test asks for the kind the program must refuse.
type Quote = number | { price: number; confBps?: number; full?: boolean };
const quoteOf = (q: Quote) => (typeof q === "number" ? { price: q } : q);

/// Who signs price posts. `npm run build` passes `--features devnet` to every
/// program, because the perps program needs it to trust a stand-in receiver;
/// mock-pyth's `devnet` build then accepts posts from its relay key alone
/// (NotRelayAuthority otherwise). Sign with that key when it is on this
/// machine, and with the wallet when it is not, which a plain build accepts.
function pricePoster(fallback: Keypair): Keypair {
  const file = process.env.RELAY_KEYPAIR ?? path.join(os.homedir(), ".config/unwind/relay.json");
  if (!fs.existsSync(file)) return fallback;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

describe("unwind", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Unwind as Program<Unwind>;
  const pyth = anchor.workspace.MockPyth as Program<any>;
  const authority = provider.wallet as anchor.Wallet;
  const poster = pricePoster(authority.payer);
  const oracle = PublicKey.findProgramAddressSync(
    [Buffer.from("price"), FEED_ID], pyth.programId)[0];

  /// What was last posted, and under which second, so an unchanged quote is
  /// not posted again and a changed one never reuses a second.
  let lastQuote = "";
  let lastTs = 0;

  const post = async (q: Quote) => {
    const { price, confBps, full = true } = quoteOf(q);
    const key = JSON.stringify([price, confBps, full]);
    if (key === lastQuote) return;
    let ts = Math.floor(Date.now() / 1000);
    if (ts <= lastTs) {
      await new Promise((r) => setTimeout(r, (lastTs + 1) * 1000 - Date.now() + 50));
      ts = lastTs + 1;
    }
    const raw = Math.round(price * 10 ** -EXP);
    await pyth.methods
      .postPrice({
        feedId: Array.from(FEED_ID),
        price: new BN(raw),
        conf: new BN(Math.round(raw * (confBps ?? 1) / 10_000)),
        exponent: EXP,
        publishTime: new BN(ts),
        fullyVerified: full,
      })
      .accounts({ payer: poster.publicKey, priceUpdate: oracle, systemProgram: SystemProgram.programId })
      .signers([poster])
      .rpc();
    lastQuote = key;
    lastTs = ts;
  };

  /// Cranks the risk price until it reaches the posted one. Liquidation reads
  /// a risk price that walks toward the oracle by at most 40 bps a slot, so a
  /// test that moves the market and then liquidates has to let it walk.
  const catchUp = async () => {
    for (let i = 0; i < 60; i++) {
      await program.methods.stepRiskPrice()
        .accounts({ pool, market, priceUpdate: oracle } as any)
        .rpc();
      const m: any = await program.account.market.fetch(market);
      if (m.riskPrice.eq(m.lastPrice)) return;
      // Three slots: the most one step counts.
      await new Promise((r) => setTimeout(r, 1_300));
    }
    throw new Error("the risk price did not reach the oracle");
  };

  let usdcMint: PublicKey;
  let pool: PublicKey;
  let usdcVault: PublicKey;
  let lpMint: PublicKey;
  let market: PublicKey;

  // The LP and the trader are separate actors so the accounting between them
  // can be asserted rather than assumed.
  const lp = Keypair.generate();
  const trader = Keypair.generate();
  const liquidator = Keypair.generate();

  let lpUsdc: PublicKey;
  let lpLp: PublicKey;
  let traderUsdc: PublicKey;
  let liquidatorUsdc: PublicKey;

  const marketParams = (overrides: any = {}) => ({
    symbol: Array.from(Buffer.concat([Buffer.from("AAPLx"), Buffer.alloc(11)])),
    feedId: Array.from(FEED_ID),
    maxPriceAgeSec: 3600,
    maxConfBps: 200,
    maxLeverageBps: 100_000, // 10x
    maintenanceMarginBps: 500, // 5%
    liquidationFeeBps: 100,
    openFeeBps: 10,
    closeFeeBps: 10,
    minPositionUsd: USD(10),
    maxOiLongUsd: USD(1_000_000),
    maxOiShortUsd: USD(1_000_000),
    pnlReserveBps: 10_000,
    baseSpreadBps: 5,
    confSpreadMultBps: 10_000,
    maxSpreadBps: 500,
    closedSessionLeverageBps: 20_000,
    closedSessionOiMultBps: 2_500,
    maxFundingRateBpsPerHour: 100,
    fundingKBps: 10_000,
    borrowRateBpsPerHour: 1,
    priceSource: 0,
    observation: PublicKey.default,
    ...overrides,
  });

  const positionPda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("position"), market.toBuffer(), owner.toBuffer()],
      program.programId
    )[0];

  /// Every liquidity instruction must be handed the full market list.
  /// What the liquidity instructions price: the market, but only while
  /// somebody holds a position in it (`Pool::markets_with_oi`).
  const allMarkets = async (priceAccount: PublicKey) => {
    const m = await program.account.market.fetch(market);
    if (m.longSizeUsd.isZero() && m.shortSizeUsd.isZero()) return [];
    return [
      { pubkey: market, isWritable: false, isSigner: false },
      { pubkey: priceAccount, isWritable: false, isSigner: false },
    ];
  };

  /// Deposits and withdrawals price LP shares from the pool's AUM
  /// checkpoint, so one is taken, over every market with open interest,
  /// before each.
  const checkpoint = async (price: Quote = 200) => {
    await post(price);
    return program.methods.checkpointAum(true)
      .accounts({ payer: lp.publicKey, pool })
      .remainingAccounts(await allMarkets(oracle))
      .signers([lp])
      .rpc();
  };

  before(async () => {
    for (const kp of [lp, trader, liquidator, poster]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2e9);
      await provider.connection.confirmTransaction(sig);
    }

    usdcMint = await createMint(
      provider.connection,
      authority.payer,
      authority.publicKey,
      null,
      6
    );

    [pool] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), usdcMint.toBuffer()],
      program.programId
    );
    [usdcVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_vault"), pool.toBuffer()],
      program.programId
    );
    [lpMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp_mint"), pool.toBuffer()],
      program.programId
    );
    // The feed's first listing, generation 1 (scripts/market-address.ts).
    market = marketPda(program.programId, pool, FEED_ID, 1);

    await post(200);

    await program.methods
      .initializePool({
        pythReceiver: pyth.programId,
        // Write-once, like the receiver. The authority stands in for it here.
        chainFeeDestination: authority.publicKey,
        addLiquidityFeeBps: 0,
        removeLiquidityFeeBps: 0,
        protocolFeeShareBps: 2000,
        insuranceFeeShareBps: 1000,
        maxUtilizationBps: 8000,
      })
      .accounts({
        authority: authority.publicKey,
        pool,
        usdcMint,
        usdcVault,
        lpMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        programData: PublicKey.findProgramAddressSync([program.programId.toBuffer()], BPF_LOADER_UPGRADEABLE)[0],
      })
      .rpc();

    await program.methods
      .addMarket(marketParams(), 1)
      .accounts({
        payer: authority.publicKey,
        pool,
        generations: marketGenerationsPda(program.programId, pool, FEED_ID),
        market,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Listing leaves a market unfunded and without a batch; both are separate
    // acts on purpose, so the setup performs them the way an operator would.
    await program.methods
      .createBatch()
      .accounts({
        payer: authority.publicKey, pool, market,
        batch: batchPda(),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    // The budget comes from backing, which the authority posts here like any
    // backer would.
    const authorityUsdc = await getOrCreateAssociatedTokenAccount(
      provider.connection, authority.payer, usdcMint, authority.publicKey);
    await mintTo(provider.connection, authority.payer, usdcMint, authorityUsdc.address,
      authority.publicKey, 10_000_000e6);
    await program.methods
      .backMarket(new BN(10_000_000_000_000))
      .accounts({
        owner: authority.publicKey, pool, market,
        backing: PublicKey.findProgramAddressSync(
          [Buffer.from("backing"), market.toBuffer(), authority.publicKey.toBuffer()],
          program.programId)[0],
        book: PublicKey.findProgramAddressSync(
          [Buffer.from("backing_book"), market.toBuffer()], program.programId)[0],
        depositMint: usdcMint, depositVault: usdcVault, ownerToken: authorityUsdc.address,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc();

    lpUsdc = await createAssociatedTokenAccount(
      provider.connection, lp, usdcMint, lp.publicKey);
    lpLp = await createAssociatedTokenAccount(
      provider.connection, lp, lpMint, lp.publicKey);
    traderUsdc = await createAssociatedTokenAccount(
      provider.connection, trader, usdcMint, trader.publicKey);
    liquidatorUsdc = await createAssociatedTokenAccount(
      provider.connection, liquidator, usdcMint, liquidator.publicKey);

    await mintTo(provider.connection, authority.payer, usdcMint, lpUsdc,
      authority.publicKey, 1_000_000e6);
    await mintTo(provider.connection, authority.payer, usdcMint, traderUsdc,
      authority.publicKey, 100_000e6);
  });

  const addLiquidity = async (amount: BN, price: Quote = 200) => {
    await checkpoint(price);
    return program.methods
      .addLiquidity(amount, new BN(0))
      .accounts({
        owner: lp.publicKey,
        pool, usdcMint, usdcVault, lpMint,
        ownerUsdc: lpUsdc, ownerLp: lpLp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([])
      .signers([lp])
      .rpc();
  };

  const batchPda = () =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), market.toBuffer()], program.programId)[0];

  /*
   * Opening a position is three steps now, and the wait in the middle is not
   * incidental: the batch will not clear before its window is up, which is the
   * property the whole design rests on. A test that could skip it would be
   * testing a venue nobody can trade on.
   *
   * With one order and no counterparty the batch falls through to the pool,
   * which fills it at its own quote — so these tests still open at the
   * oracle-derived price they always did, by a longer route.
   */
  const BATCH_WAIT_MS = 2_000;

  const open = async (
    isLong: boolean, collateral: BN, size: BN, price: Quote = 200, who = trader,
    whoUsdc = () => traderUsdc
  ) => {
    // A limit well through the index, so the order crosses whatever the batch
    // finds. The limit is the slippage control now; there is no separate one.
    const px = quoteOf(price).price * 1e6;
    const limit = new BN(Math.round(px * (isLong ? 1.1 : 0.9)));

    await program.methods
      .submitOrder(limit, size, collateral, isLong, false, false)
      .accounts({
        owner: who.publicKey,
        pool, market, batch: batchPda(),
        usdcMint, usdcVault,
        ownerUsdc: whoUsdc(),
        position: positionPda(who.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([who])
      .rpc();

    await runBatch(price, who, whoUsdc);
  };

  /// Seals the batch and settles it. Shared by opening and closing, because
  /// the program stopped distinguishing the two at this point.
  const runBatch = async (
    price: Quote = 200, who = trader, whoUsdc = () => traderUsdc
  ) => {
    await new Promise((r) => setTimeout(r, BATCH_WAIT_MS));
    await post(price);
    await program.methods
      .clearBatch()
      .accounts({ pool, market, batch: batchPda(), priceUpdate: oracle })
      .rpc();

    const sealed: any = await program.account.batch.fetch(batchPda());
    for (let i = 0; i < sealed.orders.length; i++) {
      if (!sealed.orders[i].active) continue;
      const owner = new PublicKey(sealed.orders[i].owner);
      await program.methods
        .settleOrder(i)
        .accounts({
          pool, market, batch: batchPda(), owner,
          position: positionPda(owner),
          usdcMint, usdcVault,
          ownerUsdc: owner.equals(who.publicKey) ? whoUsdc() : getAssociatedTokenAddressSync(usdcMint, owner),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    }
  };

  /// Takes back an order a refused clear left resting in the batch. Left there,
  /// the next clear would book it alongside whatever the next test opens.
  const cancelResting = async (who = trader, whoUsdc = () => traderUsdc) => {
    const b: any = await program.account.batch.fetch(batchPda());
    for (let i = 0; i < b.orders.length; i++) {
      const o = b.orders[i];
      if (!o.active || !new PublicKey(o.owner).equals(who.publicKey)) continue;
      await program.methods
        .cancelBatchOrder(i)
        .accounts({
          owner: who.publicKey, pool, market, batch: batchPda(),
          usdcMint, usdcVault, ownerUsdc: whoUsdc(),
          position: positionPda(who.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([who])
        .rpc();
    }
  };

  /// Closing is a reduce-only order through the same batch as everything else.
  /// `size` of zero means whatever is left unpromised.
  const close = async (
    size: BN, price: Quote = 200, who = trader, whoUsdc = () => traderUsdc
  ) => {
    const pos: any = await program.account.position.fetch(positionPda(who.publicKey));
    const want = size.isZero() ? pos.sizeUsd.sub(pos.closingUsd) : size;
    const isBid = !pos.isLong;
    const px = quoteOf(price).price * 1e6;
    const limit = new BN(Math.round(px * (isBid ? 1.1 : 0.9)));

    await program.methods
      .submitOrder(limit, want, new BN(0), isBid, true, false)
      .accounts({
        owner: who.publicKey,
        pool, market, batch: batchPda(),
        usdcMint, usdcVault,
        ownerUsdc: whoUsdc(),
        position: positionPda(who.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([who])
      .rpc();

    await runBatch(price, who, whoUsdc);
  };

  it("seeds the pool one LP token per dollar on the first deposit", async () => {
    await addLiquidity(USD(500_000));
    const lpBal = await getAccount(provider.connection, lpLp);
    assert.equal(lpBal.amount.toString(), USD(500_000).toString());

    const p = await program.account.pool.fetch(pool);
    assert.equal(p.liquidityUsd.toString(), USD(500_000).toString());
    assert.equal(p.lockedUsd.toString(), "0");
  });

  it("pays a winning long out of pool liquidity", async () => {
    const before = await getAccount(provider.connection, traderUsdc);
    // ~8.4x. The open fee comes out of collateral, so a request for exactly the
    // 10x cap would land just over it and be rejected.
    await open(true, USD(1_200), USD(10_000));

    const pos = await program.account.position.fetch(positionPda(trader.publicKey));
    assert.isTrue(pos.isLong);
    assert.equal(pos.sizeUsd.toString(), USD(10_000).toString());
    // Entry is the index plus the spread, so strictly worse than $200.
    assert.isTrue(pos.entryPrice.gt(PRICE(200)));

    // Nothing is held against an open: profit is held to what the market
    // can pay by the haircut at close.
    const poolMid = await program.account.pool.fetch(pool);
    assert.equal(poolMid.lockedUsd.toString(), "0");

    await close(new BN(0), 220); // +10% on the index
    const after = await getAccount(provider.connection, traderUsdc);

    const pnl = Number(after.amount - before.amount) / 1e6;
    // $10k of notional through a 10% move is ~$1,000, less spread both ways and
    // the open and close fees.
    assert.isAbove(pnl, 900, `expected a large win, got ${pnl}`);
    assert.isBelow(pnl, 1000, `win should be net of costs, got ${pnl}`);

    const p = await program.account.pool.fetch(pool);
    assert.equal(p.lockedUsd.toString(), "0", "nothing was held");
    assert.isBelow(
      p.liquidityUsd.toNumber(), USD(500_000).toNumber(),
      "the pool is the counterparty and must be down"
    );
  });

  it("keeps a losing trader's collateral in the pool", async () => {
    const poolBefore = await program.account.pool.fetch(pool);
    await open(true, USD(1_200), USD(10_000), 200);
    await close(new BN(0), 180); // -10% on $10k of notional wipes out $1.2k
    const poolAfter = await program.account.pool.fetch(pool);

    assert.isAbove(
      poolAfter.liquidityUsd.toNumber(),
      poolBefore.liquidityUsd.toNumber(),
      "the pool should have taken the trader's collateral"
    );
    const pos = await program.account.position.fetch(positionPda(trader.publicKey));
    assert.equal(pos.sizeUsd.toString(), "0");
  });

  it("refuses to quote when the oracle confidence is too wide", async () => {
    try {
      // A 5% confidence interval, against a 2% cap.
      await open(true, USD(1_000), USD(5_000), { price: 200, confBps: 500 });
      assert.fail("expected the market to halt on a wide confidence interval");
    } catch (e) {
      assert.include(e.toString(), "OracleConfidenceTooWide");
    }
    await cancelResting();
  });

  it("rejects a partially verified price update", async () => {
    try {
      await open(true, USD(1_000), USD(5_000), { price: 200, full: false });
      assert.fail("expected partial verification to be rejected");
    } catch (e) {
      assert.include(e.toString(), "InsufficientOracleVerification");
    }
    await cancelResting();
  });

  it("rejects leverage above the market maximum", async () => {
    try {
      await open(true, USD(100), USD(10_000)); // 100x
      assert.fail("expected the leverage cap to bind");
    } catch (e) {
      assert.include(e.toString(), "LeverageTooHigh");
    }
    await cancelResting();
  });

  it("tightens leverage while the underlying market is closed", async () => {
    await program.methods
      .setSession(2) // Closed
      .accounts({ authority: authority.publicKey, pool, market })
      .rpc();

    try {
      await open(true, USD(1_000), USD(5_000)); // 5x, fine while open
      assert.fail("expected the closed-session cap of 2x to bind");
    } catch (e) {
      assert.include(e.toString(), "LeverageTooHigh");
    }
    await cancelResting();

    await program.methods
      .setSession(0)
      .accounts({ authority: authority.publicKey, pool, market })
      .rpc();
  });

  it("lets anyone liquidate a position through its maintenance margin", async () => {
    await open(true, USD(1_000), USD(8_000), 200); // 8x

    // Healthy at $200: liquidation must not be possible yet.
    try {
      await program.methods
        .liquidate()
        .accounts({
          liquidator: liquidator.publicKey,
          pool, market,
          position: positionPda(trader.publicKey),
          owner: trader.publicKey,
          priceUpdate: oracle,
          usdcMint, usdcVault,
          ownerUsdc: traderUsdc,
          liquidatorUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([liquidator])
        .rpc();
      assert.fail("a healthy position must not be liquidatable");
    } catch (e) {
      assert.include(e.toString(), "PositionHealthy", `got: ${e}`);
    }

    // At $180, 10% down at 8x, the position is through its margin. The risk
    // price liquidation reads follows a move at 40 bps a slot, so the move is
    // stepped in before anyone can act on it.
    await post(180);
    await catchUp();
    await program.methods
      .liquidate()
      .accounts({
        liquidator: liquidator.publicKey,
        pool, market,
        position: positionPda(trader.publicKey),
        owner: trader.publicKey,
        priceUpdate: oracle,
        usdcMint, usdcVault,
        ownerUsdc: traderUsdc,
        liquidatorUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([liquidator])
      .rpc();

    const pos = await program.account.position.fetch(positionPda(trader.publicKey));
    assert.equal(pos.sizeUsd.toString(), "0");
    const p = await program.account.pool.fetch(pool);
    assert.equal(p.lockedUsd.toString(), "0");
  });

  it("prices LP shares against unrealized trader PnL", async () => {
    await open(true, USD(2_000), USD(10_000), 200);

    // Two identical deposits, differing only in where the index sits. The
    // second is made while traders are ~$1,000 up, which is a loss the pool has
    // taken but not yet paid out, so each LP token must be worth less and the
    // same dollars must buy more of them. Comparing the two deposits rather
    // than either one in isolation keeps the assertion independent of fees and
    // PnL accumulated by earlier tests.
    const before1 = (await getAccount(provider.connection, lpLp)).amount;
    await addLiquidity(USD(10_000), 200);
    const minted1 = (await getAccount(provider.connection, lpLp)).amount - before1;

    // A deposit counts the market at whichever of the oracle and the risk
    // price owes traders less, so the move has to be stepped in first.
    await post(220);
    await catchUp();
    const before2 = (await getAccount(provider.connection, lpLp)).amount;
    await addLiquidity(USD(10_000), 220);
    const minted2 = (await getAccount(provider.connection, lpLp)).amount - before2;

    assert.isAbove(
      Number(minted2), Number(minted1),
      "unrealized trader profit must lower the LP share price"
    );

    await close(new BN(0), 220);
  });

  it("leaves a market nobody trades out of the LP share price", async () => {
    // No open interest: the market owes nothing whatever its price, so the
    // checkpoint counts no markets and the deposit prices without it.
    await checkpoint();
    await program.methods
      .addLiquidity(USD(1_000), new BN(0))
      .accounts({
        owner: lp.publicKey,
        pool, usdcMint, usdcVault, lpMint,
        ownerUsdc: lpUsdc, ownerLp: lpLp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([])
      .signers([lp])
      .rpc();
    const p = await program.account.pool.fetch(pool);
    assert.equal(p.marketsWithOi, 0);
  });

  it("refuses to price LP shares from a checkpoint taken before the open interest moved", async () => {
    // A checkpoint with no markets, then a position opens: the pool's set of
    // markets with open interest has changed, so a deposit priced from the
    // old checkpoint would ignore what that market owes.
    await checkpoint();
    await open(true, USD(1_000), USD(5_000));
    assert.equal((await program.account.pool.fetch(pool)).marketsWithOi, 1);
    try {
      await program.methods
        .addLiquidity(USD(1_000), new BN(0))
        .accounts({
          owner: lp.publicKey,
          pool, usdcMint, usdcVault, lpMint,
          ownerUsdc: lpUsdc, ownerLp: lpLp,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([])
        .signers([lp])
        .rpc();
      assert.fail("expected the stale checkpoint to be refused");
    } catch (e) {
      assert.include(e.toString(), "AumCheckpointStale");
    }
    // A pass over the traded market makes it priceable again.
    await addLiquidity(USD(1_000));
    await close(new BN(0), 200);
    assert.equal((await program.account.pool.fetch(pool)).marketsWithOi, 0);
  });

  it("carries a position through a stock split unchanged", async () => {
    await open(true, USD(2_000), USD(10_000), 200);
    const before = await program.account.position.fetch(positionPda(trader.publicKey));

    await program.methods
      .setMarketPaused(true)
      .accounts({ authority: authority.publicKey, pool, market })
      .rpc();
    // 2-for-1: the price halves, so the price factor is multiplied by 1/2.
    await program.methods
      .applyCorporateAction(new BN(1), new BN(2), new BN(1e9))
      // The batch PDA resolves from the market; a Pyth market has no observation.
      .accounts({ authority: authority.publicKey, pool, market, observation: null })
      .rpc();
    await program.methods
      .setMarketPaused(false)
      .accounts({ authority: authority.publicKey, pool, market })
      .rpc();

    const m = await program.account.market.fetch(market);
    assert.equal(m.splitEpoch, 1);

    // The position's stored entry is untouched; it rebases through the factor.
    const after = await program.account.position.fetch(positionPda(trader.publicKey));
    assert.equal(after.entryPrice.toString(), before.entryPrice.toString());

    // Closing at the post-split index of $100 -- economically flat -- should
    // return the collateral less fees, not a 50% loss.
    const collateral = Number(after.collateralUsd) / 1e6;
    const balBefore = (await getAccount(provider.connection, traderUsdc)).amount;
    await close(new BN(0), 100);
    const returned = Number(
      (await getAccount(provider.connection, traderUsdc)).amount - balBefore
    ) / 1e6;

    assert.isAbove(
      returned, collateral * 0.97,
      `the split wiped out value: got ${returned} of ${collateral}`
    );
    assert.isBelow(
      returned, collateral,
      `should be net of fees: got ${returned} of ${collateral}`
    );
  });

  it("lets LPs withdraw with positions open, after the cooldown, at the value then", async () => {
    await open(true, USD(50_000), USD(400_000), 200);

    // Half the pool: far past what the old $400k reserve would have left free.
    const lpSupply = (await getAccount(provider.connection, lpLp)).amount;
    const half = new BN((lpSupply / 2n).toString());
    const [request] = PublicKey.findProgramAddressSync(
      [Buffer.from("withdraw_request"), pool.toBuffer(), lp.publicKey.toBuffer()], program.programId);
    const [escrowLp] = PublicKey.findProgramAddressSync(
      [Buffer.from("withdraw_escrow"), request.toBuffer()], program.programId);
    const [traderRecord] = PublicKey.findProgramAddressSync(
      [Buffer.from("trader"), lp.publicKey.toBuffer()], program.programId);
    const accounts = {
      owner: lp.publicKey,
      pool, usdcMint, usdcVault, lpMint,
      ownerUsdc: lpUsdc, ownerLp: lpLp,
      request, escrowLp, trader: traderRecord,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any;

    await program.methods.requestWithdraw(half).accounts(accounts).signers([lp]).rpc();
    // The shares left the wallet but not the supply.
    assert.equal((await getAccount(provider.connection, escrowLp)).amount.toString(), half.toString());
    // Anyone can send xLP into the escrow account. A unit sent in used to
    // keep it from closing, so the last claim and every cancel failed.
    await transfer(provider.connection, lp, lpLp, escrowLp, lp, 1);

    // Claims price from the AUM checkpoint as deposits do, so one is taken
    // right before each.
    const claim = async () => {
      await checkpoint();
      return program.methods
        .claimWithdraw(half, new BN(0))
        .accounts(accounts)
        .remainingAccounts([])
        .signers([lp])
        .rpc();
    };

    // Straight away it is refused: the cooldown has not run.
    try {
      await claim();
      assert.fail("claimed inside the cooldown");
    } catch (e: any) {
      assert.match(String(e), /WithdrawCooling/);
    }

    const r: any = await program.account.withdrawRequest.fetch(request);
    const ready = Number(r.requestSlot) + 150;
    while ((await provider.connection.getSlot("confirmed")) < ready) {
      await new Promise((ok) => setTimeout(ok, 400));
    }

    const before = (await getAccount(provider.connection, lpUsdc)).amount;
    await claim();
    const after = (await getAccount(provider.connection, lpUsdc)).amount;
    assert.isTrue(after > before, "the withdrawal paid out");
    assert.isNull(await program.account.withdrawRequest.fetchNullable(request), "the request closed");

    await close(new BN(0), 200);
  });
});
