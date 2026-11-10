import { secretBindingName } from "@pithy-sh/secrets/src/env/bindingName";
import { describe, expect, test } from "vitest";
import { GITHUB_TOKEN, statsSecretRegistry } from "./registry";

describe("statsSecretRegistry", () => {
  test("declares the GitHub token in kebab-case, read through its derived binding", () => {
    expect(GITHUB_TOKEN).toBe("github-token");
    expect(secretBindingName(GITHUB_TOKEN)).toBe("GITHUB_TOKEN");
  });

  test("keeps one token in the Secrets Store for every environment, set by a person", () => {
    expect(statsSecretRegistry[GITHUB_TOKEN]).toMatchObject({
      backend: "cf-secrets-store",
      scope: "global",
      valueType: "text",
      origin: { kind: "obtained", issuer: "github" },
      rotation: { kind: "manual", issuer: "github" },
    });
  });

  test("never mints a value: only GitHub can issue one", () => {
    expect(statsSecretRegistry[GITHUB_TOKEN]).not.toHaveProperty("devValue");
  });
});
