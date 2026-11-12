import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

const READ_CHUNK_BYTES = 64 * 1024;

/** A file that grows while a run is live, read forward one chunk at a time. */
export interface FileTail {
  /** The text appended since the previous call; empty when nothing new has landed. */
  read(): string;
}

export function createFileTail(file: string): FileTail {
  // One decoder per file: one character may straddle two reads, and `toString`
  // per chunk would corrupt it.
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  return {
    read() {
      let fd: number;
      try {
        fd = fs.openSync(file, "r");
      } catch (err) {
        // The shell has not created the file yet; anything else is a real read error.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw err;
      }
      try {
        const size = fs.fstatSync(fd).size;
        if (size <= offset) return "";
        const length = Math.min(size - offset, READ_CHUNK_BYTES);
        const bytes = Buffer.allocUnsafe(length);
        const read = fs.readSync(fd, bytes, 0, length, offset);
        offset += read;
        return decoder.write(bytes.subarray(0, read));
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}
