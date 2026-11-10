import { z } from "zod";
import { addDays, type Day, DayRange, downloadWindow, utcDay } from "./day";
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
 * ending the day before `day`, or from `backfillFrom` in a backfill. A pending package whose creation day is known
 * also reaches back to that day, clamped to {@link npmHistoryStart}, and forward to the day before `today`, so the
 * step that writes it leaves no day uncollected; `history` says so. A pending package with no creation day keeps
 * the usual window and stays pending.
 */
export function downloadWindowFor(input: PackageWindowInput): DownloadWindow {
  const usual = downloadWindow(input.day, input.backfillFrom);
  if (!input.pending || input.createdOn === null) return { ...usual, history: false };
  const floor = npmHistoryStart(input.today);
  const from = input.createdOn < floor ? floor : input.createdOn;
  const through = addDays(input.today, -1);
  return {
    start: from < usual.start ? from : usual.start,
    end: through > usual.end ? through : usual.end,
    history: true,
  };
}
