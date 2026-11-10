import { z } from "zod";
import { addDays, type Day, DayRange, downloadWindow, OVERWRITE_DAYS, utcDay } from "./day";
import { NPM_HISTORY_MONTHS } from "./upstream/npm";

export const DownloadWindow = DayRange.extend({
  history: z
    .boolean()
    .describe(
      "The window reaches back to the package's registry creation day (or npm's earliest), so a step that writes it has collected the package's whole history.",
    ),
}).describe("The daily downloads one package's step fetches on one run.");
export type DownloadWindow = z.output<typeof DownloadWindow>;

/** What one package's window is chosen from. */
export interface PackageWindowInput {
  /** The UTC day the run is for: a known package's three-day window ends the day before it. */
  day: Day;
  /** The UTC day the run fetches on: a pending package's history ends the day before it. */
  today: Day;
  /** Where a backfill starts, for every package. Absent outside a backfill. */
  backfillFrom?: Day;
  /** No step has yet written the package's whole history. */
  pending: boolean;
  /** The UTC day the registry says the package was created, or null when no registry row says. */
  createdOn: Day | null;
  /** The newest day a daily-downloads row is held for, or null when none is. Absent means none. */
  newestDay?: Day | null;
  /** The newest day npm has finished counting, as it answered this run. No window reaches past it. */
  completeThrough: Day;
}

/**
 * The first day npm's downloads API still serves on `today`: the day after the one {@link NPM_HISTORY_MONTHS}
 * calendar months back, or after that month's last day when it is shorter.
 */
export function npmHistoryStart(today: Day): Day {
  const [year, month, dayOfMonth] = today.split("-").map(Number) as [number, number, number];
  const monthIndex = month - 1 - NPM_HISTORY_MONTHS;
  const lastOfMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return addDays(utcDay(new Date(Date.UTC(year, monthIndex, Math.min(dayOfMonth, lastOfMonth)))), 1);
}

/**
 * The daily downloads one package's step fetches. A known package gets the run's usual window: the three days
 * ending the day before `day`, or from `backfillFrom` in a backfill, reaching back further to the day after
 * `newestDay` when that is earlier (clamped to {@link npmHistoryStart}), so days an earlier run could not fetch,
 * because npm had not counted them or the run failed, are caught up. A pending package whose creation day is known
 * also reaches back to that day, clamped the same way, and forward to the day before `today`, so the step that writes
 * it leaves no day uncollected; `history` says so. A pending package with no creation day keeps the usual window and
 * stays pending.
 *
 * Every window then ends no later than `completeThrough`, so a day npm has not finished counting is never fetched,
 * and a window cut short that way still starts at least {@link OVERWRITE_DAYS} days before its end.
 */
export function downloadWindowFor(input: PackageWindowInput): DownloadWindow {
  const usual = catchUp(downloadWindow(input.day, input.backfillFrom), input.newestDay ?? null, input.today);
  const wanted =
    !input.pending || input.createdOn === null
      ? { ...usual, history: false }
      : {
          start: earlier(clampToNpm(input.createdOn, input.today), usual.start),
          end: later(addDays(input.today, -1), usual.end),
          history: true,
        };
  const end = earlier(wanted.end, input.completeThrough);
  return { start: earlier(wanted.start, addDays(end, 1 - OVERWRITE_DAYS)), end, history: wanted.history };
}

/** `window`, starting no later than the day after `newestDay`, and no earlier than npm still serves on `today`. */
function catchUp(window: DayRange, newestDay: Day | null, today: Day): DayRange {
  if (newestDay === null) return window;
  return { start: earlier(window.start, clampToNpm(addDays(newestDay, 1), today)), end: window.end };
}

function earlier(a: Day, b: Day): Day {
  return a < b ? a : b;
}

function later(a: Day, b: Day): Day {
  return a > b ? a : b;
}

/** `day`, or the first day npm still serves on `today` when `day` is older. */
function clampToNpm(day: Day, today: Day): Day {
  return later(day, npmHistoryStart(today));
}
