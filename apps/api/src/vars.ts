import { defineVars } from "@pithy-sh/core/src/worker/vars";
import { z } from "zod";

/** Minutes after a run starts that its files are taken to be ready, when `READY_AFTER_MINUTES` is unset or invalid. */
export const DEFAULT_READY_AFTER_MINUTES = 15;

const MINUTES_PER_DAY = 1440;

/**
 * This Worker's own vars. `pithy worker sync` writes each into the top level and every `env.<name>` of wrangler.jsonc,
 * and the Worker reads them with `VARS.read(env)`, which hands back the default for one missing or invalid. A number set
 * as text is taken only as a plain decimal, so `READY_AFTER_MINUTES` reads `"15"` and `"15.0"` as 15 and falls back on
 * `" 15"`, `"1e1"`, `"0x10"` or `""`.
 */
export const VARS = defineVars({
  READY_AFTER_MINUTES: {
    description:
      "Whole minutes after the collector's cron starts a run that its files are taken to be ready; the cache and nextUpdate are dated by it.",
    schema: z
      .number()
      .int()
      .min(0)
      .lt(MINUTES_PER_DAY)
      .describe("Whole minutes from a run's start to the time its files are taken to be ready, under a day."),
    default: DEFAULT_READY_AFTER_MINUTES,
    environments: { staging: DEFAULT_READY_AFTER_MINUTES, prod: DEFAULT_READY_AFTER_MINUTES },
  },
});
