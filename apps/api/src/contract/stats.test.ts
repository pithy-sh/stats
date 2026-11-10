import { describe, expect, test } from "vitest";
import { Latest, SnapshotLatest, SnapshotSummary, Summary } from "./stats";

describe("nextUpdate", () => {
  for (const [name, schema] of [
    ["Summary", Summary],
    ["Latest", Latest],
  ] as const) {
    test(`${name} requires it, as an ISO 8601 UTC time with a description`, () => {
      const field = schema.shape.nextUpdate;
      expect(field.description).toMatch(/next run after this file is ready/);
      expect(field.description).toMatch(/revalidate sooner/);
      expect(field.safeParse("2026-11-10T02:15:00.000Z").success).toBe(true);
      expect(field.safeParse("2026-11-10T02:15:00+01:00").success).toBe(false);
      expect(field.safeParse("2026-11-10").success).toBe(false);
      expect(schema.safeParse({}).error?.issues.some((issue) => issue.path[0] === "nextUpdate")).toBe(true);
    });
  }
});

describe("nextUpdate on a snapshot", () => {
  for (const [name, schema] of [
    ["SnapshotSummary", SnapshotSummary],
    ["SnapshotLatest", SnapshotLatest],
  ] as const) {
    test(`${name} lets it be absent, and says so, since a past day's snapshot is never rewritten`, () => {
      const field = schema.shape.nextUpdate;
      expect(field.description).toMatch(/Absent from a snapshot published before/);
      expect(field.safeParse(undefined).success).toBe(true);
      expect(field.safeParse("2026-11-10T02:15:00.000Z").success).toBe(true);
      expect(field.safeParse("2026-11-10").success).toBe(false);
      expect(schema.safeParse({}).error?.issues.some((issue) => issue.path[0] === "nextUpdate")).toBe(false);
    });
  }
});
