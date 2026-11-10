# Pithy Stats

Downloads, releases, issues and repo numbers for every `@pithy-sh` package, and the tests and code lines in the kit's source, collected once a day and served as JSON. It powers [pithy.sh/stats](https://pithy.sh/stats).

Built with Pithy. Runs on Cloudflare: one Worker, one D1 database, one R2 bucket, and a Workflow a cron starts at 02:00 UTC.

## How it works

1. **Collect.** The daily Workflow reads npm, the npm registry, GitHub, jsDelivr and deps.dev in retried steps: one step per package for every source that is about packages, so a package that fails does not redo the ones that wrote, and one step for each source about the repository. Daily downloads re-fetch the last three days, or back to the day after the newest day held when a run has missed some, except for a package the collector has not yet collected in full, such as one just added to the org: it gets every day from its registry creation date, no further back than the eighteen months npm keeps, and keeps getting them on each run until one run writes them. Before any of them, the run asks npm which day it has last finished counting, since npm can still be counting yesterday at 02:00 UTC, and no window reaches past that day: a day npm has not counted is never stored or published, and the per-version counts are dated with the seven days npm says they cover, asked again once they are all fetched and once more after that week is recorded: if npm closed a day meanwhile, that day's counts are kept but not published, since which week each covers is not known. A second run on the same day keeps the week the first confirmed unless npm has since closed a day, and a run that falls behind another never undoes the week the newer one confirmed, so a publish while two runs overlap carries the day's version windows, or the newest dated ones before them while the day's week is not yet known. Requests to npm's downloads API go out at least four seconds apart, under the roughly twenty a minute it allows, and a rate-limited answer from any upstream is retried in place with backoff. A step that fails writes why, the URL and status, to the Worker's log, where `wrangler tail` and Workers Logs show it. One more step counts the kit: it resolves the head of `pithy-sh/pithy`'s `main` to a commit, streams that commit's tarball from the GitHub API, and counts the `.ts` and `.tsx` files under `packages/*/src/`. Tests are the `it(` and `test(` calls in test files, each form counting once; code lines are the lines of every other file that are not blank, not only a `//` comment, and not inside a `/* … */` block.
2. **Keep.** It writes everything to D1, including the per-version counts npm only keeps for seven days.
3. **Publish.** Once every source step has finished, it builds `summary.json` and `latest.json` from D1 and writes each to R2 with a dated snapshot beside it. A source that failed is published with its last good data and the time it last succeeded.
4. **Serve.** A request is answered from the edge cache, or from one R2 read, with an ETag, cached until the next file is ready: 15 minutes after the 02:00 UTC run starts, by default. Each file carries `nextUpdate`, the ready time of the run after it; a copy may revalidate sooner, at the current run's ready time or after five minutes while a run is late.

## The API

`https://stats.pithy.sh` in production, `https://stats-staging.pithy.sh` in staging. Every route is a public `GET`, readable from `https://pithy.sh` and `https://staging.pithy.sh` in a browser.

| Route | Returns | Cached |
|---|---|---|
| `/v1/summary` | The home page strip's headline numbers. | Until the next file is ready (five minutes while that file is late), then revalidated for an hour. |
| `/v1/latest` | Everything the `/stats/` page draws. | Until the next file is ready (five minutes while that file is late), then revalidated for an hour. |
| `/v1/snapshots/<YYYY-MM-DD>/summary` | That day's summary. | Until the next file is ready or midnight UTC, whichever is sooner, while the day lasts; then a year, immutable. |
| `/v1/snapshots/<YYYY-MM-DD>/latest` | That day's full file. | Until the next file is ready or midnight UTC, whichever is sooner, while the day lasts; then a year, immutable. |

The next file is taken to be ready `READY_AFTER_MINUTES` after the collector's cron starts a run: 15 minutes after 02:00 UTC, by default. The run start is read off the cron, `COLLECT_CRON` in `apps/api/src/schedule.ts`, which must stay a daily `M H * * *` schedule; `READY_AFTER_MINUTES` is a Worker var in `apps/api/wrangler.jsonc`, set per environment, and a missing or invalid value falls back to 15 and is logged. A file is late once a ready time has passed and it was uploaded before that run started. `nextUpdate` in each file is the time the next run after `generatedAt` is ready. A snapshot published before the field was added lacks it, so the snapshot routes declare it optional.

Every file is served with its R2 object's ETag and `Last-Modified`, and a matching `If-None-Match` answers 304. A path with nothing published answers 404, cached for five minutes. Query strings are ignored, by the response and by the edge cache's key. The shape of each file is in `apps/api/src/contract/stats.ts` and `apps/api/openapi.json`; a source never collected is `null`, never `0`.

## Collect by hand

The cron starts the collector every day under an instance id that is the UTC day it fired for, such as `2026-11-09`, so a second start that day is logged as already started and does not run. Every row is stamped with the UTC day it was fetched, and every write is an upsert on that day, so two runs on one day leave one set of rows and no run rewrites an earlier day's snapshot. A run may overlap another, the cron's included: neither clears the per-version week the other confirmed unless npm closed a day in between. Start a run yourself with `pithy workflow trigger`, naming the job `api/collect` (`bun run pithy workflow list --env <env>` prints it with its Workflow). A trigger without `--id` is named `manual-` and the moment it was asked for, such as `manual-20261109013000000`, never a bare date, so it never takes the day's scheduled run's id; name a run with `--id` to follow it by a name of your choosing, a new one each time, since an id already taken is refused. A failed run's error prints the refill command for its day under an id stamped with when it failed, so following it again after a refill fails is not refused:

```bash
# Refill the daily downloads of the three days before 2026-11-08 (a package not yet collected in full gets its whole history). Every other source is captured as of today.
bun run pithy workflow trigger api/collect --env prod --params '{"date":"2026-11-08"}' --id refill-2026-11-08

# Load daily downloads from the kit's first publish, 2026-09-05. Safe to repeat, under a new id each time.
bun run pithy workflow trigger api/collect --env prod --params '{"backfill":true}' --id backfill-1

# Follow a run.
bun run pithy workflow status api/collect refill-2026-11-08 --env prod
```

`--params` is checked against the job's schema before anything starts, and `--dry-run` shows what would start. In `prod` the command asks a person to type `yes, i really want to trigger prod` first; `staging` starts without asking.

The GitHub and kit steps read a fine-grained, read-only token from the Secrets Store. It is one entry every environment binds: set it once with `bun run pithy secrets create github-token`.

## Develop

```bash
bun install
bun run dev
bun run typecheck && bunx biome check . && bun run test
```

## License

MIT.
