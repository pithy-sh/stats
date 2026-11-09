import { describe, expect, test } from "vitest";
import { countCodeLines, countKit, countTests, isKitSource, isTestFile, tallyFile } from "./count";

describe("isKitSource", () => {
  test("is every .ts and .tsx file under a package's src/", () => {
    expect(isKitSource("packages/core/src/index.ts")).toBe(true);
    expect(isKitSource("packages/ui-react/src/button/Button.tsx")).toBe(true);
    expect(isKitSource("packages/core/src/data/db.test.ts")).toBe(true);
  });

  test("is nothing outside packages/*/src/", () => {
    expect(isKitSource("packages/core/templates/app/src/index.ts")).toBe(false);
    expect(isKitSource("packages/core/test/helpers.ts")).toBe(false);
    expect(isKitSource("packages/src/index.ts")).toBe(false);
    expect(isKitSource("apps/web/src/index.ts")).toBe(false);
    expect(isKitSource("src/index.ts")).toBe(false);
    expect(isKitSource("packages/core/vitest.config.ts")).toBe(false);
  });

  test("is no other kind of file", () => {
    expect(isKitSource("packages/core/src/index.js")).toBe(false);
    expect(isKitSource("packages/core/src/README.md")).toBe(false);
    expect(isKitSource("packages/core/src/data.json")).toBe(false);
    expect(isKitSource("packages/core/src/ts")).toBe(false);
  });
});

describe("isTestFile", () => {
  test("is a .test.ts or .test.tsx file, the Workers pool's included", () => {
    expect(isTestFile("packages/core/src/a.test.ts")).toBe(true);
    expect(isTestFile("packages/core/src/a.workers.test.ts")).toBe(true);
    expect(isTestFile("packages/ui-react/src/Button.test.tsx")).toBe(true);
  });

  test("is not a source file that only mentions test", () => {
    expect(isTestFile("packages/core/src/test.ts")).toBe(false);
    expect(isTestFile("packages/core/src/testing.ts")).toBe(false);
    expect(isTestFile("packages/core/src/a.test-utils.ts")).toBe(false);
  });
});

describe("countTests", () => {
  test("counts every it( and test( call", () => {
    expect(countTests(`it("a", () => {});\ntest("b", () => {});\ntest ("c", () => {});`)).toBe(3);
  });

  test.each([
    ["it.each", `it.each([1, 2, 3])("n %i", (n) => {});`],
    ["test.each", `test.each([[1], [2]])("n %i", (n) => {});`],
    ["it.skip", `it.skip("a", () => {});`],
    ["test.skip", `test.skip("a", () => {});`],
    ["it.only", `it.only("a", () => {});`],
    ["test.only", `test.only("a", () => {});`],
    ["it.todo", `it.todo("a");`],
    ["test.todo", `test.todo("a");`],
    ["it.concurrent", `it.concurrent("a", async () => {});`],
    ["test.concurrent", `test.concurrent("a", async () => {});`],
    ["a chain", `test.concurrent.each([1, 2])("n %i", async () => {});`],
    ["a chain across lines", `test\n  .skip\n  .each([1, 2])("n %i", () => {});`],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the text under test is a template literal's source.
    ["a tagged-template table", 'test.each`\n  a | b\n  ${1} | ${2}\n`("$a", () => {});'],
    ["test.for", `test.for(["dev", "prod"])("%s", (env) => {});`],
    ["skipIf", `test.skipIf(process.env.CI)("a", () => {});`],
    ["runIf", `it.runIf(true)("a", () => {});`],
    ["test.each with type arguments", `test.each<[string, number]>([["a", 1]])("%s", () => {});`],
    [
      "test.each with nested type arguments",
      `test.each<[string, Parameters<typeof f>[0], Map<string, Array<number>>]>([])("%s", () => {});`,
    ],
    ["test.each with a function type argument", `test.each<() => void>([])("%s", () => {});`],
    ["type arguments across lines", `test.each<\n  [string, boolean]\n>([])\n("%s", () => {});`],
    ["it with type arguments", `it<Ctx>("a", () => {});`],
  ])("counts the %s form once", (_form, source) => {
    expect(countTests(source)).toBe(1);
  });

  test("counts a parameterized test once, however many cases it runs", () => {
    expect(countTests(`test.each(Array.from({ length: 50 }, (_, i) => i))("n %i", () => {});`)).toBe(1);
  });

  test("counts tests nested inside describe blocks", () => {
    const source = `describe("a", () => {\n  describe.each([1])("b %i", () => {\n    it("c", () => {});\n    test("d", () => {});\n  });\n});`;
    expect(countTests(source)).toBe(2);
  });

  test("does not count a method or property named test or it", () => {
    expect(countTests(`/x/.test(value);\nexpect(re.test("a")).toBe(true);\nconst o = { test: 1, it: 2 };`)).toBe(0);
    expect(countTests(`foo . test("a");\nconst it2 = 1;\n$test("a");\nsplit("a");`)).toBe(0);
  });

  test("does not count a comparison with a variable named it or test", () => {
    expect(countTests(`if (it < a && b > c) {}\nconst x = test < 1;`)).toBe(0);
  });

  test("does not count a function declared test, or test.extend, or a tagged template without each", () => {
    expect(countTests(`function test(a) {}\nconst t = test.extend({});\ntest\`not a test\`;`)).toBe(0);
  });

  test("does not count calls inside strings, template text, comments or regexes", () => {
    const source = [
      `const a = "it('x', () => {})";`,
      `const b = 'test("y")';`,
      'const c = `it("z")`;',
      `// it("commented out", () => {});`,
      `/* test("block", () => {}); */`,
      `const d = /test\\(/;`,
    ].join("\n");
    expect(countTests(source)).toBe(0);
  });

  test("does not count a test written inside a template literal, as a fixture file is", () => {
    expect(countTests('const FIXTURE = `\nimport { test } from "vitest";\ntest("planted", () => {});\n`;')).toBe(0);
  });

  test("counts a call inside a template literal's expression", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the text under test is a template literal's source.
    expect(countTests('const s = `${it("x", () => {})}`;')).toBe(1);
  });

  test("is zero for an empty file", () => {
    expect(countTests("")).toBe(0);
  });
});

describe("countCodeLines", () => {
  test("counts every line holding code", () => {
    expect(countCodeLines(`const a = 1;\nconst b = 2;\nexport { a, b };\n`)).toBe(3);
  });

  test("skips blank lines, whitespace included", () => {
    expect(countCodeLines(`const a = 1;\n\n   \n\t\nconst b = 2;`)).toBe(2);
  });

  test("skips lines that hold only a // comment", () => {
    expect(countCodeLines(`// heading\n  // indented\nconst a = 1; // trailing\n`)).toBe(1);
  });

  test("skips every line inside a block comment that spans lines", () => {
    const source = `/**\n * A doc comment.\n *\n * @returns one\n */\nexport function one() {\n  return 1;\n}\n`;
    expect(countCodeLines(source)).toBe(3);
  });

  test("counts a line where code shares a line with a block comment", () => {
    expect(
      countCodeLines(`const a = 1; /* starts\n still a comment\n ends */ const b = 2;\n/* one line */ const c = 3;`),
    ).toBe(3);
  });

  test("reads comment markers inside strings as code", () => {
    const source = [
      `const url = "https://pithy.sh";`,
      `const glob = '/* not a comment';`,
      "const tpl = `",
      "  // not a comment either",
      "*/`;",
      `const after = 1;`,
    ].join("\n");
    expect(countCodeLines(source)).toBe(6);
    expect(countTests(`const s = "/*"; it("counted", () => {}); const e = "*/";`)).toBe(1);
  });

  test("reads comment markers inside a regex as code", () => {
    expect(countCodeLines(`const re = /\\/\\/ x/;\nconst cls = /[/*]/g;\nconst b = 1;`)).toBe(3);
  });

  test("reads a slash after a value as division, not a regex", () => {
    expect(countCodeLines(`const half = total / 2; // half\nconst q = (a) / b / c;\nconst r = 1;`)).toBe(3);
  });

  test("reads a slash after a keyword as a regex, even after another word", () => {
    expect(countCodeLines(`if (a) x();\nelse return /\\/*/.test(a);\nconst b = 1;\nconst c = 2;`)).toBe(4);
  });

  test("ends an unterminated quote at its line, so a stray apostrophe in JSX text cannot swallow the file", () => {
    const source = `const view = <p>Don't stop</p>;\n// a comment\nconst b = 2;`;
    expect(countCodeLines(source)).toBe(2);
  });

  test("is zero for an empty file", () => {
    expect(countCodeLines("")).toBe(0);
  });
});

describe("tallyFile and countKit", () => {
  test("adds a test file's tests and a source file's code lines, and nothing else", () => {
    const counts = countKit([
      { path: "packages/core/src/a.ts", source: "const a = 1;\n\nexport { a };\n" },
      {
        path: "packages/core/src/a.test.ts",
        source: `import { a } from "./a";\ntest("a", () => {});\nit.each([1])("b", () => {});\n`,
      },
      { path: "packages/ui-react/src/B.tsx", source: "export const B = () => <b />;\n" },
    ]);
    expect(counts).toEqual({ tests: 2, codeLines: 3 });
  });

  test("ignores a file outside packages/*/src/", () => {
    const counts = countKit([
      { path: "packages/core/templates/x/src/a.ts", source: "const a = 1;\n" },
      { path: "packages/core/scripts/a.test.ts", source: `test("a", () => {});\n` },
      { path: "docs/a.ts", source: "const a = 1;\n" },
    ]);
    expect(counts).toEqual({ tests: 0, codeLines: 0 });
  });

  test("an empty file adds nothing", () => {
    const empty = { tests: 0, codeLines: 0 };
    expect(tallyFile(empty, "packages/core/src/empty.ts", "")).toEqual(empty);
    expect(tallyFile(empty, "packages/core/src/empty.test.ts", "")).toEqual(empty);
  });
});
