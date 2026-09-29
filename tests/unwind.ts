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
} from "@solana/spl-token";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import { Unwind } from "../target/types/unwind";

const USD = (n: number) => new BN(Math.round(n * 1e6));
/// These fixtures are written as accounts of the real receiver's address, so
/// this pool is told to trust that program.
const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const PRICE = (n: number) => new BN(Math.round(n * 1e6));

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "manifest.json"), "utf8")
);
const FEED_ID = Buffer.from(manifest.feedId, "hex");
const oracle = (name: string) => new PublicKey(manifest.accounts[name]);

/// The fixtures are named for the price they hold, so the limit an order needs
/// can be read off the name rather than fetched back out of the account.
/// Fixtures named `at_N` hold $N. The others — `partial`, `wide_conf` — exist
/// to be rejected, and what an order's limit is on a market that will not
/// quote does not matter, so they take the default.
const priceOf = (name: string) => {
  const dollars = Number(name.replace(/^at_/, ""));
  return (Number.isFinite(dollars) ? dollars : 200) * 1e6;
};

describe("unwind", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Unwind as Program<Unwind>;
  const authority = provider.wallet as anchor.Wallet;

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

  before(async () => {
    for (const kp of [lp, trader, liquidator]) {
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
    [market] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), pool.toBuffer(), FEED_ID],
      program.programId
    );

    await program.methods
      .initializePool({
        pythReceiver: PYTH_RECEIVER,
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
      })
      .rpc();

    await program.methods
      .addMarket(marketParams())
      .accounts({
        payer: authority.publicKey,
        pool,
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

  const addLiquidity = async (amount: BN, price = "at_200") =>
    program.methods
      .addLiquidity(amount, new BN(0))
      .accounts({
        owner: lp.publicKey,
        pool, usdcMint, usdcVault, lpMint,
        ownerUsdc: lpUsdc, ownerLp: lpLp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(await allMarkets(oracle(price)))
      .signers([lp])
      .rpc();

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
    isLong: boolean, collateral: BN, size: BN, price = "at_200", who = trader,
    whoUsdc = () => traderUsdc
  ) => {
    // A limit well through the index, so the order crosses whatever the batch
    // finds. The limit is the slippage control now; there is no separate one.
    const px = Number(priceOf(price));
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
    price = "at_200", who = trader, whoUsdc = () => traderUsdc
  ) => {
    await new Promise((r) => setTimeout(r, BATCH_WAIT_MS));
    await program.methods
      .clearBatch()
      .accounts({ pool, market, batch: batchPda(), priceUpdate: oracle(price) })
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

  /// Closing is a reduce-only order through the same batch as everything else.
  /// `size` of zero means whatever is left unpromised.
  const close = async (
    size: BN, price = "at_200", who = trader, whoUsdc = () => traderUsdc
  ) => {
    const pos: any = await program.account.position.fetch(positionPda(who.publicKey));
    const want = size.isZero() ? pos.sizeUsd.sub(pos.closingUsd) : size;
    const isBid = !pos.isLong;
    const px = Number(priceOf(price));
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

    const poolMid = await program.account.pool.fetch(pool);
    assert.equal(poolMid.lockedUsd.toString(), USD(10_000).toString());

    await close(new BN(0), "at_220"); // +10% on the index
    const after = await getAccount(provider.connection, traderUsdc);

    const pnl = Number(after.amount - before.amount) / 1e6;
    // $10k of notional through a 10% move is ~$1,000, less spread both ways and
    // the open and close fees.
    assert.isAbove(pnl, 900, `expected a large win, got ${pnl}`);
    assert.isBelow(pnl, 1000, `win should be net of costs, got ${pnl}`);

    const p = await program.account.pool.fetch(pool);
    assert.equal(p.lockedUsd.toString(), "0", "reserve must be released");
    assert.isBelow(
      p.liquidityUsd.toNumber(), USD(500_000).toNumber(),
      "the pool is the counterparty and must be down"
    );
  });

  it("keeps a losing trader's collateral in the pool", async () => {
    const poolBefore = await program.account.pool.fetch(pool);
    await open(true, USD(1_200), USD(10_000), "at_200");
    await close(new BN(0), "at_180"); // -10% on $10k of notional wipes out $1.2k
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
      await open(true, USD(1_000), USD(5_000), "wide_conf");
      assert.fail("expected the market to halt on a wide confidence interval");
    } catch (e) {
      assert.include(e.toString(), "OracleConfidenceTooWide");
    }
  });

  it("rejects a partially verified price update", async () => {
    try {
      await open(true, USD(1_000), USD(5_000), "partial");
      assert.fail("expected partial verification to be rejected");
    } catch (e) {
      assert.include(e.toString(), "InsufficientOracleVerification");
    }
  });

  it("rejects leverage above the market maximum", async () => {
    try {
      await open(true, USD(100), USD(10_000)); // 100x
      assert.fail("expected the leverage cap to bind");
    } catch (e) {
      assert.include(e.toString(), "LeverageTooHigh");
    }
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

    await program.methods
      .setSession(0)
      .accounts({ authority: authority.publicKey, pool, market })
      .rpc();
  });

  it("lets anyone liquidate a position through its maintenance margin", async () => {
    await open(true, USD(1_000), USD(8_000), "at_200"); // 8x

    // Healthy at $200: liquidation must not be possible yet.
    try {
      await program.methods
        .liquidate()
        .accounts({
          liquidator: liquidator.publicKey,
          pool, market,
          position: positionPda(trader.publicKey),
          owner: trader.publicKey,
          priceUpdate: oracle("at_200"),
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

    // At $100 the position is far through its margin.
    await program.methods
      .liquidate()
      .accounts({
        liquidator: liquidator.publicKey,
        pool, market,
        position: positionPda(trader.publicKey),
        owner: trader.publicKey,
        priceUpdate: oracle("at_100"),
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
    await open(true, USD(2_000), USD(10_000), "at_200");

    // Two identical deposits, differing only in where the index sits. The
    // second is made while traders are ~$1,000 up, which is a loss the pool has
    // taken but not yet paid out, so each LP token must be worth less and the
    // same dollars must buy more of them. Comparing the two deposits rather
    // than either one in isolation keeps the assertion independent of fees and
    // PnL accumulated by earlier tests.
    const before1 = (await getAccount(provider.connection, lpLp)).amount;
    await addLiquidity(USD(10_000), "at_200");
    const minted1 = (await getAccount(provider.connection, lpLp)).amount - before1;

    const before2 = (await getAccount(provider.connection, lpLp)).amount;
    await addLiquidity(USD(10_000), "at_220");
    const minted2 = (await getAccount(provider.connection, lpLp)).amount - before2;

    assert.isAbove(
      Number(minted2), Number(minted1),
      "unrealized trader profit must lower the LP share price"
    );

    await close(new BN(0), "at_220");
  });

  it("leaves a market nobody trades out of the LP share price", async () => {
    // No open interest: the market owes nothing whatever its price, so a
    // deposit prices without it (`Pool::markets_with_oi`).
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

  it("requires every market with open interest when pricing LP shares", async () => {
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
        .remainingAccounts([]) // the traded market omitted
        .signers([lp])
        .rpc();
      assert.fail("expected the market list check to fail");
    } catch (e) {
      assert.include(e.toString(), "IncompleteMarketList");
    }
    await close(new BN(0), "at_200");
    assert.equal((await program.account.pool.fetch(pool)).marketsWithOi, 0);
  });

  it("carries a position through a stock split unchanged", async () => {
    await open(true, USD(2_000), USD(10_000), "at_200");
    const before = await program.account.position.fetch(positionPda(trader.publicKey));

    await program.methods
      .setMarketPaused(true)
      .accounts({ authority: authority.publicKey, pool, market })
      .rpc();
    // 2-for-1: the price halves, so the price factor is multiplied by 1/2.
    await program.methods
      .applyCorporateAction(new BN(1), new BN(2), new BN(1e9))
      .accounts({ authority: authority.publicKey, pool, market })
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
    await close(new BN(0), "at_100");
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

  it("lets LPs withdraw only unlocked capital", async () => {
    await open(true, USD(50_000), USD(400_000), "at_200"); // locks $400k

    const p = await program.account.pool.fetch(pool);
    const tooMuch = p.liquidityUsd.sub(p.lockedUsd).add(USD(1));
    const lpSupply = (await getAccount(provider.connection, lpLp)).amount;

    try {
      await program.methods
        .removeLiquidity(new BN(lpSupply.toString()), new BN(0))
        .accounts({
          owner: lp.publicKey,
          pool, usdcMint, usdcVault, lpMint,
          ownerUsdc: lpUsdc, ownerLp: lpLp,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(await allMarkets(oracle("at_200")))
        .signers([lp])
        .rpc();
      assert.fail("expected locked capital to be unwithdrawable");
    } catch (e) {
      assert.include(e.toString(), "InsufficientLiquidity");
    }

    await close(new BN(0), "at_200");
  });
});
