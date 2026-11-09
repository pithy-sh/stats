import { describe, expect, test } from "vitest";
import {
  currentCacheControl,
  isLate,
  NOT_FOUND_CACHE_CONTROL,
  SNAPSHOT_CACHE_CONTROL,
  secondsUntilEndOfDay,
  secondsUntilNextFile,
  snapshotCacheControl,
} from "./cache";

const at = (iso: string) => new Date(iso);

describe("secondsUntilNextFile", () => {
  test("counts to 02:05 UTC the same day before it", () => {
    expect(secondsUntilNextFile(at("2026-11-09T00:00:00Z"))).toBe(2 * 3600 + 5 * 60);
    expect(secondsUntilNextFile(at("2026-11-09T02:00:00Z"))).toBe(5 * 60);
    expect(secondsUntilNextFile(at("2026-11-09T02:04:59Z"))).toBe(1);
  });

  test("counts to 02:05 UTC the next day from it onwards", () => {
    expect(secondsUntilNextFile(at("2026-11-09T02:05:00Z"))).toBe(86_400);
    expect(secondsUntilNextFile(at("2026-11-09T12:00:00Z"))).toBe(14 * 3600 + 5 * 60);
  });

  test("crosses midnight, a month end and a year end", () => {
    expect(secondsUntilNextFile(at("2026-11-09T23:59:59Z"))).toBe(2 * 3600 + 5 * 60 + 1);
    expect(secondsUntilNextFile(at("2026-11-30T23:00:00Z"))).toBe(3 * 3600 + 5 * 60);
    expect(secondsUntilNextFile(at("2026-12-31T22:30:00Z"))).toBe(3 * 3600 + 35 * 60);
  });

  test("rounds a part second up, so a copy never outlives the file", () => {
    expect(secondsUntilNextFile(at("2026-11-09T02:04:59.250Z"))).toBe(1);
    expect(secondsUntilNextFile(at("2026-11-09T02:04:58.250Z"))).toBe(2);
  });

  test("ignores the local time zone: an offset instant is the same instant", () => {
    expect(secondsUntilNextFile(at("2026-11-09T20:00:00-05:00"))).toBe(
      secondsUntilNextFile(at("2026-11-10T01:00:00Z")),
    );
  });
});

describe("Cache-Control", () => {
  test("the current files are public and revalidate in the background for an hour", () => {
    expect(currentCacheControl(at("2026-11-09T02:00:00Z"))).toBe("public, max-age=300, stale-while-revalidate=3600");
  });

  test("a snapshot is immutable for a year once its day is over", () => {
    expect(SNAPSHOT_CACHE_CONTROL).toBe("public, max-age=31536000, immutable");
    expect(snapshotCacheControl("2026-11-08", at("2026-11-09T00:00:00Z"))).toBe(SNAPSHOT_CACHE_CONTROL);
    expect(snapshotCacheControl("2025-01-01", at("2026-11-09T12:00:00Z"))).toBe(SNAPSHOT_CACHE_CONTROL);
  });

  test("today's snapshot, which a later run today may rewrite, expires by midnight UTC at the latest", () => {
    // Before today's run, the next file is due first.
    expect(snapshotCacheControl("2026-11-09", at("2026-11-09T02:03:00Z"))).toBe("public, max-age=120");
    // After it, the day ends first, so no copy taken today outlives the day.
    expect(snapshotCacheControl("2026-11-09", at("2026-11-09T12:00:00Z"))).toBe(`public, max-age=${12 * 3600}`);
    expect(snapshotCacheControl("2026-11-09", at("2026-11-09T23:59:59Z"))).toBe("public, max-age=1");
    expect(snapshotCacheControl("2026-11-09", at("2026-11-09T23:59:59.500Z"))).toBe("public, max-age=1");
  });

  test("today's snapshot is never served stale past midnight", () => {
    expect(snapshotCacheControl("2026-11-09", at("2026-11-09T22:00:00Z"))).not.toContain("stale-while-revalidate");
  });
});

describe("secondsUntilEndOfDay", () => {
  test("counts to the next midnight UTC, rounding a part second up", () => {
    expect(secondsUntilEndOfDay(at("2026-11-09T00:00:00Z"))).toBe(86_400);
    expect(secondsUntilEndOfDay(at("2026-11-09T12:00:00Z"))).toBe(12 * 3600);
    expect(secondsUntilEndOfDay(at("2026-11-09T23:59:59.250Z"))).toBe(1);
  });
});

describe("a 404", () => {
  test("is public and kept as long as a late file", () => {
    expect(NOT_FOUND_CACHE_CONTROL).toBe("public, max-age=300");
  });
});

describe("a late run", () => {
  test("is a current file uploaded before today's 02:00 UTC, once 02:05 has passed", () => {
    expect(isLate(at("2026-11-09T02:05:00Z"), at("2026-11-08T02:03:00Z"))).toBe(true);
    expect(isLate(at("2026-11-09T23:00:00Z"), at("2026-11-09T01:59:59Z"))).toBe(true);
  });

  test("is not before 02:05, nor once today's file is uploaded", () => {
    expect(isLate(at("2026-11-09T02:04:59Z"), at("2026-11-08T02:03:00Z"))).toBe(false);
    expect(isLate(at("2026-11-09T02:05:00Z"), at("2026-11-09T02:00:00Z"))).toBe(false);
    expect(isLate(at("2026-11-09T12:00:00Z"), at("2026-11-09T02:03:00Z"))).toBe(false);
  });

  test("keeps a copy five minutes instead of until tomorrow's 02:05", () => {
    const yesterday = at("2026-11-08T02:03:00Z");
    expect(currentCacheControl(at("2026-11-09T02:06:00Z"), yesterday)).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    expect(currentCacheControl(at("2026-11-09T02:04:00Z"), yesterday)).toBe(
      "public, max-age=60, stale-while-revalidate=3600",
    );
    expect(currentCacheControl(at("2026-11-09T02:06:00Z"), at("2026-11-09T02:03:00Z"))).toBe(
      `public, max-age=${86_400 - 60}, stale-while-revalidate=3600`,
    );
  });
});
