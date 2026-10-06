// Fails when web/src/lib/errors.ts no longer matches PerpError in
// programs/unwind/src/errors.rs: same variants, same order, same #[msg].
// The order is the custom code (6000 + index), so a reorder is a drift too.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const rsPath = at("../../programs/unwind/src/errors.rs");
const tsPath = at("../src/lib/errors.ts");
if (!existsSync(rsPath)) {
  console.warn("check-errors: errors.rs not found, skipped");
  process.exit(0);
}

const rs = [...readFileSync(rsPath, "utf8")
  .matchAll(/#\[msg\("((?:[^"\\]|\\.)*)"\)\]\s*(\w+),/g)]
  .map(([, msg, name]) => [name, msg]);
const ts = [...readFileSync(tsPath, "utf8")
  .matchAll(/^\s*\["(\w+)", "((?:[^"\\]|\\.)*)", "(?:[^"\\]|\\.)*"\],$/gm)]
  .map(([, name, msg]) => [name, msg]);

const problems = [];
for (let i = 0; i < Math.max(rs.length, ts.length); i++) {
  const [a, b] = [rs[i], ts[i]];
  if (!a) problems.push(`errors.ts has extra ${b[0]} at ${6000 + i}`);
  else if (!b) problems.push(`errors.ts is missing ${a[0]} (${6000 + i})`);
  else if (a[0] !== b[0]) problems.push(`${6000 + i}: errors.rs has ${a[0]}, errors.ts has ${b[0]}`);
  else if (a[1] !== b[1]) problems.push(`${6000 + i} ${a[0]}: #[msg] changed to "${a[1]}"`);
}
if (problems.length) {
  console.error("check-errors: web/src/lib/errors.ts drifted from errors.rs\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`check-errors: ${rs.length} program errors mapped`);
