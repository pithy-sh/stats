import { describe, expect, test } from "vitest";
import { Latest, Summary } from "../../contract/stats";
import type { Issue, PullRequest } from "../../data/tables";
import { STEPS } from "../workflow";
import { buildLatest, buildSummary, type PublishRows, SOURCE_STEPS } from "./build";

const REPO = "pithy-sh/pithy";
const NOW = new Date("2026-11-09T02:10:00Z");
const at = (value: string) => new Date(value);

function issue(number: number, fields: Partial<Issue>): Issue {
  return {
    repo: REPO,
    number,
    createdAt: at("2026-11-02T00:00:00Z"),
    closedAt: null,
    state: "OPEN",
    stateReason: null,
    issueType: null,
    labels: [],
    capturedOn: "2026-11-09",
    ...fields,
  };
}

function pullRequest(number: number, fields: Partial<PullRequest>): PullRequest {
  return {
    repo: REPO,
    number,
    createdAt: at("2026-11-02T00:00:00Z"),
    mergedAt: null,
    closedAt: null,
    state: "OPEN",
    additions: 0,
    deletions: 0,
    capturedOn: "2026-11-09",
    ...fields,
  };
}

/** Two packages, a week of downloads, and a little of every other source. */
function rows(): PublishRows {
  const days = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];
  return {
    packages: ["@pithy-sh/core", "@pithy-sh/auth"],
    dailyDownloads: [
      ...days.map((day, index) => ({ packageName: "@pithy-sh/core", day, downloads: index + 1 })),
      { packageName: "@pithy-sh/auth", day: "2026-11-08", downloads: 100 },
    ],
    versionDownloads: [
      { packageName: "@pithy-sh/core", version: "0.1.0", capturedOn: "2026-11-09", downloads: 3 },
      { packageName: "@pithy-sh/core", version: "0.2.0", capturedOn: "2026-11-09", downloads: 30 },
    ],
    versionPublishes: [
      { packageName: "@pithy-sh/core", version: "0.2.0", publishedAt: at("2026-11-05T10:00:00Z") },
      { packageName: "@pithy-sh/core", version: "0.1.0", publishedAt: at("2026-11-02T10:00:00Z") },
      { packageName: "@pithy-sh/auth", version: "0.1.0", publishedAt: at("2026-11-05T12:00:00Z") },
    ],
    registry: [
      {
        packageName: "@pithy-sh/core",
        capturedOn: "2026-11-09",
        latestVersion: "0.2.0",
        description: "The core.",
        createdAt: at("2026-11-02T10:00:00Z"),
        versionCount: 2,
        unpackedSize: 2048,
        fileCount: 12,
        dependencies: { zod: "^4.0.0", hono: "^4.0.0" },
        peerDependencies: {},
      },
    ],
    repo: {
      repo: REPO,
      capturedOn: "2026-11-09",
      createdAt: at("2026-11-03T00:00:00Z"),
      stars: 50,
      forks: 4,
      commits: 900,
      contributors: 3,
    },
    issues: [
      issue(1, {
        issueType: "Bug",
        state: "CLOSED",
        stateReason: "COMPLETED",
        closedAt: at("2026-11-02T01:00:00Z"),
      }),
      issue(2, { labels: ["Bug"], createdAt: at("2026-11-04T00:00:00Z") }),
      issue(3, { state: "CLOSED", stateReason: "COMPLETED", closedAt: at("2026-11-02T03:00:00Z") }),
      issue(4, { state: "CLOSED", stateReason: "NOT_PLANNED", closedAt: at("2026-11-09T00:00:00Z") }),
    ],
    pullRequests: [
      pullRequest(5, {
        state: "MERGED",
        mergedAt: at("2026-11-02T00:30:00Z"),
        closedAt: at("2026-11-02T00:30:00Z"),
        additions: 10,
        deletions: 2,
      }),
      pullRequest(6, { state: "CLOSED", closedAt: at("2026-11-03T00:00:00Z"), additions: 99 }),
      pullRequest(7, {}),
    ],
    commits: [
      { repo: REPO, oid: "a".repeat(40), committedAt: at("2026-10-28T00:00:00Z") },
      { repo: REPO, oid: "b".repeat(40), committedAt: at("2026-11-09T01:00:00Z") },
    ],
    cdn: [
      { packageName: "@pithy-sh/core", capturedOn: "2026-11-09", period: "month", hits: 70, bandwidth: 1, rank: null },
    ],
    dependents: [
      {
        packageName: "@pithy-sh/core",
        capturedOn: "2026-11-09",
        version: "0.2.0",
        dependents: 2,
        directDependents: 1,
        indirectDependents: 1,
      },
      {
        packageName: "@pithy-sh/auth",
        capturedOn: "2026-11-09",
        version: "0.1.0",
        dependents: 1,
        directDependents: 1,
        indirectDependents: 0,
      },
    ],
    scorecard: { repo: REPO, capturedOn: "2026-11-09", score: 5.5, scoredAt: at("2026-11-02T08:00:00Z") },
    collections: [
      { step: "packages", collectedAt: at("2026-11-09T02:00:05Z") },
      { step: "dailyDownloads", collectedAt: at("2026-11-09T02:00:20Z") },
      { step: "versionDownloads", collectedAt: at("2026-11-09T02:00:30Z") },
      { step: "registry", collectedAt: at("2026-11-09T02:00:10Z") },
      { step: "github", collectedAt: at("2026-11-08T02:01:00Z") },
      { step: "depsDev", collectedAt: at("2026-11-09T02:02:00Z") },
      { step: "kit", collectedAt: at("2026-11-09T02:01:30Z") },
    ],
    kitCounts: [
      {
        repo: REPO,
        capturedOn: "2026-11-09",
        commit: "b".repeat(40),
        tests: 120,
        codeLines: 9000,
        countedAt: at("2026-11-09T02:01:29Z"),
      },
      {
        repo: REPO,
        capturedOn: "2026-11-07",
        commit: "a".repeat(40),
        tests: 100,
        codeLines: 8000,
        countedAt: at("2026-11-07T02:01:20Z"),
      },
    ],
  };
}

const empty: PublishRows = {
  packages: [],
  dailyDownloads: [],
  versionDownloads: [],
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
};

describe("SOURCE_STEPS", () => {
  test("names only steps the collector runs", () => {
    for (const steps of Object.values(SOURCE_STEPS))
      for (const step of steps) expect(Object.keys(STEPS)).toContain(step);
  });
});

describe("buildLatest", () => {
  const latest = buildLatest(rows(), { repo: REPO }, NOW);

  test("parses as the contract", () => {
    expect(Latest.parse(latest)).toEqual(latest);
  });

  test("carries the version, when it was built and the last complete day", () => {
    expect(latest).toMatchObject({ version: 1, generatedAt: "2026-11-09T02:10:00.000Z", asOf: "2026-11-08" });
  });

  test("dates each source by its stalest step, and leaves never-collected ones null", () => {
    expect(latest.sources).toEqual({
      npm: { collectedAt: "2026-11-09T02:00:05.000Z" },
      registry: { collectedAt: "2026-11-09T02:00:10.000Z" },
      github: { collectedAt: "2026-11-08T02:01:00.000Z" },
      jsdelivr: { collectedAt: null },
      depsDev: { collectedAt: "2026-11-09T02:02:00.000Z" },
      scorecard: { collectedAt: "2026-11-09T02:02:00.000Z" },
      kit: { collectedAt: "2026-11-09T02:01:30.000Z" },
    });
  });

  test("sums the kit's downloads per day, from the first day held to asOf", () => {
    expect(latest.downloads).toEqual({ start: "2026-11-02", end: "2026-11-08", kit: [1, 2, 3, 4, 5, 6, 107] });
  });

  test("lists every package by name, with its series aligned and zero before its first day", () => {
    expect(latest.packages.map((row) => row.name)).toEqual(["@pithy-sh/auth", "@pithy-sh/core"]);
    const [auth, core] = latest.packages;
    expect(auth).toMatchObject({
      description: null,
      createdAt: "2026-11-05T12:00:00.000Z",
      latest: null,
      daily: [0, 0, 0, 0, 0, 0, 100],
      footprint: null,
      jsdelivr: null,
    });
    expect(core).toEqual({
      name: "@pithy-sh/core",
      description: "The core.",
      createdAt: "2026-11-02T10:00:00.000Z",
      latest: "0.2.0",
      daily: [1, 2, 3, 4, 5, 6, 7],
      versions: [
        { version: "0.1.0", publishedAt: "2026-11-02T10:00:00.000Z" },
        { version: "0.2.0", publishedAt: "2026-11-05T10:00:00.000Z" },
      ],
      versionWeeks: [{ start: "2026-11-02", end: "2026-11-08", counts: { "0.1.0": 3, "0.2.0": 30 } }],
      footprint: { unpackedSize: 2048, fileCount: 12, dependencies: 2, peerDependencies: 0 },
      jsdelivr: 70,
    });
  });

  test("dates jsDelivr's window as the 30 days before its capture", () => {
    expect(latest.jsdelivr).toEqual({ start: "2026-10-10", end: "2026-11-08", total: 70 });
  });

  test("sums jsDelivr over the newest capture day only, and dates the window by it", () => {
    const mixed = rows();
    mixed.packages = ["@pithy-sh/core", "@pithy-sh/auth", "@pithy-sh/cli"];
    mixed.cdn = [
      { packageName: "@pithy-sh/core", capturedOn: "2026-11-09", period: "month", hits: 70, bandwidth: 1, rank: null },
      { packageName: "@pithy-sh/auth", capturedOn: "2026-11-01", period: "month", hits: 500, bandwidth: 1, rank: null },
    ];
    const stale = buildLatest(mixed, { repo: REPO }, NOW);
    expect(stale.jsdelivr).toEqual({ start: "2026-10-10", end: "2026-11-08", total: 70 });
    // The jsDelivr step last finished before the newest capture day, so a package with no row that day is unknown.
    expect(Object.fromEntries(stale.packages.map((row) => [row.name, row.jsdelivr]))).toEqual({
      "@pithy-sh/auth": null,
      "@pithy-sh/cli": null,
      "@pithy-sh/core": 70,
    });

    // Once the step finished on that day, a package with no row is one jsDelivr does not know: zero requests.
    mixed.collections = [...mixed.collections, { step: "jsdelivr", collectedAt: at("2026-11-09T02:01:00Z") }];
    const done = buildLatest(mixed, { repo: REPO }, NOW);
    expect(done.jsdelivr.total).toBe(70);
    expect(Object.fromEntries(done.packages.map((row) => [row.name, row.jsdelivr]))).toEqual({
      "@pithy-sh/auth": 0,
      "@pithy-sh/cli": 0,
      "@pithy-sh/core": 70,
    });
  });

  test("counts the repository's issues, bugs and pull requests", () => {
    expect(latest.github).toMatchObject({
      repo: REPO,
      createdAt: "2026-11-03T00:00:00.000Z",
      stars: 50,
      forks: 4,
      contributors: 3,
      commits: 900,
      weekStart: "2026-10-26",
      commitWeeks: [1, 0, 1],
      issues: {
        total: 4,
        open: 1,
        completed: 2,
        notPlanned: 1,
        medianMinutesToClose: 120,
        meanMinutesToClose: 120,
        openedWeeks: [0, 4, 0],
        closedWeeks: [0, 2, 1],
      },
      bugs: {
        total: 2,
        typed: 1,
        labelledOnly: 1,
        open: 1,
        fixed: 1,
        notPlanned: 0,
        medianMinutesToFix: 60,
        meanMinutesToFix: 60,
        reportedWeeks: [0, 2, 0],
        fixedWeeks: [0, 1, 0],
      },
      pullRequests: {
        total: 3,
        merged: 1,
        closedUnmerged: 1,
        open: 1,
        medianMinutesToMerge: 30,
        meanMinutesToMerge: 30,
        additions: 10,
        deletions: 2,
        mergedWeeks: [0, 1, 0],
      },
    });
  });

  test("sums deps.dev's dependents and carries the Scorecard", () => {
    expect(latest.depsDev).toEqual({ dependents: 3 });
    expect(latest.scorecard).toEqual({ score: 5.5, checkedAt: "2026-11-02" });
  });

  test("carries the newest count of the kit, the commit it was taken at, and every day counted oldest first", () => {
    expect(latest.kit).toEqual({
      commit: "b".repeat(40),
      countedAt: "2026-11-09T02:01:29.000Z",
      tests: 120,
      codeLines: 9000,
      history: [
        { date: "2026-11-07", commit: "a".repeat(40), tests: 100, codeLines: 8000 },
        { date: "2026-11-09", commit: "b".repeat(40), tests: 120, codeLines: 9000 },
      ],
    });
  });

  test("leaves the kit's own numbers null until they are counted", () => {
    const bare = buildLatest(empty, { repo: REPO }, NOW);
    expect(bare.kit).toEqual({ commit: null, countedAt: null, tests: null, codeLines: null, history: [] });
  });

  test("leaves every source null, never zero, before anything is collected", () => {
    const bare = buildLatest(empty, { repo: REPO }, NOW);
    expect(Latest.parse(bare)).toEqual(bare);
    expect(bare.asOf).toBe("2026-11-08");
    expect(bare.github).toMatchObject({ repo: REPO, stars: null, commitWeeks: null, weekStart: "2026-11-09" });
    expect(bare.github.issues.total).toBeNull();
    expect(bare.github.pullRequests.mergedWeeks).toBeNull();
    expect(bare.downloads).toEqual({ start: null, end: null, kit: null });
    expect(bare.jsdelivr).toEqual({ start: null, end: null, total: null });
    expect(bare.depsDev.dependents).toBeNull();
    expect(bare.scorecard).toEqual({ score: null, checkedAt: null });
    for (const source of Object.values(bare.sources)) expect(source.collectedAt).toBeNull();
  });

  test("leaves the download series null, never [0], while the package list is read but no download is", () => {
    const listed = { ...empty, packages: ["@pithy-sh/core"] };
    const latest = buildLatest(listed, { repo: REPO }, NOW);
    expect(Latest.parse(latest)).toEqual(latest);
    expect(latest.downloads).toEqual({ start: null, end: null, kit: null });
    expect(latest.packages[0]?.daily).toBeNull();
    expect(latest.packages[0]?.jsdelivr).toBeNull();
  });
});

describe("buildSummary", () => {
  const input = rows();
  const summary = buildSummary(input, buildLatest(input, { repo: REPO }, NOW));

  test("parses as the contract and carries only headline numbers", () => {
    expect(Summary.parse(summary)).toEqual(summary);
    const arrays = JSON.stringify(summary).match(/\[/g);
    expect(arrays).toBeNull();
  });

  test("reads the headline numbers", () => {
    expect(summary).toEqual({
      version: 1,
      generatedAt: "2026-11-09T02:10:00.000Z",
      asOf: "2026-11-08",
      downloads: { since: "2026-11-02", allTime: 128, last30: 128, prior30: 0, last7: 128, prior7: 0 },
      releases: { packages: 2, versions: 3, releaseDays: 2, latestAt: "2026-11-05T12:00:00.000Z" },
      issues: { total: 4, open: 1, medianMinutesToClose: 120 },
      bugs: { total: 2, open: 1, medianMinutesToFix: 60 },
      pullRequests: { merged: 1, medianMinutesToMerge: 30 },
      github: { stars: 50 },
      kit: { tests: 120, codeLines: 9000, commit: "b".repeat(40) },
    });
  });

  test("splits the download windows at asOf", () => {
    const long = rows();
    long.dailyDownloads = Array.from({ length: 14 }, (_, index) => ({
      packageName: "@pithy-sh/core",
      day: new Date(Date.UTC(2026, 9, 26 + index)).toISOString().slice(0, 10),
      downloads: index < 7 ? 1 : 10,
    }));
    const windows = buildSummary(long, buildLatest(long, { repo: REPO }, NOW)).downloads;
    expect(windows).toMatchObject({ allTime: 77, last7: 70, prior7: 7, last30: 77, prior30: 0 });
  });

  test("is null, never zero, before anything is collected", () => {
    const bare = buildSummary(empty, buildLatest(empty, { repo: REPO }, NOW));
    expect(Summary.parse(bare)).toEqual(bare);
    expect(bare.downloads).toEqual({
      since: null,
      allTime: null,
      last30: null,
      prior30: null,
      last7: null,
      prior7: null,
    });
    expect(bare.releases).toEqual({ packages: null, versions: null, releaseDays: null, latestAt: null });
    expect(bare.issues.total).toBeNull();
    expect(bare.github.stars).toBeNull();
  });
});
