/*
 * Writes the fleet's sixty devnet keys to TESTERS_KEYS (default
 * /etc/unwind/testers.json), mode 600, and prints only the public keys.
 *
 *   TESTERS_KEYS=/etc/unwind/testers.json npx ts-node -P testers/tsconfig.json testers/keygen.ts
 *
 * Refuses to overwrite an existing file: those wallets may hold funds and
 * points. Pass --force to replace it anyway, after moving the old one aside.
 */
import fs from "fs";
import path from "path";
import { Keypair } from "@solana/web3.js";
import { config } from "./config";
import { PERSONAS, PERSONA_COUNT, type KeysFile } from "./personas";

const file = config.keysFile;
const force = process.argv.includes("--force");
const repo = path.resolve(__dirname, "..");

if (path.resolve(file).startsWith(repo + path.sep)) {
  console.error(`Refusing to write keys inside the repository (${file}). Set TESTERS_KEYS to a path outside it.`);
  process.exit(1);
}
if (fs.existsSync(file) && !force) {
  console.error(`${file} already exists. Move it aside or pass --force.`);
  process.exit(1);
}

const keys = Array.from({ length: PERSONA_COUNT }, () => Keypair.generate());
const body: KeysFile = {
  version: 1,
  created: new Date().toISOString(),
  keys: keys.map((k) => Array.from(k.secretKey)),
};
fs.mkdirSync(path.dirname(file), { recursive: true });
// Created with 600 from the first byte, rather than chmod after a write.
const fd = fs.openSync(file, "w", 0o600);
fs.writeSync(fd, JSON.stringify(body));
fs.closeSync(fd);
fs.chmodSync(file, 0o600);

console.log(`Wrote ${keys.length} keys to ${file} (mode 600). Public keys:`);
keys.forEach((k, i) => {
  const p = PERSONAS[i];
  console.log(`${p.id}  ${p.role.padEnd(8)}  ${k.publicKey.toBase58()}`);
});
