/// Integration tests for instructions the other suites never send: the
/// authority hand-over, pausing a pool, collecting fees, the funding crank,
/// cancelling an LP withdrawal, account resizing, points, and backing held
/// in another token from deposit to the LPs' in-kind claim.
///
/// Each `describe` lists its own pool on its own USDC mint, so nothing here
/// depends on what `unwind.ts` or `system.ts` left behind.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createAssociatedTokenAccount, createMint, getAccount,
  getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { marketGenerationsPda, marketPda } from "../scripts/market-address";

const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const USD = (n: number) => new BN(Math.round(n * 1e6));
const EXP = -8;
const BATCH_WAIT_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pricePoster(fallback: Keypair): Keypair {
  const file = process.env.RELAY_KEYPAIR ?? path.join(os.homedir(), ".config/unwind/relay.json");
  if (!fs.existsSync(file)) return fallback;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

/// Asserts `f` fails with an error naming `code`.
async function refuses(f: () => Promise<unknown>, code: RegExp | string) {
  try {
    await f();
  } catch (e: any) {
    const text = `${e}\n${(e?.logs ?? []).join("\n")}`;
    assert.match(text, typeof code === "string" ? new RegExp(code) : code);
    return;
  }
  assert.fail(`expected a refusal matching ${code}`);
}

/// One pool on a fresh USDC mint with one Pyth market, and the helpers to
/// trade on it. `custodies` stable tokens are added before anything else.
function venue(sym: string) {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const perps = anchor.workspace.Unwind as Program<any>;
  const pyth = anchor.workspace.MockPyth as Program<any>;
  const conn = provider.connection;
  const authority = (provider.wallet as anchor.Wallet).payer;
  const poster = pricePoster(authority);
  const feed = createHash("sha256").update(`test-feed:cov-${sym}`).digest().subarray(0, 32);

  const v = {
    provider, perps, pyth, conn, authority, poster, feed,
    usdcMint: PublicKey.default, pool: PublicKey.default, usdcVault: PublicKey.default,
    lpMint: PublicKey.default, market: PublicKey.default,
    /// `(custody, price)` pairs every liquidity and backing instruction needs.
    custodies: [] as { custody: PublicKey; mint: PublicKey; vault: PublicKey }[],
    lastTs: 0,
    lastPrice: 100,

    pda(seeds: (Buffer | Uint8Array)[], p = perps.programId) {
      return PublicKey.findProgramAddressSync(seeds, p)[0];
    },
    get oracle() { return v.pda([Buffer.from("price"), feed], pyth.programId); },
    get batch() { return v.pda([Buffer.from("batch"), v.market.toBuffer()]); },
    position(owner: PublicKey) {
      return v.pda([Buffer.from("position"), v.market.toBuffer(), owner.toBuffer()]);
    },
    trader(owner: PublicKey) { return v.pda([Buffer.from("trader"), owner.toBuffer()]); },
    backing(owner: PublicKey) {
      return v.pda([Buffer.from("backing"), v.market.toBuffer(), owner.toBuffer()]);
    },
    get book() { return v.pda([Buffer.from("backing_book"), v.market.toBuffer()]); },
    custodyPairs(writable = false) {
      return v.custodies.flatMap((c) => [
        { pubkey: c.custody, isWritable: writable, isSigner: false },
        // A stable custody's price account is not read.
        { pubkey: v.oracle, isWritable: false, isSigner: false },
      ]);
    },

    async post(price: number) {
      v.lastPrice = price;
      let ts = Math.floor(Date.now() / 1000);
      if (ts <= v.lastTs) {
        await sleep((v.lastTs + 1) * 1000 - Date.now() + 50);
        ts = v.lastTs + 1;
      }
      v.lastTs = ts;
      await pyth.methods
        .postPrice({
          feedId: Array.from(feed),
          price: new BN(Math.round(price * 10 ** -EXP)),
          conf: new BN(Math.round(price * 0.0001 * 10 ** -EXP)),
          exponent: EXP,
          publishTime: new BN(ts),
          fullyVerified: true,
        })
        .accounts({ payer: poster.publicKey, priceUpdate: v.oracle, systemProgram: SystemProgram.programId })
        .signers([poster])
        .rpc();
    },

    async fund(kp: Keypair, usdc: number) {
      await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 20e9), "confirmed");
      const acc = (await getOrCreateAssociatedTokenAccount(conn, authority, v.usdcMint, kp.publicKey)).address;
      if (usdc > 0) await mintTo(conn, authority, v.usdcMint, acc, authority, usdc * 1e6);
      return acc;
    },

    /// Takes the AUM checkpoint deposits and withdrawals price from.
    async checkpoint(payer: Keypair) {
      const m: any = await perps.account.market.fetch(v.market);
      const open = !m.longSizeUsd.isZero() || !m.shortSizeUsd.isZero();
      await perps.methods.checkpointAum(true)
        .accounts({ payer: payer.publicKey, pool: v.pool })
        .remainingAccounts(open ? [
          { pubkey: v.market, isWritable: false, isSigner: false },
          { pubkey: v.oracle, isWritable: false, isSigner: false },
        ] : [])
        .signers([payer])
        .rpc();
    },

    async addLiquidity(lp: Keypair, lpUsdc: PublicKey, lpLp: PublicKey, amount: number) {
      await v.checkpoint(lp);
      await perps.methods.addLiquidity(USD(amount), new BN(0))
        .accounts({
          owner: lp.publicKey, pool: v.pool, usdcMint: v.usdcMint, usdcVault: v.usdcVault,
          lpMint: v.lpMint, ownerUsdc: lpUsdc, ownerLp: lpLp, tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(v.custodyPairs())
        .signers([lp])
        .rpc();
    },

    async backUsdc(who: Keypair, whoUsdc: PublicKey, amount: number) {
      await perps.methods.backMarket(USD(amount))
        .accounts({
          owner: who.publicKey, pool: v.pool, market: v.market,
          backing: v.backing(who.publicKey), book: v.book,
          depositMint: v.usdcMint, depositVault: v.usdcVault, ownerToken: whoUsdc,
          tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(v.custodyPairs(true))
        .signers([who])
        .rpc();
    },

    orderAccounts(owner: PublicKey, ownerUsdc: PublicKey) {
      return {
        owner, pool: v.pool, market: v.market, batch: v.batch,
        usdcMint: v.usdcMint, usdcVault: v.usdcVault, ownerUsdc,
        position: v.position(owner),
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      };
    },

    /// Seals the batch and settles everything in it.
    async runBatch(usdcOf: (owner: PublicKey) => PublicKey) {
      await sleep(BATCH_WAIT_MS);
      await v.post(v.lastPrice);
      await perps.methods.clearBatch()
        .accounts({ pool: v.pool, market: v.market, batch: v.batch, priceUpdate: v.oracle })
        .rpc();
      const sealed: any = await perps.account.batch.fetch(v.batch);
      if (Number(sealed.clearedTs) === 0) return;
      for (let i = 0; i < sealed.orders.length; i++) {
        if (!sealed.orders[i].active) continue;
        const owner = new PublicKey(sealed.orders[i].owner);
        await perps.methods.settleOrder(i)
          .accounts({
            pool: v.pool, market: v.market, batch: v.batch, owner,
            position: v.position(owner), usdcMint: v.usdcMint, usdcVault: v.usdcVault,
            ownerUsdc: usdcOf(owner), tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
      }
    },

    async open(who: Keypair, whoUsdc: PublicKey, isLong: boolean, collateral: number, size: number) {
      const limit = USD(v.lastPrice * (isLong ? 1.2 : 0.8));
      await perps.methods.submitOrder(limit, USD(size), USD(collateral), isLong, false, false)
        .accounts(v.orderAccounts(who.publicKey, whoUsdc))
        .signers([who])
        .rpc();
      await v.runBatch(() => whoUsdc);
    },

    async close(who: Keypair, whoUsdc: PublicKey) {
      const pos: any = await perps.account.position.fetch(v.position(who.publicKey));
      const isBid = !pos.isLong;
      const limit = USD(v.lastPrice * (isBid ? 1.2 : 0.8));
      await perps.methods.submitOrder(limit, pos.sizeUsd.sub(pos.closingUsd), new BN(0), isBid, true, false)
        .accounts(v.orderAccounts(who.publicKey, whoUsdc))
        .signers([who])
        .rpc();
      await v.runBatch(() => whoUsdc);
    },

    /// Lists the pool and the market, with a batch and no backing.
    async setUp(addCustodies: () => Promise<void> = async () => {}) {
      await conn.confirmTransaction(await conn.requestAirdrop(poster.publicKey, 10e9), "confirmed");
      v.usdcMint = await createMint(conn, authority, authority.publicKey, null, 6);
      v.pool = v.pda([Buffer.from("pool"), v.usdcMint.toBuffer()]);
      v.usdcVault = v.pda([Buffer.from("pool_vault"), v.pool.toBuffer()]);
      v.lpMint = v.pda([Buffer.from("lp_mint"), v.pool.toBuffer()]);
      await perps.methods
        .initializePool({
          chainFeeDestination: authority.publicKey, pythReceiver: pyth.programId,
          addLiquidityFeeBps: 0, removeLiquidityFeeBps: 0,
          protocolFeeShareBps: 2000, insuranceFeeShareBps: 1000, maxUtilizationBps: 8000,
        })
        .accounts({
          authority: authority.publicKey, pool: v.pool, usdcMint: v.usdcMint, usdcVault: v.usdcVault,
          lpMint: v.lpMint, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
          programData: PublicKey.findProgramAddressSync([perps.programId.toBuffer()], BPF_LOADER_UPGRADEABLE)[0],
        })
        .rpc();
      await addCustodies();
      await v.post(100);
      v.market = marketPda(perps.programId, v.pool, feed, 1);
      await perps.methods
        .addMarket({
          symbol: Array.from(Buffer.concat([Buffer.from(sym), Buffer.alloc(16)]).subarray(0, 16)),
          feedId: Array.from(feed),
          maxPriceAgeSec: 3600, maxConfBps: 500,
          maxLeverageBps: 100_000, maintenanceMarginBps: 500,
          liquidationFeeBps: 100, openFeeBps: 10, closeFeeBps: 10,
          minPositionUsd: USD(10), maxOiLongUsd: USD(5_000_000), maxOiShortUsd: USD(5_000_000),
          pnlReserveBps: 10_000, baseSpreadBps: 4, confSpreadMultBps: 10_000, maxSpreadBps: 500,
          closedSessionLeverageBps: 20_000, closedSessionOiMultBps: 2_500,
          maxFundingRateBpsPerHour: 100, fundingKBps: 10_000, borrowRateBpsPerHour: 1,
          priceSource: 0, observation: PublicKey.default,
        }, 1)
        .accounts({
          payer: authority.publicKey, pool: v.pool,
          generations: marketGenerationsPda(perps.programId, v.pool, feed), market: v.market,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      await perps.methods.createBatch()
        .accounts({ payer: authority.publicKey, pool: v.pool, market: v.market, batch: v.batch, systemProgram: SystemProgram.programId })
        .rpc();
    },
  };
  return v;
}

describe("coverage: pool administration and cranks", () => {
  const v = venue("ADM");
  const lp = Keypair.generate();
  const trader = Keypair.generate();
  const stranger = Keypair.generate();
  let lpUsdc: PublicKey, lpLp: PublicKey, traderUsdc: PublicKey, authorityUsdc: PublicKey;

  before(async () => {
    await v.setUp();
    lpUsdc = await v.fund(lp, 1_000_000);
    lpLp = await createAssociatedTokenAccount(v.conn, lp, v.lpMint, lp.publicKey);
    traderUsdc = await v.fund(trader, 100_000);
    await v.fund(stranger, 0);
    authorityUsdc = await v.fund(v.authority, 1_000_000);
    await v.backUsdc(v.authority, authorityUsdc, 100_000);
    await v.addLiquidity(lp, lpUsdc, lpLp, 500_000);
  });

  const updatePool = (who: Keypair) => ({ authority: who.publicKey, pool: v.pool });

  it("hands the pool to a nominee only when the nominee accepts", async () => {
    // Only the authority may nominate.
    await refuses(() => v.perps.methods.nominateAuthority(stranger.publicKey)
      .accounts(updatePool(stranger)).signers([stranger]).rpc(), "Unauthorized");
    const next = Keypair.generate();
    await v.conn.confirmTransaction(await v.conn.requestAirdrop(next.publicKey, 1e9), "confirmed");
    await v.perps.methods.nominateAuthority(next.publicKey).accounts(updatePool(v.authority)).rpc();
    let p: any = await v.perps.account.pool.fetch(v.pool);
    assert.isTrue(p.authority.equals(v.authority.publicKey), "nominating changes nothing yet");
    assert.isTrue(p.pendingAuthority.equals(next.publicKey));

    // Nobody but the nominee can accept.
    await refuses(() => v.perps.methods.acceptAuthority()
      .accounts({ newAuthority: stranger.publicKey, pool: v.pool }).signers([stranger]).rpc(), "Unauthorized");
    await v.perps.methods.acceptAuthority()
      .accounts({ newAuthority: next.publicKey, pool: v.pool }).signers([next]).rpc();
    p = await v.perps.account.pool.fetch(v.pool);
    assert.isTrue(p.authority.equals(next.publicKey));
    assert.isTrue(p.pendingAuthority.equals(PublicKey.default), "the nomination is spent");

    // The old authority has nothing left.
    await refuses(() => v.perps.methods.setPoolPaused(true).accounts(updatePool(v.authority)).rpc(), "Unauthorized");
    // A spent nomination cannot be accepted twice.
    await refuses(() => v.perps.methods.acceptAuthority()
      .accounts({ newAuthority: next.publicKey, pool: v.pool }).signers([next]).rpc(), "Unauthorized");

    // Hand it back for the rest of the suite.
    await v.perps.methods.nominateAuthority(v.authority.publicKey).accounts(updatePool(next)).signers([next]).rpc();
    await v.perps.methods.acceptAuthority().accounts({ newAuthority: v.authority.publicKey, pool: v.pool }).rpc();
  });

  it("refuses deposits and backing while the pool is paused", async () => {
    await refuses(() => v.perps.methods.setPoolPaused(true).accounts(updatePool(stranger)).signers([stranger]).rpc(), "Unauthorized");
    await v.perps.methods.setPoolPaused(true).accounts(updatePool(v.authority)).rpc();
    await refuses(() => v.addLiquidity(lp, lpUsdc, lpLp, 1_000), "PoolPaused");
    await refuses(() => v.backUsdc(v.authority, authorityUsdc, 1_000), "PoolPaused");
    await v.perps.methods.setPoolPaused(false).accounts(updatePool(v.authority)).rpc();
    await v.addLiquidity(lp, lpUsdc, lpLp, 1_000);
  });

  it("lets only the upgrade authority switch a pool's points", async () => {
    const programData = PublicKey.findProgramAddressSync([v.perps.programId.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];
    await refuses(() => v.perps.methods.setPoolPoints(false)
      .accounts({ upgradeAuthority: stranger.publicKey, pool: v.pool, programData })
      .signers([stranger]).rpc(), /Unauthorized|NotPoolCreator|Error/);
    await v.perps.methods.setPoolPoints(false)
      .accounts({ upgradeAuthority: v.authority.publicKey, pool: v.pool, programData }).rpc();
    assert.isTrue((await v.perps.account.pool.fetch(v.pool) as any).noPoints);
    await v.perps.methods.setPoolPoints(true)
      .accounts({ upgradeAuthority: v.authority.publicKey, pool: v.pool, programData }).rpc();
    assert.isFalse((await v.perps.account.pool.fetch(v.pool) as any).noPoints);
  });

  it("collects protocol and chain fees once trades have paid them, and no more", async () => {
    await v.open(trader, traderUsdc, true, 10_000, 50_000);
    const p: any = await v.perps.account.pool.fetch(v.pool);
    const protocol = Number(p.protocolFeesUsd);
    const chain = Number(p.chainFeesUsd);
    assert.isAbove(protocol, 0, "the open paid a protocol fee");
    assert.isAbove(chain, 0, "and a chain fee");

    const fees = (who: Keypair, amount: BN) => v.perps.methods.collectProtocolFees(amount)
      .accounts({
        authority: who.publicKey, pool: v.pool, usdcMint: v.usdcMint, usdcVault: v.usdcVault,
        destination: authorityUsdc, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers(who === v.authority ? [] : [who])
      .rpc();
    await refuses(() => fees(stranger, new BN(1)), "Unauthorized");
    await refuses(() => fees(v.authority, new BN(protocol + 1)), "InsufficientLiquidity");
    const before = (await getAccount(v.conn, authorityUsdc)).amount;
    await fees(v.authority, new BN(1));
    // Zero means everything left.
    await fees(v.authority, new BN(0));
    const after = (await getAccount(v.conn, authorityUsdc)).amount;
    assert.equal(Number(after - before), protocol);
    assert.equal(Number((await v.perps.account.pool.fetch(v.pool) as any).protocolFeesUsd), 0);
    await refuses(() => fees(v.authority, new BN(0)), "ZeroAmount");

    // Chain fees go only to the destination the pool was created with.
    const strangerUsdc = await v.fund(stranger, 0);
    const chainFees = (to: PublicKey) => v.perps.methods.collectChainFees()
      .accounts({
        pool: v.pool, usdcMint: v.usdcMint, usdcVault: v.usdcVault,
        destinationUsdc: to, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    await refuses(() => chainFees(strangerUsdc), "Unauthorized");
    const b2 = (await getAccount(v.conn, authorityUsdc)).amount;
    await chainFees(authorityUsdc);
    assert.equal(Number((await getAccount(v.conn, authorityUsdc)).amount - b2), chain);
    await refuses(() => chainFees(authorityUsdc), "ZeroAmount");
  });

  it("accrues funding on the crank, for anyone", async () => {
    const before: any = await v.perps.account.market.fetch(v.market);
    await sleep(2_000);
    // No signer at all: the wallet only pays the fee.
    await v.perps.methods.accrueFunding().accounts({ pool: v.pool, market: v.market }).rpc();
    const after: any = await v.perps.account.market.fetch(v.market);
    assert.isAbove(Number(after.lastFundingTs), Number(before.lastFundingTs), "the clock moves on");
    // A long-only book at 10% utilization owes whole bps an hour of nothing
    // yet; the index never runs backwards for the side that pays.
    assert.isTrue(after.cumulativeLongFunding.gte(before.cumulativeLongFunding));
    await v.close(trader, traderUsdc);
  });

  it("refuses to crank funding for a market of another pool", async () => {
    const other = venue("ADX");
    await other.setUp();
    await refuses(() => v.perps.methods.accrueFunding().accounts({ pool: v.pool, market: other.market }).rpc(),
      "MarketPoolMismatch");
  });

  it("gives an LP's escrowed shares back when the withdrawal is cancelled", async () => {
    const held = (await getAccount(v.conn, lpLp)).amount;
    const request = v.pda([Buffer.from("withdraw_request"), v.pool.toBuffer(), lp.publicKey.toBuffer()]);
    const escrowLp = v.pda([Buffer.from("withdraw_escrow"), request.toBuffer()]);
    const accounts = {
      owner: lp.publicKey, pool: v.pool, lpMint: v.lpMint, ownerLp: lpLp,
      request, escrowLp, trader: v.trader(lp.publicKey), tokenProgram: TOKEN_PROGRAM_ID,
    } as any;
    await refuses(() => v.perps.methods.requestWithdraw(new BN(0)).accounts(accounts).signers([lp]).rpc(), "ZeroAmount");
    const part = held / 4n;
    await v.perps.methods.requestWithdraw(new BN(part.toString())).accounts(accounts).signers([lp]).rpc();
    // A second request adds to the first.
    await v.perps.methods.requestWithdraw(new BN(part.toString())).accounts(accounts).signers([lp]).rpc();
    const r: any = await v.perps.account.withdrawRequest.fetch(request);
    assert.equal(r.shares.toString(), (2n * part).toString());
    assert.equal((await getAccount(v.conn, lpLp)).amount, held - 2n * part);

    // Nobody else can cancel it: the request is at the owner's address.
    await refuses(() => v.perps.methods.cancelWithdraw()
      .accounts({ ...accounts, owner: stranger.publicKey }).signers([stranger]).rpc(), /ConstraintSeeds|ConstraintHasOne|Error/);

    await v.perps.methods.cancelWithdraw().accounts(accounts).signers([lp]).rpc();
    assert.equal((await getAccount(v.conn, lpLp)).amount, held, "every share back");
    assert.isNull(await v.perps.account.withdrawRequest.fetchNullable(request), "the request closed");
    assert.isNull(await v.conn.getAccountInfo(escrowLp), "and its escrow");
  });

  it("brings a wallet's points up to date, signed by the wallet alone", async () => {
    const t0: any = await v.perps.account.trader.fetch(v.trader(lp.publicKey));
    await sleep(1_500);
    await v.perps.methods.accruePoints()
      .accounts({ owner: lp.publicKey, trader: v.trader(lp.publicKey), pool: v.pool, ownerLp: lpLp })
      .signers([lp])
      .rpc();
    const t1: any = await v.perps.account.trader.fetch(v.trader(lp.publicKey));
    assert.isTrue(t1.points.gte(t0.points), "points never fall");
    assert.isAbove(Number(t1.lpTs), Number(t0.lpTs), "the LP stake is brought to now");
    // Another wallet's LP balance cannot be shown for it.
    const strangerLp = await createAssociatedTokenAccount(v.conn, stranger, v.lpMint, stranger.publicKey);
    await refuses(() => v.perps.methods.accruePoints()
      .accounts({ owner: lp.publicKey, trader: v.trader(lp.publicKey), pool: v.pool, ownerLp: strangerLp })
      .signers([lp]).rpc(), /ConstraintRaw|Error/);
  });

  it("leaves an account already at its size alone, and refuses one of another type", async () => {
    const before = (await v.conn.getAccountInfo(v.market))!.data.length;
    await v.perps.methods.resizeMarket()
      .accounts({ payer: v.authority.publicKey, market: v.market, systemProgram: SystemProgram.programId }).rpc();
    assert.equal((await v.conn.getAccountInfo(v.market))!.data.length, before);
    await v.perps.methods.resizePool()
      .accounts({ payer: v.authority.publicKey, pool: v.pool, systemProgram: SystemProgram.programId }).rpc();
    // A pool is not a market.
    await refuses(() => v.perps.methods.resizeMarket()
      .accounts({ payer: v.authority.publicKey, market: v.pool, systemProgram: SystemProgram.programId }).rpc(),
      "InvalidParameter");
    await refuses(() => v.perps.methods.resizeTrader()
      .accounts({ payer: v.authority.publicKey, trader: v.market, systemProgram: SystemProgram.programId }).rpc(),
      "InvalidParameter");
  });
});

describe("coverage: backing held in another token", () => {
  const v = venue("KND");
  const lp = Keypair.generate();
  const trader = Keypair.generate();
  const backer = Keypair.generate();
  const stranger = Keypair.generate();
  let usdt: PublicKey, custody: PublicKey, custodyVault: PublicKey;
  let lpUsdc: PublicKey, lpLp: PublicKey, traderUsdc: PublicKey, backerUsdc: PublicKey, backerUsdt: PublicKey;

  const custodyArgs = (over: any = {}) => ({
    isStable: true, feedId: Array(32).fill(0), maxPriceAgeSec: 0, maxConfBps: 0, budgetWeightBps: 10_000, ...over,
  });
  const addCustody = (mint: PublicKey, args: any, who = v.authority) => {
    const c = v.pda([Buffer.from("custody"), v.pool.toBuffer(), mint.toBuffer()]);
    return v.perps.methods.addCustody(args)
      .accounts({
        authority: who.publicKey, pool: v.pool, mint, custody: c,
        vault: v.pda([Buffer.from("custody_vault"), c.toBuffer()]),
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers(who === v.authority ? [] : [who])
      .rpc();
  };

  const backInKind = (amount: number, pairs = v.custodyPairs(true), vault = custodyVault, mint = usdt, from = backerUsdt) =>
    v.perps.methods.backMarket(new BN(amount * 1e6))
      .accounts({
        owner: backer.publicKey, pool: v.pool, market: v.market,
        backing: v.backing(backer.publicKey), book: v.book,
        depositMint: mint, depositVault: vault, ownerToken: from,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(pairs)
      .signers([backer])
      .rpc();

  const sync = () => v.perps.methods.syncBacking()
    .accounts({ pool: v.pool, market: v.market, book: v.book })
    .remainingAccounts(v.custodyPairs(true))
    .rpc();

  before(async () => {
    await v.conn.confirmTransaction(await v.conn.requestAirdrop(stranger.publicKey, 2e9), "confirmed");
    await v.setUp(async () => {
      usdt = await createMint(v.conn, v.authority, v.authority.publicKey, null, 6);
      // The authority alone adds custodies, never the pool's own USDC, and
      // never one that counts for more than its value or prices without limits.
      await refuses(() => addCustody(usdt, custodyArgs(), stranger), "Unauthorized");
      await refuses(() => addCustody(v.usdcMint, custodyArgs()), "InvalidParameter");
      await refuses(() => addCustody(usdt, custodyArgs({ budgetWeightBps: 10_001 })), "InvalidParameter");
      await refuses(() => addCustody(usdt, custodyArgs({ isStable: false })), "InvalidParameter");
      await addCustody(usdt, custodyArgs());
      custody = v.pda([Buffer.from("custody"), v.pool.toBuffer(), usdt.toBuffer()]);
      custodyVault = v.pda([Buffer.from("custody_vault"), custody.toBuffer()]);
      v.custodies.push({ custody, mint: usdt, vault: custodyVault });
      // One custody per mint.
      await refuses(() => addCustody(usdt, custodyArgs()), /already in use|Error/);
    });
    lpUsdc = await v.fund(lp, 1_000_000);
    lpLp = await createAssociatedTokenAccount(v.conn, lp, v.lpMint, lp.publicKey);
    traderUsdc = await v.fund(trader, 100_000);
    backerUsdc = await v.fund(backer, 0);
    backerUsdt = (await getOrCreateAssociatedTokenAccount(v.conn, v.authority, usdt, backer.publicKey)).address;
    await mintTo(v.conn, v.authority, usdt, backerUsdt, v.authority, 100_000e6);
    await v.addLiquidity(lp, lpUsdc, lpLp, 500_000);
  });

  it("records the custody with its terms and an index", async () => {
    const c: any = await v.perps.account.custody.fetch(custody);
    assert.equal(c.index, 0);
    assert.isTrue(c.isStable);
    assert.equal(c.budgetWeightBps, 10_000);
    assert.isTrue(c.vault.equals(custodyVault));
    assert.equal((await v.perps.account.pool.fetch(v.pool) as any).numCustodies, 1);
  });

  it("refuses a deposit or backing that leaves a custody out", async () => {
    await refuses(() => v.perps.methods.addLiquidity(USD(1_000), new BN(0))
      .accounts({
        owner: lp.publicKey, pool: v.pool, usdcMint: v.usdcMint, usdcVault: v.usdcVault,
        lpMint: v.lpMint, ownerUsdc: lpUsdc, ownerLp: lpLp, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([])
      .signers([lp]).rpc(), "IncompleteCustodyList");
    await refuses(() => backInKind(1_000, []), "IncompleteCustodyList");
  });

  it("refuses backing in a token the pool holds no custody of, or into the wrong vault", async () => {
    const other = await createMint(v.conn, v.authority, v.authority.publicKey, null, 6);
    const otherAcc = (await getOrCreateAssociatedTokenAccount(v.conn, v.authority, other, backer.publicKey)).address;
    await mintTo(v.conn, v.authority, other, otherAcc, v.authority, 1_000e6);
    // Its own account stands in as the vault: the mint matches, the custody does not exist.
    await refuses(() => backInKind(100, v.custodyPairs(true), otherAcc, other, otherAcc), "UnknownCustody");
    // The right mint into a vault that is not the custody's.
    const stray = (await getOrCreateAssociatedTokenAccount(v.conn, v.authority, usdt, stranger.publicKey)).address;
    await refuses(() => backInKind(100, v.custodyPairs(true), stray), "InvalidParameter");
  });

  it("takes backing in kind and raises the budget by its weighted value", async () => {
    await backInKind(20_000);
    const book: any = await v.perps.account.backingBook.fetch(v.book);
    assert.equal(book.amounts[0].toString(), USD(20_000).toString());
    const c: any = await v.perps.account.custody.fetch(custody);
    assert.equal(c.backingAmount.toString(), USD(20_000).toString());
    const m: any = await v.perps.account.market.fetch(v.market);
    assert.equal(m.lossBudgetUsd.toString(), USD(20_000).toString(), "a stable at full weight counts in full");
    assert.equal(m.backingUsd.toString(), "0", "none of it is USDC");
    assert.equal((await getAccount(v.conn, custodyVault)).amount, 20_000_000_000n);
  });

  it("moves nothing on a sync while the LPs are owed nothing", async () => {
    await sync();
    const book: any = await v.perps.account.backingBook.fetch(v.book);
    assert.equal(book.amounts[0].toString(), USD(20_000).toString());
    assert.equal(book.reimbursedUsd.toString(), "0");
  });

  it("pays the LPs in kind for a winner they covered, on the next sync", async () => {
    // The pool quotes a twentieth of the budget a batch, $1,000 here, so
    // the trade stays inside one batch each way.
    await v.open(trader, traderUsdc, true, 400, 800);
    await v.post(200);
    await v.close(trader, traderUsdc);
    const pos: any = await v.perps.account.position.fetchNullable(v.position(trader.publicKey));
    assert.isTrue(!pos || pos.sizeUsd.isZero(), "closed in full");
    const m: any = await v.perps.account.market.fetch(v.market);
    const lost = Number(m.netLossUsd);
    // Up $800 on $800 at 2x the price, less fees and spread.
    assert.isAbove(lost, 700e6, "the LPs paid the winner, with no USDC backing to draw");

    await sync();
    const book: any = await v.perps.account.backingBook.fetch(v.book);
    const c: any = await v.perps.account.custody.fetch(custody);
    const paid = Number(book.reimbursedUsd);
    // What the LPs bore since the backing arrived: the loss, less what the
    // USDC the backers earned in fees already absorbed (`lp_borne_usd`).
    const m2: any = await v.perps.account.market.fetch(v.market);
    assert.equal(paid, lost - Number(m2.backingDrawnUsd) - Number(book.baselineUsd));
    assert.equal(Number(c.lpAmount), paid, "a dollar stable pays a token a dollar");
    assert.equal(Number(book.amounts[0]), 20_000e6 - paid);
    assert.equal(Number(c.backingAmount), 20_000e6 - paid);
    // Again, nothing more.
    await sync();
    assert.equal(Number((await v.perps.account.backingBook.fetch(v.book) as any).reimbursedUsd), paid);
  });

  it("marks a backer's points stake down to what their shares are still worth", async () => {
    await v.perps.methods.markBacking()
      .accounts({
        pool: v.pool, market: v.market, book: v.book,
        backing: v.backing(backer.publicKey), trader: v.trader(backer.publicKey),
      })
      .remainingAccounts(v.custodyPairs())
      .rpc();
    const b: any = await v.perps.account.backing.fetch(v.backing(backer.publicKey));
    const book: any = await v.perps.account.backingBook.fetch(v.book);
    const m: any = await v.perps.account.market.fetch(v.market);
    // The pot is the tokens left plus the USDC its fee share brought in.
    const pot = Number(book.amounts[0]) + Number(m.backingUsd);
    assert.isAtMost(Number(b.pointsBasisUsd), pot, "no points on money already lost");
    assert.isBelow(Number(b.pointsBasisUsd), 20_000e6, "it was marked down");
    assert.isAbove(Number(b.pointsBasisUsd), 0);
  });

  it("lets an LP leave with their part of the tokens, pulled one custody at a time", async () => {
    const request = v.pda([Buffer.from("withdraw_request"), v.pool.toBuffer(), lp.publicKey.toBuffer()]);
    const escrowLp = v.pda([Buffer.from("withdraw_escrow"), request.toBuffer()]);
    const tokenClaim = v.pda([Buffer.from("lp_token_claim"), v.pool.toBuffer(), lp.publicKey.toBuffer()]);
    const shares = (await getAccount(v.conn, lpLp)).amount / 2n;
    await v.perps.methods.requestWithdraw(new BN(shares.toString()))
      .accounts({
        owner: lp.publicKey, pool: v.pool, lpMint: v.lpMint, ownerLp: lpLp,
        request, escrowLp, trader: v.trader(lp.publicKey), tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([lp]).rpc();
    const r: any = await v.perps.account.withdrawRequest.fetch(request);
    while ((await v.conn.getSlot("confirmed")) < Number(r.requestSlot) + 150) await sleep(400);

    const lpTokens = Number((await v.perps.account.custody.fetch(custody) as any).lpAmount);
    await v.checkpoint(lp);
    await v.perps.methods.claimWithdraw(new BN(shares.toString()), new BN(0))
      .accounts({
        owner: lp.publicKey, pool: v.pool, usdcMint: v.usdcMint, usdcVault: v.usdcVault, lpMint: v.lpMint,
        ownerUsdc: lpUsdc, request, escrowLp, tokenClaim,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts(v.custodyPairs(true))
      .signers([lp]).rpc();
    const claim: any = await v.perps.account.lpTokenClaim.fetch(tokenClaim);
    const owed = Number(claim.owed[0]);
    // Half the shares: half the tokens, rounded down.
    assert.closeTo(owed, lpTokens / 2, 1);
    const c: any = await v.perps.account.custody.fetch(custody);
    assert.equal(Number(c.lpOwedAmount), owed);
    assert.equal(Number(c.lpAmount), lpTokens - owed);

    const lpUsdt = (await getOrCreateAssociatedTokenAccount(v.conn, v.authority, usdt, lp.publicKey)).address;
    const pull = (who: Keypair, to: PublicKey) => v.perps.methods.claimWithdrawTokens()
      .accounts({
        owner: who.publicKey, pool: v.pool, custody, mint: usdt, vault: custodyVault,
        ownerToken: to, tokenClaim: v.pda([Buffer.from("lp_token_claim"), v.pool.toBuffer(), who.publicKey.toBuffer()]),
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([who]).rpc();
    // Somebody with no claim has nothing to pull.
    const strangerUsdt = (await getOrCreateAssociatedTokenAccount(v.conn, v.authority, usdt, stranger.publicKey)).address;
    await refuses(() => pull(stranger, strangerUsdt), /AccountNotInitialized|Error/);
    await pull(lp, lpUsdt);
    assert.equal(Number((await getAccount(v.conn, lpUsdt)).amount), owed);
    assert.isNull(await v.perps.account.lpTokenClaim.fetchNullable(tokenClaim), "an emptied claim closes");
    assert.equal(Number((await v.perps.account.custody.fetch(custody) as any).lpOwedAmount), 0);
  });

  it("returns a leaving backer their tokens, and needs every custody's payout accounts", async () => {
    const b: any = await v.perps.account.backing.fetch(v.backing(backer.publicKey));
    const unback = (rest: any[]) => v.perps.methods.unbackMarket(b.shares)
      .accounts({
        owner: backer.publicKey, pool: v.pool, market: v.market, priceUpdate: v.oracle,
        backing: v.backing(backer.publicKey), book: v.book,
        usdcMint: v.usdcMint, usdcVault: v.usdcVault, ownerUsdc: backerUsdc,
        trader: v.trader(backer.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(rest)
      .signers([backer]).rpc();
    await refuses(() => unback(v.custodyPairs(true)), "IncompleteCustodyList");
    const payout = [
      { pubkey: usdt, isWritable: false, isSigner: false },
      { pubkey: custodyVault, isWritable: true, isSigner: false },
      { pubkey: backerUsdt, isWritable: true, isSigner: false },
    ];
    // Payout accounts of another custody's mint are refused.
    await refuses(() => unback([...v.custodyPairs(true), { ...payout[0], pubkey: v.usdcMint }, payout[1], payout[2]]),
      "UnknownCustody");
    await sync();
    const left = Number((await v.perps.account.backingBook.fetch(v.book) as any).amounts[0]);
    const before = (await getAccount(v.conn, backerUsdt)).amount;
    await unback([...v.custodyPairs(true), ...payout]);
    const got = Number((await getAccount(v.conn, backerUsdt)).amount - before);
    assert.equal(got, left, "the only backer takes the whole pot, nothing being open");
    const m: any = await v.perps.account.market.fetch(v.market);
    assert.equal(m.backingShares.toString(), "0");
  });
});
