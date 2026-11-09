import { env } from "cloudflare:test";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { statsDatabase } from "../data/tables";
import { freshDatabase } from "../data/testing";
import { statsMigrationProvider } from "./testing";

const TABLES = [
  "packages",
  "daily_downloads",
  "version_downloads",
  "version_publishes",
  "registry_snapshots",
  "registry_latest",
  "repo_snapshots",
  "repo_latest",
  "issues",
  "issue_snapshots",
  "pull_requests",
  "pull_request_snapshots",
  "cdn_snapshots",
  "cdn_latest",
  "dependent_snapshots",
  "dependent_latest",
  "scorecard_snapshots",
  "scorecard_latest",
];

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

beforeEach(async () => {
  await freshDatabase(env.DB);
  await rollbackMigration(env.DB, statsMigrationProvider());
});

describe("0001_init", () => {
  test("up creates every table, snake-cased", async () => {
    await runMigrations(env.DB, statsMigrationProvider());
    const present = await tables();
    for (const table of TABLES) expect(present, table).toContain(table);
  });

  test("keys each table so a re-run overwrites rather than duplicates", async () => {
    await runMigrations(env.DB, statsMigrationProvider());
    expect(await primaryKey("packages")).toEqual(["name"]);
    expect(await primaryKey("daily_downloads")).toEqual(["package_name", "day"]);
    expect(await primaryKey("version_downloads")).toEqual(["package_name", "version", "captured_on"]);
    expect(await primaryKey("version_publishes")).toEqual(["package_name", "version"]);
    expect(await primaryKey("registry_snapshots")).toEqual(["package_name", "captured_on"]);
    expect(await primaryKey("registry_latest")).toEqual(["package_name"]);
    expect(await primaryKey("repo_snapshots")).toEqual(["repo", "captured_on"]);
    expect(await primaryKey("repo_latest")).toEqual(["repo"]);
    expect(await primaryKey("issues")).toEqual(["repo", "number"]);
    expect(await primaryKey("issue_snapshots")).toEqual(["repo", "number", "captured_on"]);
    expect(await primaryKey("pull_requests")).toEqual(["repo", "number"]);
    expect(await primaryKey("pull_request_snapshots")).toEqual(["repo", "number", "captured_on"]);
    expect(await primaryKey("cdn_snapshots")).toEqual(["package_name", "captured_on"]);
    expect(await primaryKey("cdn_latest")).toEqual(["package_name"]);
    expect(await primaryKey("dependent_snapshots")).toEqual(["package_name", "captured_on"]);
    expect(await primaryKey("dependent_latest")).toEqual(["package_name"]);
    expect(await primaryKey("scorecard_snapshots")).toEqual(["repo", "captured_on"]);
    expect(await primaryKey("scorecard_latest")).toEqual(["repo"]);
  });

  test("down drops every table it created", async () => {
    await runMigrations(env.DB, statsMigrationProvider());
    await rollbackMigration(env.DB, statsMigrationProvider());
    const present = await tables();
    for (const table of TABLES) expect(present, table).not.toContain(table);
  });
});
