import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";

/** The GitHub token's registry name. It binds to the Worker as `GITHUB_TOKEN`. */
export const GITHUB_TOKEN = "github-token" as const;

const TOKEN_SETTINGS = "https://github.com/settings/personal-access-tokens";

/**
 * Every secret this app holds. One: the token the collector reads `pithy-sh/pithy` with over GitHub's API.
 *
 * It is a fine-grained, read-only token on public repositories, so it carries the rate limit and nothing
 * else. It is one Cloudflare Secrets Store entry that every environment binds, set once with `pithy secrets create github-token`, and is
 * read only through `secretsStore` inside the GitHub step.
 */
export const statsSecretRegistry = defineSecretRegistry({
  [GITHUB_TOKEN]: {
    backend: "cf-secrets-store",
    scope: "global",
    // Replaced in place: a fine-grained token has no overlap to honour.
    rotatable: false,
    valueType: "text",
    // A fine-grained token expires within a year of being made.
    rotateEveryDays: 365,
    origin: { kind: "obtained", issuer: "github", documentation: TOKEN_SETTINGS },
    rotation: { kind: "manual", issuer: "github", documentation: TOKEN_SETTINGS },
    notes:
      "Fine-grained GitHub token, public repositories, read-only. Reads pithy-sh/pithy's counts, issues and pull requests.",
  },
});
