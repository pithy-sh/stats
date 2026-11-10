import { describe, expect, test } from "vitest";
import { parseReadyAfterMinutes } from "./schedule";

/** The kit's own wrangler.jsonc reader. Named through a value, so this program, which has no Node types, does not resolve it. */
const KIT_WRANGLER = "@pithy-sh/cli/src/project/wrangler";

interface Stanza {
  vars?: Record<string, unknown>;
}
interface WranglerConfig extends Stanza {
  env?: Record<string, Stanza | undefined>;
}

/** This Worker's wrangler.jsonc, read the way the `pithy` CLI reads it. */
async function wranglerConfig(): Promise<WranglerConfig> {
  const { readWranglerConfig } = (await import(/* @vite-ignore */ KIT_WRANGLER)) as {
    readWranglerConfig: (workerDir: string) => Promise<unknown>;
  };
  return (await readWranglerConfig(
    new URL("..", (import.meta as unknown as { url: string }).url).pathname,
  )) as WranglerConfig;
}

describe("READY_AFTER_MINUTES in wrangler.jsonc", () => {
  // `env.<name>.vars` replaces the top-level block, so a stanza that leaves the var out deploys on the fallback.
  test("is set, to a valid value, at the top level and in every environment", async () => {
    const config = await wranglerConfig();
    const stanzas: [string, Stanza | undefined][] = [["dev", config], ...Object.entries(config.env ?? {})];
    expect(stanzas.map(([name]) => name)).toEqual(expect.arrayContaining(["dev", "staging", "prod"]));
    for (const [name, stanza] of stanzas) {
      expect(parseReadyAfterMinutes(stanza?.vars?.READY_AFTER_MINUTES), name).not.toBeNull();
    }
  });
});
