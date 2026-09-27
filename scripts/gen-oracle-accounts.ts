/// Generates `PriceUpdateV2` account fixtures for the local test validator.
///
/// The validator cannot be made to sign as the Pyth receiver program, so the
/// accounts are written to disk and loaded at boot via `[[test.validator.account]]`
/// in Anchor.toml. Each fixture is the same feed at a different price, which is
/// how the tests move the market: the program checks the feed id, not the
/// account address, so any fixture is a valid quote for that market.
///
/// `publish_time` is stamped at generation, so these expire: the suite sets
/// `max_price_age_sec` to an hour, and an hour after this runs every fixture
/// reads as stale. `npm run test:integration` regenerates first for that
/// reason. The product does not have this problem -- it posts live updates
/// through `programs/mock-pyth` instead.
import * as fs from "fs";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import { createHash } from "crypto";
import { encodePriceUpdate, usd, EXPONENT, PYTH_RECEIVER_ID } from "./pyth";

// Stand-in feed id for AAPLx. Deterministic so the tests can hard-code it.
export const FEED_ID = Buffer.alloc(32, 7);

/// Prices the tests need, keyed by name.
export const PRICES: Record<string, { price: number; confBps?: number; full?: boolean }> = {
  at_200: { price: 200 },
  at_220: { price: 220 },
  at_180: { price: 180 },
  at_100: { price: 100 },
  at_50: { price: 50 },
  // Same price, but a 5% confidence interval: the program should refuse to quote.
  wide_conf: { price: 200, confBps: 500 },
  // Only partially verified by the Wormhole guardians: must be rejected.
  partial: { price: 200, full: false },
};

const outDir = path.join(__dirname, "..", "tests", "fixtures");
fs.mkdirSync(outDir, { recursive: true });

const now = BigInt(Math.floor(Date.now() / 1000));
const manifest: Record<string, string> = {};

for (const [name, spec] of Object.entries(PRICES)) {
  // Derived from the fixture name rather than random, so the addresses are
  // stable and can be hard-coded in Anchor.toml's validator account list.
  const seed = createHash("sha256").update(`xstock-oracle:${name}`).digest().subarray(0, 32);
  const kp = Keypair.fromSeed(seed);
  const price = usd(spec.price);
  const conf = spec.confBps
    ? (price * BigInt(spec.confBps)) / 10_000n
    : usd(spec.price * 0.0001); // 1bp, a normal regular-hours interval

  const data = encodePriceUpdate({
    feedId: FEED_ID,
    price,
    conf,
    exponent: EXPONENT,
    publishTime: now,
    fullyVerified: spec.full,
  });

  const account = {
    pubkey: kp.publicKey.toBase58(),
    account: {
      lamports: 1_000_000_000,
      data: [data.toString("base64"), "base64"],
      owner: PYTH_RECEIVER_ID.toBase58(),
      executable: false,
      rentEpoch: 0,
    },
  };

  fs.writeFileSync(
    path.join(outDir, `${name}.json`),
    JSON.stringify(account, null, 2)
  );
  manifest[name] = kp.publicKey.toBase58();
}

fs.writeFileSync(
  path.join(outDir, "manifest.json"),
  JSON.stringify({ feedId: FEED_ID.toString("hex"), accounts: manifest }, null, 2)
);

// Anchor.toml needs one entry per fixture; emit it so it can be pasted in.
const toml = Object.entries(manifest)
  .map(
    ([name, pubkey]) =>
      `[[test.validator.account]]\naddress = "${pubkey}"\nfilename = "tests/fixtures/${name}.json"`
  )
  .join("\n\n");
fs.writeFileSync(path.join(outDir, "validator-accounts.toml"), toml + "\n");

console.log(`wrote ${Object.keys(manifest).length} oracle fixtures to ${outDir}`);
