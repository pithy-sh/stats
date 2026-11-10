import { describe, expect, test } from "vitest";
import {
  COLLECT_BINDING,
  COLLECT_CRON,
  CollectJob,
  capturedOn,
  collectWorkflows,
  refillCommand,
  runDay,
} from "./workflow";

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

describe("the collector's instance id", () => {
  const instanceId = collectWorkflows.collect?.instanceId;
  if (instanceId === undefined) throw new Error("The collector names no instance.");

  test("is the UTC day the cron fired for", () => {
    expect(instanceId({ firedAt: new Date("2026-11-09T02:00:00Z"), cron: COLLECT_CRON, params: {} })).toBe(
      "2026-11-09",
    );
  });

  test("is the UTC day, not the local one, for a fire either side of midnight UTC", () => {
    expect(instanceId({ firedAt: new Date("2026-11-09T23:30:00-02:00"), cron: COLLECT_CRON, params: {} })).toBe(
      "2026-11-10",
    );
    expect(instanceId({ firedAt: new Date("2026-11-09T23:59:59Z"), cron: COLLECT_CRON, params: {} })).toBe(
      "2026-11-09",
    );
  });

  test("is never a bare UTC day for a manual trigger without an id, so it cannot take the day's scheduled run", () => {
    const early = instanceId({ firedAt: new Date("2026-11-09T01:30:00Z"), params: {} });
    expect(early).not.toBe("2026-11-09");
    expect(early).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(instanceId({ firedAt: new Date("2026-11-09T10:00:00Z"), params: { date: "2026-10-01" } })).toBe(
      "manual-20261109100000000",
    );
  });

  test("differs for two manual triggers a moment apart", () => {
    expect(instanceId({ firedAt: new Date("2026-11-09T10:00:00.001Z"), params: {} })).not.toBe(
      instanceId({ firedAt: new Date("2026-11-09T10:00:00.002Z"), params: {} }),
    );
  });

  test("fits Cloudflare's rule for an instance id", () => {
    const rule = /^[A-Za-z0-9_-]{1,100}$/;
    expect(instanceId({ firedAt: new Date("2026-11-09T02:00:00Z"), cron: COLLECT_CRON, params: {} })).toMatch(rule);
    expect(instanceId({ firedAt: new Date("2026-11-09T02:00:00Z"), params: {} })).toMatch(rule);
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

describe("refillCommand", () => {
  const failedAt = new Date("2026-11-09T02:41:07.250Z");

  test("triggers the collector in the run's environment for its day, under an id stamped with when it failed", () => {
    expect(refillCommand("prod", "2026-11-08", failedAt)).toBe(
      `bun run pithy workflow trigger api/collect --env prod --params '{"date":"2026-11-08"}' --id refill-2026-11-08-20261109024107250`,
    );
  });

  test("never asks for the day's own id, which the scheduled run holds", () => {
    expect(refillCommand("staging", "2026-11-08", failedAt)).not.toMatch(/--id 2026-11-08\b/);
  });

  test("names a fresh id for each failure, so following it again after a refill fails is not refused", () => {
    const first = refillCommand("prod", "2026-11-08", failedAt);
    const again = refillCommand("prod", "2026-11-08", new Date("2026-11-09T03:12:00Z"));
    expect(again).not.toBe(first);
  });

  test("names an id that fits Cloudflare's rule", () => {
    const id = refillCommand("prod", "2026-11-08", failedAt).split("--id ")[1];
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
  });
});
