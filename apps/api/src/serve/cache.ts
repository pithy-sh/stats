import { MS_PER_DAY, nextReadyTime, type Schedule } from "../schedule";

/**
 * How long a copy of the JSON may be kept, given the collector's {@link Schedule}: when a run starts, read off its
 * cron, and when its files are taken to be ready, `READY_AFTER_MINUTES` after that. A copy of a current file expires
 * at the next ready time, whenever it was fetched. When a ready time has passed and the current file was uploaded
 * before the run it belongs to started, the run is late, and a copy is kept only a few minutes so the new file is
 * picked up soon after it lands. A dated snapshot is rewritten by any later run on its own day, so until its day is
 * over a copy expires at the next ready time or at midnight UTC, whichever comes first, and is never served stale: no
 * copy taken during the day outlives it, so the first immutable answer is always a fresh read. From then on the
 * snapshot never changes and is kept for a year. A 404 is kept as briefly as a late file, since a late run may still
 * publish the file it names.
 */

/** How long past expiry a cache may serve a copy while it fetches the next one. */
export const STALE_WHILE_REVALIDATE_SECONDS = 3600;

/** `max-age` for a current file while today's run is late: long enough to absorb traffic, short enough to catch up. */
export const LATE_MAX_AGE_SECONDS = 300;

/** `Cache-Control` for a dated snapshot whose day is over. */
export const SNAPSHOT_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** `Cache-Control` for a 404: no file is published at that path yet. */
export const NOT_FOUND_CACHE_CONTROL = `public, max-age=${LATE_MAX_AGE_SECONDS}`;

/** Whole seconds from `now` to the next ready time, rounded up; at a ready time exactly, the one a day later. */
export function secondsUntilNextFile(now: Date, schedule: Schedule): number {
  return Math.ceil((nextReadyTime(now, schedule).getTime() - now.getTime()) / 1000);
}

/** Whole seconds from `now` to the next midnight UTC, rounded up; at midnight exactly, a whole day. */
export function secondsUntilEndOfDay(now: Date): number {
  return Math.ceil((MS_PER_DAY - (now.getTime() % MS_PER_DAY)) / 1000);
}

/**
 * Whether, at `now`, a current file uploaded at `uploaded` should have been replaced already: the latest ready time
 * at or before `now` has passed, and the file was uploaded before the run that ready time belongs to started.
 */
export function isLate(now: Date, uploaded: Date, schedule: Schedule): boolean {
  const lastReady = nextReadyTime(now, schedule).getTime() - MS_PER_DAY;
  return uploaded.getTime() < lastReady - schedule.readyAfterMs;
}

/**
 * `Cache-Control` for a current file fetched at `now`. Given when the file was uploaded, a file the latest run has
 * not replaced by its ready time is kept for {@link LATE_MAX_AGE_SECONDS} instead.
 */
export function currentCacheControl(now: Date, schedule: Schedule, uploaded?: Date): string {
  const maxAge =
    uploaded !== undefined && isLate(now, uploaded, schedule)
      ? LATE_MAX_AGE_SECONDS
      : secondsUntilNextFile(now, schedule);
  return `public, max-age=${maxAge}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`;
}

/**
 * `Cache-Control` for the snapshot of `day`, a UTC `YYYY-MM-DD`, fetched at `now`. Immutable once `day` is over;
 * until then a run on that day may still rewrite it, so it expires at the next ready time or at the end of the day,
 * whichever is sooner, with no stale window that could run past midnight.
 */
export function snapshotCacheControl(day: string, now: Date, schedule: Schedule): string {
  if (day < now.toISOString().slice(0, 10)) return SNAPSHOT_CACHE_CONTROL;
  return `public, max-age=${Math.min(secondsUntilNextFile(now, schedule), secondsUntilEndOfDay(now))}`;
}
