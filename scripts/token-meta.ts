/// What a token calls itself, read from the chain.
///
/// Two places a Solana token keeps its name. Most tokens -- anything minted
/// by the original SPL program, which is every pump.fun launch -- have a
/// Metaplex metadata account at a PDA of the mint. Tokens minted under
/// Token-2022 can carry the same fields inside the mint account itself, as a
/// TLV extension. This reads both, Token-2022 first because when present it is
/// the mint's own claim rather than a separate account's.
///
/// None of it is verified by anybody. A name in metadata is whatever the
/// update authority wrote, and two unrelated tokens can both say "BONK". The
/// mint address is the identity; this is the label, and the page shows both.
import { Connection, PublicKey } from "@solana/web3.js";

export const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const TOKEN_2022_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// The extension type Token-2022 stores embedded metadata under.
const EXT_TOKEN_METADATA = 19;
/// A base mint is 82 bytes; an extended one pads to 165 and puts its account
/// type there, then the TLV entries.
const MINT_EXT_START = 166;

export interface TokenMeta { name: string | null; symbol: string | null }

/// Borsh strings are a u32 length and that many bytes. Metaplex pads the
/// bytes with NULs to a fixed width, so the length covers the padding too.
function borshString(data: Buffer, at: number): [string, number] {
  const len = data.readUInt32LE(at);
  const raw = data.subarray(at + 4, at + 4 + len).toString("utf8");
  return [raw.replace(/\0/g, "").trim(), at + 4 + len];
}

function fromMetaplex(data: Buffer): TokenMeta {
  // key (1) + update_authority (32) + mint (32), then name, symbol, uri.
  const [name, next] = borshString(data, 65);
  const [symbol] = borshString(data, next);
  return { name: name || null, symbol: symbol || null };
}

function fromToken2022(data: Buffer): TokenMeta | null {
  if (data.length <= MINT_EXT_START) return null;
  let at = MINT_EXT_START;
  while (at + 4 <= data.length) {
    const type = data.readUInt16LE(at);
    const len = data.readUInt16LE(at + 2);
    if (type === EXT_TOKEN_METADATA) {
      // update_authority (32) + mint (32), then name, symbol, uri.
      const [name, next] = borshString(data, at + 4 + 64);
      const [symbol] = borshString(data, next);
      return { name: name || null, symbol: symbol || null };
    }
    if (type === 0 && len === 0) break; // uninitialised tail
    at += 4 + len;
  }
  return null;
}

export async function readTokenMeta(conn: Connection, mint: PublicKey): Promise<TokenMeta> {
  const empty = { name: null, symbol: null };
  try {
    const account = await conn.getAccountInfo(mint);
    if (account?.owner.equals(TOKEN_2022_ID)) {
      const embedded = fromToken2022(account.data);
      if (embedded?.symbol) return embedded;
    }
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      METADATA_PROGRAM_ID);
    const meta = await conn.getAccountInfo(pda);
    return meta ? fromMetaplex(meta.data) : empty;
  } catch {
    // A token with no readable metadata is a token with no name, which the
    // caller has an answer for. It is not a reason to refuse the listing.
    return empty;
  }
}
