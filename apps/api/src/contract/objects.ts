/** The R2 bucket the publish step writes the JSON to and every `/v1` route reads it from. */
export const PUBLISHED_BINDING = "PUBLISHED";

/** The two files the API serves. */
export const PUBLISHED_FILES = ["summary", "latest"] as const;
export type PublishedFile = (typeof PUBLISHED_FILES)[number];

/** The key of the current copy of `file`. */
export function currentKey(file: PublishedFile): string {
  return `${file}.json`;
}

/** The key of `file` as published on `day`, a UTC `YYYY-MM-DD`. */
export function snapshotKey(day: string, file: PublishedFile): string {
  return `snapshots/${day}/${file}.json`;
}
