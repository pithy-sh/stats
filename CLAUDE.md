Agent instructions for this project, Pithy's included: @AGENTS.md

# Pithy Stats — coding rules

Download, release and repo stats for the Pithy kit, served as JSON to the `/stats/` page on pithy.sh. **Public, MIT.** Anyone can read this code, so nothing in it is a secret and nothing secret goes in it.

It is **a Pithy app**, built on the kit it measures, exactly as an adopter would build one. Every DX gap hit here is a bug in the kit: file it at `pithy-sh/pithy` through `/fix-kit`, and never work around it silently.

## The shape

- **One Worker, `apps/api`.** No UI. A Hono router composed by `createEntrypoint` serves the JSON API.
- **A daily Workflow does all the collecting.** A cron on its spec starts it at 02:00 UTC; it runs the fetches as steps, writes D1, then builds the JSON and writes it to R2. The kit starts each scheduled instance under a random id, so rows are keyed by the UTC day they were captured instead: two runs on one day leave one set of rows. It stays triggerable by hand for backfills. Daily downloads re-fetch the last three days, except for a package no run has yet collected in full: a `download windows` step, before any package's daily-downloads step, gives it the days from its registry creation date (no further back than npm's eighteen months) and journals that choice, and the package stays pending (`packages.history_collected_on` null) until one of its steps writes them, so a package that arrives with history, or a first run that fails, loses no day.
- **D1 is internal to the Workflow.** It holds the history: one row per package per day, and the snapshots npm forgets (per-version counts keep seven days upstream). No request handler reads D1, and `apps/api/src/noRequestReadsD1.test.ts` fails if a module outside `collect/`, `data/` and `migrations/` names the app database.
- **R2 holds what is served.** Each run ends with a publish step that builds `summary.json` and `latest.json` from D1 (`collect/publish/`) and writes each with a dated snapshot. The routes in `serve/` answer each file from the edge cache, keyed by path alone, or on a miss from one R2 read that they then keep at the edge; the JSON's shape lives in `contract/stats.ts`.
- **Caching is computed per request.** `Cache-Control: max-age` is the seconds from now until 02:05 UTC, plus `stale-while-revalidate`, so every copy expires when the next file is ready; once 02:05 has passed with no new file, the run is late and a copy is kept five minutes. A dated snapshot expires at the next 02:05 or at midnight UTC, whichever is sooner, with no stale window, until its day is over, and is immutable from then on; an edge copy taken during the day is never served as immutable, so the first immutable answer is a fresh R2 read. A run that publishes after its day never rewrites an existing snapshot, and a 404 is cached for five minutes. The R2 object's ETag answers `If-None-Match` with a 304, and a malformed `If-None-Match` is ignored. Query strings are ignored, so they cannot bust anything.
- **Upstreams see the Workflow once a day, never a visitor.** npm, the npm registry, GitHub, jsDelivr, deps.dev. Every request goes through `collect/upstream/client.ts`: npm's downloads API is paced (`NPM_API_GAP_MS`, with its measured basis), and a rate-limited answer from any upstream is retried in place before it becomes an `UpstreamError`. A source about packages runs one step per package, named `<source> <package>`, then a step named for the source that records it complete; a failing step logs its error's detail through the kit's Worker logger.
- **Upstream tokens live in the Secrets Store.** Each is declared in `apps/api/src/secret/registry.ts`, set with `bun run pithy secrets create <name>` (`--env <env>` only for one declared `scope: "environment"`), and read with `secretsStore` inside the step that uses it, never returned from a step or logged. Today there is one, `github-token`, declared `scope: "global"`: one entry, `stats-global-github-token`, bound by every environment.

## Toolchain

Bun for everything (`bun install`, `bun run`, `bunx`), never npm or npx. Biome for lint and format. Vitest, with the Workers pool for anything touching D1, R2 or a Workflow. ESM only, TypeScript strict. Every module must load under Node's type stripping, because the `pithy` CLI loads `pithy.config.ts` and everything it imports that way: no parameter properties, no enums, nothing else that needs a transform. `apps/api/src/typeStripping.test.ts` fails on any module that does not strip.

## Gates

```bash
bun run typecheck
bunx biome check .
bun run test
```

CI runs the same three after `bun install --frozen-lockfile`, on every pull request and every push to `main` (`.github/workflows/ci.yml`).

## Work

The board is the plan: Projects v2 **Stats** in the `pithy-sh` org, driven by `/refine` and `/ship` from the workspace root. `.claude/project.md` holds the facts those skills read. No plan or spec files in this repo.
