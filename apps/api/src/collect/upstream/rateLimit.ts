import { UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import type { Fetcher } from "./http";

/** Time as the rate limiting sees it. Injected, so a test moves it by hand instead of waiting. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * The runtime's clock. An object rather than two functions, so a Workers-pool test can stub `sleep` on it and run a
 * whole collector run without waiting out the pacing.
 */
export const clock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** When a paced upstream's next request may go. Shared by everything that paces that upstream. */
export interface PaceState {
  nextSlot: number;
}

/** A pace state no request has used yet: the first request goes at once. */
export function freshPace(): PaceState {
  return { nextSlot: Number.NEGATIVE_INFINITY };
}

/**
 * Space the requests made through `fetcher` at least `gapMs` apart, counting every request that shares `state`.
 * Each request takes the next free slot before it waits, so requests made at the same moment are spaced too.
 */
export function paced(fetcher: Fetcher, gapMs: number, time: Clock = clock, state: PaceState = freshPace()): Fetcher {
  return async (url, init) => {
    const now = time.now();
    const slot = Math.max(now, state.nextSlot);
    state.nextSlot = slot + gapMs;
    if (slot > now) await time.sleep(slot - now);
    return fetcher(url, init);
  };
}

/** How a rate-limited request is retried in place before it becomes an `UpstreamError`. */
export interface RetryPolicy {
  /** Requests made in all, the first included. */
  attempts: number;
  /** The first backoff step; each later one doubles it. */
  baseDelayMs: number;
  /** The longest single wait: a backoff step is capped at it, and a longer `Retry-After` is not waited out. */
  maxWaitMs: number;
  /** Where each wait falls between half and all of its step. `Math.random` outside tests. */
  random: () => number;
}

/**
 * Six attempts, backing off from three seconds. The waits add up to between 46 and 93 seconds, which outlasts the
 * 25 to 30 seconds npm's downloads API took to clear after it began answering 429.
 */
export const RATE_LIMIT_RETRY: RetryPolicy = {
  attempts: 6,
  baseDelayMs: 3000,
  maxWaitMs: 60_000,
  random: Math.random,
};

/** A `Retry-After` value, in seconds or as an HTTP date, as milliseconds from `now`; 0 when it cannot be read. */
function retryAfterMs(value: string, now: number): number {
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
}

/**
 * How long `response` asks to wait before trying again, in milliseconds, or null when it is not a rate limit. A
 * 429 is one, waiting what its `Retry-After` says or 0. So is a 403 that carries `Retry-After`, or says no requests
 * remain until `X-RateLimit-Reset`, which is how GitHub answers its own limits.
 */
export function rateLimitWait(response: Response, now: number): number | null {
  const retryAfter = response.headers.get("retry-after");
  if (response.status === 429) return retryAfter === null ? 0 : retryAfterMs(retryAfter, now);
  if (response.status !== 403) return null;
  if (retryAfter !== null) return retryAfterMs(retryAfter, now);
  if (response.headers.get("x-ratelimit-remaining") !== "0") return null;
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  return Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - now) : 0;
}

/**
 * Retry a rate-limited answer in place: wait what the upstream asks when it names a wait, otherwise back off
 * exponentially with jitter, up to the policy's attempts. Every other answer passes straight through. A limit that
 * outlasts the budget, or asks for a longer wait than one request should hold its step, is an `UpstreamError`
 * naming the URL and status, never a header.
 */
export function retryRateLimited(
  fetcher: Fetcher,
  policy: RetryPolicy = RATE_LIMIT_RETRY,
  time: Clock = clock,
): Fetcher {
  return async (url, init) => {
    const method = init?.method ?? "GET";
    for (let attempt = 0; ; attempt++) {
      const response = await fetcher(url, init);
      const asked = rateLimitWait(response, time.now());
      if (asked === null) return response;
      await response.body?.cancel();
      if (asked > policy.maxWaitMs) {
        throw new UpstreamError({
          detail: `${method} ${url} answered ${response.status} and asked to wait ${Math.ceil(asked / 1000)}s, longer than the ${policy.maxWaitMs / 1000}s a request waits in place.`,
        });
      }
      if (attempt + 1 >= policy.attempts) {
        throw new UpstreamError({
          detail: `${method} ${url} answered ${response.status} on each of ${policy.attempts} attempts.`,
        });
      }
      const step = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxWaitMs);
      await time.sleep(asked > 0 ? asked : step * (0.5 + policy.random() * 0.5));
    }
  };
}
