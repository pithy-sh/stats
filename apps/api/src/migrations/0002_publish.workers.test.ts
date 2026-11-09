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

async function columns(table: string): Promise<string[]> {
  const rows = await sql<{ name: string }>`select name from pragma_table_info(${table})`.execute(statsDatabase(env.DB));
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

beforeEach(async () => {
  await freshDatabase(env.DB);
});

describe("0002_publish", () => {
  test("up adds the description and repository creation columns", async () => {
    for (const table of ["registry_snapshots", "registry_latest"])
      expect(await columns(table)).toContain("description");
    for (const table of ["repo_snapshots", "repo_latest"]) expect(await columns(table)).toContain("created_at");
  });

  test("up creates the commits and collections tables, keyed so a re-run overwrites", async () => {
    expect(await primaryKey("commits")).toEqual(["repo", "oid"]);
    expect(await primaryKey("collections")).toEqual(["step"]);
  });

  test("down removes what up added and leaves the first schema", async () => {
    await rollbackMigration(env.DB, statsMigrationProvider());
    const present = await tables();
    expect(present).not.toContain("commits");
    expect(present).not.toContain("collections");
    expect(present).toContain("registry_latest");
    for (const table of ["registry_snapshots", "registry_latest"])
      expect(await columns(table)).not.toContain("description");
    for (const table of ["repo_snapshots", "repo_latest"]) expect(await columns(table)).not.toContain("created_at");
  });

  test("up again after down restores it", async () => {
    await rollbackMigration(env.DB, statsMigrationProvider());
    await runMigrations(env.DB, statsMigrationProvider());
    expect(await columns("registry_latest")).toContain("description");
    expect(await primaryKey("collections")).toEqual(["step"]);
  });
});
