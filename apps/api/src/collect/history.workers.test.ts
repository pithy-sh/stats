import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { statsDatabase } from "../data/tables";
import { freshDatabase } from "../data/testing";
import { markHistoryCollected, readHistoryState } from "./history";
import { recordPackages, writeRegistry } from "./store";
import type { RegistryFacts } from "./upstream/npm";

const db = () => statsDatabase(env.DB);

const facts = (createdAt: Date | null): RegistryFacts => ({
  latestVersion: "0.1.0",
  description: null,
  createdAt,
  versions: [],
  unpackedSize: null,
  fileCount: null,
  dependencies: {},
  peerDependencies: {},
});

beforeEach(async () => {
  await freshDatabase(env.DB);
});

describe("readHistoryState", () => {
  test("a newly recorded package is pending, with the UTC day its newest registry row says it was created", async () => {
    await recordPackages(db(), ["@pithy-sh/core"], "2026-11-09");
    await writeRegistry(db(), "@pithy-sh/core", facts(new Date("2026-09-05T23:30:00-02:00")), "2026-11-09");
    expect(await readHistoryState(db(), ["@pithy-sh/core"])).toEqual({
      "@pithy-sh/core": { pending: true, createdOn: "2026-09-06" },
    });
  });

  test("a package with no registry row, or one with no creation time, has no creation day", async () => {
    await recordPackages(db(), ["@pithy-sh/a", "@pithy-sh/b"], "2026-11-09");
    await writeRegistry(db(), "@pithy-sh/b", facts(null), "2026-11-09");
    expect(await readHistoryState(db(), ["@pithy-sh/a", "@pithy-sh/b"])).toEqual({
      "@pithy-sh/a": { pending: true, createdOn: null },
      "@pithy-sh/b": { pending: true, createdOn: null },
    });
  });

  test("a package marked collected is no longer pending, and only the names asked for are answered", async () => {
    await recordPackages(db(), ["@pithy-sh/core", "@pithy-sh/auth", "@pithy-sh/gone"], "2026-11-09");
    await markHistoryCollected(db(), "@pithy-sh/core", "2026-11-09");
    expect(await readHistoryState(db(), ["@pithy-sh/core", "@pithy-sh/auth"])).toEqual({
      "@pithy-sh/core": { pending: false, createdOn: null },
      "@pithy-sh/auth": { pending: true, createdOn: null },
    });
  });

  test("a name with no package row is pending", async () => {
    expect(await readHistoryState(db(), ["@pithy-sh/unknown"])).toEqual({
      "@pithy-sh/unknown": { pending: true, createdOn: null },
    });
  });
});

describe("markHistoryCollected", () => {
  test("records the first day only: marking again later keeps it", async () => {
    await recordPackages(db(), ["@pithy-sh/core"], "2026-11-08");
    await markHistoryCollected(db(), "@pithy-sh/core", "2026-11-08");
    await markHistoryCollected(db(), "@pithy-sh/core", "2026-11-09");
    expect(await db().selectFrom("packages").selectAll().execute()).toEqual([
      { name: "@pithy-sh/core", firstSeenOn: "2026-11-08", lastSeenOn: "2026-11-08", historyCollectedOn: "2026-11-08" },
    ]);
  });

  test("a later recordPackages leaves the mark alone", async () => {
    await recordPackages(db(), ["@pithy-sh/core"], "2026-11-08");
    await markHistoryCollected(db(), "@pithy-sh/core", "2026-11-08");
    await recordPackages(db(), ["@pithy-sh/core"], "2026-11-09");
    const row = await db().selectFrom("packages").select("historyCollectedOn").executeTakeFirst();
    expect(row?.historyCollectedOn).toBe("2026-11-08");
  });
});
