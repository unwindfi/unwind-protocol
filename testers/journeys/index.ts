/*
 * Which journeys each kind of person takes, and how often. A session runs
 * one to three of them, drawn by these weights from the persona's seed.
 */
import type { Role } from "../personas";
import type { Rng } from "../rng";
import { browse } from "./browse";
import type { Journey } from "./common";
import { earn } from "./earn";
import { limit } from "./limit";
import { list } from "./list";
import { portfolio } from "./portfolio";
import { rewards } from "./rewards";
import { tour } from "./tour";
import { trade } from "./trade";

export const JOURNEYS: Journey[] = [browse, trade, limit, portfolio, earn, list, rewards, tour];

const W: Record<Role, Partial<Record<string, number>>> = {
  new: { browse: 5, trade: 2, tour: 2, earn: 1, rewards: 1, portfolio: 1 },
  scalper: { trade: 6, browse: 1, portfolio: 1, limit: 1 },
  swing: { trade: 4, browse: 2, portfolio: 2, limit: 1 },
  limit: { limit: 6, trade: 1, portfolio: 1 },
  lp: { earn: 6, portfolio: 1, browse: 1 },
  lister: { list: 6, browse: 1, earn: 1 },
  backer: { list: 3, earn: 3, portfolio: 1 },
  referrer: { rewards: 5, trade: 1, browse: 1 },
  mobile: { browse: 2, trade: 3, tour: 2, earn: 1, rewards: 1 },
  power: { trade: 3, limit: 3, portfolio: 2, earn: 1, list: 1, rewards: 1, tour: 1 },
};

export function plan(role: Role, r: Rng): Journey[] {
  const weights = JOURNEYS.map((j) => [j, W[role][j.name] ?? 0] as const).filter(([, w]) => w > 0);
  const n = r.weighted([[1, 3], [2, 4], [3, 2]] as const);
  const out: Journey[] = [];
  for (let i = 0; i < n; i++) {
    const j = r.weighted(weights);
    if (!out.includes(j)) out.push(j);
  }
  return out;
}

export const byName = (name: string) => JOURNEYS.find((j) => j.name === name);
