/// Sanity check for read-cache.ts: `npx ts-node scripts/read-cache.check.ts`.
import assert from "node:assert/strict";
import { Memo, markMayRest } from "./read-cache";

(async () => {
  // N concurrent readers of one key cost one read per TTL.
  let t = 0;
  let reads = 0;
  const memo = new Memo<number>(3_000, () => t);
  const read = () => { reads++; return new Promise<number>((ok) => setTimeout(() => ok(reads), 5)); };
  const many = await Promise.all(Array.from({ length: 50 }, () => memo.get("a", read)));
  assert.equal(reads, 1);
  assert.ok(many.every((v) => v === 1));
  t = 2_999; await memo.get("a", read); assert.equal(reads, 1);
  t = 3_000; await memo.get("a", read); assert.equal(reads, 2);
  // Dropping a key (a transaction landed for that owner) reads at once.
  memo.drop("a"); await memo.get("a", read); assert.equal(reads, 3);
  // Other keys are separate.
  await memo.get("b", read); assert.equal(reads, 4);
  // A failed read is not kept.
  const failing = new Memo<number>(3_000, () => t);
  await failing.get("x", () => Promise.reject(new Error("429"))).catch(() => {});
  let again = 0;
  await failing.get("x", async () => ++again);
  assert.equal(again, 1);

  // The keeper leaves a flat, young, seasoned mark alone...
  const base = { seasoned: true, onChain: 1_000_000, next: 1_000_200, ageSec: 25,
                 maxAgeSec: 120, nextPassSec: 27, skipBps: 5, refreshSec: 55 };
  assert.equal(markMayRest(base), true);
  // ...but pushes a move, an old mark, an unseasoned one, or a tight max age.
  assert.equal(markMayRest({ ...base, next: 1_000_600 }), false);
  assert.equal(markMayRest({ ...base, ageSec: 50 }), false);
  assert.equal(markMayRest({ ...base, seasoned: false }), false);
  assert.equal(markMayRest({ ...base, maxAgeSec: 60 }), false);
  assert.equal(markMayRest({ ...base, skipBps: 0 }), false);
  // A mark is never left past max age, whatever the refresh setting says.
  for (let age = 0; age < 200; age++) {
    for (const maxAgeSec of [30, 60, 90, 120]) {
      if (markMayRest({ ...base, ageSec: age, maxAgeSec, refreshSec: 1_000 })) {
        assert.ok(age + base.nextPassSec + 20 < maxAgeSec);
      }
    }
  }
  console.log("read-cache: ok");
})().catch((e) => { console.error(e); process.exit(1); });
