import { describe, expect, test } from "vitest";
import { fetchDailyDownloads, fetchOrgPackages, fetchRegistry, fetchVersionDownloads } from "./npm";
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
        json: { ...packument, "dist-tags": { latest: "0.1.0" }, versions: { "0.1.0": { dist: {} } } },
      },
    });
    expect(await fetchRegistry(stub.fetch, "@pithy-sh/core")).toMatchObject({
      latestVersion: "0.1.0",
      unpackedSize: null,
      fileCount: null,
      dependencies: {},
      peerDependencies: {},
    });
  });
});
