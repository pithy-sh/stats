import type { Kysely } from "kysely";

/**
 * When each package's whole download history was collected. Every row starts null, those already recorded included,
 * so the next run fetches each package's whole history once and fills any day missing from before it was first seen.
 */
export const api_0004_history = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable("packages").addColumn("historyCollectedOn", "text").execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable("packages").dropColumn("historyCollectedOn").execute();
  },
};
