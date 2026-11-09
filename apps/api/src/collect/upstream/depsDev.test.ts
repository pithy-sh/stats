import { describe, expect, test } from "vitest";
import { fetchDependents, fetchScorecard } from "./depsDev";
import { stubFetch } from "./testing";

describe("fetchDependents", () => {
  test("counts dependents of the default version deps.dev knows", async () => {
    const stub = stubFetch({
      "https://api.deps.dev/v3/systems/npm/packages/%40pithy-sh%2Fcore": {
        json: {
          versions: [
            { versionKey: { version: "0.19.0" }, isDefault: false },
            { versionKey: { version: "0.20.0" }, isDefault: true },
          ],
        },
      },
      "https://api.deps.dev/v3alpha/systems/npm/packages/%40pithy-sh%2Fcore/versions/0.20.0:dependents": {
        json: { dependentCount: 5, directDependentCount: 3, indirectDependentCount: 2 },
      },
    });
    expect(await fetchDependents(stub.fetch, "@pithy-sh/core")).toEqual({
      version: "0.20.0",
      dependents: 5,
      directDependents: 3,
      indirectDependents: 2,
    });
  });

  test("is null when deps.dev does not know the package yet", async () => {
    const stub = stubFetch({ "https://api.deps.dev/v3/systems/npm/packages/*": { status: 404, json: {} } });
    expect(await fetchDependents(stub.fetch, "@pithy-sh/new")).toBeNull();
  });

  test("is null when no version is marked default", async () => {
    const stub = stubFetch({
      "https://api.deps.dev/v3/systems/npm/packages/*": {
        json: { versions: [{ versionKey: { version: "0.1.0" }, isDefault: false }] },
      },
    });
    expect(await fetchDependents(stub.fetch, "@pithy-sh/new")).toBeNull();
  });

  test("counts zero when deps.dev has no dependents for the version", async () => {
    const stub = stubFetch({
      "https://api.deps.dev/v3/systems/npm/packages/*": {
        json: { versions: [{ versionKey: { version: "0.1.0" }, isDefault: true }] },
      },
      "https://api.deps.dev/v3alpha/*": { status: 404, json: {} },
    });
    expect(await fetchDependents(stub.fetch, "@pithy-sh/new")).toEqual({
      version: "0.1.0",
      dependents: 0,
      directDependents: 0,
      indirectDependents: 0,
    });
  });
});

describe("fetchScorecard", () => {
  test("reads the repository's OpenSSF Scorecard through deps.dev", async () => {
    const stub = stubFetch({
      "https://api.deps.dev/v3/projects/github.com%2Fpithy-sh%2Fpithy": {
        json: { scorecard: { date: "2026-11-02T00:00:00Z", overallScore: 6.4, checks: [] } },
      },
    });
    expect(await fetchScorecard(stub.fetch, "pithy-sh/pithy")).toEqual({
      score: 6.4,
      scoredAt: new Date("2026-11-02T00:00:00Z"),
    });
  });

  test("is null before Scorecard has scored the repository", async () => {
    const stub = stubFetch({ "https://api.deps.dev/v3/projects/*": { json: { starsCount: 1 } } });
    expect(await fetchScorecard(stub.fetch, "pithy-sh/pithy")).toBeNull();
  });

  test("is null when deps.dev does not know the repository", async () => {
    const stub = stubFetch({ "https://api.deps.dev/v3/projects/*": { status: 404, json: {} } });
    expect(await fetchScorecard(stub.fetch, "pithy-sh/pithy")).toBeNull();
  });
});
