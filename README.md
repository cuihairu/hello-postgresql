# hello-postgresql

Field notes from a game developer using PostgreSQL: implementation tradeoffs, debugging stories, and observations from real projects. Published with VitePress.

**Read online**: <https://cuihairu.github.io/hello-postgresql/>

中文文档见 [README.zh.md](README.zh.md)。

## Run locally

Requires Node.js 18+ (20+ recommended).

```bash
npm ci                # install deps
npm run docs:dev      # dev server with hot reload
npm run docs:build    # build static site to docs/.vitepress/dist/ (dead-link check fails the build)
npm run docs:preview  # preview the built site
```

> If npm is configured with install scripts disabled (`npm warn install-scripts`) and the build fails on a missing esbuild binary, run `npm rebuild esbuild` and retry.

## Layout

```
Repository root:
├── OUTLINE.md          # editorial outline and progress checklist
└── todo.md             # maintenance ledger with commit evidence

Published site (docs/):
├── index.md            # home
├── knowledge.md        # knowledge map (review track)
├── basics/             # Part 1  Basics (15 pages)
├── database-design/    # Part 2  Database design (14 pages)
├── advanced-sql/       # Part 3  Advanced SQL (18 pages)
├── internals/          # Part 4  Internals (20 pages)
├── indexing/           # Part 5  Indexing (12 pages)
├── performance/        # Part 6  Query tuning (14 pages)
├── operations/         # Part 7  Architecture & deployment (12 pages)
├── security/           # Part 8  Security (8 pages)
├── ecosystem/          # Part 9  Ecosystem & new features (10 pages)
├── tools/              # Part 10 Tooling in practice (8 pages)
├── appendix/           # Appendix (5 pages)
├── .vitepress/
│   ├── config.mts      # site config (base / nav / search / dead-link gate)
│   └── sidebar.json    # authoritative site navigation and route list
└── public/             # favicon / logo
```

Directory page counts above exclude each directory's `index.md`; the sidebar is the authoritative site navigation. `index.md` pages provide topic overviews, while `knowledge.md` is a cross-topic review summary. Update the sidebar when published routes change; do not maintain a second hand-written route list.

## Editorial notes

- One or two core ideas per page, 80–200 lines, body text in Chinese.
- Commands and SQL examples are **reproducible**: full DDL for tables, queries you can paste and run; version differences are called out explicitly (e.g. “since PG 16”).
- Heading structure: a single H1 per page, `##` / `###` inside; same shape as the sister site hello-mysql.
- Every page ends with two blocks: `## 相关页面` (in-site relative links without the `.md` suffix, slugs from `sidebar.json`) and one official-docs link line.
- Fact checking: verify uncertain syntax/parameters/version details against the [official docs](https://www.postgresql.org/docs/current/) before writing them down.

## Deploy

Pushing to `main` triggers GitHub Actions (`.github/workflows/deploy-docs.yml`) to build and publish to GitHub Pages; you can also run it manually via `workflow_dispatch`. This repo does not publish versioned releases.

## License

[CC BY 4.0](./LICENSE)
