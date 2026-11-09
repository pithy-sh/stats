import type { Kysely } from "kysely";

/** The collector's history: packages, downloads, registry, GitHub, jsDelivr and deps.dev tables. */
export const api_0001_init = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable("packages")
      .addColumn("name", "text", (c) => c.primaryKey().notNull())
      .addColumn("firstSeenOn", "text", (c) => c.notNull())
      .addColumn("lastSeenOn", "text", (c) => c.notNull())
      .execute();

    await db.schema
      .createTable("dailyDownloads")
      .addColumn("packageName", "text", (c) => c.notNull())
      .addColumn("day", "text", (c) => c.notNull())
      .addColumn("downloads", "integer", (c) => c.notNull())
      .addColumn("capturedOn", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("dailyDownloadsPk", ["packageName", "day"])
      .execute();

    await db.schema
      .createTable("versionDownloads")
      .addColumn("packageName", "text", (c) => c.notNull())
      .addColumn("version", "text", (c) => c.notNull())
      .addColumn("capturedOn", "text", (c) => c.notNull())
      .addColumn("downloads", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint("versionDownloadsPk", ["packageName", "version", "capturedOn"])
      .execute();

    await db.schema
      .createTable("versionPublishes")
      .addColumn("packageName", "text", (c) => c.notNull())
      .addColumn("version", "text", (c) => c.notNull())
      .addColumn("publishedAt", "integer", (c) => c.notNull())
      .addPrimaryKeyConstraint("versionPublishesPk", ["packageName", "version"])
      .execute();

    for (const [table, key] of [
      ["registrySnapshots", ["packageName", "capturedOn"]],
      ["registryLatest", ["packageName"]],
    ] as const) {
      await db.schema
        .createTable(table)
        .addColumn("packageName", "text", (c) => c.notNull())
        .addColumn("capturedOn", "text", (c) => c.notNull())
        .addColumn("latestVersion", "text", (c) => c.notNull())
        .addColumn("createdAt", "integer")
        .addColumn("versionCount", "integer", (c) => c.notNull())
        .addColumn("unpackedSize", "integer")
        .addColumn("fileCount", "integer")
        .addColumn("dependencies", "text", (c) => c.notNull())
        .addColumn("peerDependencies", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint(`${table}Pk`, [...key])
        .execute();
    }

    for (const [table, key] of [
      ["repoSnapshots", ["repo", "capturedOn"]],
      ["repoLatest", ["repo"]],
    ] as const) {
      await db.schema
        .createTable(table)
        .addColumn("repo", "text", (c) => c.notNull())
        .addColumn("capturedOn", "text", (c) => c.notNull())
        .addColumn("stars", "integer", (c) => c.notNull())
        .addColumn("forks", "integer", (c) => c.notNull())
        .addColumn("commits", "integer", (c) => c.notNull())
        .addColumn("contributors", "integer", (c) => c.notNull())
        .addPrimaryKeyConstraint(`${table}Pk`, [...key])
        .execute();
    }

    for (const [table, key] of [
      ["issueSnapshots", ["repo", "number", "capturedOn"]],
      ["issues", ["repo", "number"]],
    ] as const) {
      await db.schema
        .createTable(table)
        .addColumn("repo", "text", (c) => c.notNull())
        .addColumn("number", "integer", (c) => c.notNull())
        .addColumn("createdAt", "integer", (c) => c.notNull())
        .addColumn("closedAt", "integer")
        .addColumn("state", "text", (c) => c.notNull())
        .addColumn("stateReason", "text")
        .addColumn("issueType", "text")
        .addColumn("labels", "text", (c) => c.notNull())
        .addColumn("capturedOn", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint(`${table}Pk`, [...key])
        .execute();
    }

    for (const [table, key] of [
      ["pullRequestSnapshots", ["repo", "number", "capturedOn"]],
      ["pullRequests", ["repo", "number"]],
    ] as const) {
      await db.schema
        .createTable(table)
        .addColumn("repo", "text", (c) => c.notNull())
        .addColumn("number", "integer", (c) => c.notNull())
        .addColumn("createdAt", "integer", (c) => c.notNull())
        .addColumn("mergedAt", "integer")
        .addColumn("closedAt", "integer")
        .addColumn("state", "text", (c) => c.notNull())
        .addColumn("additions", "integer", (c) => c.notNull())
        .addColumn("deletions", "integer", (c) => c.notNull())
        .addColumn("capturedOn", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint(`${table}Pk`, [...key])
        .execute();
    }

    for (const [table, key] of [
      ["cdnSnapshots", ["packageName", "capturedOn"]],
      ["cdnLatest", ["packageName"]],
    ] as const) {
      await db.schema
        .createTable(table)
        .addColumn("packageName", "text", (c) => c.notNull())
        .addColumn("capturedOn", "text", (c) => c.notNull())
        .addColumn("period", "text", (c) => c.notNull())
        .addColumn("hits", "integer", (c) => c.notNull())
        .addColumn("bandwidth", "integer", (c) => c.notNull())
        .addColumn("rank", "integer")
        .addPrimaryKeyConstraint(`${table}Pk`, [...key])
        .execute();
    }

    for (const [table, key] of [
      ["dependentSnapshots", ["packageName", "capturedOn"]],
      ["dependentLatest", ["packageName"]],
    ] as const) {
      await db.schema
        .createTable(table)
        .addColumn("packageName", "text", (c) => c.notNull())
        .addColumn("capturedOn", "text", (c) => c.notNull())
        .addColumn("version", "text", (c) => c.notNull())
        .addColumn("dependents", "integer", (c) => c.notNull())
        .addColumn("directDependents", "integer", (c) => c.notNull())
        .addColumn("indirectDependents", "integer", (c) => c.notNull())
        .addPrimaryKeyConstraint(`${table}Pk`, [...key])
        .execute();
    }

    for (const [table, key] of [
      ["scorecardSnapshots", ["repo", "capturedOn"]],
      ["scorecardLatest", ["repo"]],
    ] as const) {
      await db.schema
        .createTable(table)
        .addColumn("repo", "text", (c) => c.notNull())
        .addColumn("capturedOn", "text", (c) => c.notNull())
        .addColumn("score", "real", (c) => c.notNull())
        .addColumn("scoredAt", "integer", (c) => c.notNull())
        .addPrimaryKeyConstraint(`${table}Pk`, [...key])
        .execute();
    }
  },

  async down(db: Kysely<unknown>): Promise<void> {
    for (const table of [
      "scorecardLatest",
      "scorecardSnapshots",
      "dependentLatest",
      "dependentSnapshots",
      "cdnLatest",
      "cdnSnapshots",
      "pullRequests",
      "pullRequestSnapshots",
      "issues",
      "issueSnapshots",
      "repoLatest",
      "repoSnapshots",
      "registryLatest",
      "registrySnapshots",
      "versionPublishes",
      "versionDownloads",
      "dailyDownloads",
      "packages",
    ]) {
      await db.schema.dropTable(table).ifExists().execute();
    }
  },
};
