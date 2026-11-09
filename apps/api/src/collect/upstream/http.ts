import { UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import type { z } from "zod";

/** The slice of `fetch` the collector uses. Injected, so a test answers from a table. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** The runtime's own `fetch`, called unbound-safe. */
export const runtimeFetch: Fetcher = (url, init) => fetch(url, init);

/** Who is asking. GitHub refuses a request without one, and every upstream can see who to contact. */
export const USER_AGENT = "pithy-stats (+https://github.com/pithy-sh/stats)";

/** What a request may add: a method, a body and headers. Headers never reach an error. */
export interface RequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

async function send(fetcher: Fetcher, url: string, options: RequestOptions): Promise<Response> {
  try {
    return await fetcher(url, {
      method: options.method ?? "GET",
      ...(options.body === undefined ? {} : { body: options.body }),
      headers: { accept: "application/json", "user-agent": USER_AGENT, ...options.headers },
    });
  } catch (cause) {
    throw new UpstreamError({ detail: `${options.method ?? "GET"} ${url} did not answer.` }, { cause });
  }
}

async function parse<S extends z.ZodType>(response: Response, url: string, schema: S): Promise<z.output<S>> {
  if (!response.ok) throw new UpstreamError({ detail: `${url} answered ${response.status}.` });
  // No content is a JSON `null`, so a schema can say whether it accepts an empty answer.
  if (response.status === 204) return parseBody(null, url, schema);
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new UpstreamError({ detail: `${url} answered ${response.status} with a body that is not JSON.` }, { cause });
  }
  return parseBody(body, url, schema);
}

function parseBody<S extends z.ZodType>(body: unknown, url: string, schema: S): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new UpstreamError({ detail: `${url} answered a body of an unexpected shape: ${issues.join("; ")}` });
  }
  return parsed.data;
}

/** GET (or `options.method`) `url` and parse its JSON body with `schema`. Any failure is an `UpstreamError`. */
export async function requestJson<S extends z.ZodType>(
  fetcher: Fetcher,
  url: string,
  schema: S,
  options: RequestOptions = {},
): Promise<z.output<S>> {
  return (await requestJsonWithHeaders(fetcher, url, schema, options)).data;
}

/** {@link requestJson}, with the response headers beside the body, for an upstream that pages in a header. */
export async function requestJsonWithHeaders<S extends z.ZodType>(
  fetcher: Fetcher,
  url: string,
  schema: S,
  options: RequestOptions = {},
): Promise<{ data: z.output<S>; headers: Headers }> {
  const response = await send(fetcher, url, options);
  return { data: await parse(response, url, schema), headers: response.headers };
}

/** {@link requestJson}, answering `null` where the upstream says 404: it has nothing for this subject yet. */
export async function requestJsonOrNull<S extends z.ZodType>(
  fetcher: Fetcher,
  url: string,
  schema: S,
  options: RequestOptions = {},
): Promise<z.output<S> | null> {
  const response = await send(fetcher, url, options);
  if (response.status === 404) return null;
  return parse(response, url, schema);
}

/**
 * GET (or `options.method`) `url` and answer its body as a stream, for a body too large to hold: the caller reads it
 * as it arrives. Any failure before the body starts is an `UpstreamError`.
 */
export async function requestStream(
  fetcher: Fetcher,
  url: string,
  options: RequestOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  const response = await send(fetcher, url, options);
  if (!response.ok) {
    await response.body?.cancel();
    throw new UpstreamError({ detail: `${url} answered ${response.status}.` });
  }
  if (response.body === null) throw new UpstreamError({ detail: `${url} answered ${response.status} with no body.` });
  return response.body;
}
