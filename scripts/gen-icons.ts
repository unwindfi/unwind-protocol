/// Builds `app/icons.svg`, a sprite of the icons the UI uses.
///
/// Lucide (ISC) rather than emoji: emoji render as a different glyph on every
/// platform and cannot be recoloured or aligned to the type.
import * as fs from "fs";
import * as path from "path";

const SRC = path.join(__dirname, "..", "node_modules", "lucide-static", "icons");
const OUT = path.join(__dirname, "..", "app", "icons.svg");

const ICONS = [
  "globe", "settings", "search", "star", "chevron-down", "wallet", "x",
  "arrow-up-down", "corner-down-left", "command", "trending-up", "layers",
];

const symbols = ICONS.map((name) => {
  const raw = fs.readFileSync(path.join(SRC, `${name}.svg`), "utf8");
  // Keep only the drawing commands; stroke and size come from CSS.
  const body = raw
    .replace(/<svg[^>]*>/, "")
    .replace(/<\/svg>/, "")
    .replace(/\s+/g, " ")
    .trim();
  return `<symbol id="${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</symbol>`;
}).join("\n");

// A solid star for the "favourited" state, which Lucide only ships outlined.
const starSolid = `<symbol id="star-solid" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.45 6.2 20.5l1.1-6.45-4.7-4.6 6.5-.95z"/></symbol>`;

fs.writeFileSync(OUT,
  `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n${symbols}\n${starSolid}\n</svg>\n`);
console.log(`wrote ${ICONS.length + 1} icons to app/icons.svg`);
