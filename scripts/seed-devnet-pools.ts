/// Seeds the devnet testnet with pools a tester can list a market on.
///
/// Listing watches a real AMM pool on the chain the venue runs on, and every
/// real pool is on mainnet, so without these the testnet's list page has
/// nothing it can list. Meteora's DLMM program sits at the same address on
/// devnet as on mainnet, so a pair created here is read by exactly the code
/// that reads a mainnet one: same program id, same layout, same depth maths.
///
/// Each token is made up and minted here, paired against the pool's own test
/// USDC, and given liquidity either side of a starting price deep enough to
/// earn a listing its full limits. Idempotent: tokens and pairs already in
/// the state file are left alone.
///
///   CLUSTER=devnet npx ts-node scripts/seed-devnet-pools.ts
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { JUP_PRICE, POPULAR, SHADOWS, seedPool } from "./testnet-flow";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..");
const STATE = path.join(ROOT, ".devnet-state.json");
const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
const kp = (a: number[]) => Keypair.fromSecretKey(Uint8Array.from(a));

/// WIND, KITE and YAK are invented, and named after the trail the film was
/// shot on, so nobody mistakes one for a token with a market somewhere else.
/// The popular set are test copies of real Solana tokens, seeded at the real
/// token's price (Jupiter) and kept following it by `testnet-flow.ts`.
const ONLY = process.env.ONLY?.split(",");
const INVENTED: { symbol: string; name: string; price: number; decimals?: number }[] = [
  { symbol: "WIND", name: "Wind", price: 0.84 },
  { symbol: "KITE", name: "Kite", price: 3.2 },
  { symbol: "YAK", name: "Yak", price: 0.0042 },
];
const DECIMALS = 9;
/// Of each side, in dollars. About a third lands within the band depth is
/// measured over, which clears the $50k a listing's open-interest ceiling
/// is measured against, so these list at full limits.
const SIDE_USD = 180_000;
(async () => {
  // RPC_URL, so a run can stay off the key the testnet server is using.
  const conn = new Connection(process.env.RPC_URL ?? st.rpc, "confirmed");
  const authority = kp(st.keys.authority);
  const usdc = new PublicKey(st.usdcMint);
  st.seededPools ??= [];

  const r = await fetch(`${JUP_PRICE}?ids=${POPULAR.map((k) => SHADOWS[k].mint).join(",")}`);
  if (!r.ok) throw new Error(`jupiter price ${r.status}`);
  const real = (await r.json()) as Record<string, { usdPrice: number; decimals: number }>;
  const TOKENS = [
    ...INVENTED,
    ...POPULAR.filter((k) => real[SHADOWS[k].mint]?.usdPrice)
      // The real token's decimals: at nine, a side of BONK in base units is
      // past what a u64 holds.
      .map((k) => ({ symbol: k, name: SHADOWS[k].name!, price: real[SHADOWS[k].mint].usdPrice,
                     decimals: real[SHADOWS[k].mint].decimals })),
  ];

  for (const t of TOKENS.filter((t) => !ONLY || ONLY.includes(t.symbol))) {
    if (st.seededPools.some((p: any) => p.symbol === t.symbol)) {
      console.log(`${t.symbol} already seeded`);
      continue;
    }

    const { mint, pair: pairKey, position } = await seedPool(conn, authority, usdc,
      { price: t.price, decimals: t.decimals ?? DECIMALS, sideUsd: SIDE_USD });

    st.seededPools.push({
      symbol: t.symbol, name: t.name, mint: mint.toBase58(), pair: pairKey.toBase58(),
      position: position.toBase58(),
    });
    fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
    console.log(`${t.symbol}  mint ${mint.toBase58()}  pair ${pairKey.toBase58()}`);
  }
})().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
