/*
 * One persona, named journeys, once, with the issues printed: for checking a
 * journey after the site changes, without the whole fleet.
 *
 *   DRY_TX=1 BASE_URL=http://localhost:5185 npx ts-node --transpile-only \
 *     -P testers/tsconfig.json testers/try.ts t07 earn list
 */
import { chromium } from "playwright-core";
import { config } from "./config";
import { byName, JOURNEYS } from "./journeys";
import { PERSONAS, loadKeys } from "./personas";
import { Ctx } from "./session";
import * as store from "./store";

async function main() {
  const [id, ...names] = process.argv.slice(2);
  const p = PERSONAS.find((x) => x.id === id);
  if (!p) { console.error(`usage: try.ts <t01..t60> [${JOURNEYS.map((j) => j.name).join("|")} ...]`); process.exit(2); }
  store.open();
  loadKeys();
  const journeys = (names.length ? names : ["browse"]).map((n) => {
    const j = byName(n);
    if (!j) { console.error(`no journey ${n}`); process.exit(2); }
    return j!;
  });
  const browser = await chromium.launch({ headless: config.headless, executablePath: config.chromePath });
  const sid = store.startSession({ persona: p.id, role: p.role, device: p.device.name, theme: p.theme, worker: 0 });
  const ctx = new Ctx(p, sid, 0);
  await ctx.open(browser);
  const seen: string[] = [];
  ctx.rec.onIssue = (t) => { seen.push(`${t} @ ${ctx.rec.route} (${ctx.rec.step})`); };
  console.log(`${p.id} ${p.role} ${p.device.name} ${p.theme} ${ctx.owner}`);
  let failed = 0;
  for (const j of journeys) {
    const t = Date.now();
    ctx.deadline = t + j.budgetMs;
    try {
      await j.run(ctx);
      console.log(`  ${j.name}: ok in ${((Date.now() - t) / 1000).toFixed(1)}s`);
      store.recordJourney({ session: sid, persona: p.id, name: j.name, started: t, ok: true, steps: ctx.steps });
    } catch (e: any) {
      failed++;
      const err = `${ctx.rec.step}: ${String(e?.message ?? e).split("\n")[0]}`;
      console.log(`  ${j.name}: FAILED at ${err}`);
      await ctx.rec.issue("step-failed", "medium", `${j.name} / ${err}`, { key: `${j.name} ${ctx.rec.step}`, detail: String(e?.message ?? e).slice(0, 4000) });
      if (process.env.VERBOSE) console.log(String(e?.message ?? e).split("\n").slice(0, 20).join("\n"));
      store.recordJourney({ session: sid, persona: p.id, name: j.name, started: t, ok: false, error: err, steps: ctx.steps });
    }
  }
  console.log(`  wallet: ${ctx.wallet.log.connects} connects, ${ctx.wallet.log.messages} messages signed, ` +
    `${ctx.wallet.log.signed.length} transactions signed${config.dryTx ? " (dry)" : ""}, ${ctx.wallet.log.refused.length} refused`);
  for (const s of seen) console.log(`  issue: ${s}`);
  for (const t of ctx.rec.toasts) console.log(`  toast [${t.status}] ${t.text.replace(/\n+/g, " / ")}`);
  store.endSession(sid, { ok: failed === 0, passed: journeys.length - failed, failed });
  await ctx.close();
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
