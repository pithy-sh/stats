import type { Migration } from "kysely/migration";
import { api_0001_init } from "./0001_init";
import { api_0002_publish } from "./0002_publish";

/** Every migration of the app database, keyed by its permanent local key. Append-only. */
export const STATS_MIGRATIONS: Record<string, Migration> = {
  "0001_init": api_0001_init,
  "0002_publish": api_0002_publish,
};
