# Pithy Stats

Downloads, releases, issues and repo numbers for every `@pithy-sh` package, collected once a day and served as JSON. It powers [pithy.sh/stats](https://pithy.sh/stats).

Built with Pithy. Runs on Cloudflare: one Worker, one D1 database, one R2 bucket, and a Workflow a cron starts at 02:00 UTC.

## How it works

1. **Collect.** The daily Workflow reads npm, the npm registry, GitHub, jsDelivr and deps.dev, each in its own retried step.
2. **Keep.** It writes everything to D1, including the per-version counts npm only keeps for seven days.
3. **Publish.** It builds the JSON and writes `latest.json` and a dated snapshot to R2.
4. **Serve.** A request reads one R2 object, cached until 02:05 UTC, with an ETag.

## Collect by hand

The cron starts the collector every day under a random instance id. Every row is stamped with the UTC day it was fetched, and every write is an upsert on that day, so two runs on one day leave one set of rows and no run rewrites an earlier day's snapshot. Start a run yourself with `wrangler workflows trigger` against the environment's Workflow, `stats-<env>-api-collect`:

```bash
# Refill the daily downloads of the three days before 2026-11-08. Every other source is captured as of today.
bunx wrangler workflows trigger stats-prod-api-collect '{"date":"2026-11-08"}'

# Load daily downloads from the kit's first publish, 2026-09-05. Safe to repeat.
bunx wrangler workflows trigger stats-prod-api-collect '{"backfill":true}'
```

The GitHub step reads a fine-grained, read-only token from the Secrets Store. Set it once per environment with `bun run pithy secrets create github-token --env staging` and `--env prod`.

## Develop

```bash
bun install
bun run dev
bun run typecheck && bunx biome check . && bun run test
```

## License

MIT.
