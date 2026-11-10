import { z } from "zod";
import { Day, type DayRange, dayRanges } from "../day";
import { type Fetcher, requestJson, requestJsonOrNull } from "./http";

/** The host of npm's downloads API, the one upstream the collector paces. */
export const NPM_API_HOST = "api.npmjs.org";

/**
 * The least time between two requests to npm's downloads API. Measured on 2026-11-09: sent back to back, the 21st
 * request answered 429 with `retry-after: 0`, about three seconds in, and the limit took 25 to 30 seconds to
 * clear. Two seconds apart, the 21st was still refused, 43 seconds in; four seconds apart, 27 requests in a row
 * all answered. So the limit is about twenty requests a minute, and four seconds keeps a quarter under it.
 */
export const NPM_API_GAP_MS = 4000;

/** npm's downloads API serves at most eighteen months per request; a year keeps well inside it. */
export const MAX_RANGE_DAYS = 365;

/** How many months back npm's downloads API keeps daily counts. A package's history is fetched from no earlier. */
export const NPM_HISTORY_MONTHS = 18;

/** A package name as a URL path segment, with a scope's slash encoded the way the registry wants it. */
function encodedName(name: string): string {
  return name.replace("/", "%2F");
}

const OrgPackages = z
  .record(z.string().describe("A package name."), z.string().describe("The org's access to it."))
  .describe("The registry's map of an org's packages to its access level.");

/** Every package the npm org publishes, sorted by name. */
export async function fetchOrgPackages(fetcher: Fetcher, org: string): Promise<string[]> {
  const packages = await requestJson(fetcher, `https://registry.npmjs.org/-/org/${org}/package`, OrgPackages);
  return Object.keys(packages).sort();
}

export const DailyDownload = z
  .object({
    day: Day.describe("The UTC day counted."),
    downloads: z.number().int().nonnegative().describe("Downloads npm counted that day."),
  })
  .describe("One package's downloads on one day.");
export type DailyDownload = z.output<typeof DailyDownload>;

const DownloadRange = z
  .object({ downloads: z.array(DailyDownload).describe("One entry per day of the range.") })
  .describe("npm's answer for a range of daily downloads.");

/** One package's downloads for every day of `range`. Empty when npm has no stats for it. */
export async function fetchDailyDownloads(fetcher: Fetcher, name: string, range: DayRange): Promise<DailyDownload[]> {
  const rows: DailyDownload[] = [];
  for (const { start, end } of dayRanges(range.start, range.end, MAX_RANGE_DAYS)) {
    const answer = await requestJsonOrNull(
      fetcher,
      `https://api.npmjs.org/downloads/range/${start}:${end}/${name}`,
      DownloadRange,
    );
    if (answer !== null) rows.push(...answer.downloads);
  }
  return rows;
}

const VersionDownloads = z
  .object({
    downloads: z
      .record(z.string().describe("A version."), z.number().int().nonnegative().describe("Its downloads."))
      .describe("Downloads per version over the last seven days."),
  })
  .describe("npm's per-version download counts for one package.");

/** Downloads per version over the last seven days, which is all npm keeps. Empty when npm has none. */
export async function fetchVersionDownloads(fetcher: Fetcher, name: string): Promise<Record<string, number>> {
  const answer = await requestJsonOrNull(
    fetcher,
    `https://api.npmjs.org/versions/${encodedName(name)}/last-week`,
    VersionDownloads,
  );
  return answer?.downloads ?? {};
}

const DependencyMap = z
  .record(z.string().describe("A dependency's name."), z.string().describe("Its range."))
  .describe("A manifest's dependency map.");

const Manifest = z
  .object({
    dist: z
      .object({
        unpackedSize: z.number().int().nonnegative().optional().describe("Bytes once unpacked."),
        fileCount: z.number().int().nonnegative().optional().describe("Files in the tarball."),
      })
      .describe("The tarball's facts."),
    dependencies: DependencyMap.optional().describe("Runtime dependencies."),
    peerDependencies: DependencyMap.optional().describe("Peer dependencies."),
  })
  .describe("One version's manifest, as much of it as the collector reads.");

const Packument = z
  .object({
    description: z.string().optional().describe("The package's description."),
    "dist-tags": z.object({ latest: z.string().describe("The latest version.") }).describe("The dist tags."),
    time: z
      .record(z.string().describe("A version, or `created` / `modified`."), z.iso.datetime().describe("When."))
      .describe("Publish times."),
    versions: z.record(z.string().describe("A version."), Manifest).describe("Every published version's manifest."),
  })
  .describe("The registry document for one package.");

export const RegistryFacts = z
  .object({
    latestVersion: z.string().describe("`dist-tags.latest`."),
    description: z.string().nullable().describe("The package's description, or null when it has none."),
    createdAt: z
      .date()
      .nullable()
      .describe("When the package was first published, or null when the registry omits it."),
    versions: z
      .array(
        z
          .object({
            version: z.string().describe("The version."),
            publishedAt: z.date().describe("When it was published."),
          })
          .describe("One published version."),
      )
      .describe("Every version still in the registry, oldest first."),
    unpackedSize: z.number().int().nullable().describe("The latest version's unpacked size in bytes, or null."),
    fileCount: z.number().int().nullable().describe("The latest version's file count, or null."),
    dependencies: DependencyMap.describe("The latest version's runtime dependencies."),
    peerDependencies: DependencyMap.describe("The latest version's peer dependencies."),
  })
  .describe("What the registry says about one package today.");
export type RegistryFacts = z.output<typeof RegistryFacts>;

/** The registry's facts for one package: every version's publish time, and the latest manifest's shape. */
export async function fetchRegistry(fetcher: Fetcher, name: string): Promise<RegistryFacts> {
  const doc = await requestJson(fetcher, `https://registry.npmjs.org/${encodedName(name)}`, Packument);
  const latestVersion = doc["dist-tags"].latest;
  const latest = doc.versions[latestVersion];
  const created = doc.time.created;
  const versions = Object.keys(doc.versions)
    .flatMap((version) => {
      const at = doc.time[version];
      return at === undefined ? [] : [{ version, publishedAt: new Date(at) }];
    })
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
  return {
    latestVersion,
    description: doc.description ?? null,
    createdAt: created === undefined ? null : new Date(created),
    versions,
    unpackedSize: latest?.dist.unpackedSize ?? null,
    fileCount: latest?.dist.fileCount ?? null,
    dependencies: latest?.dependencies ?? {},
    peerDependencies: latest?.peerDependencies ?? {},
  };
}
