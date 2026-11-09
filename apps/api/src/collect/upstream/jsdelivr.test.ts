import { describe, expect, test } from "vitest";
import { fetchCdnStats } from "./jsdelivr";
import { stubFetch } from "./testing";

describe("fetchCdnStats", () => {
  test("reads the month's hits, bandwidth and rank", async () => {
    const stub = stubFetch({
      "https://data.jsdelivr.com/v1/stats/packages/npm/@pithy-sh/core?period=month": {
        json: {
          hits: { rank: 9000, typeRank: 8000, total: 1234, dates: {}, prev: { rank: null, typeRank: null, total: 0 } },
          bandwidth: { rank: 9100, typeRank: 8100, total: 56789, dates: {}, prev: {} },
        },
      },
    });
    expect(await fetchCdnStats(stub.fetch, "@pithy-sh/core")).toEqual({
      period: "month",
      hits: 1234,
      bandwidth: 56789,
      rank: 9000,
    });
  });

  test("keeps a null rank, which jsDelivr gives a package with too few hits to rank", async () => {
    const stub = stubFetch({
      "https://data.jsdelivr.com/v1/stats/packages/npm/*": {
        json: { hits: { rank: null, total: 0 }, bandwidth: { rank: null, total: 0 } },
      },
    });
    expect(await fetchCdnStats(stub.fetch, "@pithy-sh/new")).toEqual({
      period: "month",
      hits: 0,
      bandwidth: 0,
      rank: null,
    });
  });

  test("is null when jsDelivr does not know the package yet", async () => {
    const stub = stubFetch({ "https://data.jsdelivr.com/v1/stats/packages/npm/*": { status: 404, json: {} } });
    expect(await fetchCdnStats(stub.fetch, "@pithy-sh/new")).toBeNull();
  });
});
