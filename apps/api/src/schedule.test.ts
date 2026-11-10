import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { describe, expect, test, vi } from "vitest";
import {
  COLLECT_CRON,
  dailyRunStart,
  lastRunStart,
  nextReadyTime,
  nextUpdateAfter,
  READY_RULE,
  type Schedule,
  scheduleReader,
} from "./schedule";
import { DEFAULT_READY_AFTER_MINUTES } from "./vars";

const at = (iso: string) => new Date(iso);
const MINUTE = 60_000;

/** A logger that records each warning's message and fields. */
function recordingLogger(): { log: Logger; warnings: unknown[][] } {
  const warnings: unknown[][] = [];
  const log: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message, fields) => {
      warnings.push([message, fields]);
    },
    error: () => {},
    child: () => log,
  };
  return { log, warnings };
}

/** The collector's own schedule: 02:00 UTC, ready 15 minutes after. */
const DEFAULT: Schedule = { runStartMs: 2 * 60 * MINUTE, readyAfterMs: 15 * MINUTE };

describe("COLLECT_CRON", () => {
  test("is a daily `M H * * *` schedule, which is the only shape the cache can derive a run start from", () => {
    expect(() => dailyRunStart(COLLECT_CRON)).not.toThrow();
  });
});

describe("READY_RULE", () => {
  test("names the default delay and the cron's run start in words", () => {
    expect(READY_RULE).toBe("15 minutes after the 02:00 UTC run starts, by default");
  });
});

describe("dailyRunStart", () => {
  test("is the cron's minute and hour as milliseconds after midnight UTC", () => {
    expect(dailyRunStart("0 2 * * *")).toBe(2 * 60 * MINUTE);
    expect(dailyRunStart("30 23 * * *")).toBe((23 * 60 + 30) * MINUTE);
    expect(dailyRunStart("0 0 * * *")).toBe(0);
    expect(dailyRunStart("59 23 * * *")).toBe((23 * 60 + 59) * MINUTE);
    expect(dailyRunStart("05 02 * * *")).toBe((2 * 60 + 5) * MINUTE);
  });

  for (const cron of [
    "*/5 * * * *",
    "0 * * * *",
    "0 2 * * 1",
    "0 2 1 * *",
    "0 2 * 1 *",
    "0 2,14 * * *",
    "0 2-4 * * *",
    "60 2 * * *",
    "0 24 * * *",
    "-1 2 * * *",
    "0 2 * *",
    "0 2 * * * *",
    "@daily",
    "",
  ]) {
    test(`refuses ${JSON.stringify(cron)}, which is not one run a day at a fixed UTC time`, () => {
      expect(() => dailyRunStart(cron)).toThrow(/daily/);
    });
  }
});

describe("scheduleReader", () => {
  test("defaults to 15 minutes after the cron's run start, logging that the var is unset", () => {
    const { log, warnings } = recordingLogger();
    expect(DEFAULT_READY_AFTER_MINUTES).toBe(15);
    expect(scheduleReader()({}, log)).toEqual(DEFAULT);
    expect(warnings).toHaveLength(1);
  });

  test("takes READY_AFTER_MINUTES from the env when it is valid, as text or as wrangler.jsonc holds it, without logging", () => {
    const { log, warnings } = recordingLogger();
    expect(scheduleReader()({ READY_AFTER_MINUTES: "30" }, log)).toEqual({
      runStartMs: 2 * 60 * MINUTE,
      readyAfterMs: 30 * MINUTE,
    });
    expect(scheduleReader()({ READY_AFTER_MINUTES: 45 }, log)).toEqual({
      runStartMs: 2 * 60 * MINUTE,
      readyAfterMs: 45 * MINUTE,
    });
    expect(warnings).toHaveLength(0);
  });

  test("takes any JSON spelling of a valid number, surrounding whitespace included, without logging", () => {
    const { log, warnings } = recordingLogger();
    const read = scheduleReader();
    expect(read({ READY_AFTER_MINUTES: " 15" }, log).readyAfterMs).toBe(15 * MINUTE);
    expect(read({ READY_AFTER_MINUTES: "15 " }, log).readyAfterMs).toBe(15 * MINUTE);
    expect(read({ READY_AFTER_MINUTES: "1e1" }, log).readyAfterMs).toBe(10 * MINUTE);
    expect(read({ READY_AFTER_MINUTES: "15.0" }, log).readyAfterMs).toBe(15 * MINUTE);
    expect(warnings).toHaveLength(0);
  });

  for (const raw of ["abc", "1.5", "15m", "-5", "1440", "1e4"]) {
    test(`falls back to the default for ${JSON.stringify(raw)}, naming the value it ignored`, () => {
      const { log, warnings } = recordingLogger();
      expect(scheduleReader()({ READY_AFTER_MINUTES: raw }, log)).toEqual(DEFAULT);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.[1]).toMatchObject({ value: raw, fallback: 15 });
    });
  }

  test("logs an invalid value once, however many times it is read", () => {
    const { log, warnings } = recordingLogger();
    const read = scheduleReader();
    for (let i = 0; i < 5; i += 1) read({ READY_AFTER_MINUTES: "nope" }, log);
    read({}, log);
    read({}, log);
    expect(warnings).toHaveLength(2);
  });

  test("never throws, whatever the env holds", () => {
    const warn = vi.fn();
    const log = { ...recordingLogger().log, warn };
    expect(() => scheduleReader()({ READY_AFTER_MINUTES: Symbol("x") as unknown as string }, log)).not.toThrow();
  });
});

describe("lastRunStart", () => {
  test("is today's run start from it onwards, and yesterday's before it", () => {
    expect(lastRunStart(at("2026-11-09T02:00:00Z"), DEFAULT).toISOString()).toBe("2026-11-09T02:00:00.000Z");
    expect(lastRunStart(at("2026-11-09T12:00:00Z"), DEFAULT).toISOString()).toBe("2026-11-09T02:00:00.000Z");
    expect(lastRunStart(at("2026-11-09T01:59:59Z"), DEFAULT).toISOString()).toBe("2026-11-08T02:00:00.000Z");
    expect(lastRunStart(at("2026-01-01T00:00:00Z"), DEFAULT).toISOString()).toBe("2025-12-31T02:00:00.000Z");
  });
});

describe("nextReadyTime", () => {
  test("is the next run start plus the ready delay, strictly after now", () => {
    expect(nextReadyTime(at("2026-11-09T01:00:00Z"), DEFAULT).toISOString()).toBe("2026-11-09T02:15:00.000Z");
    expect(nextReadyTime(at("2026-11-09T02:10:00Z"), DEFAULT).toISOString()).toBe("2026-11-09T02:15:00.000Z");
    expect(nextReadyTime(at("2026-11-09T02:15:00Z"), DEFAULT).toISOString()).toBe("2026-11-10T02:15:00.000Z");
    expect(nextReadyTime(at("2026-12-31T23:00:00Z"), DEFAULT).toISOString()).toBe("2027-01-01T02:15:00.000Z");
  });

  test("crosses midnight when the ready time falls on the next day", () => {
    const late: Schedule = { runStartMs: (23 * 60 + 50) * MINUTE, readyAfterMs: 15 * MINUTE };
    expect(nextReadyTime(at("2026-11-09T23:55:00Z"), late).toISOString()).toBe("2026-11-10T00:05:00.000Z");
    expect(nextReadyTime(at("2026-11-10T00:05:00Z"), late).toISOString()).toBe("2026-11-11T00:05:00.000Z");
    expect(nextReadyTime(at("2026-11-09T12:00:00Z"), late).toISOString()).toBe("2026-11-10T00:05:00.000Z");
  });
});

describe("nextUpdateAfter", () => {
  test("is the ready time of the next run to start after the file was generated", () => {
    // Published by today's run before its ready time: the next file is tomorrow's.
    expect(nextUpdateAfter(at("2026-11-09T02:12:00Z"), DEFAULT).toISOString()).toBe("2026-11-10T02:15:00.000Z");
    // A late run, or a manual one during the day.
    expect(nextUpdateAfter(at("2026-11-09T02:40:00Z"), DEFAULT).toISOString()).toBe("2026-11-10T02:15:00.000Z");
    expect(nextUpdateAfter(at("2026-11-09T14:00:00Z"), DEFAULT).toISOString()).toBe("2026-11-10T02:15:00.000Z");
    // A manual run before today's cron: today's run is next.
    expect(nextUpdateAfter(at("2026-11-09T01:00:00Z"), DEFAULT).toISOString()).toBe("2026-11-09T02:15:00.000Z");
  });

  test("a publish at the run start's own instant waits for the next day's run", () => {
    expect(nextUpdateAfter(at("2026-11-09T02:00:00Z"), DEFAULT).toISOString()).toBe("2026-11-10T02:15:00.000Z");
  });

  test("is always after the time it is counted from", () => {
    for (const iso of ["2026-11-09T00:00:00Z", "2026-11-09T02:14:59.999Z", "2026-11-09T23:59:59.999Z"]) {
      expect(nextUpdateAfter(at(iso), DEFAULT).getTime()).toBeGreaterThan(at(iso).getTime());
    }
  });
});
