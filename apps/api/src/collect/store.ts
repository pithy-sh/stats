import { chunkRowsByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { type ExpressionBuilder, type Kysely, sql } from "kysely";
import {
  CdnSnapshot,
  Collection,
  Commit,
  DailyDownload,
  DependentSnapshot,
  Issue,
  Package,
  PullRequest,
  RegistrySnapshot,
  RepoSnapshot,
  ScorecardSnapshot,
  type StatsDatabase,
  VersionDownload,
  VersionPublish,
} from "../data/tables";
import type { Day } from "./day";
import type { Dependents, Scorecard } from "./upstream/depsDev";
import type { GitHubCommit, GitHubIssue, GitHubPullRequest, RepoStats } from "./upstream/github";
import type { CdnStats } from "./upstream/jsdelivr";
import type { RegistryFacts, DailyDownload as UpstreamDailyDownload } from "./upstream/npm";

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

/** Every package in the org list captured on `capturedOn`: first seen keeps its day, last seen only moves forward. */
export async function recordPackages(db: StatsDatabase, names: readonly string[], capturedOn: Day): Promise<void> {
  const rows = names.map((name) => Package.encode({ name, firstSeenOn: capturedOn, lastSeenOn: capturedOn }));
  for (const chunk of chunkRowsByBoundParameters(rows, 3)) {
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
