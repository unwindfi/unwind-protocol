/// Address Lookup Table plumbing for the liquidity instructions.
///
/// `add_liquidity` and `remove_liquidity` must see every market so the pool's
/// liability is priced in full, and in a legacy transaction each market costs
/// 66 bytes — two 32-byte keys plus their indices. Twelve markets serialises to
/// 1482 bytes against the 1232 limit, which is why the market list was capped
/// at eight.
///
/// A lookup table replaces each 32-byte key with a 1-byte index, taking the
/// per-market cost from 66 bytes to 4. Size stops being the binding constraint;
/// what binds instead is Solana's cap of 64 account locks per transaction, so
/// with ~9 fixed accounts the real ceiling is about 27 markets.
import {
  AddressLookupTableAccount, AddressLookupTableProgram, Connection, Keypair,
  PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";

/// Solana refuses a transaction that locks more than this many accounts.
export const MAX_TX_ACCOUNT_LOCKS = 64;
/// Fixed accounts on a liquidity instruction, before the per-market pairs.
const FIXED_ACCOUNTS = 9;
export const MAX_MARKETS_WITH_ALT = Math.floor((MAX_TX_ACCOUNT_LOCKS - FIXED_ACCOUNTS) / 2);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/// Creates a lookup table holding `addresses` and waits for it to be usable.
export async function createLookupTable(
  connection: Connection,
  payer: Keypair,
  addresses: PublicKey[]
): Promise<PublicKey> {
  const slot = await connection.getSlot("finalized");
  const [createIx, tableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });

  await sendV0(connection, payer, [createIx]);
  await extendLookupTable(connection, payer, tableAddress, addresses);
  return tableAddress;
}

/// Adds `addresses` to a table `payer` has authority over, and waits until a
/// transaction can use them.
///
/// A table cannot be referenced in the same slot it was extended, so this waits
/// for the extension to land and a slot to pass before returning; otherwise the
/// first transaction to use it fails with an address-not-found error that looks
/// nothing like a timing problem.
export async function extendLookupTable(
  connection: Connection,
  payer: Keypair,
  tableAddress: PublicKey,
  addresses: PublicKey[]
): Promise<void> {
  const before = (await connection.getAddressLookupTable(tableAddress)).value?.state.addresses.length ?? 0;
  // Each extend instruction carries the keys inline, so they go in batches.
  for (let i = 0; i < addresses.length; i += 20) {
    await sendV0(connection, payer, [
      AddressLookupTableProgram.extendLookupTable({
        payer: payer.publicKey,
        authority: payer.publicKey,
        lookupTable: tableAddress,
        addresses: addresses.slice(i, i + 20),
      }),
    ]);
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const got = await connection.getAddressLookupTable(tableAddress);
    if (got.value && got.value.state.addresses.length >= before + addresses.length) {
      // Active from the slot after the one it was extended in.
      await sleep(1_200);
      return;
    }
    await sleep(500);
  }
  throw new Error(`lookup table ${tableAddress.toBase58()} did not become available`);
}

export async function loadLookupTable(
  connection: Connection,
  address: PublicKey
): Promise<AddressLookupTableAccount> {
  const got = await connection.getAddressLookupTable(address);
  if (!got.value) throw new Error(`lookup table ${address.toBase58()} not found`);
  return got.value;
}

/// Sends a v0 transaction, optionally compressing account keys through `tables`.
export async function sendV0(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  tables: AddressLookupTableAccount[] = [],
  extraSigners: Keypair[] = []
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(tables);

  const tx = new VersionedTransaction(msg);
  tx.sign([payer, ...extraSigners]);

  const sig = await connection.sendTransaction(tx, { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}
