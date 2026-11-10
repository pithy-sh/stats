import type { WorkflowStepConfig } from "cloudflare:workers";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import type { CollectStep } from "./workflow";

/**
 * Run `work` as the step `name`, logging why each attempt that throws failed before the runtime retries it. The
 * Workflow's own record keeps only an error's public message; the log carries its whole payload, an
 * `UpstreamError`'s detail (the URL and status) included. No request header reaches an error's payload, so none
 * reaches the log.
 */
export function loggedStep<T extends Rpc.Serializable<T>>(
  step: CollectStep,
  log: Logger,
  name: string,
  config: WorkflowStepConfig,
  work: () => Promise<T>,
): Promise<T> {
  return step.do<T>(name, config, async () => {
    try {
      return await work();
    } catch (error) {
      log.error("collector step failed", { step: name, error });
      throw error;
    }
  });
}
