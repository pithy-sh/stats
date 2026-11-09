/**
 * How long a copy of the JSON may be kept. The collector starts at 02:00 UTC and the next files are written within
 * minutes, so a copy of a current file expires at the next 02:05 UTC, whenever it was fetched. When 02:05 has passed
 * and the current file is still yesterday's, the run is late, and a copy is kept only a few minutes so today's file
 * is picked up soon after it lands. A dated snapshot is rewritten by any later run on its own day, so until its day
 * is over a copy expires at the next 02:05 or at midnight UTC, whichever comes first, and is never served stale: no
 * copy taken during the day outlives it, so the first immutable answer is always a fresh read. From then on the
 * snapshot never changes and is kept for a year. A 404 is kept as briefly as a late file, since a late run may still
 * publish the file it names.
 */

/** The UTC time of day a run starts at: 02:00. A current file uploaded before it today is yesterday's. */
const RUN_START_MS = 2 * 60 * 60_000;
/** The UTC time of day the next files are taken to be ready by: 02:05. */
const NEXT_FILE_MS = (2 * 60 + 5) * 60_000;
const MS_PER_DAY = 86_400_000;

/** How long past expiry a cache may serve a copy while it fetches the next one. */
export const STALE_WHILE_REVALIDATE_SECONDS = 3600;

/** `max-age` for a current file while today's run is late: long enough to absorb traffic, short enough to catch up. */
export const LATE_MAX_AGE_SECONDS = 300;

/** `Cache-Control` for a dated snapshot whose day is over. */
export const SNAPSHOT_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** `Cache-Control` for a 404: no file is published at that path yet. */
export const NOT_FOUND_CACHE_CONTROL = `public, max-age=${LATE_MAX_AGE_SECONDS}`;

/** Whole seconds from `now` to the next 02:05 UTC, rounded up; at 02:05 exactly, the one a day later. */
export function secondsUntilNextFile(now: Date): number {
  const sinceMidnight = now.getTime() % MS_PER_DAY;
  const untilNext =
    sinceMidnight < NEXT_FILE_MS ? NEXT_FILE_MS - sinceMidnight : MS_PER_DAY - sinceMidnight + NEXT_FILE_MS;
  return Math.ceil(untilNext / 1000);
}

/** Whole seconds from `now` to the next midnight UTC, rounded up; at midnight exactly, a whole day. */
export function secondsUntilEndOfDay(now: Date): number {
  return Math.ceil((MS_PER_DAY - (now.getTime() % MS_PER_DAY)) / 1000);
}

/** Whether, at `now`, a current file uploaded at `uploaded` should have been replaced by today's run already. */
export function isLate(now: Date, uploaded: Date): boolean {
  const midnight = now.getTime() - (now.getTime() % MS_PER_DAY);
  return now.getTime() >= midnight + NEXT_FILE_MS && uploaded.getTime() < midnight + RUN_START_MS;
}

/**
 * `Cache-Control` for a current file fetched at `now`. Given when the file was uploaded, a file that today's run
 * has not replaced yet is kept for {@link LATE_MAX_AGE_SECONDS} instead.
 */
export function currentCacheControl(now: Date, uploaded?: Date): string {
  const maxAge = uploaded !== undefined && isLate(now, uploaded) ? LATE_MAX_AGE_SECONDS : secondsUntilNextFile(now);
  return `public, max-age=${maxAge}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`;
}

/**
 * `Cache-Control` for the snapshot of `day`, a UTC `YYYY-MM-DD`, fetched at `now`. Immutable once `day` is over;
 * until then a run on that day may still rewrite it, so it expires at the next 02:05 or at the end of the day,
 * whichever is sooner, with no stale window that could run past midnight.
 */
export function snapshotCacheControl(day: string, now: Date): string {
  if (day < now.toISOString().slice(0, 10)) return SNAPSHOT_CACHE_CONTROL;
  return `public, max-age=${Math.min(secondsUntilNextFile(now), secondsUntilEndOfDay(now))}`;
}
