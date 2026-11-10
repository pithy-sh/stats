import { parseVar } from "@pithy-sh/core/src/worker/vars";
import { describe, expect, test } from "vitest";
import { DEFAULT_READY_AFTER_MINUTES, VARS } from "./vars";

describe("READY_AFTER_MINUTES", () => {
  const entry = VARS.vars.READY_AFTER_MINUTES;

  test("defaults to 15 minutes, and staging and prod each name their own value", () => {
    expect(DEFAULT_READY_AFTER_MINUTES).toBe(15);
    expect(entry.default).toBe(DEFAULT_READY_AFTER_MINUTES);
    expect(entry.environments).toEqual({ staging: 15, prod: 15 });
  });

  test("reads a whole number of minutes under a day, as wrangler.jsonc holds it or as text", () => {
    expect(VARS.read({ READY_AFTER_MINUTES: 30 }).READY_AFTER_MINUTES).toBe(30);
    expect(VARS.read({ READY_AFTER_MINUTES: "20" }).READY_AFTER_MINUTES).toBe(20);
    expect(VARS.read({ READY_AFTER_MINUTES: "0" }).READY_AFTER_MINUTES).toBe(0);
    expect(VARS.read({ READY_AFTER_MINUTES: 1439 }).READY_AFTER_MINUTES).toBe(1439);
  });

  // The kit reads text that the schema refuses once more as JSON, so any JSON spelling of a valid number is taken.
  for (const [raw, minutes] of [
    [" 15", 15],
    ["15 ", 15],
    ["\t15\n", 15],
    ["1e1", 10],
    ["15.0", 15],
  ] as const) {
    test(`reads ${JSON.stringify(raw)}, a JSON spelling of ${minutes}, as ${minutes} minutes`, () => {
      expect(VARS.read({ READY_AFTER_MINUTES: raw }).READY_AFTER_MINUTES).toBe(minutes);
      expect(parseVar(entry, raw)).toEqual({ ok: true, value: minutes });
    });
  }

  for (const raw of [
    undefined,
    null,
    "",
    " ",
    "abc",
    "1.5",
    "15m",
    "0x10",
    "1e-1",
    "15,0",
    "-5",
    "1440",
    "99999",
    1.5,
    -1,
    1440,
    NaN,
    {},
  ]) {
    test(`falls back to the default for ${typeof raw === "string" ? JSON.stringify(raw) : String(raw)}`, () => {
      const env = raw === undefined ? {} : { READY_AFTER_MINUTES: raw };
      expect(VARS.read(env).READY_AFTER_MINUTES).toBe(DEFAULT_READY_AFTER_MINUTES);
      expect(parseVar(entry, raw).ok).toBe(false);
    });
  }
});
