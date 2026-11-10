import { env } from "cloudflare:test";
import { rollbackMigration, runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { statsDatabase } from "../data/tables";
import { freshDatabase } from "../data/testing";
import { statsMigrationProvider } from "./testing";

async function columns(table: string): Promise<string[]> {
  const rows = await sql<{ name: string }>`select name from pragma_table_info(${table})`.execute(statsDatabase(env.DB));
  return rows.rows.map((row) => row.name);
}

beforeEach(async () => {
  await freshDatabase(env.DB);
});

describe("0004_history", () => {
  test("up adds history_collected_on to packages, null for a package inserted after it", async () => {
    expect(await columns("packages")).toContain("history_collected_on");
    await env.DB.prepare(
      "insert into packages (name, first_seen_on, last_seen_on) values ('@pithy-sh/new', '2026-11-09', '2026-11-09')",
    ).run();
    const row = await env.DB.prepare("select history_collected_on as day from packages").first<{
      day: string | null;
    }>();
    expect(row?.day).toBeNull();
  });

  test("up leaves every package already recorded uncollected, so the next run fetches its whole history", async () => {
    await rollbackMigration(env.DB, statsMigrationProvider());
    expect(await columns("packages")).not.toContain("history_collected_on");
    await env.DB.prepare(
      "insert into packages (name, first_seen_on, last_seen_on) values ('@pithy-sh/core', '2026-09-05', '2026-11-08'), ('@pithy-sh/auth', '2026-10-01', '2026-11-08')",
    ).run();
    await runMigrations(env.DB, statsMigrationProvider());
    const { results } = await env.DB.prepare(
      "select name, history_collected_on as day from packages order by name",
    ).all<{ name: string; day: string | null }>();
    expect(results).toEqual([
      { name: "@pithy-sh/auth", day: null },
      { name: "@pithy-sh/core", day: null },
    ]);
  });

  test("down removes the column and keeps every package row", async () => {
    await env.DB.prepare(
      "insert into packages (name, first_seen_on, last_seen_on) values ('@pithy-sh/core', '2026-09-05', '2026-11-08')",
    ).run();
    await rollbackMigration(env.DB, statsMigrationProvider());
    expect(await columns("packages")).toEqual(["name", "first_seen_on", "last_seen_on"]);
    const { results } = await env.DB.prepare("select name from packages").all<{ name: string }>();
    expect(results).toEqual([{ name: "@pithy-sh/core" }]);
  });

  test("up again after down restores it", async () => {
    await rollbackMigration(env.DB, statsMigrationProvider());
    await runMigrations(env.DB, statsMigrationProvider());
    expect(await columns("packages")).toContain("history_collected_on");
  });
});
