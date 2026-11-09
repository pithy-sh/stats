Agent instructions for this project, Pithy's included: @AGENTS.md

# Pithy Stats — coding rules

Download, release and repo stats for the Pithy kit, served as JSON to the `/stats/` page on pithy.sh. **Public, MIT.** Anyone can read this code, so nothing in it is a secret and nothing secret goes in it.

It is **a Pithy app**, built on the kit it measures, exactly as an adopter would build one. Every DX gap hit here is a bug in the kit: file it at `pithy-sh/pithy` through `/fix-kit`, and never work around it silently.

## The shape

- **One Worker, `apps/api`.** No UI. A Hono router composed by `createEntrypoint` serves the JSON API.
- **A daily Workflow does all the collecting.** A cron on its spec starts it at 02:00 UTC; it runs the fetches as steps, writes D1, then builds the JSON and writes it to R2. The instance id is the UTC date, so a day runs once. It stays triggerable by hand for backfills.
- **D1 is internal to the Workflow.** It holds the history: one row per package per day, and the snapshots npm forgets (per-version counts keep seven days upstream). No request handler reads D1.
- **R2 holds what is served.** Each run writes `latest.json` and a dated snapshot. A request reads one R2 object and returns it.
- **Caching is computed per request.** `Cache-Control: max-age` is the seconds from now until 02:05 UTC, plus `stale-while-revalidate`, so every copy expires when the next file is ready. The R2 object's ETag answers `If-None-Match` with a 304. Query strings are ignored, so they cannot bust anything.
- **Upstreams see the Workflow once a day, never a visitor.** npm, the npm registry, GitHub, jsDelivr, deps.dev.

## Toolchain

Bun for everything (`bun install`, `bun run`, `bunx`), never npm or npx. Biome for lint and format. Vitest, with the Workers pool for anything touching D1, R2 or a Workflow. ESM only, TypeScript strict.

## Gates

```bash
bun run typecheck
bunx biome check .
bun run test
```

## Work

The board is the plan: Projects v2 **Stats** in the `pithy-sh` org, driven by `/refine` and `/ship` from the workspace root. `.claude/project.md` holds the facts those skills read. No plan or spec files in this repo.
