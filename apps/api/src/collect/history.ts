import { z } from "zod";
import { RegistrySnapshot, type StatsDatabase } from "../data/tables";
import { Day, utcDay } from "./day";

export const HistoryState = z
  .object({
    pending: z.boolean().describe("No daily-downloads step has yet written the package's whole history."),
    createdOn: Day.nullable().describe(
      "The UTC day the newest registry row says the package was created, or null when none says.",
    ),
  })
  .describe("What one package's daily-downloads window is chosen from.");
export type HistoryState = z.output<typeof HistoryState>;

/**
 * Each of `names`' history state. A name with no package row is pending. Every package is read and filtered here,
 * so the query binds no parameter however many names there are.
 */
export async function readHistoryState(
  db: StatsDatabase,
  names: readonly string[],
): Promise<Record<string, HistoryState>> {
  const marked = new Map(
    (await db.selectFrom("packages").select(["name", "historyCollectedOn"]).execute()).map((row) => [
      row.name,
      row.historyCollectedOn,
    ]),
  );
  const created = new Map(
    (await db.selectFrom("registryLatest").select(["packageName", "createdAt"]).execute()).map((row) => {
      const createdAt = RegistrySnapshot.shape.createdAt.decode(row.createdAt);
      return [row.packageName, createdAt === null ? null : utcDay(createdAt)];
    }),
  );
  return Object.fromEntries(
    names.map((name) => [name, { pending: (marked.get(name) ?? null) === null, createdOn: created.get(name) ?? null }]),
  );
}

/** A daily-downloads step wrote `name`'s whole history on `on`. A package already marked keeps its first day. */
export async function markHistoryCollected(db: StatsDatabase, name: string, on: Day): Promise<void> {
  await db
    .updateTable("packages")
    .set({ historyCollectedOn: on })
    .where("name", "=", name)
    .where("historyCollectedOn", "is", null)
    .execute();
}
