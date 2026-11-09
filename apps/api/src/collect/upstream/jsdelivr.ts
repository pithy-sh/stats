import { z } from "zod";
import { type Fetcher, requestJsonOrNull } from "./http";

/** The window jsDelivr totals over. A month is its default and the one the page reads. */
const PERIOD = "month";

export const CdnStats = z
  .object({
    period: z.literal(PERIOD).describe("The window the totals cover, ending yesterday."),
    hits: z.number().int().nonnegative().describe("CDN hits over the period."),
    bandwidth: z.number().int().nonnegative().describe("Bytes served over the period."),
    rank: z.number().int().positive().nullable().describe("jsDelivr's rank by hits, or null when unranked."),
  })
  .describe("One package's jsDelivr totals.");
export type CdnStats = z.output<typeof CdnStats>;

const Total = z
  .object({
    rank: z.number().int().nullable().describe("Rank among all packages."),
    total: z.number().int().describe("The total over the period."),
  })
  .describe("One jsDelivr metric.");

const PackageStats = z
  .object({ hits: Total.describe("Hits."), bandwidth: Total.describe("Bandwidth in bytes.") })
  .describe("jsDelivr's answer for one package.");

/** One package's jsDelivr hits and bandwidth over the last month, or null when jsDelivr does not know it yet. */
export async function fetchCdnStats(fetcher: Fetcher, name: string): Promise<CdnStats | null> {
  const answer = await requestJsonOrNull(
    fetcher,
    `https://data.jsdelivr.com/v1/stats/packages/npm/${name}?period=${PERIOD}`,
    PackageStats,
  );
  if (answer === null) return null;
  return { period: PERIOD, hits: answer.hits.total, bandwidth: answer.bandwidth.total, rank: answer.hits.rank };
}
