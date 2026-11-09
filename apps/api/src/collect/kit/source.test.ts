import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { countTarball, repositoryPath } from "./source";
import { chunked, gzip, tarArchive } from "./testing";

async function tgz(entries: Parameters<typeof tarArchive>[0]): Promise<ReadableStream<Uint8Array>> {
  return chunked(await gzip(tarArchive(entries)), 1000);
}

describe("repositoryPath", () => {
  test("drops the archive's top-level directory", () => {
    expect(repositoryPath("pithy-sh-pithy-0123abc/packages/core/src/a.ts")).toBe("packages/core/src/a.ts");
    expect(repositoryPath("pithy-sh-pithy-0123abc")).toBe("");
  });
});

describe("countTarball", () => {
  test("counts the kit's tests and code lines out of a gzipped tarball", async () => {
    const stream = await tgz({
      "README.md": "# Pithy\n",
      "packages/core/package.json": "{}",
      "packages/core/src/a.ts": "// a comment\nexport const a = 1;\n\nexport const b = 2;\n",
      "packages/core/src/a.test.ts": `test("a", () => {});\nit.each([1, 2])("b %i", () => {});\n`,
      "packages/ui-react/src/B.tsx": "export const B = () => <b />;\n",
      "packages/core/templates/app/src/c.ts": "const c = 3;\n",
      "packages/core/src/notes.md": "it('x')\n",
    });
    expect(await countTarball(stream)).toEqual({ tests: 2, codeLines: 3 });
  });

  test("throws when the archive holds no kit source at all, rather than counting zero", async () => {
    const error = await countTarball(await tgz({ "README.md": "# Pithy\n" })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.detail).toContain("packages/*/src/");
  });

  test("throws when the body is not gzip", async () => {
    const error = await countTarball(chunked(new TextEncoder().encode("not gzip at all"), 100)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PithyError);
  });
});
