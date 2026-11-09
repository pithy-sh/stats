import { UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { type Fetcher, requestJson, requestJsonWithHeaders } from "./http";

const GRAPHQL = "https://api.github.com/graphql";
const PAGE_SIZE = 100;
/** More issues or pull requests than the kit's repository will ever hold. */
const MAX_NODES = 100_000;
/** The most pages one connection is read across. Past it, paging is taken to be broken rather than long. */
export const MAX_PAGES = MAX_NODES / PAGE_SIZE;

function authorization(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" };
}

function ownerAndName(repo: string): { owner: string; name: string } {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, name };
}

/** POST one GraphQL query and answer its `data`. GraphQL reports failure as `errors` on a 200, so both are read. */
async function graphql<S extends z.ZodType>(
  fetcher: Fetcher,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  data: S,
): Promise<z.output<S>> {
  const answer = await requestJson(
    fetcher,
    GRAPHQL,
    z
      .object({
        data: data.nullable().optional().describe("The query's result."),
        errors: z
          .array(z.object({ message: z.string().describe("What went wrong.") }).describe("One GraphQL error."))
          .optional()
          .describe("GraphQL's errors, present when the query failed."),
      })
      .describe("A GraphQL response."),
    {
      method: "POST",
      body: JSON.stringify({ query, variables }),
      headers: { ...authorization(token), "content-type": "application/json" },
    },
  );
  if (answer.errors !== undefined && answer.errors.length > 0) {
    throw new UpstreamError({
      detail: `GitHub GraphQL answered errors: ${answer.errors.map((error) => error.message).join("; ")}`,
    });
  }
  if (answer.data === undefined || answer.data === null) {
    throw new UpstreamError({ detail: "GitHub GraphQL answered no data." });
  }
  return answer.data;
}

/** The number of the page a `Link` header calls `last`, or null when it names none. */
export function lastPage(link: string | null): number | null {
  if (link === null) return null;
  for (const part of link.split(",")) {
    if (!/rel="last"/.test(part)) continue;
    const page = /[?&]page=(\d+)/.exec(part)?.[1];
    if (page !== undefined) return Number(page);
  }
  return null;
}

/** How many contributors GitHub lists for the repository, anonymous ones included. GraphQL has no such count. */
export async function contributorCount(fetcher: Fetcher, token: string, repo: string): Promise<number> {
  // One per page, so the `last` page's number is the count.
  const { data, headers } = await requestJsonWithHeaders(
    fetcher,
    `https://api.github.com/repos/${repo}/contributors?per_page=1&anon=true`,
    z.array(z.unknown().describe("One contributor.")).nullable().describe("A page of contributors."),
    { headers: authorization(token) },
  );
  return lastPage(headers.get("link")) ?? data?.length ?? 0;
}

export const RepoStats = z
  .object({
    stars: z.number().int().nonnegative().describe("Stargazers."),
    forks: z.number().int().nonnegative().describe("Forks."),
    commits: z.number().int().nonnegative().describe("Commits on the default branch."),
    contributors: z.number().int().nonnegative().describe("Contributors, anonymous ones included."),
  })
  .describe("The repository's headline counts.");
export type RepoStats = z.output<typeof RepoStats>;

const REPO_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    stargazerCount
    forkCount
    defaultBranchRef { target { ... on Commit { history { totalCount } } } }
  }
}`;

const RepoData = z
  .object({
    repository: z
      .object({
        stargazerCount: z.number().int().describe("Stargazers."),
        forkCount: z.number().int().describe("Forks."),
        defaultBranchRef: z
          .object({
            target: z
              .object({
                history: z.object({ totalCount: z.number().int().describe("Commits.") }).describe("History."),
              })
              .describe("The branch head commit."),
          })
          .nullable()
          .describe("The default branch, or null for an empty repository."),
      })
      .describe("The repository."),
  })
  .describe("The repository query's data.");

/** Stars, forks and commits over GraphQL, and contributors over REST. */
export async function fetchRepoStats(fetcher: Fetcher, token: string, repo: string): Promise<RepoStats> {
  const data = await graphql(fetcher, token, REPO_QUERY, ownerAndName(repo), RepoData);
  return {
    stars: data.repository.stargazerCount,
    forks: data.repository.forkCount,
    commits: data.repository.defaultBranchRef?.target.history.totalCount ?? 0,
    contributors: await contributorCount(fetcher, token, repo),
  };
}

const PageInfo = z
  .object({
    hasNextPage: z.boolean().describe("Whether another page follows."),
    endCursor: z.string().nullable().describe("The cursor to ask for the next page with."),
  })
  .describe("GraphQL connection paging.");

/**
 * Every node of a paged connection, asking for the next page until GitHub says there is none. Throws when a
 * page answers the cursor it was asked with, or when `MAX_PAGES` pages still leave more.
 */
async function allPages<N extends z.ZodType>(
  fetcher: Fetcher,
  token: string,
  repo: string,
  query: string,
  connection: "issues" | "pullRequests",
  node: N,
): Promise<z.output<N>[]> {
  const Data = z
    .object({
      repository: z
        .object({
          [connection]: z
            .object({ pageInfo: PageInfo, nodes: z.array(node).describe("This page's nodes.") })
            .describe("One page."),
        })
        .describe("The repository."),
    })
    .describe("A paged query's data.");
  const nodes: z.output<N>[] = [];
  let after: string | null = null;
  for (let pages = 1; ; pages++) {
    const data = await graphql(fetcher, token, query, { ...ownerAndName(repo), after }, Data);
    const page = data.repository[connection] as { pageInfo: z.output<typeof PageInfo>; nodes: z.output<N>[] };
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) return nodes;
    if (page.pageInfo.endCursor === after) {
      throw new UpstreamError({
        detail: `GitHub GraphQL paged ${repo} ${connection} back to the cursor it was asked with ("${after}") on page ${pages}.`,
      });
    }
    if (pages >= MAX_PAGES) {
      throw new UpstreamError({
        detail: `GitHub GraphQL still had more ${repo} ${connection} after ${pages} pages (${nodes.length} nodes), the most one run reads (${MAX_PAGES}).`,
      });
    }
    after = page.pageInfo.endCursor;
  }
}

const Timestamp = z.iso.datetime().transform((value) => new Date(value));

export const GitHubIssue = z
  .object({
    number: z.number().int().positive().describe("The issue number."),
    createdAt: z.date().describe("When it was opened."),
    closedAt: z.date().nullable().describe("When it was closed, or null while open."),
    state: z.string().describe("`OPEN` or `CLOSED`."),
    stateReason: z.string().nullable().describe("Why it closed (`COMPLETED`, `NOT_PLANNED`, …), or null."),
    issueType: z.string().nullable().describe("The issue type's name, or null when it has none."),
    labels: z.array(z.string().describe("A label name.")).describe("Its labels."),
  })
  .describe("One issue on the repository.");
export type GitHubIssue = z.output<typeof GitHubIssue>;

const ISSUES_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: ${PAGE_SIZE}, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number createdAt closedAt state stateReason
        issueType { name }
        labels(first: 50) { nodes { name } }
      }
    }
  }
}`;

const IssueNode = z
  .object({
    number: z.number().int().describe("The issue number."),
    createdAt: Timestamp.describe("When it was opened."),
    closedAt: Timestamp.nullable().describe("When it was closed."),
    state: z.string().describe("Its state."),
    stateReason: z.string().nullable().describe("Why it is in that state."),
    issueType: z
      .object({ name: z.string().describe("The type's name.") })
      .nullable()
      .describe("Its issue type."),
    labels: z
      .object({ nodes: z.array(z.object({ name: z.string().describe("A label.") }).describe("A label node.")) })
      .describe("Its labels."),
  })
  .describe("An issue node as GraphQL answers it.");

/** Every issue on the repository, oldest first. */
export async function fetchIssues(fetcher: Fetcher, token: string, repo: string): Promise<GitHubIssue[]> {
  const nodes = await allPages(fetcher, token, repo, ISSUES_QUERY, "issues", IssueNode);
  return nodes.map((node) => ({
    number: node.number,
    createdAt: node.createdAt,
    closedAt: node.closedAt,
    state: node.state,
    stateReason: node.stateReason,
    issueType: node.issueType?.name ?? null,
    labels: node.labels.nodes.map((label) => label.name),
  }));
}

export const GitHubPullRequest = z
  .object({
    number: z.number().int().positive().describe("The pull request number."),
    createdAt: z.date().describe("When it was opened."),
    mergedAt: z.date().nullable().describe("When it merged, or null."),
    closedAt: z.date().nullable().describe("When it closed, merged or not, or null while open."),
    state: z.string().describe("`OPEN`, `CLOSED` or `MERGED`."),
    additions: z.number().int().nonnegative().describe("Lines added."),
    deletions: z.number().int().nonnegative().describe("Lines deleted."),
  })
  .describe("One pull request on the repository.");
export type GitHubPullRequest = z.output<typeof GitHubPullRequest>;

const PULL_REQUESTS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${PAGE_SIZE}, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number createdAt mergedAt closedAt state additions deletions }
    }
  }
}`;

const PullRequestNode = z
  .object({
    number: z.number().int().describe("The pull request number."),
    createdAt: Timestamp.describe("When it was opened."),
    mergedAt: Timestamp.nullable().describe("When it merged."),
    closedAt: Timestamp.nullable().describe("When it closed."),
    state: z.string().describe("Its state."),
    additions: z.number().int().describe("Lines added."),
    deletions: z.number().int().describe("Lines deleted."),
  })
  .describe("A pull request node as GraphQL answers it.");

/** Every pull request on the repository, oldest first. */
export async function fetchPullRequests(fetcher: Fetcher, token: string, repo: string): Promise<GitHubPullRequest[]> {
  return allPages(fetcher, token, repo, PULL_REQUESTS_QUERY, "pullRequests", PullRequestNode);
}
