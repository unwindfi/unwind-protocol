# unwind docs

The docs site for docs.unwindfi.xyz, built with Fumadocs on Next.js.

Pages are not stored here. `scripts/sync-docs.mjs` reads `../docs` (the
markdown that changes with the program) before every `dev` and `build`:
`SUMMARY.md` sets the sidebar order and groups, each group is a folder, so
pages keep their GitBook paths (`/mechanism/auction`, `/trading/fees`), and
`README.md` is the index. GitBook hints become callouts. The output in
`content/` and `public/assets/` is generated and ignored by git.

## Dev

```sh
npm install
npm run dev        # http://localhost:3000, rerun after editing ../docs
```

## Build

```sh
npm run build      # syncs ../docs, then next build
```

## Deploy

A Vercel project of its own, from this repository:

1. New project, import the repository, Root Directory `docs-site`,
   framework Next.js. Keep "Include files outside the root directory" on,
   since the build reads `../docs`.
2. Add the domain `docs.unwindfi.xyz` under Settings, Domains.
3. At Namecheap, Advanced DNS for unwindfi.xyz: add a CNAME record, host
   `docs`, value `cname.vercel-dns.com`, TTL automatic.

Every push to main redeploys, so a change to `docs/` goes live with the code.
