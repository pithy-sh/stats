import { describe, expect, test } from "vitest";
import type { Schedule } from "../schedule";
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
const MINUTE = 60_000;

/** The defaults: a 02:00 UTC run, ready 15 minutes after. */
const DEFAULT: Schedule = { runStartMs: 2 * 60 * MINUTE, readyAfterMs: 15 * MINUTE };
/** A run at 23:50 UTC whose files are ready at 00:05 the next day. */
const ACROSS_MIDNIGHT: Schedule = { runStartMs: (23 * 60 + 50) * MINUTE, readyAfterMs: 15 * MINUTE };
/** A 06:30 run given an hour. */
const LATER: Schedule = { runStartMs: (6 * 60 + 30) * MINUTE, readyAfterMs: 60 * MINUTE };

describe("secondsUntilNextFile", () => {
  test("counts to the ready time, 02:15 UTC by default, the same day before it", () => {
    expect(secondsUntilNextFile(at("2026-11-09T00:00:00Z"), DEFAULT)).toBe(2 * 3600 + 15 * 60);
    expect(secondsUntilNextFile(at("2026-11-09T02:00:00Z"), DEFAULT)).toBe(15 * 60);
    expect(secondsUntilNextFile(at("2026-11-09T02:14:59Z"), DEFAULT)).toBe(1);
  });

  test("counts to the next day's ready time from it onwards", () => {
    expect(secondsUntilNextFile(at("2026-11-09T02:15:00Z"), DEFAULT)).toBe(86_400);
    expect(secondsUntilNextFile(at("2026-11-09T12:00:00Z"), DEFAULT)).toBe(14 * 3600 + 15 * 60);
  });

  test("crosses midnight, a month end and a year end", () => {
    expect(secondsUntilNextFile(at("2026-11-09T23:59:59Z"), DEFAULT)).toBe(2 * 3600 + 15 * 60 + 1);
    expect(secondsUntilNextFile(at("2026-11-30T23:00:00Z"), DEFAULT)).toBe(3 * 3600 + 15 * 60);
    expect(secondsUntilNextFile(at("2026-12-31T22:30:00Z"), DEFAULT)).toBe(3 * 3600 + 45 * 60);
  });

  test("follows any schedule, a ready time past midnight included", () => {
    expect(secondsUntilNextFile(at("2026-11-09T06:00:00Z"), LATER)).toBe(90 * 60);
    expect(secondsUntilNextFile(at("2026-11-09T23:55:00Z"), ACROSS_MIDNIGHT)).toBe(10 * 60);
    expect(secondsUntilNextFile(at("2026-11-10T00:05:00Z"), ACROSS_MIDNIGHT)).toBe(86_400);
  });

  test("rounds a part second up, so a copy never outlives the file", () => {
    expect(secondsUntilNextFile(at("2026-11-09T02:14:59.250Z"), DEFAULT)).toBe(1);
    expect(secondsUntilNextFile(at("2026-11-09T02:14:58.250Z"), DEFAULT)).toBe(2);
  });

  test("ignores the local time zone: an offset instant is the same instant", () => {
    expect(secondsUntilNextFile(at("2026-11-09T20:00:00-05:00"), DEFAULT)).toBe(
      secondsUntilNextFile(at("2026-11-10T01:00:00Z"), DEFAULT),
    );
  });
});

describe("Cache-Control for the current files", () => {
  const yesterday = at("2026-11-08T02:12:00Z");

  test("are public and revalidate in the background for an hour", () => {
    expect(currentCacheControl(at("2026-11-09T02:00:00Z"), DEFAULT)).toBe(
      "public, max-age=900, stale-while-revalidate=3600",
    );
  });

  test("a current file fetched at 01:00 or 02:10 UTC is kept until 02:15", () => {
    expect(currentCacheControl(at("2026-11-09T01:00:00Z"), DEFAULT, yesterday)).toBe(
      `public, max-age=${75 * 60}, stale-while-revalidate=3600`,
    );
    expect(currentCacheControl(at("2026-11-09T02:10:00Z"), DEFAULT, yesterday)).toBe(
      `public, max-age=${5 * 60}, stale-while-revalidate=3600`,
    );
  });

  test("at 02:16 with yesterday's file, the run is late and a copy is kept five minutes", () => {
    expect(currentCacheControl(at("2026-11-09T02:16:00Z"), DEFAULT, yesterday)).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
  });

  test("at 02:16 with a file uploaded at 02:12 today, a copy is kept until tomorrow's 02:15", () => {
    expect(currentCacheControl(at("2026-11-09T02:16:00Z"), DEFAULT, at("2026-11-09T02:12:00Z"))).toBe(
      `public, max-age=${86_400 - 60}, stale-while-revalidate=3600`,
    );
  });
});

describe("Cache-Control for a snapshot", () => {
  test("is immutable for a year once its day is over", () => {
    expect(SNAPSHOT_CACHE_CONTROL).toBe("public, max-age=31536000, immutable");
    expect(snapshotCacheControl("2026-11-08", at("2026-11-09T00:00:00Z"), DEFAULT)).toBe(SNAPSHOT_CACHE_CONTROL);
    expect(snapshotCacheControl("2025-01-01", at("2026-11-09T12:00:00Z"), DEFAULT)).toBe(SNAPSHOT_CACHE_CONTROL);
  });

  test("today's snapshot, which a later run today may rewrite, expires at the ready time or midnight UTC", () => {
    // Before today's ready time, the next file is due first.
    expect(snapshotCacheControl("2026-11-09", at("2026-11-09T02:13:00Z"), DEFAULT)).toBe("public, max-age=120");
    // After it, the day ends first, so no copy taken today outlives the day.
    expect(snapshotCacheControl("2026-11-09", at("2026-11-09T12:00:00Z"), DEFAULT)).toBe(
      `public, max-age=${12 * 3600}`,
    );
    expect(snapshotCacheControl("2026-11-09", at("2026-11-09T23:59:59Z"), DEFAULT)).toBe("public, max-age=1");
    expect(snapshotCacheControl("2026-11-09", at("2026-11-09T23:59:59.500Z"), DEFAULT)).toBe("public, max-age=1");
  });

  test("uses the schedule's ready time, still capped at midnight", () => {
    expect(snapshotCacheControl("2026-11-09", at("2026-11-09T06:00:00Z"), LATER)).toBe(`public, max-age=${90 * 60}`);
    // A ready time past midnight never stretches today's copy into tomorrow.
    expect(snapshotCacheControl("2026-11-09", at("2026-11-09T23:55:00Z"), ACROSS_MIDNIGHT)).toBe(
      `public, max-age=${5 * 60}`,
    );
  });

  test("today's snapshot is never served stale past midnight", () => {
    expect(snapshotCacheControl("2026-11-09", at("2026-11-09T22:00:00Z"), DEFAULT)).not.toContain(
      "stale-while-revalidate",
    );
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
  test("is a current file uploaded before the latest run start, once that run's ready time has passed", () => {
    expect(isLate(at("2026-11-09T02:15:00Z"), at("2026-11-08T02:13:00Z"), DEFAULT)).toBe(true);
    expect(isLate(at("2026-11-09T23:00:00Z"), at("2026-11-09T01:59:59Z"), DEFAULT)).toBe(true);
  });

  test("is not before the ready time, nor once the latest run's file is uploaded", () => {
    expect(isLate(at("2026-11-09T02:14:59Z"), at("2026-11-08T02:13:00Z"), DEFAULT)).toBe(false);
    expect(isLate(at("2026-11-09T02:15:00Z"), at("2026-11-09T02:00:00Z"), DEFAULT)).toBe(false);
    expect(isLate(at("2026-11-09T12:00:00Z"), at("2026-11-09T02:13:00Z"), DEFAULT)).toBe(false);
    expect(isLate(at("2026-11-09T01:00:00Z"), at("2026-11-08T02:13:00Z"), DEFAULT)).toBe(false);
  });

  test("before today's run, is yesterday's run never having landed", () => {
    expect(isLate(at("2026-11-09T01:00:00Z"), at("2026-11-07T02:13:00Z"), DEFAULT)).toBe(true);
    // Still late while today's run is under way: yesterday's file is the one overdue.
    expect(isLate(at("2026-11-09T02:05:00Z"), at("2026-11-07T02:13:00Z"), DEFAULT)).toBe(true);
  });

  test("follows a ready time past midnight", () => {
    // The 23:50 run's file landed at 23:58: not late at 00:10 the next day.
    expect(isLate(at("2026-11-10T00:10:00Z"), at("2026-11-09T23:58:00Z"), ACROSS_MIDNIGHT)).toBe(false);
    // The day before's file is late once 00:05 has passed.
    expect(isLate(at("2026-11-10T00:10:00Z"), at("2026-11-08T23:58:00Z"), ACROSS_MIDNIGHT)).toBe(true);
    expect(isLate(at("2026-11-10T00:04:00Z"), at("2026-11-08T23:58:00Z"), ACROSS_MIDNIGHT)).toBe(false);
  });
});
