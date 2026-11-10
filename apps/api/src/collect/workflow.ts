import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import type { WorkflowSpecMap } from "@pithy-sh/core/src/workflow/spec";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { secretsStore } from "@pithy-sh/secrets/src/secretsStore";
import { z } from "zod";
import { type StatsDatabase, statsDatabase } from "../data/tables";
import { GITHUB_TOKEN, statsSecretRegistry } from "../secret/registry";
import { Day, utcDay } from "./day";
import { markHistoryCollected, readHistoryState } from "./history";
import { countTarball } from "./kit/source";
import { publish } from "./publish/publish";
import { loggedStep } from "./step";
import {
  recordCollected,
  recordPackages,
  writeCdn,
  writeCommits,
  writeDailyDownloads,
  writeDependents,
  writeIssues,
  writeKitCount,
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
import { fetchDailyDownloads, fetchOrgPackages, fetchRegistry, fetchVersionDownloads } from "./upstream/npm";
import { type DownloadWindow, downloadWindowFor } from "./window";

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
/** Every day at 02:00 UTC, once npm has finished counting the day before. */
export const COLLECT_CRON = "0 2 * * *";

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

export const collectWorkflows: WorkflowSpecMap = {
  collect: { binding: COLLECT_BINDING, params: CollectJob, schedule: COLLECT_CRON, className: "CollectWorkflow" },
};

/**
 * What the collector needs off the Worker env: the app D1, the secrets the GitHub token is read from, the R2
 * bucket the publish step writes to, and the environment's name.
 */
export interface CollectEnv extends SecretsStoreEnv {
  /** The environment's name, which every log record the run writes carries. wrangler.jsonc sets it per environment. */
  ENVIRONMENT: string;
  DB: D1Database;
  PUBLISHED: R2Bucket;
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
 * The step that decides each package's daily-downloads window, once the registry has run and before any package's
 * daily-downloads step. Its journalled answer is what every one of those steps fetches, on a replay as on the first
 * run.
 */
export const DOWNLOAD_WINDOWS = "download windows";

/** The download-windows step: a retry reads the same rows again. */
export const DOWNLOAD_WINDOWS_STEP = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "1 minute",
} as const satisfies WorkflowStepConfig;

/** The publish step's name. It runs once every source step has finished, whether or not each succeeded. */
export const PUBLISH = "publish";

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
    day: Day.describe("The UTC day the run was for: its daily downloads end the day before."),
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
 * read: the kit's scheduled handler starts every instance under a random id.
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
 * for the source that records it complete once every subject has written.
 */
type SourceWork =
  | { whole: () => Promise<number> }
  | { each: ReadonlyArray<readonly [subject: string, run: () => Promise<number>]> };

/** The subject of deps.dev's one step that is not a package: the repository's Scorecard. */
export const SCORECARD_SUBJECT = "scorecard";

/** Where a run's daily downloads reach back to for every package: the kit's first publish in a backfill. */
function backfillFrom(job: CollectJob): Day | undefined {
  return job.backfill === true ? FIRST_PUBLISH_DAY : undefined;
}

/**
 * Each package's daily-downloads window for this run, from its history state: the whole history for a package no
 * step has yet collected in full, the usual window for the rest.
 */
async function planWindows(
  db: StatsDatabase,
  packages: readonly string[],
  day: Day,
  today: Day,
  job: CollectJob,
): Promise<Record<string, DownloadWindow>> {
  const states = await readHistoryState(db, packages);
  return Object.fromEntries(
    packages.map((name) => {
      const state = states[name] ?? { pending: false, createdOn: null };
      return [name, downloadWindowFor({ day, today, backfillFrom: backfillFrom(job), ...state })];
    }),
  );
}

/**
 * Each source as units of work: fetch, then write. A source that loops over packages does one step per package, so
 * a package that fails does not redo the ones that wrote. Only daily downloads read `day`, because only they come
 * from a dated historical API, and each package's window comes from `windowOf`, decided before its step runs; a
 * step that fetched a package's whole history marks it collected. Everything is stamped with `today`, the day it was
 * fetched. The kit's count records `now()` as when it was taken.
 */
function sources(
  db: StatsDatabase,
  env: CollectEnv,
  fetcher: Fetcher,
  today: Day,
  packages: readonly string[],
  windowOf: (name: string) => DownloadWindow,
  now: () => Date,
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
    dailyDownloads: perPackage(async (name) => {
      const window = windowOf(name);
      const days = await fetchDailyDownloads(fetcher, name, window);
      await writeDailyDownloads(db, name, days, today);
      if (window.history) await markHistoryCollected(db, name, today);
      return days.length;
    }),
    versionDownloads: perPackage(async (name) => {
      const counts = await fetchVersionDownloads(fetcher, name);
      await writeVersionDownloads(db, name, counts, today);
      return Object.keys(counts).length;
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
 * completion step run.
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
    await loggedStep(step, log, name, SOURCE_STEP, () => complete(0));
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
 * Before daily downloads, one step decides each package's window: a package no step has yet collected in full gets
 * its whole history, from its registry creation day as far back as npm keeps, and keeps getting it on every run
 * until one of its steps writes it. If that step fails, every package gets the usual window, none is marked, and the
 * run fails naming it.
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
  const windows: Record<string, DownloadWindow> = {};
  const usual = downloadWindowFor({ day, today, backfillFrom: backfillFrom(job), pending: false, createdOn: null });
  const work = sources(db, env, upstream, today, packages, (name) => windows[name] ?? usual, now);
  for (const source of Object.keys(work) as SourceKey[]) {
    if (source === "dailyDownloads") {
      try {
        Object.assign(
          windows,
          await loggedStep(step, log, DOWNLOAD_WINDOWS, DOWNLOAD_WINDOWS_STEP, () =>
            planWindows(db, packages, day, today, job),
          ),
        );
      } catch {
        failed.push(DOWNLOAD_WINDOWS);
      }
    }
    const outcome = await runSource(step, log, db, source, work[source], now);
    rows[STEPS[source]] = outcome.rows;
    if (outcome.failure === null) completed.push(STEPS[source]);
    else failed.push(outcome.failure);
  }

  const published = await loggedStep(step, log, PUBLISH, PUBLISH_STEP, () =>
    publish(db, env.PUBLISHED, KIT_REPO, today, now()),
  );

  if (failed.length > 0) {
    throw new UpstreamError({
      message: `The ${day} run could not collect: ${failed.join(", ")}.`,
      action: `Once the upstream answers, trigger the Workflow with {"date":"${day}"}: it refills that day's daily downloads, and every other source is captured as of the day it runs, so no earlier snapshot is rewritten. The Worker's log says why each step failed.`,
      detail: `Sources that completed: ${completed.join(", ") || "none"}.`,
    });
  }
  return { day, capturedOn: today, packages: packages.length, rows, published };
}
