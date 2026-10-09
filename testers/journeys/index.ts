/*
 * Which journeys each kind of person takes, and how often. A session runs
 * one to three of them, drawn by these weights from the persona's seed.
 */
import { config } from "../config";
import type { Role } from "../personas";
import type { Rng } from "../rng";
import { browse } from "./browse";
import type { Journey } from "./common";
import { backing } from "./backing";
import { earn } from "./earn";
import { faucet } from "./faucet";
import { lifecycle } from "./lifecycle";
import { limit } from "./limit";
import { liquidation } from "./liquidation";
import { list } from "./list";
import { makers } from "./makers";
import { newmarket } from "./newmarket";
import { portfolio } from "./portfolio";
import { referral } from "./referral";
import { rewards } from "./rewards";
import { tour } from "./tour";
import { tpsl } from "./tpsl";
import { trade } from "./trade";

export const JOURNEYS: Journey[] = [
  browse, trade, limit, portfolio, earn, list, rewards, tour,
  // Multi-visit: each run does one stage and leaves the rest to follow-ups
  // (followup.ts), which run.ts gives priority to once due.
  lifecycle, tpsl, liquidation, makers, newmarket, backing, referral, faucet,
];

const W: Record<Role, Partial<Record<string, number>>> = {
  new: { browse: 5, trade: 2, tour: 2, earn: 1, rewards: 1, portfolio: 1, faucet: 1 },
  scalper: { trade: 6, browse: 1, portfolio: 1, limit: 1, lifecycle: 2 },
  swing: { trade: 4, browse: 2, portfolio: 2, limit: 1, lifecycle: 2, tpsl: 1 },
  limit: { limit: 6, trade: 1, portfolio: 1, makers: 3, tpsl: 2 },
  lp: { earn: 6, portfolio: 1, browse: 1, backing: 2 },
  lister: { list: 6, browse: 1, earn: 1, newmarket: 2 },
  backer: { list: 3, earn: 3, portfolio: 1, backing: 2 },
  referrer: { rewards: 5, trade: 1, browse: 1, referral: 2 },
  mobile: { browse: 2, trade: 3, tour: 2, earn: 1, rewards: 1 },
  power: { trade: 3, limit: 3, portfolio: 2, earn: 1, list: 1, rewards: 1, tour: 1, lifecycle: 1, tpsl: 1, makers: 1 },
};

/// A journey that starts a multi-visit plan runs alone in its session: the
/// next journey would otherwise trade on top of the first stage.
const ALONE = new Set(["lifecycle", "tpsl", "liquidation", "makers", "newmarket", "backing", "referral"]);

export function plan(role: Role, r: Rng, persona?: string): Journey[] {
  // The liquidation persona does nothing else, so its balance stays small.
  if (persona && persona === config.liqPersona) return [liquidation];
  const weights = JOURNEYS.map((j) => [j, W[role][j.name] ?? 0] as const).filter(([, w]) => w > 0);
  const n = r.weighted([[1, 3], [2, 4], [3, 2]] as const);
  const out: Journey[] = [];
  for (let i = 0; i < n; i++) {
    const j = r.weighted(weights);
    if (ALONE.has(j.name)) return [j];
    if (!out.includes(j)) out.push(j);
  }
  return out;
}

export const byName = (name: string) => JOURNEYS.find((j) => j.name === name);
