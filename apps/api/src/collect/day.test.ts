import { describe, expect, test } from "vitest";
import { addDays, Day, dayRanges, downloadWindow, utcDay } from "./day";

describe("utcDay", () => {
  test("is the UTC calendar day, whatever the local offset of the instant", () => {
    expect(utcDay(new Date("2026-11-09T00:30:00+02:00"))).toBe("2026-11-08");
    expect(utcDay(new Date("2026-11-09T23:59:59Z"))).toBe("2026-11-09");
  });
});

describe("addDays", () => {
  test("crosses month and year boundaries", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2026-11-09", 0)).toBe("2026-11-09");
  });
});

describe("Day", () => {
  test("accepts a calendar day and refuses anything else", () => {
    expect(Day.safeParse("2026-09-05").success).toBe(true);
    expect(Day.safeParse("2026-9-5").success).toBe(false);
    expect(Day.safeParse("2026-02-30").success).toBe(false);
    expect(Day.safeParse("2026-11-09T00:00:00Z").success).toBe(false);
  });
});

describe("downloadWindow", () => {
  test("is the three days before the run day, ending yesterday", () => {
    expect(downloadWindow("2026-11-09")).toEqual({ start: "2026-11-06", end: "2026-11-08" });
  });

  test("starts at an earlier day when one is given, for a backfill", () => {
    expect(downloadWindow("2026-11-09", "2026-09-05")).toEqual({ start: "2026-09-05", end: "2026-11-08" });
  });

  test("never starts after the three-day window would", () => {
    expect(downloadWindow("2026-11-09", "2026-11-08")).toEqual({ start: "2026-11-06", end: "2026-11-08" });
  });
});

describe("dayRanges", () => {
  test("is one range when the span fits", () => {
    expect(dayRanges("2026-09-05", "2026-11-08", 365)).toEqual([{ start: "2026-09-05", end: "2026-11-08" }]);
  });

  test("splits a long span into consecutive ranges of at most the limit, inclusive", () => {
    expect(dayRanges("2026-01-01", "2026-01-10", 4)).toEqual([
      { start: "2026-01-01", end: "2026-01-04" },
      { start: "2026-01-05", end: "2026-01-08" },
      { start: "2026-01-09", end: "2026-01-10" },
    ]);
  });

  test("is empty when the span is backwards", () => {
    expect(dayRanges("2026-01-10", "2026-01-09", 4)).toEqual([]);
  });
});
