import { UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import { createLogger } from "@pithy-sh/core/src/logger/logger";
import { type LogRecord, serializeRecord } from "@pithy-sh/core/src/logger/record";
import { describe, expect, test } from "vitest";
import { loggedStep } from "./step";
import type { CollectStep } from "./workflow";

/** A step that runs its callback once, as the runtime does on a first attempt. */
const once: CollectStep = {
  do: (async (_name: string, ...rest: unknown[]) => {
    const callback = rest[rest.length - 1] as () => Promise<unknown>;
    return callback();
  }) as CollectStep["do"],
};

function captured() {
  const records: LogRecord[] = [];
  return { records, log: createLogger({ level: "debug", sink: (record) => records.push(record) }) };
}

const CONFIG = { retries: { limit: 0, delay: "1 second" }, timeout: "1 minute" } as const;

describe("loggedStep", () => {
  test("answers what the work answers, and logs nothing when it succeeds", async () => {
    const { records, log } = captured();
    expect(await loggedStep(once, log, "registry @pithy-sh/core", CONFIG, async () => 3)).toBe(3);
    expect(records).toEqual([]);
  });

  test("logs a failure's upstream detail with the step's name, then throws it on for the runtime to retry", async () => {
    const { records, log } = captured();
    const error = new UpstreamError({ detail: "https://api.npmjs.org/versions/x/last-week answered 429." });
    const thrown = await loggedStep(once, log, "version downloads @pithy-sh/core", CONFIG, async () => {
      throw error;
    }).catch((caught: unknown) => caught);
    expect(thrown).toBe(error);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "error",
      fields: { step: "version downloads @pithy-sh/core" },
      error: { code: "core/upstream_failed", detail: "https://api.npmjs.org/versions/x/last-week answered 429." },
    });
  });

  test("logs an error that is not a PithyError by its message", async () => {
    const { records, log } = captured();
    await loggedStep(once, log, "kit", CONFIG, async () => {
      throw new Error("tar ended early");
    }).catch(() => undefined);
    expect(serializeRecord(records[0] as LogRecord)).toContain("tar ended early");
  });
});
