import type { Kysely } from "kysely";

/**
 * Which days npm's downloads API had counted, one row per capture day: the newest day it had finished, and the window
 * its `last-week` counts covered. The per-version counts captured that day are dated by that window, which stays null
 * until a run confirms every one of them covers it.
 */
export const api_0005_npm_days = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("npmDays")
      .addColumn("capturedOn", "text", (c) => c.notNull().primaryKey())
      .addColumn("lastDay", "text", (c) => c.notNull())
      .addColumn("weekStart", "text")
      .addColumn("weekEnd", "text")
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable("npmDays").ifExists().execute();
  },
};
