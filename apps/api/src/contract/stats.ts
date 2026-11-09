import { z } from "zod";

/**
 * The JSON the API serves: `summary.json` for the home page strip and `latest.json` for the `/stats/` page.
 *
 * Every date is UTC: a date is `YYYY-MM-DD`, a time is ISO 8601. A daily series is one integer per UTC day from
 * its `start` to its `end`, inclusive. A weekly series is one integer per Monday-start UTC week, from
 * `github.weekStart` to the week holding `generatedAt`, so its last entry is the week in progress. Durations are
 * whole minutes. A source never collected is `null`, never `0`. Fields may be added within `version: 1`; renaming
 * or removing one is `version: 2`, served under `/v2`.
 */

/** The contract version both files carry. */
export const CONTRACT_VERSION = 1;

const Version = z.literal(CONTRACT_VERSION).describe("The contract version: `1`.");
const Time = z.iso.datetime().describe("An instant, ISO 8601 in UTC.");
const Date_ = z.iso.date().describe("A UTC day, `YYYY-MM-DD`.");
const Count = z.number().int().nonnegative();
const Series = z.array(Count.describe("One period's count.")).describe("A series of counts, oldest first.");
const GeneratedAt = Time.describe("When the publish step ran.");
const AsOf = Date_.describe("The last complete day of npm downloads.");

export const Summary = z
  .object({
    version: Version,
    generatedAt: GeneratedAt,
    asOf: AsOf,
    downloads: z
      .object({
        since: Date_.nullable().describe("The day of the kit's first publish, or null before the registry is read."),
        allTime: Count.nullable().describe("Kit-wide downloads on every day held, ending at `asOf`."),
        last30: Count.nullable().describe("Kit-wide downloads over the 30 days ending at `asOf`."),
        prior30: Count.nullable().describe("Kit-wide downloads over the 30 days before those."),
        last7: Count.nullable().describe("Kit-wide downloads over the 7 days ending at `asOf`."),
        prior7: Count.nullable().describe("Kit-wide downloads over the 7 days before those."),
      })
      .describe("Kit-wide npm downloads. Every count is null before npm's downloads are collected."),
    releases: z
      .object({
        packages: Count.nullable().describe("Packages in the `@pithy-sh` org."),
        versions: Count.nullable().describe("Every version ever published."),
        releaseDays: Count.nullable().describe("UTC days with at least one publish."),
        latestAt: Time.nullable().describe("When the newest version was published."),
      })
      .describe("The kit's release history, null before the registry is read."),
    issues: z
      .object({
        total: Count.nullable().describe("Every issue, bugs included."),
        open: Count.nullable().describe("Issues open now."),
        medianMinutesToClose: Count.nullable().describe(
          "Median minutes from open to close, over issues closed as completed; null when none has.",
        ),
      })
      .describe("Issues on the kit's repository, null before GitHub is read."),
    bugs: z
      .object({
        total: Count.nullable().describe("Every bug: an issue typed Bug or labelled `bug`."),
        open: Count.nullable().describe("Bugs open now."),
        medianMinutesToFix: Count.nullable().describe(
          "Median minutes from report to fix, over bugs closed as completed; null when none has.",
        ),
      })
      .describe("Bugs on the kit's repository, null before GitHub is read."),
    pullRequests: z
      .object({
        merged: Count.nullable().describe("Pull requests merged."),
        medianMinutesToMerge: Count.nullable().describe(
          "Median minutes from open to merge; null when none has merged.",
        ),
      })
      .describe("Pull requests on the kit's repository, null before GitHub is read."),
    github: z
      .object({ stars: Count.nullable().describe("Stargazers, null before GitHub is read.") })
      .describe("The kit repository's headline number."),
    kit: z
      .object({
        tests: Count.nullable().describe("Tests in the kit, null until they are counted."),
        codeLines: Count.nullable().describe("Lines of code in the kit, null until they are counted."),
        commit: z.string().nullable().describe("The full SHA they were counted at, null until they are counted."),
      })
      .describe("The kit's own size."),
  })
  .describe("The home page strip's headline numbers, served at `/v1/summary`. Nothing in it needs the history.");
export type Summary = z.output<typeof Summary>;

const SourceStatus = z
  .object({
    collectedAt: Time.nullable().describe(
      "The last successful collection, or null when it has never succeeded. A failed run keeps the last good data and this time, so a figure can be shown as stale.",
    ),
  })
  .describe("One source's freshness.");

export const SOURCES = ["npm", "registry", "github", "jsdelivr", "depsDev", "scorecard", "kit"] as const;
export type Source = (typeof SOURCES)[number];

const PackageVersion = z
  .object({
    version: z.string().describe("The version."),
    publishedAt: Time.describe("When it was published."),
  })
  .describe("One published version.");

const VersionWeek = z
  .object({
    start: Date_.describe("The window's first day."),
    end: Date_.describe("The window's last day: the day before the capture."),
    counts: z
      .record(z.string().describe("A version."), Count.describe("Its downloads over the window."))
      .describe("npm's per-version counts over the window."),
  })
  .describe("npm's per-version downloads over one seven-day window.");

const Footprint = z
  .object({
    unpackedSize: Count.nullable().describe("The latest version's unpacked size in bytes, or null when npm omits it."),
    fileCount: Count.nullable().describe("The latest version's file count, or null when npm omits it."),
    dependencies: Count.describe("Runtime dependencies the latest version declares."),
    peerDependencies: Count.describe("Peer dependencies the latest version declares."),
  })
  .describe("The latest version's manifest, in numbers.");

export const PackageStats = z
  .object({
    name: z.string().describe("The package, `@pithy-sh/<name>`."),
    description: z.string().nullable().describe("npm's description, or null."),
    createdAt: Time.nullable().describe("When it was first published, or null before the registry is read."),
    latest: z.string().nullable().describe("`dist-tags.latest`, or null before the registry is read."),
    daily: Series.nullable().describe(
      "Downloads per day, aligned to `downloads.start..end`; `0` before the first publish. Null before npm's downloads are collected.",
    ),
    versions: z.array(PackageVersion).describe("Every published version, oldest first."),
    versionWeeks: z
      .array(VersionWeek)
      .describe("One entry per non-overlapping seven-day window of per-version counts held, newest last."),
    footprint: Footprint.nullable().describe("The latest version's footprint, or null before the registry is read."),
    jsdelivr: Count.nullable().describe("jsDelivr requests in the `jsdelivr` window, or null before jsDelivr is read."),
  })
  .describe("One package in the org.");
export type PackageStats = z.output<typeof PackageStats>;

const Closing = (subject: string, verb: string) =>
  ({
    median: Count.nullable().describe(`Median minutes to ${verb}, over ${subject}; null when there are none.`),
    mean: Count.nullable().describe(`Mean minutes to ${verb}, over ${subject}; null when there are none.`),
  }) as const;

const issueClosing = Closing("issues closed as completed", "close");
const bugClosing = Closing("bugs closed as completed", "fix");
const mergeClosing = Closing("merged pull requests", "merge");

const NullableSeries = Series.nullable();

export const Latest = z
  .object({
    version: Version,
    generatedAt: GeneratedAt,
    asOf: AsOf,
    sources: z
      .object(
        Object.fromEntries(SOURCES.map((source) => [source, SourceStatus])) as Record<Source, typeof SourceStatus>,
      )
      .describe("When each source was last collected."),
    downloads: z
      .object({
        start: Date_.nullable().describe("The first day of every daily download series, or null before npm is read."),
        end: Date_.nullable().describe("The last day of every daily download series; equals `asOf`, or null."),
        kit: Series.nullable().describe("Kit-wide downloads per day, or null before npm's downloads are collected."),
      })
      .describe("Daily npm downloads."),
    packages: z.array(PackageStats).describe("One entry per package in the org, by name."),
    jsdelivr: z
      .object({
        start: Date_.nullable().describe("The first day of the 30-day window, or null before jsDelivr is read."),
        end: Date_.nullable().describe("The last day of the window."),
        total: Count.nullable().describe("Requests across every package over the window."),
      })
      .describe("jsDelivr's CDN requests."),
    github: z
      .object({
        repo: z.string().describe("The repository counted, `owner/name`."),
        createdAt: Time.nullable().describe("When it was created."),
        stars: Count.nullable().describe("Stargazers."),
        forks: Count.nullable().describe("Forks."),
        contributors: Count.nullable().describe("Contributors, anonymous ones included."),
        commits: Count.nullable().describe("Every commit reachable from `main`."),
        weekStart: Date_.describe("The Monday every weekly series starts on."),
        commitWeeks: NullableSeries.describe("Commits to `main` per week."),
        issues: z
          .object({
            total: Count.nullable().describe("Every issue, bugs included."),
            open: Count.nullable().describe("Open now."),
            completed: Count.nullable().describe("Closed as completed."),
            notPlanned: Count.nullable().describe("Closed as not planned."),
            medianMinutesToClose: issueClosing.median,
            meanMinutesToClose: issueClosing.mean,
            openedWeeks: NullableSeries.describe("Issues opened per week."),
            closedWeeks: NullableSeries.describe("Issues closed per week, for any reason."),
          })
          .describe("Issues."),
        bugs: z
          .object({
            total: Count.nullable().describe("Every bug: an issue typed Bug or labelled `bug`."),
            typed: Count.nullable().describe("Bugs typed Bug."),
            labelledOnly: Count.nullable().describe(
              "Bugs labelled `bug` and not typed Bug; `typed + labelledOnly = total`.",
            ),
            open: Count.nullable().describe("Open now."),
            fixed: Count.nullable().describe("Closed as completed."),
            notPlanned: Count.nullable().describe("Closed as not planned."),
            medianMinutesToFix: bugClosing.median,
            meanMinutesToFix: bugClosing.mean,
            reportedWeeks: NullableSeries.describe("Bugs reported per week."),
            fixedWeeks: NullableSeries.describe("Bugs fixed per week."),
          })
          .describe("Bugs."),
        pullRequests: z
          .object({
            total: Count.nullable().describe("Every pull request."),
            merged: Count.nullable().describe("Merged."),
            closedUnmerged: Count.nullable().describe("Closed without merging."),
            open: Count.nullable().describe("Open now."),
            medianMinutesToMerge: mergeClosing.median,
            meanMinutesToMerge: mergeClosing.mean,
            additions: Count.nullable().describe("Lines added across merged pull requests."),
            deletions: Count.nullable().describe("Lines deleted across merged pull requests."),
            mergedWeeks: NullableSeries.describe("Pull requests merged per week."),
          })
          .describe("Pull requests."),
      })
      .describe("The kit's repository. Every number is null before GitHub is read."),
    depsDev: z
      .object({
        dependents: Count.nullable().describe(
          "Dependents of every package's default version, summed across packages, or null before deps.dev is read.",
        ),
      })
      .describe("deps.dev's dependent counts."),
    scorecard: z
      .object({
        score: z.number().min(0).max(10).nullable().describe("The OpenSSF Scorecard aggregate, out of 10, or null."),
        checkedAt: Date_.nullable().describe("The day Scorecard computed it, or null."),
      })
      .describe("The repository's OpenSSF Scorecard."),
    kit: z
      .object({
        commit: z.string().nullable().describe("The full SHA the kit was last counted at, null until it is counted."),
        countedAt: Time.nullable().describe("When it was counted."),
        tests: Count.nullable().describe("Tests in the kit."),
        codeLines: Count.nullable().describe("Lines of code in the kit."),
        history: z
          .array(
            z
              .object({
                date: Date_.describe("The day counted."),
                commit: z.string().describe("The full SHA counted."),
                tests: Count.describe("Tests."),
                codeLines: Count.describe("Lines of code."),
              })
              .describe("One day's count."),
          )
          .describe("One entry per day counted, oldest first."),
      })
      .describe("The kit's own size, null until it is counted."),
  })
  .describe("Everything the `/stats/` page draws, served at `/v1/latest`.");
export type Latest = z.output<typeof Latest>;
