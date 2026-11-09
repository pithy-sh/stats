import { addDays, type Day, utcDay } from "../day";

/**
 * The arithmetic the publish step builds its figures with: medians, weekly and daily series, window sums and
 * per-version windows. Pure, so each is tested on its own.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

/** The median of `values`, rounded to a whole number, or null over none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return Math.round(value);
}

/** The mean of `values`, rounded to a whole number, or null over none. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

/** Whole minutes from `from` to `to`, rounded. */
export function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_MINUTE);
}

/** The Monday that starts the UTC week holding `at`. */
export function mondayOf(at: Date): Day {
  const day = utcDay(at);
  const sinceMonday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -sinceMonday);
}

/** Which week, counting from the one starting `weekStart`, holds `at`. */
function weekIndex(weekStart: Day, at: Date): number {
  return Math.floor((at.getTime() - Date.parse(`${weekStart}T00:00:00Z`)) / MS_PER_WEEK);
}

/** How many weeks run from the one starting `weekStart` to the one holding `now`, both included. */
export function weekCount(weekStart: Day, now: Date): number {
  return Math.max(0, weekIndex(weekStart, now) + 1);
}

/** One count per week from `weekStart` to the week holding `now`: how many of `instants` fall in each. */
export function weeklySeries(weekStart: Day, now: Date, instants: readonly (Date | null)[]): number[] {
  const series = new Array<number>(weekCount(weekStart, now)).fill(0);
  for (const at of instants) {
    if (at === null) continue;
    const index = weekIndex(weekStart, at);
    if (index >= 0 && index < series.length) series[index] = (series[index] ?? 0) + 1;
  }
  return series;
}

/** One count per day from `start` to `end` inclusive, summing `rows` by day; zero on a day none holds. */
export function dailySeries(start: Day, end: Day, rows: readonly { day: Day; downloads: number }[]): number[] {
  const length = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / MS_PER_DAY) + 1;
  const series = new Array<number>(Math.max(0, length)).fill(0);
  const origin = Date.parse(`${start}T00:00:00Z`);
  for (const row of rows) {
    const index = Math.round((Date.parse(`${row.day}T00:00:00Z`) - origin) / MS_PER_DAY);
    if (index >= 0 && index < series.length) series[index] = (series[index] ?? 0) + row.downloads;
  }
  return series;
}

/** The sum of the `days` entries of `series` that end `back` entries before its last. */
export function windowSum(series: readonly number[], days: number, back: number): number {
  const end = series.length - back;
  return series.slice(Math.max(0, end - days), Math.max(0, end)).reduce((total, value) => total + value, 0);
}

/** One version's seven-day count as captured on one day. */
export interface VersionCapture {
  version: string;
  capturedOn: Day;
  downloads: number;
}

/** npm's per-version counts over one seven-day window. */
export interface VersionWindow {
  start: Day;
  end: Day;
  counts: Record<string, number>;
}

/**
 * npm's per-version counts as non-overlapping seven-day windows, newest last. A capture on day C covers the seven
 * days ending the day before it. Starting from the newest capture, each earlier capture is kept only when its
 * window ends before the last kept one starts.
 */
export function versionWindows(rows: readonly VersionCapture[]): VersionWindow[] {
  const byDay = new Map<Day, Record<string, number>>();
  for (const row of rows) {
    const counts = byDay.get(row.capturedOn) ?? {};
    counts[row.version] = row.downloads;
    byDay.set(row.capturedOn, counts);
  }
  const windows: VersionWindow[] = [];
  let earliestStart: Day | null = null;
  for (const day of [...byDay.keys()].sort().reverse()) {
    const end = addDays(day, -1);
    if (earliestStart !== null && end >= earliestStart) continue;
    const start = addDays(day, -7);
    windows.push({ start, end, counts: byDay.get(day) ?? {} });
    earliestStart = start;
  }
  return windows.reverse();
}
