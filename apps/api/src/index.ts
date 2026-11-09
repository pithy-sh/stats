import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createEntrypoint } from "@pithy-sh/core/src/createEntrypoint";
import config from "../pithy.config";
import { type CollectEnv, type CollectReport, runCollect } from "./collect/workflow";

// The Worker. createEntrypoint assembles the capabilities in pithy.config.ts into
// a Worker entrypoint: `fetch` is one Hono app (typed db/kv registries on every
// request, fail-fast binding validation, GET /health), and `scheduled` starts every
// Workflow whose spec carries the cron that fired.
export default createEntrypoint(config);

/**
 * The collector Workflow, exported here because Cloudflare resolves a Workflow's `class_name` on the module
 * named by `main`. A shell: the run is `runCollect`, plain TypeScript a test can drive. `cloudflare:workers`
 * resolves only inside workerd, so this is the one module that imports a value from it.
 */
export class CollectWorkflow extends WorkflowEntrypoint<CollectEnv, unknown> {
  override async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<CollectReport> {
    return await runCollect(this.env, event, step);
  }
}
