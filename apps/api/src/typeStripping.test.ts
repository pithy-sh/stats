import { describe, expect, test } from "vitest";

/** Vite's module glob. This program carries the Workers types, not Vite's, so the one call is typed here. */
type Glob = (
  pattern: string | string[],
  options: { query: "?raw"; import: "default"; eager: true },
) => Record<string, string>;

/** Node's type stripper, from `node:module`. Typed here for the same reason: this program has no Node types. */
type StripTypes = (code: string, options: { mode: "strip" }) => string;

/** Named through a value, so this program, which has no Node types, does not try to resolve it. */
const NODE_MODULE = "node:module";

/** Every non-test TypeScript module of this Worker, `pithy.config.ts` included, keyed by its path. */
const SOURCES = Object.entries(
  (import.meta as unknown as { glob: Glob }).glob(
    ["./**/*.ts", "../pithy.config.ts", "!./**/*.test.ts", "!./**/*.d.ts"] as unknown as string,
    { query: "?raw", import: "default", eager: true },
  ),
);

describe("every module loads under Node's type stripping", () => {
  // The `pithy` CLI loads pithy.config.ts, and everything it imports, by stripping types the way Node does. That
  // refuses syntax that needs a transform, such as a parameter property or an enum, and the CLI then cannot read
  // the config at all.
  test.each(SOURCES)("%s", async (_path, source) => {
    const { stripTypeScriptTypes } = (await import(/* @vite-ignore */ NODE_MODULE)) as unknown as {
      stripTypeScriptTypes: StripTypes;
    };
    expect(() => stripTypeScriptTypes(source, { mode: "strip" })).not.toThrow();
  });

  test("covers the config and the collector", () => {
    const paths = SOURCES.map(([path]) => path);
    expect(paths).toContain("../pithy.config.ts");
    expect(paths).toContain("./collect/kit/tar.ts");
  });
});
