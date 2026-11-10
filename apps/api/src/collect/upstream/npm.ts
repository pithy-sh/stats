import { UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { addDays, Day, DayRange, dayRanges } from "../day";
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

const DownloadPoint = z
  .object({
    downloads: z.number().int().nonnegative().describe("Downloads npm counted over the window."),
    start: Day.describe("The window's first day."),
    end: Day.describe("The window's last day."),
    package: z.string().describe("The package counted."),
  })
  .describe("npm's answer for one package's downloads over a named window.");

export const NpmDays = z
  .object({
    package: z.string().describe("The package npm was asked about: the first of the org's it has stats for."),
    lastDay: Day.describe("The newest day npm has finished counting: its `last-day` window."),
    lastWeek: DayRange.describe(
      "The seven days npm's `last-week` counts cover, per-version counts included: the seven ending `lastDay`.",
    ),
  })
  .describe("Which days npm's downloads API has counted, as it answered on one run.");
export type NpmDays = z.output<typeof NpmDays>;

/** The seven days npm's `last-week` counts cover for `name` now. */
export async function fetchNpmWeek(fetcher: Fetcher, name: string): Promise<DayRange> {
  const week = await requestJson(fetcher, `https://api.npmjs.org/downloads/point/last-week/${name}`, DownloadPoint);
  return { start: week.start, end: week.end };
}

/**
 * The days npm has counted, read off the first of `names` it has stats for: its `last-day` window, which names the
 * newest day npm has finished, and its `last-week` window. Two requests for that package, one per window. Fails
 * when no package has stats, when `last-day` is not a single day before `today`, or when `last-week` is not the
 * seven days ending it, so a window is never capped, and no week is ever recorded, from an answer that does not
 * add up.
 */
export async function fetchNpmDays(fetcher: Fetcher, names: readonly string[], today: Day): Promise<NpmDays> {
  for (const name of names) {
    const lastDay = await requestJsonOrNull(
      fetcher,
      `https://api.npmjs.org/downloads/point/last-day/${name}`,
      DownloadPoint,
    );
    if (lastDay === null) continue;
    if (lastDay.start !== lastDay.end) {
      throw new UpstreamError({
        detail: `npm's last-day window for ${name} is ${lastDay.start}..${lastDay.end}, not one day.`,
      });
    }
    if (lastDay.end >= today) {
      throw new UpstreamError({
        detail: `npm's last-day for ${name} is ${lastDay.end}, which has not ended on ${today}.`,
      });
    }
    const lastWeek = await fetchNpmWeek(fetcher, name);
    if (lastWeek.end !== lastDay.end || lastWeek.start !== addDays(lastDay.end, -6)) {
      throw new UpstreamError({
        detail: `npm's last-week window for ${name} is ${lastWeek.start}..${lastWeek.end}, not the seven days ending its last-day ${lastDay.end}.`,
      });
    }
    return { package: name, lastDay: lastDay.end, lastWeek };
  }
  throw new UpstreamError({
    detail: `npm has download stats for none of ${names.length} packages, so its last complete day is unknown.`,
  });
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
