import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { statsDatabase } from "../../data/tables";
import { freshDatabase } from "../../data/testing";
import {
  recordCollected,
  recordPackages,
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
} from "../store";
import { readPublishRows } from "./read";

const REPO = "pithy-sh/pithy";
const OTHER = "pithy-sh/elsewhere";
const db = () => statsDatabase(env.DB);

const facts = (version: string) => ({
  latestVersion: version,
  description: null,
  createdAt: new Date("2026-09-05T00:00:00Z"),
  versions: [{ version, publishedAt: new Date("2026-09-05T00:00:00Z") }],
  unpackedSize: 10,
  fileCount: 1,
  dependencies: { zod: "^4.0.0" },
  peerDependencies: {},
});

const issue = (number: number) => ({
  number,
  createdAt: new Date("2026-11-01T00:00:00Z"),
  closedAt: null,
  state: "OPEN",
  stateReason: null,
  issueType: null,
  labels: ["bug"],
});

const pullRequest = (number: number) => ({
  number,
  createdAt: new Date("2026-11-01T00:00:00Z"),
  mergedAt: null,
  closedAt: null,
  state: "OPEN",
  additions: 1,
  deletions: 0,
});

/** Every per-package source, written for `name` on `day`. */
async function writePackage(name: string, day: string): Promise<void> {
  await writeDailyDownloads(db(), name, [{ day: "2026-11-01", downloads: 5 }], day);
  await writeVersionDownloads(db(), name, { "0.1.0": 1 }, day);
  await writeRegistry(db(), name, facts("0.1.0"), day);
  await writeCdn(db(), name, { period: "month", hits: 9, bandwidth: 90, rank: null }, day);
  await writeDependents(
    db(),
    name,
    { version: "0.1.0", dependents: 3, directDependents: 2, indirectDependents: 1 },
    day,
  );
}

beforeEach(async () => {
  await freshDatabase(env.DB);
});

describe("readPublishRows", () => {
  test("answers empty before anything is collected", async () => {
    expect(await readPublishRows(db(), REPO)).toEqual({
      packages: [],
      dailyDownloads: [],
      versionDownloads: [],
      npmDays: [],
      versionPublishes: [],
      registry: [],
      repo: null,
      issues: [],
      pullRequests: [],
      commits: [],
      cdn: [],
      dependents: [],
      scorecard: null,
      collections: [],
      kitCounts: [],
    });
  });

  test("keeps only the newest package list, and drops every row of a package that has left the org", async () => {
    await recordPackages(db(), ["@pithy-sh/core", "@pithy-sh/gone"], "2026-11-05");
    await recordPackages(db(), ["@pithy-sh/core", "@pithy-sh/auth"], "2026-11-09");
    await writePackage("@pithy-sh/gone", "2026-11-05");
    await writePackage("@pithy-sh/core", "2026-11-09");
    await writePackage("@pithy-sh/auth", "2026-11-09");

    const rows = await readPublishRows(db(), REPO);
    expect([...rows.packages].sort()).toEqual(["@pithy-sh/auth", "@pithy-sh/core"]);
    for (const table of [
      "dailyDownloads",
      "versionDownloads",
      "versionPublishes",
      "registry",
      "cdn",
      "dependents",
    ] as const) {
      const names = new Set(rows[table].map((row) => row.packageName));
      expect([...names].sort(), table).toEqual(["@pithy-sh/auth", "@pithy-sh/core"]);
    }
  });

  test("keeps only the repository's own GitHub rows", async () => {
    for (const repo of [REPO, OTHER]) {
      await writeRepo(
        db(),
        repo,
        { createdAt: new Date("2026-09-01T00:00:00Z"), stars: 5, forks: 1, commits: 10, contributors: 1 },
        "2026-11-09",
      );
      await writeIssues(db(), repo, [issue(1), issue(2)], "2026-11-09");
      await writePullRequests(db(), repo, [pullRequest(3)], "2026-11-09");
      await writeCommits(db(), repo, [
        { oid: `${repo === REPO ? "a" : "b"}`.repeat(40), committedAt: new Date("2026-11-01T00:00:00Z") },
      ]);
      await writeScorecard(
        db(),
        repo,
        { score: repo === REPO ? 7 : 1, scoredAt: new Date("2026-11-02T00:00:00Z") },
        "2026-11-09",
      );
    }

    const rows = await readPublishRows(db(), REPO);
    expect(rows.repo?.repo).toBe(REPO);
    expect(rows.issues.map((row) => [row.repo, row.number])).toEqual([
      [REPO, 1],
      [REPO, 2],
    ]);
    expect(rows.pullRequests.map((row) => row.repo)).toEqual([REPO]);
    expect(rows.commits.map((row) => row.oid)).toEqual(["a".repeat(40)]);
    expect(rows.scorecard?.score).toBe(7);
  });

  test("decodes instants back to Date and JSON columns back to values", async () => {
    await recordPackages(db(), ["@pithy-sh/core"], "2026-11-09");
    await writePackage("@pithy-sh/core", "2026-11-09");
    await writeIssues(db(), REPO, [issue(1)], "2026-11-09");
    await recordCollected(db(), "registry", new Date("2026-11-09T02:00:10Z"));

    const rows = await readPublishRows(db(), REPO);
    expect(rows.registry[0]?.createdAt).toEqual(new Date("2026-09-05T00:00:00Z"));
    expect(rows.registry[0]?.dependencies).toEqual({ zod: "^4.0.0" });
    expect(rows.versionPublishes[0]?.publishedAt).toEqual(new Date("2026-09-05T00:00:00Z"));
    expect(rows.issues[0]?.createdAt).toEqual(new Date("2026-11-01T00:00:00Z"));
    expect(rows.issues[0]?.labels).toEqual(["bug"]);
    expect(rows.collections).toEqual([{ step: "registry", collectedAt: new Date("2026-11-09T02:00:10Z") }]);
  });

  test("decodes a repository row whose creation time was never read as null", async () => {
    await db()
      .insertInto("repoLatest")
      .values({
        repo: REPO,
        capturedOn: "2026-11-01",
        createdAt: null,
        stars: 3,
        forks: 0,
        commits: 9,
        contributors: 1,
      })
      .execute();
    const rows = await readPublishRows(db(), REPO);
    expect(rows.repo).toEqual({
      repo: REPO,
      capturedOn: "2026-11-01",
      createdAt: null,
      stars: 3,
      forks: 0,
      commits: 9,
      contributors: 1,
    });
  });

  test("reads the kit's counts for the repository, oldest first, with each instant decoded", async () => {
    await writeKitCount(
      db(),
      REPO,
      "b".repeat(40),
      { tests: 2, codeLines: 20 },
      "2026-11-09",
      new Date("2026-11-09T02:01:00Z"),
    );
    await writeKitCount(
      db(),
      REPO,
      "a".repeat(40),
      { tests: 1, codeLines: 10 },
      "2026-11-08",
      new Date("2026-11-08T02:01:00Z"),
    );
    await writeKitCount(db(), "someone/else", "c".repeat(40), { tests: 9, codeLines: 90 }, "2026-11-09", new Date());
    const rows = await readPublishRows(db(), REPO);
    expect(rows.kitCounts).toEqual([
      {
        repo: REPO,
        capturedOn: "2026-11-08",
        commit: "a".repeat(40),
        tests: 1,
        codeLines: 10,
        countedAt: new Date("2026-11-08T02:01:00Z"),
      },
      {
        repo: REPO,
        capturedOn: "2026-11-09",
        commit: "b".repeat(40),
        tests: 2,
        codeLines: 20,
        countedAt: new Date("2026-11-09T02:01:00Z"),
      },
    ]);
  });

  test("reads every day npm was asked which days it had counted, and the week confirmed for it", async () => {
    await writeNpmDays(
      db(),
      { package: "@pithy-sh/core", lastDay: "2026-11-08", lastWeek: { start: "2026-11-02", end: "2026-11-08" } },
      "2026-11-10",
    );
    await writeNpmWeek(db(), { start: "2026-11-02", end: "2026-11-08" }, "2026-11-10");
    await writeNpmDays(
      db(),
      { package: "@pithy-sh/core", lastDay: "2026-11-07", lastWeek: { start: "2026-11-01", end: "2026-11-07" } },
      "2026-11-09",
    );
    const rows = await readPublishRows(db(), REPO);
    expect(rows.npmDays).toEqual([
      { capturedOn: "2026-11-09", lastDay: "2026-11-07", weekStart: null, weekEnd: null },
      { capturedOn: "2026-11-10", lastDay: "2026-11-08", weekStart: "2026-11-02", weekEnd: "2026-11-08" },
    ]);
  });
});
