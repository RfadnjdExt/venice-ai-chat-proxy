#!/usr/bin/env node
// Like `tee`, but the log file is size-capped: stdin is copied to stdout and
// appended to <file>; once the file would grow past the limit it is renamed to
// <file>.1 (older copies shift to .2, .3, ...) and a fresh file is started.
//
// Usage: <command> 2>&1 | node scripts/log-rotate.mjs <file>
//   LOG_MAX_BYTES  size limit per file (default 10485760 = 10 MiB; k/m/g suffixes allowed)
//   LOG_KEEP       rotated copies to keep (default 3)
// Disk use is at most about LOG_MAX_BYTES × (LOG_KEEP + 1).

import fs from "node:fs";

function parseSize(value, fallback) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmg]?)i?b?\s*$/i.exec(value ?? "");
  if (!match) {
    return fallback;
  }
  const scale = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase()];
  const bytes = Math.floor(Number(match[1]) * scale);
  return bytes > 0 ? bytes : fallback;
}

const file = process.argv[2];
if (!file) {
  console.error("usage: <command> 2>&1 | node scripts/log-rotate.mjs <file>");
  process.exit(2);
}
const maxBytes = parseSize(process.env.LOG_MAX_BYTES, 10 * 1024 ** 2);
const keepRaw = Number.parseInt(process.env.LOG_KEEP ?? "", 10);
const keep = Number.isInteger(keepRaw) && keepRaw >= 0 ? keepRaw : 3;

let fd = fs.openSync(file, "a");
let size = fs.fstatSync(fd).size;

function rotate() {
  fs.closeSync(fd);
  if (keep === 0) {
    fs.rmSync(file, { force: true });
  } else {
    fs.rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i -= 1) {
      if (fs.existsSync(`${file}.${i}`)) {
        fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      }
    }
    fs.renameSync(file, `${file}.1`);
  }
  fd = fs.openSync(file, "a");
  size = 0;
}

// Split at the last newline that still fits, so a rotation does not cut a line
// in two; a single line longer than the limit is written whole.
function writeToFile(chunk) {
  let rest = chunk;
  while (rest.length > 0) {
    if (size + rest.length <= maxBytes) {
      fs.writeSync(fd, rest);
      size += rest.length;
      return;
    }
    const room = maxBytes - size;
    const cut = room > 0 ? rest.lastIndexOf(0x0a, room - 1) : -1;
    if (cut >= 0) {
      fs.writeSync(fd, rest.subarray(0, cut + 1));
      rest = rest.subarray(cut + 1);
    } else if (size === 0) {
      // Nothing written yet and the line alone is too long: keep it whole.
      const end = rest.indexOf(0x0a);
      const line = end >= 0 ? rest.subarray(0, end + 1) : rest;
      fs.writeSync(fd, line);
      size += line.length;
      rest = rest.subarray(line.length);
      continue;
    }
    rotate();
  }
}

let stdoutOpen = true;
process.stdout.on("error", () => {
  // Terminal gone (EPIPE): keep logging to the file.
  stdoutOpen = false;
});

// Ctrl+C reaches the whole pipeline. Stay alive until the command upstream
// exits and closes stdin, so its last lines still reach the file.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

process.stdin.on("data", (chunk) => {
  if (stdoutOpen) {
    process.stdout.write(chunk);
  }
  try {
    writeToFile(chunk);
  } catch (error) {
    console.error(`log-rotate: ${error.message}`);
  }
});
process.stdin.on("end", () => {
  fs.closeSync(fd);
});
