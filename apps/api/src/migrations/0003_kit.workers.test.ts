import { env } from "cloudflare:test";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { statsDatabase } from "../data/tables";
import { freshDatabase } from "../data/testing";
import { statsMigrationProvider } from "./testing";

async function tables(): Promise<string[]> {
  const rows = await sql<{ name: string }>`select name from sqlite_master where type = 'table'`.execute(
    statsDatabase(env.DB),
  );
  return rows.rows.map((row) => row.name);
}

async function primaryKey(table: string): Promise<string[]> {
  const rows = await sql<{ name: string; pk: number }>`select name, pk from pragma_table_info(${table})`.execute(
    statsDatabase(env.DB),
  );
  return rows.rows
    .filter((row) => row.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((row) => row.name);
}

/** Roll back to the schema before 0003: every later migration comes down first. */
async function rollbackKit(): Promise<void> {
  for (;;) {
    const results = await rollbackMigration(env.DB, statsMigrationProvider());
    if (results.length === 0 || results.some((result) => result.migrationName.endsWith("0003_kit"))) return;
  }
}

beforeEach(async () => {
  await freshDatabase(env.DB);
});

describe("0003_kit", () => {
  test("up creates kit_counts, keyed by repository and capture day so a re-run of a day replaces its row", async () => {
    expect(await tables()).toContain("kit_counts");
    expect(await primaryKey("kit_counts")).toEqual(["repo", "captured_on"]);
  });

  test("down removes kit_counts and leaves the schema before it", async () => {
    await rollbackKit();
    const present = await tables();
    expect(present).not.toContain("kit_counts");
    expect(present).toContain("collections");
  });

  test("up again after down restores it", async () => {
    await rollbackKit();
    await runMigrations(env.DB, statsMigrationProvider());
    expect(await primaryKey("kit_counts")).toEqual(["repo", "captured_on"]);
  });
});
