/// Client for the localnet mock Pyth receiver.
///
/// Posts live quotes into `PriceUpdateV2` accounts that the perps program
/// reads exactly as it would read the real receiver's. See
/// `programs/mock-pyth/src/lib.rs` for why this exists.
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { EXPONENT, MARKETS, MarketDef } from "./markets";
import { LiveQuote } from "./prices";

const ROOT = path.join(__dirname, "..");

export const MOCK_PYTH_ID = new PublicKey(
  "J1FKStdEnsAK69gV4G5nVTm6eZTquo5kwQdLCHctE2k4"
);

/// One account per feed, stable for the life of the validator.
export const priceAccountFor = (feedId: Uint8Array): PublicKey =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("price"), feedId],
    MOCK_PYTH_ID
  )[0];

export const priceAccounts = (): Record<string, PublicKey> =>
  Object.fromEntries(
    MARKETS.map((m) => [m.symbol, priceAccountFor(Buffer.from(m.feedId, "hex"))])
  );

/// The key that posts prices off localnet. The devnet build of the program
/// accepts posts from `RELAY_AUTHORITY` alone (see programs/mock-pyth), and
/// this is that key: kept outside the repo, apart from the program's upgrade
/// authority, and pointed at by `RELAY_KEYPAIR` wherever the server runs.
export function relayKeypair(): Keypair {
  const file = process.env.RELAY_KEYPAIR
    ?? path.join(process.env.HOME ?? "", ".config/unwind/relay.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

export function mockPythProgram(provider: anchor.AnchorProvider): any {
  const idl = JSON.parse(
    fs.readFileSync(path.join(ROOT, "target/idl/mock_pyth.json"), "utf8"));
  return new Program(idl, provider);
}

/// `price`/`conf` are in dollars; both are scaled to `EXPONENT` here so the
/// caller never has to think about it.
export function postPriceIx(
  program: any,
  payer: PublicKey,
  market: MarketDef,
  q: { price: number; conf: number; publishTime: number },
  fullyVerified = true
) {
  const scale = 10 ** -EXPONENT;
  const feedId = Buffer.from(market.feedId, "hex");
  return program.methods
    .postPrice({
      feedId: Array.from(feedId),
      price: new BN(Math.round(q.price * scale)),
      conf: new BN(Math.max(0, Math.round(q.conf * scale))),
      exponent: EXPONENT,
      publishTime: new BN(Math.floor(q.publishTime)),
      fullyVerified,
    })
    .accounts({
      payer,
      priceUpdate: priceAccountFor(feedId),
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .instruction();
}

/// Posts every quote in one transaction, so no market is ever priced a block
/// ahead of its neighbours -- which would show up as phantom PnL in the pool's
/// AUM, since that is computed across all markets at once.
export async function postQuotes(
  program: any,
  payer: Keypair,
  quotes: Record<string, LiveQuote>,
  markets: MarketDef[] = MARKETS
): Promise<string | null> {
  const ixs = await Promise.all(
    markets
      .filter((m) => quotes[m.symbol])
      .map((m) => postPriceIx(program, payer.publicKey, m, quotes[m.symbol]))
  );
  if (ixs.length === 0) return null;

  // Each post adds a 32-byte price account plus ~75 bytes of instruction and
  // data, on a ~197-byte base — so about nine fit in a 1232-byte transaction.
  // Eight leaves room for a longer blockhash path without recomputing this.
  const PER_TX = 8;
  let sig: string | null = null;
  for (let i = 0; i < ixs.length; i += PER_TX) {
    const tx = new Transaction().add(...ixs.slice(i, i + PER_TX));
    sig = await program.provider.sendAndConfirm(tx, [payer]);
  }
  return sig;
}
