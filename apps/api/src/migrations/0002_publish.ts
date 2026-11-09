import type { Kysely } from "kysely";

/**
 * What the publish step needs that the first schema did not hold: npm's description per package, the
 * repository's creation time, every commit on the default branch, and when each collector step last finished.
 */
export const api_0002_publish = {
  async up(db: Kysely<unknown>): Promise<void> {
    for (const table of ["registrySnapshots", "registryLatest"]) {
      await db.schema.alterTable(table).addColumn("description", "text").execute();
    }
    for (const table of ["repoSnapshots", "repoLatest"]) {
      await db.schema.alterTable(table).addColumn("createdAt", "integer").execute();
    }

    await db.schema
      .createTable("commits")
      .addColumn("repo", "text", (c) => c.notNull())
      .addColumn("oid", "text", (c) => c.notNull())
      .addColumn("committedAt", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint("commitsPk", ["repo", "oid"])
      .execute();

    await db.schema
      .createTable("collections")
      .addColumn("step", "text", (c) => c.primaryKey().notNull())
      .addColumn("collectedAt", "integer", (c) => c.notNull())
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable("collections").ifExists().execute();
    await db.schema.dropTable("commits").ifExists().execute();
    for (const table of ["repoLatest", "repoSnapshots"]) {
      await db.schema.alterTable(table).dropColumn("createdAt").execute();
    }
    for (const table of ["registryLatest", "registrySnapshots"]) {
      await db.schema.alterTable(table).dropColumn("description").execute();
    }
  },
};
