import type { Fetcher } from "./http";

/** One answer a stub gives: a JSON body and a status, or a `Response` built by hand. */
export type StubAnswer = { status?: number; json?: unknown; headers?: Record<string, string> } | Response;

/** A recorded request: what the code under test asked for. */
export interface StubCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

/**
 * A `fetch` that answers from a table instead of the network, and records every call. A key matches a URL
 * exactly, or by prefix when it ends in `*`. A function answer sees the request, so a test can page or fail
 * on a condition. An unmatched URL answers 599, so a test never reaches a real upstream by accident.
 */
export function stubFetch(routes: Record<string, StubAnswer | ((call: StubCall) => StubAnswer)>): {
  fetch: Fetcher;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const call: StubCall = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    const key =
      url in routes
        ? url
        : Object.keys(routes).find((candidate) => candidate.endsWith("*") && url.startsWith(candidate.slice(0, -1)));
    const route = key === undefined ? undefined : routes[key];
    if (route === undefined) return new Response(`no stub for ${url}`, { status: 599 });
    const answer = typeof route === "function" ? route(call) : route;
    if (answer instanceof Response) return answer;
    return new Response(answer.json === undefined ? null : JSON.stringify(answer.json), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json", ...answer.headers },
    });
  };
  return { fetch: fetcher, calls };
}
