import type { Fetcher } from "./http";
import { NPM_API_GAP_MS, NPM_API_HOST } from "./npm";
import { type Clock, clock, freshPace, type PaceState, paced, RATE_LIMIT_RETRY, retryRateLimited } from "./rateLimit";

/**
 * When the next request to npm's downloads API may go, for everything in this isolate. Module scope, because the
 * Workflow runtime may run a run's body again from the top between steps, and a pace kept per call of
 * `upstreamFetcher` would forget the request the previous step just made.
 */
const NPM_PACE: PaceState = freshPace();

/**
 * The fetcher a collector run calls every upstream through. Requests to npm's downloads API are paced, and a
 * rate-limited answer from any upstream is retried in place. The retries sit outside the pacing, so a retried npm
 * request still waits its turn.
 */
export function upstreamFetcher(fetcher: Fetcher, time: Clock = clock, npmPace: PaceState = NPM_PACE): Fetcher {
  const npm = paced(fetcher, NPM_API_GAP_MS, time, npmPace);
  const routed: Fetcher = (url, init) => (new URL(url).host === NPM_API_HOST ? npm(url, init) : fetcher(url, init));
  return retryRateLimited(routed, RATE_LIMIT_RETRY, time);
}
