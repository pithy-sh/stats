import { describe, expect, test } from "vitest";
import { dayRanges } from "./day";
import { MAX_RANGE_DAYS } from "./upstream/npm";
import { DownloadWindow, downloadWindowFor, npmHistoryStart } from "./window";

/** npm has counted every day before the run's: the usual case once its day has closed. */
const counted = { completeThrough: "2026-11-08" } as const;
const known = { pending: false, createdOn: "2026-09-05", ...counted } as const;
const fresh = { pending: true, createdOn: "2026-09-05", ...counted } as const;

describe("npmHistoryStart", () => {
  test("is the first day inside the eighteen months that end on the given day", () => {
    expect(npmHistoryStart("2026-11-09")).toBe("2025-05-10");
  });

  test("lands on a month's last day when the same day-of-month does not exist eighteen months back", () => {
    expect(npmHistoryStart("2027-08-31")).toBe("2026-03-01");
    expect(npmHistoryStart("2026-08-30")).toBe("2025-03-01");
  });
});

describe("downloadWindowFor", () => {
  test("a known package fetches only the three days ending the day before the run", () => {
    expect(downloadWindowFor({ day: "2026-11-09", today: "2026-11-09", ...known })).toEqual({
      start: "2026-11-06",
      end: "2026-11-08",
      history: false,
    });
  });

  test("a package not yet collected in full fetches from its registry creation day up to the day before the run", () => {
    expect(downloadWindowFor({ day: "2026-11-09", today: "2026-11-09", ...fresh })).toEqual({
      start: "2026-09-05",
      end: "2026-11-08",
      history: true,
    });
  });

  test("a creation day older than npm's history is clamped to the first day npm still serves", () => {
    const window = downloadWindowFor({
      day: "2026-11-09",
      today: "2026-11-09",
      pending: true,
      createdOn: "2019-01-01",
      ...counted,
    });
    expect(window).toEqual({ start: "2025-05-10", end: "2026-11-08", history: true });
    expect(dayRanges(window.start, window.end, MAX_RANGE_DAYS)).toEqual([
      { start: "2025-05-10", end: "2026-05-09" },
      { start: "2026-05-10", end: "2026-11-08" },
    ]);
  });

  test("a pending package whose creation day is unknown keeps the three-day window and stays pending", () => {
    expect(
      downloadWindowFor({ day: "2026-11-09", today: "2026-11-09", pending: true, createdOn: null, ...counted }),
    ).toEqual({
      start: "2026-11-06",
      end: "2026-11-08",
      history: false,
    });
  });

  test("a package created within the three-day window still counts as collected in full", () => {
    expect(
      downloadWindowFor({ day: "2026-11-09", today: "2026-11-09", pending: true, createdOn: "2026-11-08", ...counted }),
    ).toEqual({ start: "2026-11-06", end: "2026-11-08", history: true });
    expect(
      downloadWindowFor({ day: "2026-11-09", today: "2026-11-09", pending: true, createdOn: "2026-11-09", ...counted }),
    ).toEqual({ start: "2026-11-06", end: "2026-11-08", history: true });
  });

  test("a run for an earlier date reaches the day before the day it runs on for a pending package, so no day is skipped", () => {
    expect(downloadWindowFor({ day: "2026-11-05", today: "2026-11-09", ...fresh })).toEqual({
      start: "2026-09-05",
      end: "2026-11-08",
      history: true,
    });
    expect(downloadWindowFor({ day: "2026-11-05", today: "2026-11-09", ...known })).toEqual({
      start: "2026-11-02",
      end: "2026-11-04",
      history: false,
    });
  });

  test("a backfill reaches back to its start for every package, and further for a pending one created earlier", () => {
    expect(downloadWindowFor({ day: "2026-11-09", today: "2026-11-09", backfillFrom: "2026-09-05", ...known })).toEqual(
      { start: "2026-09-05", end: "2026-11-08", history: false },
    );
    expect(
      downloadWindowFor({
        day: "2026-11-09",
        today: "2026-11-09",
        backfillFrom: "2026-09-05",
        pending: true,
        createdOn: "2026-01-02",
        ...counted,
      }),
    ).toEqual({ start: "2026-01-02", end: "2026-11-08", history: true });
  });

  test("a run before npm has counted yesterday ends every window at npm's last complete day, keeping three days for a known package", () => {
    const lagging = { completeThrough: "2026-11-07" } as const;
    expect(
      downloadWindowFor({ day: "2026-11-09", today: "2026-11-09", pending: false, createdOn: null, ...lagging }),
    ).toEqual({ start: "2026-11-05", end: "2026-11-07", history: false });
    expect(
      downloadWindowFor({ day: "2026-11-09", today: "2026-11-09", pending: true, createdOn: "2026-09-05", ...lagging }),
    ).toEqual({ start: "2026-09-05", end: "2026-11-07", history: true });
    expect(
      downloadWindowFor({
        day: "2026-11-09",
        today: "2026-11-09",
        backfillFrom: "2026-09-05",
        pending: false,
        createdOn: null,
        ...lagging,
      }),
    ).toEqual({ start: "2026-09-05", end: "2026-11-07", history: false });
  });

  test("npm's last complete day never widens a window: a run for an earlier date keeps its own end", () => {
    expect(downloadWindowFor({ day: "2026-11-05", today: "2026-11-09", ...known })).toEqual({
      start: "2026-11-02",
      end: "2026-11-04",
      history: false,
    });
    expect(
      downloadWindowFor({
        day: "2026-11-09",
        today: "2026-11-09",
        pending: false,
        createdOn: null,
        completeThrough: "2026-11-20",
      }),
    ).toEqual({ start: "2026-11-06", end: "2026-11-08", history: false });
  });

  test("a package created after npm's last complete day is still collected in full by the capped window", () => {
    expect(
      downloadWindowFor({
        day: "2026-11-09",
        today: "2026-11-09",
        pending: true,
        createdOn: "2026-11-08",
        completeThrough: "2026-11-07",
      }),
    ).toEqual({ start: "2026-11-05", end: "2026-11-07", history: true });
  });

  test("a known package whose newest stored day is older than the usual window catches up from the day after it", () => {
    expect(downloadWindowFor({ day: "2026-11-09", today: "2026-11-09", newestDay: "2026-11-01", ...known })).toEqual({
      start: "2026-11-02",
      end: "2026-11-08",
      history: false,
    });
  });

  test("catching up stays within the days npm still serves, and never reaches past its last complete day", () => {
    expect(
      downloadWindowFor({
        day: "2026-11-09",
        today: "2026-11-09",
        newestDay: "2024-01-01",
        pending: false,
        createdOn: "2019-01-01",
        completeThrough: "2026-11-07",
      }),
    ).toEqual({ start: "2025-05-10", end: "2026-11-07", history: false });
  });

  test("a newest stored day inside the usual window changes nothing", () => {
    for (const newestDay of ["2026-11-06", "2026-11-08", "2026-11-09"]) {
      expect(downloadWindowFor({ day: "2026-11-09", today: "2026-11-09", newestDay, ...known })).toEqual({
        start: "2026-11-06",
        end: "2026-11-08",
        history: false,
      });
    }
  });

  test("its answer is a DownloadWindow", () => {
    expect(DownloadWindow.parse(downloadWindowFor({ day: "2026-11-09", today: "2026-11-09", ...fresh }))).toEqual({
      start: "2026-09-05",
      end: "2026-11-08",
      history: true,
    });
  });
});
