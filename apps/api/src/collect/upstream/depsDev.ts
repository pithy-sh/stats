import { z } from "zod";
import { type Fetcher, requestJsonOrNull } from "./http";

const DEPS_DEV = "https://api.deps.dev";

const PackageVersions = z
  .object({
    versions: z
      .array(
        z
          .object({
            versionKey: z.object({ version: z.string().describe("The version.") }).describe("The version key."),
            isDefault: z.boolean().optional().describe("Whether deps.dev treats it as the package's default."),
          })
          .describe("One version deps.dev knows."),
      )
      .describe("Every version deps.dev knows."),
  })
  .describe("deps.dev's answer for one package.");

const DependentCounts = z
  .object({
    dependentCount: z.number().int().nonnegative().describe("All dependents."),
    directDependentCount: z.number().int().nonnegative().describe("Direct dependents."),
    indirectDependentCount: z.number().int().nonnegative().describe("Indirect dependents."),
  })
  .describe("deps.dev's dependent counts for one version.");

export const Dependents = z
  .object({
    version: z.string().describe("The version counted: the one deps.dev marks default."),
    dependents: z.number().int().nonnegative().describe("Packages that depend on it."),
    directDependents: z.number().int().nonnegative().describe("Of those, the ones that name it directly."),
    indirectDependents: z.number().int().nonnegative().describe("Of those, the ones that reach it transitively."),
  })
  .describe("How many packages depend on one package, as deps.dev counts them.");
export type Dependents = z.output<typeof Dependents>;

/** Dependents of a package's default version, or null when deps.dev has no default version for it. */
export async function fetchDependents(fetcher: Fetcher, name: string): Promise<Dependents | null> {
  const encoded = encodeURIComponent(name);
  const known = await requestJsonOrNull(fetcher, `${DEPS_DEV}/v3/systems/npm/packages/${encoded}`, PackageVersions);
  const version = known?.versions.find((candidate) => candidate.isDefault === true)?.versionKey.version;
  if (version === undefined) return null;
  const counts = await requestJsonOrNull(
    fetcher,
    `${DEPS_DEV}/v3alpha/systems/npm/packages/${encoded}/versions/${encodeURIComponent(version)}:dependents`,
    DependentCounts,
  );
  return {
    version,
    dependents: counts?.dependentCount ?? 0,
    directDependents: counts?.directDependentCount ?? 0,
    indirectDependents: counts?.indirectDependentCount ?? 0,
  };
}

const Project = z
  .object({
    scorecard: z
      .object({
        date: z.iso.datetime().describe("When Scorecard last scored the repository."),
        overallScore: z.number().min(0).max(10).describe("The aggregate score, 0 to 10."),
      })
      .optional()
      .describe("The OpenSSF Scorecard result, absent until the repository has been scored."),
  })
  .describe("deps.dev's answer for one source project.");

export const Scorecard = z
  .object({
    score: z.number().min(0).max(10).describe("The OpenSSF Scorecard aggregate, 0 to 10."),
    scoredAt: z.date().describe("When Scorecard computed it."),
  })
  .describe("The repository's OpenSSF Scorecard.");
export type Scorecard = z.output<typeof Scorecard>;

/** The repository's OpenSSF Scorecard as deps.dev reports it, or null before it has one. */
export async function fetchScorecard(fetcher: Fetcher, repo: string): Promise<Scorecard | null> {
  const project = await requestJsonOrNull(
    fetcher,
    `${DEPS_DEV}/v3/projects/${encodeURIComponent(`github.com/${repo}`)}`,
    Project,
  );
  if (project?.scorecard === undefined) return null;
  return { score: project.scorecard.overallScore, scoredAt: new Date(project.scorecard.date) };
}
