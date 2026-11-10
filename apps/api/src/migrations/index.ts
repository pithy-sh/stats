import type { Migration } from "kysely/migration";
import { api_0001_init } from "./0001_init";
import { api_0002_publish } from "./0002_publish";
import { api_0003_kit } from "./0003_kit";
import { api_0004_history } from "./0004_history";
import { api_0005_npm_days } from "./0005_npm_days";

/** Every migration of the app database, keyed by its permanent local key. Append-only. */
export const STATS_MIGRATIONS: Record<string, Migration> = {
  "0001_init": api_0001_init,
  "0002_publish": api_0002_publish,
  "0003_kit": api_0003_kit,
  "0004_history": api_0004_history,
  "0005_npm_days": api_0005_npm_days,
};
