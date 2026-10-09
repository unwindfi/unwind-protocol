/*
 * Journeys that take longer than one visit: a position held ten minutes, a
 * withdrawal that waits its 150 slots, a trigger that may fire in the next
 * twenty minutes. A browser is never kept open for the wait. A stage does
 * its part, writes down what comes next and when, and the session ends;
 * the runner gives that persona a turn again once the next stage is due
 * (run.ts asks `nextDue` before its round robin).
 *
 * Plans live in the store's meta table under `fu:<persona>:<journey>`, so a
 * restart picks them up where they were. While a persona holds a plan it
 * runs nothing else: another journey closing its position half way through
 * a lifecycle would make every figure after it wrong.
 */
import { config } from "../config";
import * as store from "../store";

export interface Plan<S = Record<string, unknown>> {
  persona: string;
  journey: string;
  /// The stage to run next.
  stage: string;
  /// Not before this time (ms).
  due: number;
  /// When the plan began, for the stale cutoff.
  since: number;
  data: S;
}

const PREFIX = "fu:";
const keyOf = (persona: string, journey: string) => `${PREFIX}${persona}:${journey}`;
/// Past this a plan is dropped: no journey here waits longer, so a plan this
/// old is one whose stage keeps failing before it can move on.
const STALE_MS = 12 * 3_600_000;

function rows(): Plan[] {
  const d = store.open();
  const out: Plan[] = [];
  for (const r of d.prepare("SELECT key, value FROM meta WHERE key LIKE ?").all(`${PREFIX}%`) as { key: string; value: string }[]) {
    let p: Plan | null = null;
    try { p = JSON.parse(r.value) as Plan; } catch { p = null; }
    if (!p || Date.now() - p.since > STALE_MS) { d.prepare("DELETE FROM meta WHERE key = ?").run(r.key); continue; }
    out.push(p);
  }
  return out;
}

export function get<S>(persona: string, journey: string): Plan<S> | null {
  const raw = store.getMeta(keyOf(persona, journey));
  if (!raw) return null;
  try { return JSON.parse(raw) as Plan<S>; } catch { return null; }
}

/// Writes the next stage. `since` is kept from the plan it continues.
export function next<S>(persona: string, journey: string, stage: string, due: number, data: S, since?: number) {
  const prev = get<S>(persona, journey);
  // A new stage is progress: the stuck count (see `settle`) starts over.
  if (prev && prev.stage !== stage && data && typeof data === "object") delete (data as Record<string, unknown>).__stuck;
  const p: Plan<S> = { persona, journey, stage, due, since: since ?? prev?.since ?? Date.now(), data };
  store.setMeta(keyOf(persona, journey), JSON.stringify(p));
}

export function clear(persona: string, journey: string) {
  store.open().prepare("DELETE FROM meta WHERE key = ?").run(keyOf(persona, journey));
}

/*
 * After a due stage ran: a plan still on the same stage and still due made
 * no progress (its step failed, or it left without saying what is next).
 * Each such turn pushes it back further, and the third drops it, so one
 * stuck stage cannot take every worker turn.
 */
export function settle(persona: string, journey: string, before: Plan<unknown> | null) {
  const p = get<Record<string, unknown>>(persona, journey);
  if (!p || !before || p.stage !== before.stage || p.due > Date.now()) return;
  const stuck = Number(p.data.__stuck ?? 0) + 1;
  if (stuck >= 3) { note(journey, persona, `stage "${p.stage}" made no progress three times; dropped`); return clear(persona, journey); }
  next(persona, journey, p.stage, Date.now() + stuck * 5 * 60_000, { ...p.data, __stuck: stuck });
}

/// Every live plan.
export const all = () => rows();

/// Whether this persona has a plan, due or not.
export const holds = (persona: string) => rows().some((p) => p.persona === persona);

/// The journeys due for this persona now, oldest first.
export const dueFor = (persona: string) =>
  rows().filter((p) => p.persona === persona && p.due <= Date.now()).sort((a, b) => a.due - b.due).map((p) => p.journey);

/// The persona whose plan has waited longest past due, among `ids`, skipping
/// any already in a session.
export function nextDue(ids: string[], busy: Set<string>): string | null {
  const want = new Set(ids);
  const due = rows().filter((p) => want.has(p.persona) && !busy.has(p.persona) && p.due <= Date.now())
    .sort((a, b) => a.due - b.due);
  return due[0]?.persona ?? null;
}

/// When this persona may sign again (the per-persona gap in txgate.ts), with
/// a few seconds to spare so the stage is not refused by its own clock.
export const txReadyAt = (persona: string) =>
  Math.max(Date.now(), store.lastTxAt(persona) + config.personaTxGapMs + 5_000);

/// A small note per journey (the last outcome a person should see), kept in
/// meta beside the plans: "tp did not trigger in 20 min" is a result, not an
/// issue.
export function note(journey: string, persona: string, text: string) {
  store.setMeta(`note:${journey}:${persona}`, JSON.stringify({ at: Date.now(), text }));
  console.log(new Date().toISOString().slice(11, 19), `[${persona}] ${journey}: ${text}`);
}

/// Once-a-day counters for journeys that spend something shared (the faucet's
/// daily budget, a listing), fleet wide, in meta.
export function countToday(name: string): number {
  const raw = store.getMeta(`count:${name}`);
  const xs: number[] = raw ? (JSON.parse(raw) as number[]) : [];
  return xs.filter((t) => Date.now() - t < 86_400_000).length;
}
export function countOne(name: string) {
  const raw = store.getMeta(`count:${name}`);
  const xs: number[] = (raw ? (JSON.parse(raw) as number[]) : []).filter((t) => Date.now() - t < 86_400_000);
  xs.push(Date.now());
  store.setMeta(`count:${name}`, JSON.stringify(xs));
}
