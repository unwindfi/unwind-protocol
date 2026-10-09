/*
 * Rewards and referrals: the boards, claiming a referral code, arriving by
 * someone's /r/CODE link and naming them as referrer.
 *
 * Codes are the persona's own (`ut-t08`), so a referrer's code is known to
 * the rest of the fleet without any shared state.
 */
import { PERSONAS } from "../personas";
import type { Journey } from "./common";

export const codeOf = (id: string) => `ut-${id}`;

export const rewards: Journey = {
  name: "rewards",
  budgetMs: 150_000,
  wallet: true,
  async run(ctx) {
    const page = ctx.page;
    // Half the time, arrive by a referrer's link first.
    const referrers = PERSONAS.filter((p) => p.role === "referrer" && p.id !== ctx.persona.id);
    const arrive = ctx.persona.role !== "referrer" && ctx.rng.chance(0.5);
    const code = codeOf(ctx.rng.pick(referrers).id);
    if (arrive) {
      await ctx.step("open /r/:code", async () => {
        await ctx.goto(`/r/${code}`, (p) => p.getByPlaceholder("Search ticker or name"));
        const u = new URL(page.url());
        const stored = await page.evaluate(() => localStorage.getItem("unwind.ref")).catch(() => null);
        if (u.pathname !== "/" || u.searchParams.get("ref") !== code) {
          await ctx.rec.issue("referral-link", "high", `/r/${code} landed on ${u.pathname}${u.search}, not /?ref=${code}`, { key: "ref redirect" });
        }
        if (stored !== code) {
          await ctx.rec.issue("referral-link", "high", `/r/${code} did not remember the code (stored: ${stored})`, { key: "ref stored" });
        }
      });
    }

    await ctx.step("open /rewards", () => ctx.goto("/rewards", (p) => p.getByRole("tab", { name: "Leaderboard" })));
    await ctx.step("the boards", async () => {
      await ctx.checkPage();
      const how = page.getByRole("tab", { name: "How it works" });
      if (ctx.rng.chance(0.5)) await ctx.click(how, "How it works");
      await ctx.click(page.getByRole("tab", { name: "Leaderboard" }), "Leaderboard", { expectChange: false });
      await ctx.checkPage();
    });
    await ctx.connect();

    await ctx.step("referrals", async () => {
      await ctx.click(page.getByRole("tab", { name: "Referrals" }), "the Referrals tab");
      // The tab waits on the wallet's rewards read: a code field, or the link.
      const field = page.getByPlaceholder("yourname");
      const copy = page.getByRole("button", { name: /^(Copy|Copied)$/ });
      await ctx.ready(field.or(copy), "the referral panel").catch(async () => {
        await ctx.rec.issue("referral-panel", "medium", "The Referrals tab showed neither a code field nor a link for a connected wallet", { key: "ref panel" });
      });
      if (ctx.persona.role === "referrer" && await field.first().isVisible().catch(() => false)) {
        const mine = codeOf(ctx.persona.id);
        await ctx.type(field, mine);
        // The hint keeps its last state until the server has checked the
        // whole code, so wait for the check's own answer.
        const hint = page.getByText(/^(Available\.|Taken\.)$/);
        await ctx.ready(hint, "the code check").catch(() => undefined);
        const said = await hint.first().innerText().catch(() => "");
        if (said === "Taken.") {
          // Taken by someone else: this persona's own code would show as its link.
          await ctx.rec.issue("referral-code", "low", `Code ${mine} is taken by another wallet`, { key: "code taken", shot: false });
          return;
        }
        const claim = page.getByRole("button", { name: "Claim", exact: true });
        if (await claim.first().isEnabled().catch(() => false)) await ctx.tx("referral-code", () => ctx.click(claim, "Claim"));
        return;
      }
      if (await copy.first().isVisible().catch(() => false)) await ctx.click(copy, "Copy link");
      const set = page.getByRole("button", { name: "Set referrer" });
      if (arrive && await set.first().waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false)) {
        await ctx.tx("set-referrer", () => ctx.click(set, "Set referrer"));
      }
      await ctx.checkPage();
    });
  },
};
