import {
  createExecutionContext,
  env,
  introspectWorkflow,
  introspectWorkflowInstance,
  type WorkflowInstanceModifier,
  waitOnExecutionContext,
} from "cloudflare:test";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { currentKey, snapshotKey } from "../contract/objects";
import { Latest, Summary } from "../contract/stats";
import { statsDatabase, type statsTables } from "../data/tables";
import { freshDatabase } from "../data/testing";
import worker from "../index";
import { COLLECT_CRON, dailyRunStart, nextUpdateAfter } from "../schedule";
import { addDays, dayRanges } from "./day";
import { markHistoryCollected } from "./history";
import { gzip, tarArchive } from "./kit/testing";
import {
  recordCollected,
  recordPackages,
  writeCdn,
  writeDailyDownloads,
  writeDependents,
  writeNpmDays,
  writeNpmWeek,
  writeRegistry,
  writeRepo,
  writeVersionDownloads,
} from "./store";
import { MAX_RANGE_DAYS, NPM_API_GAP_MS } from "./upstream/npm";
import { clock } from "./upstream/rateLimit";
import { type StubAnswer, type StubCall, stubFetch } from "./upstream/testing";
import { npmHistoryStart } from "./window";
import { type CollectEnv, type CollectStep, DOWNLOAD_WINDOWS, refillCommand, runCollect } from "./workflow";

const PACKAGES = ["@pithy-sh/auth", "@pithy-sh/core"];
/** The day every test's {@link PACKAGES} were first seen and had their history collected: they are known. */
const KNOWN_SINCE = "2026-09-05";
const TOKEN = "test-github-token";
/** The head of the kit's `main` the stub answers, and the commit whose tarball it serves. */
const HEAD = "c".repeat(40);
const TARBALL_URL = `https://api.github.com/repos/pithy-sh/pithy/tarball/${HEAD}`;

/** A small kit: three tests in one test file and four code lines across two source files, and files never read. */
let kitTarball: Uint8Array;
beforeAll(async () => {
  kitTarball = await gzip(
    tarArchive({
      "README.md": "# Pithy\n",
      "packages/core/src/a.ts": "// a\nexport const a = 1;\n\nexport const b = 2;\n",
      "packages/core/src/a.test.ts": `test("a", () => {});\nit.each([1, 2])("b %i", () => {});\ntest.todo("c");\n`,
      "packages/ui-react/src/B.tsx": "/** B. */\nexport const B = () => <b />;\nexport default B;\n",
      "packages/core/templates/app/src/c.ts": "const c = 3;\n",
    }),
  );
});

/** The kit's tarball, fresh on every request since a body is read once. */
const tarball = (): StubAnswer => new Response(kitTarball as BodyInit, { status: 200 });

/** The day before the one this test runs on: what npm names as its last complete day once that day has closed. */
const yesterday = () => addDays(new Date().toISOString().slice(0, 10), -1);

/** npm's `last-day` and `last-week` answers when the last day it has counted is `lastDay()`. */
function npmPoints(lastDay: () => string = yesterday): Record<string, (call: StubCall) => StubAnswer> {
  const point = (call: StubCall, start: string, end: string): StubAnswer => ({
    json: { downloads: 36, start, end, package: call.url.split("/").slice(-2).join("/") },
  });
  return {
    "https://api.npmjs.org/downloads/point/last-day/*": (call) => point(call, lastDay(), lastDay()),
    "https://api.npmjs.org/downloads/point/last-week/*": (call) => point(call, addDays(lastDay(), -6), lastDay()),
  };
}

/**
 * Every upstream the collector calls, answering a small, consistent kit. `downloads` sets a day's count, and `kit`
 * answers the tarball request. npm has counted every day before the one the test runs on.
 */
function upstreams(
  downloads: (name: string, day: string) => number = () => 10,
  stars = 50,
  kit: () => StubAnswer = tarball,
) {
  const graphql = (call: StubCall) => {
    const query = (JSON.parse(call.body ?? "{}") as { query: string }).query;
    const page = { hasNextPage: false, endCursor: null };
    if (query.includes("issues(")) {
      return {
        json: {
          data: {
            repository: {
              issues: {
                pageInfo: page,
                nodes: [
                  {
                    number: 1,
                    createdAt: "2026-09-05T00:00:00Z",
                    closedAt: null,
                    state: "OPEN",
                    stateReason: null,
                    issueType: { name: "Feature" },
                    labels: { nodes: [{ name: "kit" }] },
                  },
                ],
              },
            },
          },
        },
      };
    }
    if (query.includes("history(first")) {
      return {
        json: {
          data: {
            repository: {
              defaultBranchRef: {
                target: {
                  history: {
                    pageInfo: page,
                    nodes: [
                      { oid: "b".repeat(40), committedDate: "2026-09-06T00:00:00Z" },
                      { oid: "a".repeat(40), committedDate: "2026-09-05T00:00:00Z" },
                    ],
                  },
                },
              },
            },
          },
        },
      };
    }
    if (query.includes("pullRequests(")) {
      return {
        json: {
          data: {
            repository: {
              pullRequests: {
                pageInfo: page,
                nodes: [
                  {
                    number: 2,
                    createdAt: "2026-09-05T00:00:00Z",
                    mergedAt: "2026-09-06T00:00:00Z",
                    closedAt: "2026-09-06T00:00:00Z",
                    state: "MERGED",
                    additions: 100,
                    deletions: 4,
                  },
                ],
              },
            },
          },
        },
      };
    }
    return {
      json: {
        data: {
          repository: {
            createdAt: "2026-09-01T00:00:00Z",
            stargazerCount: stars,
            forkCount: 4,
            defaultBranchRef: { target: { history: { totalCount: 900 } } },
          },
        },
      },
    };
  };

  return stubFetch({
    ...npmPoints(),
    "https://registry.npmjs.org/-/org/pithy-sh/package": {
      json: Object.fromEntries(PACKAGES.map((name) => [name, "write"])),
    },
    "https://registry.npmjs.org/*": {
      json: {
        description: "A Pithy package.",
        "dist-tags": { latest: "0.2.0" },
        time: {
          created: "2026-09-05T00:00:00Z",
          "0.1.0": "2026-09-05T00:00:00Z",
          "0.2.0": "2026-10-01T00:00:00Z",
        },
        versions: {
          "0.1.0": { dist: { unpackedSize: 10, fileCount: 1 } },
          "0.2.0": { dist: { unpackedSize: 20, fileCount: 2 }, dependencies: { zod: "^4.0.0" } },
        },
      },
    },
    "https://api.npmjs.org/downloads/range/*": (call) => {
      const [, , , , , span = "", ...nameParts] = call.url.split("/");
      const name = nameParts.join("/");
      const [start = "", end = ""] = span.split(":");
      const days: { day: string; downloads: number }[] = [];
      for (let day = start; day <= end; day = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10)) {
        days.push({ day, downloads: downloads(name, day) });
      }
      return { json: { downloads: days } };
    },
    "https://api.npmjs.org/versions/*": { json: { downloads: { "0.1.0": 3, "0.2.0": 30 } } },
    "https://api.github.com/graphql": graphql,
    "https://api.github.com/repos/pithy-sh/pithy/git/ref/heads/main": {
      json: { ref: "refs/heads/main", object: { sha: HEAD, type: "commit" } },
    },
    [TARBALL_URL]: kit,
    "https://api.github.com/repos/pithy-sh/pithy/contributors*": { json: [{}, {}] },
    "https://data.jsdelivr.com/v1/stats/packages/npm/*": {
      json: { hits: { rank: 5000, total: 77 }, bandwidth: { rank: 5100, total: 7700 } },
    },
    "https://api.deps.dev/v3/systems/npm/packages/*": {
      json: { versions: [{ versionKey: { version: "0.2.0" }, isDefault: true }] },
    },
    "https://api.deps.dev/v3alpha/*": {
      json: { dependentCount: 2, directDependentCount: 1, indirectDependentCount: 1 },
    },
    "https://api.deps.dev/v3/projects/*": { json: { scorecard: { date: "2026-11-02T00:00:00Z", overallScore: 5.5 } } },
  });
}

/** Every wait the collector asked for while upstreams were stubbed: pacing and rate-limit backoff alike. */
let sleeps: number[] = [];

/**
 * The collector's time while upstreams are stubbed: it moves only when the collector sleeps, and never backwards
 * from one test to the next, since npm's pace is kept for the whole isolate.
 */
let virtualNow = Date.now();

/**
 * Route the runtime's `fetch` to a stub table, and answer every wait at once while recording it and moving the
 * collector's clock past it. The Workflow's steps run in this isolate, so they see all of it.
 */
function stubUpstreams(stub: ReturnType<typeof stubFetch>): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    stub.fetch(input instanceof Request ? input.url : String(input), init),
  );
  sleeps = [];
  vi.spyOn(clock, "now").mockImplementation(() => virtualNow);
  vi.spyOn(clock, "sleep").mockImplementation(async (ms) => {
    sleeps.push(ms);
    virtualNow += ms;
  });
}

/** `upstreams()` with some routes answered differently. */
function upstreamsWith(
  overrides: Record<string, StubAnswer | ((call: StubCall) => StubAnswer)>,
): ReturnType<typeof stubFetch> {
  const base = upstreams();
  const changed = stubFetch(overrides);
  const calls: StubCall[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const answer = await changed.fetch(url, init);
      if (answer.status !== 599) {
        calls.push(changed.calls[changed.calls.length - 1] as StubCall);
        return answer;
      }
      const fallback = await base.fetch(url, init);
      calls.push(base.calls[base.calls.length - 1] as StubCall);
      return fallback;
    },
  };
}

const db = () => statsDatabase(env.DB);

/** The UTC day now, which is what a run stamps its rows with: the runtime sets the event's timestamp. */
const today = () => new Date().toISOString().slice(0, 10);

/** `day` is the UTC day this test is running on, allowing for a run that straddles midnight. */
function expectToday(day: string): void {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  expect([yesterday, today()]).toContain(day);
}

async function count(table: keyof typeof statsTables): Promise<number> {
  const row = await db().selectFrom(table).select(sql<number>`count(*)`.as("n")).executeTakeFirstOrThrow();
  return Number(row.n);
}

async function rowCounts(): Promise<Record<string, number>> {
  const tables = [
    "packages",
    "dailyDownloads",
    "versionDownloads",
    "npmDays",
    "versionPublishes",
    "registrySnapshots",
    "registryLatest",
    "repoSnapshots",
    "repoLatest",
    "issues",
    "issueSnapshots",
    "pullRequests",
    "pullRequestSnapshots",
    "commits",
    "collections",
    "cdnSnapshots",
    "cdnLatest",
    "dependentSnapshots",
    "dependentLatest",
    "scorecardSnapshots",
    "scorecardLatest",
    "kitCounts",
  ] as const;
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = await count(table);
  return counts;
}

beforeEach(async () => {
  await freshDatabase(env.DB);
  await recordPackages(db(), PACKAGES, KNOWN_SINCE);
  for (const name of PACKAGES) await markHistoryCollected(db(), name, KNOWN_SINCE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a full run", () => {
  test("writes every source, stamped with the day the run happened", async () => {
    const stub = upstreams();
    stubUpstreams(stub);
    await using instance = await introspectWorkflowInstance(env.COLLECT, "full");
    await env.COLLECT.create({ id: "full", params: { date: "2026-11-09" } });
    await instance.waitForStatus("complete");

    const output = (await instance.getOutput()) as { capturedOn: string };
    expectToday(output.capturedOn);
    expect(output).toEqual({
      day: "2026-11-09",
      capturedOn: output.capturedOn,
      packages: 2,
      rows: {
        registry: 6,
        "daily downloads": 6,
        "version downloads": 4,
        github: 5,
        kit: 1,
        jsdelivr: 2,
        "deps.dev": 3,
      },
      published: {
        [snapshotKey(output.capturedOn, "summary")]: expect.any(Number),
        [snapshotKey(output.capturedOn, "latest")]: expect.any(Number),
        "summary.json": expect.any(Number),
        "latest.json": expect.any(Number),
      },
    });
    expect(await rowCounts()).toEqual({
      packages: 2,
      dailyDownloads: 6,
      versionDownloads: 4,
      npmDays: 1,
      versionPublishes: 4,
      registrySnapshots: 2,
      registryLatest: 2,
      repoSnapshots: 1,
      repoLatest: 1,
      issues: 1,
      issueSnapshots: 1,
      pullRequests: 1,
      pullRequestSnapshots: 1,
      commits: 2,
      collections: 8,
      cdnSnapshots: 2,
      cdnLatest: 2,
      dependentSnapshots: 2,
      dependentLatest: 2,
      scorecardSnapshots: 1,
      scorecardLatest: 1,
      kitCounts: 1,
    });
    expect(
      await db().selectFrom("kitCounts").select(["repo", "capturedOn", "commit", "tests", "codeLines"]).execute(),
    ).toEqual([{ repo: "pithy-sh/pithy", capturedOn: output.capturedOn, commit: HEAD, tests: 3, codeLines: 4 }]);
    expect(await db().selectFrom("repoLatest").selectAll().execute()).toEqual([
      {
        repo: "pithy-sh/pithy",
        capturedOn: output.capturedOn,
        createdAt: Date.parse("2026-09-01T00:00:00Z"),
        stars: 50,
        forks: 4,
        commits: 900,
        contributors: 2,
      },
    ]);
  });

  test("reads GitHub with the token from the secrets store and never returns it", async () => {
    const stub = upstreams();
    stubUpstreams(stub);
    await using instance = await introspectWorkflowInstance(env.COLLECT, "token-run");
    await env.COLLECT.create({ id: "token-run", params: { date: "2026-11-09" } });
    await instance.waitForStatus("complete");

    const github = stub.calls.filter((call) => call.url.startsWith("https://api.github.com/"));
    expect(github.length).toBeGreaterThan(0);
    for (const call of github) expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    for (const call of stub.calls.filter((call) => !call.url.startsWith("https://api.github.com/"))) {
      expect(call.headers.get("authorization")).toBeNull();
    }
    expect(JSON.stringify(await instance.getOutput())).not.toContain(TOKEN);
    expect(JSON.stringify(await instance.waitForStepResult({ name: "github" }))).not.toContain(TOKEN);
    expect(JSON.stringify(await instance.waitForStepResult({ name: "kit" }))).not.toContain(TOKEN);
    expect(stub.calls.filter((call) => call.url === TARBALL_URL)).toHaveLength(1);
  });
});

describe("a run's day and the day it captures", () => {
  test("two runs on one capture day leave one set of rows, holding the second run's values", async () => {
    stubUpstreams(upstreams());
    {
      await using first = await introspectWorkflowInstance(env.COLLECT, "same-day-1");
      await env.COLLECT.create({ id: "same-day-1", params: { date: "2026-11-09" } });
      await first.waitForStatus("complete");
    }
    const once = await rowCounts();

    vi.restoreAllMocks();
    stubUpstreams(upstreams(() => 42, 77));
    let capturedOn: string;
    {
      await using second = await introspectWorkflowInstance(env.COLLECT, "same-day-2");
      await env.COLLECT.create({ id: "same-day-2", params: { date: "2026-11-09" } });
      await second.waitForStatus("complete");
      ({ capturedOn } = (await second.getOutput()) as { capturedOn: string });
    }
    expect(await rowCounts()).toEqual(once);
    expect(await db().selectFrom("repoSnapshots").select(["capturedOn", "stars"]).execute()).toEqual([
      { capturedOn, stars: 77 },
    ]);
    expect(await db().selectFrom("repoLatest").select(["capturedOn", "stars"]).execute()).toEqual([
      { capturedOn, stars: 77 },
    ]);
    const daily = await db().selectFrom("dailyDownloads").select(["downloads", "capturedOn"]).execute();
    expect(daily).toHaveLength(once.dailyDownloads ?? 0);
    for (const row of daily) expect(row).toEqual({ downloads: 42, capturedOn });
  });

  test("an instance id is not a date: params {} under a date-shaped id runs for the day it was created", async () => {
    stubUpstreams(upstreams());
    await using instance = await introspectWorkflowInstance(env.COLLECT, "2026-10-01");
    await env.COLLECT.create({ id: "2026-10-01", params: {} });
    await instance.waitForStatus("complete");
    const output = (await instance.getOutput()) as { day: string; capturedOn: string };
    expectToday(output.day);
    expect(output.capturedOn).toBe(output.day);
  });

  test("re-running an earlier date refills its daily downloads and leaves its snapshots as they were", async () => {
    const earlier = "2026-11-05";
    const core = "@pithy-sh/core";
    await writeVersionDownloads(db(), core, { "0.1.0": 1, "0.2.0": 2 }, earlier);
    await writeRegistry(
      db(),
      core,
      {
        latestVersion: "0.1.0",
        description: null,
        createdAt: new Date("2026-09-05T00:00:00Z"),
        versions: [{ version: "0.1.0", publishedAt: new Date("2026-09-05T00:00:00Z") }],
        unpackedSize: 10,
        fileCount: 1,
        dependencies: {},
        peerDependencies: {},
      },
      earlier,
    );
    await writeRepo(
      db(),
      "pithy-sh/pithy",
      { createdAt: new Date("2026-09-01T00:00:00Z"), stars: 7, forks: 1, commits: 100, contributors: 1 },
      earlier,
    );
    await writeCdn(db(), core, { period: "month", hits: 5, bandwidth: 50, rank: null }, earlier);
    await writeDependents(
      db(),
      core,
      { version: "0.1.0", dependents: 0, directDependents: 0, indirectDependents: 0 },
      earlier,
    );
    const snapshotsOn = async (day: string) => ({
      versionDownloads: await db().selectFrom("versionDownloads").selectAll().where("capturedOn", "=", day).execute(),
      registry: await db().selectFrom("registrySnapshots").selectAll().where("capturedOn", "=", day).execute(),
      repo: await db().selectFrom("repoSnapshots").selectAll().where("capturedOn", "=", day).execute(),
      cdn: await db().selectFrom("cdnSnapshots").selectAll().where("capturedOn", "=", day).execute(),
      dependents: await db().selectFrom("dependentSnapshots").selectAll().where("capturedOn", "=", day).execute(),
      issues: await db().selectFrom("issueSnapshots").selectAll().where("capturedOn", "=", day).execute(),
      pullRequests: await db().selectFrom("pullRequestSnapshots").selectAll().where("capturedOn", "=", day).execute(),
    });
    const before = await snapshotsOn(earlier);

    const stub = upstreams(() => 99, 500);
    stubUpstreams(stub);
    await using instance = await introspectWorkflowInstance(env.COLLECT, "rerun-earlier");
    await env.COLLECT.create({ id: "rerun-earlier", params: { date: earlier } });
    await instance.waitForStatus("complete");
    const output = (await instance.getOutput()) as { day: string; capturedOn: string };
    expect(output.day).toBe(earlier);
    expectToday(output.capturedOn);

    expect(await snapshotsOn(earlier)).toEqual(before);
    const ranges = stub.calls.filter((call) => call.url.startsWith("https://api.npmjs.org/downloads/range/"));
    for (const call of ranges) expect(call.url).toContain("/2026-11-02:2026-11-04/");
    const refilled = await db()
      .selectFrom("dailyDownloads")
      .select(["day", "downloads", "capturedOn"])
      .where("packageName", "=", core)
      .orderBy("day")
      .execute();
    expect(refilled).toEqual(
      ["2026-11-02", "2026-11-03", "2026-11-04"].map((day) => ({ day, downloads: 99, capturedOn: output.capturedOn })),
    );
    expect(await db().selectFrom("repoLatest").select(["capturedOn", "stars"]).execute()).toEqual([
      { capturedOn: output.capturedOn, stars: 500 },
    ]);
    const packages = await db().selectFrom("packages").select(["firstSeenOn", "lastSeenOn"]).execute();
    for (const row of packages) expect(row).toEqual({ firstSeenOn: KNOWN_SINCE, lastSeenOn: output.capturedOn });
  });

  test("the cron starts a run for the day it fires on", async () => {
    stubUpstreams(upstreams());
    await using introspector = await introspectWorkflow(env.COLLECT);
    const scheduled = worker.scheduled;
    if (scheduled === undefined) throw new Error("The Worker exports no scheduled handler.");
    await scheduled({ cron: COLLECT_CRON }, env as unknown as Record<string, unknown>, {} as ExecutionContext);
    const [instance] = await introspector.get();
    if (instance === undefined) throw new Error("The cron started no instance.");
    await instance.waitForStatus("complete");
    const output = (await instance.getOutput()) as { day: string; capturedOn: string };
    expectToday(output.day);
    expect(output.capturedOn).toBe(output.day);
  });

  test("the cron names its run by the UTC day it fired for, and a second fire that day is logged, not run", async () => {
    stubUpstreams(upstreams());
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const scheduled = worker.scheduled;
    if (scheduled === undefined) throw new Error("The Worker exports no scheduled handler.");
    const fire = { cron: COLLECT_CRON, scheduledTime: Date.parse("2026-11-07T02:00:00Z") };
    const workerEnv = env as unknown as Record<string, unknown>;

    // Held to the end of the test: disposing an instance's introspector removes the instance.
    await using instance = await introspectWorkflowInstance(env.COLLECT, "2026-11-07");
    await scheduled(fire, workerEnv, {} as ExecutionContext);
    await instance.waitForStatus("complete");
    const runs = lines.length;
    await expect(scheduled(fire, workerEnv, {} as ExecutionContext)).resolves.toBeUndefined();

    const already = lines.slice(runs).filter((line) => line.includes("workflow already started"));
    expect(already).toHaveLength(1);
    expect(already[0]).toContain('"workflow":"api/collect"');
    expect(already[0]).toContain('"id":"2026-11-07"');
    expect(await (await env.COLLECT.get("2026-11-07")).status()).toMatchObject({ status: "complete" });
  });

  test("a cron the collector does not declare starts nothing", async () => {
    await using introspector = await introspectWorkflow(env.COLLECT);
    await worker.scheduled?.({ cron: "5 * * * *" }, env as unknown as Record<string, unknown>, {} as ExecutionContext);
    expect(await introspector.get()).toHaveLength(0);
  });
});

describe("daily downloads", () => {
  test("each run overwrites the last three days and leaves older days alone", async () => {
    await writeDailyDownloads(
      db(),
      "@pithy-sh/core",
      ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"].map((day) => ({ day, downloads: 1 })),
      "2026-11-08",
    );
    const stub = upstreams(() => 99);
    stubUpstreams(stub);
    await using instance = await introspectWorkflowInstance(env.COLLECT, "overwrite");
    await env.COLLECT.create({ id: "overwrite", params: { date: "2026-11-09" } });
    await instance.waitForStatus("complete");
    const { capturedOn } = (await instance.getOutput()) as { capturedOn: string };

    const ranges = stub.calls.filter((call) => call.url.startsWith("https://api.npmjs.org/downloads/range/"));
    expect(ranges.map((call) => call.url)).toEqual(
      PACKAGES.map((name) => `https://api.npmjs.org/downloads/range/2026-11-06:2026-11-08/${name}`),
    );
    const core = await db()
      .selectFrom("dailyDownloads")
      .select(["day", "downloads", "capturedOn"])
      .where("packageName", "=", "@pithy-sh/core")
      .orderBy("day")
      .execute();
    expect(core).toEqual([
      { day: "2026-11-05", downloads: 1, capturedOn: "2026-11-08" },
      { day: "2026-11-06", downloads: 99, capturedOn },
      { day: "2026-11-07", downloads: 99, capturedOn },
      { day: "2026-11-08", downloads: 99, capturedOn },
    ]);
  });

  test("a backfill loads every day from the kit's first publish, and re-running it changes nothing", async () => {
    const stub = upstreams();
    stubUpstreams(stub);
    for (const id of ["backfill-1", "backfill-2"]) {
      await using instance = await introspectWorkflowInstance(env.COLLECT, id);
      await env.COLLECT.create({ id, params: { date: "2026-11-09", backfill: true } });
      await instance.waitForStatus("complete");
      expect(await count("dailyDownloads")).toBe(2 * 65);
    }
    const ranges = stub.calls.filter((call) => call.url.startsWith("https://api.npmjs.org/downloads/range/"));
    for (const call of ranges) expect(call.url).toContain("/2026-09-05:2026-11-08/");
  });
});

describe("each source is its own step", () => {
  test("a failing step is retried, and the steps before and after it run once", async () => {
    const stub = upstreams();
    stubUpstreams(stub);
    await using instance = await introspectWorkflowInstance(env.COLLECT, "retry");
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "github" }, new Error("GitHub is down"), 2);
    });
    await env.COLLECT.create({ id: "retry", params: { date: "2026-11-09" } });
    await instance.waitForStatus("complete");

    expect(await count("repoLatest")).toBe(1);
    const fetched = (prefix: string) => stub.calls.filter((call) => call.url.startsWith(prefix)).length;
    expect(fetched("https://registry.npmjs.org/-/org/")).toBe(1);
    expect(fetched("https://api.npmjs.org/versions/")).toBe(PACKAGES.length);
    expect(fetched("https://data.jsdelivr.com/")).toBe(PACKAGES.length);
    expect(fetched("https://api.github.com/repos/pithy-sh/pithy/contributors")).toBe(1);
    expect(fetched(TARBALL_URL)).toBe(1);
  });

  test("a source that exhausts its retries does not stop the others, and the run fails naming it", async () => {
    stubUpstreams(upstreams());
    await using instance = await introspectWorkflowInstance(env.COLLECT, "exhausted");
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      for (const name of PACKAGES) await m.mockStepError({ name: `jsdelivr ${name}` }, new Error("jsDelivr is down"));
    });
    await env.COLLECT.create({ id: "exhausted", params: { date: "2026-11-09" } });
    await instance.waitForStatus("errored");

    expect((await instance.getError()).message).toContain("jsdelivr");
    expect(await count("cdnLatest")).toBe(0);
    expect(await count("dependentLatest")).toBe(PACKAGES.length);
    expect(await count("repoLatest")).toBe(1);
  });

  test("a refill run that fails names a refill id other than its own, so following it again is not refused", async () => {
    stubUpstreams(upstreams());
    const ownId = refillCommand("dev", "2026-11-08", new Date("2026-11-09T02:41:07.250Z")).split("--id ")[1] ?? "";
    // Runs each step's work once, failing every jsDelivr step as one that exhausted its retries would.
    const step = {
      do: async (name: string, _config: unknown, work: () => Promise<unknown>) => {
        if (name.startsWith("jsdelivr")) throw new Error("jsDelivr is down");
        return work();
      },
    } as unknown as CollectStep;
    const event = { payload: { date: "2026-11-08" }, timestamp: new Date(), instanceId: ownId };

    const failure = await runCollect(env as unknown as CollectEnv, event, step).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PithyError);
    const action = (failure as PithyError).payload.action ?? "";
    expect(action).toContain(`--params '{"date":"2026-11-08"}' --id refill-2026-11-08-`);
    expect(action).not.toContain(`--id ${ownId}`);
  });

  test("a kit count that cannot be read fails only its own step: every other source still writes and publishes", async () => {
    const before = new Date("2026-11-08T02:01:30Z");
    await recordCollected(db(), "kit", before);
    stubUpstreams(upstreams(undefined, undefined, () => ({ status: 502, json: { message: "Bad Gateway" } })));
    await using instance = await introspectWorkflowInstance(env.COLLECT, "kit-down");
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
    });
    await env.COLLECT.create({ id: "kit-down", params: { date: "2026-11-09" } });
    await instance.waitForStatus("errored");

    expect((await instance.getError()).message).toContain("kit");
    expect(await count("kitCounts")).toBe(0);
    expect(await count("repoLatest")).toBe(1);
    expect(await count("cdnLatest")).toBe(PACKAGES.length);
    expect(await count("dependentLatest")).toBe(PACKAGES.length);
    const latest = Latest.parse(await published(currentKey("latest")));
    expect(latest.sources.kit.collectedAt).toBe(before.toISOString());
    expect(latest.sources.github.collectedAt).not.toBeNull();
    expect(latest.kit).toEqual({ commit: null, countedAt: null, tests: null, codeLines: null, history: [] });
  });

  test("a failed package list stops the run before any per-package source", async () => {
    const stub = upstreams();
    stubUpstreams(stub);
    await using instance = await introspectWorkflowInstance(env.COLLECT, "no-list");
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "package list" }, new Error("registry is down"));
    });
    await env.COLLECT.create({ id: "no-list", params: { date: "2026-11-09" } });
    await instance.waitForStatus("errored");
    expect(stub.calls).toHaveLength(0);
  });
});

describe("per-package steps", () => {
  test("every per-package source runs one step per package, then one recording it complete", async () => {
    stubUpstreams(upstreams());
    await using instance = await introspectWorkflowInstance(env.COLLECT, "per-package");
    await env.COLLECT.create({ id: "per-package", params: { date: "2026-11-09" } });
    await instance.waitForStatus("complete");

    for (const source of ["registry", "daily downloads", "version downloads", "jsdelivr", "deps.dev"]) {
      for (const name of PACKAGES) {
        expect(await instance.waitForStepResult({ name: `${source} ${name}` }), `${source} ${name}`).toEqual(
          expect.any(Number),
        );
      }
      expect(await instance.waitForStepResult({ name: source })).toBe(0);
    }
    expect(await instance.waitForStepResult({ name: "deps.dev scorecard" })).toBe(1);
    expect(await instance.waitForStepResult({ name: "daily downloads @pithy-sh/core" })).toBe(3);
  });

  test("a package that exhausts its retries leaves the other packages' rows written, and the run's failure names it", async () => {
    const failing = "@pithy-sh/core";
    const stub = upstreamsWith({
      [`https://api.npmjs.org/downloads/range/2026-11-06:2026-11-08/${failing}`]: { status: 503 },
    });
    stubUpstreams(stub);
    await using instance = await introspectWorkflowInstance(env.COLLECT, "one-package-down");
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
    });
    await env.COLLECT.create({ id: "one-package-down", params: { date: "2026-11-09" } });
    await instance.waitForStatus("errored");

    const message = (await instance.getError()).message;
    expect(message).toContain(`daily downloads (${failing})`);
    const daily = await db().selectFrom("dailyDownloads").select("packageName").execute();
    expect(daily.map((row) => row.packageName)).toEqual(["@pithy-sh/auth", "@pithy-sh/auth", "@pithy-sh/auth"]);
    const ranges = stub.calls.filter((call) => call.url.startsWith("https://api.npmjs.org/downloads/range/"));
    expect(ranges.filter((call) => call.url.endsWith("@pithy-sh/auth"))).toHaveLength(1);
    const collected = await db().selectFrom("collections").select("step").execute();
    expect(collected.map((row) => row.step)).not.toContain("dailyDownloads");
    expect(collected.map((row) => row.step)).toContain("versionDownloads");
    expect(await count("versionDownloads")).toBe(4);
    // The run still publishes everything that did write.
    expect(await published(currentKey("latest"))).not.toBeNull();
  });

  test("a source tries every package however many fail, and its failure names only the ones that did", async () => {
    const many = Array.from({ length: 8 }, (_, i) => `@pithy-sh/p${i}`);
    // Four in a row, then failures between successes: neither a run of failures nor their total stops the source.
    const failing = new Set(["p0", "p1", "p2", "p3", "p5", "p7"].map((short) => `@pithy-sh/${short}`));
    const cdn = "https://data.jsdelivr.com/v1/stats/packages/npm/";
    const stub = upstreamsWith({
      "https://registry.npmjs.org/-/org/pithy-sh/package": { json: Object.fromEntries(many.map((n) => [n, "write"])) },
      [`${cdn}*`]: (call) =>
        failing.has(call.url.slice(cdn.length).split("?")[0] ?? "") ? { status: 500 } : { status: 599 },
    });
    stubUpstreams(stub);
    await using instance = await introspectWorkflowInstance(env.COLLECT, "many-down");
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
    });
    await env.COLLECT.create({ id: "many-down", params: { date: "2026-11-09" } });
    await instance.waitForStatus("errored");

    const tried = new Set(stub.calls.filter((call) => call.url.startsWith(cdn)).map((call) => call.url));
    expect(tried.size).toBe(many.length);
    const cdnRows = await db().selectFrom("cdnLatest").select("packageName").orderBy("packageName").execute();
    expect(cdnRows.map((row) => row.packageName)).toEqual(["@pithy-sh/p4", "@pithy-sh/p6"]);
    const message = (await instance.getError()).message;
    expect(message).toContain(`jsdelivr (${[...failing].join(", ")})`);
    expect(message).not.toContain("not tried");
    expect(await count("dependentLatest")).toBe(many.length);
  });

  test("a source whose packages all wrote but whose completion step fails keeps their rows, and the run names it", async () => {
    stubUpstreams(upstreams());
    await using instance = await introspectWorkflowInstance(env.COLLECT, "no-completion");
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "jsdelivr" }, new Error("D1 is down"));
    });
    await env.COLLECT.create({ id: "no-completion", params: { date: "2026-11-09" } });
    await instance.waitForStatus("errored");

    expect((await instance.getError()).message).toContain("could not collect: jsdelivr.");
    expect(await count("cdnLatest")).toBe(PACKAGES.length);
    const collected = await db().selectFrom("collections").select("step").execute();
    expect(collected.map((row) => row.step)).not.toContain("jsdelivr");
    expect(collected.map((row) => row.step)).toContain("depsDev");
  });
});

describe("npm's rate limit", () => {
  test("a burst of 429s is retried in place and the run completes with every row", async () => {
    let refused = 0;
    const stub = upstreamsWith({
      "https://api.npmjs.org/versions/*": () =>
        ++refused <= 4 ? { status: 429, headers: { "retry-after": "0" } } : { json: { downloads: { "0.1.0": 3 } } },
    });
    stubUpstreams(stub);
    await using instance = await introspectWorkflowInstance(env.COLLECT, "npm-burst");
    await env.COLLECT.create({ id: "npm-burst", params: { date: "2026-11-09" } });
    await instance.waitForStatus("complete");

    expect(await count("versionDownloads")).toBe(PACKAGES.length);
    expect(stub.calls.filter((call) => call.url.startsWith("https://api.npmjs.org/versions/"))).toHaveLength(
      PACKAGES.length + 4,
    );
  });

  test("requests to npm's downloads API are paced by the measured gap", async () => {
    stubUpstreams(upstreams());
    await using instance = await introspectWorkflowInstance(env.COLLECT, "paced");
    await env.COLLECT.create({ id: "paced", params: { date: "2026-11-09" } });
    await instance.waitForStatus("complete");
    // Six npm requests (the two that ask which days npm has counted, then two packages in two sources), each waiting
    // out the gap after the one before it. The first waits too when an earlier test's request was the last to go,
    // since time moves here only by sleeping.
    expect(sleeps.length).toBeGreaterThanOrEqual(5);
    expect(sleeps.every((ms) => ms === NPM_API_GAP_MS)).toBe(true);
  });
});

describe("why a step failed", () => {
  test("its upstream detail reaches the Worker log, and the token and headers never do", async () => {
    stubUpstreams(
      upstreamsWith({ "https://api.github.com/graphql": { status: 401, json: { message: "Bad credentials" } } }),
    );
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    await using instance = await introspectWorkflowInstance(env.COLLECT, "logged");
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
    });
    await env.COLLECT.create({ id: "logged", params: { date: "2026-11-09" } });
    await instance.waitForStatus("errored");

    const failures = lines.filter((line) => line.includes("collector step failed"));
    expect(failures.length).toBeGreaterThan(0);
    const github = failures.filter((line) => line.includes('"step":"github"'));
    expect(github.length).toBeGreaterThan(0);
    expect(github[0]).toContain("https://api.github.com/graphql answered 401.");
    expect(github[0]).toContain('"instance":"logged"');
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line.toLowerCase()).not.toContain("authorization");
      expect(line).not.toContain("Bearer");
    }
  });
});

/** The JSON object R2 holds at `key`, or null. */
async function published(key: string): Promise<unknown> {
  const object = await env.PUBLISHED.get(key);
  return object === null ? null : await object.json();
}

describe("the publish step", () => {
  test("writes summary.json, latest.json and both dated snapshots, after every source has written", async () => {
    stubUpstreams(upstreams());
    await using instance = await introspectWorkflowInstance(env.COLLECT, "publish");
    await env.COLLECT.create({ id: "publish", params: { date: "2026-11-09" } });
    await instance.waitForStatus("complete");
    const { capturedOn } = (await instance.getOutput()) as { capturedOn: string };

    const latest = Latest.parse(await published(currentKey("latest")));
    const summary = Summary.parse(await published(currentKey("summary")));
    expect(await published(snapshotKey(capturedOn, "latest"))).toEqual(latest);
    expect(await published(snapshotKey(capturedOn, "summary"))).toEqual(summary);
    expect((await env.PUBLISHED.get(currentKey("latest")))?.httpMetadata?.contentType).toBe(
      "application/json; charset=utf-8",
    );

    // deps.dev is the last source step: its numbers in the file show the publish ran after it.
    expect(latest.depsDev.dependents).toBe(4);
    // Dated by the Worker's READY_AFTER_MINUTES, 20 in the test runtime: the next run's ready time after the file.
    const schedule = { runStartMs: dailyRunStart(COLLECT_CRON), readyAfterMs: 20 * 60_000 };
    expect(latest.nextUpdate).toBe(nextUpdateAfter(new Date(latest.generatedAt), schedule).toISOString());
    expect(latest.nextUpdate).toMatch(/T02:20:00\.000Z$/);
    expect(Date.parse(latest.nextUpdate)).toBeGreaterThan(Date.parse(latest.generatedAt));
    expect(summary.nextUpdate).toBe(latest.nextUpdate);
    expect(latest.packages.map((row) => row.name)).toEqual(PACKAGES);
    expect(latest.packages[0]?.description).toBe("A Pithy package.");
    expect(latest.github).toMatchObject({ stars: 50, commits: 900, createdAt: "2026-09-01T00:00:00.000Z" });
    expect(latest.github.commitWeeks?.reduce((total, value) => total + value, 0)).toBe(2);
    for (const source of ["npm", "registry", "github", "jsdelivr", "depsDev", "scorecard", "kit"] as const) {
      expect(latest.sources[source].collectedAt, source).not.toBeNull();
    }
    expect(latest.kit).toMatchObject({
      commit: HEAD,
      tests: 3,
      codeLines: 4,
      history: [{ date: capturedOn, commit: HEAD, tests: 3, codeLines: 4 }],
    });
    expect(summary.kit).toEqual({ tests: 3, codeLines: 4, commit: HEAD });
    expect(summary).toMatchObject({
      asOf: "2026-11-08",
      github: { stars: 50 },
      releases: { packages: 2, versions: 4 },
    });
  });

  test("still publishes when a source fails, keeping that source's last good time", async () => {
    const before = new Date("2026-11-08T02:00:40Z");
    await recordCollected(db(), "jsdelivr", before);
    stubUpstreams(upstreams());
    await using instance = await introspectWorkflowInstance(env.COLLECT, "publish-stale");
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      for (const name of PACKAGES) await m.mockStepError({ name: `jsdelivr ${name}` }, new Error("jsDelivr is down"));
    });
    await env.COLLECT.create({ id: "publish-stale", params: { date: "2026-11-09" } });
    await instance.waitForStatus("errored");

    const latest = Latest.parse(await published(currentKey("latest")));
    expect(latest.sources.jsdelivr.collectedAt).toBe(before.toISOString());
    expect(latest.sources.github.collectedAt).not.toBeNull();
    expect(latest.jsdelivr.total).toBeNull();
  });

  test("two runs on one capture day: the day's snapshot carries the second run, and is never served immutable meanwhile", async () => {
    const serve = async (path: string): Promise<Response> => {
      const ctx = createExecutionContext();
      const response = await worker.fetch?.(
        new Request(`https://stats.pithy.sh${path}`) as Request<unknown, IncomingRequestCfProperties>,
        env as unknown as Record<string, unknown>,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      if (response === undefined) throw new Error("The Worker exports no fetch handler.");
      return response;
    };

    stubUpstreams(upstreams());
    let capturedOn: string;
    {
      await using first = await introspectWorkflowInstance(env.COLLECT, "snapshot-1");
      await env.COLLECT.create({ id: "snapshot-1", params: { date: "2026-11-09" } });
      await first.waitForStatus("complete");
      ({ capturedOn } = (await first.getOutput()) as { capturedOn: string });
    }
    const path = `/v1/snapshots/${capturedOn}/latest`;
    const once = await serve(path);
    expect(once.headers.get("cache-control")).not.toContain("immutable");
    expect(Latest.parse(await once.json()).github.stars).toBe(50);

    vi.restoreAllMocks();
    stubUpstreams(upstreams(() => 42, 77));
    {
      await using second = await introspectWorkflowInstance(env.COLLECT, "snapshot-2");
      await env.COLLECT.create({ id: "snapshot-2", params: { date: "2026-11-09" } });
      await second.waitForStatus("complete");
    }
    // The first answer's copies expire by midnight at the latest; the edge's goes when it does.
    await caches.default.delete(`https://stats.pithy.sh${path}`);
    const twice = await serve(path);
    expect(twice.headers.get("cache-control")).not.toContain("immutable");
    expect(twice.headers.get("etag")).not.toBe(once.headers.get("etag"));
    expect(Latest.parse(await twice.json()).github.stars).toBe(77);
  });
});

// Each test runs up to four instances in turn, so it gets more than the default five seconds.
describe("a newly seen package", { timeout: 30_000 }, () => {
  const FRESH = "@pithy-sh/fresh";
  const RANGES = "https://api.npmjs.org/downloads/range/";
  /** A package moved into the org with years of downloads behind it: older than npm's history. */
  const FRESH_CREATED = "2019-01-01T00:00:00Z";

  /** The org list holds {@link FRESH} beside {@link PACKAGES}, and the registry dates it {@link FRESH_CREATED}. */
  const withFresh = (overrides: Record<string, StubAnswer | ((call: StubCall) => StubAnswer)> = {}) =>
    upstreamsWith({
      "https://registry.npmjs.org/-/org/pithy-sh/package": {
        json: Object.fromEntries([...PACKAGES, FRESH].map((name) => [name, "write"])),
      },
      "https://registry.npmjs.org/@pithy-sh%2Ffresh": {
        json: {
          "dist-tags": { latest: "1.0.0" },
          time: { created: FRESH_CREATED, "1.0.0": FRESH_CREATED },
          versions: { "1.0.0": { dist: {} } },
        },
      },
      ...overrides,
    });

  /** Every daily-downloads URL the stub was asked for, of one package. */
  const rangesOf = (stub: ReturnType<typeof stubFetch>, name: string) =>
    stub.calls.filter((call) => call.url.startsWith(RANGES) && call.url.endsWith(`/${name}`)).map((call) => call.url);

  /** The URLs a package's whole history is fetched with on a run on `capturedOn`: clamped, then cut per request. */
  const historyUrls = (capturedOn: string, name: string) =>
    dayRanges(npmHistoryStart(capturedOn), addDays(capturedOn, -1), MAX_RANGE_DAYS).map(
      ({ start, end }) => `${RANGES}${start}:${end}/${name}`,
    );

  const markOf = async (name: string) =>
    (await db().selectFrom("packages").select("historyCollectedOn").where("name", "=", name).executeTakeFirst())
      ?.historyCollectedOn;

  /**
   * One run for 2026-11-09 against `stub`, with retry delays off. `errored` expects it to fail, and answers its
   * message; `modify` changes the instance first.
   */
  async function run(
    id: string,
    stub: ReturnType<typeof stubFetch>,
    options: { errored?: boolean; modify?: (m: WorkflowInstanceModifier) => Promise<void> } = {},
  ): Promise<string | null> {
    vi.restoreAllMocks();
    stubUpstreams(stub);
    await using instance = await introspectWorkflowInstance(env.COLLECT, id);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await options.modify?.(m);
    });
    await env.COLLECT.create({ id, params: { date: "2026-11-09" } });
    if (options.errored !== true) {
      await instance.waitForStatus("complete");
      return null;
    }
    await instance.waitForStatus("errored");
    return (await instance.getError()).message;
  }

  test("its first run fetches its whole history, clamped to npm's and cut per request, while known packages fetch three days", async () => {
    const stub = withFresh();
    stubUpstreams(stub);
    await using instance = await introspectWorkflowInstance(env.COLLECT, "fresh");
    await env.COLLECT.create({ id: "fresh", params: { date: "2026-11-09" } });
    await instance.waitForStatus("complete");
    const { capturedOn } = (await instance.getOutput()) as { capturedOn: string };

    const history = historyUrls(capturedOn, FRESH);
    expect(history.length).toBe(2);
    expect(rangesOf(stub, FRESH)).toEqual(history);
    for (const name of PACKAGES) expect(rangesOf(stub, name)).toEqual([`${RANGES}2026-11-06:2026-11-08/${name}`]);

    // The window was decided in its own step, before any package's step ran, and is journalled there.
    expect(await instance.waitForStepResult({ name: DOWNLOAD_WINDOWS })).toEqual({
      npm: {
        package: PACKAGES[0],
        lastDay: addDays(capturedOn, -1),
        lastWeek: { start: addDays(capturedOn, -7), end: addDays(capturedOn, -1) },
      },
      windows: {
        "@pithy-sh/auth": { start: "2026-11-06", end: "2026-11-08", history: false },
        "@pithy-sh/core": { start: "2026-11-06", end: "2026-11-08", history: false },
        [FRESH]: { start: npmHistoryStart(capturedOn), end: addDays(capturedOn, -1), history: true },
      },
    });
    const days = await db().selectFrom("dailyDownloads").select("day").where("packageName", "=", FRESH).execute();
    expect(days[0]?.day).toBe(npmHistoryStart(capturedOn));
    expect(await markOf(FRESH)).toBe(capturedOn);
    for (const name of PACKAGES) expect(await markOf(name)).toBe(KNOWN_SINCE);

    vi.restoreAllMocks();
    const next = withFresh();
    stubUpstreams(next);
    await using second = await introspectWorkflowInstance(env.COLLECT, "fresh-next");
    await env.COLLECT.create({ id: "fresh-next", params: { date: "2026-11-09" } });
    await second.waitForStatus("complete");
    expect(rangesOf(next, FRESH)).toEqual([`${RANGES}2026-11-06:2026-11-08/${FRESH}`]);
  });

  test("a first-sight step that fails keeps the whole window for the next run, until one succeeds", async () => {
    const down = (call: StubCall): StubAnswer => (call.url.endsWith(`/${FRESH}`) ? { status: 503 } : { status: 599 });

    const first = await run("fresh-down", withFresh({ [`${RANGES}*`]: down }), { errored: true });
    expect(first).toContain(`daily downloads (${FRESH})`);
    expect(await markOf(FRESH)).toBeNull();

    const again = withFresh({ [`${RANGES}*`]: down });
    const second = await run("fresh-down-again", again, { errored: true });
    expect(second).toContain(`daily downloads (${FRESH})`);
    const capturedOn = await db()
      .selectFrom("packages")
      .select("lastSeenOn")
      .where("name", "=", FRESH)
      .executeTakeFirstOrThrow();
    // Each attempt starts from the far end of the history again, and fails on its first request.
    expect(new Set(rangesOf(again, FRESH))).toEqual(new Set([historyUrls(capturedOn.lastSeenOn, FRESH)[0]]));
    expect(await markOf(FRESH)).toBeNull();

    const healthy = withFresh();
    await run("fresh-up", healthy);
    expect(rangesOf(healthy, FRESH)).toEqual(historyUrls(capturedOn.lastSeenOn, FRESH));
    expect(await markOf(FRESH)).toBe(capturedOn.lastSeenOn);

    const after = withFresh();
    await run("fresh-known", after);
    expect(rangesOf(after, FRESH)).toEqual([`${RANGES}2026-11-06:2026-11-08/${FRESH}`]);
  });

  test("a package whose registry step failed waits for a run that knows its creation day", async () => {
    const noRegistry = withFresh({ "https://registry.npmjs.org/@pithy-sh%2Ffresh": { status: 500 } });
    const first = await run("fresh-no-registry", noRegistry, { errored: true });
    expect(first).toContain(`registry (${FRESH})`);
    expect(rangesOf(noRegistry, FRESH)).toEqual([`${RANGES}2026-11-06:2026-11-08/${FRESH}`]);
    expect(await markOf(FRESH)).toBeNull();

    const healthy = withFresh();
    await run("fresh-registry-back", healthy);
    const { lastSeenOn } = await db()
      .selectFrom("packages")
      .select("lastSeenOn")
      .where("name", "=", FRESH)
      .executeTakeFirstOrThrow();
    expect(rangesOf(healthy, FRESH)).toEqual(historyUrls(lastSeenOn, FRESH));
    expect(await markOf(FRESH)).toBe(lastSeenOn);
  });

  test("when the windows cannot be decided, no package fetches daily or version downloads, none is marked, and the run names all three", async () => {
    const stub = withFresh();
    const error = await run("no-windows", stub, {
      errored: true,
      modify: (m) => m.mockStepError({ name: DOWNLOAD_WINDOWS }, new Error("D1 is down")),
    });
    expect(error).toContain(`${DOWNLOAD_WINDOWS}, version downloads, daily downloads`);
    expect(stub.calls.filter((call) => call.url.startsWith(RANGES))).toEqual([]);
    expect(stub.calls.filter((call) => call.url.startsWith("https://api.npmjs.org/versions/"))).toEqual([]);
    expect(await markOf(FRESH)).toBeNull();
    expect(await count("versionDownloads")).toBe(0);
  });
});

// Each test runs an instance end to end against a stubbed npm that has not yet counted the day before the run.
describe("npm's last complete day", { timeout: 30_000 }, () => {
  const RANGES = "https://api.npmjs.org/downloads/range/";
  const POINTS = "https://api.npmjs.org/downloads/point/";
  const VERSIONS = "https://api.npmjs.org/versions/";
  /** Two days before the day the test runs on: npm has not finished counting yesterday. */
  const twoDaysBack = () => addDays(new Date().toISOString().slice(0, 10), -2);

  /** `upstreams()`, with npm's last complete day two days back and a count of 0 for any later day, as npm answers. */
  function lagging(): ReturnType<typeof stubFetch> {
    return upstreamsWith({
      ...npmPoints(twoDaysBack),
      [`${RANGES}*`]: (call) => {
        const [start = "", end = ""] = (call.url.slice(RANGES.length).split("/")[0] ?? "").split(":");
        const days: { day: string; downloads: number }[] = [];
        for (let day = start; day <= end; day = addDays(day, 1)) {
          days.push({ day, downloads: day > twoDaysBack() ? 0 : 10 });
        }
        return { json: { downloads: days } };
      },
    });
  }

  test("a run before npm has counted yesterday neither stores nor publishes a row for it", async () => {
    const stub = lagging();
    stubUpstreams(stub);
    await using instance = await introspectWorkflowInstance(env.COLLECT, "lagging");
    await env.COLLECT.create({ id: "lagging", params: {} });
    await instance.waitForStatus("complete");
    const { capturedOn } = (await instance.getOutput()) as { capturedOn: string };
    const lastDay = addDays(capturedOn, -2);

    // Asked once per run, for one package, before any package's version or daily downloads, through the paced client;
    // last-week is asked twice more once every package's per-version counts are in, before and after dating them,
    // both before any daily downloads.
    const points = stub.calls.filter((call) => call.url.startsWith(POINTS)).map((call) => call.url);
    expect(points).toEqual([
      `${POINTS}last-day/${PACKAGES[0]}`,
      `${POINTS}last-week/${PACKAGES[0]}`,
      `${POINTS}last-week/${PACKAGES[0]}`,
      `${POINTS}last-week/${PACKAGES[0]}`,
    ]);
    const urls = stub.calls.map((call) => call.url);
    const firstVersions = urls.findIndex((url) => url.startsWith(VERSIONS));
    const lastVersions = urls.length - 1 - [...urls].reverse().findIndex((url) => url.startsWith(VERSIONS));
    expect(urls.indexOf(`${POINTS}last-week/${PACKAGES[0]}`)).toBeLessThan(firstVersions);
    expect(urls.lastIndexOf(`${POINTS}last-week/${PACKAGES[0]}`)).toBeGreaterThan(lastVersions);
    expect(urls.lastIndexOf(`${POINTS}last-week/${PACKAGES[0]}`)).toBeLessThan(
      urls.findIndex((url) => url.startsWith(RANGES)),
    );

    // Every window ends at npm's last complete day and still overwrites three days.
    for (const name of PACKAGES) {
      expect(stub.calls.filter((call) => call.url.startsWith(RANGES) && call.url.endsWith(`/${name}`))).toEqual([
        expect.objectContaining({ url: `${RANGES}${addDays(lastDay, -2)}:${lastDay}/${name}` }),
      ]);
    }
    const days = await db().selectFrom("dailyDownloads").select("day").distinct().orderBy("day").execute();
    expect(days.map((row) => row.day)).toEqual([addDays(lastDay, -2), addDays(lastDay, -1), lastDay]);
    expect(await db().selectFrom("npmDays").selectAll().execute()).toEqual([
      { capturedOn, lastDay, weekStart: addDays(lastDay, -6), weekEnd: lastDay },
    ]);

    const latest = Latest.parse(await published(currentKey("latest")));
    const summary = Summary.parse(await published(currentKey("summary")));
    expect(latest.asOf).toBe(lastDay);
    expect(latest.downloads.end).toBe(lastDay);
    expect(latest.downloads.kit?.at(-1)).toBe(20);
    for (const row of latest.packages) expect(row.daily?.at(-1)).toBe(10);
    expect(summary.asOf).toBe(lastDay);
    expect(summary.downloads).toMatchObject({ allTime: 60, last7: 60, prior7: 0, last30: 60 });
    // The per-version counts captured today are dated by npm's last-week window, not by the capture day.
    for (const row of latest.packages) {
      expect(row.versionWeeks).toEqual([
        { start: addDays(lastDay, -6), end: lastDay, counts: { "0.1.0": 3, "0.2.0": 30 } },
      ]);
    }
  });

  test("a zero row stored before for a day npm has not counted is never asOf, and is overwritten once npm counts it", async () => {
    const pending = addDays(new Date().toISOString().slice(0, 10), -1);
    for (const name of PACKAGES) await writeDailyDownloads(db(), name, [{ day: pending, downloads: 0 }], KNOWN_SINCE);

    stubUpstreams(lagging());
    {
      await using instance = await introspectWorkflowInstance(env.COLLECT, "zero-row-early");
      await env.COLLECT.create({ id: "zero-row-early", params: {} });
      await instance.waitForStatus("complete");
    }
    const early = Latest.parse(await published(currentKey("latest")));
    expect(early.asOf).toBe(twoDaysBack());
    expect(early.downloads.end).toBe(twoDaysBack());

    vi.restoreAllMocks();
    stubUpstreams(upstreams(() => 7));
    {
      await using instance = await introspectWorkflowInstance(env.COLLECT, "zero-row-counted");
      await env.COLLECT.create({ id: "zero-row-counted", params: {} });
      await instance.waitForStatus("complete");
    }
    const counted = Latest.parse(await published(currentKey("latest")));
    expect(counted.asOf).toBe(pending);
    expect(counted.downloads.kit?.at(-1)).toBe(14);
  });

  test("a probe npm cannot answer is retried, then fails the windows step: nothing uncounted is fetched", async () => {
    // A capture from before npm was asked: it has no week, so it is never published under one derived from its day.
    for (const name of PACKAGES) await writeVersionDownloads(db(), name, { "0.1.0": 5 }, addDays(today(), -3));
    const stub = upstreamsWith({ [`${POINTS}*`]: { status: 503 } });
    stubUpstreams(stub);
    await using instance = await introspectWorkflowInstance(env.COLLECT, "no-probe");
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
    });
    await env.COLLECT.create({ id: "no-probe", params: {} });
    await instance.waitForStatus("errored");

    expect((await instance.getError()).message).toContain(DOWNLOAD_WINDOWS);
    expect(stub.calls.filter((call) => call.url.startsWith(RANGES))).toEqual([]);
    expect(stub.calls.filter((call) => call.url.startsWith(VERSIONS))).toEqual([]);
    expect(stub.calls.filter((call) => call.url.startsWith(POINTS)).length).toBeGreaterThan(1);
    expect(await count("npmDays")).toBe(0);
    expect(await count("versionDownloads")).toBe(PACKAGES.length);
    const latest = Latest.parse(await published(currentKey("latest")));
    for (const row of latest.packages) expect(row.versionWeeks).toEqual([]);
  });

  test("npm closing a day between the probe and the per-version counts leaves today's counts undated and unpublished", async () => {
    // npm's last-week ends two days back until the first per-version request, then yesterday: a day closed mid-run.
    let rolled = false;
    const lastDay = () => (rolled ? yesterday() : twoDaysBack());
    const stub = upstreamsWith({
      ...npmPoints(lastDay),
      [`${VERSIONS}*`]: () => {
        rolled = true;
        return { status: 599 };
      },
    });
    stubUpstreams(stub);
    await using instance = await introspectWorkflowInstance(env.COLLECT, "rolled");
    await env.COLLECT.create({ id: "rolled", params: {} });
    await instance.waitForStatus("complete");
    const { capturedOn } = (await instance.getOutput()) as { capturedOn: string };

    expect(await count("versionDownloads")).toBe(2 * PACKAGES.length);
    expect(await db().selectFrom("npmDays").selectAll().execute()).toEqual([
      { capturedOn, lastDay: addDays(capturedOn, -2), weekStart: null, weekEnd: null },
    ]);
    const latest = Latest.parse(await published(currentKey("latest")));
    expect(latest.asOf).toBe(addDays(capturedOn, -2));
    for (const row of latest.packages) expect(row.versionWeeks).toEqual([]);
  });

  test("a lag longer than the overwrite is caught up by the first run after npm recovers", async () => {
    const fiveBack = () => addDays(today(), -6);
    vi.restoreAllMocks();
    stubUpstreams(upstreamsWith(npmPoints(fiveBack)));
    {
      await using instance = await introspectWorkflowInstance(env.COLLECT, "lag-five");
      await env.COLLECT.create({ id: "lag-five", params: {} });
      await instance.waitForStatus("complete");
    }
    const lagged = await db().selectFrom("dailyDownloads").select("day").distinct().orderBy("day").execute();
    expect(lagged.map((row) => row.day)).toEqual([-8, -7, -6].map((back) => addDays(today(), back)));

    vi.restoreAllMocks();
    const recovered = upstreams();
    stubUpstreams(recovered);
    {
      await using instance = await introspectWorkflowInstance(env.COLLECT, "lag-recovered");
      await env.COLLECT.create({ id: "lag-recovered", params: {} });
      await instance.waitForStatus("complete");
    }
    for (const name of PACKAGES) {
      expect(recovered.calls.filter((call) => call.url.startsWith(RANGES) && call.url.endsWith(`/${name}`))).toEqual([
        expect.objectContaining({ url: `${RANGES}${addDays(today(), -5)}:${yesterday()}/${name}` }),
      ]);
    }
    const days = await db().selectFrom("dailyDownloads").select("day").distinct().orderBy("day").execute();
    expect(days.map((row) => row.day)).toEqual([-8, -7, -6, -5, -4, -3, -2, -1].map((back) => addDays(today(), back)));
    const latest = Latest.parse(await published(currentKey("latest")));
    expect(latest.asOf).toBe(yesterday());
  });
});

/**
 * A flag one side sets and the other waits on. The wait polls on its own timer rather than awaiting a promise the other
 * side settles: a Workflow step and the test run in separate request contexts, and the runtime takes a step waiting on
 * the test's promise for a hung request.
 */
function gate(): { open: () => void; opened: () => Promise<void> } {
  let open = false;
  return {
    open: () => {
      open = true;
    },
    opened: async () => {
      while (!open) await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
}

// Two instances run side by side, each held at one request until the test lets it through.
describe("two runs on one day at once", { timeout: 30_000 }, () => {
  const VERSIONS = "https://api.npmjs.org/versions/";
  const SCORECARD = "https://api.deps.dev/v3/projects/";
  /** Two days before the day the test runs on. */
  const twoDaysBack = () => addDays(today(), -2);
  const week = (lastDay: string) => ({ start: addDays(lastDay, -6), end: lastDay });

  /**
   * Upstreams for two runs started one after the other. The first waits at its last request before publishing, the
   * second at its first per-version request, by when its download-windows step has written today's npm row, as the
   * 02:00 cron did over a manual run. npm names `firstDay()` as its last complete day until the first run is held, and
   * `secondDay()` after.
   */
  function heldRuns(firstDay: () => string, secondDay: () => string) {
    const firstHeld = gate();
    const releaseFirst = gate();
    const secondHeld = gate();
    const releaseSecond = gate();
    let scorecards = 0;
    const base = upstreamsWith(npmPoints(() => (scorecards === 0 ? firstDay() : secondDay())));
    stubUpstreams({
      calls: base.calls,
      fetch: async (url, init) => {
        if (url.startsWith(SCORECARD) && ++scorecards === 1) {
          firstHeld.open();
          await releaseFirst.opened();
        }
        if (url.startsWith(VERSIONS) && scorecards > 0) {
          secondHeld.open();
          await releaseSecond.opened();
        }
        return base.fetch(url, init);
      },
    });
    return { firstHeld, releaseFirst, secondHeld, releaseSecond };
  }

  /** The versionWeeks every package is published with now. */
  async function publishedWeeks(): Promise<unknown[]> {
    const latest = Latest.parse(await published(currentKey("latest")));
    expect(latest.packages).toHaveLength(PACKAGES.length);
    return latest.packages.map((row) => row.versionWeeks);
  }

  const COUNTS = { "0.1.0": 3, "0.2.0": 30 };

  test("a run that starts before another publishes keeps the week that one confirmed, and both publish today's windows", async () => {
    const runs = heldRuns(yesterday, yesterday);
    await using first = await introspectWorkflowInstance(env.COLLECT, "overlap-first");
    await using second = await introspectWorkflowInstance(env.COLLECT, "overlap-second");
    try {
      await env.COLLECT.create({ id: "overlap-first", params: {} });
      await runs.firstHeld.opened();
      await env.COLLECT.create({ id: "overlap-second", params: {} });
      await runs.secondHeld.opened();

      const held = await db().selectFrom("npmDays").selectAll().execute();
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ lastDay: yesterday(), weekStart: week(yesterday()).start, weekEnd: yesterday() });

      const windows = [{ ...week(yesterday()), counts: COUNTS }];
      runs.releaseFirst.open();
      await first.waitForStatus("complete");
      expect(await publishedWeeks()).toEqual(PACKAGES.map(() => windows));

      runs.releaseSecond.open();
      await second.waitForStatus("complete");
      expect(await publishedWeeks()).toEqual(PACKAGES.map(() => windows));
    } finally {
      // A held instance never finishes, and disposing it waits for it to: let both through whatever failed.
      runs.releaseFirst.open();
      runs.releaseSecond.open();
    }
  });

  test("a run told of a later day undates the week another confirmed, which then publishes the window before it, and today's once confirmed", async () => {
    // An earlier capture, dated by npm, which each publish falls back to while today's week is not known.
    const earlier = addDays(today(), -9);
    for (const name of PACKAGES) await writeVersionDownloads(db(), name, { "0.1.0": 1 }, earlier);
    const earlierWeek = week(addDays(earlier, -1));
    await writeNpmDays(db(), { package: PACKAGES[0] ?? "", lastDay: earlierWeek.end, lastWeek: earlierWeek }, earlier);
    await writeNpmWeek(db(), earlierWeek, earlier);

    const runs = heldRuns(twoDaysBack, yesterday);
    await using first = await introspectWorkflowInstance(env.COLLECT, "later-first");
    await using second = await introspectWorkflowInstance(env.COLLECT, "later-second");
    try {
      await env.COLLECT.create({ id: "later-first", params: {} });
      await runs.firstHeld.opened();
      expect(await db().selectFrom("npmDays").select("weekEnd").where("capturedOn", "=", today()).execute()).toEqual([
        { weekEnd: twoDaysBack() },
      ]);
      await env.COLLECT.create({ id: "later-second", params: {} });
      await runs.secondHeld.opened();
      expect(await db().selectFrom("npmDays").selectAll().where("capturedOn", "=", today()).execute()).toEqual([
        { capturedOn: today(), lastDay: yesterday(), weekStart: null, weekEnd: null },
      ]);

      const before = { ...earlierWeek, counts: { "0.1.0": 1 } };
      runs.releaseFirst.open();
      await first.waitForStatus("complete");
      expect(await publishedWeeks()).toEqual(PACKAGES.map(() => [before]));

      runs.releaseSecond.open();
      await second.waitForStatus("complete");
      expect(await publishedWeeks()).toEqual(PACKAGES.map(() => [before, { ...week(yesterday()), counts: COUNTS }]));
    } finally {
      runs.releaseFirst.open();
      runs.releaseSecond.open();
    }
  });

  test("a run whose completion lands after a later run confirmed a later day leaves that week, and both publish today's window", async () => {
    const LAST_WEEK = "https://api.npmjs.org/downloads/point/last-week/";
    const firstHeld = gate();
    const releaseFirst = gate();
    let rolled = false;
    let lastWeeks = 0;
    const base = upstreamsWith(npmPoints(() => (rolled ? yesterday() : twoDaysBack())));
    stubUpstreams({
      calls: base.calls,
      fetch: async (url, init) => {
        // The first run's second last-week request is its completion step's: npm closes a day just before it.
        if (url.startsWith(LAST_WEEK) && ++lastWeeks === 2) {
          rolled = true;
          firstHeld.open();
          await releaseFirst.opened();
        }
        return base.fetch(url, init);
      },
    });
    await using first = await introspectWorkflowInstance(env.COLLECT, "stale-first");
    await using second = await introspectWorkflowInstance(env.COLLECT, "stale-second");
    try {
      await env.COLLECT.create({ id: "stale-first", params: {} });
      await firstHeld.opened();
      expect(await db().selectFrom("npmDays").selectAll().execute()).toEqual([
        { capturedOn: today(), lastDay: twoDaysBack(), weekStart: null, weekEnd: null },
      ]);

      await env.COLLECT.create({ id: "stale-second", params: {} });
      await second.waitForStatus("complete");
      const confirmed = {
        capturedOn: today(),
        lastDay: yesterday(),
        weekStart: week(yesterday()).start,
        weekEnd: yesterday(),
      };
      expect(await db().selectFrom("npmDays").selectAll().execute()).toEqual([confirmed]);
      const windows = [{ ...week(yesterday()), counts: COUNTS }];
      expect(await publishedWeeks()).toEqual(PACKAGES.map(() => windows));

      releaseFirst.open();
      await first.waitForStatus("complete");
      expect(await db().selectFrom("npmDays").selectAll().execute()).toEqual([confirmed]);
      expect(await publishedWeeks()).toEqual(PACKAGES.map(() => windows));
    } finally {
      releaseFirst.open();
    }
  });

  test("a run that keeps a confirmed week undates it before writing counts npm closed a day under, so a publish meanwhile does not date them", async () => {
    const firstHeld = gate();
    const releaseFirst = gate();
    const secondHeld = gate();
    const releaseSecond = gate();
    let rolled = false;
    let scorecards = 0;
    let secondVersions = 0;
    const base = upstreamsWith({
      ...npmPoints(() => (rolled ? yesterday() : twoDaysBack())),
      [`${VERSIONS}*`]: () => (rolled ? { json: { downloads: { "0.1.0": 5, "0.2.0": 50 } } } : { status: 599 }),
    });
    stubUpstreams({
      calls: base.calls,
      fetch: async (url, init) => {
        if (url.startsWith(SCORECARD) && ++scorecards === 1) {
          firstHeld.open();
          await releaseFirst.opened();
        }
        if (url.startsWith(VERSIONS) && scorecards > 0) {
          // npm closes a day as the second run fetches its first package's counts, and it is held at its second.
          if (++secondVersions === 1) rolled = true;
          else if (secondVersions === 2) {
            secondHeld.open();
            await releaseSecond.opened();
          }
        }
        return base.fetch(url, init);
      },
    });
    await using first = await introspectWorkflowInstance(env.COLLECT, "kept-first");
    await using second = await introspectWorkflowInstance(env.COLLECT, "kept-second");
    try {
      await env.COLLECT.create({ id: "kept-first", params: {} });
      await firstHeld.opened();
      const confirmed = {
        capturedOn: today(),
        lastDay: twoDaysBack(),
        weekStart: week(twoDaysBack()).start,
        weekEnd: twoDaysBack(),
      };
      expect(await db().selectFrom("npmDays").selectAll().execute()).toEqual([confirmed]);

      await env.COLLECT.create({ id: "kept-second", params: {} });
      await secondHeld.opened();
      expect(await db().selectFrom("npmDays").selectAll().execute()).toEqual([
        { ...confirmed, weekStart: null, weekEnd: null },
      ]);

      releaseFirst.open();
      await first.waitForStatus("complete");
      expect(await publishedWeeks()).toEqual(PACKAGES.map(() => []));

      releaseSecond.open();
      await second.waitForStatus("complete");
      expect(await publishedWeeks()).toEqual(PACKAGES.map(() => []));
    } finally {
      releaseFirst.open();
      releaseSecond.open();
    }
  });

  test("a completion that dates the week after npm closed a day, while another run wrote counts for the next, undates it again", async () => {
    const LAST_WEEK = "https://api.npmjs.org/downloads/point/last-week/";
    const firstHeld = gate();
    const releaseFirst = gate();
    const secondHeld = gate();
    const releaseSecond = gate();
    let rolled = false;
    let lastWeeks = 0;
    let secondVersions = 0;
    let firstIsHeld = false;
    const base = upstreamsWith({
      ...npmPoints(() => (rolled ? yesterday() : twoDaysBack())),
      [`${VERSIONS}*`]: () => (rolled ? { json: { downloads: { "0.1.0": 5, "0.2.0": 50 } } } : { status: 599 }),
    });
    stubUpstreams({
      calls: base.calls,
      fetch: async (url, init) => {
        if (url.startsWith(VERSIONS) && firstIsHeld) {
          // npm closes a day as the second run fetches its first package's counts, and it is held at its second.
          if (++secondVersions === 1) rolled = true;
          else if (secondVersions === 2) {
            secondHeld.open();
            await releaseSecond.opened();
          }
        }
        const response = await base.fetch(url, init);
        // The first run's second last-week request is its completion step's: it is answered, then held before writing.
        if (url.startsWith(LAST_WEEK) && ++lastWeeks === 2) {
          firstIsHeld = true;
          firstHeld.open();
          await releaseFirst.opened();
        }
        return response;
      },
    });
    await using first = await introspectWorkflowInstance(env.COLLECT, "late-first");
    await using second = await introspectWorkflowInstance(env.COLLECT, "late-second");
    try {
      await env.COLLECT.create({ id: "late-first", params: {} });
      await firstHeld.opened();
      await env.COLLECT.create({ id: "late-second", params: {} });
      await secondHeld.opened();
      const undated = { capturedOn: today(), lastDay: twoDaysBack(), weekStart: null, weekEnd: null };
      expect(await db().selectFrom("npmDays").selectAll().execute()).toEqual([undated]);

      releaseFirst.open();
      await first.waitForStatus("complete");
      expect(await db().selectFrom("npmDays").selectAll().execute()).toEqual([undated]);
      expect(await publishedWeeks()).toEqual(PACKAGES.map(() => []));

      releaseSecond.open();
      await second.waitForStatus("complete");
      expect(await db().selectFrom("npmDays").selectAll().execute()).toEqual([undated]);
      expect(await publishedWeeks()).toEqual(PACKAGES.map(() => []));
    } finally {
      releaseFirst.open();
      releaseSecond.open();
    }
  });

  test("a later run that sees npm close a day mid-run undates the week an earlier run confirmed, since its counts are mixed", async () => {
    stubUpstreams(upstreamsWith(npmPoints(twoDaysBack)));
    let capturedOn: string;
    {
      await using instance = await introspectWorkflowInstance(env.COLLECT, "confirmed");
      await env.COLLECT.create({ id: "confirmed", params: {} });
      await instance.waitForStatus("complete");
      ({ capturedOn } = (await instance.getOutput()) as { capturedOn: string });
    }
    expect(await db().selectFrom("npmDays").selectAll().execute()).toEqual([
      { capturedOn, lastDay: twoDaysBack(), weekStart: week(twoDaysBack()).start, weekEnd: twoDaysBack() },
    ]);

    vi.restoreAllMocks();
    let rolled = false;
    stubUpstreams(
      upstreamsWith({
        ...npmPoints(() => (rolled ? yesterday() : twoDaysBack())),
        [`${VERSIONS}*`]: () => {
          rolled = true;
          return { status: 599 };
        },
      }),
    );
    {
      await using instance = await introspectWorkflowInstance(env.COLLECT, "rolled-after-confirmed");
      await env.COLLECT.create({ id: "rolled-after-confirmed", params: {} });
      await instance.waitForStatus("complete");
    }
    expect(await db().selectFrom("npmDays").selectAll().execute()).toEqual([
      { capturedOn, lastDay: twoDaysBack(), weekStart: null, weekEnd: null },
    ]);
    const latest = Latest.parse(await published(currentKey("latest")));
    for (const row of latest.packages) expect(row.versionWeeks).toEqual([]);
  });
});
