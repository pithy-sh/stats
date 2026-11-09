import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { MAX_FILE_BYTES, MAX_NAME_BYTES, type TarFile, tarFiles } from "./tar";
import { chunked, tarArchive } from "./testing";

const decoder = new TextDecoder();

async function read(
  stream: ReadableStream<Uint8Array>,
  select: (path: string) => boolean = () => true,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for await (const file of tarFiles(stream, select)) files[file.path] = decoder.decode(file.content);
  return files;
}

/** Rewrite the size field of the header at `offset` in `archive`, and its checksum to match. */
function setSize(archive: Uint8Array, offset: number, size: number): void {
  const header = archive.subarray(offset, offset + 512);
  const encoder = new TextEncoder();
  header.set(encoder.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
  header.fill(0x20, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
}

/** A stream of `archive` in 512-byte chunks that counts what has been pulled from it and whether it was cancelled. */
function watched(archive: Uint8Array): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
  cancelled: () => boolean;
} {
  let offset = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull: (controller) => {
        if (offset >= archive.length) controller.close();
        else {
          controller.enqueue(archive.slice(offset, offset + 512));
          offset += 512;
        }
      },
      cancel: () => {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => offset, cancelled: () => cancelled };
}

describe("tarFiles", () => {
  test("yields each regular file's path and content", async () => {
    const archive = tarArchive({ "a.ts": "const a = 1;\n", "dir/b.ts": "export {};\n" }, "top");
    expect(await read(chunked(archive, 4096))).toEqual({
      "top/a.ts": "const a = 1;\n",
      "top/dir/b.ts": "export {};\n",
    });
  });

  test("reads the same across any chunk size, a header split mid-block included", async () => {
    const content = "x".repeat(1500);
    const archive = tarArchive({ "a.ts": content, "b.ts": "", "c.ts": "c" }, "top");
    for (const size of [1, 7, 511, 512, 513, 100_000]) {
      expect(await read(chunked(archive, size)), String(size)).toEqual({
        "top/a.ts": content,
        "top/b.ts": "",
        "top/c.ts": "c",
      });
    }
  });

  test("buffers only the files selected, and passes every other entry by", async () => {
    const archive = tarArchive({ "keep.ts": "kept", "skip.md": "y".repeat(5000), "also.ts": "also" }, "top");
    const asked: string[] = [];
    const files = await read(chunked(archive, 300), (path) => {
      asked.push(path);
      return path.endsWith(".ts");
    });
    expect(files).toEqual({ "top/keep.ts": "kept", "top/also.ts": "also" });
    expect(asked).toEqual(["top/keep.ts", "top/skip.md", "top/also.ts"]);
  });

  test("never yields a directory, a link or a pax global header", async () => {
    const archive = tarArchive(
      { src: { type: "directory" }, "link.ts": { type: "symlink", target: "a.ts" }, "a.ts": "a" },
      "top",
    );
    expect(await read(chunked(archive, 512))).toEqual({ "top/a.ts": "a" });
  });

  test.each(["pax", "gnu", "ustar"] as const)("reads a long path written as a %s name", async (longName) => {
    const path = `packages/${"deep/".repeat(25)}file.ts`;
    const archive = tarArchive({ [path]: { type: "file", content: "long", longName } }, "top");
    expect(await read(chunked(archive, 1000))).toEqual({ [`top/${path}`]: "long" });
  });

  test("reads a size written in base-256", async () => {
    const content = "q".repeat(1500);
    const archive = tarArchive({ "a.ts": content, "b.ts": "b" }, "top");
    const header = archive.subarray(1024, 1536);
    header.fill(0, 124, 136);
    header[124] = 0x80;
    header[134] = 1500 >> 8;
    header[135] = 1500 & 0xff;
    header.fill(0x20, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    expect(await read(chunked(archive, 512))).toEqual({ "top/a.ts": content, "top/b.ts": "b" });
  });

  test("throws when the archive ends inside an entry", async () => {
    const archive = tarArchive({ "a.ts": "z".repeat(2000) }, "top");
    const error = await read(chunked(archive.slice(0, 1024 + 700), 512)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
  });

  test("throws on a header whose checksum does not match", async () => {
    const archive = tarArchive({ "a.ts": "a" }, "top");
    archive[1024 + 10] = 0x41;
    const error = await read(chunked(archive, 512)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.detail).toContain("checksum");
  });

  test("an archive of no entries yields nothing", async () => {
    expect(await read(chunked(new Uint8Array(1024), 512))).toEqual({});
    expect(await read(chunked(new Uint8Array(0), 512))).toEqual({});
  });

  test("cancels the stream when the reader stops early", async () => {
    const archive = tarArchive({ "a.ts": "a", "b.ts": "b" }, "top");
    let cancelled = false;
    const inner = chunked(archive, 512).getReader();
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const { done, value } = await inner.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: () => {
        cancelled = true;
      },
    });
    const seen: TarFile[] = [];
    for await (const file of tarFiles(stream, () => true)) {
      seen.push(file);
      break;
    }
    expect(seen).toHaveLength(1);
    expect(cancelled).toBe(true);
  });

  test("throws on a selected file larger than the cap before reading any of it", async () => {
    const archive = tarArchive({ "a.ts": "a".repeat(5000) }, "top");
    setSize(archive, 1024, MAX_FILE_BYTES + 1);
    const { stream, pulled, cancelled } = watched(archive);
    const error = await read(stream).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.detail).toContain("top/a.ts");
    expect((error as PithyError).payload.detail).toContain(String(MAX_FILE_BYTES + 1));
    expect(pulled()).toBe(1536);
    expect(cancelled()).toBe(true);
  });

  test("passes by an unselected file larger than the cap", async () => {
    const big = "m".repeat(MAX_FILE_BYTES + 1);
    const archive = tarArchive({ "big.md": big, "a.ts": "a" }, "top");
    expect(await read(chunked(archive, 65_536), (path) => path.endsWith(".ts"))).toEqual({ "top/a.ts": "a" });
  });

  test.each(["pax", "gnu"] as const)(
    "throws on a %s name body larger than the cap before reading it",
    async (longName) => {
      const archive = tarArchive({ "a.ts": { type: "file", content: "a", longName } }, "top");
      setSize(archive, 1024, MAX_NAME_BYTES + 1);
      const { stream, pulled, cancelled } = watched(archive);
      const error = await read(stream).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.detail).toContain(String(MAX_NAME_BYTES + 1));
      expect(pulled()).toBe(1536);
      expect(cancelled()).toBe(true);
    },
  );
});
