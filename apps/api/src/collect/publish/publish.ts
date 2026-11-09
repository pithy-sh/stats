import { currentKey, PUBLISHED_FILES, type PublishedFile, snapshotKey } from "../../contract/objects";
import { Latest, Summary } from "../../contract/stats";
import type { StatsDatabase } from "../../data/tables";
import { type Day, utcDay } from "../day";
import { buildLatest, buildSummary } from "./build";
import { readPublishRows } from "./read";

/** What one publish wrote: each key and its size in bytes. No figures, so a step's result stays small. */
export type PublishReport = Record<string, number>;

const JSON_METADATA = { contentType: "application/json; charset=utf-8" } as const;

/**
 * Build `summary.json` and `latest.json` from D1 as of `now`, and write each to R2 twice: as the dated snapshot for
 * `day` and as the current copy. The snapshots go first, so a current copy never names a day with no snapshot.
 * Both files are parsed through the contract before anything is written, so a malformed build writes nothing.
 *
 * A snapshot is served immutable once its day is over, so a run that publishes after `day` has ended writes the
 * snapshot only when none exists yet and otherwise refreshes the current copies alone. On `day` itself the snapshot
 * is rewritten, and served as expiring with the current files.
 */
export async function publish(
  db: StatsDatabase,
  bucket: R2Bucket,
  repo: string,
  day: Day,
  now: Date,
): Promise<PublishReport> {
  const rows = await readPublishRows(db, repo);
  const latest = Latest.parse(buildLatest(rows, { repo }, now));
  const summary = Summary.parse(buildSummary(rows, latest));
  const bodies: Record<PublishedFile, string> = { summary: JSON.stringify(summary), latest: JSON.stringify(latest) };
  const dayIsOver = day < utcDay(now);

  const report: PublishReport = {};
  const put = async (key: string, body: string, onlyIfAbsent: boolean) => {
    const written = await bucket.put(key, body, {
      httpMetadata: JSON_METADATA,
      ...(onlyIfAbsent ? { onlyIf: new Headers({ "if-none-match": "*" }) } : {}),
    });
    if (written !== null) report[key] = new TextEncoder().encode(body).byteLength;
  };
  for (const file of PUBLISHED_FILES) await put(snapshotKey(day, file), bodies[file], dayIsOver);
  for (const file of PUBLISHED_FILES) await put(currentKey(file), bodies[file], false);
  return report;
}
