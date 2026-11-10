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

async function columns(table: string): Promise<{ name: string; pk: number; notnull: number }[]> {
  const rows = await sql<{ name: string; pk: number; notnull: number }>`
    select name, pk, "notnull" from pragma_table_info(${table})`.execute(statsDatabase(env.DB));
  return rows.rows;
}

beforeEach(async () => {
  await freshDatabase(env.DB);
});

describe("0005_npm_days", () => {
  test("up creates npm_days, one row per capture day, its week optional", async () => {
    expect(await columns("npm_days")).toEqual([
      { name: "captured_on", pk: 1, notnull: 1 },
      { name: "last_day", pk: 0, notnull: 1 },
      { name: "week_start", pk: 0, notnull: 0 },
      { name: "week_end", pk: 0, notnull: 0 },
    ]);
    await env.DB.prepare(
      "insert into npm_days (captured_on, last_day, week_start, week_end) values ('2026-11-10', '2026-11-08', '2026-11-02', '2026-11-08')",
    ).run();
    await env.DB.prepare("insert into npm_days (captured_on, last_day) values ('2026-11-11', '2026-11-09')").run();
    await expect(
      env.DB.prepare("insert into npm_days (captured_on, week_start) values ('2026-11-12', '2026-11-04')").run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "insert into npm_days (captured_on, last_day, week_start, week_end) values ('2026-11-10', '2026-11-09', '2026-11-03', '2026-11-09')",
      ).run(),
    ).rejects.toThrow();
  });

  test("down removes npm_days and leaves every other table", async () => {
    await rollbackMigration(env.DB, statsMigrationProvider());
    const present = await tables();
    expect(present).not.toContain("npm_days");
    expect(present).toContain("version_downloads");
    expect(present).toContain("packages");
  });

  test("up again after down restores it", async () => {
    await rollbackMigration(env.DB, statsMigrationProvider());
    await runMigrations(env.DB, statsMigrationProvider());
    expect(await tables()).toContain("npm_days");
  });
});
