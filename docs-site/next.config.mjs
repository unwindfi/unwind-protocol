import { createMDX } from 'fumadocs-mdx/next';
import { fileURLToPath } from 'node:url';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The repository root has its own lockfile; this app is built on its own.
  turbopack: { root: fileURLToPath(new URL('.', import.meta.url)) },
  // GitBook served the index at /readme as well.
  async redirects() {
    return [{ source: '/readme', destination: '/', permanent: true }];
  },
};

export default withMDX(config);
