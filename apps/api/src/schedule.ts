import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { parseVar } from "@pithy-sh/core/src/worker/vars";
import { DEFAULT_READY_AFTER_MINUTES, VARS } from "./vars";

/**
 * The one clock the app keeps: the collector's cron. The time a run starts is read off it, and the time its files
 * are taken to be ready is that start plus `READY_AFTER_MINUTES`, a Worker var declared in `vars.ts`. The cache's expiry and the JSON's
 * `nextUpdate` are both derived from these two, so moving the cron moves everything with it. This module imports
 * nothing from the collector, so the serve path can read it without loading collector code.
 */

/**
 * Every day at 02:00 UTC. npm may still be counting the day before by then, so each run asks npm which day it has
 * last finished instead of assuming it. Only a daily `M H * * *` schedule is supported: {@link dailyRunStart} refuses
 * any other.
 */
export const COLLECT_CRON = "0 2 * * *";

const MS_PER_MINUTE = 60_000;
export const MS_PER_DAY = 86_400_000;

/** When the collector runs and when its files are ready, each in milliseconds. */
export interface Schedule {
  /** The UTC time of day a run starts, in milliseconds after midnight. */
  runStartMs: number;
  /** How long after a run starts its files are taken to be ready, under a day. */
  readyAfterMs: number;
}

/** What the schedule reads off the Worker env. */
export interface ScheduleEnv {
  /**
   * Whole minutes from a run's start to the time its files are taken to be ready, as a number or as text. Text is read
   * as JSON, so `" 15"`, `"15.0"` and `"1e1"` are taken as well as `"15"`.
   */
  READY_AFTER_MINUTES?: unknown;
}

const CRON_FIELD = /^\d{1,2}$/;

/**
 * The UTC time of day `cron` starts a run at, in milliseconds after midnight. Throws unless `cron` is a daily
 * `M H * * *` schedule with a plain minute and hour, the one shape that names a single run start each day.
 */
export function dailyRunStart(cron: string): number {
  const fields = cron.trim().split(/\s+/);
  const [minute, hour, ...rest] = fields;
  const daily =
    fields.length === 5 &&
    minute !== undefined &&
    hour !== undefined &&
    CRON_FIELD.test(minute) &&
    CRON_FIELD.test(hour) &&
    Number(minute) < 60 &&
    Number(hour) < 24 &&
    rest.every((field) => field === "*");
  if (!daily) {
    throw new InternalError({
      message: "The collector's cron is not a daily schedule.",
      action: 'Set COLLECT_CRON in src/schedule.ts to "M H * * *", one run a day at a fixed UTC time.',
      detail: `The collector's cron "${cron}" is not a daily "M H * * *" schedule, so no run start can be read off it.`,
    });
  }
  return (Number(hour) * 60 + Number(minute)) * MS_PER_MINUTE;
}

/** `ms` after midnight as a UTC clock time, `HH:MM`. */
function clockTime(ms: number): string {
  const minutes = Math.floor(ms / MS_PER_MINUTE);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The ready rule in words, read off {@link COLLECT_CRON}, for the API's descriptions. */
export const READY_RULE = `${DEFAULT_READY_AFTER_MINUTES} minutes after the ${clockTime(dailyRunStart(COLLECT_CRON))} UTC run starts, by default`;

/** `raw` as a log field: the value as it was set, or `unset`. */
function describeRaw(raw: unknown): string {
  if (raw === undefined) return "unset";
  if (typeof raw === "string") return raw;
  return typeof raw === "symbol" ? raw.toString() : String(raw);
}

/**
 * A reader of the {@link Schedule} off the Worker env, through {@link VARS}. `READY_AFTER_MINUTES` parses as a number,
 * or as text whose JSON is one, so surrounding whitespace, `15.0` and `1e1` are taken. A value that does not parse
 * falls back to {@link DEFAULT_READY_AFTER_MINUTES} and is logged as a warning the first time this reader sees that
 * value, never again, so a request never fails on it and a busy Worker does not log it on every request.
 */
export function scheduleReader(cron: string = COLLECT_CRON): (env: ScheduleEnv, log: Logger) => Schedule {
  const runStartMs = dailyRunStart(cron);
  const warned = new Set<string>();
  return (env, log) => {
    const raw = env.READY_AFTER_MINUTES;
    if (!parseVar(VARS.vars.READY_AFTER_MINUTES, raw).ok) {
      const value = describeRaw(raw);
      if (!warned.has(value)) {
        warned.add(value);
        log.warn("READY_AFTER_MINUTES is not a whole number of minutes under a day; using the default.", {
          value,
          fallback: DEFAULT_READY_AFTER_MINUTES,
        });
      }
    }
    return { runStartMs, readyAfterMs: VARS.read(env).READY_AFTER_MINUTES * MS_PER_MINUTE };
  };
}

/** The Worker's one schedule reader, so an invalid var is logged once per isolate. */
export const readSchedule = scheduleReader();

/** The latest run start at or before `now`. */
export function lastRunStart(now: Date, schedule: Schedule): Date {
  const midnight = now.getTime() - (now.getTime() % MS_PER_DAY);
  const today = midnight + schedule.runStartMs;
  return new Date(today <= now.getTime() ? today : today - MS_PER_DAY);
}

/** The first ready time strictly after `now`: at a ready time exactly, the one a day later. */
export function nextReadyTime(now: Date, schedule: Schedule): Date {
  const ready = lastRunStart(now, schedule).getTime() + schedule.readyAfterMs;
  return new Date(ready > now.getTime() ? ready : ready + MS_PER_DAY);
}

/**
 * When the file generated at `generatedAt` is next replaced: the ready time of the first run to start after it.
 * A file published by a run before that run's own ready time names the next day's, not its own.
 */
export function nextUpdateAfter(generatedAt: Date, schedule: Schedule): Date {
  return new Date(lastRunStart(generatedAt, schedule).getTime() + MS_PER_DAY + schedule.readyAfterMs);
}
