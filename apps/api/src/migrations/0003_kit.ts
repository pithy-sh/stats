import type { Kysely } from "kysely";

/** The kit's own counts: one row per repository per capture day, with the commit they were counted at. */
export const api_0003_kit = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("kitCounts")
      .addColumn("repo", "text", (c) => c.notNull())
      .addColumn("capturedOn", "text", (c) => c.notNull())
      .addColumn("commit", "text", (c) => c.notNull())
      .addColumn("tests", "integer", (c) => c.notNull())
      .addColumn("codeLines", "integer", (c) => c.notNull())
      .addColumn("countedAt", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint("kitCountsPk", ["repo", "capturedOn"])
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable("kitCounts").ifExists().execute();
  },
};
