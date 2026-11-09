import { env, introspectWorkflow, introspectWorkflowInstance } from "cloudflare:test";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { statsDatabase, type statsTables } from "../data/tables";
import { freshDatabase } from "../data/testing";
import worker from "../index";
import {
  recordPackages,
  writeCdn,
  writeDailyDownloads,
  writeDependents,
  writeRegistry,
  writeRepo,
  writeVersionDownloads,
} from "./store";
import { type StubCall, stubFetch } from "./upstream/testing";
import { COLLECT_CRON } from "./workflow";

const PACKAGES = ["@pithy-sh/auth", "@pithy-sh/core"];
const TOKEN = "test-github-token";

/** Every upstream the collector calls, answering a small, consistent kit. `downloads` sets a day's count. */
function upstreams(downloads: (name: string, day: string) => number = () => 10, stars = 50) {
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
            stargazerCount: stars,
            forkCount: 4,
            defaultBranchRef: { target: { history: { totalCount: 900 } } },
          },
        },
      },
    };
  };

  return stubFetch({
    "https://registry.npmjs.org/-/org/pithy-sh/package": {
      json: Object.fromEntries(PACKAGES.map((name) => [name, "write"])),
    },
    "https://registry.npmjs.org/*": {
      json: {
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

/** Route the runtime's `fetch` to a stub table. The Workflow's steps run in this isolate, so they see it. */
function stubUpstreams(stub: ReturnType<typeof stubFetch>): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    stub.fetch(input instanceof Request ? input.url : String(input), init),
  );
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
    "versionPublishes",
    "registrySnapshots",
    "registryLatest",
    "repoSnapshots",
    "repoLatest",
    "issues",
    "issueSnapshots",
    "pullRequests",
    "pullRequestSnapshots",
    "cdnSnapshots",
    "cdnLatest",
    "dependentSnapshots",
    "dependentLatest",
    "scorecardSnapshots",
    "scorecardLatest",
  ] as const;
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = await count(table);
  return counts;
}

beforeEach(async () => {
  await freshDatabase(env.DB);
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
        github: 3,
        jsdelivr: 2,
        "deps.dev": 3,
      },
    });
    expect(await rowCounts()).toEqual({
      packages: 2,
      dailyDownloads: 6,
      versionDownloads: 4,
      versionPublishes: 4,
      registrySnapshots: 2,
      registryLatest: 2,
      repoSnapshots: 1,
      repoLatest: 1,
      issues: 1,
      issueSnapshots: 1,
      pullRequests: 1,
      pullRequestSnapshots: 1,
      cdnSnapshots: 2,
      cdnLatest: 2,
      dependentSnapshots: 2,
      dependentLatest: 2,
      scorecardSnapshots: 1,
      scorecardLatest: 1,
    });
    expect(await db().selectFrom("repoLatest").selectAll().execute()).toEqual([
      { repo: "pithy-sh/pithy", capturedOn: output.capturedOn, stars: 50, forks: 4, commits: 900, contributors: 2 },
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
    await recordPackages(db(), PACKAGES, earlier);
    await writeVersionDownloads(db(), core, { "0.1.0": 1, "0.2.0": 2 }, earlier);
    await writeRegistry(
      db(),
      core,
      {
        latestVersion: "0.1.0",
        createdAt: new Date("2026-09-05T00:00:00Z"),
        versions: [{ version: "0.1.0", publishedAt: new Date("2026-09-05T00:00:00Z") }],
        unpackedSize: 10,
        fileCount: 1,
        dependencies: {},
        peerDependencies: {},
      },
      earlier,
    );
    await writeRepo(db(), "pithy-sh/pithy", { stars: 7, forks: 1, commits: 100, contributors: 1 }, earlier);
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
    for (const row of packages) expect(row).toEqual({ firstSeenOn: earlier, lastSeenOn: output.capturedOn });
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
    expect(fetched("https://api.github.com/repos/")).toBe(1);
  });

  test("a source that exhausts its retries does not stop the others, and the run fails naming it", async () => {
    stubUpstreams(upstreams());
    await using instance = await introspectWorkflowInstance(env.COLLECT, "exhausted");
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "jsdelivr" }, new Error("jsDelivr is down"));
    });
    await env.COLLECT.create({ id: "exhausted", params: { date: "2026-11-09" } });
    await instance.waitForStatus("errored");

    expect((await instance.getError()).message).toContain("jsdelivr");
    expect(await count("cdnLatest")).toBe(0);
    expect(await count("dependentLatest")).toBe(PACKAGES.length);
    expect(await count("repoLatest")).toBe(1);
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
