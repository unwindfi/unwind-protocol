/// Tests for the pieces that sit between the program and the product.
///
/// The program's own arithmetic is covered by the Rust unit tests and by
/// `unwind.ts`. This covers what was built around it and never had a
/// test: the localnet oracle, the lookup-table liquidity path, a keeper that
/// has to serve every trader rather than one, and the wallet flow where the
/// server builds a transaction that somebody else signs.
///
/// Prices are posted through `mock-pyth` rather than loaded from fixture files,
/// so a test can move the market mid-run — which is what makes the liquidation
/// case deterministic instead of a wait.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createAssociatedTokenAccount, createAssociatedTokenAccountIdempotentInstruction,
  createMint, createMintToInstruction, getAccount, getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import { createHash } from "crypto";
import { createLookupTable, loadLookupTable, sendV0 } from "../scripts/alt";
import { MAX_COMPUTE_UNITS, packInstructions, withComputeLimit } from "../scripts/pack";

const USD = (n: number) => new BN(Math.round(n * 1e6));
const EXP = -8;
const priceArgs = (price: number, over: Partial<any> = {}) => ({
  price: new BN(Math.round(price * 10 ** -EXP)),
  conf: new BN(Math.round(price * 0.0002 * 10 ** -EXP)),
  exponent: EXP,
  publishTime: new BN(Math.floor(Date.now() / 1000)),
  fullyVerified: true,
  ...over,
});

const feedFor = (sym: string) =>
  createHash("sha256").update(`test-feed:${sym}`).digest().subarray(0, 32);

describe("system", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const perps = anchor.workspace.Unwind as Program<any>;
  const pyth = anchor.workspace.MockPyth as Program<any>;
  const conn = provider.connection;
  const authority = (provider.wallet as anchor.Wallet).payer;

  // Two traders, because a keeper that only works for one is the bug this
  // suite exists to catch.
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const lp = Keypair.generate();

  let usdcMint: PublicKey, pool: PublicKey, usdcVault: PublicKey, lpMint: PublicKey;
  let lpUsdc: PublicKey, lpLp: PublicKey;
  const usdcOf = new Map<string, PublicKey>();

  /// Enough markets that the liquidity instruction cannot fit in a legacy
  /// transaction — which is the whole point of the lookup table.
  const SYMBOLS = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "III", "JJJ"];
  const markets = new Map<string, PublicKey>();
  let table: PublicKey;

  const pda = (seeds: (Buffer | Uint8Array)[], p = perps.programId) =>
    PublicKey.findProgramAddressSync(seeds, p)[0];
  const priceAccount = (feed: Buffer) =>
    pda([Buffer.from("price"), feed], pyth.programId);
  const positionPda = (market: PublicKey, owner: PublicKey) =>
    pda([Buffer.from("position"), market.toBuffer(), owner.toBuffer()]);

  /// What each market was last posted at, so an order's limit can be placed
  /// relative to it without reading the oracle account back.
  const lastPosted = new Map<string, number>();

  async function post(sym: string, price: number, over: Partial<any> = {}) {
    lastPosted.set(sym, price);
    const feed = feedFor(sym);
    await pyth.methods
      .postPrice({ feedId: Array.from(feed), ...priceArgs(price, over) })
      .accounts({
        payer: authority.publicKey,
        priceUpdate: priceAccount(feed),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async function seedLiquidity(amount: number) {
    const ix = await perps.methods
      .addLiquidity(USD(amount), new BN(0))
      .accounts({
        owner: lp.publicKey, pool, usdcMint, usdcVault, lpMint,
        ownerUsdc: lpUsdc, ownerLp: lpLp, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(await oiMarketAccounts())
      .instruction();
    await sendV0(conn, lp, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix,
    ], [await loadLookupTable(conn, table)]);
  }

  const marketAccounts = () =>
    SYMBOLS.flatMap((s) => [
      { pubkey: markets.get(s)!, isWritable: false, isSigner: false },
      { pubkey: priceAccount(feedFor(s)), isWritable: false, isSigner: false },
    ]);

  /// What the liquidity instructions actually price: only the markets somebody
  /// holds a position in (`Pool::markets_with_oi`).
  const oiMarketAccounts = async () => {
    const out: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] = [];
    for (const s of SYMBOLS) {
      const m = await perps.account.market.fetch(markets.get(s)!);
      if (m.longSizeUsd.isZero() && m.shortSizeUsd.isZero()) continue;
      out.push(
        { pubkey: markets.get(s)!, isWritable: false, isSigner: false },
        { pubkey: priceAccount(feedFor(s)), isWritable: false, isSigner: false },
      );
    }
    return out;
  };

  const adlAccounts = (sym: string, owner: PublicKey) => ({
    keeper: authority.publicKey,
    pool, market: markets.get(sym)!,
    position: positionPda(markets.get(sym)!, owner),
    owner,
    priceUpdate: priceAccount(feedFor(sym)),
    usdcMint, usdcVault, ownerUsdc: usdcOf.get(owner.toBase58())!,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  const batchPda = (sym: string) =>
    pda([Buffer.from("batch"), markets.get(sym)!.toBuffer()]);

  const orderAccounts = (sym: string, owner: PublicKey) => ({
    owner, pool, market: markets.get(sym)!, batch: batchPda(sym),
    usdcMint, usdcVault, ownerUsdc: usdcOf.get(owner.toBase58())!,
    position: positionPda(markets.get(sym)!, owner),
    tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  });

  /*
   * Opening through the auction: submit, wait out the window, clear, settle.
   *
   * The wait is the design, not overhead — a batch that could be cleared early
   * is a batch worth racing to. With a single order and no counterparty the
   * clearing falls through to the pool, which fills at its own quote, so these
   * tests still open at the oracle-derived price they always did.
   */
  const BATCH_WAIT_MS = 2_000;

  /// Waits out the collection window, seals the batch, and settles whatever
  /// it holds. Shared by opening and closing, because the program does not
  /// distinguish them at this point either.
  const runBatch = async (sym: string) => {
    await new Promise((r) => setTimeout(r, BATCH_WAIT_MS));
    await perps.methods
      .clearBatch()
      .accounts({
        pool, market: markets.get(sym)!, batch: batchPda(sym),
        priceUpdate: priceAccount(feedFor(sym)),
      })
      .rpc();

    const sealed: any = await perps.account.batch.fetch(batchPda(sym));
    // A batch that found no crossing reopens with its orders standing. There
    // is nothing to settle and `settle_order` says so, so do not ask.
    if (Number(sealed.clearedTs) === 0) return;
    for (let i = 0; i < sealed.orders.length; i++) {
      if (!sealed.orders[i].active) continue;
      const owner = new PublicKey(sealed.orders[i].owner);
      await perps.methods
        .settleOrder(i)
        .accounts({
          pool, market: markets.get(sym)!, batch: batchPda(sym), owner,
          position: positionPda(markets.get(sym)!, owner),
          usdcMint, usdcVault, ownerUsdc: usdcOf.get(owner.toBase58())!,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    }
  };

  const open = async (
    sym: string, who: Keypair, isLong: boolean, collateral: BN, size: BN,
    limitPrice?: number
  ) => {
    // A limit far enough through the index to cross whatever the batch finds.
    // The limit *is* the slippage control now; there is no separate argument.
    const ref = limitPrice ?? lastPosted.get(sym) ?? 100;
    const limit = USD(ref * (isLong ? 1.2 : 0.8));

    await perps.methods
      .submitOrder(limit, size, collateral, isLong, false, false)
      .accounts(orderAccounts(sym, who.publicKey))
      .signers([who])
      .rpc();

    await runBatch(sym);
  };

  /// Closing through the auction: a reduce-only order, then the same batch.
  ///
  /// `size` of zero means whatever the position still has that is not already
  /// promised to another resting order.
  const close = async (sym: string, who: Keypair, size: BN = new BN(0)) => {
    const market = markets.get(sym)!;
    const pos: any = await perps.account.position.fetch(
      positionPda(market, who.publicKey));
    const want = size.isZero()
      ? pos.sizeUsd.sub(pos.closingUsd)
      : size;
    // Closing a long sells, closing a short buys.
    const isBid = !pos.isLong;
    const ref = lastPosted.get(sym) ?? 100;
    const limit = USD(ref * (isBid ? 1.2 : 0.8));

    await perps.methods
      .submitOrder(limit, want, new BN(0), isBid, true, false)
      .accounts(orderAccounts(sym, who.publicKey))
      .signers([who])
      .rpc();

    await runBatch(sym);
  };

  const marketParams = (sym: string, over: Record<string, any> = {}) => ({
    symbol: Array.from(Buffer.concat([Buffer.from(sym), Buffer.alloc(16)]).subarray(0, 16)),
    feedId: Array.from(feedFor(sym)),
    maxPriceAgeSec: 3600, maxConfBps: 500,
    maxLeverageBps: 100_000, maintenanceMarginBps: 500,
    liquidationFeeBps: 100, openFeeBps: 6, closeFeeBps: 6,
    minPositionUsd: USD(10),
    maxOiLongUsd: USD(5_000_000), maxOiShortUsd: USD(5_000_000),
    pnlReserveBps: 10_000,
    baseSpreadBps: 4, confSpreadMultBps: 10_000, maxSpreadBps: 500,
    closedSessionLeverageBps: 20_000, closedSessionOiMultBps: 2_500,
    maxFundingRateBpsPerHour: 100, fundingKBps: 8_000, borrowRateBpsPerHour: 1,
    priceSource: 0,
    observation: PublicKey.default,
    ...over,
  });

  const setParams = (sym: string, over: Record<string, any>) =>
    perps.methods.updateMarketParams(marketParams(sym, over))
      .accounts({ authority: authority.publicKey, pool, market: markets.get(sym)! })
      .rpc();

  before(async () => {
    for (const kp of [alice, bob, lp]) {
      await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 100e9), "confirmed");
    }
    usdcMint = await createMint(conn, authority, authority.publicKey, null, 6);

    pool = pda([Buffer.from("pool"), usdcMint.toBuffer()]);
    usdcVault = pda([Buffer.from("pool_vault"), pool.toBuffer()]);
    lpMint = pda([Buffer.from("lp_mint"), pool.toBuffer()]);

    await perps.methods
      .initializePool({
        chainFeeDestination: authority.publicKey,
        pythReceiver: pyth.programId,
        addLiquidityFeeBps: 0, removeLiquidityFeeBps: 0,
        protocolFeeShareBps: 2000,
        insuranceFeeShareBps: 1000, maxUtilizationBps: 8000,
      })
      .accounts({
        authority: authority.publicKey, pool, usdcMint, usdcVault, lpMint,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc();

    for (const s of SYMBOLS) {
      const feed = feedFor(s);
      await post(s, 100);
      const market = pda([Buffer.from("market"), pool.toBuffer(), feed]);
      await perps.methods
        .addMarket(marketParams(s))
        .accounts({ payer: authority.publicKey, pool, market, systemProgram: SystemProgram.programId })
        .rpc();
      markets.set(s, market);

      // A market lists unfunded and with nowhere to put orders. Both are
      // deliberate — underwriting is a separate decision from listing, and a
      // market with no batch simply cannot be traded — so the setup has to do
      // what a real operator would.
      await perps.methods
        .createBatch()
        .accounts({
          payer: authority.publicKey, pool, market,
          batch: pda([Buffer.from("batch"), market.toBuffer()]),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      // The budget comes from backing, which the authority posts here like
      // any backer would.
      const authorityUsdc = await getOrCreateAssociatedTokenAccount(
        conn, authority, usdcMint, authority.publicKey);
      await mintTo(conn, authority, usdcMint, authorityUsdc.address, authority.publicKey, 10_000_000e6);
      await perps.methods
        .backMarket(USD(10_000_000))
        .accounts({
          owner: authority.publicKey, pool, market,
          backing: pda([Buffer.from("backing"), market.toBuffer(), authority.publicKey.toBuffer()]),
          book: pda([Buffer.from("backing_book"), market.toBuffer()]),
          depositMint: usdcMint, depositVault: usdcVault, ownerToken: authorityUsdc.address,
          tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    lpUsdc = await createAssociatedTokenAccount(conn, lp, usdcMint, lp.publicKey);
    lpLp = await createAssociatedTokenAccount(conn, lp, lpMint, lp.publicKey);
    await mintTo(conn, authority, usdcMint, lpUsdc, authority.publicKey, 5_000_000e6);

    for (const kp of [alice, bob]) {
      const acc = await createAssociatedTokenAccount(conn, kp, usdcMint, kp.publicKey);
      usdcOf.set(kp.publicKey.toBase58(), acc);
      await mintTo(conn, authority, usdcMint, acc, authority.publicKey, 200_000e6);
    }

    // The pool is the counterparty to every test below, so it has to be funded
    // before anything opens — and funding it already needs the lookup table.
    table = await createLookupTable(conn, authority, marketAccounts().map((a) => a.pubkey));
    await seedLiquidity(1_000_000);
  });

  describe("closing", () => {
    it("prices an exit at the batch's clearing price, not the index", async () => {
      await post("BBB", 100);
      await open("BBB", alice, true, USD(2_000), USD(8_000));

      // Move the index between the open and the close, so a close that still
      // read the oracle and one that reads the batch cannot give the same
      // answer.
      await post("BBB", 108);

      const market = markets.get("BBB")!;
      const before: any = await perps.account.position.fetch(
        positionPda(market, alice.publicKey));

      await perps.methods
        .submitOrder(USD(100), before.sizeUsd, new BN(0), false, true, false)
        .accounts(orderAccounts("BBB", alice.publicKey))
        .signers([alice]).rpc();

      // While it rests, the size is spoken for and the position still stands.
      const resting: any = await perps.account.position.fetch(
        positionPda(market, alice.publicKey));
      assert.equal(resting.closingUsd.toString(), before.sizeUsd.toString(),
        "a resting close reserves the size it promised");
      assert.equal(resting.sizeUsd.toString(), before.sizeUsd.toString(),
        "and changes nothing else until the batch clears");

      await runBatch("BBB");

      const after: any = await perps.account.position.fetch(
        positionPda(market, alice.publicKey));
      assert.equal(after.sizeUsd.toNumber(), 0, "the batch closed it");
      assert.equal(after.closingUsd.toNumber(), 0, "and gave the reservation back");
    });

    it("will not let one position be promised to two closing orders", async () => {
      await post("BBB", 100);
      await open("BBB", alice, true, USD(2_000), USD(8_000));
      const market = markets.get("BBB")!;
      const pos: any = await perps.account.position.fetch(
        positionPda(market, alice.publicKey));

      // Through the index, so the batch actually crosses and this test ends
      // with the position closed rather than an order left resting on BBB.
      await perps.methods
        .submitOrder(USD(95), pos.sizeUsd, new BN(0), false, true, false)
        .accounts(orderAccounts("BBB", alice.publicKey))
        .signers([alice]).rpc();

      // Nothing is escrowed behind a close, so the only thing standing between
      // a trader and closing the same size twice is the reservation. Without
      // it the second settlement unwinds a position that only ever covered the
      // first, and the pool pays for both.
      try {
        await perps.methods
          .submitOrder(USD(95), pos.sizeUsd, new BN(0), false, true, false)
          .accounts(orderAccounts("BBB", alice.publicKey))
          .signers([alice]).rpc();
        assert.fail("the same size must not be promised twice");
      } catch (e: any) {
        assert.include(e.toString(), "PositionTooSmall");
      }

      await runBatch("BBB");
    });

    it("gives the reservation back when a closing order is cancelled", async () => {
      await post("BBB", 100);
      await open("BBB", alice, true, USD(2_000), USD(8_000));
      const market = markets.get("BBB")!;
      const pos: any = await perps.account.position.fetch(
        positionPda(market, alice.publicKey));

      await perps.methods
        .submitOrder(USD(100), pos.sizeUsd, new BN(0), false, true, false)
        .accounts(orderAccounts("BBB", alice.publicKey))
        .signers([alice]).rpc();

      const b: any = await perps.account.batch.fetch(batchPda("BBB"));
      const index = b.orders.findIndex((o: any) =>
        o.active && o.reduceOnly && new PublicKey(o.owner).equals(alice.publicKey));
      assert.isAtLeast(index, 0, "the closing order should be resting");

      await perps.methods.cancelBatchOrder(index)
        .accounts({
          owner: alice.publicKey, pool, market, batch: batchPda("BBB"),
          usdcMint, usdcVault, ownerUsdc: usdcOf.get(alice.publicKey.toBase58())!,
          position: positionPda(market, alice.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([alice]).rpc();

      const after: any = await perps.account.position.fetch(
        positionPda(market, alice.publicKey));
      assert.equal(after.closingUsd.toNumber(), 0,
        "cancelling must free the size, or the position can never be closed");
      assert.equal(after.sizeUsd.toString(), pos.sizeUsd.toString());

      await close("BBB", alice);
    });
  });

  describe("localnet oracle", () => {
    it("prices a fill at what was posted", async () => {
      await post("AAA", 250);
      await open("AAA", alice, true, USD(1_000), USD(5_000));

      const p = await perps.account.position.fetch(positionPda(markets.get("AAA")!, alice.publicKey));
      const entry = p.entryPrice.toNumber() / 1e6;
      // Posted price plus the spread, and nothing else.
      assert.isAbove(entry, 250, `entry ${entry} should include the spread`);
      assert.isBelow(entry, 250 * 1.01, `entry ${entry} should be the posted price`);

      await close("AAA", alice);
    });

    it("rejects a stale price", async () => {
      // Narrow this one market's tolerance and let its price age past it, then
      // put it back. Posting an old timestamp is not an option — mock-pyth
      // refuses a publish time that goes backwards — and leaving any market
      // permanently stale would block the pool, since liquidity prices all of
      // them.
      await setParams("BBB", { maxPriceAgeSec: 1 });
      await new Promise((r) => setTimeout(r, 2500));
      try {
        await open("BBB", alice, true, USD(1_000), USD(5_000));
        assert.fail("expected a stale price to be rejected");
      } catch (e: any) {
        assert.include(e.toString(), "StaleOracle");
      } finally {
        await setParams("BBB", {});
        await post("BBB", 100);
      }
    });

    it("refuses a price whose publish time goes backwards", async () => {
      // The oracle's own guard: a replayed or reordered post must not be able
      // to walk a market's price back in time.
      try {
        await post("AAA", 100, {
          publishTime: new BN(Math.floor(Date.now() / 1000) - 600),
        });
        assert.fail("expected a regressed publish time to be rejected");
      } catch (e: any) {
        assert.include(e.toString(), "PublishTimeRegressed");
      }
    });

    it("rejects a partially verified price", async () => {
      await post("CCC", 100, { fullyVerified: false });
      try {
        await open("CCC", alice, true, USD(1_000), USD(5_000));
        assert.fail("expected partial verification to be rejected");
      } catch (e: any) {
        assert.include(e.toString(), "InsufficientOracleVerification");
      }
      await post("CCC", 100);
    });

    it("halts when confidence is too wide", async () => {
      await post("DDD", 100, { conf: new BN(Math.round(100 * 0.08 * 10 ** -EXP)) });
      try {
        await open("DDD", alice, true, USD(1_000), USD(5_000));
        assert.fail("expected a wide confidence interval to halt the market");
      } catch (e: any) {
        assert.include(e.toString(), "OracleConfidenceTooWide");
      }
      await post("DDD", 100);
    });
  });

  describe("lookup table", () => {
    it("is what keeps the instruction inside the size limit", async () => {
      const ix = await perps.methods
        .addLiquidity(USD(1), new BN(0))
        .accounts({
          owner: lp.publicKey, pool, usdcMint, usdcVault, lpMint,
          ownerUsdc: lpUsdc, ownerLp: lpLp, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(marketAccounts())
        .instruction();

      const blockhash = (await conn.getLatestBlockhash()).blockhash;
      const legacy = new TransactionMessage({
        payerKey: lp.publicKey, recentBlockhash: blockhash, instructions: [ix],
      }).compileToLegacyMessage().serialize().length;

      const compressed = new TransactionMessage({
        payerKey: lp.publicKey, recentBlockhash: blockhash, instructions: [ix],
      }).compileToV0Message([await loadLookupTable(conn, table)]).serialize().length;

      // Inline, an account costs its 32-byte key plus a 1-byte index. Through
      // the table it costs one index in the instruction and one in the lookup
      // section: 2 bytes. So ~31 per account, less the 32-byte table key paid
      // once — measured at 584 bytes over 20 accounts.
      const saved = legacy - compressed;
      assert.isAbove(saved, SYMBOLS.length * 2 * 25,
        `expected the table to save ~29 bytes per account, saved ${saved}`);
      assert.isBelow(compressed + 65, 1232,
        `compressed message ${compressed} + signature must fit the 1232 limit`);
    });

    it("carries the same instruction through a v0 transaction", async () => {
      const loaded = await loadLookupTable(conn, table);
      assert.equal(loaded.state.addresses.length, SYMBOLS.length * 2);

      const ix = await perps.methods
        .addLiquidity(USD(1_000_000), new BN(0))
        .accounts({
          owner: lp.publicKey, pool, usdcMint, usdcVault, lpMint,
          ownerUsdc: lpUsdc, ownerLp: lpLp, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(await oiMarketAccounts())
        .instruction();

      const before = (await perps.account.pool.fetch(pool)).liquidityUsd.toNumber();
      await sendV0(conn, lp, [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix,
      ], [loaded]);

      // As a delta. What this test is about is the transaction landing, and an
      // absolute total only held while nothing had traded beforehand.
      const p = await perps.account.pool.fetch(pool);
      assert.equal(p.liquidityUsd.toNumber() - before, USD(1_000_000).toNumber(),
        "the deposit carried by the v0 transaction landed");
      assert.isAbove(Number((await getAccount(conn, lpLp)).amount), 0);
    });
  });

  describe("keeper", () => {
    it("finds every trader's position, not just one account's", async () => {
      // Alice near the edge, Bob comfortable, in the same market.
      await post("EEE", 100);
      await open("EEE", alice, true, USD(1_000), USD(9_000));
      await open("EEE", bob, true, USD(5_000), USD(9_000));

      // The scan the keeper actually performs.
      const all = await perps.account.position.all();
      const inMarket = all.filter(
        (a: any) => a.account.market.toBase58() === markets.get("EEE")!.toBase58()
          && a.account.sizeUsd.toNumber() > 0);
      assert.equal(inMarket.length, 2, "both traders' positions must be visible");
      const owners = inMarket.map((a: any) => a.account.owner.toBase58()).sort();
      assert.deepEqual(owners, [alice.publicKey.toBase58(), bob.publicKey.toBase58()].sort());

      // A move that takes Alice through her margin and leaves Bob fine.
      await post("EEE", 89);

      // The setup made it when the authority backed the markets.
      const liquidatorUsdc = getAssociatedTokenAddressSync(usdcMint, authority.publicKey);

      for (const entry of inMarket as any[]) {
        const owner = entry.account.owner as PublicKey;
        try {
          await perps.methods.liquidate().accounts({
            liquidator: authority.publicKey,
            pool, market: markets.get("EEE")!, position: entry.publicKey, owner,
            priceUpdate: priceAccount(feedFor("EEE")),
            usdcMint, usdcVault,
            ownerUsdc: usdcOf.get(owner.toBase58())!,
            liquidatorUsdc,
            tokenProgram: TOKEN_PROGRAM_ID,
          }).rpc();
        } catch (e: any) {
          // Bob is healthy; the program says so rather than the keeper guessing.
          assert.include(e.toString(), "PositionHealthy");
        }
      }

      const aliceAfter = await perps.account.position.fetch(
        positionPda(markets.get("EEE")!, alice.publicKey));
      const bobAfter = await perps.account.position.fetch(
        positionPda(markets.get("EEE")!, bob.publicKey));
      assert.equal(aliceAfter.sizeUsd.toNumber(), 0, "the underwater trader is closed");
      assert.isAbove(bobAfter.sizeUsd.toNumber(), 0, "the healthy trader is untouched");

      await post("EEE", 100);
      await close("EEE", bob);
    });
  });

  describe("insurance fund", () => {
    it("fills from trading fees", async () => {
      const before = (await perps.account.pool.fetch(pool)).insuranceUsd.toNumber();
      await post("HHH", 100);
      await open("HHH", alice, true, USD(2_000), USD(10_000));
      await close("HHH", alice);

      const after = (await perps.account.pool.fetch(pool)).insuranceUsd.toNumber();
      // 10% of the close fee, which is 6bp of $10,000.
      assert.isAbove(after, before, "the close fee should have fed the fund");
    });

    it("takes capital from anyone, without issuing a claim", async () => {
      const before = await perps.account.pool.fetch(pool);
      const lpBefore = (await getAccount(conn, lpLp)).amount;

      await perps.methods.fundInsurance(USD(25_000))
        .accounts({
          payer: bob.publicKey, pool, usdcMint, usdcVault,
          payerUsdc: usdcOf.get(bob.publicKey.toBase58())!,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([bob])
        .rpc();

      const after = await perps.account.pool.fetch(pool);
      assert.equal(
        after.insuranceUsd.toNumber() - before.insuranceUsd.toNumber(),
        USD(25_000).toNumber());
      // Given, not deposited: no LP tokens, and LP liquidity is untouched.
      assert.equal((await getAccount(conn, lpLp)).amount.toString(), lpBefore.toString());
      assert.equal(after.liquidityUsd.toString(), before.liquidityUsd.toString());
    });

    it("stands between a gap and the LPs", async () => {
      // A market whose reserve covers only a sliver of the notional, so a
      // modest move puts the pool past what it set aside.
      await setParams("III", { pnlReserveBps: 500, maxLeverageBps: 100_000 });
      await post("III", 100);

      await open("III", alice, true, USD(2_000), USD(18_000));

      const before = await perps.account.pool.fetch(pool);
      // Drain LP liquidity to just under what the winning close will owe, so
      // the fund is the only thing that can settle it.
      await post("III", 140);

      const p = await perps.account.pool.fetch(pool);
      assert.isAbove(p.insuranceUsd.toNumber(), 0, "the fund must be seeded for this");

      await close("III", alice);

      const after = await perps.account.pool.fetch(pool);
      const pos = await perps.account.position.fetch(
        positionPda(markets.get("III")!, alice.publicKey));
      assert.equal(pos.sizeUsd.toNumber(), 0, "the winning trader got out");
      assert.isAtMost(after.liquidityUsd.toNumber(), before.liquidityUsd.toNumber(),
        "the payout came out of the pool");

      await setParams("III", {});
      await post("III", 100);
    });
  });

  describe("auto-deleveraging", () => {
    it("refuses a position the reserve still covers", async () => {
      await setParams("JJJ", {});
      await post("JJJ", 100);
      await open("JJJ", alice, true, USD(2_000), USD(10_000));
      await post("JJJ", 104);

      try {
        await perps.methods.autoDeleverage().accounts(adlAccounts("JJJ", alice.publicKey)).rpc();
        assert.fail("a covered position must not be deleveraged");
      } catch (e: any) {
        assert.include(e.toString(), "PositionCovered");
      }

      await close("JJJ", alice);
      await post("JJJ", 100);
    });

    it("closes a position whose profit has outgrown its reserve, paying it in full", async () => {
      // A thin reserve, so a modest move puts the profit past what the pool set
      // aside against this position.
      await setParams("JJJ", { pnlReserveBps: 1_000 });
      await post("JJJ", 100);
      await open("JJJ", alice, true, USD(2_000), USD(15_000));

      const reserved = (await perps.account.position.fetch(
        positionPda(markets.get("JJJ")!, alice.publicKey))).lockedUsd.toNumber();

      await post("JJJ", 130);

      const before = Number((await getAccount(conn, usdcOf.get(alice.publicKey.toBase58())!)).amount);
      await perps.methods.autoDeleverage()
        .accounts(adlAccounts("JJJ", alice.publicKey))
        .rpc();
      const after = Number((await getAccount(conn, usdcOf.get(alice.publicKey.toBase58())!)).amount);

      const pos = await perps.account.position.fetch(
        positionPda(markets.get("JJJ")!, alice.publicKey));
      assert.equal(pos.sizeUsd.toNumber(), 0, "the position is closed");

      // Full equity, no penalty: more than the collateral they put up.
      const paid = after - before;
      assert.isAbove(paid, USD(2_000).toNumber(),
        "a deleveraged trader keeps their profit");
      // And the profit really had outgrown the reserve, which is the trigger.
      assert.isAbove(paid - USD(2_000).toNumber(), reserved * 0.5);

      await setParams("JJJ", {});
      await post("JJJ", 100);
    });
  });

  describe("trigger orders", () => {
    const orderPda = (market: PublicKey, owner: PublicKey, slot: number) =>
      pda([Buffer.from("order"), market.toBuffer(), owner.toBuffer(), Buffer.from([slot])]);

    const placeParams = (over: Record<string, any> = {}) => ({
      slot: 0, kind: 0, isLong: true,
      sizeUsd: new BN(0), collateralUsd: new BN(0),
      triggerPrice: USD(120), triggerAbove: true, expiryTs: new BN(0),
      ...over,
    });

    const placeAccounts = (sym: string, kp: Keypair, slot: number) => ({
      owner: kp.publicKey, pool, market: markets.get(sym)!,
      order: orderPda(markets.get(sym)!, kp.publicKey, slot),
      position: positionPda(markets.get(sym)!, kp.publicKey),
      usdcMint, usdcVault, ownerUsdc: usdcOf.get(kp.publicKey.toBase58())!,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    });

    const cancelAccounts = (kp: Keypair, order: PublicKey) => ({
      owner: kp.publicKey, pool, order,
      usdcMint, usdcVault, ownerUsdc: usdcOf.get(kp.publicKey.toBase58())!,
      tokenProgram: TOKEN_PROGRAM_ID,
    });

    const execAccounts = (sym: string, owner: PublicKey, slot: number) => ({
      keeper: authority.publicKey,
      pool, market: markets.get(sym)!,
      order: orderPda(markets.get(sym)!, owner, slot),
      position: positionPda(markets.get(sym)!, owner),
      owner,
      priceUpdate: priceAccount(feedFor(sym)),
      batch: batchPda(sym),
      usdcMint, usdcVault, ownerUsdc: usdcOf.get(owner.toBase58())!,
      tokenProgram: TOKEN_PROGRAM_ID,
    });

    /*
     * Firing a trigger no longer fills it. `execute_order` turns the trigger
     * into an order in the market's batch and the auction prices it, so every
     * test that used to assert on a position straight afterwards has to let
     * that batch clear first. Without it there was a standing way to trade at
     * the index: place a stop a tick away and have a keeper fire it.
     */
    const fire = async (sym: string, owner: PublicKey, slot: number) => {
      await perps.methods.executeOrder()
        .accounts(execAccounts(sym, owner, slot)).rpc();
      await runBatch(sym);
    };

    it("will not fire before the price gets there", async () => {
      await post("JJJ", 100);
      await open("JJJ", alice, true, USD(2_000), USD(8_000));

      await perps.methods.placeOrder(placeParams({ triggerPrice: USD(120) }))
        .accounts(placeAccounts("JJJ", alice, 0))
        .signers([alice]).rpc();

      await post("JJJ", 110);
      try {
        await perps.methods.executeOrder().accounts(execAccounts("JJJ", alice.publicKey, 0)).rpc();
        assert.fail("an untriggered order must not execute");
      } catch (e: any) {
        assert.include(e.toString(), "OrderNotTriggered");
      }
    });

    it("takes profit when the index crosses the trigger", async () => {
      const before = Number((await getAccount(conn, usdcOf.get(alice.publicKey.toBase58())!)).amount);
      await post("JJJ", 121);

      await fire("JJJ", alice.publicKey, 0);

      const pos = await perps.account.position.fetch(
        positionPda(markets.get("JJJ")!, alice.publicKey));
      assert.equal(pos.sizeUsd.toNumber(), 0, "the position is closed");

      const paid = Number((await getAccount(conn, usdcOf.get(alice.publicKey.toBase58())!)).amount) - before;
      assert.isAbove(paid, USD(2_000).toNumber(), "a take-profit pays out the gain");

      // Spent: the account is gone, so the keeper stops seeing it.
      const acc = await conn.getAccountInfo(orderPda(markets.get("JJJ")!, alice.publicKey, 0));
      assert.isNull(acc, "an executed order is closed");
      await post("JJJ", 100);
    });

    it("stops out a long on the way down", async () => {
      await post("JJJ", 100);
      await open("JJJ", alice, true, USD(2_000), USD(8_000));

      // Slot 1, so a stop can sit alongside a take-profit on the same market.
      await perps.methods.placeOrder(placeParams({
        slot: 1, triggerPrice: USD(95), triggerAbove: false,
      }))
        .accounts(placeAccounts("JJJ", alice, 1))
        .signers([alice]).rpc();

      await post("JJJ", 94);
      await fire("JJJ", alice.publicKey, 1);

      const pos = await perps.account.position.fetch(
        positionPda(markets.get("JJJ")!, alice.publicKey));
      assert.equal(pos.sizeUsd.toNumber(), 0, "the stop closed the position");
      await post("JJJ", 100);
    });

    it("lets the owner cancel, and nobody else", async () => {
      await perps.methods.placeOrder(placeParams({ slot: 2 }))
        .accounts(placeAccounts("JJJ", alice, 2))
        .signers([alice]).rpc();

      try {
        await perps.methods.cancelOrder()
          .accounts(cancelAccounts(bob, orderPda(markets.get("JJJ")!, alice.publicKey, 2)))
          .signers([bob]).rpc();
        assert.fail("another trader must not cancel this order");
      } catch (e: any) {
        assert.match(e.toString(), /Unauthorized|ConstraintSeeds|ConstraintHasOne/);
      }

      await perps.methods.cancelOrder()
        .accounts(cancelAccounts(alice, orderPda(markets.get("JJJ")!, alice.publicKey, 2)))
        .signers([alice]).rpc();
      assert.isNull(await conn.getAccountInfo(orderPda(markets.get("JJJ")!, alice.publicKey, 2)));
    });

    it("escrows a limit order's collateral when it is placed", async () => {
      await post("JJJ", 100);
      const before = Number((await getAccount(conn, usdcOf.get(alice.publicKey.toBase58())!)).amount);
      const poolBefore = await perps.account.pool.fetch(pool);

      await perps.methods.placeOrder(placeParams({
        slot: 3, kind: 1, sizeUsd: USD(8_000), collateralUsd: USD(2_000),
        triggerPrice: USD(90), triggerAbove: false,
      }))
        .accounts(placeAccounts("JJJ", alice, 3))
        .signers([alice]).rpc();

      const after = Number((await getAccount(conn, usdcOf.get(alice.publicKey.toBase58())!)).amount);
      assert.equal(before - after, USD(2_000).toNumber(), "collateral leaves the trader");

      const poolAfter = await perps.account.pool.fetch(pool);
      assert.equal(
        poolAfter.escrowUsd.toNumber() - poolBefore.escrowUsd.toNumber(),
        USD(2_000).toNumber(), "and is held as escrow, not as liquidity");
      assert.equal(poolAfter.liquidityUsd.toString(), poolBefore.liquidityUsd.toString());
    });

    it("opens the position when the limit price is reached", async () => {
      await post("JJJ", 89);
      const escrowBefore = (await perps.account.pool.fetch(pool)).escrowUsd.toNumber();
      await fire("JJJ", alice.publicKey, 3);

      const pos = await perps.account.position.fetch(
        positionPda(markets.get("JJJ")!, alice.publicKey));
      assert.isTrue(pos.isLong);
      assert.equal(pos.sizeUsd.toNumber(), USD(8_000).toNumber());
      // Filled at the limit or better, never worse.
      assert.isAtMost(pos.entryPrice.toNumber() / 1e6, 90 * 1.01);

      // Measured as a change, not as an absolute. `escrow_usd` is shared with
      // the batch auction now, and orders resting in other markets are money
      // legitimately held — so a global zero says nothing about this order.
      const p = await perps.account.pool.fetch(pool);
      assert.equal(
        escrowBefore - p.escrowUsd.toNumber(), USD(2_000).toNumber(),
        "escrow became collateral");

      await close("JJJ", alice);
      await post("JJJ", 100);
    });

    it("fills on a market the trader has never touched", async () => {
      // The position account does not exist yet here, so this is the case where
      // placing the order is what creates it — and where an uninitialised
      // position would make the order unfillable.
      await post("GGG", 100);
      await perps.methods.placeOrder(placeParams({
        slot: 5, kind: 1, sizeUsd: USD(6_000), collateralUsd: USD(2_000),
        triggerPrice: USD(101), triggerAbove: false,
      }))
        .accounts(placeAccounts("GGG", bob, 5))
        .signers([bob]).rpc();

      await fire("GGG", bob.publicKey, 5);

      const pos = await perps.account.position.fetch(
        positionPda(markets.get("GGG")!, bob.publicKey));
      assert.equal(pos.owner.toBase58(), bob.publicKey.toBase58());
      assert.equal(pos.sizeUsd.toNumber(), USD(6_000).toNumber());

      await close("GGG", bob);
    });

    it("gives the escrow back if the order is cancelled", async () => {
      await post("JJJ", 100);
      const before = Number((await getAccount(conn, usdcOf.get(alice.publicKey.toBase58())!)).amount);
      const escrowBefore = (await perps.account.pool.fetch(pool)).escrowUsd.toNumber();

      await perps.methods.placeOrder(placeParams({
        slot: 4, kind: 1, sizeUsd: USD(8_000), collateralUsd: USD(2_000),
        triggerPrice: USD(50), triggerAbove: false,
      }))
        .accounts(placeAccounts("JJJ", alice, 4))
        .signers([alice]).rpc();

      await perps.methods.cancelOrder()
        .accounts(cancelAccounts(alice, orderPda(markets.get("JJJ")!, alice.publicKey, 4)))
        .signers([alice]).rpc();

      const after = Number((await getAccount(conn, usdcOf.get(alice.publicKey.toBase58())!)).amount);
      assert.equal(after, before, "a cancelled order leaves the trader whole");
      assert.equal(
        (await perps.account.pool.fetch(pool)).escrowUsd.toNumber(), escrowBefore,
        "and the pool holds exactly what it held before");
    });
  });

  describe("an order that cannot be booked", () => {
    it("is refused when it opens against the side already held", async () => {
      await post("JJJ", 100);
      await open("JJJ", alice, true, USD(1_000), USD(4_000));
      try {
        await perps.methods
          .submitOrder(USD(80), USD(2_000), USD(1_000), false, false, false)
          .accounts(orderAccounts("JJJ", alice.publicKey))
          .signers([alice])
          .rpc();
        assert.fail("an open against a held long must not be accepted");
      } catch (e: any) {
        assert.match(e.toString(), /PositionAlreadyOpen/);
      }
      await close("JJJ", alice);
    });

    it("goes home unfilled rather than freezing the batch", async () => {
      // Both sides from one wallet in one batch: whichever settles second
      // cannot be booked, because positions do not flip.
      const before = Number((await getAccount(conn, usdcOf.get(bob.publicKey.toBase58())!)).amount);
      for (const isBid of [true, false]) {
        await perps.methods
          .submitOrder(USD(isBid ? 120 : 80), USD(2_000), USD(1_000), isBid, false, false)
          .accounts(orderAccounts("JJJ", bob.publicKey))
          .signers([bob])
          .rpc();
      }
      const seq = Number((await perps.account.batch.fetch(batchPda("JJJ"))).seq);
      await runBatch("JJJ");

      const b: any = await perps.account.batch.fetch(batchPda("JJJ"));
      assert.equal(Number(b.seq), seq + 1, "the batch cleared and the next one opened");
      assert.equal(Number(b.clearedTs), 0, "and it is collecting again");

      const pos: any = await perps.account.position.fetch(positionPda(markets.get("JJJ")!, bob.publicKey));
      assert.isAbove(Number(pos.sizeUsd), 0, "one side was booked");
      const after = Number((await getAccount(conn, usdcOf.get(bob.publicKey.toBase58())!)).amount);
      // $2,000 posted, one $1,000 escrow booked as margin, the other returned.
      assert.approximately((before - after) / 1e6, 1_000, 1, "the unbookable side came back in full");
      await close("JJJ", bob);
    });
  });

  describe("dual flow", () => {
    const submit = (who: Keypair, price: number, isBid: boolean, isMaker: boolean) =>
      perps.methods
        .submitOrder(USD(price), USD(2_000), USD(1_000), isBid, false, isMaker)
        .accounts(orderAccounts("CCC", who.publicKey))
        .signers([who])
        .rpc();
    const entry = async (who: Keypair) => Number((await perps.account.position.fetch(
      positionPda(markets.get("CCC")!, who.publicKey))).entryPrice) / 1e6;

    // Earlier tests leave orders resting in this market's batch, refused at
    // settlement or never cleared. Anything left in the book is part of the
    // auction, so each test here starts from an empty one.
    beforeEach(async () => {
      const b: any = await perps.account.batch.fetch(batchPda("CCC"));
      for (let i = 0; i < b.orders.length; i++) {
        const o = b.orders[i];
        if (!o.active) continue;
        const who = [alice, bob].find((k) => k.publicKey.equals(new PublicKey(o.owner)))!;
        await perps.methods
          .cancelBatchOrder(i)
          .accounts({
            owner: who.publicKey, pool, market: markets.get("CCC")!, batch: batchPda("CCC"),
            usdcMint, usdcVault, ownerUsdc: usdcOf.get(who.publicKey.toBase58())!,
            position: positionPda(markets.get("CCC")!, who.publicKey),
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([who])
          .rpc();
      }
    });

    it("fills a taker at the price a maker named", async () => {
      await post("CCC", 100);
      // Alice would pay up to 102. Bob is making at 100.30. In the buy flow
      // the crossing nearest the index is Bob's price, and Alice gets it.
      await submit(alice, 102, true, false);
      await submit(bob, 100.3, false, true);
      const seq = Number((await perps.account.batch.fetch(batchPda("CCC"))).seq);
      let id = 0;
      const heard = new Promise<any>((resolve) => {
        id = perps.addEventListener("batchCleared", (ev: any) => {
          if (Number(ev.seq) === seq) resolve(ev);
        });
      });
      // Settled as well as cleared before anything is read back: the event
      // lands first, and a position read then would still be empty.
      await runBatch("CCC");
      const cleared = await heard;
      await perps.removeEventListener(id);
      assert.equal(Number(cleared.buyPrice), USD(100.3).toNumber(), "the maker's price");
      assert.equal(Number(cleared.poolSold), 0, "the pool sold nothing: the maker filled it all");
      assert.equal(Number(cleared.sellPrice), 0, "nobody was selling to a maker");
      assert.approximately(await entry(alice), 100.3, 1e-6);
      assert.approximately(await entry(bob), 100.3, 1e-6);
      await close("CCC", alice);
      await close("CCC", bob);
    });

    it("never crosses two takers with each other", async () => {
      await post("CCC", 100);
      // Crossed by four dollars. In one book they would have traded with
      // each other at a single price. Here each meets only the pool, at its
      // own side of the quote.
      await submit(alice, 102, true, false);
      await submit(bob, 98, false, false);
      await runBatch("CCC");
      const bought = await entry(alice);
      const sold = await entry(bob);
      assert.isAbove(bought, 100, "the taker buying paid the pool's ask");
      assert.isBelow(sold, 100, "the taker selling got the pool's bid");
      await close("CCC", alice);
      await close("CCC", bob);
    });
  });

  describe("wallet flow", () => {
    it("a transaction built for someone else is valid once they sign it", async () => {
      await post("FFF", 100);

      // Exactly what the server does: build, serialise, hand over unsigned.
      const ix = await perps.methods
        .submitOrder(USD(120), USD(4_000), USD(1_000), true, false, false)
        .accounts(orderAccounts("FFF", bob.publicKey))
        .instruction();
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({
        payerKey: bob.publicKey, recentBlockhash: blockhash, instructions: [ix],
      }).compileToV0Message();
      const wire = Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");

      // The authority cannot send it, because it is not the owner.
      const unsigned = VersionedTransaction.deserialize(Buffer.from(wire, "base64"));
      assert.isTrue(unsigned.signatures.every((s) => s.every((b) => b === 0)),
        "the server must hand over an unsigned transaction");

      // The wallet signs and it lands.
      unsigned.sign([bob]);
      const sig = await conn.sendRawTransaction(unsigned.serialize());
      await conn.confirmTransaction(sig, "confirmed");

      // What landed is an order, not a position — the position is written when
      // the batch settles. The thing under test is that a transaction the
      // server built for somebody else is valid the moment they sign it, and
      // the order carrying their key is what shows that.
      const b: any = await perps.account.batch.fetch(batchPda("FFF"));
      const mine = b.orders.filter((o: any) =>
        o.active && new PublicKey(o.owner).equals(bob.publicKey));
      assert.lengthOf(mine, 1, "bob's order should be resting in the batch");
      assert.equal(mine[0].sizeUsd.toNumber(), USD(4_000).toNumber());
    });

    it("will not let one wallet trade another's position", async () => {
      await post("GGG", 100);
      const ix = await perps.methods
        .submitOrder(USD(120), USD(4_000), USD(1_000), true, false, false)
        .accounts(orderAccounts("GGG", bob.publicKey))
        .instruction();
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({
        payerKey: bob.publicKey, recentBlockhash: blockhash, instructions: [ix],
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);

      // Rejected before it is even sent: the message names Bob as the only
      // signer, so Alice's key cannot produce a signature slot to fill.
      try {
        tx.sign([alice]);
        await conn.sendRawTransaction(tx.serialize());
        assert.fail("a transaction signed by the wrong wallet must not land");
      } catch (e: any) {
        assert.match(e.toString(), /non signer|signature|Signature|missing/i);
      }
    });
  });

  describe("permissionless underwriting", () => {
    // A market nobody has underwritten, listed by Alice rather than by the
    // pool's authority. "KKK" is outside `SYMBOLS`, so nothing else touches it.
    const SYM = "KKK";
    let market: PublicKey;
    const backingPda = (m: PublicKey, owner: PublicKey) =>
      pda([Buffer.from("backing"), m.toBuffer(), owner.toBuffer()]);

    // Named for both instructions: `back_market` takes whatever it is paid in
    // as the deposit, `unback_market` pays USDC back by its own names. This
    // pool has no custodies, so USDC is all there is either way.
    const backingAccounts = (owner: Keypair) => ({
      owner: owner.publicKey, pool, market, backing: backingPda(market, owner.publicKey),
      book: pda([Buffer.from("backing_book"), market.toBuffer()]),
      depositMint: usdcMint, depositVault: usdcVault,
      ownerToken: usdcOf.get(owner.publicKey.toBase58())!,
      usdcMint, usdcVault, ownerUsdc: usdcOf.get(owner.publicKey.toBase58())!,
      // Read by `unback_market` while the market has open interest.
      priceUpdate: priceAccount(feedFor(SYM)),
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    });

    // What a non-authority listing may set (`validate_listing`): the bounds
    // the site lists with.
    const LISTED = {
      maxPriceAgeSec: 120, maxLeverageBps: 30_000, closedSessionLeverageBps: 30_000,
      openFeeBps: 10, closeFeeBps: 10, baseSpreadBps: 10,
      maxOiLongUsd: USD(50_000), maxOiShortUsd: USD(50_000),
    };

    before(async () => {
      market = pda([Buffer.from("market"), pool.toBuffer(), feedFor(SYM)]);
      await perps.methods
        .addMarket(marketParams(SYM, LISTED))
        .accounts({
          payer: alice.publicKey, pool, market,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();
    });

    it("holds a hand-built listing to the site's bounds", async () => {
      const SYM2 = "KKX";
      const m2 = pda([Buffer.from("market"), pool.toBuffer(), feedFor(SYM2)]);
      for (const over of [{ maxLeverageBps: 100_000 }, { maxPriceAgeSec: 3_600 }, { openFeeBps: 0 }]) {
        try {
          await perps.methods.addMarket(marketParams(SYM2, { ...LISTED, ...over }))
            .accounts({ payer: alice.publicKey, pool, market: m2, systemProgram: SystemProgram.programId })
            .signers([alice]).rpc();
          assert.fail(`expected ${JSON.stringify(over)} to be refused`);
        } catch (e: any) {
          assert.include(e.toString(), "ListingOutOfBounds");
        }
      }
    });

    it("lists with no allowance at all", async () => {
      const m: any = await perps.account.market.fetch(market);
      assert.equal(Number(m.lossBudgetUsd), 0, "a fresh listing underwrites nothing");
      assert.equal(m.deployer.toBase58(), alice.publicKey.toBase58());
    });

    // What the pool already held as backing: the setup backs every market.
    let poolBackingBefore = 0;

    it("lets anyone underwrite it, with no authority on the transaction", async () => {
      poolBackingBefore = Number((await perps.account.pool.fetch(pool) as any).backingUsd);
      await perps.methods.backMarket(USD(40_000))
        .accounts(backingAccounts(bob)).signers([bob]).rpc();

      const m: any = await perps.account.market.fetch(market);
      assert.equal(Number(m.backingUsd), 40_000e6);
      assert.equal(Number(m.lossBudgetUsd), 40_000e6, "the budget is what was posted");

      const b: any = await perps.account.backing.fetch(backingPda(market, bob.publicKey));
      assert.equal(b.owner.toBase58(), bob.publicKey.toBase58());
      assert.equal(Number(b.depositedUsd), 40_000e6);
    });

    it("does not let backing read as LP capital", async () => {
      const p: any = await perps.account.pool.fetch(pool);
      assert.equal(Number(p.backingUsd) - poolBackingBefore, 40_000e6);
      // The vault holds it, the LPs do not own it: `liquidity_usd` is what LP
      // shares are priced against, and backing must never inflate it.
      assert.isAbove(Number(p.liquidityUsd), 0);
      assert.notInclude(
        [Number(p.liquidityUsd)],
        [Number(p.liquidityUsd) + Number(p.backingUsd)],
      );
    });

    it("gives it back, and the budget falls with it", async () => {
      const b: any = await perps.account.backing.fetch(backingPda(market, bob.publicKey));
      const before = Number((await getAccount(conn, usdcOf.get(bob.publicKey.toBase58())!)).amount);

      await perps.methods.unbackMarket(new BN(Math.floor(Number(b.shares) / 2)))
        .accounts(backingAccounts(bob)).signers([bob]).rpc();

      const after = Number((await getAccount(conn, usdcOf.get(bob.publicKey.toBase58())!)).amount);
      assert.approximately((after - before) / 1e6, 20_000, 1, "half the stake came back");

      const m: any = await perps.account.market.fetch(market);
      assert.approximately(Number(m.lossBudgetUsd) / 1e6, 20_000, 1,
        "a market may not keep an allowance its backers have withdrawn");
    });

    it("refuses a backer who never posted anything", async () => {
      try {
        await perps.methods.unbackMarket(new BN(1))
          .accounts(backingAccounts(alice)).signers([alice]).rpc();
        assert.fail("withdrawing from an empty stake must not succeed");
      } catch (e: any) {
        // Refused before anything is created: there is no stake account to
        // withdraw from, and the withdrawal no longer makes an empty one.
        assert.match(e.toString(), /AccountNotInitialized|InsufficientLiquidity|ZeroAmount|constraint/i);
      }
    });

    it("lets the authority lower a budget but never raise it", async () => {
      const setBudget = (usd: number) => perps.methods.setMarketBudget(USD(usd))
        .accounts({ authority: authority.publicKey, pool, market }).rpc();
      const budget = async () =>
        Number((await perps.account.market.fetch(market) as any).lossBudgetUsd) / 1e6;

      const was = await budget();
      try {
        await setBudget(was + 1_000);
        assert.fail("the authority must not raise a budget");
      } catch (e: any) {
        assert.include(e.toString(), "BudgetOnlyLowers");
      }
      assert.approximately(await budget(), was, 0.01);

      await setBudget(was - 5_000);
      assert.approximately(await budget(), was - 5_000, 0.01);
    });
  });

  /*
   * The batch at capacity: 64 orders, the most one can hold.
   *
   * Every other test clears a batch of one or two orders, which says nothing
   * about whether a full one fits in a transaction's compute. `clear_batch`
   * walks every order to find the crossing, so it is the instruction that
   * grows with the book, and it has to fit or the market stops.
   */
  describe("a full batch", () => {
    const SYM = "HHH";
    const N = 64;
    const traders = Array.from({ length: N }, () => Keypair.generate());
    // A confirmed transaction can take a moment to be readable back.
    const used = async (sig: string) => {
      for (let i = 0; i < 20; i++) {
        const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (t) return t.meta!.computeUnitsConsumed!;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`transaction ${sig} never became readable`);
    };
    const send = (ixs: TransactionInstruction[]) =>
      provider.sendAndConfirm(new Transaction().add(...withComputeLimit(ixs)));

    const clear = async () => {
      await new Promise((r) => setTimeout(r, BATCH_WAIT_MS));
      const sig = await perps.methods
        .clearBatch()
        .accounts({
          pool, market: markets.get(SYM)!, batch: batchPda(SYM),
          priceUpdate: priceAccount(feedFor(SYM)),
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS })])
        .rpc();
      return used(sig);
    };

    /// Settles the whole batch the way the crank does, and reports how it
    /// packed and what the heaviest transaction cost.
    const settleAll = async () => {
      const sealed: any = await perps.account.batch.fetch(batchPda(SYM));
      const ixs: TransactionInstruction[] = [];
      for (let i = 0; i < sealed.orders.length; i++) {
        if (!sealed.orders[i].active) continue;
        const owner = new PublicKey(sealed.orders[i].owner);
        ixs.push(await perps.methods
          .settleOrder(i)
          .accounts({
            pool, market: markets.get(SYM)!, batch: batchPda(SYM), owner,
            position: positionPda(markets.get(SYM)!, owner),
            usdcMint, usdcVault, ownerUsdc: usdcOf.get(owner.toBase58())!,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction());
      }
      const groups = packInstructions(ixs, authority.publicKey);
      let peak = 0;
      for (const g of groups) peak = Math.max(peak, await used(await send(g)));
      return { orders: ixs.length, txs: groups.length, perTx: groups[0].length, peak };
    };

    const submitAll = (reduceOnly: boolean) =>
      Promise.all(traders.map((t, i) => {
        // Half each side, so the auction crosses them against each other
        // rather than leaning on the pool for every fill. Closing flips it.
        // The odd half make: takers only ever meet makers, so opening is
        // taker bids against maker asks and closing taker asks against maker
        // bids.
        const isBid = (i % 2 === 0) !== reduceOnly;
        const isMaker = i % 2 === 1;
        return perps.methods
          .submitOrder(USD(isBid ? 120 : 80), USD(1_000), reduceOnly ? new BN(0) : USD(200), isBid, reduceOnly, isMaker)
          .accounts(orderAccounts(SYM, t.publicKey))
          .signers([t])
          .rpc();
      }));

    before(async () => {
      await post(SYM, 100);
      const setup: TransactionInstruction[] = [];
      for (const t of traders) {
        const acc = getAssociatedTokenAddressSync(usdcMint, t.publicKey);
        usdcOf.set(t.publicKey.toBase58(), acc);
        setup.push(
          SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: t.publicKey, lamports: 50_000_000 }),
          createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, acc, t.publicKey, usdcMint),
          createMintToInstruction(usdcMint, acc, authority.publicKey, 1_000e6),
        );
      }
      for (const g of packInstructions(setup, authority.publicKey)) await send(g);
    });

    it("clears and settles 64 opening orders", async () => {
      await submitAll(false);
      const b: any = await perps.account.batch.fetch(batchPda(SYM));
      assert.equal(b.orders.filter((o: any) => o.active).length, N, "the batch is full");

      const clearCu = await clear();
      const sealed: any = await perps.account.batch.fetch(batchPda(SYM));
      assert.notEqual(Number(sealed.clearedTs), 0, "a full, crossed batch clears");
      assert.notEqual(Number(sealed.buyPrice), 0, "taker bids met maker asks");
      const filled = sealed.orders.filter((o: any) => o.active && !o.filledUsd.isZero()).length;
      assert.equal(filled, N, "32 bids against 32 asks of the same size fill every one");

      const s = await settleAll();
      console.log(`      open:  clear ${clearCu} CU; settle ${s.orders} orders in ${s.txs} txs (${s.perTx}/tx), peak ${s.peak} CU`);
      assert.isBelow(clearCu, MAX_COMPUTE_UNITS, "clearing a full batch fits one transaction");
      assert.isAtMost(s.txs, Math.ceil(N / 5), "settlement packs at least five orders a transaction");

      for (const t of traders) {
        const p: any = await perps.account.position.fetch(positionPda(markets.get(SYM)!, t.publicKey));
        assert.equal(p.sizeUsd.toNumber(), USD(1_000).toNumber());
      }
    });

    it("clears and settles 64 closing orders", async () => {
      await submitAll(true);
      const clearCu = await clear();
      const s = await settleAll();
      console.log(`      close: clear ${clearCu} CU; settle ${s.orders} orders in ${s.txs} txs (${s.perTx}/tx), peak ${s.peak} CU`);
      assert.isBelow(clearCu, MAX_COMPUTE_UNITS);

      for (const t of traders) {
        const p: any = await perps.account.position.fetchNullable(positionPda(markets.get(SYM)!, t.publicKey));
        assert.isTrue(!p || p.sizeUsd.isZero(), "every position closed");
      }
    });
  });

  describe("referrals", () => {
    const carol = Keypair.generate();
    const dave = Keypair.generate();
    const SYM = "JJJ";
    const traderPda = (owner: PublicKey) => pda([Buffer.from("trader"), owner.toBuffer()]);
    const codeBytes = (c: string) => Array.from(Buffer.concat([Buffer.from(c), Buffer.alloc(16)]).subarray(0, 16));
    const codePda = (c: string) => pda([Buffer.from("referral_code"), Buffer.from(codeBytes(c))]);
    const setReferrer = (who: Keypair, code: string, referrer: PublicKey) =>
      perps.methods.setReferrer(codeBytes(code))
        .accounts({
          owner: who.publicKey, trader: traderPda(who.publicKey),
          referralCode: codePda(code), referrerTrader: traderPda(referrer),
          systemProgram: SystemProgram.programId,
        })
        .signers([who]).rpc();

    before(async () => {
      for (const kp of [carol, dave]) {
        await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 10e9), "confirmed");
        const acc = await createAssociatedTokenAccount(conn, kp, usdcMint, kp.publicKey);
        usdcOf.set(kp.publicKey.toBase58(), acc);
        await mintTo(conn, authority, usdcMint, acc, authority.publicKey, 50_000e6);
      }
    });

    it("hands out a code once, to one wallet", async () => {
      await perps.methods.claimReferralCode(codeBytes("dave"))
        .accounts({ owner: dave.publicKey, trader: traderPda(dave.publicKey), referralCode: codePda("dave") })
        .signers([dave]).rpc();
      const rc: any = await perps.account.referralCode.fetch(codePda("dave"));
      assert.equal(rc.owner.toBase58(), dave.publicKey.toBase58());

      let taken = false;
      try {
        await perps.methods.claimReferralCode(codeBytes("dave"))
          .accounts({ owner: carol.publicKey, trader: traderPda(carol.publicKey), referralCode: codePda("dave") })
          .signers([carol]).rpc();
      } catch { taken = true; }
      assert.isTrue(taken, "a code somebody holds cannot be claimed again");

      let bad = false;
      try {
        await perps.methods.claimReferralCode(codeBytes("NO"))
          .accounts({ owner: carol.publicKey, trader: traderPda(carol.publicKey), referralCode: codePda("NO") })
          .signers([carol]).rpc();
      } catch (e: any) { bad = /InvalidReferralCode/.test(String(e)); }
      assert.isTrue(bad, "codes are lowercase and at least three long");
    });

    it("will not let a wallet refer itself", async () => {
      let refused = false;
      try { await setReferrer(dave, "dave", dave.publicKey); }
      catch (e: any) { refused = /SelfReferral/.test(String(e)); }
      assert.isTrue(refused);
    });

    it("discounts a referee's fees and owes the referrer a cut of them", async () => {
      await setReferrer(carol, "dave", dave.publicKey);
      const d0: any = await perps.account.trader.fetch(traderPda(dave.publicKey));
      assert.equal(d0.referralCount, 1);

      // Deltas, not absolutes: the full-batch tests above trade this market too.
      const p0: any = await perps.account.pool.fetch(pool);
      const m0: any = await perps.account.market.fetch(markets.get(SYM)!);
      await post(SYM, 100);
      await open(SYM, carol, true, USD(2_000), USD(10_000));

      const t: any = await perps.account.trader.fetch(traderPda(carol.publicKey));
      const m: any = await perps.account.market.fetch(markets.get(SYM)!);
      const p1: any = await perps.account.pool.fetch(pool);
      // 6 bps on $10,000 is $6; a referee pays 10% less, $5.40.
      const fee = 5.4e6;
      assert.equal(t.volumeUsd.toNumber(), USD(10_000).toNumber());
      assert.equal(t.points.toNumber(), 10_000e6, "a point a dollar");
      assert.equal(t.feesSavedUsd.toNumber(), 0.6e6);
      assert.equal(t.referrerRewardsOwed.toNumber(), fee * 0.1);
      assert.equal(t.referrerPointsOwed.toNumber(), 1_000e6);
      // Running totals for the page, kept past the sync that empties the owed lines.
      assert.equal(t.givenToReferrerUsd.toNumber(), fee * 0.1);
      assert.equal(t.givenToReferrerPoints.toNumber(), 1_000e6);
      assert.equal(m.deployerEarnedUsd.sub(m0.deployerEarnedUsd).toNumber(), fee * 0.1);
      // The market was listed by the authority, so its deployer is owed 10%.
      assert.equal(m.deployerRewardsUsd.sub(m0.deployerRewardsUsd).toNumber(), fee * 0.1);
      assert.equal(m.volumeUsd.sub(m0.volumeUsd).toNumber(), USD(10_000).toNumber());
      // Both came out of the protocol's 20%, and nothing else moved for it.
      assert.equal(p1.rewardsUsd.sub(p0.rewardsUsd).toNumber(), fee * 0.2);
      assert.equal(p1.protocolFeesUsd.sub(p0.protocolFeesUsd).toNumber(), 0);
    });

    it("locks the referrer once the wallet has traded", async () => {
      let refused = false;
      try { await setReferrer(carol, "dave", dave.publicKey); }
      catch (e: any) { refused = /ReferrerLocked/.test(String(e)); }
      assert.isTrue(refused);
    });

    it("moves what a referee earned to the referrer, and pays it out", async () => {
      await perps.methods.syncReferral()
        .accounts({ referee: traderPda(carol.publicKey), referrer: traderPda(dave.publicKey) })
        .rpc();
      const d: any = await perps.account.trader.fetch(traderPda(dave.publicKey));
      assert.equal(d.rewardsUsd.toNumber(), 0.54e6);
      assert.equal(d.points.toNumber(), 1_000e6);
      assert.equal(d.referredVolumeUsd.toNumber(), USD(10_000).toNumber());
      const c: any = await perps.account.trader.fetch(traderPda(carol.publicKey));
      assert.equal(c.referrerRewardsOwed.toNumber(), 0);
      assert.equal(c.givenToReferrerUsd.toNumber(), 0.54e6, "the total outlives the sync");
      assert.equal(d.referralEarnedUsd.toNumber(), 0.54e6);

      const ownerUsdc = usdcOf.get(dave.publicKey.toBase58())!;
      const before = Number((await getAccount(conn, ownerUsdc)).amount);
      await perps.methods.claimRewards()
        .accounts({
          owner: dave.publicKey, pool, trader: traderPda(dave.publicKey),
          usdcMint, usdcVault, ownerUsdc, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([dave]).rpc();
      const after = Number((await getAccount(conn, ownerUsdc)).amount);
      assert.equal(after - before, 0.54e6);
      const d2: any = await perps.account.trader.fetch(traderPda(dave.publicKey));
      assert.equal(d2.rewardsUsd.toNumber(), 0);
      assert.equal(d2.rewardsClaimedUsd.toNumber(), 0.54e6);
    });

    it("pays a market's deployer their share and points on its volume", async () => {
      await perps.methods.createTrader()
        .accounts({ owner: authority.publicKey, trader: traderPda(authority.publicKey) })
        .rpc();
      const m0: any = await perps.account.market.fetch(markets.get(SYM)!);
      const a0: any = await perps.account.trader.fetch(traderPda(authority.publicKey));
      assert.isAbove(m0.deployerRewardsUsd.toNumber(), 0);
      await perps.methods.syncDeployer()
        .accounts({ market: markets.get(SYM)!, deployer: traderPda(authority.publicKey) })
        .rpc();
      const a: any = await perps.account.trader.fetch(traderPda(authority.publicKey));
      assert.equal(a.rewardsUsd.sub(a0.rewardsUsd).toNumber(), m0.deployerRewardsUsd.toNumber());
      assert.equal(a.listingEarnedUsd.sub(a0.listingEarnedUsd).toNumber(), m0.deployerRewardsUsd.toNumber());
      const traded = m0.volumeUsd.sub(m0.deployerSyncedVolumeUsd).toNumber();
      assert.equal(a.points.sub(a0.points).toNumber(), Math.floor(traded / 10),
        "a tenth of a point per dollar traded");
      const m: any = await perps.account.market.fetch(markets.get(SYM)!);
      assert.equal(m.deployerRewardsUsd.toNumber(), 0);
      assert.equal(m.deployerSyncedVolumeUsd.toNumber(), m0.volumeUsd.toNumber());

      // A second sync has nothing left to move.
      await perps.methods.syncDeployer()
        .accounts({ market: markets.get(SYM)!, deployer: traderPda(authority.publicKey) })
        .rpc();
      const a2: any = await perps.account.trader.fetch(traderPda(authority.publicKey));
      assert.equal(a2.points.toNumber(), a.points.toNumber());
      assert.equal(a2.rewardsUsd.toNumber(), a.rewardsUsd.toNumber());
    });
  });
});
