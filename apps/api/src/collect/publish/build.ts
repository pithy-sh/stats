import {
  CONTRACT_VERSION,
  type Latest,
  type PackageStats,
  SOURCES,
  type Source,
  type Summary,
} from "../../contract/stats";
import type {
  CdnSnapshot,
  Collection,
  Commit,
  DailyDownload,
  DependentSnapshot,
  Issue,
  KitCount,
  PullRequest,
  RegistrySnapshot,
  RepoSnapshot,
  ScorecardSnapshot,
  VersionDownload,
  VersionPublish,
} from "../../data/tables";
import { addDays, type Day, type DayRange, utcDay } from "../day";
import {
  dailySeries,
  mean,
  median,
  minutesBetween,
  mondayOf,
  versionWindows,
  weeklySeries,
  windowSum,
} from "./figures";

/** Everything the publish step reads out of D1: the current package list and every source's newest rows. */
export interface PublishRows {
  /** The packages in the org's newest list, by name. */
  packages: readonly string[];
  dailyDownloads: readonly Pick<DailyDownload, "packageName" | "day" | "downloads">[];
  versionDownloads: readonly VersionDownload[];
  versionPublishes: readonly VersionPublish[];
  /** The newest registry row per package. */
  registry: readonly RegistrySnapshot[];
  /** The repository's newest row, or null before GitHub has been read. */
  repo: RepoSnapshot | null;
  issues: readonly Issue[];
  pullRequests: readonly PullRequest[];
  commits: readonly Commit[];
  /** The newest jsDelivr row per package. */
  cdn: readonly CdnSnapshot[];
  /** The newest deps.dev row per package. */
  dependents: readonly DependentSnapshot[];
  scorecard: ScorecardSnapshot | null;
  collections: readonly Collection[];
  /** The kit's counts for the repository, one per capture day. */
  kitCounts: readonly KitCount[];
}

/** The repository every GitHub figure is about. */
export interface PublishSubject {
  repo: string;
}

/**
 * Which collector steps each source's freshness is made of, by their keys in `STEPS`. A source made of several is
 * as fresh as its stalest.
 */
export const SOURCE_STEPS: Readonly<Record<Source, readonly string[]>> = {
  npm: ["packages", "dailyDownloads", "versionDownloads"],
  registry: ["registry"],
  github: ["github"],
  jsdelivr: ["jsdelivr"],
  depsDev: ["depsDev"],
  scorecard: ["depsDev"],
  kit: ["kit"],
};

/** How many days back jsDelivr's `month` window starts from its capture day. */
const JSDELIVR_DAYS = 30;

const iso = (at: Date): string => at.toISOString();

function sourceTimes(collections: readonly Collection[]): Latest["sources"] {
  const finished = new Map(collections.map((row) => [row.step, row.collectedAt]));
  const entries = SOURCES.map((source) => {
    const times = SOURCE_STEPS[source].map((step) => finished.get(step));
    const known = times.filter((at): at is Date => at !== undefined);
    const stalest =
      times.length === 0 || known.length < times.length
        ? null
        : known.reduce((oldest, at) => (at < oldest ? at : oldest));
    return [source, { collectedAt: stalest === null ? null : iso(stalest) }];
  });
  return Object.fromEntries(entries) as Latest["sources"];
}

function isBug(issue: Issue): boolean {
  return issue.issueType === "Bug" || issue.labels.some((label) => label.toLowerCase() === "bug");
}

const closedAs = (reason: string) => (issue: Issue) => issue.state === "CLOSED" && issue.stateReason === reason;
const completed = closedAs("COMPLETED");
const notPlanned = closedAs("NOT_PLANNED");

function closeMinutes(issues: readonly Issue[]): number[] {
  return issues.flatMap((issue) => (issue.closedAt === null ? [] : [minutesBetween(issue.createdAt, issue.closedAt)]));
}

function earliest(instants: readonly (Date | null)[]): Date | null {
  let first: Date | null = null;
  for (const at of instants) if (at !== null && (first === null || at < first)) first = at;
  return first;
}

function githubFigures(rows: PublishRows, subject: PublishSubject, now: Date): Latest["github"] {
  const { repo, issues, pullRequests, commits } = rows;
  const start = earliest([
    repo?.createdAt ?? null,
    ...commits.map((commit) => commit.committedAt),
    ...issues.map((issue) => issue.createdAt),
    ...pullRequests.map((pullRequest) => pullRequest.createdAt),
  ]);
  const weekStart = mondayOf(start ?? now);
  const weeks = (instants: readonly (Date | null)[]) => weeklySeries(weekStart, now, instants);

  const bugs = issues.filter(isBug);
  const typed = bugs.filter((issue) => issue.issueType === "Bug");
  const fixedBugs = bugs.filter(completed);
  const completedIssues = issues.filter(completed);
  const merged = pullRequests.filter((pullRequest) => pullRequest.state === "MERGED");
  const mergeMinutes = merged.flatMap((pullRequest) =>
    pullRequest.mergedAt === null ? [] : [minutesBetween(pullRequest.createdAt, pullRequest.mergedAt)],
  );

  const figures: Latest["github"] = {
    repo: subject.repo,
    createdAt: repo?.createdAt ? iso(repo.createdAt) : null,
    stars: repo?.stars ?? null,
    forks: repo?.forks ?? null,
    contributors: repo?.contributors ?? null,
    commits: repo?.commits ?? null,
    weekStart,
    commitWeeks: weeks(commits.map((commit) => commit.committedAt)),
    issues: {
      total: issues.length,
      open: issues.filter((issue) => issue.state === "OPEN").length,
      completed: completedIssues.length,
      notPlanned: issues.filter(notPlanned).length,
      medianMinutesToClose: median(closeMinutes(completedIssues)),
      meanMinutesToClose: mean(closeMinutes(completedIssues)),
      openedWeeks: weeks(issues.map((issue) => issue.createdAt)),
      closedWeeks: weeks(issues.filter((issue) => issue.state === "CLOSED").map((issue) => issue.closedAt)),
    },
    bugs: {
      total: bugs.length,
      typed: typed.length,
      labelledOnly: bugs.length - typed.length,
      open: bugs.filter((issue) => issue.state === "OPEN").length,
      fixed: fixedBugs.length,
      notPlanned: bugs.filter(notPlanned).length,
      medianMinutesToFix: median(closeMinutes(fixedBugs)),
      meanMinutesToFix: mean(closeMinutes(fixedBugs)),
      reportedWeeks: weeks(bugs.map((issue) => issue.createdAt)),
      fixedWeeks: weeks(fixedBugs.map((issue) => issue.closedAt)),
    },
    pullRequests: {
      total: pullRequests.length,
      merged: merged.length,
      closedUnmerged: pullRequests.filter((pullRequest) => pullRequest.state === "CLOSED").length,
      open: pullRequests.filter((pullRequest) => pullRequest.state === "OPEN").length,
      medianMinutesToMerge: median(mergeMinutes),
      meanMinutesToMerge: mean(mergeMinutes),
      additions: merged.reduce((total, pullRequest) => total + pullRequest.additions, 0),
      deletions: merged.reduce((total, pullRequest) => total + pullRequest.deletions, 0),
      mergedWeeks: weeks(merged.map((pullRequest) => pullRequest.mergedAt)),
    },
  };
  return repo === null ? neverRead(figures) : figures;
}

/** GitHub's figures before GitHub has been read: every number and series null, the repository and week kept. */
function neverRead(figures: Latest["github"]): Latest["github"] {
  const nulled = <T extends object>(group: T): { [K in keyof T]: null } =>
    Object.fromEntries(Object.keys(group).map((key) => [key, null])) as { [K in keyof T]: null };
  return {
    repo: figures.repo,
    weekStart: figures.weekStart,
    createdAt: null,
    stars: null,
    forks: null,
    contributors: null,
    commits: null,
    commitWeeks: null,
    issues: nulled(figures.issues),
    bugs: nulled(figures.bugs),
    pullRequests: nulled(figures.pullRequests),
  };
}

/** The newest day jsDelivr was captured on, or null before it is read. */
function newestCdnDay(cdn: readonly CdnSnapshot[]): Day | null {
  return cdn.reduce<Day | null>(
    (newest, row) => (newest === null || row.capturedOn > newest ? row.capturedOn : newest),
    null,
  );
}

/**
 * Each package's jsDelivr requests in the window captured on the newest day. A package with no row that day is `0`
 * when the jsDelivr step finished on or after that day, since jsDelivr then had no stats for it, and null otherwise,
 * since the step may have stopped before reaching it.
 */
function cdnHits(rows: PublishRows): (name: string) => number | null {
  const day = newestCdnDay(rows.cdn);
  if (day === null) return () => null;
  const hits = new Map(rows.cdn.filter((row) => row.capturedOn === day).map((row) => [row.packageName, row.hits]));
  const finished = rows.collections.find((row) => row.step === "jsdelivr")?.collectedAt;
  const missing = finished !== undefined && utcDay(finished) >= day ? 0 : null;
  return (name) => hits.get(name) ?? missing;
}

function packageFigures(rows: PublishRows, span: DayRange | null): PackageStats[] {
  const registry = new Map(rows.registry.map((row) => [row.packageName, row]));
  const jsdelivr = cdnHits(rows);
  return [...rows.packages].sort().map((name) => {
    const facts = registry.get(name);
    const versions = rows.versionPublishes
      .filter((row) => row.packageName === name)
      .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
    const createdAt = facts?.createdAt ?? versions[0]?.publishedAt ?? null;
    return {
      name,
      description: facts?.description ?? null,
      createdAt: createdAt === null ? null : iso(createdAt),
      latest: facts?.latestVersion ?? null,
      daily:
        span === null
          ? null
          : dailySeries(
              span.start,
              span.end,
              rows.dailyDownloads.filter((row) => row.packageName === name),
            ),
      versions: versions.map((row) => ({ version: row.version, publishedAt: iso(row.publishedAt) })),
      versionWeeks: versionWindows(rows.versionDownloads.filter((row) => row.packageName === name)),
      footprint:
        facts === undefined
          ? null
          : {
              unpackedSize: facts.unpackedSize,
              fileCount: facts.fileCount,
              dependencies: Object.keys(facts.dependencies).length,
              peerDependencies: Object.keys(facts.peerDependencies).length,
            },
      jsdelivr: jsdelivr(name),
    };
  });
}

/** jsDelivr's window as captured on the newest day, summed over the rows captured that day only. */
function jsdelivrFigures(cdn: readonly CdnSnapshot[]): Latest["jsdelivr"] {
  const capturedOn = newestCdnDay(cdn);
  if (capturedOn === null) return { start: null, end: null, total: null };
  return {
    start: addDays(capturedOn, -JSDELIVR_DAYS),
    end: addDays(capturedOn, -1),
    total: cdn.filter((row) => row.capturedOn === capturedOn).reduce((total, row) => total + row.hits, 0),
  };
}

/** The kit's newest count and every day counted, oldest first; null figures and no history before its first count. */
function kitFigures(counts: readonly KitCount[]): Latest["kit"] {
  const history = [...counts].sort((a, b) => (a.capturedOn < b.capturedOn ? -1 : a.capturedOn > b.capturedOn ? 1 : 0));
  const newest = history[history.length - 1];
  if (newest === undefined) return { commit: null, countedAt: null, tests: null, codeLines: null, history: [] };
  return {
    commit: newest.commit,
    countedAt: iso(newest.countedAt),
    tests: newest.tests,
    codeLines: newest.codeLines,
    history: history.map((row) => ({
      date: row.capturedOn,
      commit: row.commit,
      tests: row.tests,
      codeLines: row.codeLines,
    })),
  };
}

/** The last complete day of npm downloads held, or the day before `now` when none is. */
function asOfDay(rows: PublishRows, now: Date): Day {
  const days = rows.dailyDownloads.map((row) => row.day);
  if (days.length === 0) return addDays(utcDay(now), -1);
  return days.reduce((newest, day) => (day > newest ? day : newest));
}

/** `latest.json`: everything the `/stats/` page draws, from the rows D1 holds, as of `now`. */
export function buildLatest(rows: PublishRows, subject: PublishSubject, now: Date): Latest {
  const asOf = asOfDay(rows, now);
  const held = rows.dailyDownloads.filter((row) => row.day <= asOf);
  const span: DayRange | null =
    held.length === 0
      ? null
      : { start: held.map((row) => row.day).reduce((first, day) => (day < first ? day : first)), end: asOf };
  return {
    version: CONTRACT_VERSION,
    generatedAt: iso(now),
    asOf,
    sources: sourceTimes(rows.collections),
    downloads:
      span === null
        ? { start: null, end: null, kit: null }
        : { start: span.start, end: span.end, kit: dailySeries(span.start, span.end, held) },
    packages: packageFigures(rows, span),
    jsdelivr: jsdelivrFigures(rows.cdn),
    github: githubFigures(rows, subject, now),
    depsDev: {
      dependents:
        rows.dependents.length === 0 ? null : rows.dependents.reduce((total, row) => total + row.dependents, 0),
    },
    scorecard: {
      score: rows.scorecard?.score ?? null,
      checkedAt: rows.scorecard ? utcDay(rows.scorecard.scoredAt) : null,
    },
    kit: kitFigures(rows.kitCounts),
  };
}

/** `summary.json`: the home page strip's headline numbers, read off `latest` and the rows it was built from. */
export function buildSummary(rows: PublishRows, latest: Latest): Summary {
  const series = latest.downloads.kit;
  const window = (days: number, back: number) => (series === null ? null : windowSum(series, days, back));
  const registryRead = rows.registry.length > 0;
  const publishes = rows.versionPublishes.map((row) => row.publishedAt);
  const firstCreated = earliest(
    latest.packages.map((row) => (row.createdAt === null ? null : new Date(row.createdAt))),
  );
  const newest = publishes.reduce<Date | null>(
    (latestAt, at) => (latestAt === null || at > latestAt ? at : latestAt),
    null,
  );
  const { issues, bugs, pullRequests } = latest.github;
  return {
    version: CONTRACT_VERSION,
    generatedAt: latest.generatedAt,
    asOf: latest.asOf,
    downloads: {
      since: firstCreated === null ? null : utcDay(firstCreated),
      allTime: series === null ? null : series.reduce((total, value) => total + value, 0),
      last30: window(30, 0),
      prior30: window(30, 30),
      last7: window(7, 0),
      prior7: window(7, 7),
    },
    releases: {
      packages: rows.packages.length === 0 ? null : rows.packages.length,
      versions: registryRead ? publishes.length : null,
      releaseDays: registryRead ? new Set(publishes.map(utcDay)).size : null,
      latestAt: registryRead && newest !== null ? iso(newest) : null,
    },
    issues: { total: issues.total, open: issues.open, medianMinutesToClose: issues.medianMinutesToClose },
    bugs: { total: bugs.total, open: bugs.open, medianMinutesToFix: bugs.medianMinutesToFix },
    pullRequests: { merged: pullRequests.merged, medianMinutesToMerge: pullRequests.medianMinutesToMerge },
    github: { stars: latest.github.stars },
    kit: { tests: latest.kit.tests, codeLines: latest.kit.codeLines, commit: latest.kit.commit },
  };
}
