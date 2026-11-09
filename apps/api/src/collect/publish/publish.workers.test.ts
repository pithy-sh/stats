import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { currentKey, snapshotKey } from "../../contract/objects";
import { Latest, Summary } from "../../contract/stats";
import { statsDatabase } from "../../data/tables";
import { freshDatabase } from "../../data/testing";
import {
  recordCollected,
  recordPackages,
  writeCdn,
  writeDailyDownloads,
  writeDependents,
  writeRegistry,
} from "../store";
import { publish } from "./publish";

const REPO = "pithy-sh/pithy";
const DAY = "2026-11-09";
const NOW = new Date("2026-11-09T02:10:00Z");
const db = () => statsDatabase(env.DB);

interface Put {
  key: string;
  body: string;
  contentType: string | undefined;
}

/** An R2 bucket that records every put, in order, and stores nothing. */
function recordingBucket(): { bucket: R2Bucket; puts: Put[] } {
  const puts: Put[] = [];
  const bucket = {
    async put(key: string, body: string, options?: R2PutOptions) {
      const httpMetadata = options?.httpMetadata as R2HTTPMetadata | undefined;
      puts.push({ key, body, contentType: httpMetadata?.contentType });
      return {} as R2Object;
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
}

async function clearBucket(): Promise<void> {
  const listed = await env.PUBLISHED.list();
  for (const object of listed.objects) await env.PUBLISHED.delete(object.key);
}

/** One package, `name`, with a day of every per-package source, captured on `day`. */
async function seedPackage(name: string, day: string, downloads: number): Promise<void> {
  await writeDailyDownloads(db(), name, [{ day: "2026-11-08", downloads }], day);
  await writeRegistry(
    db(),
    name,
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
    day,
  );
  await writeCdn(db(), name, { period: "month", hits: downloads, bandwidth: 1, rank: null }, day);
  await writeDependents(
    db(),
    name,
    { version: "0.1.0", dependents: downloads, directDependents: downloads, indirectDependents: 0 },
    day,
  );
}

beforeEach(async () => {
  await freshDatabase(env.DB);
  await clearBucket();
});

describe("publish", () => {
  test("writes the day's snapshots first, then the current copies, as JSON, and reports each size", async () => {
    await recordPackages(db(), ["@pithy-sh/core"], DAY);
    await seedPackage("@pithy-sh/core", DAY, 10);
    const { bucket, puts } = recordingBucket();

    const report = await publish(db(), bucket, REPO, DAY, NOW);

    expect(puts.map((put) => put.key)).toEqual([
      snapshotKey(DAY, "summary"),
      snapshotKey(DAY, "latest"),
      currentKey("summary"),
      currentKey("latest"),
    ]);
    for (const put of puts) expect(put.contentType).toBe("application/json; charset=utf-8");
    expect(report).toEqual(
      Object.fromEntries(puts.map((put) => [put.key, new TextEncoder().encode(put.body).byteLength])),
    );
    const [summary, latest, currentSummary, currentLatest] = puts.map((put) => JSON.parse(put.body));
    expect(Summary.parse(summary)).toEqual(currentSummary);
    expect(Latest.parse(latest)).toEqual(currentLatest);
  });

  test("a build that fails the contract writes nothing", async () => {
    await recordPackages(db(), ["@pithy-sh/core"], DAY);
    await seedPackage("@pithy-sh/core", DAY, 10);
    await db()
      .insertInto("dailyDownloads")
      .values({ packageName: "@pithy-sh/core", day: "2026-11-07", downloads: -5, capturedOn: DAY })
      .execute();
    const { bucket, puts } = recordingBucket();

    await expect(publish(db(), bucket, REPO, DAY, NOW)).rejects.toThrow();
    expect(puts).toEqual([]);
  });

  test("a package that has left the org is in no list and no total", async () => {
    await recordPackages(db(), ["@pithy-sh/core", "@pithy-sh/gone"], "2026-11-05");
    await recordPackages(db(), ["@pithy-sh/core"], DAY);
    await seedPackage("@pithy-sh/gone", "2026-11-05", 1000);
    await seedPackage("@pithy-sh/core", DAY, 10);
    await recordCollected(db(), "jsdelivr", NOW);
    const { bucket, puts } = recordingBucket();

    await publish(db(), bucket, REPO, DAY, NOW);
    const file = (key: string) => JSON.parse(puts.find((put) => put.key === key)?.body ?? "null");
    const latest = Latest.parse(file(currentKey("latest")));
    const summary = Summary.parse(file(currentKey("summary")));

    expect(latest.packages.map((row) => row.name)).toEqual(["@pithy-sh/core"]);
    expect(latest.downloads.kit).toEqual([10]);
    expect(latest.jsdelivr.total).toBe(10);
    expect(latest.depsDev.dependents).toBe(10);
    expect(summary.downloads.allTime).toBe(10);
    expect(summary.releases).toMatchObject({ packages: 1, versions: 1 });
  });

  test("a re-run on the snapshot's own day rewrites it, since it is not immutable until the day is over", async () => {
    await recordPackages(db(), ["@pithy-sh/core"], DAY);
    await seedPackage("@pithy-sh/core", DAY, 10);
    await publish(db(), env.PUBLISHED, REPO, DAY, NOW);
    await seedPackage("@pithy-sh/core", DAY, 20);
    await publish(db(), env.PUBLISHED, REPO, DAY, new Date("2026-11-09T10:00:00Z"));

    const snapshot = Latest.parse(await (await env.PUBLISHED.get(snapshotKey(DAY, "latest")))?.json());
    expect(snapshot.downloads.kit).toEqual([20]);
  });

  test("a run that publishes after its capture day is over never rewrites that day's snapshot", async () => {
    await recordPackages(db(), ["@pithy-sh/core"], DAY);
    await seedPackage("@pithy-sh/core", DAY, 10);
    await publish(db(), env.PUBLISHED, REPO, DAY, NOW);
    const before = await (await env.PUBLISHED.get(snapshotKey(DAY, "latest")))?.text();

    await seedPackage("@pithy-sh/core", DAY, 20);
    const report = await publish(db(), env.PUBLISHED, REPO, DAY, new Date("2026-11-10T00:01:00Z"));

    expect(await (await env.PUBLISHED.get(snapshotKey(DAY, "latest")))?.text()).toBe(before);
    expect(Object.keys(report)).toEqual([currentKey("summary"), currentKey("latest")]);
    const current = Latest.parse(await (await env.PUBLISHED.get(currentKey("latest")))?.json());
    expect(current.downloads.kit).toEqual([20]);
  });

  test("a run that publishes after its capture day still writes that day's snapshot when none exists", async () => {
    await recordPackages(db(), ["@pithy-sh/core"], DAY);
    await seedPackage("@pithy-sh/core", DAY, 10);
    const report = await publish(db(), env.PUBLISHED, REPO, DAY, new Date("2026-11-10T00:01:00Z"));
    expect(Object.keys(report)).toContain(snapshotKey(DAY, "latest"));
    expect(await env.PUBLISHED.head(snapshotKey(DAY, "latest"))).not.toBeNull();
  });
});
