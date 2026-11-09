/** One entry to put in a test archive. A string is a regular file's text. */
export type TarFixture =
  | string
  | { type: "directory" }
  | { type: "symlink"; target: string }
  | { type: "file"; content: string; longName?: "pax" | "gnu" | "ustar" };

const BLOCK = 512;
const encoder = new TextEncoder();

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, size: number, type: string, fields: { prefix?: string; linkname?: string } = {}) {
  const block = new Uint8Array(BLOCK);
  const put = (text: string, offset: number) => block.set(encoder.encode(text), offset);
  put(name.slice(0, 100), 0);
  put(octal(0o644, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(size, 12), 124);
  put(octal(0, 12), 136);
  put("        ", 148);
  put(type, 156);
  if (fields.linkname !== undefined) put(fields.linkname, 157);
  put("ustar\0", 257);
  put("00", 263);
  if (fields.prefix !== undefined) put(fields.prefix, 345);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function padded(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.length / BLOCK) * BLOCK);
  out.set(bytes);
  return out;
}

/** One pax record, `<length> <key>=<value>\n`, whose length counts itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = encoder.encode(body).length;
  while (`${length}${body}`.length !== length) length = encoder.encode(`${length}${body}`).length;
  return `${length}${body}`;
}

/**
 * A tar archive laid out as `git archive` lays out GitHub's tarball: a pax global header carrying the commit, then
 * every entry under one top-level directory. A file can name itself through a pax `path`, a GNU long name or the
 * ustar prefix, so each way a long path is written can be read back.
 */
export function tarArchive(entries: Record<string, TarFixture>, top = "pithy-sh-pithy-0123abc"): Uint8Array {
  const blocks: Uint8Array[] = [];
  const comment = encoder.encode(paxRecord("comment", "0123abc"));
  blocks.push(header("pax_global_header", comment.length, "g"), padded(comment));
  for (const [relative, entry] of Object.entries(entries)) {
    const path = `${top}/${relative}`;
    if (typeof entry !== "string" && entry.type === "directory") {
      blocks.push(header(`${path}/`, 0, "5"));
      continue;
    }
    if (typeof entry !== "string" && entry.type === "symlink") {
      blocks.push(header(path, 0, "2", { linkname: entry.target }));
      continue;
    }
    const content = encoder.encode(typeof entry === "string" ? entry : entry.content);
    const longName = typeof entry === "string" ? undefined : entry.longName;
    if (longName === "pax") {
      const record = encoder.encode(paxRecord("path", path));
      blocks.push(header("PaxHeaders/x", record.length, "x"), padded(record));
      blocks.push(header("truncated-name", content.length, "0"));
    } else if (longName === "gnu") {
      const name = encoder.encode(`${path}\0`);
      blocks.push(header("././@LongLink", name.length, "L"), padded(name));
      blocks.push(header("truncated-name", content.length, "0"));
    } else if (longName === "ustar") {
      const cut = path.lastIndexOf("/");
      blocks.push(header(path.slice(cut + 1), content.length, "0", { prefix: path.slice(0, cut) }));
    } else {
      blocks.push(header(path, content.length, "0"));
    }
    blocks.push(padded(content));
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

/** `bytes` as a stream that arrives in chunks of `size`, so a reader is tested across chunk boundaries. */
export function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

/** `bytes` gzipped, as GitHub serves a tarball. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
