import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import {
  contributorCount,
  fetchCommits,
  fetchIssues,
  fetchPullRequests,
  fetchRepoStats,
  lastPage,
  MAX_PAGES,
} from "./github";
import { type StubCall, stubFetch } from "./testing";

const TOKEN = "test-token";
const GRAPHQL = "https://api.github.com/graphql";

function variables(call: StubCall): Record<string, unknown> {
  return (JSON.parse(call.body ?? "{}") as { variables: Record<string, unknown> }).variables;
}

describe("lastPage", () => {
  test("reads the last page number from a Link header", () => {
    const link =
      '<https://api.github.com/repositories/1/contributors?per_page=1&anon=true&page=2>; rel="next", <https://api.github.com/repositories/1/contributors?per_page=1&anon=true&page=37>; rel="last"';
    expect(lastPage(link)).toBe(37);
  });

  test("is null when there is no last page", () => {
    expect(lastPage(null)).toBeNull();
    expect(lastPage('<https://x.test/?page=2>; rel="next"')).toBeNull();
  });
});

describe("contributorCount", () => {
  test("is the last page when the list pages one per page", async () => {
    const stub = stubFetch({
      "https://api.github.com/repos/pithy-sh/pithy/contributors?per_page=1&anon=true": {
        json: [{ login: "a" }],
        headers: { link: '<https://api.github.com/x?per_page=1&anon=true&page=12>; rel="last"' },
      },
    });
    expect(await contributorCount(stub.fetch, TOKEN, "pithy-sh/pithy")).toBe(12);
    expect(stub.calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("is the list's length when it fits on one page", async () => {
    const stub = stubFetch({ "https://api.github.com/repos/pithy-sh/pithy/contributors*": { json: [{ login: "a" }] } });
    expect(await contributorCount(stub.fetch, TOKEN, "pithy-sh/pithy")).toBe(1);
  });

  test("is zero for an empty repository, which GitHub answers with 204", async () => {
    const stub = stubFetch({
      "https://api.github.com/repos/pithy-sh/pithy/contributors*": new Response(null, { status: 204 }),
    });
    expect(await contributorCount(stub.fetch, TOKEN, "pithy-sh/pithy")).toBe(0);
  });
});

describe("fetchRepoStats", () => {
  test("reads stars, forks, commits and the creation time over GraphQL, and contributors over REST", async () => {
    const stub = stubFetch({
      [GRAPHQL]: {
        json: {
          data: {
            repository: {
              createdAt: "2026-08-20T12:00:00Z",
              stargazerCount: 120,
              forkCount: 8,
              defaultBranchRef: { target: { history: { totalCount: 2400 } } },
            },
          },
        },
      },
      "https://api.github.com/repos/pithy-sh/pithy/contributors*": { json: [{}, {}, {}] },
    });
    expect(await fetchRepoStats(stub.fetch, TOKEN, "pithy-sh/pithy")).toEqual({
      createdAt: new Date("2026-08-20T12:00:00Z"),
      stars: 120,
      forks: 8,
      commits: 2400,
      contributors: 3,
    });
    const graphql = stub.calls.find((call) => call.url === GRAPHQL);
    expect(graphql?.method).toBe("POST");
    expect(graphql?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(variables(graphql as StubCall)).toEqual({ owner: "pithy-sh", name: "pithy" });
  });

  test("throws when GraphQL answers errors with a 200", async () => {
    const stub = stubFetch({
      [GRAPHQL]: { json: { data: null, errors: [{ message: "Could not resolve to a Repository" }] } },
      "https://api.github.com/repos/pithy-sh/pithy/contributors*": { json: [] },
    });
    const error = await fetchRepoStats(stub.fetch, TOKEN, "pithy-sh/pithy").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.detail).toContain("Could not resolve to a Repository");
  });
});

describe("fetchIssues", () => {
  test("pages through every issue", async () => {
    const stub = stubFetch({
      [GRAPHQL]: (call) => {
        const after = variables(call).after;
        const first = after === null;
        return {
          json: {
            data: {
              repository: {
                issues: {
                  pageInfo: { hasNextPage: first, endCursor: first ? "c1" : "c2" },
                  nodes: first
                    ? [
                        {
                          number: 1,
                          createdAt: "2026-09-05T00:00:00Z",
                          closedAt: "2026-09-06T00:00:00Z",
                          state: "CLOSED",
                          stateReason: "COMPLETED",
                          issueType: { name: "Bug" },
                          labels: { nodes: [{ name: "kit" }] },
                        },
                      ]
                    : [
                        {
                          number: 2,
                          createdAt: "2026-09-07T00:00:00Z",
                          closedAt: null,
                          state: "OPEN",
                          stateReason: null,
                          issueType: null,
                          labels: { nodes: [] },
                        },
                      ],
                },
              },
            },
          },
        };
      },
    });
    expect(await fetchIssues(stub.fetch, TOKEN, "pithy-sh/pithy")).toEqual([
      {
        number: 1,
        createdAt: new Date("2026-09-05T00:00:00Z"),
        closedAt: new Date("2026-09-06T00:00:00Z"),
        state: "CLOSED",
        stateReason: "COMPLETED",
        issueType: "Bug",
        labels: ["kit"],
      },
      {
        number: 2,
        createdAt: new Date("2026-09-07T00:00:00Z"),
        closedAt: null,
        state: "OPEN",
        stateReason: null,
        issueType: null,
        labels: [],
      },
    ]);
    expect(stub.calls.map((call) => variables(call).after)).toEqual([null, "c1"]);
  });
});

describe("fetchPullRequests", () => {
  test("pages through every pull request", async () => {
    const stub = stubFetch({
      [GRAPHQL]: {
        json: {
          data: {
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    number: 3,
                    createdAt: "2026-09-05T00:00:00Z",
                    mergedAt: "2026-09-05T02:00:00Z",
                    closedAt: "2026-09-05T02:00:00Z",
                    state: "MERGED",
                    additions: 10,
                    deletions: 2,
                  },
                ],
              },
            },
          },
        },
      },
    });
    expect(await fetchPullRequests(stub.fetch, TOKEN, "pithy-sh/pithy")).toEqual([
      {
        number: 3,
        createdAt: new Date("2026-09-05T00:00:00Z"),
        mergedAt: new Date("2026-09-05T02:00:00Z"),
        closedAt: new Date("2026-09-05T02:00:00Z"),
        state: "MERGED",
        additions: 10,
        deletions: 2,
      },
    ]);
  });
});

describe("fetchCommits", () => {
  test("pages through every commit on the default branch", async () => {
    const stub = stubFetch({
      [GRAPHQL]: (call) => {
        const first = variables(call).after === null;
        return {
          json: {
            data: {
              repository: {
                defaultBranchRef: {
                  target: {
                    history: {
                      pageInfo: { hasNextPage: first, endCursor: first ? "c1" : "c2" },
                      nodes: first
                        ? [{ oid: "b".repeat(40), committedDate: "2026-09-07T00:00:00Z" }]
                        : [{ oid: "a".repeat(40), committedDate: "2026-09-05T00:00:00Z" }],
                    },
                  },
                },
              },
            },
          },
        };
      },
    });
    expect(await fetchCommits(stub.fetch, TOKEN, "pithy-sh/pithy")).toEqual([
      { oid: "b".repeat(40), committedAt: new Date("2026-09-07T00:00:00Z") },
      { oid: "a".repeat(40), committedAt: new Date("2026-09-05T00:00:00Z") },
    ]);
    expect(stub.calls.map((call) => variables(call).after)).toEqual([null, "c1"]);
  });

  test("is empty for a repository with no default branch", async () => {
    const stub = stubFetch({ [GRAPHQL]: { json: { data: { repository: { defaultBranchRef: null } } } } });
    expect(await fetchCommits(stub.fetch, TOKEN, "pithy-sh/pithy")).toEqual([]);
  });
});

describe("paging a connection", () => {
  /** A GraphQL stub that always says another page follows, with `cursor` naming it. */
  function endless(cursor: (call: StubCall) => string) {
    return stubFetch({
      [GRAPHQL]: (call) => ({
        json: {
          data: {
            repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: cursor(call) }, nodes: [] } },
          },
        },
      }),
    });
  }

  test("throws when GitHub answers the cursor it was asked with", async () => {
    const stub = endless(() => "stuck");
    const error = await fetchPullRequests(stub.fetch, TOKEN, "pithy-sh/pithy").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.detail).toContain("stuck");
    expect(stub.calls).toHaveLength(2);
  });

  test("stops at a page ceiling when the cursor keeps moving", async () => {
    const stub = endless((call) => `c${stub.calls.indexOf(call) + 1}`);
    const error = await fetchPullRequests(stub.fetch, TOKEN, "pithy-sh/pithy").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.detail).toContain(String(MAX_PAGES));
    expect(stub.calls).toHaveLength(MAX_PAGES);
  });
});
