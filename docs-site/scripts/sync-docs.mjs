// Builds the site's content from ../docs, which stays the single source of
// truth. SUMMARY.md sets the order and the groups; each group becomes a folder,
// so pages keep the paths they had on GitBook (/mechanism/auction and so on).
// The output (content/docs, public/assets) is generated and not committed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.resolve(root, '../docs');
const out = path.join(root, 'content/docs');
const assetsOut = path.join(root, 'public/assets');

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// SUMMARY.md: "* [Title](file.md)" items, grouped under "## Group" headings.
// Items before the first group are top level; README.md is the index.
function readSummary() {
  const lines = fs.readFileSync(path.join(src, 'SUMMARY.md'), 'utf8').split('\n');
  const groups = [];
  let current = null;
  for (const line of lines) {
    const group = line.match(/^##\s+(.+?)\s*$/);
    if (group) {
      current = { title: group[1], slug: slugify(group[1]), pages: [] };
      groups.push(current);
      continue;
    }
    const item = line.match(/^\s*[*-]\s+\[(.+?)\]\((.+?\.md)\)/);
    if (!item) continue;
    const [, title, file] = item;
    if (file === 'README.md') continue;
    if (!current) throw new Error(`SUMMARY.md: ${file} sits outside a group`);
    current.pages.push({ title, file, slug: path.basename(file, '.md') });
  }
  return groups;
}

const groups = readSummary();

// Every route a docs file is served at, for rewriting links between pages.
const routes = new Map([['README.md', '/']]);
for (const g of groups) for (const p of g.pages) routes.set(p.file, `/${g.slug}/${p.slug}`);

function rewriteLinks(md, file) {
  return md
    .replace(/\]\((\.gitbook\/assets\/[^)\s]+)\)/g, (_, p) => `](/assets/${path.basename(p)})`)
    .replace(/\]\(([^)\s#]+\.md)(#[^)\s]*)?\)/g, (whole, target, hash = '') => {
      const route = routes.get(path.basename(target));
      if (!route) throw new Error(`${file}: link to ${target} matches no page in SUMMARY.md`);
      return `](${route}${hash})`;
    });
}

// GitBook hints become paragraphs of their own, so the remark plugin in
// lib/remark-hint.mjs can turn the span between them into a Callout.
const spaceHints = (md) =>
  md.replace(/^[ \t]*(\{%\s*(?:hint\s+style="\w+"|endhint)\s*%\})[ \t]*$/gm, '\n$1\n');

// Plain text of the first paragraph after the title, for <meta description>.
function firstParagraph(body) {
  const blocks = body.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const para = blocks.find((b) => !/^(#|\||[*-]\s|\d+\.\s|>|```|\{%|!\[|<)/.test(b));
  if (!para) return undefined;
  return para
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parse(file) {
  let raw = fs.readFileSync(path.join(src, file), 'utf8');
  const meta = {};
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
    raw = raw.slice(fm[0].length);
  }
  const h1 = raw.match(/^#\s+(.+)$/m);
  if (!h1) throw new Error(`${file}: no "# Title" heading`);
  const body = raw.slice(h1.index + h1[0].length);
  return { meta, title: h1[1].trim(), body };
}

function write(file, dest, extra = {}) {
  const { meta, title, body } = parse(file);
  const frontmatter = { title, description: firstParagraph(body), ...extra };
  if (meta.cover) frontmatter.cover = `/assets/${path.basename(meta.cover)}`;
  const yaml = Object.entries(frontmatter)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  const content = spaceHints(rewriteLinks(body, file)).replace(/^\n+/, '');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `---\n${yaml}\n---\n\n${content}`);
}

const json = (dest, value) => fs.writeFileSync(dest, `${JSON.stringify(value, null, 2)}\n`);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

write('README.md', path.join(out, 'index.md'));
let count = 1;
const rootPages = ['index'];
for (const g of groups) {
  const dir = path.join(out, g.slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const p of g.pages) {
    // The sidebar shows the SUMMARY.md label, the page its own heading.
    write(p.file, path.join(dir, `${p.slug}.md`), { sidebarTitle: p.title });
    count++;
  }
  json(path.join(dir, 'meta.json'), { title: g.title, pages: g.pages.map((p) => p.slug) });
  rootPages.push(`---${g.title}---`, `...${g.slug}`);
}
json(path.join(out, 'meta.json'), { pages: rootPages });

fs.rmSync(assetsOut, { recursive: true, force: true });
fs.cpSync(path.join(src, '.gitbook/assets'), assetsOut, { recursive: true });

console.log(`sync-docs: ${count} pages in ${groups.length} groups from ../docs`);
