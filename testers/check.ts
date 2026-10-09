/*
 * One check, once, with what it filed printed: for trying a check after the
 * site changes, without the whole fleet.
 *
 *   DRY_TX=1 npx ts-node --transpile-only -P testers/tsconfig.json testers/check.ts numbers
 *
 * Names: numbers, stale, wallet-edges, links, api-health, deploy (one look
 * at the fingerprints; twice in a row shows whether they are stable), smoke
 * (the deploy smoke pass now, with DEPLOY_PERSONAS), survey <route> (one
 * route's survey captures with the speed and layout checks).
 */
import { chromium } from "playwright-core";
import { config } from "./config";
import { DEVICES } from "./personas";
import * as store from "./store";
import * as checks from "./checks";
import * as apiHealth from "./checks/api-health";
import * as deploy from "./checks/deploy";
import { db } from "./checks/common";
import { capture } from "./survey";

async function main() {
  const [name, arg] = process.argv.slice(2);
  store.open();
  db();
  const since = Date.now();
  const filed = () => store.open().prepare("SELECT type, severity, route, message FROM issues WHERE last_seen >= ? ORDER BY last_seen")
    .all(since) as { type: string; severity: string; route: string; message: string }[];
  if (name === "api-health") {
    const r = await apiHealth.ping();
    console.log(`${r.total - r.failed} of ${r.total} routes fine${r.down ? "; the API looks down" : ""}`);
    for (const x of apiHealth.summary(1).routes) console.log(`  ${x.ok ? "ok  " : "FAIL"} ${x.route} ${x.status} ${x.ms}ms`);
  } else if (name === "deploy") {
    deploy.restore();
    console.log((await deploy.poll()) ?? "no change");
    console.log(store.getMeta("deploy_fingerprint"));
  } else {
    const browser = await chromium.launch({ headless: config.headless, executablePath: config.chromePath });
    try {
      if (name === "smoke") {
        const id = db().prepare("INSERT INTO deploys (t, reason, status, results) VALUES (?,?,?,?)").run(Date.now(), "by hand (check.ts)", "running", "{}").lastInsertRowid;
        const [a, b] = config.deployPersonas;
        console.log(await deploy.runTask(browser, { deploy: Number(id), persona: a, journeys: ["browse", "trade", "list"] }, 0));
        if (b) console.log(await deploy.runTask(browser, { deploy: Number(id), persona: b, journeys: ["rewards", "earn", "trade"] }, 0));
      } else if (name === "survey") {
        const route = arg ?? "/";
        for (const device of [DEVICES.desktop, DEVICES["phone-390"]]) {
          for (const theme of ["dark", "light"] as const) {
            await capture(browser, { route, theme, device });
            const m = db().prepare("SELECT * FROM page_metrics WHERE route = ? AND device = ? AND theme = ? ORDER BY t DESC LIMIT 1").get(route, device.name, theme);
            console.log(`${route} ${device.name} ${theme}`, m);
          }
        }
      } else {
        const c = checks.byName(name);
        if (!c) { console.error(`usage: check.ts <${[...checks.names(), "api-health", "deploy", "smoke", "survey <route>"].join("|")}>`); process.exit(2); }
        const t = Date.now();
        const r = await c.run(browser);
        console.log(`${r.ok ? "ok" : "NOT OK"} in ${((Date.now() - t) / 1000).toFixed(0)}s: ${r.summary}`);
      }
    } finally { await browser.close(); }
  }
  for (const i of filed()) console.log(`  issue [${i.severity}] ${i.type} @ ${i.route}: ${i.message.slice(0, 300)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
