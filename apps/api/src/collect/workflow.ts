import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { InternalError, UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import type { WorkflowSpecMap } from "@pithy-sh/core/src/workflow/spec";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { secretsStore } from "@pithy-sh/secrets/src/secretsStore";
import { z } from "zod";
import { type StatsDatabase, statsDatabase } from "../data/tables";
import { COLLECT_CRON, readSchedule } from "../schedule";
import { GITHUB_TOKEN, statsSecretRegistry } from "../secret/registry";
import { Day, type DayRange, utcDay } from "./day";
import { markHistoryCollected, readHistoryState } from "./history";
import { countTarball } from "./kit/source";
import { publish } from "./publish/publish";
import { loggedStep } from "./step";
import {
  clearNpmWeek,
  readNpmWeek,
  recordCollected,
  recordPackages,
  undateNpmWeek,
  writeCdn,
  writeCommits,
  writeDailyDownloads,
  writeDependents,
  writeIssues,
  writeKitCount,
  writeNpmDays,
  writeNpmWeek,
  writePullRequests,
  writeRegistry,
  writeRepo,
  writeScorecard,
  writeVersionDownloads,
} from "./store";
import { upstreamFetcher } from "./upstream/client";
import { fetchDependents, fetchScorecard } from "./upstream/depsDev";
import {
  fetchBranchHead,
  fetchCommits,
  fetchIssues,
  fetchPullRequests,
  fetchRepoStats,
  fetchTarball,
} from "./upstream/github";
import { type Fetcher, runtimeFetch } from "./upstream/http";
import { fetchCdnStats } from "./upstream/jsdelivr";
import {
  fetchDailyDownloads,
  fetchNpmDays,
  fetchNpmWeek,
  fetchOrgPackages,
  fetchRegistry,
  fetchVersionDownloads,
  NpmDays,
} from "./upstream/npm";
import { DownloadWindow, downloadWindowFor } from "./window";

/** The npm org whose packages are counted. */
export const KIT_ORG = "pithy-sh";
/** The repository whose GitHub numbers are counted. */
export const KIT_REPO = "pithy-sh/pithy";
/** The branch whose head the kit's tests and code lines are counted at. */
export const KIT_BRANCH = "main";
/** The day the kit was first published: where a backfill of daily downloads starts. */
export const FIRST_PUBLISH_DAY: Day = "2026-09-05";

/** The binding the collector Workflow is reached by. */
export const COLLECT_BINDING = "COLLECT";
export const CollectJob = z
  .object({
    date: Day.optional().describe(
      "The UTC day whose daily-downloads window this run fetches. Absent: the UTC day the instance was created.",
    ),
    backfill: z
      .boolean()
      .optional()
      .describe("Fetch daily downloads from the kit's first publish rather than the last three days."),
  })
  .describe(
    "One collector run. The cron sends `{}`; a person sends a date to refill that day's daily downloads, or `backfill` to load history.",
  );
export type CollectJob = z.output<typeof CollectJob>;

/**
 * The collector's one job. A cron start is named by the UTC day it was scheduled for, so a second cron start that day
 * asks for a taken id, which the kit logs as already started instead of running it twice. A manual trigger that names
 * no id is named `manual-` and the moment it was asked for, never a bare day, so it never takes the day's scheduled
 * run's id. The rows' capture-day keys stay the guard for two runs on one day under different ids.
 */
export const collectWorkflows: WorkflowSpecMap = {
  collect: {
    binding: COLLECT_BINDING,
    params: CollectJob,
    schedule: COLLECT_CRON,
    instanceId: ({ firedAt, cron }) => (cron === undefined ? `manual-${idStamp(firedAt)}` : utcDay(firedAt)),
    className: "CollectWorkflow",
  },
};

/** The collector's `<capability>/<job>` key: the app capability `api` in pithy.config.ts declares the job `collect`. */
export const COLLECT_JOB = "api/collect";

/** `at` as the digits of its UTC ISO time to the millisecond, such as `20261109024107250`: the part of an id that is unique. */
function idStamp(at: Date): string {
  return at.toISOString().replace(/[^0-9]/g, "");
}

/**
 * The command that refills `day`'s daily downloads in `environment`, for a run that failed at `failedAt`. Its instance
 * id carries that moment, so each failure names a fresh id: a refill run that fails in turn prints a command whose id
 * is not its own, and following it is not refused as already started.
 */
export function refillCommand(environment: string, day: Day, failedAt: Date): string {
  return `bun run pithy workflow trigger ${COLLECT_JOB} --env ${environment} --params '{"date":"${day}"}' --id refill-${day}-${idStamp(failedAt)}`;
}

/**
 * What the collector needs off the Worker env: the app D1, the secrets the GitHub token is read from, the R2
 * bucket the publish step writes to, the environment's name, and the ready delay `nextUpdate` is dated with.
 */
export interface CollectEnv extends SecretsStoreEnv {
  /** The environment's name, which every log record the run writes carries. wrangler.jsonc sets it per environment. */
  ENVIRONMENT: string;
  DB: D1Database;
  PUBLISHED: R2Bucket;
  /** Whole minutes from a run's start to the time its files are taken to be ready, read through `VARS`. */
  READY_AFTER_MINUTES?: unknown;
}

/** The one step method the collector uses. */
export type CollectStep = Pick<WorkflowStep, "do">;

/** The parts of a Workflow event the collector reads. */
export interface CollectEvent {
  payload: unknown;
  timestamp: Date;
  instanceId: string;
}

/** Every source retries on its own: an upstream that is down for an hour delays only its own rows. */
export const SOURCE_STEP = {
  retries: { limit: 5, delay: "1 minute", backoff: "exponential" },
  timeout: "10 minutes",
} as const satisfies WorkflowStepConfig;

/**
 * One package's step, or one other subject's. Fewer and shorter retries than a whole source's, because a source
 * runs one of these per package in turn: a rate limit is already retried in place inside the step, so what is
 * left for these is an upstream that is failing outright.
 */
export const SUBJECT_STEP = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const satisfies WorkflowStepConfig;

/** The publish step: a retry rebuilds both files from D1 and rewrites them, so it can safely run again. */
export const PUBLISH_STEP = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} as const satisfies WorkflowStepConfig;

/**
 * The step that asks npm which days it has counted and decides each package's daily-downloads window, once the
 * registry has run and before any package's version-downloads or daily-downloads step. It records npm's last complete
 * day and ends every window there. Its journalled answer is what every one of those steps fetches, and the week the
 * version-downloads source checks its counts against, on a replay as on the first run.
 */
export const DOWNLOAD_WINDOWS = "download windows";

/**
 * The download-windows step: a retry asks npm again and reads the same rows again. Its two npm requests are paced and
 * a rate limit is waited out in place, which can take most of a minute, so it gets the time a subject step does.
 */
export const DOWNLOAD_WINDOWS_STEP = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const satisfies WorkflowStepConfig;

/** The publish step's name. It runs once every source step has finished, whether or not each succeeded. */
export const PUBLISH = "publish";

export const WindowPlan = z
  .object({
    npm: NpmDays.describe("Which days npm said it had counted."),
    windows: z
      .record(z.string().describe("A package name."), DownloadWindow)
      .describe("Each package's daily-downloads window."),
  })
  .describe("What the download-windows step decided: npm's answer, and every package's window from it.");
export type WindowPlan = z.output<typeof WindowPlan>;

/**
 * Each source's name: its step's, or for a source that runs per subject, the prefix of each subject's step and the
 * name of the step that records it complete. Also how a run's sources are named in its report and its failure.
 */
export const STEPS = {
  packages: "package list",
  registry: "registry",
  dailyDownloads: "daily downloads",
  versionDownloads: "version downloads",
  github: "github",
  kit: "kit",
  jsdelivr: "jsdelivr",
  depsDev: "deps.dev",
} as const;

export const CollectReport = z
  .object({
    day: Day.describe(
      "The UTC day the run was for: its daily downloads end the day before, or at npm's last complete day when that is earlier.",
    ),
    capturedOn: Day.describe("The UTC day the run fetched on, which every row it wrote is stamped with."),
    packages: z.number().int().nonnegative().describe("Packages in the org's list."),
    rows: z
      .record(z.string().describe("A source name."), z.number().int().nonnegative().describe("Rows its steps wrote."))
      .describe("Rows each source wrote, a failed source's included."),
    published: z
      .record(z.string().describe("An R2 key."), z.number().int().nonnegative().describe("Bytes written."))
      .describe("What the publish step wrote to R2."),
  })
  .describe("What one collector run did. Counts only: no upstream data and no credential.");
export type CollectReport = z.output<typeof CollectReport>;

/**
 * The UTC day a run is for: the payload's date, else the day the instance was created. The instance id is never
 * read: a manual trigger may name its instance anything.
 */
export function runDay(event: CollectEvent, job: CollectJob): Day {
  return job.date ?? capturedOn(event);
}

/**
 * The UTC day a run fetches on: the day the instance was created. Every point-in-time source (the package
 * list, registry, version downloads, GitHub, jsDelivr, deps.dev) is stamped with it whatever date the run is
 * for, since what an upstream answers today is true of today. The runtime keeps the timestamp across
 * retries and resumes, so a step re-run later still writes under the same day.
 */
export function capturedOn(event: CollectEvent): Day {
  return utcDay(event.timestamp);
}

/** Each source by its key in `STEPS`, the package list aside. Also the key its completion is recorded under. */
type SourceKey = Exclude<keyof typeof STEPS, "packages">;

/**
 * One source's work, each part answering the rows it wrote. `whole` runs as one step named for the source, which
 * records the source complete. `each` runs one step per subject, named `<source> <subject>`, and then a step named
 * for the source that runs `finish`, if any, and records it complete once every subject has written.
 */
type SourceWork =
  | { whole: () => Promise<number> }
  | {
      each: ReadonlyArray<readonly [subject: string, run: () => Promise<number>]>;
      finish?: () => Promise<void>;
    };

/** The sources that wait for the download-windows step, and are skipped when it fails. */
const NEEDS_PLAN: ReadonlySet<SourceKey> = new Set(["versionDownloads", "dailyDownloads"]);

/** The subject of deps.dev's one step that is not a package: the repository's Scorecard. */
export const SCORECARD_SUBJECT = "scorecard";

/** Where a run's daily downloads reach back to for every package: the kit's first publish in a backfill. */
function backfillFrom(job: CollectJob): Day | undefined {
  return job.backfill === true ? FIRST_PUBLISH_DAY : undefined;
}

/**
 * Each package's daily-downloads window for this run: npm is asked, through `fetcher`, which days it has counted, and
 * its last complete day is recorded under `today`, with no week until the version-downloads source confirms one. Then
 * each package gets the whole history if no step has yet collected it in full, the usual window otherwise, caught up
 * from the newest day held, every one ending no later than npm's last complete day.
 */
async function planWindows(
  db: StatsDatabase,
  fetcher: Fetcher,
  packages: readonly string[],
  day: Day,
  today: Day,
  job: CollectJob,
): Promise<WindowPlan> {
  const npm = await fetchNpmDays(fetcher, packages, today);
  await writeNpmDays(db, npm, today);
  const states = await readHistoryState(db, packages);
  const windows = Object.fromEntries(
    packages.map((name) => {
      const state = states[name] ?? { pending: false, createdOn: null, newestDay: null };
      return [
        name,
        downloadWindowFor({ day, today, backfillFrom: backfillFrom(job), completeThrough: npm.lastDay, ...state }),
      ];
    }),
  );
  return { npm, windows };
}

/**
 * Date today's per-version counts, once every package's have been written: npm is asked again for its `last-week`
 * window, and only if it is still the one the download-windows step was told is it recorded as theirs. If npm closed a
 * day in between, some counts may cover the old week and some the new, so the day's week is cleared, one an earlier
 * run that day confirmed included, unless a run told of a later day has moved the day on, whose own completion dates
 * the counts it rewrote.
 *
 * Once written, npm is asked a third time. Another run may have fetched and written counts after npm closed a day but
 * before this write, and the week just written would date them. npm only moves forward, so any counts fetched after it
 * moved were fetched before this last request, which then sees the move and clears the week, unless another run has
 * since recorded a different one.
 */
async function dateVersionCounts(
  db: StatsDatabase,
  fetcher: Fetcher,
  log: Logger,
  npm: NpmDays,
  today: Day,
): Promise<void> {
  const week = await fetchNpmWeek(fetcher, npm.package);
  if (sameWeek(week, npm.lastWeek)) {
    await writeNpmWeek(db, week, today);
    const after = await fetchNpmWeek(fetcher, npm.package);
    if (sameWeek(after, week)) return;
    await undateNpmWeek(db, week, today);
    log.warn("npm's last-week window moved as today's per-version counts were dated: the week is cleared", {
      capturedOn: today,
      written: `${week.start}..${week.end}`,
      after: `${after.start}..${after.end}`,
    });
    return;
  }
  await clearNpmWeek(db, npm.lastDay, today);
  log.warn("npm's last-week window moved while per-version counts were fetched: they are kept undated", {
    capturedOn: today,
    probed: `${npm.lastWeek.start}..${npm.lastWeek.end}`,
    after: `${week.start}..${week.end}`,
  });
}

function sameWeek(a: DayRange, b: DayRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/**
 * Before one package's per-version counts are written under `today`: if a week is already recorded for the day,
 * another run confirmed it, and a publish dates whatever is written now by it. npm is asked for its `last-week` again,
 * which the counts just fetched cover, and the recorded week is cleared when it is not that one, so a publish meanwhile
 * falls back to an earlier dated capture rather than dating these counts by the wrong week.
 */
async function undateIfMoved(
  db: StatsDatabase,
  fetcher: Fetcher,
  log: Logger,
  npm: NpmDays,
  today: Day,
): Promise<void> {
  const recorded = await readNpmWeek(db, today);
  if (recorded === null) return;
  const week = await fetchNpmWeek(fetcher, npm.package);
  if (sameWeek(week, recorded)) return;
  await undateNpmWeek(db, recorded, today);
  log.warn("npm's last-week window is not the week recorded for today's per-version counts: that week is cleared", {
    capturedOn: today,
    recorded: `${recorded.start}..${recorded.end}`,
    now: `${week.start}..${week.end}`,
  });
}

/**
 * Each source as units of work: fetch, then write, in the order they run. A source that loops over packages does one
 * step per package, so a package that fails does not redo the ones that wrote. Only daily downloads have a window,
 * because only they come from a dated historical API, and each package's comes from `plan`, decided before its step
 * runs; a step that fetched a package's whole history marks it collected. Version downloads run straight after that
 * decision, so npm has the least time to close a day before they are dated against its answer. Everything is stamped
 * with `today`, the day it was fetched. The kit's count records `now()` as when it was taken.
 */
function sources(
  db: StatsDatabase,
  env: CollectEnv,
  fetcher: Fetcher,
  today: Day,
  packages: readonly string[],
  plan: () => WindowPlan,
  now: () => Date,
  log: Logger,
): Record<SourceKey, SourceWork> {
  const perPackage = (run: (name: string) => Promise<number>): SourceWork => ({
    each: packages.map((name) => [name, () => run(name)] as const),
  });
  return {
    registry: perPackage(async (name) => {
      const facts = await fetchRegistry(fetcher, name);
      await writeRegistry(db, name, facts, today);
      return facts.versions.length + 1;
    }),
    versionDownloads: {
      ...perPackage(async (name) => {
        const counts = await fetchVersionDownloads(fetcher, name);
        await undateIfMoved(db, fetcher, log, plan().npm, today);
        await writeVersionDownloads(db, name, counts, today);
        return Object.keys(counts).length;
      }),
      finish: () => dateVersionCounts(db, fetcher, log, plan().npm, today),
    },
    dailyDownloads: perPackage(async (name) => {
      const window = plan().windows[name];
      if (window === undefined) throw new InternalError({ detail: `No download window was decided for ${name}.` });
      const days = await fetchDailyDownloads(fetcher, name, window);
      await writeDailyDownloads(db, name, days, today);
      if (window.history) await markHistoryCollected(db, name, today);
      return days.length;
    }),
    github: {
      whole: async () => {
        // Read inside the step, so the token is never a step's returned value and never leaves this closure.
        const token = (await secretsStore(env, statsSecretRegistry)).get(GITHUB_TOKEN);
        const stats = await fetchRepoStats(fetcher, token, KIT_REPO);
        const issues = await fetchIssues(fetcher, token, KIT_REPO);
        const pullRequests = await fetchPullRequests(fetcher, token, KIT_REPO);
        const commits = await fetchCommits(fetcher, token, KIT_REPO);
        await writeRepo(db, KIT_REPO, stats, today);
        await writeIssues(db, KIT_REPO, issues, today);
        await writePullRequests(db, KIT_REPO, pullRequests, today);
        await writeCommits(db, KIT_REPO, commits);
        return 1 + issues.length + pullRequests.length + commits.length;
      },
    },
    kit: {
      whole: async () => {
        const token = (await secretsStore(env, statsSecretRegistry)).get(GITHUB_TOKEN);
        // Resolved first, so the row names the exact commit counted even if the branch moves during the download.
        const commit = await fetchBranchHead(fetcher, token, KIT_REPO, KIT_BRANCH);
        const counts = await countTarball(await fetchTarball(fetcher, token, KIT_REPO, commit));
        await writeKitCount(db, KIT_REPO, commit, counts, today, now());
        return 1;
      },
    },
    jsdelivr: perPackage(async (name) => {
      const stats = await fetchCdnStats(fetcher, name);
      if (stats === null) return 0;
      await writeCdn(db, name, stats, today);
      return 1;
    }),
    depsDev: {
      each: [
        ...packages.map(
          (name) =>
            [
              name,
              async () => {
                const counts = await fetchDependents(fetcher, name);
                if (counts === null) return 0;
                await writeDependents(db, name, counts, today);
                return 1;
              },
            ] as const,
        ),
        [
          SCORECARD_SUBJECT,
          async () => {
            const scorecard = await fetchScorecard(fetcher, KIT_REPO);
            if (scorecard === null) return 0;
            await writeScorecard(db, KIT_REPO, scorecard, today);
            return 1;
          },
        ] as const,
      ],
    },
  };
}

/** What running one source came to. */
interface SourceOutcome {
  /** Rows its steps wrote, a failed source's included. */
  rows: number;
  /** Null when it completed; otherwise how the run's failure names it. */
  failure: string | null;
}

/**
 * Run one source's steps. A per-subject source tries every subject however many fail before it, so one that answers
 * still writes, and its failure names each subject that did not. Only once every subject has written does its
 * completion step run its `finish` and record it complete.
 */
async function runSource(
  step: CollectStep,
  log: Logger,
  db: StatsDatabase,
  source: SourceKey,
  work: SourceWork,
  now: () => Date,
): Promise<SourceOutcome> {
  const name = STEPS[source];
  const complete = async (written: number): Promise<number> => {
    await recordCollected(db, source, now());
    return written;
  };
  if ("whole" in work) {
    try {
      return {
        rows: await loggedStep(step, log, name, SOURCE_STEP, async () => complete(await work.whole())),
        failure: null,
      };
    } catch {
      return { rows: 0, failure: name };
    }
  }

  let rows = 0;
  const failed: string[] = [];
  for (const [subject, run] of work.each) {
    try {
      rows += await loggedStep(step, log, `${name} ${subject}`, SUBJECT_STEP, run);
    } catch {
      failed.push(subject);
    }
  }
  if (failed.length > 0) return { rows, failure: `${name} (${failed.join(", ")})` };
  try {
    await loggedStep(step, log, name, SOURCE_STEP, async () => {
      await work.finish?.();
      return complete(0);
    });
    return { rows, failure: null };
  } catch {
    return { rows, failure: name };
  }
}

/**
 * One collector run, the body behind `CollectWorkflow`.
 *
 * The package list comes first, because every per-package source needs it; if it cannot be read, nothing
 * else can run and the run fails. Every other source runs in its own steps with their own retries: one step for a
 * source about the repository, one per package for a source about packages. A step that exhausts its retries does
 * not stop the rest: the remaining packages and sources still run and write, and the run then fails naming the
 * sources and packages that did not, so it shows as errored and can be re-run. With the kit's 27 packages that is
 * about 145 steps, well under the runtime's limit per instance.
 *
 * Before version downloads and daily downloads, one step asks npm which day it has last finished counting and decides
 * each package's daily-downloads window, none reaching past that day: a package no step has yet collected in full gets
 * its whole history, from its registry creation day as far back as npm keeps, and keeps getting it on every run until
 * one of its steps writes it; a known package's window reaches back to the day after the newest day held, so the days a
 * capped or failed run skipped are fetched by the next. If that step fails, neither source runs, so no day npm has not
 * counted is stored and no per-version count is captured without the week it covers, and the run fails naming all
 * three. Version downloads run next, and their last step asks npm for its week again, dating them only when it has
 * not moved.
 *
 * Every request goes through one {@link upstreamFetcher}, which paces npm's downloads API and retries a rate limit
 * in place, and every step that throws logs why through `log` before the runtime retries it.
 *
 * Every write is an upsert keyed by the day it was captured, so two runs on one day leave one set of rows,
 * and a run for an earlier date refills that date's daily downloads without rewriting any earlier snapshot.
 *
 * A source that completes records when it did, inside its last step, so a failed one keeps its last good time.
 * Once every source has finished, the publish step builds the JSON from D1 and writes it to R2, so a source
 * that failed is published with its last good data and its old time.
 */
export async function runCollect(
  env: CollectEnv,
  event: CollectEvent,
  step: CollectStep,
  fetcher: Fetcher = runtimeFetch,
  now: () => Date = () => new Date(),
  log: Logger = createWorkerLogger({ name: "collect" }),
): Promise<CollectReport> {
  const job = CollectJob.parse(event.payload ?? {});
  const day = runDay(event, job);
  const today = capturedOn(event);
  const db = statsDatabase(env.DB);
  const upstream = upstreamFetcher(fetcher);

  const packages = await loggedStep(step, log, STEPS.packages, SOURCE_STEP, async () => {
    const names = await fetchOrgPackages(upstream, KIT_ORG);
    await recordPackages(db, names, today);
    await recordCollected(db, "packages", now());
    return names;
  });

  const rows: Record<string, number> = {};
  const failed: string[] = [];
  const completed: string[] = [];
  let plan: WindowPlan | "failed" | null = null;
  const planned = (): WindowPlan => {
    if (plan === null || plan === "failed") throw new InternalError({ detail: "No download windows were decided." });
    return plan;
  };
  const work = sources(db, env, upstream, today, packages, planned, now, log);
  for (const source of Object.keys(work) as SourceKey[]) {
    if (NEEDS_PLAN.has(source)) {
      if (plan === null) {
        try {
          plan = await loggedStep(step, log, DOWNLOAD_WINDOWS, DOWNLOAD_WINDOWS_STEP, () =>
            planWindows(db, upstream, packages, day, today, job),
          );
        } catch {
          plan = "failed";
          failed.push(DOWNLOAD_WINDOWS);
        }
      }
      if (plan === "failed") {
        failed.push(STEPS[source]);
        rows[STEPS[source]] = 0;
        continue;
      }
    }
    const outcome = await runSource(step, log, db, source, work[source], now);
    rows[STEPS[source]] = outcome.rows;
    if (outcome.failure === null) completed.push(STEPS[source]);
    else failed.push(outcome.failure);
  }

  const published = await loggedStep(step, log, PUBLISH, PUBLISH_STEP, () =>
    publish(db, env.PUBLISHED, KIT_REPO, today, now(), readSchedule(env, log)),
  );

  if (failed.length > 0) {
    throw new UpstreamError({
      message: `The ${day} run could not collect: ${failed.join(", ")}.`,
      action: `Once the upstream answers, run ${refillCommand(env.ENVIRONMENT, day, now())}: it refills that day's daily downloads, and every other source is captured as of the day it runs, so no earlier snapshot is rewritten. The Worker's log says why each step failed.`,
      detail: `Sources that completed: ${completed.join(", ") || "none"}.`,
    });
  }
  return { day, capturedOn: today, packages: packages.length, rows, published };
}
