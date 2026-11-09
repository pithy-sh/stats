# Pithy Stats

Downloads, releases, issues and repo numbers for every `@pithy-sh` package, collected once a day and served as JSON. It powers [pithy.sh/stats](https://pithy.sh/stats).

Built with Pithy. Runs on Cloudflare: one Worker, one D1 database, one R2 bucket, and a Workflow a cron starts at 02:00 UTC.

## How it works

1. **Collect.** The daily Workflow reads npm, the npm registry, GitHub, jsDelivr and deps.dev, each in its own retried step.
2. **Keep.** It writes everything to D1, including the per-version counts npm only keeps for seven days.
3. **Publish.** It builds the JSON and writes `latest.json` and a dated snapshot to R2.
4. **Serve.** A request reads one R2 object, cached until 02:05 UTC, with an ETag.

## Develop

```bash
bun install
bun run dev
bun run typecheck && bunx biome check . && bun run test
```

## License

MIT.
