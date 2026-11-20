// SPDX-License-Identifier: MIT
import { readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/** The newest modification time (ms) under `paths`, walking directories as Cargo does. */
export function newestMtime(paths) {
  let newest = 0;
  const visit = (path) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    newest = Math.max(newest, stat.mtimeMs);
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  };
  for (const path of paths) visit(path);
  return newest;
}

/**
 * Write a generated archive through a temp file and rename, so concurrent builds never read
 * a torn one, dated to its newest input. Cargo reruns a build script when a watched file is
 * newer than the script's last start, and Tauri watches every bundle resource: an archive
 * dated "now" would rebuild the app once more on the next cargo command.
 */
export function writeBuildOutput(output, bytes, inputs) {
  const temp = `${output}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, bytes);
    const newest = newestMtime(inputs);
    if (newest > 0) utimesSync(temp, new Date(), new Date(newest));
    renameSync(temp, output);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function tarHeader(name, size, mtime) {
  const header = Buffer.alloc(512);
  const put = (value, offset, length) => header.write(value, offset, length, "utf8");
  const octal = (value, length) => value.toString(8).padStart(length - 1, "0");
  if (Buffer.byteLength(name) > 100) throw new Error(`tar path too long: ${name}`);
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(mtime, 12), 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${octal(sum, 7)}\0`, 148, 8);
  return header;
}

// The gzip header's OS byte (RFC 1952). zlib writes the build host's (3 on Linux, 19 on macOS), so
// it is pinned to 255, "unknown": the same inputs give the same archive bytes on every host.
const GZIP_OS_OFFSET = 9;
const GZIP_OS_UNKNOWN = 255;

/** A deterministic tar.gz of `[name, bytes]` entries, every entry dated `mtime`. */
export function tarGz(entries, mtime) {
  const parts = [];
  for (const [name, data] of entries) {
    parts.push(tarHeader(name, data.length, mtime), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(parts), { level: 9 });
  archive[GZIP_OS_OFFSET] = GZIP_OS_UNKNOWN;
  return archive;
}
