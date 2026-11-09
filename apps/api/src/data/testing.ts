import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { statsMigrationProvider } from "../migrations/testing";

/** Drop every table in `d1`, then migrate it to the latest schema: an empty, current database for one test. */
export async function freshDatabase(d1: D1Database): Promise<void> {
  const { results } = await d1
    .prepare(
      "select name from sqlite_master where type = 'table' and name not like '\\_cf%' escape '\\' and name <> 'sqlite_sequence'",
    )
    .all<{ name: string }>();
  for (const { name } of results) await d1.prepare(`drop table if exists "${name}"`).run();
  await runMigrations(d1, statsMigrationProvider());
}
