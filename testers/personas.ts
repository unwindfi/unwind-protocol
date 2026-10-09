/*
 * The fleet: sixty people who use the site in different ways.
 *
 * Generated from fixed seeds, so persona 17 is the same person on every run
 * and on every box: the same device, theme, temperament and habits. Only its
 * key comes from outside, from the file `keygen.ts` writes (TESTERS_KEYS).
 */
import fs from "fs";
import { Keypair } from "@solana/web3.js";
import { config } from "./config";
import { hash32, rng } from "./rng";

export type Role =
  | "new" | "scalper" | "swing" | "limit" | "lp"
  | "lister" | "backer" | "referrer" | "mobile" | "power";

export type DeviceName = "desktop" | "laptop" | "tablet" | "phone-375" | "phone-390";

export interface Device {
  name: DeviceName;
  width: number;
  height: number;
  mobile: boolean;
  touch: boolean;
}

export const DEVICES: Record<DeviceName, Device> = {
  desktop: { name: "desktop", width: 1440, height: 900, mobile: false, touch: false },
  laptop: { name: "laptop", width: 1280, height: 800, mobile: false, touch: false },
  tablet: { name: "tablet", width: 768, height: 1024, mobile: true, touch: true },
  "phone-375": { name: "phone-375", width: 375, height: 812, mobile: true, touch: true },
  "phone-390": { name: "phone-390", width: 390, height: 844, mobile: true, touch: true },
};

/// Which markets a persona gravitates to. Matched against the live list at
/// run time, since the list changes as markets are opened.
export type Taste = "majors" | "memes" | "equities" | "opened" | "any";

export interface Persona {
  id: string;            // "t07"
  index: number;         // 0..59, the key's position in the keys file
  name: string;
  role: Role;
  device: Device;
  theme: "dark" | "light";
  /// 0.2 (gives up fast, clicks before things settle) to 1 (reads everything).
  patience: number;
  taste: Taste;
  /// Symbols tried first when the market list has them.
  favorites: string[];
  /// Leverage this persona reaches for, and the order sizes it types (USD).
  leverage: [number, number];
  sizes: number[];
  seed: number;
}

export const ROLES: Role[] = [
  "new", "scalper", "swing", "limit", "lp", "lister", "backer", "referrer", "mobile", "power",
];

const NAMES = [
  "Ana", "Ben", "Chen", "Dara", "Eli", "Fatima", "Gus", "Hana", "Ivo", "Jun",
  "Kofi", "Lena", "Milo", "Nadia", "Omar", "Pia", "Quinn", "Ravi", "Sora", "Tariq",
  "Uma", "Vik", "Wren", "Xia", "Yusuf", "Zoe", "Arjun", "Bea", "Cyrus", "Dina",
  "Emil", "Freya", "Goran", "Hiro", "Isla", "Jonah", "Kira", "Luca", "Maya", "Nils",
  "Odette", "Pavel", "Rhea", "Sami", "Tess", "Ugo", "Vera", "Wade", "Yara", "Zane",
  "Aiko", "Bruno", "Cleo", "Dev", "Esme", "Finn", "Gita", "Hugo", "Ines", "Jae",
];

const FAVORITES: Record<Taste, string[]> = {
  majors: ["SOL", "JUP", "RAY", "JTO", "ORCA"],
  memes: ["WIF", "POPCAT", "FARTCOIN", "1MBONK", "1KPENGU", "TRUMP"],
  equities: ["SPYx", "CRCLx", "COINx"],
  opened: [],
  any: [],
};

/// Devices each role tends to use. A mobile-first persona is always on a phone.
const DEVICE_MIX: Record<Role, [DeviceName, number][]> = {
  new: [["desktop", 2], ["laptop", 3], ["phone-390", 3], ["phone-375", 2], ["tablet", 1]],
  scalper: [["desktop", 6], ["laptop", 3], ["tablet", 1]],
  swing: [["desktop", 3], ["laptop", 3], ["phone-390", 2], ["tablet", 1]],
  limit: [["desktop", 4], ["laptop", 3], ["tablet", 1]],
  lp: [["desktop", 2], ["laptop", 3], ["phone-390", 2], ["tablet", 1]],
  lister: [["desktop", 3], ["laptop", 3], ["phone-375", 1]],
  backer: [["desktop", 2], ["laptop", 2], ["phone-390", 2], ["phone-375", 1]],
  referrer: [["laptop", 2], ["phone-390", 3], ["phone-375", 2]],
  mobile: [["phone-375", 1], ["phone-390", 1]],
  power: [["desktop", 5], ["laptop", 2], ["tablet", 1]],
};

const TASTES: Record<Role, [Taste, number][]> = {
  new: [["majors", 4], ["memes", 3], ["any", 2]],
  scalper: [["majors", 5], ["memes", 3]],
  swing: [["majors", 3], ["equities", 3], ["any", 1]],
  limit: [["majors", 3], ["equities", 2], ["memes", 1]],
  lp: [["any", 1]],
  lister: [["opened", 3], ["memes", 2]],
  backer: [["opened", 4], ["memes", 1]],
  referrer: [["majors", 2], ["memes", 2]],
  mobile: [["memes", 3], ["majors", 2], ["any", 1]],
  power: [["any", 2], ["majors", 1], ["opened", 1], ["equities", 1]],
};

function make(index: number): Persona {
  const role = ROLES[index % ROLES.length];
  const seed = hash32(`unwind-tester-${index}`);
  const r = rng(seed);
  const device = DEVICES[r.weighted(DEVICE_MIX[role])];
  const taste = r.weighted(TASTES[role]);
  const lev: Record<Role, [number, number]> = {
    // Clamped to each market's own maximum when typed.
    new: [1.5, 3], scalper: [3, 10], swing: [1.5, 3], limit: [2, 4], lp: [1.5, 2],
    lister: [2, 3], backer: [1.5, 2], referrer: [2, 4], mobile: [2, 6], power: [3, 10],
  };
  // Small on purpose: most devnet markets fill about $100 a batch, and the
  // minimum order is $10.
  const sizes: Record<Role, number[]> = {
    new: [10, 15, 25], scalper: [40, 80, 150], swing: [20, 50, 100],
    limit: [15, 40, 80], lp: [20, 50], lister: [15, 30], backer: [25, 50],
    referrer: [12, 30], mobile: [10, 20, 45], power: [60, 150, 400],
  };
  return {
    id: `t${String(index + 1).padStart(2, "0")}`,
    index,
    name: NAMES[index % NAMES.length],
    role,
    device,
    theme: r.chance(role === "mobile" ? 0.4 : 0.55) ? "dark" : "light",
    patience: Math.round((0.2 + r.next() * 0.8) * 100) / 100,
    taste,
    favorites: r.shuffle(FAVORITES[taste]).slice(0, 3),
    leverage: lev[role],
    sizes: sizes[role],
    seed,
  };
}

export const PERSONA_COUNT = 60;
export const PERSONAS: Persona[] = Array.from({ length: PERSONA_COUNT }, (_, i) => make(i));

/// The personas this process runs: all of them, or those named in PERSONAS.
export function activePersonas(): Persona[] {
  if (!config.only.length) return PERSONAS;
  const want = new Set(config.only);
  return PERSONAS.filter((p) => want.has(p.id));
}

/// The keys file: a JSON array of 60 secret keys (64-number arrays), in
/// persona order. Read once; the secret keys never leave this process.
export interface KeysFile { version: 1; created: string; keys: number[][] }

let loaded: Keypair[] | null = null;
export function loadKeys(file = config.keysFile): Keypair[] {
  if (loaded) return loaded;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as KeysFile;
  if (!Array.isArray(raw.keys) || raw.keys.length < PERSONA_COUNT) {
    throw new Error(`${file} holds ${raw.keys?.length ?? 0} keys, the fleet needs ${PERSONA_COUNT}`);
  }
  loaded = raw.keys.map((k) => Keypair.fromSecretKey(Uint8Array.from(k)));
  return loaded;
}

export const keyOf = (p: Persona) => loadKeys()[p.index];
