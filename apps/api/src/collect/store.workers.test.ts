import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { statsDatabase } from "../data/tables";
import { freshDatabase } from "../data/testing";
import {
  recordCollected,
  recordPackages,
  writeCdn,
  writeCommits,
  writeDailyDownloads,
  writeDependents,
  writeIssues,
  writePullRequests,
  writeRegistry,
  writeRepo,
  writeScorecard,
  writeVersionDownloads,
} from "./store";
import type { RegistryFacts } from "./upstream/npm";

const db = () => statsDatabase(env.DB);

beforeEach(async () => {
  await freshDatabase(env.DB);
});

describe("recordPackages", () => {
  test("keeps the first day a package was seen and moves the last", async () => {
    await recordPackages(db(), ["@pithy-sh/core"], "2026-11-08");
    await recordPackages(db(), ["@pithy-sh/core", "@pithy-sh/auth"], "2026-11-09");
    expect(await db().selectFrom("packages").selectAll().orderBy("name").execute()).toEqual([
      { name: "@pithy-sh/auth", firstSeenOn: "2026-11-09", lastSeenOn: "2026-11-09" },
      { name: "@pithy-sh/core", firstSeenOn: "2026-11-08", lastSeenOn: "2026-11-09" },
    ]);
  });

  test("never moves the last day seen backwards", async () => {
    await recordPackages(db(), ["@pithy-sh/core"], "2026-11-09");
    await recordPackages(db(), ["@pithy-sh/core"], "2026-11-05");
    expect(await db().selectFrom("packages").selectAll().execute()).toEqual([
      { name: "@pithy-sh/core", firstSeenOn: "2026-11-09", lastSeenOn: "2026-11-09" },
    ]);
  });
});

describe("writeDailyDownloads", () => {
  test("overwrites a day already stored with the newer count", async () => {
    await writeDailyDownloads(
      db(),
      "@pithy-sh/core",
      [
        { day: "2026-11-06", downloads: 1 },
        { day: "2026-11-07", downloads: 2 },
      ],
      "2026-11-08",
    );
    await writeDailyDownloads(
      db(),
      "@pithy-sh/core",
      [
        { day: "2026-11-07", downloads: 20 },
        { day: "2026-11-08", downloads: 30 },
      ],
      "2026-11-09",
    );
    expect(await db().selectFrom("dailyDownloads").selectAll().orderBy("day").execute()).toEqual([
      { packageName: "@pithy-sh/core", day: "2026-11-06", downloads: 1, capturedOn: "2026-11-08" },
      { packageName: "@pithy-sh/core", day: "2026-11-07", downloads: 20, capturedOn: "2026-11-09" },
      { packageName: "@pithy-sh/core", day: "2026-11-08", downloads: 30, capturedOn: "2026-11-09" },
    ]);
  });

  test("writes more rows than one statement can bind", async () => {
    const days = Array.from({ length: 400 }, (_, index) => ({
      day: new Date(Date.UTC(2025, 0, 1) + index * 86_400_000).toISOString().slice(0, 10),
      downloads: index,
    }));
    await writeDailyDownloads(db(), "@pithy-sh/core", days, "2026-11-09");
    const { count } = await db()
      .selectFrom("dailyDownloads")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(count).toBe(400);
  });
});

describe("writeVersionDownloads", () => {
  test("keeps one snapshot per capture day", async () => {
    await writeVersionDownloads(db(), "@pithy-sh/core", { "0.20.0": 5 }, "2026-11-08");
    await writeVersionDownloads(db(), "@pithy-sh/core", { "0.20.0": 9 }, "2026-11-09");
    await writeVersionDownloads(db(), "@pithy-sh/core", { "0.20.0": 9 }, "2026-11-09");
    expect(await db().selectFrom("versionDownloads").selectAll().orderBy("capturedOn").execute()).toEqual([
      { packageName: "@pithy-sh/core", version: "0.20.0", capturedOn: "2026-11-08", downloads: 5 },
      { packageName: "@pithy-sh/core", version: "0.20.0", capturedOn: "2026-11-09", downloads: 9 },
    ]);
  });
});

const facts = (latestVersion: string): RegistryFacts => ({
  latestVersion,
  description: "The Pithy kit's core.",
  createdAt: new Date("2026-09-05T10:00:00Z"),
  versions: [{ version: "0.1.0", publishedAt: new Date("2026-09-05T10:00:00Z") }],
  unpackedSize: 100,
  fileCount: 3,
  dependencies: { zod: "^4.0.0" },
  peerDependencies: {},
});

describe("writeRegistry", () => {
  test("writes publishes, a dated snapshot and the latest values", async () => {
    await writeRegistry(db(), "@pithy-sh/core", facts("0.1.0"), "2026-11-09");
    expect(await db().selectFrom("versionPublishes").selectAll().execute()).toEqual([
      { packageName: "@pithy-sh/core", version: "0.1.0", publishedAt: Date.parse("2026-09-05T10:00:00Z") },
    ]);
    const latest = await db().selectFrom("registryLatest").selectAll().executeTakeFirstOrThrow();
    expect(latest).toMatchObject({
      latestVersion: "0.1.0",
      description: "The Pithy kit's core.",
      capturedOn: "2026-11-09",
      dependencies: '{"zod":"^4.0.0"}',
    });
    expect(await db().selectFrom("registrySnapshots").selectAll().execute()).toHaveLength(1);
  });

  test("a re-run of an older day corrects its snapshot and leaves the latest values alone", async () => {
    await writeRegistry(db(), "@pithy-sh/core", facts("0.2.0"), "2026-11-09");
    await writeRegistry(db(), "@pithy-sh/core", facts("0.1.0"), "2026-11-08");
    await writeRegistry(db(), "@pithy-sh/core", facts("0.1.1"), "2026-11-08");
    const latest = await db().selectFrom("registryLatest").selectAll().execute();
    expect(latest.map((row) => [row.capturedOn, row.latestVersion])).toEqual([["2026-11-09", "0.2.0"]]);
    const snapshots = await db().selectFrom("registrySnapshots").selectAll().orderBy("capturedOn").execute();
    expect(snapshots.map((row) => [row.capturedOn, row.latestVersion])).toEqual([
      ["2026-11-08", "0.1.1"],
      ["2026-11-09", "0.2.0"],
    ]);
  });

  test("the same day written twice takes the second write", async () => {
    await writeRegistry(db(), "@pithy-sh/core", facts("0.1.0"), "2026-11-09");
    await writeRegistry(db(), "@pithy-sh/core", facts("0.1.1"), "2026-11-09");
    const latest = await db().selectFrom("registryLatest").select("latestVersion").execute();
    expect(latest).toEqual([{ latestVersion: "0.1.1" }]);
  });
});

describe("GitHub writes", () => {
  test("writeRepo keeps a dated row and the latest", async () => {
    const createdAt = new Date("2026-08-20T12:00:00Z");
    await writeRepo(
      db(),
      "pithy-sh/pithy",
      { createdAt, stars: 1, forks: 0, commits: 10, contributors: 1 },
      "2026-11-08",
    );
    await writeRepo(
      db(),
      "pithy-sh/pithy",
      { createdAt, stars: 2, forks: 1, commits: 12, contributors: 2 },
      "2026-11-09",
    );
    expect(await db().selectFrom("repoSnapshots").selectAll().execute()).toHaveLength(2);
    expect(await db().selectFrom("repoLatest").selectAll().execute()).toEqual([
      {
        repo: "pithy-sh/pithy",
        capturedOn: "2026-11-09",
        createdAt: createdAt.getTime(),
        stars: 2,
        forks: 1,
        commits: 12,
        contributors: 2,
      },
    ]);
  });

  test("writeIssues updates an issue in place when it closes", async () => {
    const open = {
      number: 1,
      createdAt: new Date("2026-09-05T00:00:00Z"),
      closedAt: null,
      state: "OPEN",
      stateReason: null,
      issueType: "Bug",
      labels: ["kit"],
    };
    await writeIssues(db(), "pithy-sh/pithy", [open], "2026-11-08");
    await writeIssues(
      db(),
      "pithy-sh/pithy",
      [{ ...open, state: "CLOSED", stateReason: "COMPLETED", closedAt: new Date("2026-11-08T12:00:00Z") }],
      "2026-11-09",
    );
    expect(await db().selectFrom("issues").selectAll().execute()).toEqual([
      {
        repo: "pithy-sh/pithy",
        number: 1,
        createdAt: Date.parse("2026-09-05T00:00:00Z"),
        closedAt: Date.parse("2026-11-08T12:00:00Z"),
        state: "CLOSED",
        stateReason: "COMPLETED",
        issueType: "Bug",
        labels: '["kit"]',
        capturedOn: "2026-11-09",
      },
    ]);
    const snapshots = await db().selectFrom("issueSnapshots").selectAll().orderBy("capturedOn").execute();
    expect(snapshots.map((row) => [row.number, row.capturedOn, row.state])).toEqual([
      [1, "2026-11-08", "OPEN"],
      [1, "2026-11-09", "CLOSED"],
    ]);
  });

  test("writeIssues for an older day keeps that day's snapshot and leaves the latest alone", async () => {
    const issue = {
      number: 1,
      createdAt: new Date("2026-09-05T00:00:00Z"),
      closedAt: null,
      state: "OPEN",
      stateReason: null,
      issueType: null,
      labels: [],
    };
    await writeIssues(db(), "pithy-sh/pithy", [{ ...issue, state: "CLOSED" }], "2026-11-09");
    await writeIssues(db(), "pithy-sh/pithy", [issue], "2026-11-08");
    expect(await db().selectFrom("issues").select(["state", "capturedOn"]).execute()).toEqual([
      { state: "CLOSED", capturedOn: "2026-11-09" },
    ]);
    expect(await db().selectFrom("issueSnapshots").selectAll().execute()).toHaveLength(2);
  });

  test("writePullRequests upserts by number", async () => {
    const pr = {
      number: 3,
      createdAt: new Date("2026-09-05T00:00:00Z"),
      mergedAt: null,
      closedAt: null,
      state: "OPEN",
      additions: 1,
      deletions: 0,
    };
    await writePullRequests(db(), "pithy-sh/pithy", [pr], "2026-11-08");
    await writePullRequests(db(), "pithy-sh/pithy", [{ ...pr, state: "MERGED", additions: 5 }], "2026-11-09");
    const rows = await db().selectFrom("pullRequests").select(["state", "additions"]).execute();
    expect(rows).toEqual([{ state: "MERGED", additions: 5 }]);
    const snapshots = await db().selectFrom("pullRequestSnapshots").selectAll().orderBy("capturedOn").execute();
    expect(snapshots.map((row) => [row.number, row.capturedOn, row.state])).toEqual([
      [3, "2026-11-08", "OPEN"],
      [3, "2026-11-09", "MERGED"],
    ]);
  });
});

describe("jsDelivr and deps.dev writes", () => {
  test("each keeps a dated row and the latest", async () => {
    await writeCdn(db(), "@pithy-sh/core", { period: "month", hits: 10, bandwidth: 100, rank: null }, "2026-11-09");
    await writeDependents(
      db(),
      "@pithy-sh/core",
      { version: "0.20.0", dependents: 3, directDependents: 2, indirectDependents: 1 },
      "2026-11-09",
    );
    await writeScorecard(
      db(),
      "pithy-sh/pithy",
      { score: 6.4, scoredAt: new Date("2026-11-02T00:00:00Z") },
      "2026-11-09",
    );
    expect(await db().selectFrom("cdnLatest").selectAll().execute()).toEqual([
      {
        packageName: "@pithy-sh/core",
        capturedOn: "2026-11-09",
        period: "month",
        hits: 10,
        bandwidth: 100,
        rank: null,
      },
    ]);
    expect(await db().selectFrom("cdnSnapshots").selectAll().execute()).toHaveLength(1);
    expect(await db().selectFrom("dependentLatest").select("dependents").execute()).toEqual([{ dependents: 3 }]);
    expect(await db().selectFrom("dependentSnapshots").selectAll().execute()).toHaveLength(1);
    expect(await db().selectFrom("scorecardLatest").select(["score", "scoredAt"]).execute()).toEqual([
      { score: 6.4, scoredAt: Date.parse("2026-11-02T00:00:00Z") },
    ]);
    expect(await db().selectFrom("scorecardSnapshots").selectAll().execute()).toHaveLength(1);
  });
});

describe("writeCommits", () => {
  test("keeps one row per commit, however often it is written", async () => {
    const commits = [
      { oid: "a".repeat(40), committedAt: new Date("2026-09-05T00:00:00Z") },
      { oid: "b".repeat(40), committedAt: new Date("2026-09-07T00:00:00Z") },
    ];
    await writeCommits(db(), "pithy-sh/pithy", commits);
    await writeCommits(db(), "pithy-sh/pithy", commits);
    expect(await db().selectFrom("commits").selectAll().orderBy("oid").execute()).toEqual([
      { repo: "pithy-sh/pithy", oid: "a".repeat(40), committedAt: Date.parse("2026-09-05T00:00:00Z") },
      { repo: "pithy-sh/pithy", oid: "b".repeat(40), committedAt: Date.parse("2026-09-07T00:00:00Z") },
    ]);
  });
});

describe("recordCollected", () => {
  test("keeps the newest time each step finished", async () => {
    await recordCollected(db(), "github", new Date("2026-11-08T02:01:00Z"));
    await recordCollected(db(), "github", new Date("2026-11-09T02:01:00Z"));
    await recordCollected(db(), "registry", new Date("2026-11-09T02:00:30Z"));
    expect(await db().selectFrom("collections").selectAll().orderBy("step").execute()).toEqual([
      { step: "github", collectedAt: Date.parse("2026-11-09T02:01:00Z") },
      { step: "registry", collectedAt: Date.parse("2026-11-09T02:00:30Z") },
    ]);
  });
});
