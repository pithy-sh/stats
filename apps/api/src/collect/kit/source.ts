import { PithyError, UpstreamError } from "@pithy-sh/core/src/error/pithyError";
import { isKitSource, type KitCounts, tallyFile } from "./count";
import { tarFiles } from "./tar";

const decoder = new TextDecoder();

/** A path inside GitHub's tarball, relative to the repository root: the archive's top-level directory dropped. */
export function repositoryPath(archivePath: string): string {
  const slash = archivePath.indexOf("/");
  return slash === -1 ? "" : archivePath.slice(slash + 1);
}

/**
 * Count the kit out of its gzipped tarball as it streams in: gunzip, read the tar entries, and tally each `.ts` and
 * `.tsx` file under `packages/*\/src/`, one file at a time. Throws when no such file is found, since a layout the
 * counter does not recognise would otherwise publish zeros.
 */
export async function countTarball(gzipped: ReadableStream<Uint8Array>): Promise<KitCounts> {
  let counts: KitCounts = { tests: 0, codeLines: 0 };
  let files = 0;
  try {
    const tar = gzipped.pipeThrough(new DecompressionStream("gzip"));
    for await (const file of tarFiles(tar, (path) => isKitSource(repositoryPath(path)))) {
      counts = tallyFile(counts, repositoryPath(file.path), decoder.decode(file.content));
      files++;
    }
  } catch (cause) {
    if (cause instanceof PithyError) throw cause;
    throw new UpstreamError({ detail: "The kit's tarball could not be read as gzipped tar." }, { cause });
  }
  if (files === 0) {
    throw new UpstreamError({ detail: "The kit's tarball holds no .ts or .tsx file under packages/*/src/." });
  }
  return counts;
}
