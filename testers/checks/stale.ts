/*
 * Markets that should not take an order: paused (close only), or priced off
 * a mark older than the market allows. Every STALE_EVERY_MIN minutes, from
 * /api/markets: each paused market, and each whose priceAgeMs is past 80%
 * of maxPriceAgeSec, at most three, are opened as a connected persona
 * (STALE_PERSONA) at desktop size. The header should flag the feed's age (or
 * the pause), and the ticket should refuse to place an opening order and
 * say why under its button. A market that has caught up by the time its
 * page is open is a pass. With none in that state, the run records a pass
 * and stops.
 */
import type { Browser } from "playwright-core";
import { config } from "../config";
import { submitButton, ticket, ticketNote } from "../journeys/common";
import type { Market } from "../session";
import { api, asPersona, persona } from "./common";

const staleNow = (m: Market) => m.priceAgeMs != null && m.priceAgeMs / 1000 > m.maxPriceAgeSec;

export async function run(browser: Browser): Promise<{ ok: boolean; summary: string }> {
  const list = (await api<Market[]>("/api/markets")) ?? [];
  const near = list.filter((m) => !m.hidden && (m.paused || (m.priceAgeMs != null && m.priceAgeMs / 1000 >= m.maxPriceAgeSec * 0.8)));
  if (!near.length) return { ok: true, summary: `stale: none of ${list.length} markets paused or near stale, pass` };
  const pick = near.sort((a, b) => Number(!!b.paused) - Number(!!a.paused) || (b.priceAgeMs ?? 0) - (a.priceAgeMs ?? 0)).slice(0, 3);
  const notes: string[] = [];
  let bad = 0;
  const r = await asPersona(browser, persona(config.stalePersona), "stale", config.checkTimeoutMs - 30_000, async (ctx) => {
    for (const m0 of pick) {
      const sym = m0.symbol;
      await ctx.step("open /trade/:sym", () => ctx.goto(`/trade/${encodeURIComponent(sym)}`,
        (p) => p.getByRole("button", { name: /^(Place (long|short)|Connect wallet)/ })));
      await ctx.connect();
      await ctx.step(`check ${sym} refuses orders`, async () => {
        await ctx.page.waitForTimeout(2_500);
        // The state the page should be showing now, not when the run began.
        const m = ((await api<Market[]>("/api/markets")) ?? []).find((x) => x.symbol === sym);
        if (!m) { notes.push(`${sym} gone`); return; }
        const stale = staleNow(m);
        if (!stale && !m.paused) { notes.push(`${sym} caught up (${Math.round((m.priceAgeMs ?? 0) / 1000)}s of ${m.maxPriceAgeSec}s)`); return; }
        const why = m.paused ? "paused" : `${Math.round(m.priceAgeMs! / 1000)}s old (max ${m.maxPriceAgeSec}s)`;
        const header = await ctx.page.locator("main header").first().innerText().catch(() => "");
        if (stale && !/feed \d+s/i.test(header)) {
          bad++;
          await ctx.rec.issue("stale-unflagged", "medium", `${sym}'s mark is ${why} and the header does not flag the feed`, { key: "stale header" });
        }
        if (m.paused && !/Exits only|paused|close only/i.test(header)) {
          bad++;
          await ctx.rec.issue("stale-unflagged", "medium", `${sym} is paused and the header does not say so`, { key: "paused header" });
        }
        const t = await ticket(ctx, "long");
        const amount = t.getByRole("textbox", { name: "Amount" });
        if (await amount.first().isEditable().catch(() => false)) await ctx.type(amount, "10");
        await ctx.page.waitForTimeout(800);
        const submit = submitButton(t).first();
        const label = await submit.innerText().catch(() => "");
        const enabled = await submit.isEnabled().catch(() => false);
        const note = await ticketNote(t);
        const says = m.paused ? /paused|close only|exits only|reduce/i : /behind|stale|paused|old/i;
        if (enabled && label !== "Connect wallet") {
          bad++;
          await ctx.rec.issue("stale-not-blocked", "high", `${sym} is ${why}, and the ticket's "${label}" is enabled`, { key: m.paused ? "paused open" : "stale open" });
        } else if (!says.test(note)) {
          bad++;
          await ctx.rec.issue("stale-no-reason", "medium",
            `${sym} is ${why}; the ticket blocks the order but says ${note ? `"${note}"` : "nothing"} about why`, { key: m.paused ? "paused reason" : "stale reason" });
        }
        notes.push(`${sym} ${why}: ${enabled ? "OPEN" : `blocked ("${note.slice(0, 60)}")`}`);
      });
    }
    return notes.join("; ");
  });
  return { ok: r.ok && bad === 0, summary: `stale: ${r.note}` };
}
