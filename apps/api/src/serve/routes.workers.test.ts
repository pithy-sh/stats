import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { currentKey, snapshotKey } from "../contract/objects";
import worker from "../index";
import { secondsUntilNextFile } from "./cache";

const SUMMARY = JSON.stringify({ version: 1, file: "summary" });
const LATEST = JSON.stringify({ version: 1, file: "latest" });
const DAY = "2026-11-08";

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const fetch = worker.fetch;
  if (fetch === undefined) throw new Error("The Worker exports no fetch handler.");
  const response = await fetch(
    new Request(`https://stats.pithy.sh${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
    env as unknown as Record<string, unknown>,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function maxAge(response: Response): number {
  return Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1]);
}

async function clearBucket(): Promise<void> {
  const listed = await env.PUBLISHED.list();
  for (const object of listed.objects) await env.PUBLISHED.delete(object.key);
}

/** Every path a test here requests, so the edge cache can be emptied between tests. */
const PATHS = [
  "/v1/summary",
  "/v1/latest",
  ...[DAY, "2026-01-01", "2027-03-10"].flatMap((day) => [
    `/v1/snapshots/${day}/summary`,
    `/v1/snapshots/${day}/latest`,
  ]),
];

/** Drop the edge copies, as their expiry would: the next request reads R2. */
async function clearEdge(): Promise<void> {
  for (const path of PATHS) await caches.default.delete(`https://stats.pithy.sh${path}`);
}

/** Midday UTC `days` from the real clock: R2 stamps uploads with the real clock, so fake times are set around it. */
function dayFromNow(days: number, time = "12:00:00"): string {
  return `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)}T${time}Z`;
}

beforeEach(async () => {
  await clearBucket();
  await clearEdge();
  await env.PUBLISHED.put(currentKey("summary"), SUMMARY);
  await env.PUBLISHED.put(currentKey("latest"), LATEST);
  await env.PUBLISHED.put(snapshotKey(DAY, "summary"), SUMMARY);
  await env.PUBLISHED.put(snapshotKey(DAY, "latest"), LATEST);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the current files", () => {
  for (const [path, body, key] of [
    ["/v1/summary", SUMMARY, currentKey("summary")],
    ["/v1/latest", LATEST, currentKey("latest")],
  ] as const) {
    test(`${path} returns the R2 object as JSON, with its ETag`, async () => {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await response.text()).toBe(body);
      expect(response.headers.get("etag")).toBe((await env.PUBLISHED.head(key))?.httpEtag);
    });

    test(`${path} is public and expires at the next 02:05 UTC`, async () => {
      const before = secondsUntilNextFile(new Date());
      const response = await request(path);
      const after = secondsUntilNextFile(new Date());
      expect(response.headers.get("cache-control")).toMatch(/^public, max-age=\d+, stale-while-revalidate=3600$/);
      expect([before, after]).toContain(maxAge(response));
    });
  }

  test("max-age is computed per request, from the clock at the time, edge copy or not", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Days before the real upload, so the files read as today's, never late.
      vi.setSystemTime(new Date(dayFromNow(-3, "23:59:59")));
      expect(maxAge(await request("/v1/latest"))).toBe(2 * 3600 + 5 * 60 + 1);
      vi.setSystemTime(new Date(dayFromNow(-2, "02:04:00")));
      expect(maxAge(await request("/v1/latest"))).toBe(60);
      vi.setSystemTime(new Date(dayFromNow(-2, "02:05:00")));
      expect(maxAge(await request("/v1/summary"))).toBe(86_400);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a file today's run has not replaced by 02:05 is kept five minutes, not until tomorrow", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Two days after the real upload: the files are older than today's 02:00 UTC.
      vi.setSystemTime(new Date(dayFromNow(2, "02:06:00")));
      const late = await request("/v1/latest");
      expect(late.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=3600");
      // An edge copy is judged by when its file was uploaded too.
      expect(maxAge(await request("/v1/latest?again"))).toBe(300);
      // Before 02:05 the next file is not due yet, so a copy still counts to it.
      vi.setSystemTime(new Date(dayFromNow(2, "01:00:00")));
      expect(maxAge(await request("/v1/latest"))).toBe(3900);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a new file has a new ETag once the edge copy has expired", async () => {
    const first = (await request("/v1/latest")).headers.get("etag");
    await env.PUBLISHED.put(currentKey("latest"), JSON.stringify({ version: 1, file: "newer" }));
    await clearEdge();
    const second = (await request("/v1/latest")).headers.get("etag");
    expect(second).not.toBe(first);
  });

  test("answers 404 before anything is published, cached for five minutes", async () => {
    await clearBucket();
    const response = await request("/v1/summary");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });
});

describe("conditional requests", () => {
  test("a matching If-None-Match answers 304 with no body, the same ETag and Cache-Control", async () => {
    const first = await request("/v1/latest");
    const etag = first.headers.get("etag") ?? "";
    const response = await request("/v1/latest", { headers: { "if-none-match": etag } });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(etag);
    expect(response.headers.get("cache-control")).toMatch(/^public, max-age=\d+/);
  });

  test("a stale If-None-Match answers the new file", async () => {
    const response = await request("/v1/latest", { headers: { "if-none-match": '"not-the-etag"' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(LATEST);
  });

  test("a weak tag, a list and `*` match too", async () => {
    const etag = (await request("/v1/latest")).headers.get("etag") ?? "";
    for (const value of [`W/${etag}`, `"other", ${etag}`, "*"]) {
      const response = await request("/v1/latest", { headers: { "if-none-match": value } });
      expect(response.status, value).toBe(304);
    }
  });

  for (const [name, value] of [
    ["garbage", "garbage"],
    ["an unquoted ETag", "abc123"],
    ["an unterminated quote", '"unterminated'],
    ["bare commas", ",,,"],
    ["a 10 KB value", `"${"a".repeat(10_240)}"`],
  ] as const) {
    test(`a malformed If-None-Match, ${name}, is ignored and the file is served`, async () => {
      for (const path of ["/v1/latest", `/v1/snapshots/${DAY}/latest`]) {
        await clearEdge();
        const response = await request(path, { headers: { "if-none-match": value } });
        expect(response.status, path).toBe(200);
        expect(await response.text()).toBe(LATEST);
      }
    });
  }

  test("a snapshot answers 304 on its ETag too", async () => {
    const etag = (await request(`/v1/snapshots/${DAY}/summary`)).headers.get("etag") ?? "";
    const response = await request(`/v1/snapshots/${DAY}/summary`, { headers: { "if-none-match": etag } });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
  });
});

describe("snapshots", () => {
  test("each past day's files are served immutable, with their ETag", async () => {
    for (const [file, body] of [
      ["summary", SUMMARY],
      ["latest", LATEST],
    ] as const) {
      const response = await request(`/v1/snapshots/${DAY}/${file}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(response.headers.get("etag")).toBe((await env.PUBLISHED.head(snapshotKey(DAY, file)))?.httpEtag);
    }
  });

  test("today's files, which a later run today may rewrite, expire by the end of their day", async () => {
    const today = "2027-03-10";
    await env.PUBLISHED.put(snapshotKey(today, "latest"), LATEST);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(`${today}T12:00:00Z`));
      const during = await request(`/v1/snapshots/${today}/latest`);
      expect(during.status).toBe(200);
      expect(during.headers.get("cache-control")).toBe(`public, max-age=${12 * 3600}`);
      vi.setSystemTime(new Date(`${today}T01:00:00Z`));
      const beforeRun = await request(`/v1/snapshots/${today}/latest?early`);
      expect(beforeRun.headers.get("cache-control")).toBe(`public, max-age=${3600 + 5 * 60}`);
      vi.setSystemTime(new Date("2027-03-11T00:00:00Z"));
      const after = await request(`/v1/snapshots/${today}/latest`);
      expect(after.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    } finally {
      vi.useRealTimers();
    }
  });

  test("an edge copy taken during the day is not served as immutable once a same-day rewrite has replaced it", async () => {
    const today = "2027-03-10";
    const rewritten = JSON.stringify({ version: 1, file: "rewritten" });
    await env.PUBLISHED.put(snapshotKey(today, "latest"), LATEST);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(`${today}T10:00:00Z`));
      const during = await request(`/v1/snapshots/${today}/latest`);
      const oldEtag = during.headers.get("etag") ?? "";
      expect(await during.text()).toBe(LATEST);

      await env.PUBLISHED.put(snapshotKey(today, "latest"), rewritten);
      const newEtag = (await env.PUBLISHED.head(snapshotKey(today, "latest")))?.httpEtag;
      expect(newEtag).not.toBe(oldEtag);

      // The edge is not cleared: the copy taken at 10:00 is still there.
      vi.setSystemTime(new Date("2027-03-11T00:30:00Z"));
      const revalidated = await request(`/v1/snapshots/${today}/latest`, { headers: { "if-none-match": oldEtag } });
      expect(revalidated.status).toBe(200);
      expect(revalidated.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(revalidated.headers.get("etag")).toBe(newEtag);
      expect(await revalidated.text()).toBe(rewritten);

      const after = await request(`/v1/snapshots/${today}/latest`);
      expect(after.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(after.headers.get("etag")).toBe(newEtag);
      expect(await after.text()).toBe(rewritten);
    } finally {
      vi.useRealTimers();
    }
  });

  test("once the day is over, the immutable copy is kept at the edge and read from R2 no more", async () => {
    const today = "2027-03-10";
    await env.PUBLISHED.put(snapshotKey(today, "latest"), LATEST);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(`${today}T10:00:00Z`));
      await request(`/v1/snapshots/${today}/latest`);
      vi.setSystemTime(new Date("2027-03-11T00:30:00Z"));
      await request(`/v1/snapshots/${today}/latest`);
      const get = vi.spyOn(env.PUBLISHED, "get");
      const again = await request(`/v1/snapshots/${today}/latest`);
      expect(again.status).toBe(200);
      expect(get).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a day with no snapshot answers 404, cached for five minutes", async () => {
    const response = await request("/v1/snapshots/2026-01-01/latest");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  test("a date that is not a day is refused before R2 is read", async () => {
    const get = vi.spyOn(env.PUBLISHED, "get");
    const response = await request("/v1/snapshots/..%2Fsummary/latest");
    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("query strings", () => {
  test("change neither the body nor any header", async () => {
    const bare = await request("/v1/summary");
    const busted = await request("/v1/summary?v=123&cache=no");
    expect(busted.status).toBe(200);
    expect(await busted.text()).toBe(await bare.text());
    expect(busted.headers.get("etag")).toBe(bare.headers.get("etag"));
    expect(busted.headers.get("cache-control")?.replace(/max-age=\d+/, "")).toBe(
      bare.headers.get("cache-control")?.replace(/max-age=\d+/, ""),
    );
    expect(busted.headers.get("content-type")).toBe(bare.headers.get("content-type"));
  });

  test("on a snapshot too", async () => {
    const response = await request(`/v1/snapshots/${DAY}/latest?date=2026-01-01`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(LATEST);
  });
});

describe("each route reads at most one R2 object", () => {
  test("one get on a miss, none once the edge holds a copy, and no fetch", async () => {
    const get = vi.spyOn(env.PUBLISHED, "get");
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const path of ["/v1/summary", "/v1/latest", `/v1/snapshots/${DAY}/summary`, `/v1/snapshots/${DAY}/latest`]) {
      get.mockClear();
      await request(path);
      expect(get, path).toHaveBeenCalledTimes(1);
      get.mockClear();
      const again = await request(path);
      expect(again.status, path).toBe(200);
      expect(get, path).not.toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a query string is served from the same edge copy, without reading R2", async () => {
    const bare = await request("/v1/latest");
    const get = vi.spyOn(env.PUBLISHED, "get");
    const busted = await request("/v1/latest?v=123");
    expect(get).not.toHaveBeenCalled();
    expect(busted.status).toBe(200);
    expect(await busted.text()).toBe(LATEST);
    expect(busted.headers.get("etag")).toBe(bare.headers.get("etag"));
  });

  test("an edge copy answers a matching If-None-Match with a 304, without reading R2", async () => {
    const etag = (await request("/v1/latest")).headers.get("etag") ?? "";
    const get = vi.spyOn(env.PUBLISHED, "get");
    const response = await request("/v1/latest", { headers: { "if-none-match": etag } });
    expect(get).not.toHaveBeenCalled();
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(etag);
  });

  test("a 404 is kept at the edge for five minutes only, so a repeat costs no R2 read", async () => {
    await clearBucket();
    expect((await request("/v1/summary")).status).toBe(404);
    const stored = await caches.default.match("https://stats.pithy.sh/v1/summary");
    expect(stored?.status).toBe(404);
    expect(stored?.headers.get("cache-control")).toBe("public, max-age=300");

    const get = vi.spyOn(env.PUBLISHED, "get");
    const again = await request("/v1/summary?again");
    expect(again.status).toBe(404);
    expect(again.headers.get("cache-control")).toBe("public, max-age=300");
    expect(get).not.toHaveBeenCalled();

    // Once that copy expires, a file published since is served.
    await env.PUBLISHED.put(currentKey("summary"), SUMMARY);
    await clearEdge();
    expect((await request("/v1/summary")).status).toBe(200);
  });
});

describe("CORS", () => {
  for (const origin of ["https://pithy.sh", "https://staging.pithy.sh"]) {
    test(`allows ${origin} and exposes the ETag`, async () => {
      const response = await request("/v1/latest", { headers: { origin } });
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-expose-headers")).toContain("ETag");
    });
  }

  test("allows no other origin", async () => {
    const response = await request("/v1/latest", { headers: { origin: "https://example.com" } });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a preflight allows GET only", async () => {
    const response = await request("/v1/latest", {
      method: "OPTIONS",
      headers: { origin: "https://pithy.sh", "access-control-request-method": "GET" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://pithy.sh");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET");
  });

  test("no route answers a write", async () => {
    const response = await request("/v1/latest", { method: "POST", headers: { origin: "https://pithy.sh" } });
    expect(response.status).toBe(404);
  });
});
