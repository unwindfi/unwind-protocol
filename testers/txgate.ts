/*
 * How often the fleet may ask for a signature.
 *
 * Devnet RPC keys and the house maker are shared with real users, so the
 * fleet trades slowly: one transaction per persona per PERSONA_TX_GAP_MS
 * (three minutes) and one from the whole fleet per FLEET_TX_GAP_MS (ten
 * seconds). The times live in the store, so a restart does not reset them.
 *
 * A journey asks for a ticket before it presses a button that signs. The
 * wallet only signs a transaction against a ticket; anything else the page
 * asks it to sign is refused as a user would refuse it, and noted.
 */
import { config } from "./config";
import * as store from "./store";

let fleetLast = 0;
let queue: Promise<unknown> = Promise.resolve();

export interface Ticket { kind: string; persona: string; at: number }

/// Waits up to `waitMs` for the fleet slot. Null when this persona traded too
/// recently or the slot did not free up in time; the journey then explores
/// without signing.
export function acquire(persona: string, kind: string, waitMs = 20_000): Promise<Ticket | null> {
  const run = async (): Promise<Ticket | null> => {
    const mine = store.lastTxAt(persona);
    if (Date.now() - mine < config.personaTxGapMs) return null;
    fleetLast = Math.max(fleetLast, store.lastTxAt());
    const wait = fleetLast + config.fleetTxGapMs - Date.now();
    if (wait > waitMs) return null;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    fleetLast = Date.now();
    store.recordTx({ persona, kind, status: "requested" });
    return { kind, persona, at: fleetLast };
  };
  // One at a time, so two workers cannot both take the same slot.
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

/// Whether a real listing is allowed today (LISTINGS_PER_DAY, fleet wide).
export const listingAllowed = () =>
  !config.dryTx && store.countTx("list-market", 86_400_000) < config.listingsPerDay;
