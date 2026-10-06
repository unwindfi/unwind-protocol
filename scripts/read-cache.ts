/// Small pieces the server's RPC budget rests on, kept free of any connection
/// so they can be checked on their own (scripts/read-cache.check.ts).

/*
 * One read per key per `ttlMs`, shared by everyone who asks meanwhile.
 *
 * A page polls on a timer, and every open page polls the same few routes. A
 * read-through cost one RPC round per poll per visitor; through this it is one
 * round per key per TTL however many pollers there are, and a poll that
 * arrives while a read is in flight waits on that read instead of starting
 * its own. A failed read is not kept: the next caller reads again.
 */
export class Memo<T> {
  private entries = new Map<string, { at: number; body: Promise<T> }>();
  constructor(private ttlMs: number, private now: () => number = Date.now) {}

  get(key: string, read: () => Promise<T>): Promise<T> {
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit && t - hit.at < this.ttlMs) return hit.body;
    // Expired entries are only dropped when the map grows, so a busy key is
    // never re-inserted at a new position on every read.
    if (this.entries.size >= 10_000) {
      for (const [k, v] of this.entries) if (t - v.at >= this.ttlMs) this.entries.delete(k);
    }
    const body = read();
    const entry = { at: t, body };
    this.entries.set(key, entry);
    body.catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    return body;
  }

  /// Forgets one key, so its next read goes to the chain.
  drop(key: string) { this.entries.delete(key); }
  clear() { this.entries.clear(); }
}

/*
 * Whether the mark keeper may leave a market's mark where it is this pass.
 *
 * Only when nothing would change and nothing could go stale: the market has
 * seasoned (an unseasoned one is always pushed, so seasoning never slows), the
 * price it would push is within `skipBps` of the mark on chain, and the mark
 * is young enough that it is still well inside the market's
 * `max_price_age_sec` by the time the next pass can land. `nextPassSec` is how
 * long until then (the loop's interval plus how long a pass has been taking);
 * `refreshSec` caps how long a mark is ever left, so depth (which only moves
 * on a push) and the page's feed age stay current too.
 */
export function markMayRest(o: {
  seasoned: boolean;
  onChain: number;
  next: number;
  ageSec: number;
  maxAgeSec: number;
  nextPassSec: number;
  skipBps: number;
  refreshSec: number;
}): boolean {
  if (!o.seasoned || !(o.onChain > 0) || !(o.next > 0) || o.skipBps <= 0) return false;
  if (!(o.ageSec >= 0)) return false;
  const moveBps = Math.abs(o.next / o.onChain - 1) * 10_000;
  if (moveBps >= o.skipBps) return false;
  // Twenty seconds of slack for the push itself to land and confirm.
  const ageAtNextPass = o.ageSec + o.nextPassSec + 20;
  return ageAtNextPass < o.maxAgeSec && o.ageSec + o.nextPassSec <= o.refreshSec;
}
