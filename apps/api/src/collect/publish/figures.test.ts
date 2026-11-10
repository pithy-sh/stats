import { describe, expect, test } from "vitest";
import { addDays } from "../day";
import {
  dailySeries,
  mean,
  median,
  minutesBetween,
  mondayOf,
  versionWindows,
  weekCount,
  weeklySeries,
  windowSum,
} from "./figures";

describe("median and mean", () => {
  test("median is the middle value, rounded to a whole number", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(3);
    expect(median([1, 2])).toBe(2);
  });

  test("mean is rounded to a whole number", () => {
    expect(mean([1, 2])).toBe(2);
    expect(mean([1, 1, 2])).toBe(1);
  });

  test("both are null over nothing", () => {
    expect(median([])).toBeNull();
    expect(mean([])).toBeNull();
  });
});

describe("minutesBetween", () => {
  test("is whole minutes, rounded", () => {
    expect(minutesBetween(new Date("2026-09-05T00:00:00Z"), new Date("2026-09-05T01:30:29Z"))).toBe(90);
  });
});

describe("mondayOf", () => {
  test("is the Monday of a UTC week", () => {
    expect(mondayOf(new Date("2026-11-09T12:00:00Z"))).toBe("2026-11-09");
    expect(mondayOf(new Date("2026-11-15T23:59:59Z"))).toBe("2026-11-09");
    expect(mondayOf(new Date("2026-11-16T00:00:00Z"))).toBe("2026-11-16");
  });
});

describe("weekly series", () => {
  test("counts each instant in its Monday-start week, through the week in progress", () => {
    const at = (iso: string) => new Date(iso);
    expect(weekCount("2026-11-02", at("2026-11-18T10:00:00Z"))).toBe(3);
    expect(
      weeklySeries("2026-11-02", at("2026-11-18T10:00:00Z"), [
        at("2026-11-02T00:00:00Z"),
        at("2026-11-08T23:59:59Z"),
        at("2026-11-17T00:00:00Z"),
        null,
      ]),
    ).toEqual([2, 0, 1]);
  });

  test("leaves out an instant outside the series", () => {
    const at = (iso: string) => new Date(iso);
    expect(weeklySeries("2026-11-02", at("2026-11-03T00:00:00Z"), [at("2026-10-01T00:00:00Z")])).toEqual([0]);
  });
});

describe("dailySeries", () => {
  test("is one count per day of the span, zero where none is held", () => {
    expect(
      dailySeries("2026-11-01", "2026-11-04", [
        { day: "2026-11-02", downloads: 5 },
        { day: "2026-11-04", downloads: 7 },
        { day: "2026-10-31", downloads: 99 },
      ]),
    ).toEqual([0, 5, 0, 7]);
  });

  test("adds counts that share a day", () => {
    expect(
      dailySeries("2026-11-01", "2026-11-01", [
        { day: "2026-11-01", downloads: 5 },
        { day: "2026-11-01", downloads: 2 },
      ]),
    ).toEqual([7]);
  });
});

describe("windowSum", () => {
  test("sums the days of a window ending some days back from the series' end", () => {
    const series = [1, 2, 3, 4, 5];
    expect(windowSum(series, 2, 0)).toBe(9);
    expect(windowSum(series, 2, 2)).toBe(5);
    expect(windowSum(series, 2, 4)).toBe(1);
    expect(windowSum(series, 2, 5)).toBe(0);
  });
});

describe("versionWindows", () => {
  test("keeps one capture per non-overlapping seven days, newest last", () => {
    const rows = [
      { version: "0.1.0", capturedOn: "2026-11-09", downloads: 9 },
      { version: "0.2.0", capturedOn: "2026-11-09", downloads: 90 },
      { version: "0.1.0", capturedOn: "2026-11-08", downloads: 8 },
      { version: "0.1.0", capturedOn: "2026-11-02", downloads: 2 },
      { version: "0.1.0", capturedOn: "2026-11-01", downloads: 1 },
    ];
    const weekEnding = (end: string) => ({ start: addDays(end, -6), end });
    const weeks = new Map([
      ["2026-11-09", weekEnding("2026-11-08")],
      ["2026-11-08", weekEnding("2026-11-07")],
      ["2026-11-02", weekEnding("2026-11-01")],
      ["2026-11-01", weekEnding("2026-10-31")],
    ]);
    expect(versionWindows(rows, weeks)).toEqual([
      { start: "2026-10-26", end: "2026-11-01", counts: { "0.1.0": 2 } },
      { start: "2026-11-02", end: "2026-11-08", counts: { "0.1.0": 9, "0.2.0": 90 } },
    ]);
  });

  test("dates a capture by the week npm said its counts covered, not by the capture day", () => {
    const rows = [
      { version: "0.1.0", capturedOn: "2026-11-10", downloads: 1730 },
      { version: "0.1.0", capturedOn: "2026-11-03", downloads: 900 },
    ];
    const weeks = new Map([
      ["2026-11-10", { start: "2026-11-02", end: "2026-11-08" }],
      ["2026-11-03", { start: "2026-10-26", end: "2026-11-01" }],
    ]);
    expect(versionWindows(rows, weeks)).toEqual([
      { start: "2026-10-26", end: "2026-11-01", counts: { "0.1.0": 900 } },
      { start: "2026-11-02", end: "2026-11-08", counts: { "0.1.0": 1730 } },
    ]);
  });

  test("keeps windows apart by npm's weeks: a capture whose week overlaps a newer one's is dropped", () => {
    const rows = [
      { version: "0.1.0", capturedOn: "2026-11-10", downloads: 10 },
      { version: "0.1.0", capturedOn: "2026-11-09", downloads: 9 },
      { version: "0.1.0", capturedOn: "2026-11-02", downloads: 2 },
    ];
    const weeks = new Map([
      ["2026-11-10", { start: "2026-11-02", end: "2026-11-08" }],
      ["2026-11-09", { start: "2026-11-01", end: "2026-11-07" }],
      ["2026-11-02", { start: "2026-10-25", end: "2026-10-31" }],
    ]);
    expect(versionWindows(rows, weeks)).toEqual([
      { start: "2026-10-25", end: "2026-10-31", counts: { "0.1.0": 2 } },
      { start: "2026-11-02", end: "2026-11-08", counts: { "0.1.0": 10 } },
    ]);
  });

  test("leaves out a capture with no week, and never dates one by its capture day", () => {
    const rows = [
      { version: "0.1.0", capturedOn: "2026-11-10", downloads: 10 },
      { version: "0.1.0", capturedOn: "2026-11-03", downloads: 3 },
    ];
    expect(versionWindows(rows, new Map([["2026-11-03", { start: "2026-10-26", end: "2026-11-01" }]]))).toEqual([
      { start: "2026-10-26", end: "2026-11-01", counts: { "0.1.0": 3 } },
    ]);
    expect(versionWindows(rows, new Map())).toEqual([]);
  });

  test("an undated newer capture does not push out an older dated one", () => {
    const rows = [
      { version: "0.1.0", capturedOn: "2026-11-10", downloads: 10 },
      { version: "0.1.0", capturedOn: "2026-11-09", downloads: 9 },
    ];
    expect(versionWindows(rows, new Map([["2026-11-09", { start: "2026-11-01", end: "2026-11-07" }]]))).toEqual([
      { start: "2026-11-01", end: "2026-11-07", counts: { "0.1.0": 9 } },
    ]);
  });

  test("is empty with nothing held", () => {
    expect(versionWindows([], new Map())).toEqual([]);
  });
});
