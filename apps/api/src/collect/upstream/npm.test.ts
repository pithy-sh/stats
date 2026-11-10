import { UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { addDays } from "../day";
import {
  fetchDailyDownloads,
  fetchNpmDays,
  fetchNpmWeek,
  fetchOrgPackages,
  fetchRegistry,
  fetchVersionDownloads,
} from "./npm";
import { stubFetch } from "./testing";

describe("fetchOrgPackages", () => {
  test("lists the org's packages, sorted", async () => {
    const stub = stubFetch({
      "https://registry.npmjs.org/-/org/pithy-sh/package": {
        json: { "@pithy-sh/core": "write", "@pithy-sh/auth": "write" },
      },
    });
    expect(await fetchOrgPackages(stub.fetch, "pithy-sh")).toEqual(["@pithy-sh/auth", "@pithy-sh/core"]);
  });
});

describe("fetchDailyDownloads", () => {
  test("reads one range per package", async () => {
    const stub = stubFetch({
      "https://api.npmjs.org/downloads/range/2026-11-06:2026-11-08/@pithy-sh/core": {
        json: {
          start: "2026-11-06",
          end: "2026-11-08",
          package: "@pithy-sh/core",
          downloads: [
            { downloads: 5, day: "2026-11-06" },
            { downloads: 7, day: "2026-11-07" },
            { downloads: 0, day: "2026-11-08" },
          ],
        },
      },
    });
    expect(await fetchDailyDownloads(stub.fetch, "@pithy-sh/core", { start: "2026-11-06", end: "2026-11-08" })).toEqual(
      [
        { day: "2026-11-06", downloads: 5 },
        { day: "2026-11-07", downloads: 7 },
        { day: "2026-11-08", downloads: 0 },
      ],
    );
  });

  test("splits a span longer than npm allows into several requests", async () => {
    const stub = stubFetch({
      "https://api.npmjs.org/downloads/range/*": (call) => {
        const span = call.url.split("/")[5] ?? "";
        const [start] = span.split(":");
        return { json: { downloads: [{ downloads: 1, day: start }] } };
      },
    });
    const rows = await fetchDailyDownloads(stub.fetch, "@pithy-sh/core", { start: "2025-01-01", end: "2026-06-30" });
    expect(stub.calls.map((call) => call.url.split("/")[5])).toEqual([
      "2025-01-01:2025-12-31",
      "2026-01-01:2026-06-30",
    ]);
    expect(rows).toEqual([
      { day: "2025-01-01", downloads: 1 },
      { day: "2026-01-01", downloads: 1 },
    ]);
  });

  test("is empty when npm has no stats for the package yet", async () => {
    const stub = stubFetch({
      "https://api.npmjs.org/downloads/range/*": { status: 404, json: { error: "package @pithy-sh/new not found" } },
    });
    expect(await fetchDailyDownloads(stub.fetch, "@pithy-sh/new", { start: "2026-11-06", end: "2026-11-08" })).toEqual(
      [],
    );
  });

  test("makes no request for an empty span", async () => {
    const stub = stubFetch({});
    expect(await fetchDailyDownloads(stub.fetch, "@pithy-sh/core", { start: "2026-11-09", end: "2026-11-08" })).toEqual(
      [],
    );
    expect(stub.calls).toHaveLength(0);
  });
});

describe("fetchVersionDownloads", () => {
  test("reads the last week's count per version, with the scope's slash encoded", async () => {
    const stub = stubFetch({
      "https://api.npmjs.org/versions/@pithy-sh%2Fcore/last-week": {
        json: { package: "@pithy-sh/core", downloads: { "0.20.0": 40, "0.19.1": 3 } },
      },
    });
    expect(await fetchVersionDownloads(stub.fetch, "@pithy-sh/core")).toEqual({ "0.20.0": 40, "0.19.1": 3 });
  });

  test("is empty when npm has nothing for the package", async () => {
    const stub = stubFetch({ "https://api.npmjs.org/versions/*": { status: 404, json: {} } });
    expect(await fetchVersionDownloads(stub.fetch, "@pithy-sh/new")).toEqual({});
  });
});

describe("fetchRegistry", () => {
  const packument = {
    name: "@pithy-sh/core",
    description: "The Pithy kit's core.",
    "dist-tags": { latest: "0.20.0", next: "0.21.0-rc.1" },
    time: {
      created: "2026-09-05T10:00:00.000Z",
      modified: "2026-11-01T10:00:00.000Z",
      "0.1.0": "2026-09-05T10:00:00.000Z",
      "0.20.0": "2026-11-01T10:00:00.000Z",
      "0.0.9": "2026-09-01T00:00:00.000Z",
    },
    versions: {
      "0.1.0": { dist: { unpackedSize: 100, fileCount: 3 } },
      "0.20.0": {
        dist: { unpackedSize: 2048, fileCount: 40 },
        dependencies: { zod: "^4.0.0" },
        peerDependencies: { hono: "^4.0.0" },
      },
    },
  };

  test("reads every version's publish time and the latest manifest's shape", async () => {
    const stub = stubFetch({ "https://registry.npmjs.org/@pithy-sh%2Fcore": { json: packument } });
    expect(await fetchRegistry(stub.fetch, "@pithy-sh/core")).toEqual({
      latestVersion: "0.20.0",
      description: "The Pithy kit's core.",
      createdAt: new Date("2026-09-05T10:00:00.000Z"),
      versions: [
        { version: "0.1.0", publishedAt: new Date("2026-09-05T10:00:00.000Z") },
        { version: "0.20.0", publishedAt: new Date("2026-11-01T10:00:00.000Z") },
      ],
      unpackedSize: 2048,
      fileCount: 40,
      dependencies: { zod: "^4.0.0" },
      peerDependencies: { hono: "^4.0.0" },
    });
  });

  test("answers empty dependencies and null sizes where the manifest leaves them out", async () => {
    const stub = stubFetch({
      "https://registry.npmjs.org/@pithy-sh%2Fcore": {
        json: {
          ...packument,
          description: undefined,
          "dist-tags": { latest: "0.1.0" },
          versions: { "0.1.0": { dist: {} } },
        },
      },
    });
    expect(await fetchRegistry(stub.fetch, "@pithy-sh/core")).toMatchObject({
      latestVersion: "0.1.0",
      description: null,
      unpackedSize: null,
      fileCount: null,
      dependencies: {},
      peerDependencies: {},
    });
  });
});

describe("fetchNpmDays", () => {
  const TODAY = "2026-11-10";
  const POINT = "https://api.npmjs.org/downloads/point/";
  const point = (name: string, start: string, end: string) => ({
    json: { downloads: 36, start, end, package: name },
  });

  test("reads npm's last complete day and its last-week window off one package, one request each", async () => {
    const stub = stubFetch({
      [`${POINT}last-day/@pithy-sh/auth`]: point("@pithy-sh/auth", "2026-11-08", "2026-11-08"),
      [`${POINT}last-week/@pithy-sh/auth`]: point("@pithy-sh/auth", "2026-11-02", "2026-11-08"),
    });
    expect(await fetchNpmDays(stub.fetch, ["@pithy-sh/auth", "@pithy-sh/core"], TODAY)).toEqual({
      package: "@pithy-sh/auth",
      lastDay: "2026-11-08",
      lastWeek: { start: "2026-11-02", end: "2026-11-08" },
    });
    expect(stub.calls.map((call) => call.url)).toEqual([
      `${POINT}last-day/@pithy-sh/auth`,
      `${POINT}last-week/@pithy-sh/auth`,
    ]);
  });

  test("asks the next package when npm has no stats for one", async () => {
    const stub = stubFetch({
      [`${POINT}last-day/@pithy-sh/auth`]: { status: 404, json: { error: "package @pithy-sh/auth not found" } },
      [`${POINT}last-day/@pithy-sh/core`]: point("@pithy-sh/core", "2026-11-08", "2026-11-08"),
      [`${POINT}last-week/@pithy-sh/core`]: point("@pithy-sh/core", "2026-11-02", "2026-11-08"),
    });
    expect(await fetchNpmDays(stub.fetch, ["@pithy-sh/auth", "@pithy-sh/core"], TODAY)).toEqual({
      package: "@pithy-sh/core",
      lastDay: "2026-11-08",
      lastWeek: { start: "2026-11-02", end: "2026-11-08" },
    });
    expect(stub.calls).toHaveLength(3);
  });

  test("fails when no package has stats, rather than guess a day", async () => {
    const stub = stubFetch({ [`${POINT}*`]: { status: 404, json: { error: "not found" } } });
    await expect(fetchNpmDays(stub.fetch, ["@pithy-sh/auth"], TODAY)).rejects.toBeInstanceOf(UpstreamError);
    await expect(fetchNpmDays(stub.fetch, [], TODAY)).rejects.toBeInstanceOf(UpstreamError);
  });

  test("fails on an answer that is not a single day, so a malformed probe never caps a window", async () => {
    const stub = stubFetch({
      [`${POINT}last-day/@pithy-sh/auth`]: point("@pithy-sh/auth", "2026-11-07", "2026-11-08"),
      [`${POINT}last-week/@pithy-sh/auth`]: point("@pithy-sh/auth", "2026-11-02", "2026-11-08"),
    });
    await expect(fetchNpmDays(stub.fetch, ["@pithy-sh/auth"], TODAY)).rejects.toBeInstanceOf(UpstreamError);
  });

  test("fails when last-week does not end on last-day, so a week that does not match is never recorded", async () => {
    const stub = stubFetch({
      [`${POINT}last-day/@pithy-sh/auth`]: point("@pithy-sh/auth", "2026-11-08", "2026-11-08"),
      [`${POINT}last-week/@pithy-sh/auth`]: point("@pithy-sh/auth", "2026-11-03", "2026-11-09"),
    });
    await expect(fetchNpmDays(stub.fetch, ["@pithy-sh/auth"], TODAY)).rejects.toBeInstanceOf(UpstreamError);
  });

  test("fails when last-week ends on last-day but is not seven days long", async () => {
    const stub = stubFetch({
      [`${POINT}last-day/@pithy-sh/auth`]: point("@pithy-sh/auth", "2026-11-08", "2026-11-08"),
      [`${POINT}last-week/@pithy-sh/auth`]: point("@pithy-sh/auth", "2026-11-01", "2026-11-08"),
    });
    await expect(fetchNpmDays(stub.fetch, ["@pithy-sh/auth"], TODAY)).rejects.toBeInstanceOf(UpstreamError);
  });

  test("fails when last-day is the run's own day or later, which npm cannot have finished", async () => {
    for (const day of [TODAY, "2026-11-11"]) {
      const stub = stubFetch({
        [`${POINT}last-day/@pithy-sh/auth`]: point("@pithy-sh/auth", day, day),
        [`${POINT}last-week/@pithy-sh/auth`]: point("@pithy-sh/auth", addDays(day, -6), day),
      });
      await expect(fetchNpmDays(stub.fetch, ["@pithy-sh/auth"], TODAY)).rejects.toBeInstanceOf(UpstreamError);
    }
  });
});

describe("fetchNpmWeek", () => {
  test("reads the window npm's last-week counts cover for one package", async () => {
    const stub = stubFetch({
      "https://api.npmjs.org/downloads/point/last-week/@pithy-sh/core": {
        json: { downloads: 36, start: "2026-11-02", end: "2026-11-08", package: "@pithy-sh/core" },
      },
    });
    expect(await fetchNpmWeek(stub.fetch, "@pithy-sh/core")).toEqual({ start: "2026-11-02", end: "2026-11-08" });
  });
});
