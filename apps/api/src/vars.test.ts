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

  test("reads a plain decimal written as text, a fraction of zero included, as that number", () => {
    expect(parseVar(entry, "20")).toEqual({ ok: true, value: 20 });
    expect(parseVar(entry, "15.0")).toEqual({ ok: true, value: 15 });
    expect(VARS.read({ READY_AFTER_MINUTES: "15.0" }).READY_AFTER_MINUTES).toBe(15);
  });

  // Text is a number only as a plain decimal: padding, an exponent or a hex prefix is a typo, not another spelling.
  for (const raw of [" 15", "15 ", "\t15\n", "1e1", "0x10", ""]) {
    test(`falls back to the default for ${JSON.stringify(raw)}, which is not a plain decimal`, () => {
      expect(VARS.read({ READY_AFTER_MINUTES: raw }).READY_AFTER_MINUTES).toBe(DEFAULT_READY_AFTER_MINUTES);
      expect(parseVar(entry, raw).ok).toBe(false);
    });
  }

  test("tells onFallback which value fell back and why, and nothing for a valid one", () => {
    const fallbacks: unknown[] = [];
    VARS.read({ READY_AFTER_MINUTES: "20" }, { onFallback: (fallback) => fallbacks.push(fallback) });
    expect(fallbacks).toEqual([]);
    VARS.read({ READY_AFTER_MINUTES: "1e1" }, { onFallback: (fallback) => fallbacks.push(fallback) });
    VARS.read({}, { onFallback: (fallback) => fallbacks.push(fallback) });
    expect(fallbacks).toMatchObject([
      { name: "READY_AFTER_MINUTES", raw: "1e1", reason: "invalid" },
      { name: "READY_AFTER_MINUTES", raw: undefined, reason: "missing" },
    ]);
  });

  for (const raw of [
    undefined,
    null,
    " ",
    "abc",
    "1.5",
    "15m",
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
