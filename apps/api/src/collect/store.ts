import { chunkRowsByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { type ExpressionBuilder, type Kysely, sql } from "kysely";
import {
  CdnSnapshot,
  Collection,
  Commit,
  DailyDownload,
  DependentSnapshot,
  Issue,
  KitCount,
  NpmCountedDays,
  Package,
  PullRequest,
  RegistrySnapshot,
  RepoSnapshot,
  ScorecardSnapshot,
  type StatsDatabase,
  VersionDownload,
  VersionPublish,
} from "../data/tables";
import type { Day, DayRange } from "./day";
import type { KitCounts } from "./kit/count";
import type { Dependents, Scorecard } from "./upstream/depsDev";
import type { GitHubCommit, GitHubIssue, GitHubPullRequest, RepoStats } from "./upstream/github";
import type { CdnStats } from "./upstream/jsdelivr";
import type { NpmDays, RegistryFacts, DailyDownload as UpstreamDailyDownload } from "./upstream/npm";

/**
 * Every write the collector makes. Each is an upsert on the table's natural key, so writing the same capture
 * day twice leaves one set of rows, and a retried step rewrites what it wrote before. `capturedOn` is always
 * the day the values were fetched, so no write can put today's numbers under an earlier day.
 *
 * The rows are encoded through their table's Zod schema before they reach SQL, which is where the typing
 * lives; the upsert itself is generic over table and column names, so it runs on an untyped view.
 */

type Row = Record<string, unknown>;
type LooseDatabase = Kysely<Record<string, Row>>;

function loose(db: StatsDatabase): LooseDatabase {
  return db as unknown as LooseDatabase;
}

/** `{ column: excluded.column }` for every column given: an upsert's "take the new row's value". */
function fromExcluded(columns: readonly string[]) {
  return (eb: ExpressionBuilder<Record<string, Row>, string>) =>
    Object.fromEntries(columns.map((column) => [column, eb.ref(`excluded.${column}`)]));
}

/**
 * Insert `rows` into `table`, replacing the non-key columns of any row whose `key` already exists. Chunked
 * under D1's bound-parameter ceiling.
 */
async function upsertRows(
  db: StatsDatabase,
  table: string,
  key: readonly string[],
  rows: readonly Row[],
): Promise<void> {
  const first = rows[0];
  if (first === undefined) return;
  const columns = Object.keys(first);
  const replaced = columns.filter((column) => !key.includes(column));
  for (const chunk of chunkRowsByBoundParameters(rows, columns.length)) {
    await loose(db)
      .insertInto(table)
      .values(chunk)
      .onConflict((oc) => oc.columns(key as string[]).doUpdateSet(fromExcluded(replaced)))
      .execute();
  }
}

/**
 * Write each subject's dated snapshot and, unless a newer capture already wrote it, its latest row. Writing an
 * older capture day therefore never rolls the latest values back.
 */
async function writeSnapshots(
  db: StatsDatabase,
  snapshot: string,
  latest: string,
  key: readonly string[],
  rows: readonly Row[],
): Promise<void> {
  const first = rows[0];
  if (first === undefined) return;
  await upsertRows(db, snapshot, [...key, "capturedOn"], rows);
  const columns = Object.keys(first);
  const replaced = columns.filter((column) => !key.includes(column));
  for (const chunk of chunkRowsByBoundParameters(rows, columns.length)) {
    await loose(db)
      .insertInto(latest)
      .values(chunk)
      .onConflict((oc) =>
        oc
          .columns(key as string[])
          .doUpdateSet(fromExcluded(replaced))
          .where((eb) => eb(`${latest}.capturedOn`, "<=", eb.ref("excluded.capturedOn"))),
      )
      .execute();
  }
}

/**
 * Every package in the org list captured on `capturedOn`: first seen keeps its day, last seen only moves forward, and
 * a new package starts with its history uncollected.
 */
export async function recordPackages(db: StatsDatabase, names: readonly string[], capturedOn: Day): Promise<void> {
  const rows = names.map((name) =>
    Package.encode({ name, firstSeenOn: capturedOn, lastSeenOn: capturedOn, historyCollectedOn: null }),
  );
  for (const chunk of chunkRowsByBoundParameters(rows, 4)) {
    await db
      .insertInto("packages")
      .values(chunk)
      .onConflict((oc) =>
        oc.column("name").doUpdateSet({ lastSeenOn: sql<string>`max(packages.last_seen_on, excluded.last_seen_on)` }),
      )
      .execute();
  }
}

/** One package's daily downloads, fetched on `capturedOn`. A day already stored takes the newer count. */
export async function writeDailyDownloads(
  db: StatsDatabase,
  packageName: string,
  days: readonly UpstreamDailyDownload[],
  capturedOn: Day,
): Promise<void> {
  const rows = days.map((entry) => DailyDownload.encode({ packageName, ...entry, capturedOn }));
  await upsertRows(db, "dailyDownloads", ["packageName", "day"], rows);
}

/** One package's seven-day per-version counts, as npm reported them on `capturedOn`. */
export async function writeVersionDownloads(
  db: StatsDatabase,
  packageName: string,
  counts: Readonly<Record<string, number>>,
  capturedOn: Day,
): Promise<void> {
  const rows = Object.entries(counts).map(([version, downloads]) =>
    VersionDownload.encode({ packageName, version, capturedOn, downloads }),
  );
  await upsertRows(db, "versionDownloads", ["packageName", "version", "capturedOn"], rows);
}

/**
 * Which day npm had last finished counting when asked on `capturedOn`, with no week yet: {@link writeNpmWeek} records
 * that once the day's per-version counts are known to cover it. A later day replaces an earlier one, and an earlier day
 * changes nothing, since a run told of an older day is the stale one. A week already recorded is kept when it ends on
 * the day the row then names, since the counts any run captures for that day cover the same seven days, so a publish
 * running meanwhile still dates them; it is cleared when it does not, since the counts the run told of a later day
 * rewrites cover a later week.
 */
export async function writeNpmDays(db: StatsDatabase, days: NpmDays, capturedOn: Day): Promise<void> {
  const row = NpmCountedDays.encode({ capturedOn, lastDay: days.lastDay, weekStart: null, weekEnd: null });
  const newest = sql<string>`max(${sql.ref("npmDays.lastDay")}, ${sql.ref("excluded.lastDay")})`;
  const keptOrCleared = (column: "weekStart" | "weekEnd") =>
    sql<
      string | null
    >`case when ${sql.ref("npmDays.weekEnd")} = ${newest} then ${sql.ref(`npmDays.${column}`)} else null end`;
  await db
    .insertInto("npmDays")
    .values(row)
    .onConflict((oc) =>
      oc.column("capturedOn").doUpdateSet({
        lastDay: newest,
        weekStart: keptOrCleared("weekStart"),
        weekEnd: keptOrCleared("weekEnd"),
      }),
    )
    .execute();
}

/**
 * The week npm's `last-week` covered on `capturedOn`, which every per-version count captured that day covers. Written
 * only when it ends on the last day recorded for `capturedOn`: a run told of a later day has replaced those counts.
 */
export async function writeNpmWeek(db: StatsDatabase, week: DayRange, capturedOn: Day): Promise<void> {
  await db
    .updateTable("npmDays")
    .set({ weekStart: week.start, weekEnd: week.end })
    .where("capturedOn", "=", capturedOn)
    .where("lastDay", "=", week.end)
    .execute();
}

/** The week recorded for `capturedOn`, which a publish dates that day's per-version counts by; null when none is. */
export async function readNpmWeek(db: StatsDatabase, capturedOn: Day): Promise<DayRange | null> {
  const row = await db.selectFrom("npmDays").selectAll().where("capturedOn", "=", capturedOn).executeTakeFirst();
  if (row === undefined) return null;
  const { weekStart, weekEnd } = NpmCountedDays.decode(row);
  return weekStart === null || weekEnd === null ? null : { start: weekStart, end: weekEnd };
}

/**
 * `capturedOn` has no known week: a run told npm had last counted `lastDay` rewrote per-version counts that day while
 * npm closed a day, so some may cover one week and some the next. Cleared only while the row still names `lastDay`:
 * once a run told of a later day has moved it, that run's own completion dates the counts. The captures stay in D1 and
 * are not published until a run that day confirms a week.
 */
export async function clearNpmWeek(db: StatsDatabase, lastDay: Day, capturedOn: Day): Promise<void> {
  await db
    .updateTable("npmDays")
    .set({ weekStart: null, weekEnd: null })
    .where("capturedOn", "=", capturedOn)
    .where("lastDay", "=", lastDay)
    .execute();
}

/**
 * `capturedOn` no longer has `week`: counts covering another week are about to be written for that day. Cleared only
 * while the row still records `week`, so a week another run has since confirmed stays.
 */
export async function undateNpmWeek(db: StatsDatabase, week: DayRange, capturedOn: Day): Promise<void> {
  await db
    .updateTable("npmDays")
    .set({ weekStart: null, weekEnd: null })
    .where("capturedOn", "=", capturedOn)
    .where("weekStart", "=", week.start)
    .where("weekEnd", "=", week.end)
    .execute();
}

/** One package's registry facts: every version's publish time, and the dated and latest snapshot. */
export async function writeRegistry(
  db: StatsDatabase,
  packageName: string,
  facts: RegistryFacts,
  capturedOn: Day,
): Promise<void> {
  const publishes = facts.versions.map((entry) => VersionPublish.encode({ packageName, ...entry }));
  await upsertRows(db, "versionPublishes", ["packageName", "version"], publishes);
  const row = RegistrySnapshot.encode({
    packageName,
    capturedOn,
    latestVersion: facts.latestVersion,
    description: facts.description,
    createdAt: facts.createdAt,
    versionCount: facts.versions.length,
    unpackedSize: facts.unpackedSize,
    fileCount: facts.fileCount,
    dependencies: facts.dependencies,
    peerDependencies: facts.peerDependencies,
  });
  await writeSnapshots(db, "registrySnapshots", "registryLatest", ["packageName"], [row]);
}

/** The repository's headline counts, dated and latest. */
export async function writeRepo(db: StatsDatabase, repo: string, stats: RepoStats, capturedOn: Day): Promise<void> {
  const row = RepoSnapshot.encode({ repo, capturedOn, ...stats });
  await writeSnapshots(db, "repoSnapshots", "repoLatest", ["repo"], [row]);
}

/** Every issue as GitHub reported it on `capturedOn`, dated and latest. */
export async function writeIssues(
  db: StatsDatabase,
  repo: string,
  issues: readonly GitHubIssue[],
  capturedOn: Day,
): Promise<void> {
  const rows = issues.map((issue) => Issue.encode({ repo, ...issue, capturedOn }));
  await writeSnapshots(db, "issueSnapshots", "issues", ["repo", "number"], rows);
}

/** Every pull request as GitHub reported it on `capturedOn`, dated and latest. */
export async function writePullRequests(
  db: StatsDatabase,
  repo: string,
  pullRequests: readonly GitHubPullRequest[],
  capturedOn: Day,
): Promise<void> {
  const rows = pullRequests.map((pullRequest) => PullRequest.encode({ repo, ...pullRequest, capturedOn }));
  await writeSnapshots(db, "pullRequestSnapshots", "pullRequests", ["repo", "number"], rows);
}

/** Every commit on the default branch. A commit is written once and never changes, so a re-run rewrites the same rows. */
export async function writeCommits(db: StatsDatabase, repo: string, commits: readonly GitHubCommit[]): Promise<void> {
  const rows = commits.map((commit) => Commit.encode({ repo, ...commit }));
  await upsertRows(db, "commits", ["repo", "oid"], rows);
}

/** That collector `step` finished without error at `at`. */
export async function recordCollected(db: StatsDatabase, step: string, at: Date): Promise<void> {
  await upsertRows(db, "collections", ["step"], [Collection.encode({ step, collectedAt: at })]);
}

/** One package's jsDelivr totals, dated and latest. */
export async function writeCdn(
  db: StatsDatabase,
  packageName: string,
  stats: CdnStats,
  capturedOn: Day,
): Promise<void> {
  const row = CdnSnapshot.encode({ packageName, capturedOn, ...stats });
  await writeSnapshots(db, "cdnSnapshots", "cdnLatest", ["packageName"], [row]);
}

/** One package's deps.dev dependent counts, dated and latest. */
export async function writeDependents(
  db: StatsDatabase,
  packageName: string,
  dependents: Dependents,
  capturedOn: Day,
): Promise<void> {
  const row = DependentSnapshot.encode({ packageName, capturedOn, ...dependents });
  await writeSnapshots(db, "dependentSnapshots", "dependentLatest", ["packageName"], [row]);
}

/** The repository's OpenSSF Scorecard, dated and latest. */
export async function writeScorecard(
  db: StatsDatabase,
  repo: string,
  scorecard: Scorecard,
  capturedOn: Day,
): Promise<void> {
  const row = ScorecardSnapshot.encode({ repo, capturedOn, ...scorecard });
  await writeSnapshots(db, "scorecardSnapshots", "scorecardLatest", ["repo"], [row]);
}

/** The kit's counts at `commit`, taken at `countedAt` on `capturedOn`. A second count on that day replaces the first. */
export async function writeKitCount(
  db: StatsDatabase,
  repo: string,
  commit: string,
  counts: KitCounts,
  capturedOn: Day,
  countedAt: Date,
): Promise<void> {
  const row = KitCount.encode({ repo, capturedOn, commit, ...counts, countedAt });
  await upsertRows(db, "kitCounts", ["repo", "capturedOn"], [row]);
}
