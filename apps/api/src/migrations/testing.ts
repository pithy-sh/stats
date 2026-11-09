import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import type { MigrationProvider } from "kysely/migration";
import { APP_MIGRATION_ORDER, RETAINED_TABLES } from "../data/tables";
import { STATS_MIGRATIONS } from "./index";

/** This app's migrations as one registry over the test D1, the way the runner composes them in production. */
export function statsMigrationProvider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "api",
      order: APP_MIGRATION_ORDER,
      migrations: STATS_MIGRATIONS,
      retained: RETAINED_TABLES,
    },
  ]);
  const provider = registry.app;
  if (provider === undefined) throw new Error("The app database has no migrations.");
  return provider;
}
