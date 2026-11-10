import { afterAll, beforeAll, describe, expect, test } from "vitest";

// This program carries the Workers types, not Node's, so the few Node calls this test makes are typed here and
// their modules named through values, which this program then does not try to resolve.
type Fs = {
  mkdtempSync(prefix: string): string;
  mkdirSync(path: string, options: { recursive: true }): void;
  writeFileSync(path: string, data: string): void;
  rmSync(path: string, options: { recursive: true; force: true }): void;
};
type ChildProcess = {
  spawnSync(
    command: string,
    args: string[],
    options: { encoding: "utf8"; cwd?: string },
  ): { status: number | null; stdout: string; stderr: string };
};
type Os = { tmpdir(): string };
const NODE_FS = "node:fs";
const NODE_CHILD_PROCESS = "node:child_process";
const NODE_OS = "node:os";

/** The project root: this file is `apps/api/src/lintSafeguards.test.ts`. */
const ROOT = new URL("../../../", (import.meta as unknown as { url: string }).url).pathname;
const BIOME = `${ROOT}node_modules/.bin/biome`;
const CONFIG = `${ROOT}biome.jsonc`;

const PARAMETER_PROPERTY = "export class Probe {\n  constructor(private readonly value: number) {}\n}\n";
const FIELD_ASSIGNED =
  "export class Probe {\n  readonly value: number;\n  constructor(value: number) {\n    this.value = value;\n  }\n}\n";

let fs: Fs;
let spawnSync: ChildProcess["spawnSync"];
/** A scratch tree shaped like the project, so each plugin's `includes` match it as they match app source. */
let scratch: string;

beforeAll(async () => {
  fs = (await import(/* @vite-ignore */ NODE_FS)) as unknown as Fs;
  ({ spawnSync } = (await import(/* @vite-ignore */ NODE_CHILD_PROCESS)) as unknown as ChildProcess);
  const { tmpdir } = (await import(/* @vite-ignore */ NODE_OS)) as unknown as Os;
  scratch = fs.mkdtempSync(`${tmpdir()}/stats-lint-`);
  fs.mkdirSync(`${scratch}/apps/api/src`, { recursive: true });
});

afterAll(() => {
  fs?.rmSync(scratch, { recursive: true, force: true });
});

/** Lint one file at `path` under the scratch tree with the project's Biome config, answering its exit and output. */
function lint(path: string, source: string): { status: number | null; output: string } {
  const file = `${scratch}/${path}`;
  fs.writeFileSync(file, source);
  const result = spawnSync(BIOME, ["lint", "--config-path", CONFIG, file], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("the project's includes", () => {
  // Run from wherever this checkout lives, a feature worktree under `.worktrees/` included, where an exclusion that
  // starts with `**` matches the checkout's own path and leaves nothing to check.
  test("check this checkout's own source", () => {
    const result = spawnSync(BIOME, ["lint", "."], { encoding: "utf8", cwd: ROOT });
    const checked = /Checked (\d+) files?/.exec(`${result.stdout}${result.stderr}`);
    expect(Number(checked?.[1] ?? 0)).toBeGreaterThan(50);
  });
});

describe("the no-unerasable-syntax safeguard", () => {
  test("fails a parameter property in app source", () => {
    const { status, output } = lint("apps/api/src/probe.ts", PARAMETER_PROPERTY);
    expect(status).not.toBe(0);
    expect(output).toContain("Node's type stripping refuses this");
  });

  test("fails one in a Worker's pithy.config.ts", () => {
    const { status, output } = lint("apps/api/pithy.config.ts", PARAMETER_PROPERTY);
    expect(status).not.toBe(0);
    expect(output).toContain("Node's type stripping refuses this");
  });

  test("passes a field assigned in the constructor", () => {
    const { output } = lint("apps/api/src/probe.ts", FIELD_ASSIGNED);
    expect(output).not.toContain("Node's type stripping refuses this");
  });

  test("leaves a test alone, which no config imports", () => {
    const { output } = lint("apps/api/src/probe.test.ts", PARAMETER_PROPERTY);
    expect(output).not.toContain("Node's type stripping refuses this");
  });
});
