# Project card — `pithy-sh/stats`

Read by the shared `/refine` and `/ship` skills in the workspace root (`../.claude/skills/`). **The process lives in the skill; the facts about this repo live here.** When a skill says "read the project card", this is the file.

## Identity

- **Repo:** `pithy-sh/stats` — public, MIT. A deployed Pithy app; nothing here is published to npm.
- **Board:** Projects v2, org `pithy-sh`, title **Stats** — project **#6**, id `PVT_kwDOEV7hPs4Bq5lV`.
- **Status field id:** `PVTSSF_lADOEV7hPs4Bq5lVzhpOoSo` — options `Inbox · Ready · In Progress · Done`.
- **Voice:** `../marketing/reference/writing-voice.md` is binding, here as on the site.

## Issue sections beyond the shared template

- **Kit dependencies** — any `pithy-sh/pithy` issues this needs, as `pithy-sh/pithy#N`. Empty when none. **A Kit dependency must be closed, and released to npm, before this can ship**: the app consumes the kit from npm by range, exactly as an adopter does. Check it; do not assume.
- **Site** — `N/A`, or what this changes on pithy.sh. The `/stats/` page lives in `../pithy-sh/raw-content`, not here, and reads this repo's JSON API. A change to the JSON's shape names the page change it needs.

**There is no Release note and no Change type.** Nothing here is versioned or published; a deploy is the release.

## The cross-repo rule

**A kit bug belongs in the kit.** If refining or shipping surfaces a defect or gap in `@pithy-sh/*`, file it at `pithy-sh/pithy` and reference it under **Kit dependencies**. Do not patch the kit from here and do not work around it silently. `/fix-kit` drives that path.

## Shipping

No changeset and no version. Squash-merge to `main` once the gates are green.

## Release

None yet. Staging and production deploy with `pithy deploy --env staging|prod`; there is no tag or release record. When there is, it goes here, and `/release` refuses until it does.

## Docs

`/update-docs` assesses each of these and edits what a change made wrong.

- **Repo docs:** `README.md`, and `CLAUDE.md` when a convention changed.
- **The site:** `/stats/` on pithy.sh, in `../pithy-sh/raw-content`, whenever the JSON API's shape or meaning changes.

## Isolation

`bun run pithy feature create <slug> --issue <N>` from the main checkout, `bun run pithy feature destroy --local-only` from inside the worktree. Never a hand-rolled worktree script: only the CLI frees the port block.

## Review emphasis

The repo is public and the API is public. Every review checks: no token or credential in code, config or logs; upstream tokens (GitHub) live in Secrets Store or Worker secrets only; no request path reads D1 or calls an upstream; every response is cached and cannot be busted by a query string.

## Gates

```bash
bun run typecheck
bunx biome check .
bun run test
```
