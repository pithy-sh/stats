/// <reference types="@cloudflare/vitest-plugin/types" />

// What `*.workers.test.ts` gets from `cloudflare:test`, matching the bindings the root
// vitest.workers.config.ts declares. Add a binding in both places or the test sees `undefined` typed
// as something real — the one shape of test failure that looks like a bug in your code.
declare namespace Cloudflare {
  interface Env {
    ENVIRONMENT: string;
    DB: D1Database;
    PUBLISHED: R2Bucket;
    COLLECT: Workflow;
    GITHUB_TOKEN: string;
    SECRETS: D1Database;
    SECRETS_ENCRYPTION_KEYS: string;
  }
}
