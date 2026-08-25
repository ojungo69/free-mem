import { Buffer } from "node:buffer";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

import { decodeUtf8, parseIJson } from "../../../harness/schema/jcs.ts";

function readBoundedIJson(descriptor, maxBytes) {
  const before = fstatSync(descriptor, { bigint: true });
  if (before.isFile() && before.size > BigInt(maxBytes)) {
    throw new Error("result input exceeds the fixed byte limit");
  }
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytesRead = 0;
  for (let size; (size = readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) {
    bytesRead += size;
    if (bytesRead > maxBytes) throw new Error("result input exceeds the fixed byte limit");
    chunks.push(Buffer.from(buffer.subarray(0, size)));
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (before.isFile() && (BigInt(bytesRead) !== after.size ||
      ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some((name) => before[name] !== after[name]))) {
    throw new Error("result input changed while it was being read");
  }
  const bytes = Buffer.concat(chunks, bytesRead);
  return parseIJson(decodeUtf8(bytes, "candidate result"));
}

export function readBoundedIJsonFile(path, maxBytes) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    return readBoundedIJson(descriptor, maxBytes);
  } finally {
    closeSync(descriptor);
  }
}

export function readBoundedIJsonStdin(maxBytes) {
  return readBoundedIJson(0, maxBytes);
}
