# hello-postgresql Directory and Content Organization Audit (2026-10-19)

## Scope and Method

A read-only inspection of the repository layout, Markdown statistics, the VitePress configuration, the sidebar, and local Markdown links; the only file added by this review is this report. Page counts and `wc -l` line counts per first-level subdirectory follow `docs/<first-level-directory>/*.md` and exclude `docs/` root pages, configuration, static assets, and this report. The numbering check covers filename prefixes and the section numbering of the main directory entry titles and sidebar sections — not ordered-list numbering inside the prose.

## Quantitative Facts

### Page Volume per First-Level docs Directory

| Directory | .md count | Total lines |
|---|---:|---:|
| advanced-sql | 19 | 2,911 |
| appendix | 6 | 612 |
| basics | 16 | 2,345 |
| database-design | 15 | 1,935 |
| ecosystem | 11 | 1,185 |
| indexing | 13 | 1,805 |
| internals | 21 | 2,537 |
| operations | 13 | 1,826 |
| performance | 15 | 1,952 |
| security | 9 | 1,045 |
| tools | 9 | 1,023 |
| **Total (11 directories)** | **147** | **19,176** |

In addition there are `docs/index.md` (the home page) and `docs/knowledge.md` (the review map), so `docs/` currently holds 149 Markdown pages (excluding this report). The "15/14/18..." figures in the README count prose pages and exclude each directory's `index.md`; the counts match that convention, see `README.zh.md:28-38`.

### Parallel Organization Axes

Counted by how a reader reaches content, there are **4 parallel organization schemes**. The first three are complementary entry points and the fourth is a maintenance/review index; they are not four competing complete taxonomies.

| Directory / entry | Item count | Naming pattern | Numbered? | Numbering continuous? |
|---|---:|---|---|---|
| The ten main topic directories plus the appendix (`docs/basics/` through `docs/appendix/`) | 147 pages across 11 directories | English kebab-case slugs; an `index.md` guide per directory, the rest named by topic | Directories unnumbered; entry titles carry "Part N" | 1–10 continuous, with no gaps or repeats; the appendix being unnumbered is expected |
| Section/topic navigation (`.vitepress/sidebar.json`) | 12 top-level groups (10 parts + appendix + knowledge), 148 links | Chinese display titles mapped to topic slugs; groups ordered for teaching | Main body prefixed "Part 1–10" | Continuous; the appendix and knowledge map are non-chapter supplements |
| Guide/quick-reference entries (each directory's `index.md`, the home page) | Home 1 + 11 directory guides | `index.md` as the fixed entry; prose titles describe the part | The 10 main part guides are numbered; security and others | Same sequence as the main line |
| Review map/outline ledger (`docs/knowledge.md`, root `OUTLINE.md`, `todo.md`) | 1 site knowledge map + 1 outline of 136 items + 1 task ledger | Topic summaries, a production checklist, and audit state, organized separately | The knowledge map has local numbering; the outline has progress entries; todo is by status | Not part of the chapter numbering sequence; entry numbers are not page slugs |

Separate API or history directories/page groups: **none found**. `history` appears only as a PostgreSQL concept in the basics introduction and is not a documentation axis (`docs/basics/index.md:5`).

### Numbering and Filenames

- Filename prefix spot check: **no Markdown file starts with a digit**, so there are no page-level numbering gaps, skips, or duplicates.
- Main section numbering appears in `docs/.vitepress/sidebar.json:3-218` and the first line of each `index.md`: Parts 1 through 10 each appear exactly once and in sequence; the appendix and knowledge map being unnumbered are reasonable exceptions.
- Nothing supports "the numbering system is chaotic". The numbering risk is mainly that writing numbers into filenames in the future would conflict with the current stable slug convention — not an existing defect.

### Sidebar Reconciliation

Parsing the 148 links of `docs/.vitepress/sidebar.json` and matching them under VitePress directory-index/clean-URL rules:

| Category | Count | First 10 entries |
|---|---:|---|
| Configured but no file exists | 0 | none |
| File exists but not in the sidebar | 1 | `docs/index.md` (the home page, expected to be served by the home route; after this report was added it also stayed out of the sidebar, unpublished by request) |

`docs/knowledge.md` is at the end of the sidebar (`docs/.vitepress/sidebar.json:215-218`). This report is a review-added page and is not yet configured into the sidebar — the expected state for a review artifact.

### Dead-Link Verification

- Local Markdown link scan: across the 149 existing documents, **no missing local targets were found (0)**. The script checked relative paths, site-root paths, and `.md`/directory-index targets; it does not cover external availability or heading-anchor semantics.
- VitePress build dead-link check: **not verified**. Running `npm run docs:build` failed to start because the repository has no `node_modules` and the shell reports `vitepress: not found`. The configuration explicitly sets `ignoreDeadLinks: false` (`docs/.vitepress/config.mts:10`); once dependencies are installed, a real build can re-check this.
- Every sidebar file target exists, which corroborates the local link scan but does not replace a full build.

### Stray and Duplicate Entries at the Root

- The root has `README.md` and `README.zh.md`, the English/Chinese descriptions respectively — a deliberate bilingual pair, not a duplicate README; both maintain the directory statistics in sync (for example `README.md:23-44`, `README.zh.md:22-45`).
- `OUTLINE.md` (a 136-item knowledge outline) and `todo.md` (an inspection ledger) are maintenance material, not published pages; keeping them at the repository root helps contributors read them.
- The `docs/` top level additionally has `index.md` and `knowledge.md`, two entries with different purposes; they are not duplicate files, but the home page, the knowledge review page, and section navigation form multiple entry points whose purposes need to be stated.
- No temporary files or backup Markdown found at the root. `package.json`, the lockfile, LICENSE, and the GitHub workflows are all required project files.

## Issue List and Findings

Severity: high = affects accessibility/the build or the main task; medium = keeps adding getting-lost/maintenance cost; low = local inconsistency or stale copy.

| ID | Severity | Issue and evidence | Finding |
|---|---|---|---|
| S1 | Medium | The same content carries two naming layers: the sidebar's "Part 4: Internals" maps to the `internals/` directory, navigation uses a chapter sequence like "Basics/Database Design", and disk storage is by topic. Evidence: `docs/.vitepress/sidebar.json:3-218`, `docs/internals/index.md:1`. | This one needs its relationships explained, but chapter order and topic directories do not actually conflict; there is no need to push numbering into filenames. Recommendation: keep the primary/secondary pair of "topic directories for storage + chapter navigation for ordering". |
| S2 | Medium | Content at different depths or for different tasks around one concept is spread across directories: psql lives in `docs/basics/psql-getting-started.md`, `docs/tools/psql-advanced.md`, and `docs/appendix/psql-meta-command-reference.md`; replication in `docs/internals/streaming-replication-and-sync.md`, `docs/operations/streaming-replication-setup.md`, and `docs/operations/logical-replication-ops.md`; indexing appears in both `docs/indexing/` and the performance part, and the design part has further partitioning/index pages. | Topically related is not duplicated: the getting-started/operations/quick-reference split is sound; the gap is a conspicuous cross-part roadmap. Add cross-navigation first; do not merge prose outright. |
| S3 | Low | Mixed language, casing, and abbreviation styles in slugs/titles: `docs/tools/schema-migration-tools.md` (schema), `docs/internals/checkpoint-and-buffer.md` (checkpoint/buffer), `docs/internals/join-implementations.md` (join), `docs/advanced-sql/jsonb-operations.md` (jsonb), alongside combined styles like `docs/tools/pgadmin-4.md` and `docs/advanced-sql/cte-and-non-recursive-with.md`; the README rules mandate kebab-case but say nothing about term casing or language (`README.zh.md:49-55`). | URL slugs are in fact uniformly lowercase English kebab-case; the differences are mostly in display titles/technical terms, not chaotic directory names. A glossary is enough; bulk-renaming slugs risks breaking external links. |
| S4 | Low | The README's page-count convention does not say whether `index.md` files are included: the README says basics 15 pages and database-design 14, while the directory totals including guides are 16 and 15; of the sidebar's 148 links, 12 are directory/knowledge-map entries and the remaining 136 are prose pages, so the README's "136 pages" has its own basis. Evidence: `README.zh.md:28-44`, `docs/.vitepress/sidebar.json:1-219`. | Not a counting error, but the counting convention is not stated explicitly; label it "prose pages, excluding index/home/knowledge map" rather than recounting. |
| S5 | Low | Some directory guides end with automatic backlinks to neighboring parts or same-named indexes, for example `docs/tools/index.md:18-21` links ecosystem/index and `docs/basics/index.md:25-28` links advanced-sql/index, which can mislead readers as "related pages". | The link targets exist, so they are not dead links; this is a navigation-semantics/auto-generated-relation accuracy issue — review the rest of the directory pages in bulk before deciding. |
| S6 | Low | The top-level home page, the knowledge review map, and the eleven directory indexes are all legitimate entries, but the README puts `docs/` pages and root planning material into the same tree-shaped code block, so readers may think `OUTLINE.md`/`todo.md` live inside docs. Evidence: `README.md:23-44`, `README.zh.md:22-45`. | Slightly muddled presentation, not actual directory mixing. Present the repository root and the site content separately. |

### What Is in Fact Fine and Should Not Be Touched

- The 11 topic directories use lowercase English kebab-case and page slugs carry no numeric prefix; stable and predictable, well suited to URLs and site generation.
- The ten teaching parts run 1–10 continuously and all 148 sidebar targets exist; no numbering gaps, duplicate sections, or sidebar-missing pages.
- Every topic directory has an `index.md` guide and prose files are named by knowledge topic; the README also states "each part's entry is index.md" (`README.zh.md:47`).
- `appendix` separately holds the glossary, command quick references, troubleshooting, and reference material — lookup content properly kept apart from sequential-learning prose; security/ecosystem and the other topics have clear boundaries too.
- The English/Chinese READMEs are language versions, not duplicates; `OUTLINE.md` and `todo.md` are contributor maintenance material and should not be folded into the published site directory.
- `knowledge.md` is a cross-topic review view whose entries link back into the prose (`docs/knowledge.md:3-20`); it is an index, not a second copy of the facts, and should not be deleted.

## Findings and Recommendations

There are currently **4 organization axes**; the recommendation is to converge on **2 reader-facing schemes + 1 maintenance ledger**:

1. Keep only "topic directories + continuous chapter navigation" as the primary organization: directories own content placement and stable paths; the sidebar and each directory's `index.md` own learning order.
2. Keep the horizontal entries — home page, knowledge map, appendix — but name them explicitly "Start Reading / Review Map / Reference Tools" so they are not mistaken for competing taxonomies.
3. Keep `OUTLINE.md` and `todo.md` at the repository root as maintenance indexes; do not interleave them with site pages.

At this stage, large-scale renames or directory moves are not advised: there is no evidence of structural breakage; the gains come from navigation wording, counting conventions, and cross-link semantics. Actually "merging into one scheme" would sacrifice the review/quick-reference purposes, and the payoff is smaller than the link and discovery costs.

## Three-Phase Convergence Plan

| Phase | Action list | Blast radius | Risk (links/search/external links) | Author's call |
|---|---|---|---|---|
| Phase 1: mechanical tidy-up (under 1 hour) | Fix the directory page counts/totals in both READMEs; present repository-root files and the `docs/` tree separately; add one README sentence "topic directories are the storage structure, the sidebar is the learning order, knowledge is the review entry"; unify the term-casing rule description without changing slugs. | `README.md`, `README.zh.md`; no prose or configuration touched. | Low; wording only, changing no page paths, search index, or external links. | **Needs a call**: whether the READMEs stay bilingual-in-sync; recommend maintaining both together. |
| Phase 2: navigation tidy-up | Fix the misleading "related pages" links on the guide pages; add explicit getting-started → advanced → operations/quick-reference paths for multi-location topics like psql/replication/indexing; bring this audit and later maintenance pages into the sidebar or explicitly unpublish them. If slugs change, configure VitePress redirects/compat pages and verify old links. | Several directories' `index.md`, `docs/.vitepress/sidebar.json`, possibly VitePress redirect configuration. | Medium; sidebar order affects discovery and on-site search ranking; slug/redirect changes affect external links and search indexing. | **Must be decided**: whether to publish the audit report, where horizontal topic entries sit in the sidebar, and whether legacy-URL redirects may be added. |
| Phase 3: deep restructuring | Compare page by page for genuine duplication and merge duplicated prose into a single authoritative page; keep the other purpose pages as summaries/links; reassign chapter ownership and adjust the sidebar if needed; create a redirect for every migrated old slug and check external links. | Many prose pages under `docs/`, the sidebar, possibly redirects; the outline and both READMEs kept in sync. | High; search results, citations, and external links churn easily, and merging prose can take away paths readers know — link mapping and build checks are mandatory. | **Must be decided**: whether chapter migrations/prose merges are acceptable, which page is authoritative, how long old URLs survive, and the search migration strategy. |

## Conclusion: The Three Things to Do First

1. In both READMEs, label "136 prose pages exclude each directory's index", and mark repository-root maintenance files separately from the site directories.
2. Fix the semantically unrelated links among the automatic backlinks on directory pages; review all 11 indexes first, then change only the items with clear evidence.
3. Add a clear learning/operations/quick-reference path for cross-part topics like psql, replication, and indexing; keep slugs unchanged and solve discovery with links first.

**Limit**: dependencies were not installed for this review, so the production VitePress build and builder-level dead-link validation remain unverified; the local Markdown path scan found 0 missing.

## Stage B: Group-by-Group Cross-Axis Content Verdicts (2026-10-19)

The verdicts below compare what the prose actually says. A "genuine duplicate" requires the same fact to be maintained with the same duty in two pages, such that changing one stales the other; summary references, quick-reference extracts, and different operational tasks do not count automatically.

| Topic group | Verdict and action | Textual evidence from both places |
|---|---|---|
| psql getting started, advanced psql, psql meta-command quick reference | Different angles; keep and cross-link; do not merge. The first is connections and high-frequency meta-commands, the second focuses on scripting automation and advanced capabilities, and the appendix is a by-purpose lookup. | `docs/basics/psql-getting-started.md:3` says it "picks only the high-frequency uses" and links the full meta-command reference; `docs/tools/psql-advanced.md:3` defines the page as automation with variables, `\\gexec`, and `\\watch`; `docs/appendix/psql-meta-command-reference.md:3` explains it is grouped by purpose for lookup. The three carry the getting-started, advanced, and lookup duties. |
| Streaming and synchronous replication, streaming replication setup, logical replication operations | Different angles; keep and cross-link; do not merge. The first two explain physical replication semantics and physical replication setup respectively; the third handles day-to-day operations of logical replication. | `docs/internals/streaming-replication-and-sync.md:3` focuses on the process chain, `synchronous_commit`, degradation risk, and standby conflicts; `docs/operations/streaming-replication-setup.md:3` declares itself a setup manual including `pg_basebackup` and replication slots; `docs/operations/logical-replication-ops.md:3` focuses on logical replication setup, DDL, conflicts, and monitoring. The principles page and the setup page already cross-link. |
| Index selection, performance verification | Different angles; keep and cross-link; do not merge. The former chooses an access method by the shape of the predicate; the latter is execution-plan reading and diagnosis. | `docs/indexing/index-selection-decision-tree.md:3` picks the AM by the shape of the query condition; `docs/performance/explain-basics.md:3` introduces how EXPLAIN presents the plan and links the deeper ANALYZE/BUFFERS page. The selection page already links the BUFFERS verification note. |

This round confirmed **0** genuine duplicate groups and **3** topic groups kept as different angles. The short summary lines in the knowledge map do not count as duplicated prose: `docs/knowledge.md:3` states explicitly that entries keep only conclusions while derivations and examples live in the prose — its duty is a review index, not a second statement of the facts.
