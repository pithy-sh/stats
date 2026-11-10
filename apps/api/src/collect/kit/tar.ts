import { UpstreamError } from "@pithy-sh/core/src/error/pithyError";

/**
 * A streaming reader for the POSIX tar format `git archive` writes: ustar headers, with a pax extended header (or
 * a GNU long name) for a path that does not fit. It reads the stream as it arrives and holds at most one selected
 * file's content at a time; every other entry is passed by without being kept. An entry it would keep is refused
 * before any of it is read when its header claims more than the cap for its kind.
 */

const BLOCK = 512;

/** The most a pax extended header or GNU long name body may hold. */
export const MAX_NAME_BYTES = 64 * 1024;

/** The most a selected file may hold. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
const decoder = new TextDecoder();

/** One regular file read from an archive. */
export interface TarFile {
  /** Its full path inside the archive, top-level directory included. */
  path: string;
  content: Uint8Array;
}

/** Reads exact byte counts off a stream, keeping only what has arrived and not yet been taken. */
class ByteQueue {
  private readonly chunks: Uint8Array[] = [];
  private buffered = 0;
  private done = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  // Assigned by hand rather than as a parameter property: the `pithy` CLI loads pithy.config.ts, which imports
  // this module, under Node's type stripping, and that refuses parameter properties.
  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  /** Wait until `n` bytes are buffered or the stream has ended; answer whether they are. */
  private async fill(n: number): Promise<boolean> {
    while (this.buffered < n && !this.done) {
      const { done, value } = await this.reader.read();
      if (done) this.done = true;
      else if (value.length > 0) {
        this.chunks.push(value);
        this.buffered += value.length;
      }
    }
    return this.buffered >= n;
  }

  /** The next `n` bytes, or null when the stream ends first. */
  async take(n: number): Promise<Uint8Array | null> {
    if (!(await this.fill(n))) return null;
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0] as Uint8Array;
      const used = Math.min(chunk.length, n - offset);
      out.set(chunk.subarray(0, used), offset);
      offset += used;
      if (used === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(used);
    }
    this.buffered -= n;
    return out;
  }

  /** Drop the next `n` bytes as they arrive; answer false when the stream ends first. */
  async skip(n: number): Promise<boolean> {
    let left = n;
    while (left > 0) {
      if (this.chunks.length === 0 && !(await this.fill(1))) return false;
      const chunk = this.chunks[0] as Uint8Array;
      const used = Math.min(chunk.length, left);
      if (used === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(used);
      this.buffered -= used;
      left -= used;
    }
    return true;
  }
}

/** A NUL-terminated header field as text. */
function text(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

/** A numeric header field: octal text, or base-256 when its first byte's high bit is set. */
function number(block: Uint8Array, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length);
  if (((field[0] ?? 0) & 0x80) !== 0) {
    let value = (field[0] ?? 0) & 0x7f;
    for (let i = 1; i < field.length; i++) value = value * 256 + (field[i] ?? 0);
    return value;
  }
  const digits = text(block, offset, length).trim();
  return digits === "" ? 0 : Number.parseInt(digits, 8);
}

/** Whether a header's checksum, the byte sum with its own field read as spaces, matches the field. */
function checksumMatches(block: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] ?? 0);
  return sum === number(block, 148, 8);
}

/** The `path` a pax extended header sets, if it sets one. */
function paxPath(records: Uint8Array): string | undefined {
  let path: string | undefined;
  let offset = 0;
  while (offset < records.length) {
    const space = records.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(decoder.decode(records.subarray(offset, space)), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = decoder.decode(records.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    if (record.slice(0, equals) === "path") path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

/** Refuse an entry whose claimed `size` exceeds `cap`, before any of it is read. */
function checkSize(path: string, size: number, cap: number): void {
  if (size > cap) {
    throw new UpstreamError({
      detail: `The kit's tarball holds ${path} at ${size} bytes, over the ${cap}-byte limit for it.`,
    });
  }
}

function truncated(path: string): UpstreamError {
  return new UpstreamError({ detail: `The kit's tarball ended inside ${path}.` });
}

/**
 * Every regular file in the tar `stream` whose path `select` accepts, in archive order. Each file's content is read
 * only once it is selected, and the stream is cancelled if the caller stops early or anything throws.
 */
export async function* tarFiles(
  stream: ReadableStream<Uint8Array>,
  select: (path: string) => boolean,
): AsyncGenerator<TarFile> {
  const reader = stream.getReader();
  const bytes = new ByteQueue(reader);
  let finished = false;
  try {
    let longPath: string | undefined;
    for (;;) {
      const block = await bytes.take(BLOCK);
      if (block === null || block.every((byte) => byte === 0)) break;
      if (!checksumMatches(block)) {
        throw new UpstreamError({ detail: "The kit's tarball holds a header whose checksum does not match." });
      }
      const type = text(block, 156, 1);
      const size = number(block, 124, 12);
      const padding = (BLOCK - (size % BLOCK)) % BLOCK;
      const prefix = text(block, 345, 155);
      const name = text(block, 0, 100);
      const path = longPath ?? (prefix === "" ? name : `${prefix}/${name}`);

      if (type === "x" || type === "L") {
        checkSize(path, size, MAX_NAME_BYTES);
        const body = await bytes.take(size);
        if (body === null || !(await bytes.skip(padding))) throw truncated(path);
        longPath = type === "x" ? (paxPath(body) ?? longPath) : text(body, 0, body.length);
        continue;
      }
      longPath = undefined;
      const regular = type === "0" || type === "" || type === "7";
      if (regular && select(path)) {
        checkSize(path, size, MAX_FILE_BYTES);
        const content = await bytes.take(size);
        if (content === null || !(await bytes.skip(padding))) throw truncated(path);
        yield { path, content };
      } else if (!(await bytes.skip(size + padding))) {
        throw truncated(path);
      }
    }
    finished = true;
  } finally {
    if (finished) reader.releaseLock();
    else await reader.cancel().catch(() => undefined);
  }
}
