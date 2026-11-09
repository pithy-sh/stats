import { describe, expect, test } from "vitest";
import { COLLECT_BINDING, COLLECT_CRON, CollectJob, capturedOn, collectWorkflows, runDay } from "./workflow";

const event = (instanceId: string, timestamp = "2026-11-09T02:00:03Z") => ({
  payload: {},
  instanceId,
  timestamp: new Date(timestamp),
});

describe("collectWorkflows", () => {
  test("runs daily at 02:00 UTC through the COLLECT binding and the exported class", () => {
    expect(collectWorkflows.collect).toMatchObject({
      binding: COLLECT_BINDING,
      schedule: "0 2 * * *",
      className: "CollectWorkflow",
    });
    expect(COLLECT_CRON).toBe("0 2 * * *");
  });

  test("accepts the cron's empty params", () => {
    expect(CollectJob.parse({})).toEqual({});
  });

  test("refuses a date that is not a day", () => {
    expect(CollectJob.safeParse({ date: "yesterday" }).success).toBe(false);
  });
});

describe("runDay", () => {
  test("is the payload's date when one is given", () => {
    expect(runDay(event("2026-11-09"), { date: "2026-10-01" })).toBe("2026-10-01");
  });

  test("is the UTC day the instance was created on otherwise, as for a cron run's random id", () => {
    expect(runDay(event("0b5c7c1e-1d2f-4a3b-9c8d-7e6f5a4b3c2d"), {})).toBe("2026-11-09");
    expect(runDay(event("random", "2026-11-09T23:30:00-02:00"), {})).toBe("2026-11-10");
  });

  test("is the new UTC day for a fire just after midnight", () => {
    expect(runDay(event("0b5c7c1e-1d2f-4a3b-9c8d-7e6f5a4b3c2d", "2026-11-10T00:00:01Z"), {})).toBe("2026-11-10");
  });

  test("never reads a day out of the instance id", () => {
    expect(runDay(event("2026-11-08"), {})).toBe("2026-11-09");
  });
});

describe("capturedOn", () => {
  test("is the UTC day the instance was created on, whatever day the run is for", () => {
    expect(capturedOn(event("rerun", "2026-11-09T10:00:00Z"))).toBe("2026-11-09");
    expect(capturedOn(event("cron", "2026-11-10T00:00:01Z"))).toBe("2026-11-10");
  });
});
