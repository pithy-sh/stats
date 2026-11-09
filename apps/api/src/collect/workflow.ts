import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import type { WorkflowSpecMap } from "@pithy-sh/core/src/workflow/spec";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { secretsStore } from "@pithy-sh/secrets/src/secretsStore";
import { z } from "zod";
import { type StatsDatabase, statsDatabase } from "../data/tables";
import { GITHUB_TOKEN, statsSecretRegistry } from "../secret/registry";
import { Day, downloadWindow, utcDay } from "./day";
import {
  recordPackages,
  writeCdn,
  writeDailyDownloads,
  writeDependents,
  writeIssues,
  writePullRequests,
  writeRegistry,
  writeRepo,
  writeScorecard,
  writeVersionDownloads,
} from "./store";
import { fetchDependents, fetchScorecard } from "./upstream/depsDev";
import { fetchIssues, fetchPullRequests, fetchRepoStats } from "./upstream/github";
import { type Fetcher, runtimeFetch } from "./upstream/http";
import { fetchCdnStats } from "./upstream/jsdelivr";
import { fetchDailyDownloads, fetchOrgPackages, fetchRegistry, fetchVersionDownloads } from "./upstream/npm";

/** The npm org whose packages are counted. */
export const KIT_ORG = "pithy-sh";
/** The repository whose GitHub numbers are counted. */
export const KIT_REPO = "pithy-sh/pithy";
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

/** What the collector needs off the Worker env: the app D1, and the secrets the GitHub token is read from. */
export interface CollectEnv extends SecretsStoreEnv {
  DB: D1Database;
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

/** The step names, which are also how a run's sources are named in its report and its failure. */
export const STEPS = {
  packages: "package list",
  registry: "registry",
  dailyDownloads: "daily downloads",
  versionDownloads: "version downloads",
  github: "github",
  jsdelivr: "jsdelivr",
  depsDev: "deps.dev",
} as const;

export const CollectReport = z
  .object({
    day: Day.describe("The UTC day the run was for: its daily downloads end the day before."),
    capturedOn: Day.describe("The UTC day the run fetched on, which every row it wrote is stamped with."),
    packages: z.number().int().nonnegative().describe("Packages in the org's list."),
    rows: z
      .record(z.string().describe("A step name."), z.number().int().nonnegative().describe("Rows it wrote."))
      .describe("Rows each source step wrote."),
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

/** Run `each` over `items` in order and add up the rows it reports. */
async function sum<T>(items: readonly T[], each: (item: T) => Promise<number>): Promise<number> {
  let total = 0;
  for (const item of items) total += await each(item);
  return total;
}

/**
 * Each source as one unit of work: fetch, then write, inside its own step. Each answers the rows it wrote.
 * Only daily downloads read `day`, because only they come from a dated historical API; everything is
 * stamped with `today`, the day it was fetched.
 */
function sources(
  db: StatsDatabase,
  env: CollectEnv,
  fetcher: Fetcher,
  day: Day,
  today: Day,
  packages: readonly string[],
  job: CollectJob,
): Record<Exclude<keyof typeof STEPS, "packages">, () => Promise<number>> {
  return {
    registry: () =>
      sum(packages, async (name) => {
        const facts = await fetchRegistry(fetcher, name);
        await writeRegistry(db, name, facts, today);
        return facts.versions.length + 1;
      }),
    dailyDownloads: () => {
      const window = downloadWindow(day, job.backfill === true ? FIRST_PUBLISH_DAY : undefined);
      return sum(packages, async (name) => {
        const days = await fetchDailyDownloads(fetcher, name, window);
        await writeDailyDownloads(db, name, days, today);
        return days.length;
      });
    },
    versionDownloads: () =>
      sum(packages, async (name) => {
        const counts = await fetchVersionDownloads(fetcher, name);
        await writeVersionDownloads(db, name, counts, today);
        return Object.keys(counts).length;
      }),
    github: async () => {
      // Read inside the step, so the token is never a step's returned value and never leaves this closure.
      const token = (await secretsStore(env, statsSecretRegistry)).get(GITHUB_TOKEN);
      const stats = await fetchRepoStats(fetcher, token, KIT_REPO);
      const issues = await fetchIssues(fetcher, token, KIT_REPO);
      const pullRequests = await fetchPullRequests(fetcher, token, KIT_REPO);
      await writeRepo(db, KIT_REPO, stats, today);
      await writeIssues(db, KIT_REPO, issues, today);
      await writePullRequests(db, KIT_REPO, pullRequests, today);
      return 1 + issues.length + pullRequests.length;
    },
    jsdelivr: () =>
      sum(packages, async (name) => {
        const stats = await fetchCdnStats(fetcher, name);
        if (stats === null) return 0;
        await writeCdn(db, name, stats, today);
        return 1;
      }),
    depsDev: async () => {
      const dependents = await sum(packages, async (name) => {
        const counts = await fetchDependents(fetcher, name);
        if (counts === null) return 0;
        await writeDependents(db, name, counts, today);
        return 1;
      });
      const scorecard = await fetchScorecard(fetcher, KIT_REPO);
      if (scorecard !== null) await writeScorecard(db, KIT_REPO, scorecard, today);
      return dependents + (scorecard === null ? 0 : 1);
    },
  };
}

/**
 * One collector run, the body behind `CollectWorkflow`.
 *
 * The package list comes first, because every per-package source needs it; if it cannot be read, nothing
 * else can run and the run fails. Every other source is its own step with its own retries, and one that
 * exhausts them does not stop the rest: the remaining sources still run and write, and the run then fails
 * naming the sources that did not, so it shows as errored and can be re-run.
 *
 * Every write is an upsert keyed by the day it was captured, so two runs on one day leave one set of rows,
 * and a run for an earlier date refills that date's daily downloads without rewriting any earlier snapshot.
 */
export async function runCollect(
  env: CollectEnv,
  event: CollectEvent,
  step: CollectStep,
  fetcher: Fetcher = runtimeFetch,
): Promise<CollectReport> {
  const job = CollectJob.parse(event.payload ?? {});
  const day = runDay(event, job);
  const today = capturedOn(event);
  const db = statsDatabase(env.DB);

  const packages = await step.do(STEPS.packages, SOURCE_STEP, async () => {
    const names = await fetchOrgPackages(fetcher, KIT_ORG);
    await recordPackages(db, names, today);
    return names;
  });

  const rows: Record<string, number> = {};
  const failed: string[] = [];
  for (const [source, run] of Object.entries(sources(db, env, fetcher, day, today, packages, job))) {
    const name = STEPS[source as keyof typeof STEPS];
    try {
      rows[name] = await step.do(name, SOURCE_STEP, run);
    } catch {
      // The step's own error is recorded on the instance by the runtime; the run carries on to the next source.
      failed.push(name);
    }
  }

  if (failed.length > 0) {
    throw new UpstreamError({
      message: `The ${day} run could not collect: ${failed.join(", ")}.`,
      action: `Once the upstream answers, trigger the Workflow with {"date":"${day}"}: it refills that day's daily downloads, and every other source is captured as of the day it runs, so no earlier snapshot is rewritten.`,
      detail: `Sources that wrote: ${Object.keys(rows).join(", ") || "none"}.`,
    });
  }
  return { day, capturedOn: today, packages: packages.length, rows };
}
