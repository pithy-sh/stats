import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { upstreamFetcher } from "./client";
import { NPM_API_GAP_MS } from "./npm";
import { type Clock, freshPace, RATE_LIMIT_RETRY } from "./rateLimit";
import { type StubAnswer, stubFetch } from "./testing";

/** A clock that moves only when slept on, recording when each request went out. */
function fakeClock(): Clock & { sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

/** A route that answers 429 for its first `n` calls and then `ok`. */
function limitedFor(n: number, ok: StubAnswer = { json: {} }): () => StubAnswer {
  let calls = 0;
  return () => (++calls <= n ? { status: 429, headers: { "retry-after": "0" } } : ok);
}

describe("upstreamFetcher", () => {
  test("spaces requests to npm's downloads API by the measured gap", async () => {
    const clock = fakeClock();
    const stub = stubFetch({ "https://api.npmjs.org/*": { json: {} } });
    const fetcher = upstreamFetcher(stub.fetch, clock, freshPace());
    await fetcher("https://api.npmjs.org/downloads/range/2026-11-06:2026-11-08/@pithy-sh/core");
    await fetcher("https://api.npmjs.org/versions/@pithy-sh%2Fcore/last-week");
    await fetcher("https://api.npmjs.org/downloads/range/2026-11-06:2026-11-08/@pithy-sh/auth");
    expect(clock.sleeps).toEqual([NPM_API_GAP_MS, NPM_API_GAP_MS]);
  });

  test("keeps one pace across fetchers built for the same upstream, as a run rebuilt between steps does", async () => {
    const clock = fakeClock();
    const pace = freshPace();
    const stub = stubFetch({ "https://api.npmjs.org/*": { json: {} } });
    await upstreamFetcher(stub.fetch, clock, pace)("https://api.npmjs.org/versions/@pithy-sh%2Fcore/last-week");
    await upstreamFetcher(stub.fetch, clock, pace)("https://api.npmjs.org/versions/@pithy-sh%2Fauth/last-week");
    expect(clock.sleeps).toEqual([NPM_API_GAP_MS]);
  });

  test("leaves every other upstream unpaced", async () => {
    const clock = fakeClock();
    const stub = stubFetch({ "https://*": { json: {} } });
    const fetcher = upstreamFetcher(stub.fetch, clock, freshPace());
    for (const url of [
      "https://registry.npmjs.org/@pithy-sh%2Fcore",
      "https://registry.npmjs.org/@pithy-sh%2Fauth",
      "https://data.jsdelivr.com/v1/stats/packages/npm/@pithy-sh/core?period=month",
      "https://data.jsdelivr.com/v1/stats/packages/npm/@pithy-sh/auth?period=month",
    ]) {
      await fetcher(url);
    }
    expect(clock.sleeps).toEqual([]);
  });

  test("a burst of 429s from npm is retried and answers once npm recovers within the budget", async () => {
    const clock = fakeClock();
    const url = "https://api.npmjs.org/downloads/range/2026-11-06:2026-11-08/@pithy-sh/core";
    const stub = stubFetch({ [url]: limitedFor(RATE_LIMIT_RETRY.attempts - 1, { json: { downloads: [] } }) });
    const response = await upstreamFetcher(stub.fetch, clock, freshPace())(url);
    expect(response.status).toBe(200);
    expect(stub.calls).toHaveLength(RATE_LIMIT_RETRY.attempts);
  });

  test("an npm retry waits at least the pacing gap, as well as its backoff", async () => {
    const clock = fakeClock();
    const url = "https://api.npmjs.org/versions/@pithy-sh%2Fcore/last-week";
    const stub = stubFetch({ [url]: limitedFor(1) });
    await upstreamFetcher(stub.fetch, clock, freshPace())(url);
    expect(clock.sleeps.reduce((total, ms) => total + ms, 0)).toBeGreaterThanOrEqual(NPM_API_GAP_MS);
  });

  test.each([
    ["the registry", "https://registry.npmjs.org/@pithy-sh%2Fcore"],
    ["jsDelivr", "https://data.jsdelivr.com/v1/stats/packages/npm/@pithy-sh/core?period=month"],
    ["deps.dev", "https://api.deps.dev/v3/systems/npm/packages/%40pithy-sh%2Fcore"],
    ["GitHub", "https://api.github.com/graphql"],
  ])("%s's 429s are retried the same way", async (_name, url) => {
    const clock = fakeClock();
    const stub = stubFetch({ [url]: limitedFor(2) });
    expect((await upstreamFetcher(stub.fetch, clock, freshPace())(url)).status).toBe(200);
    expect(stub.calls).toHaveLength(3);
  });

  test("a limit that outlasts the budget is an upstream error naming the URL and status", async () => {
    const clock = fakeClock();
    const url = "https://data.jsdelivr.com/v1/stats/packages/npm/@pithy-sh/core?period=month";
    const stub = stubFetch({ [url]: { status: 429 } });
    const error = await upstreamFetcher(stub.fetch, clock, freshPace())(url).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.detail).toContain(url);
    expect((error as PithyError).payload.detail).toContain("429");
  });
});
