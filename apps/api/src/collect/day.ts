import { z } from "zod";

/** A UTC calendar day. Every date the collector keys on is one of these, never a local date. */
export const Day = z.iso.date().describe("A UTC calendar day, `YYYY-MM-DD`.");
export type Day = z.output<typeof Day>;

/** An inclusive span of days. */
export const DayRange = z
  .object({
    start: Day.describe("The first day of the span, inclusive."),
    end: Day.describe("The last day of the span, inclusive."),
  })
  .describe("An inclusive span of UTC days.");
export type DayRange = z.output<typeof DayRange>;

/** How many trailing days each run re-fetches and overwrites, so a late-settling count corrects itself. */
export const OVERWRITE_DAYS = 3;

const MS_PER_DAY = 86_400_000;

/** The UTC day an instant falls on. */
export function utcDay(at: Date): Day {
  return at.toISOString().slice(0, 10);
}

/** The day `days` after `day`; negative goes back. */
export function addDays(day: Day, days: number): Day {
  return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * MS_PER_DAY));
}

/**
 * The daily downloads a run on `runDay` fetches: the {@link OVERWRITE_DAYS} days ending the day before it,
 * since npm has no count for a day that has not finished. `from` reaches further back for a backfill and
 * never shortens the window.
 */
export function downloadWindow(runDay: Day, from?: Day): DayRange {
  const end = addDays(runDay, -1);
  const overwrite = addDays(runDay, -OVERWRITE_DAYS);
  return { start: from !== undefined && from < overwrite ? from : overwrite, end };
}

/** `start..end` cut into consecutive inclusive ranges of at most `maxDays` days each. */
export function dayRanges(start: Day, end: Day, maxDays: number): DayRange[] {
  const ranges: DayRange[] = [];
  let cursor = start;
  while (cursor <= end) {
    const last = addDays(cursor, maxDays - 1);
    const rangeEnd = last < end ? last : end;
    ranges.push({ start: cursor, end: rangeEnd });
    cursor = addDays(rangeEnd, 1);
  }
  return ranges;
}
