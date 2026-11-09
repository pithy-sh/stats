import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { InternalError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { describeRoute } from "@pithy-sh/core/src/http/routeSpec";
import { validate } from "@pithy-sh/core/src/http/validation";
import type { Context, Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { currentKey, PUBLISHED_BINDING, type PublishedFile, snapshotKey } from "../contract/objects";
import { Latest, Summary } from "../contract/stats";
import { currentCacheControl, NOT_FOUND_CACHE_CONTROL, SNAPSHOT_CACHE_CONTROL, snapshotCacheControl } from "./cache";

/**
 * The public JSON API. Each route answers one file the collector's publish step wrote to R2: from this data
 * center's edge cache when it holds a copy, otherwise from one R2 read, which is then kept at the edge until the
 * copy's `Cache-Control` expires. A missing file is a 404 kept the same way, briefly. No route reads D1 or calls an
 * upstream. Query strings are never read, and the edge
 * copy is keyed by the path alone, so `?anything` answers the same bytes with the same headers as the bare path and
 * costs no R2 read.
 */

/** The sites that read the API from a browser: pithy.sh and its staging site. */
export const ALLOWED_ORIGINS = ["https://pithy.sh", "https://staging.pithy.sh"] as const;

/** How long a browser may keep a preflight answer, in seconds. */
const PREFLIGHT_MAX_AGE_SECONDS = 86_400;

export const ConditionalHeaders = z
  .object({
    "if-none-match": z
      .string()
      .optional()
      .describe(
        "ETags this API answered before, or `*`. When one still matches, the answer is a 304 with no body. A value that is not an entity-tag list is ignored.",
      ),
  })
  .describe("The request headers a `/v1` route reads.");
export type ConditionalHeaders = z.output<typeof ConditionalHeaders>;

export const SnapshotParams = z
  .object({ date: z.iso.date().describe("The UTC day the snapshot was published, `YYYY-MM-DD`.") })
  .describe("Which day's snapshot to read.");
export type SnapshotParams = z.output<typeof SnapshotParams>;

const NOT_MODIFIED = { description: "The copy named by `If-None-Match` is current. No body." } as const;

/** The longest `If-None-Match` read. A longer one is ignored, as a malformed one is. */
const MAX_IF_NONE_MATCH_LENGTH = 4096;

/** An `If-None-Match` list: `*`, or comma-separated entity tags, each `"…"` or weak `W/"…"`. */
const ENTITY_TAG_LIST = /^\s*(?:\*|(?:W\/)?"[^"]*"(?:\s*,\s*(?:W\/)?"[^"]*")*)\s*$/;
const ENTITY_TAG = /(?:W\/)?"([^"]*)"/g;

/**
 * Whether `ifNoneMatch` names `etag`, compared weakly as RFC 9110 has `If-None-Match` compare. A value that is not
 * an entity-tag list matches nothing, so the file is served: a server may ignore a malformed precondition.
 */
export function matchesIfNoneMatch(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined || ifNoneMatch.length > MAX_IF_NONE_MATCH_LENGTH) return false;
  if (!ENTITY_TAG_LIST.test(ifNoneMatch)) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const opaque = etag.replace(/^W\//, "");
  return [...ifNoneMatch.matchAll(ENTITY_TAG)].some((match) => `"${match[1]}"` === opaque);
}

function bucketOf(c: Context<PithyHonoEnv>): R2Bucket {
  const bucket = c.env[PUBLISHED_BINDING] as R2Bucket | undefined;
  if (bucket === undefined) {
    throw new InternalError({ detail: `No R2 bucket is bound as ${PUBLISHED_BINDING}.` });
  }
  return bucket;
}

/** One file as served: its bytes, its ETag and when R2 stored it. */
interface ServedFile {
  body: ArrayBuffer;
  etag: string;
  uploaded: Date;
}

/** The edge cache key for a request: its origin and path, so no query string makes a second copy. */
function edgeKey(c: Context<PithyHonoEnv>): Request {
  const url = new URL(c.req.url);
  return new Request(`${url.origin}${url.pathname}`);
}

/** Throw the 404 for `key`, with the `Cache-Control` a missing file is kept for. */
function notFound(c: Context<PithyHonoEnv>, key: string): never {
  c.header("cache-control", NOT_FOUND_CACHE_CONTROL);
  throw new NotFoundError({
    message: "No stats have been published here yet.",
    detail: `R2 holds no object at ${key}.`,
  });
}

/**
 * The file at `key`: the edge copy when this data center holds one, otherwise R2's object, which is then put at
 * the edge with `cacheControl(uploaded)` so the copy expires when a browser's would. A copy stored before the file
 * became immutable is not trusted to be the final file and is replaced by a fresh read. When R2 holds no object, a
 * 404 is put at the edge instead and thrown.
 */
async function readFile(
  c: Context<PithyHonoEnv>,
  key: string,
  cacheControl: (uploaded: Date) => string,
): Promise<ServedFile> {
  const cache = caches.default;
  const cacheKey = edgeKey(c);
  const hit = await cache.match(cacheKey);
  if (hit?.status === 404) notFound(c, key);
  const hitEtag = hit?.headers.get("etag");
  const hitModified = hit?.headers.get("last-modified");
  if (hit !== undefined && hitEtag && hitModified) {
    const uploaded = new Date(hitModified);
    const storedImmutable = hit.headers.get("cache-control") === SNAPSHOT_CACHE_CONTROL;
    if (storedImmutable || cacheControl(uploaded) !== SNAPSHOT_CACHE_CONTROL) {
      return { body: await hit.arrayBuffer(), etag: hitEtag, uploaded };
    }
  }

  const object = await bucketOf(c).get(key);
  if (object === null) {
    c.executionCtx.waitUntil(
      cache.put(cacheKey, new Response(null, { status: 404, headers: { "cache-control": NOT_FOUND_CACHE_CONTROL } })),
    );
    notFound(c, key);
  }
  const file = { body: await object.arrayBuffer(), etag: object.httpEtag, uploaded: object.uploaded };
  const stored = new Response(file.body, {
    headers: {
      "cache-control": cacheControl(file.uploaded),
      "content-type": "application/json; charset=utf-8",
      etag: file.etag,
      "last-modified": file.uploaded.toUTCString(),
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, stored));
  return file;
}

/**
 * Answer the file at `key` with its ETag, `Last-Modified` and `cacheControl(uploaded)`, counted from this request's
 * clock whether the file came from the edge or R2; or a 304 with the same headers when `If-None-Match` names it.
 */
async function serveObject(
  c: Context<PithyHonoEnv>,
  key: string,
  cacheControl: (uploaded: Date) => string,
  ifNoneMatch: string | undefined,
): Promise<Response> {
  const file = await readFile(c, key, cacheControl);
  const headers = {
    "cache-control": cacheControl(file.uploaded),
    etag: file.etag,
    "last-modified": file.uploaded.toUTCString(),
  };
  if (matchesIfNoneMatch(ifNoneMatch, file.etag)) return c.body(null, 304, headers);
  return c.body(file.body, 200, { ...headers, "content-type": "application/json; charset=utf-8" });
}

const CURRENT: Record<PublishedFile, { summary: string; description: string; schema: z.ZodType }> = {
  summary: {
    summary: "Read the kit's headline numbers.",
    description:
      "The home page strip. Cached until the next file is ready, at 02:05 UTC, or for five minutes once that file is late, then revalidated in the background for an hour.",
    schema: Summary,
  },
  latest: {
    summary: "Read everything the stats page draws.",
    description:
      "Every dataset `/stats/` draws. Cached until the next file is ready, at 02:05 UTC, or for five minutes once that file is late, then revalidated in the background for an hour.",
    schema: Latest,
  },
};

/** Mount the `/v1` routes and their CORS on `app`. `now` is the clock `max-age` is counted from. */
export function statsRoutes(app: Hono<PithyHonoEnv>, now: () => Date = () => new Date()): void {
  app.use(
    "/v1/*",
    cors({
      origin: [...ALLOWED_ORIGINS],
      allowMethods: ["GET"],
      allowHeaders: ["If-None-Match"],
      exposeHeaders: ["ETag"],
      maxAge: PREFLIGHT_MAX_AGE_SECONDS,
    }),
  );

  for (const file of ["summary", "latest"] as const) {
    const route = CURRENT[file];
    app.get(
      `/v1/${file}`,
      describeRoute({
        summary: route.summary,
        description: route.description,
        verification: "public",
        responses: { 200: route.schema, 304: NOT_MODIFIED },
      }),
      validate("header", ConditionalHeaders),
      (c) =>
        serveObject(
          c,
          currentKey(file),
          (uploaded) => currentCacheControl(now(), uploaded),
          c.req.valid("header")["if-none-match"],
        ),
    );
    app.get(
      `/v1/snapshots/:date/${file}`,
      describeRoute({
        summary: `Read one day's ${file === "summary" ? "headline numbers" : "full stats"}.`,
        description:
          "The file as published on that UTC day. A later run that day may rewrite it, so until the day is over it expires at the next 02:05 UTC or at midnight UTC, whichever is sooner; from then on it never changes and is cached as immutable.",
        verification: "public",
        responses: { 200: route.schema, 304: NOT_MODIFIED },
      }),
      validate("param", SnapshotParams),
      validate("header", ConditionalHeaders),
      (c) => {
        const { date } = c.req.valid("param");
        return serveObject(
          c,
          snapshotKey(date, file),
          () => snapshotCacheControl(date, now()),
          c.req.valid("header")["if-none-match"],
        );
      },
    );
  }
}
