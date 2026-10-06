import { createGetUrl } from 'fumadocs-core/source';

export const siteName = 'unwind docs';
export const siteUrl = 'https://docs.unwindfi.xyz';
export const appUrl = 'https://www.unwindfi.xyz/markets';
export const xUrl = 'https://x.com/unwindfi';

// Pages sit at the root, on the paths they had on GitBook.
export const docsRoute = '/';
export const docsContentRoute = '/llms.mdx';

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}
