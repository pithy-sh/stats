import { z } from "zod";

/**
 * The counting rules for the kit's source: which files are read, what a test is, and what a code line is. Pure over
 * a file's path and text, so each rule is tested without an archive.
 */

export const KitCounts = z
  .object({
    tests: z.number().int().nonnegative().describe("`it(` and `test(` calls in the kit's test files."),
    codeLines: z
      .number()
      .int()
      .nonnegative()
      .describe("Lines in the kit's non-test files holding code: not blank, not only a comment."),
  })
  .describe("The kit's tests and code lines, counted over `.ts` and `.tsx` files under `packages/*/src/`.");
export type KitCounts = z.output<typeof KitCounts>;

/** A path relative to the repository root: `packages/<package>/src/`, then any depth, ending `.ts` or `.tsx`. */
const KIT_SOURCE = /^packages\/[^/]+\/src\/(?:.+\/)?[^/]+\.tsx?$/;
const TEST_FILE = /\.test\.tsx?$/;

/** Whether the counter reads the file at `path`, relative to the repository root. */
export function isKitSource(path: string): boolean {
  return KIT_SOURCE.test(path);
}

/** Whether the file at `path` is a test file, whose tests are counted instead of its lines. */
export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/** Words after which a `/` starts a regex rather than dividing. */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);
const IDENTIFIER = /[\w$]/;

/** One file read as a lexer reads it. */
interface Scan {
  /** The text with comments, regex bodies and string contents blanked to spaces; quotes and newlines kept. */
  code: string;
  /** Per line, whether it holds anything outside a comment and whitespace. */
  codeLines: boolean[];
}

/**
 * Lex `source` far enough to tell code from comments and strings. Template literals nest through `${…}`. A `/` is a
 * regex when what precedes it cannot end a value. JSX text is not parsed: a quote in it reads as a string to the end
 * of its line, since a quoted string never spans one.
 */
function scan(source: string): Scan {
  const code: string[] = [];
  const codeLines: boolean[] = [false];
  /** For each open template expression, the brace depth its `${` was opened at. */
  const templates: number[] = [];
  let depth = 0;
  let previous = "";
  /** The identifier ending at the last significant character, or empty when that character ends none. */
  let word = "";
  /** Whether whitespace or a comment came after the last significant character. */
  let gap = false;
  let i = 0;

  const keep = (ch: string, isCode: boolean) => {
    if (ch === "\n") {
      code.push("\n");
      codeLines.push(false);
      return;
    }
    code.push(ch);
    if (isCode && ch.trim() !== "") codeLines[codeLines.length - 1] = true;
  };
  const blank = (ch: string, isCode: boolean) => {
    if (ch === "\n") return keep(ch, isCode);
    if (isCode && ch.trim() !== "") codeLines[codeLines.length - 1] = true;
    code.push(" ");
  };
  const significant = (ch: string) => {
    word = IDENTIFIER.test(ch) ? (gap || !IDENTIFIER.test(previous) ? ch : word + ch) : "";
    previous = ch;
    gap = false;
  };

  /** Read template text from `i`, just past its opening backtick or a closing `}`, to its close or next `${`. */
  const templateText = () => {
    while (i < source.length) {
      const ch = source[i] as string;
      if (ch === "\\") {
        blank(ch, true);
        if (i + 1 < source.length) blank(source[i + 1] as string, true);
        i += 2;
        continue;
      }
      if (ch === "`") {
        keep(ch, true);
        i++;
        significant("`");
        return;
      }
      if (ch === "$" && source[i + 1] === "{") {
        keep("$", true);
        keep("{", true);
        i += 2;
        templates.push(depth);
        depth++;
        significant("{");
        return;
      }
      blank(ch, true);
      i++;
    }
  };

  /** The index of the `/` closing a regex opened at `start`, or -1 when none closes on this line. */
  const regexEnd = (start: number): number => {
    let inClass = false;
    for (let j = start + 1; j < source.length; j++) {
      const ch = source[j];
      if (ch === "\n") return -1;
      if (ch === "\\") j++;
      else if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) return j;
    }
    return -1;
  };

  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") blank(source[i++] as string, false);
      gap = true;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      while (i < end) blank(source[i++] as string, false);
      gap = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      keep(ch, true);
      i++;
      while (i < source.length) {
        const inner = source[i] as string;
        if (inner === "\n") break;
        if (inner === "\\") {
          blank(inner, true);
          if (i + 1 < source.length) blank(source[i + 1] as string, true);
          i += 2;
          continue;
        }
        i++;
        if (inner === ch) {
          keep(inner, true);
          break;
        }
        blank(inner, true);
      }
      significant(ch);
      continue;
    }
    if (ch === "`") {
      keep(ch, true);
      i++;
      templateText();
      continue;
    }
    if (ch === "/") {
      const value = IDENTIFIER.test(previous) || previous === ")" || previous === "]" || previous === "}";
      const end = value && !REGEX_AFTER_WORD.has(word) ? -1 : regexEnd(i);
      if (end !== -1) {
        while (i <= end) blank(source[i++] as string, true);
        significant("/");
        continue;
      }
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        keep(ch, true);
        i++;
        templateText();
        continue;
      }
    }
    keep(ch, true);
    if (ch.trim() !== "") significant(ch);
    else gap = true;
    i++;
  }
  return { code: code.join(""), codeLines };
}

/** The modifiers a test call may chain: each still declares one test. */
const MODIFIERS = "each|for|skip|only|todo|concurrent|sequential|fails|skipIf|runIf";
/**
 * `it` or `test`, not a property, not part of a longer name and not a function's declared name, then any chain of
 * modifiers. Whether a call follows is checked by `callOpens`, since type arguments can nest.
 */
const TEST_CALL = new RegExp(
  `(?<![\\w$])(?<!\\.\\s*)(?<!\\bfunction\\s*\\*?\\s*)\\b(?:it|test)\\s*((?:\\.\\s*(?:${MODIFIERS})\\b\\s*)*)`,
  "g",
);
const WHITESPACE = /\s/;

/**
 * In lexed `code`, the character opening the call that starts at `from`, past whitespace and any type-argument list
 * `<…>` (nested brackets and `=>` included), or undefined when no call opens there.
 */
function callOpens(code: string, from: number): string | undefined {
  let i = from;
  while (i < code.length && WHITESPACE.test(code[i] as string)) i++;
  if (code[i] === "<") {
    let depth = 0;
    for (; i < code.length; i++) {
      const ch = code[i];
      if (ch === ";") return undefined;
      if (ch === "<") depth++;
      else if (ch === ">" && code[i - 1] !== "=" && --depth === 0) break;
    }
    i++;
    while (i < code.length && WHITESPACE.test(code[i] as string)) i++;
  }
  return code[i];
}

/** `it(` and `test(` calls in `source`, outside strings and comments; each form counts once. */
export function countTests(source: string): number {
  const { code } = scan(source);
  let tests = 0;
  for (const match of code.matchAll(TEST_CALL)) {
    const chain = match[1] ?? "";
    const opens = callOpens(code, (match.index ?? 0) + match[0].length);
    if (opens === "(" || (opens === "`" && /\b(?:each|for)\b/.test(chain))) tests++;
  }
  return tests;
}

/** Lines of `source` holding code: not blank, not only a `//` comment, not inside a block comment. */
export function countCodeLines(source: string): number {
  return scan(source).codeLines.filter(Boolean).length;
}

/** `counts` with the file at `path` added: its tests when it is a test file, else its code lines. */
export function tallyFile(counts: KitCounts, path: string, source: string): KitCounts {
  if (!isKitSource(path)) return counts;
  return isTestFile(path)
    ? { tests: counts.tests + countTests(source), codeLines: counts.codeLines }
    : { tests: counts.tests, codeLines: counts.codeLines + countCodeLines(source) };
}

/** The counts over every file given, by path and text. */
export function countKit(files: Iterable<{ path: string; source: string }>): KitCounts {
  let counts: KitCounts = { tests: 0, codeLines: 0 };
  for (const file of files) counts = tallyFile(counts, file.path, file.source);
  return counts;
}
