import { describe, expect, test } from "vitest";
import config from "../pithy.config";

/** Vite's module glob. This program carries the Workers types, not Vite's, so the one call is typed here. */
type Glob = (
  pattern: string | string[],
  options: { query: "?raw"; import: "default"; eager: true },
) => Record<string, string>;

/** Every non-test TypeScript module under `src/`, keyed by its path relative to this file. */
const SOURCES = Object.entries(
  (import.meta as unknown as { glob: Glob }).glob(
    ["./**/*.ts", "!./**/*.test.ts", "!./**/*.d.ts"] as unknown as string,
    {
      query: "?raw",
      import: "default",
      eager: true,
    },
  ),
);

/** The folders allowed to reach the app D1: the collector, the schema and its migrations. */
const D1_OWNERS = ["./collect/", "./data/", "./migrations/"];

describe("no request path reads D1", () => {
  test("the app mounts no routes of its own, so only the built-in health check answers a request", () => {
    expect(config.app.routes).toBeUndefined();
  });

  test("only the collector, the schema and its migrations name the app database", () => {
    expect(SOURCES.length).toBeGreaterThan(10);
    const readers = SOURCES.filter(([, source]) => /statsDatabase|data\/tables|\.DB\b/.test(source)).map(
      ([path]) => path,
    );
    expect(readers.length).toBeGreaterThan(0);
    for (const path of readers)
      expect(
        D1_OWNERS.some((owner) => path.startsWith(owner)),
        path,
      ).toBe(true);
  });
});
