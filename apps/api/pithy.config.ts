// apps/api/pithy.config.ts — what THIS Worker is made of.
//
// Every Worker under apps/ has its own config. Capabilities are per-Worker
// because everything they drive is per-Worker: the composed route tree, the
// bindings written into this Worker's wrangler.jsonc, and Durable Object class
// migrations (which register a class against a specific script).
//
// Two Workers share a resource by declaring the SAME binding name — feature
// resource names are derived from the binding, not the Worker — so two Workers
// that both declare `DB` are backed by one D1. A Worker that wants its own
// declares a different binding (e.g. COLLAB_DB).

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { compositionEnvironment } from "@pithy-sh/core/src/env/ambient";
import { originFor } from "@pithy-sh/core/src/naming/domains";
import { secrets } from "@pithy-sh/secrets/src/index";
import { COLLECT_BINDING, collectWorkflows } from "./src/collect/workflow";
import { APP_MIGRATION_ORDER, RETAINED_TABLES, statsTables } from "./src/data/tables";
import { STATS_MIGRATIONS } from "./src/migrations/index";
import { statsSecretRegistry } from "./src/secret/registry";

// Where this Worker answers, per environment. Declare it once here and the
// `routes` entry and `vars.BASE_URL` in wrangler.jsonc are generated from it —
// `pithy init` and `pithy worker add` fill this in when you name a domain.
// `dev` is absent on purpose: local runs on the port your feature pinned.
const DOMAINS = {
  // staging: { pattern: "staging.api.example.com", zone: "example.com" },
  // prod: { pattern: "api.example.com", zone: "example.com" },
};

// This Worker's public origin, for the environment it is composing in. Hand it
// to every capability that needs one — auth's callbacks, email's links, a
// payment's return URL — so no origin is ever written down.
//
// An origin written down is production's origin written into staging, and that
// is not a typo you notice: it is staging mailing your testers magic links into
// production, and an unsubscribe from a staging test unsubscribing them there.
// An environment DOMAINS does not name resolves to the local origin, so a link
// built in the wrong place goes nowhere rather than somewhere real.
//
// Exported so your own code can build a link against the same origin.
export const PUBLIC_ORIGIN = originFor(compositionEnvironment(), DOMAINS);

// Your app is a capability like any other: routes, middleware, databases, KV
// namespaces, and the bindings they need. It composes last, after every
// library capability.
const app = defineCapability({
  // The app's capability name. Also its migration namespace once it has tables.
  name: "api",
  // Bindings your own routes need beyond what capabilities declare. Validated
  // on the first request — a missing binding fails fast with the binding's name.
  requiredBindings: [
    { type: "d1", name: "DB" },
    // Declared so a Worker deployed without the binding fails naming it, not on the next 02:00.
    { type: "workflow", name: COLLECT_BINDING },
  ],
  // The daily collector. Its spec's cron is what `pithy worker sync` writes into `triggers.crons`, and what
  // `createEntrypoint`'s `scheduled` handler starts it on.
  workflows: collectWorkflows,
  // The collector's history. Only the Workflow reads or writes it; no route does.
  databases: {
    app: {
      binding: "DB",
      tables: statsTables,
      migrationOrder: APP_MIGRATION_ORDER,
      migrations: STATS_MIGRATIONS,
      retained: RETAINED_TABLES,
    },
  },
  // Mount your routes here. Every route declares how callers are verified —
  // bearer, session, signed-webhook, or public — and what it returns, with
  // `describeRoute` from @pithy-sh/core/src/http/routeSpec. `pithy contract`
  // writes that into apps/api/openapi.json for every client to build against.
  // Read a request through `validate(target, Schema)` from
  // @pithy-sh/core/src/http/validation. `GET /health` is built in.
  // routes: (a) => {
  //   a.get(
  //     "/hello",
  //     describeRoute({
  //       summary: "Say hi.",
  //       verification: "public",
  //       responses: { 200: { description: "A greeting.", contentType: "text/plain" } },
  //     }),
  //     (c) => c.text("Hi."),
  //   );
  // },
});

const config = {
  domains: DOMAINS,
  // Library capabilities this Worker composes, in order.
  // `pithy add <capability> --worker api` registers them here.
  capabilities: [
    secrets({
      // Every secret this app holds: the GitHub token the collector reads with. Both the Workflow's
      // `secretsStore` and the `pithy secrets` CLI read it. See src/secret/registry.ts.
      registry: statsSecretRegistry,
      // How often the at-rest encryption key rotates. The secrets manager re-encrypts every stored secret on this cadence; raise it to rotate less often, lower it to rotate more aggressively.
      rotationIntervalDays: 30,
    }),
    // pithy:capabilities (managed region — do not remove this marker)
  ],
  app,
};

export default config;
