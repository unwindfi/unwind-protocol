import { PublicKey } from "@solana/web3.js";

/// Pyth Solana Receiver program. `PriceUpdateV2` accounts must be owned by it.
export const PYTH_RECEIVER_ID = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"
);

/// sha256("account:PriceUpdateV2")[..8]
const DISCRIMINATOR = Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]);

export interface PriceUpdateArgs {
  feedId: Buffer; // 32 bytes
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
  /// `false` produces a Partial update, which the program must reject.
  fullyVerified?: boolean;
}

/// Borsh-encodes a `PriceUpdateV2` exactly as the on-chain reader in
/// `oracle.rs` expects it: discriminator, write authority, verification level,
/// price message, posted slot.
export function encodePriceUpdate(args: PriceUpdateArgs): Buffer {
  const parts: Buffer[] = [DISCRIMINATOR, Buffer.alloc(32)]; // authority = default

  if (args.fullyVerified === false) {
    parts.push(Buffer.from([0, 3])); // Partial { num_signatures: 3 }
  } else {
    parts.push(Buffer.from([1])); // Full
  }

  // PriceFeedMessage, 84 bytes:
  //   feed_id [u8;32] | price i64 | conf u64 | exponent i32
  //   publish_time i64 | prev_publish_time i64 | ema_price i64 | ema_conf u64
  const msg = Buffer.alloc(84);
  args.feedId.copy(msg, 0);
  msg.writeBigInt64LE(args.price, 32);
  msg.writeBigUInt64LE(args.conf, 40);
  msg.writeInt32LE(args.exponent, 48);
  msg.writeBigInt64LE(args.publishTime, 52);
  msg.writeBigInt64LE(args.publishTime - 1n, 60);
  msg.writeBigInt64LE(args.price, 68); // ema_price
  msg.writeBigUInt64LE(args.conf, 76); // ema_conf
  parts.push(msg);

  const slot = Buffer.alloc(8);
  slot.writeBigUInt64LE(1n);
  parts.push(slot);

  return Buffer.concat(parts);
}

/// A price expressed in whole dollars, at the exponent Pyth uses for equities.
export const EXPONENT = -8;
export function usd(dollars: number): bigint {
  return BigInt(Math.round(dollars * 1e8));
}

export interface DecodedPrice {
  feedId: string;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
  fullyVerified: boolean;
}

/// Inverse of `encodePriceUpdate`, for reading fixtures back off the chain.
export function decodePriceUpdate(data: Buffer): DecodedPrice {
  let o = 8 + 32; // discriminator + write_authority
  const fullyVerified = data[o] === 1;
  o += fullyVerified ? 1 : 2;
  const feedId = data.subarray(o, o + 32).toString("hex");
  return {
    feedId,
    price: data.readBigInt64LE(o + 32),
    conf: data.readBigUInt64LE(o + 40),
    exponent: data.readInt32LE(o + 48),
    publishTime: data.readBigInt64LE(o + 52),
    fullyVerified,
  };
}
