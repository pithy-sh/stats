import { UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { type Fetcher, requestJson, requestJsonWithHeaders } from "./http";

const GRAPHQL = "https://api.github.com/graphql";
const PAGE_SIZE = 100;
/** More issues or pull requests than the kit's repository will ever hold. */
const MAX_NODES = 100_000;
/** The most pages one connection is read across. Past it, paging is taken to be broken rather than long. */
export const MAX_PAGES = MAX_NODES / PAGE_SIZE;

const Timestamp = z.iso.datetime().transform((value) => new Date(value));

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
    createdAt: z.date().describe("When the repository was created."),
    stars: z.number().int().nonnegative().describe("Stargazers."),
    forks: z.number().int().nonnegative().describe("Forks."),
    commits: z.number().int().nonnegative().describe("Commits on the default branch."),
    contributors: z.number().int().nonnegative().describe("Contributors, anonymous ones included."),
  })
  .describe("The repository's headline counts.");
export type RepoStats = z.output<typeof RepoStats>;

const REPO_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    createdAt
    stargazerCount
    forkCount
    defaultBranchRef { target { ... on Commit { history { totalCount } } } }
  }
}`;

const RepoData = z
  .object({
    repository: z
      .object({
        createdAt: Timestamp.describe("When the repository was created."),
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
    createdAt: data.repository.createdAt,
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

/** One page of a GraphQL connection: its paging and its nodes. */
interface Page<N> {
  pageInfo: z.output<typeof PageInfo>;
  nodes: N[];
}

/** A query's data holding one paged connection directly under the repository. */
function repositoryConnection<N extends z.ZodType>(connection: "issues" | "pullRequests", node: N) {
  return z
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
}

/**
 * Every node of a paged connection, asking for the next page until GitHub says there is none. `pageOf` finds the
 * page in a query's data, or answers null when there is no connection to page. Throws when a page answers the
 * cursor it was asked with, or when `MAX_PAGES` pages still leave more.
 */
async function allPages<D extends z.ZodType, N>(
  fetcher: Fetcher,
  token: string,
  repo: string,
  query: string,
  connection: string,
  data: D,
  pageOf: (data: z.output<D>) => Page<N> | null,
): Promise<N[]> {
  const nodes: N[] = [];
  let after: string | null = null;
  for (let pages = 1; ; pages++) {
    const page = pageOf(await graphql(fetcher, token, query, { ...ownerAndName(repo), after }, data));
    if (page === null) return nodes;
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
  const nodes = await allPages(
    fetcher,
    token,
    repo,
    ISSUES_QUERY,
    "issues",
    repositoryConnection("issues", IssueNode),
    (data) => data.repository.issues as Page<z.output<typeof IssueNode>>,
  );
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
  return allPages(
    fetcher,
    token,
    repo,
    PULL_REQUESTS_QUERY,
    "pullRequests",
    repositoryConnection("pullRequests", PullRequestNode),
    (data) => data.repository.pullRequests as Page<GitHubPullRequest>,
  );
}

export const GitHubCommit = z
  .object({
    oid: z.string().describe("The commit's full SHA."),
    committedAt: z.date().describe("When it was committed: when it landed on the branch for a squash merge."),
  })
  .describe("One commit on the repository's default branch.");
export type GitHubCommit = z.output<typeof GitHubCommit>;

const COMMITS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: ${PAGE_SIZE}, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { oid committedDate }
          }
        }
      }
    }
  }
}`;

const CommitNode = z
  .object({
    oid: z.string().describe("The commit's SHA."),
    committedDate: Timestamp.describe("When it was committed."),
  })
  .describe("A commit node as GraphQL answers it.");

const CommitsData = z
  .object({
    repository: z
      .object({
        defaultBranchRef: z
          .object({
            target: z
              .object({
                history: z
                  .object({ pageInfo: PageInfo, nodes: z.array(CommitNode).describe("This page's commits.") })
                  .describe("One page of history."),
              })
              .describe("The branch head commit."),
          })
          .nullable()
          .describe("The default branch, or null for an empty repository."),
      })
      .describe("The repository."),
  })
  .describe("The commit history query's data.");

/** Every commit reachable from the default branch, newest first. Empty for a repository with no branch. */
export async function fetchCommits(fetcher: Fetcher, token: string, repo: string): Promise<GitHubCommit[]> {
  const nodes = await allPages(fetcher, token, repo, COMMITS_QUERY, "commits", CommitsData, (data) => {
    return data.repository.defaultBranchRef?.target.history ?? null;
  });
  return nodes.map((node) => ({ oid: node.oid, committedAt: node.committedDate }));
}
