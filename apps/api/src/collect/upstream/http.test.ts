import { PithyError, UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { requestJson, requestJsonOrNull, requestJsonWithHeaders, requestStream, USER_AGENT } from "./http";
import { stubFetch } from "./testing";

const Shape = z.object({ n: z.number().describe("A number.") }).describe("A test body.");

describe("requestJson", () => {
  test("parses the body against the schema and sends the user agent", async () => {
    const stub = stubFetch({ "https://up.test/a": { json: { n: 1, extra: true } } });
    expect(await requestJson(stub.fetch, "https://up.test/a", Shape)).toEqual({ n: 1 });
    expect(stub.calls[0]?.headers.get("user-agent")).toBe(USER_AGENT);
    expect(stub.calls[0]?.headers.get("accept")).toBe("application/json");
  });

  test("passes method, body and extra headers through", async () => {
    const stub = stubFetch({ "https://up.test/a": { json: { n: 2 } } });
    await requestJson(stub.fetch, "https://up.test/a", Shape, {
      method: "POST",
      body: "{}",
      headers: { "x-test": "yes" },
    });
    expect(stub.calls[0]).toMatchObject({ method: "POST", body: "{}" });
    expect(stub.calls[0]?.headers.get("x-test")).toBe("yes");
  });

  test("throws an upstream error naming the URL and status on a non-2xx answer", async () => {
    const stub = stubFetch({ "https://up.test/a": { status: 503, json: { error: "down" } } });
    const error = await requestJson(stub.fetch, "https://up.test/a", Shape).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("core/upstream_failed");
    expect((error as PithyError).payload.detail).toContain("https://up.test/a");
    expect((error as PithyError).payload.detail).toContain("503");
  });

  test("throws an upstream error when the body does not match the schema", async () => {
    const stub = stubFetch({ "https://up.test/a": { json: { n: "one" } } });
    const error = await requestJson(stub.fetch, "https://up.test/a", Shape).catch((caught: unknown) => caught);
    expect((error as PithyError).payload.code).toBe("core/upstream_failed");
    expect((error as PithyError).payload.detail).toContain("n");
  });

  test("throws an upstream error when the body is not JSON", async () => {
    const stub = stubFetch({ "https://up.test/a": new Response("<html>", { status: 200 }) });
    const error = await requestJson(stub.fetch, "https://up.test/a", Shape).catch((caught: unknown) => caught);
    expect((error as PithyError).payload.code).toBe("core/upstream_failed");
  });

  test("never puts a request header in the error, so a token cannot leak through it", async () => {
    const stub = stubFetch({ "https://up.test/a": { status: 401, json: {} } });
    const error = await requestJson(stub.fetch, "https://up.test/a", Shape, {
      headers: { authorization: "Bearer sekrit" },
    }).catch((caught: unknown) => caught);
    expect(JSON.stringify((error as PithyError).payload)).not.toContain("sekrit");
    expect((error as PithyError).message).not.toContain("sekrit");
  });
});

describe("a fetcher that throws an upstream error itself", () => {
  test("surfaces it unchanged, so its detail is not replaced by a bare 'did not answer'", async () => {
    const thrown = new UpstreamError({ detail: "GET https://up.test/a answered 429 on each of 6 attempts." });
    const error = await requestJson(
      async () => {
        throw thrown;
      },
      "https://up.test/a",
      Shape,
    ).catch((caught: unknown) => caught);
    expect(error).toBe(thrown);
  });
});

describe("requestJson on 204", () => {
  test("parses no content as a JSON null", async () => {
    const stub = stubFetch({ "https://up.test/a": new Response(null, { status: 204 }) });
    expect(await requestJson(stub.fetch, "https://up.test/a", Shape.nullable())).toBeNull();
  });
});

describe("requestJsonOrNull", () => {
  test("is null on a 404", async () => {
    const stub = stubFetch({ "https://up.test/a": { status: 404, json: { error: "not found" } } });
    expect(await requestJsonOrNull(stub.fetch, "https://up.test/a", Shape)).toBeNull();
  });

  test("still throws on any other failure", async () => {
    const stub = stubFetch({ "https://up.test/a": { status: 500 } });
    await expect(requestJsonOrNull(stub.fetch, "https://up.test/a", Shape)).rejects.toBeInstanceOf(PithyError);
  });
});

describe("requestJsonWithHeaders", () => {
  test("answers the parsed body and the response headers", async () => {
    const stub = stubFetch({ "https://up.test/a": { json: { n: 3 }, headers: { link: '<x>; rel="last"' } } });
    const answer = await requestJsonWithHeaders(stub.fetch, "https://up.test/a", Shape);
    expect(answer.data).toEqual({ n: 3 });
    expect(answer.headers.get("link")).toBe('<x>; rel="last"');
  });
});

describe("requestStream", () => {
  test("answers the body as a stream, sending the user agent and the headers given", async () => {
    const stub = stubFetch({ "https://up.test/a.tgz": new Response("archive bytes", { status: 200 }) });
    const body = await requestStream(stub.fetch, "https://up.test/a.tgz", { headers: { authorization: "Bearer t" } });
    expect(await new Response(body).text()).toBe("archive bytes");
    expect(stub.calls[0]?.headers.get("user-agent")).toBe(USER_AGENT);
    expect(stub.calls[0]?.headers.get("authorization")).toBe("Bearer t");
  });

  test("throws an upstream error naming the URL and status on a non-2xx answer, and never the headers", async () => {
    const stub = stubFetch({ "https://up.test/a.tgz": { status: 404, json: { message: "Not Found" } } });
    const error = await requestStream(stub.fetch, "https://up.test/a.tgz", {
      headers: { authorization: "Bearer secret-token" },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.detail).toContain("404");
    expect(JSON.stringify((error as PithyError).payload)).not.toContain("secret-token");
  });

  test("throws when a 2xx answer has no body", async () => {
    const stub = stubFetch({ "https://up.test/a.tgz": new Response(null, { status: 204 }) });
    const error = await requestStream(stub.fetch, "https://up.test/a.tgz").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
  });
});
