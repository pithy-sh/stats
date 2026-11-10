import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { type Clock, paced, RATE_LIMIT_RETRY, type RetryPolicy, rateLimitWait, retryRateLimited } from "./rateLimit";
import { type StubAnswer, stubFetch } from "./testing";

/** A clock that only moves when something sleeps on it, and records every sleep. */
function fakeClock(start = 1_000_000): Clock & { sleeps: number[]; at: () => number } {
  let now = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    at: () => now,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

/** A policy whose jitter always picks the top of its range, so a test can name each wait exactly. */
const NO_JITTER: RetryPolicy = { ...RATE_LIMIT_RETRY, random: () => 1 };

describe("paced", () => {
  test("lets the first request through at once and spaces every later one by the gap", async () => {
    const clock = fakeClock();
    const stub = stubFetch({ "https://up.test/*": { json: {} } });
    const fetcher = paced(stub.fetch, 4000, clock);
    const sentAt: number[] = [];
    for (let i = 0; i < 3; i++) {
      await fetcher(`https://up.test/${i}`);
      sentAt.push(clock.at());
    }
    expect(sentAt).toEqual([1_000_000, 1_004_000, 1_008_000]);
    expect(stub.calls).toHaveLength(3);
  });

  test("waits only for what is left of the gap when time has already passed", async () => {
    const clock = fakeClock();
    const stub = stubFetch({ "https://up.test/*": { json: {} } });
    const fetcher = paced(stub.fetch, 4000, clock);
    await fetcher("https://up.test/a");
    await clock.sleep(2500);
    clock.sleeps.length = 0;
    await fetcher("https://up.test/b");
    expect(clock.sleeps).toEqual([1500]);
  });

  test("spaces requests made at the same moment, each taking its own slot", async () => {
    // Time stands still while all three wait, as it does for requests made in one tick.
    const sleeps: number[] = [];
    const clock: Clock = { now: () => 1_000_000, sleep: async (ms) => void sleeps.push(ms) };
    const stub = stubFetch({ "https://up.test/*": { json: {} } });
    const fetcher = paced(stub.fetch, 1000, clock);
    await Promise.all([fetcher("https://up.test/a"), fetcher("https://up.test/b"), fetcher("https://up.test/c")]);
    expect(sleeps.sort((a, b) => a - b)).toEqual([1000, 2000]);
  });
});

describe("rateLimitWait", () => {
  const response = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

  test("is null for an answer that is not a rate limit", () => {
    expect(rateLimitWait(response(200), 1_000_000)).toBeNull();
    expect(rateLimitWait(response(503), 1_000_000)).toBeNull();
    expect(rateLimitWait(response(403), 1_000_000)).toBeNull();
  });

  test("is zero for a 429 that names no wait, or names a wait of zero as npm does", () => {
    expect(rateLimitWait(response(429), 1_000_000)).toBe(0);
    expect(rateLimitWait(response(429, { "retry-after": "0" }), 1_000_000)).toBe(0);
  });

  test("reads Retry-After in seconds or as a date", () => {
    expect(rateLimitWait(response(429, { "retry-after": "7" }), 1_000_000)).toBe(7000);
    const now = Date.parse("2026-11-09T02:00:00Z");
    expect(rateLimitWait(response(429, { "retry-after": "Mon, 09 Nov 2026 02:00:30 GMT" }), now)).toBe(30_000);
  });

  test("ignores a Retry-After it cannot read", () => {
    expect(rateLimitWait(response(429, { "retry-after": "soon" }), 1_000_000)).toBe(0);
  });

  test("treats GitHub's 403 with Retry-After, or with no requests remaining, as a rate limit", () => {
    expect(rateLimitWait(response(403, { "retry-after": "60" }), 1_000_000)).toBe(60_000);
    const now = Date.parse("2026-11-09T02:00:00Z");
    const reset = String(Date.parse("2026-11-09T02:20:00Z") / 1000);
    expect(rateLimitWait(response(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }), now)).toBe(
      20 * 60_000,
    );
  });
});

describe("retryRateLimited", () => {
  test("retries a burst of 429s in place with exponential backoff and answers once the upstream recovers", async () => {
    const clock = fakeClock();
    let calls = 0;
    const stub = stubFetch({
      "https://api.test/a": (): StubAnswer =>
        ++calls <= 3 ? { status: 429, headers: { "retry-after": "0" } } : { json: { ok: 1 } },
    });
    const response = await retryRateLimited(stub.fetch, NO_JITTER, clock)("https://api.test/a");
    expect(response.status).toBe(200);
    expect(stub.calls).toHaveLength(4);
    const base = RATE_LIMIT_RETRY.baseDelayMs;
    expect(clock.sleeps).toEqual([base, base * 2, base * 4]);
  });

  test("jitters each wait between half and all of its step", async () => {
    const low = fakeClock();
    const stub = stubFetch({ "https://api.test/a": { status: 429 } });
    await retryRateLimited(
      stub.fetch,
      { ...RATE_LIMIT_RETRY, random: () => 0 },
      low,
    )("https://api.test/a").catch(() => undefined);
    expect(low.sleeps[0]).toBe(RATE_LIMIT_RETRY.baseDelayMs / 2);
    expect(low.sleeps[1]).toBe(RATE_LIMIT_RETRY.baseDelayMs);
  });

  test("its backoff outlasts the half minute npm was measured to take to clear", () => {
    let least = 0;
    for (let attempt = 0; attempt < RATE_LIMIT_RETRY.attempts - 1; attempt++) {
      least += Math.min(RATE_LIMIT_RETRY.baseDelayMs * 2 ** attempt, RATE_LIMIT_RETRY.maxWaitMs) / 2;
    }
    expect(least).toBeGreaterThan(30_000);
  });

  test("honours a non-zero Retry-After instead of its own backoff", async () => {
    const clock = fakeClock();
    let calls = 0;
    const stub = stubFetch({
      "https://api.test/a": (): StubAnswer =>
        ++calls === 1 ? { status: 429, headers: { "retry-after": "9" } } : { json: {} },
    });
    await retryRateLimited(stub.fetch, NO_JITTER, clock)("https://api.test/a");
    expect(clock.sleeps).toEqual([9000]);
  });

  test("throws an upstream error naming the URL and the attempts once the budget is spent", async () => {
    const clock = fakeClock();
    const stub = stubFetch({ "https://api.test/a": { status: 429 } });
    const error = await retryRateLimited(
      stub.fetch,
      NO_JITTER,
      clock,
    )("https://api.test/a", {
      headers: { authorization: "Bearer sekrit" },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    const payload = (error as PithyError).payload;
    expect(payload.code).toBe("core/upstream_failed");
    expect(payload.detail).toContain("https://api.test/a");
    expect(payload.detail).toContain("429");
    expect(payload.detail).toContain(String(RATE_LIMIT_RETRY.attempts));
    expect(JSON.stringify(payload)).not.toContain("sekrit");
    expect(stub.calls).toHaveLength(RATE_LIMIT_RETRY.attempts);
  });

  test("gives up at once when the upstream asks for a longer wait than the step should hold", async () => {
    const clock = fakeClock();
    const stub = stubFetch({ "https://api.test/a": { status: 429, headers: { "retry-after": "3600" } } });
    const error = await retryRateLimited(
      stub.fetch,
      NO_JITTER,
      clock,
    )("https://api.test/a").catch((caught: unknown) => caught);
    expect((error as PithyError).payload.detail).toContain("3600");
    expect(stub.calls).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  test("passes every other answer straight through, failures included", async () => {
    const clock = fakeClock();
    const stub = stubFetch({ "https://api.test/a": { status: 503 }, "https://api.test/b": { status: 404 } });
    const fetcher = retryRateLimited(stub.fetch, NO_JITTER, clock);
    expect((await fetcher("https://api.test/a")).status).toBe(503);
    expect((await fetcher("https://api.test/b")).status).toBe(404);
    expect(stub.calls).toHaveLength(2);
    expect(clock.sleeps).toEqual([]);
  });

  test("sends the same method, body and headers on every attempt", async () => {
    const clock = fakeClock();
    let calls = 0;
    const stub = stubFetch({
      "https://api.test/q": (): StubAnswer => (++calls === 1 ? { status: 429 } : { json: {} }),
    });
    await retryRateLimited(
      stub.fetch,
      NO_JITTER,
      clock,
    )("https://api.test/q", {
      method: "POST",
      body: '{"q":1}',
      headers: { "x-a": "b" },
    });
    for (const call of stub.calls) {
      expect(call).toMatchObject({ method: "POST", body: '{"q":1}' });
      expect(call.headers.get("x-a")).toBe("b");
    }
  });
});
