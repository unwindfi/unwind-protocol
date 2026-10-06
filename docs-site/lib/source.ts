import { llms, loader } from 'fumadocs-core/source';
import { createElement } from 'react';
import * as Phosphor from '@phosphor-icons/react/ssr';
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
      coverDark: z.string().optional(),
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
    const Icon = (Phosphor as unknown as Record<string, React.ComponentType<{ weight?: string; className?: string }>>)[name];
    if (!Icon) throw new Error(`Unknown sidebar icon: ${name}`);
    return createElement(Icon, { weight: 'duotone', className: 'text-fd-foreground' });
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
