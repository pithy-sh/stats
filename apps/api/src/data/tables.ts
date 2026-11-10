import { SQLiteDate, sqliteJson } from "@pithy-sh/core/src/data/codecs";
import { createDatabase, type DatabaseSchema } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { Day } from "../collect/day";

/**
 * The collector's history, in the app D1. Only the Workflow reads or writes these tables.
 *
 * A source that changes over time keeps two tables: a `*Snapshots` table with one row per subject per day it
 * was captured, and a `*Latest` table with one row per subject holding the newest capture's values. Both
 * share a row schema. Days are UTC `YYYY-MM-DD` text; instants are ms-epoch integers through `SQLiteDate`.
 */

const PackageName = z.string().min(1).describe("An npm package name, scope included.");
const Repo = z
  .string()
  .regex(/^[^/]+\/[^/]+$/)
  .describe("A GitHub repository, `owner/name`.");
const CapturedOn = Day.describe("The UTC day the run that wrote this row fetched it: the day the values were true.");
const Count = z.number().int().nonnegative();
const DependencyMap = z
  .record(z.string().describe("A dependency's name."), z.string().describe("Its version range."))
  .describe("A manifest's dependency map.");

export const Package = z
  .object({
    name: PackageName,
    firstSeenOn: Day.describe("The day the package was first captured in the org's package list."),
    lastSeenOn: Day.describe("The newest day the package was captured in the org's package list."),
    historyCollectedOn: Day.nullable().describe(
      "The day a daily-downloads step first wrote the package's whole history, or null while none has.",
    ),
  })
  .describe("One package the npm org publishes, in `packages`.");
export type Package = z.output<typeof Package>;

export const DailyDownload = z
  .object({
    packageName: PackageName,
    day: Day.describe("The UTC day counted."),
    downloads: Count.describe("Downloads npm counted that day."),
    capturedOn: CapturedOn,
  })
  .describe("One package's downloads on one day, in `daily_downloads`. The newest run's count wins.");
export type DailyDownload = z.output<typeof DailyDownload>;

export const VersionDownload = z
  .object({
    packageName: PackageName,
    version: z.string().min(1).describe("The version counted."),
    capturedOn: CapturedOn,
    downloads: Count.describe("Downloads of this version over the seven days npm reported on the capture day."),
  })
  .describe("One version's seven-day downloads as npm reported them on one capture day, in `version_downloads`.");
export type VersionDownload = z.output<typeof VersionDownload>;

export const VersionPublish = z
  .object({
    packageName: PackageName,
    version: z.string().min(1).describe("The version published."),
    publishedAt: SQLiteDate.describe("When the registry says it was published."),
  })
  .describe("One published version, in `version_publishes`.");
export type VersionPublish = z.output<typeof VersionPublish>;

export const RegistrySnapshot = z
  .object({
    packageName: PackageName,
    capturedOn: CapturedOn,
    latestVersion: z.string().min(1).describe("`dist-tags.latest` on the capture day."),
    description: z.string().nullable().describe("npm's description of the package, or null when it has none."),
    createdAt: SQLiteDate.nullable().describe("When the package was first published, or null when unknown."),
    versionCount: Count.describe("Versions in the registry on the capture day."),
    unpackedSize: Count.nullable().describe("The latest version's unpacked size in bytes, or null."),
    fileCount: Count.nullable().describe("The latest version's file count, or null."),
    dependencies: sqliteJson(DependencyMap).describe("The latest version's runtime dependencies."),
    peerDependencies: sqliteJson(DependencyMap).describe("The latest version's peer dependencies."),
  })
  .describe("The registry's facts for one package on one capture day, in `registry_snapshots` and `registry_latest`.");
export type RegistrySnapshot = z.output<typeof RegistrySnapshot>;

export const RepoSnapshot = z
  .object({
    repo: Repo,
    capturedOn: CapturedOn,
    createdAt: SQLiteDate.nullable().describe(
      "When the repository was created, or null on a row captured before it was read.",
    ),
    stars: Count.describe("Stargazers."),
    forks: Count.describe("Forks."),
    commits: Count.describe("Commits on the default branch."),
    contributors: Count.describe("Contributors, anonymous ones included."),
  })
  .describe("A repository's headline counts on one capture day, in `repo_snapshots` and `repo_latest`.");
export type RepoSnapshot = z.output<typeof RepoSnapshot>;

export const Issue = z
  .object({
    repo: Repo,
    number: z.number().int().positive().describe("The issue number."),
    createdAt: SQLiteDate.describe("When it was opened."),
    closedAt: SQLiteDate.nullable().describe("When it was closed, or null while open."),
    state: z.string().describe("`OPEN` or `CLOSED`."),
    stateReason: z.string().nullable().describe("Why it closed, or null."),
    issueType: z.string().nullable().describe("The issue type's name, or null."),
    labels: sqliteJson(z.array(z.string().describe("A label name."))).describe("Its labels."),
    capturedOn: CapturedOn,
  })
  .describe("One issue as captured on one day, in `issue_snapshots`, and as of the newest capture, in `issues`.");
export type Issue = z.output<typeof Issue>;

export const PullRequest = z
  .object({
    repo: Repo,
    number: z.number().int().positive().describe("The pull request number."),
    createdAt: SQLiteDate.describe("When it was opened."),
    mergedAt: SQLiteDate.nullable().describe("When it merged, or null."),
    closedAt: SQLiteDate.nullable().describe("When it closed, merged or not, or null while open."),
    state: z.string().describe("`OPEN`, `CLOSED` or `MERGED`."),
    additions: Count.describe("Lines added."),
    deletions: Count.describe("Lines deleted."),
    capturedOn: CapturedOn,
  })
  .describe(
    "One pull request as captured on one day, in `pull_request_snapshots`, and as of the newest capture, in `pull_requests`.",
  );
export type PullRequest = z.output<typeof PullRequest>;

export const Commit = z
  .object({
    repo: Repo,
    oid: z.string().min(1).describe("The commit's full SHA."),
    committedAt: SQLiteDate.describe("When it was committed."),
  })
  .describe("One commit reachable from the repository's default branch, in `commits`.");
export type Commit = z.output<typeof Commit>;

export const Collection = z
  .object({
    step: z.string().min(1).describe("The collector step, by its key in `STEPS`."),
    collectedAt: SQLiteDate.describe("When the step last finished without error."),
  })
  .describe("When one collector step last succeeded, in `collections`. A failed step leaves its row as it was.");
export type Collection = z.output<typeof Collection>;

export const CdnSnapshot = z
  .object({
    packageName: PackageName,
    capturedOn: CapturedOn,
    period: z.string().describe("The window jsDelivr totalled over, ending the day before the run."),
    hits: Count.describe("CDN hits over the period."),
    bandwidth: Count.describe("Bytes served over the period."),
    rank: z.number().int().positive().nullable().describe("jsDelivr's rank by hits, or null when unranked."),
  })
  .describe("One package's jsDelivr totals on one capture day, in `cdn_snapshots` and `cdn_latest`.");
export type CdnSnapshot = z.output<typeof CdnSnapshot>;

export const DependentSnapshot = z
  .object({
    packageName: PackageName,
    capturedOn: CapturedOn,
    version: z.string().min(1).describe("The version deps.dev counted dependents of: its default."),
    dependents: Count.describe("All dependents."),
    directDependents: Count.describe("Direct dependents."),
    indirectDependents: Count.describe("Indirect dependents."),
  })
  .describe(
    "One package's deps.dev dependent counts on one capture day, in `dependent_snapshots` and `dependent_latest`.",
  );
export type DependentSnapshot = z.output<typeof DependentSnapshot>;

export const ScorecardSnapshot = z
  .object({
    repo: Repo,
    capturedOn: CapturedOn,
    score: z.number().min(0).max(10).describe("The OpenSSF Scorecard aggregate, 0 to 10."),
    scoredAt: SQLiteDate.describe("When Scorecard computed it."),
  })
  .describe("A repository's OpenSSF Scorecard on one capture day, in `scorecard_snapshots` and `scorecard_latest`.");
export type ScorecardSnapshot = z.output<typeof ScorecardSnapshot>;

export const KitCount = z
  .object({
    repo: Repo,
    capturedOn: CapturedOn,
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .describe("The full SHA of the commit counted: the head of the default branch when the step ran."),
    tests: Count.describe("`it(` and `test(` calls in the test files under `packages/*/src/`."),
    codeLines: Count.describe("Lines holding code in the non-test files under `packages/*/src/`."),
    countedAt: SQLiteDate.describe("When the step counted it."),
  })
  .describe("The kit counted at one commit on one capture day, in `kit_counts`. A re-run of the day replaces it.");
export type KitCount = z.output<typeof KitCount>;

/** Where this app's migrations sort within the app database: after every composed capability's. */
export const APP_MIGRATION_ORDER = 2000;

/** Every table this app owns. camelCase keys; `CamelCasePlugin` writes the snake_case SQL. */
export const statsTables = {
  packages: Package,
  dailyDownloads: DailyDownload,
  versionDownloads: VersionDownload,
  versionPublishes: VersionPublish,
  registrySnapshots: RegistrySnapshot,
  registryLatest: RegistrySnapshot,
  repoSnapshots: RepoSnapshot,
  repoLatest: RepoSnapshot,
  issues: Issue,
  issueSnapshots: Issue,
  pullRequests: PullRequest,
  pullRequestSnapshots: PullRequest,
  commits: Commit,
  collections: Collection,
  cdnSnapshots: CdnSnapshot,
  cdnLatest: CdnSnapshot,
  dependentSnapshots: DependentSnapshot,
  dependentLatest: DependentSnapshot,
  scorecardSnapshots: ScorecardSnapshot,
  scorecardLatest: ScorecardSnapshot,
  kitCounts: KitCount,
};

/**
 * The tables whose rows exist nowhere else once an upstream's window has passed: npm keeps eighteen months
 * of daily downloads and seven days of per-version counts, no upstream keeps yesterday's snapshot, and the kit's
 * counts are kept by the day they were taken, which its history does not record.
 */
export const RETAINED_TABLES = [
  "dailyDownloads",
  "versionDownloads",
  "registrySnapshots",
  "repoSnapshots",
  "issueSnapshots",
  "pullRequestSnapshots",
  "cdnSnapshots",
  "dependentSnapshots",
  "scorecardSnapshots",
  "kitCounts",
] as const satisfies readonly (keyof typeof statsTables)[];

export type StatsDatabase = Kysely<DatabaseSchema<typeof statsTables>>;

/** The typed Kysely over the app D1. */
export function statsDatabase(d1: D1Database): StatsDatabase {
  return createDatabase(d1, statsTables);
}
