import type { z } from "zod";
import {
  CdnSnapshot,
  Collection,
  Commit,
  DependentSnapshot,
  Issue,
  KitCount,
  PullRequest,
  RegistrySnapshot,
  RepoSnapshot,
  ScorecardSnapshot,
  type StatsDatabase,
  VersionDownload,
  VersionPublish,
} from "../../data/tables";
import type { PublishRows } from "./build";

/** Each stored row decoded through its table's schema: instants back to `Date`, JSON columns back to values. */
function decodeAll<S extends z.ZodType>(schema: S, rows: readonly unknown[]): z.output<S>[] {
  return rows.map((row) => schema.decode(row as z.input<S>));
}

/**
 * Every row the publish step builds from. Only the newest package list counts: a package that has left the org
 * stops being published, and none of its rows reach a kit-wide total.
 */
export async function readPublishRows(db: StatsDatabase, repo: string): Promise<PublishRows> {
  const newest = await db
    .selectFrom("packages")
    .select((eb) => eb.fn.max("lastSeenOn").as("day"))
    .executeTakeFirst();
  const listDay = newest?.day ?? null;
  const packages =
    listDay === null
      ? []
      : (await db.selectFrom("packages").select("name").where("lastSeenOn", "=", listDay).execute()).map(
          (row) => row.name,
        );
  const listed = new Set(packages);
  const current = <T extends { packageName: string }>(rows: T[]): T[] =>
    rows.filter((row) => listed.has(row.packageName));
  const repoRow = await db.selectFrom("repoLatest").selectAll().where("repo", "=", repo).executeTakeFirst();
  const scorecardRow = await db.selectFrom("scorecardLatest").selectAll().where("repo", "=", repo).executeTakeFirst();

  return {
    packages,
    dailyDownloads: current(
      await db.selectFrom("dailyDownloads").select(["packageName", "day", "downloads"]).execute(),
    ),
    versionDownloads: current(
      decodeAll(VersionDownload, await db.selectFrom("versionDownloads").selectAll().execute()),
    ),
    versionPublishes: current(decodeAll(VersionPublish, await db.selectFrom("versionPublishes").selectAll().execute())),
    registry: current(decodeAll(RegistrySnapshot, await db.selectFrom("registryLatest").selectAll().execute())),
    repo: repoRow === undefined ? null : RepoSnapshot.decode(repoRow as z.input<typeof RepoSnapshot>),
    issues: decodeAll(Issue, await db.selectFrom("issues").selectAll().where("repo", "=", repo).execute()),
    pullRequests: decodeAll(
      PullRequest,
      await db.selectFrom("pullRequests").selectAll().where("repo", "=", repo).execute(),
    ),
    commits: decodeAll(Commit, await db.selectFrom("commits").selectAll().where("repo", "=", repo).execute()),
    cdn: current(decodeAll(CdnSnapshot, await db.selectFrom("cdnLatest").selectAll().execute())),
    dependents: current(decodeAll(DependentSnapshot, await db.selectFrom("dependentLatest").selectAll().execute())),
    scorecard:
      scorecardRow === undefined ? null : ScorecardSnapshot.decode(scorecardRow as z.input<typeof ScorecardSnapshot>),
    collections: decodeAll(Collection, await db.selectFrom("collections").selectAll().execute()),
    kitCounts: decodeAll(
      KitCount,
      await db.selectFrom("kitCounts").selectAll().where("repo", "=", repo).orderBy("capturedOn").execute(),
    ),
  };
}
