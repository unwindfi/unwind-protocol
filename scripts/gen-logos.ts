/// Writes the ticker logos the UI picks up from `app/logos/<SYMBOL>.svg`.
///
/// Marks come from `simple-icons`, whose icon files are CC0. The trademarks
/// themselves remain the property of their owners — this is a local demo, and
/// shipping it anywhere real is a question for whoever owns the deployment.
///
/// Colours are lifted from each brand but brightened where the official value
/// is too dark to read on this UI's background (Apple's black, most obviously).
import * as fs from "fs";
import * as path from "path";
import * as si from "simple-icons";

// Written into the web app's `public/`, not straight into `app/`: Vite copies
// public/ into whatever it is building to, so the same files land in `app/logos`
// for the local server and in `dist/logos` for a static deploy. Writing to
// `app/` only would leave the deployed page falling back to monograms.
const OUT = path.join(__dirname, "..", "web", "public", "logos");
fs.mkdirSync(OUT, { recursive: true });

const wrap = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>\n`;

const fromIcon = (icon: any, color: string) =>
  wrap(`<path fill="${color}" d="${icon.path}"/>`);

const marks: Record<string, string> = {
  // Apple's mark is pure black; on a dark UI it has to be inverted to read.
  AAPLx: fromIcon(si.siApple, "#f5f5f7"),
  NVDAx: fromIcon(si.siNvidia, "#76b900"),
  TSLAx: fromIcon(si.siTesla, "#e82127"),
  // SPY is an ETF, not a consumer brand, and has no icon in the set. An index
  // glyph is both honest and clearer than a wordmark at 24px.
  SPYx: wrap(
    `<path fill="none" stroke="#5b9dff" stroke-width="2.1" stroke-linecap="round"
       stroke-linejoin="round" d="M2.5 16.8l5.2-5.6 4 3.4 6.1-7.3"/>` +
    `<path fill="#5b9dff" d="M17.1 4.9h4.4v4.4l-1.7-1.7-2.4 2.9-1.6-1.4 2.4-2.9z"/>` +
    `<path fill="none" stroke="#5b9dff" stroke-width="1.7" stroke-linecap="round"
       d="M2.5 20.6h19"/>`
  ),
};

for (const [symbol, svg] of Object.entries(marks)) {
  fs.writeFileSync(path.join(OUT, `${symbol}.svg`), svg);
}
console.log(`wrote ${Object.keys(marks).length} logos to app/logos`);
