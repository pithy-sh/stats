import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The Workers-runtime project: `*.workers.test.ts` runs inside workerd, against a real D1 database and a
// real Workflow that Miniflare creates per run and throws away after. No mocks, no fakes.
//
// `main` is the api Worker, because a Workflow's class resolves on the main module: the collector runs in
// the real Workflows engine, and a test drives it through the `COLLECT` binding. `GITHUB_TOKEN` stands in
// for the Secrets Store binding, which `secretsStore` reads as a plain string the way local dev does.
//
// The bindings here are declared for the *test* runtime, not read from a Worker's wrangler.jsonc — one
// test run covers every Worker under apps/, and they do not all declare the same bindings. Add a
// binding here when a capability you compose needs one; `pithy add <capability>` writes it into the
// Worker's wrangler.jsonc, and this file is the matching statement for tests.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./apps/api/src/index.ts",
      miniflare: {
        compatibilityDate: "2026-06-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        workflows: { COLLECT: { name: "stats-test-api-collect", className: "CollectWorkflow" } },
        bindings: { GITHUB_TOKEN: "test-github-token" },
      },
    }),
  ],
  test: {
    name: "workers",
    include: ["apps/*/src/**/*.workers.test.ts"],
  },
});
