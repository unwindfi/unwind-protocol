import { llms, loader } from 'fumadocs-core/source';
import { createElement } from 'react';
import { icons } from 'lucide-react';
import { docsRoute } from './shared';
import { defineDocs } from 'fumadocs-mdx/macro';
import { applyMdxPreset } from 'fumadocs-mdx/config';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { z } from 'zod';
import { remarkHint } from './remark-hint.mjs';

// content/docs is generated from ../docs by scripts/sync-docs.mjs.
const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema.extend({
      cover: z.string().optional(),
      sidebarTitle: z.string().optional(),
    }),
    mdxOptions: applyMdxPreset({
      remarkPlugins: (v) => [remarkHint, ...v],
    }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  icon(name) {
    if (!name) return;
    if (!(name in icons)) throw new Error(`Unknown sidebar icon: ${name}`);
    return createElement(icons[name as keyof typeof icons]);
  },
  plugins: [
    {
      name: 'unwind:sidebar-title',
      // The sidebar shows the SUMMARY.md label where it differs from the heading.
      transformPageTree: {
        root(node) {
          node.name = 'unwind docs';
          return node;
        },
        file(node, filePath) {
          if (!filePath) return node;
          const file = this.storage.read(filePath);
          const label = file?.format === 'page' && (file.data as { sidebarTitle?: string }).sidebarTitle;
          if (label) node.name = label;
          return node;
        },
      },
    },
  ],
});

export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${await page.data.getText('processed')}`,
});
