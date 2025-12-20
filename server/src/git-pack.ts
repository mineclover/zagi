/**
 * Git Pack Protocol Implementation
 *
 * Handles parsing and generating git packfiles for the smart HTTP protocol.
 * This allows git clients to push/pull without needing the git binary.
 *
 * Pack format:
 * - 4 bytes: "PACK"
 * - 4 bytes: version (network byte order, usually 2)
 * - 4 bytes: number of objects
 * - N objects (each with type, size, compressed data)
 * - 20 bytes: SHA-1 checksum of entire pack
 */

import { createHash } from "crypto";
import { inflateSync, deflateSync } from "zlib";
import type { Database } from "bun:sqlite";
import {
  storeObject,
  getObject,
  hasObject,
  type GitObjectType,
} from "./git-storage.ts";

// Object type numbers in pack format
const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

const typeToNum: Record<GitObjectType, number> = {
  commit: OBJ_COMMIT,
  tree: OBJ_TREE,
  blob: OBJ_BLOB,
  tag: OBJ_TAG,
};

const numToType: Record<number, GitObjectType> = {
  [OBJ_COMMIT]: "commit",
  [OBJ_TREE]: "tree",
  [OBJ_BLOB]: "blob",
  [OBJ_TAG]: "tag",
};

/**
 * Pkt-line helpers
 */
export function pktLine(data: string | Buffer): Buffer {
  const content = typeof data === "string" ? Buffer.from(data) : data;
  const len = content.length + 4;
  const lenHex = len.toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(lenHex), content]);
}

export function pktFlush(): Buffer {
  return Buffer.from("0000");
}

/**
 * Parse pkt-lines from a buffer
 */
export function* parsePktLines(data: Buffer): Generator<Buffer | null> {
  let offset = 0;

  while (offset < data.length) {
    if (offset + 4 > data.length) break;

    const lenHex = data.slice(offset, offset + 4).toString();
    const len = parseInt(lenHex, 16);

    if (len === 0) {
      // Flush packet
      yield null;
      offset += 4;
      continue;
    }

    if (len < 4 || offset + len > data.length) break;

    const content = data.slice(offset + 4, offset + len);
    yield content;
    offset += len;
  }
}

/**
 * Parse a packfile and store objects in SQLite
 */
export function parsePackfile(
  db: Database,
  packData: Buffer
): { count: number; hashes: string[] } {
  let offset = 0;

  // Check header
  const header = packData.slice(0, 4).toString();
  if (header !== "PACK") {
    throw new Error("Invalid pack header");
  }
  offset += 4;

  // Version
  const version = packData.readUInt32BE(offset);
  if (version !== 2 && version !== 3) {
    throw new Error(`Unsupported pack version: ${version}`);
  }
  offset += 4;

  // Object count
  const count = packData.readUInt32BE(offset);
  offset += 4;

  const hashes: string[] = [];
  const objectOffsets = new Map<number, { type: GitObjectType; data: Buffer; hash: string }>();

  for (let i = 0; i < count; i++) {
    const objOffset = offset;
    const result = parsePackObject(packData, offset, objectOffsets);
    offset = result.newOffset;

    // Store the object
    const hash = storeObject(db, result.type, result.data);
    hashes.push(hash);

    // Remember for delta resolution
    objectOffsets.set(objOffset, { type: result.type, data: result.data, hash });
  }

  return { count, hashes };
}

/**
 * Parse a single object from a packfile
 */
function parsePackObject(
  data: Buffer,
  offset: number,
  objectOffsets: Map<number, { type: GitObjectType; data: Buffer; hash: string }>
): { type: GitObjectType; data: Buffer; newOffset: number } {
  const startOffset = offset;

  // First byte: type (bits 4-6) and size (bits 0-3)
  let byte = data[offset++]!;
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;

  // Variable-length size encoding
  while (byte & 0x80) {
    byte = data[offset++]!;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }

  // Handle delta objects
  if (type === OBJ_REF_DELTA) {
    // 20 bytes: base object SHA-1
    const baseHash = data.slice(offset, offset + 20).toString("hex");
    offset += 20;

    // Decompress delta data
    const { result: deltaData, bytesRead } = decompressObject(data, offset, size);
    offset += bytesRead;

    // Find base object (must already be stored)
    // For now, skip ref deltas - they require the base to be in the same pack or already stored
    throw new Error("REF_DELTA not yet supported - base object needed");
  }

  if (type === OBJ_OFS_DELTA) {
    // Variable-length negative offset to base object
    let baseOffset = 0;
    byte = data[offset++]!;
    baseOffset = byte & 0x7f;
    while (byte & 0x80) {
      byte = data[offset++]!;
      baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
    }

    const baseObjOffset = startOffset - baseOffset;
    const baseObj = objectOffsets.get(baseObjOffset);
    if (!baseObj) {
      throw new Error(`OFS_DELTA base not found at offset ${baseObjOffset}`);
    }

    // Decompress delta data
    const { result: deltaData, bytesRead } = decompressObject(data, offset, size);
    offset += bytesRead;

    // Apply delta
    const resultData = applyDelta(baseObj.data, deltaData);

    return { type: baseObj.type, data: resultData, newOffset: offset };
  }

  // Regular object - decompress
  const objType = numToType[type];
  if (!objType) {
    throw new Error(`Unknown object type: ${type}`);
  }

  const { result: objData, bytesRead } = decompressObject(data, offset, size);
  offset += bytesRead;

  return { type: objType, data: objData, newOffset: offset };
}

/**
 * Decompress a zlib-compressed object from the pack
 * Uses streaming inflate to find exact compressed size
 */
function decompressObject(
  data: Buffer,
  offset: number,
  expectedSize: number
): { result: Buffer; bytesRead: number } {
  // Use zlib's inflateRaw with a custom approach
  // Try with increasing buffer sizes and track consumed bytes
  const remaining = data.slice(offset);

  // inflateSync will throw if there's not enough data
  // We need to find how many bytes were consumed
  try {
    const result = inflateSync(remaining, { finishFlush: 2 }); // Z_SYNC_FLUSH

    // Unfortunately inflateSync doesn't tell us consumed bytes
    // We need to use a workaround: try decompress with increasing input sizes
    // until we get the expected output size, then that's our compressed size

    // Start with a reasonable estimate based on compression ratio
    let compressedSize = Math.ceil(expectedSize * 0.5) + 20;

    for (let size = 20; size <= remaining.length; size += 10) {
      try {
        const chunk = remaining.slice(0, size);
        const testResult = inflateSync(chunk);
        if (testResult.length >= expectedSize) {
          // Found it! Now binary search for exact size
          let lo = Math.max(1, size - 20);
          let hi = size;
          while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            try {
              const testChunk = remaining.slice(0, mid);
              inflateSync(testChunk);
              hi = mid;
            } catch {
              lo = mid + 1;
            }
          }
          return { result: testResult.slice(0, expectedSize), bytesRead: lo };
        }
      } catch {
        // Need more data
      }
    }

    // If all else fails, use the full decompression
    return { result: result.slice(0, expectedSize), bytesRead: remaining.length };
  } catch (e) {
    throw new Error(`Failed to decompress: ${e}`);
  }
}

/**
 * Apply a git delta to a base object
 * Delta format: source size (varint), target size (varint), instructions
 */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;

  // Read source size (varint)
  let sourceSize = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = delta[offset++]!;
    sourceSize |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);

  // Read target size (varint)
  let targetSize = 0;
  shift = 0;
  do {
    byte = delta[offset++]!;
    targetSize |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);

  const result = Buffer.alloc(targetSize);
  let resultOffset = 0;

  // Apply instructions
  while (offset < delta.length) {
    const cmd = delta[offset++]!;

    if (cmd & 0x80) {
      // Copy from base
      let copyOffset = 0;
      let copySize = 0;

      if (cmd & 0x01) copyOffset = delta[offset++]!;
      if (cmd & 0x02) copyOffset |= delta[offset++]! << 8;
      if (cmd & 0x04) copyOffset |= delta[offset++]! << 16;
      if (cmd & 0x08) copyOffset |= delta[offset++]! << 24;

      if (cmd & 0x10) copySize = delta[offset++]!;
      if (cmd & 0x20) copySize |= delta[offset++]! << 8;
      if (cmd & 0x40) copySize |= delta[offset++]! << 16;

      if (copySize === 0) copySize = 0x10000;

      base.copy(result, resultOffset, copyOffset, copyOffset + copySize);
      resultOffset += copySize;
    } else if (cmd > 0) {
      // Insert new data
      delta.copy(result, resultOffset, offset, offset + cmd);
      resultOffset += cmd;
      offset += cmd;
    } else {
      throw new Error("Invalid delta instruction");
    }
  }

  return result;
}

/**
 * Generate a packfile from a list of object hashes
 */
export function generatePackfile(db: Database, hashes: string[]): Buffer {
  const parts: Buffer[] = [];

  // Header
  const header = Buffer.alloc(12);
  header.write("PACK", 0);
  header.writeUInt32BE(2, 4); // version 2
  header.writeUInt32BE(hashes.length, 8);
  parts.push(header);

  // Objects
  for (const hash of hashes) {
    const obj = getObject(db, hash);
    if (!obj) continue;

    const typeNum = typeToNum[obj.type];
    const compressed = deflateSync(obj.data);

    // Encode type and size
    const sizeBytes = encodeTypeAndSize(typeNum, obj.size);
    parts.push(sizeBytes, compressed);
  }

  // Compute checksum
  const pack = Buffer.concat(parts);
  const checksum = createHash("sha1").update(pack).digest();
  parts.push(checksum);

  return Buffer.concat(parts);
}

/**
 * Encode object type and size for pack format
 */
function encodeTypeAndSize(type: number, size: number): Buffer {
  const bytes: number[] = [];

  // First byte: type in bits 4-6, size bits 0-3
  let firstByte = (type << 4) | (size & 0x0f);
  size >>= 4;

  if (size > 0) {
    firstByte |= 0x80;
  }
  bytes.push(firstByte);

  // Remaining size bytes
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }

  return Buffer.from(bytes);
}

/**
 * Generate ref advertisement for info/refs endpoint
 */
export function generateRefAdvertisement(
  db: Database,
  service: string,
  refs: { name: string; hash: string }[]
): Buffer {
  const parts: Buffer[] = [];

  // Service announcement
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(pktFlush());

  if (refs.length === 0) {
    // Empty repo - advertise capabilities on a zero ref
    const caps = "report-status delete-refs ofs-delta";
    parts.push(pktLine(`0000000000000000000000000000000000000000 capabilities^{}\0${caps}\n`));
  } else {
    // First ref includes capabilities
    const caps = "report-status delete-refs ofs-delta";
    const first = refs[0]!;
    parts.push(pktLine(`${first.hash} ${first.name}\0${caps}\n`));

    // Remaining refs
    for (let i = 1; i < refs.length; i++) {
      const ref = refs[i]!;
      parts.push(pktLine(`${ref.hash} ${ref.name}\n`));
    }
  }

  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/**
 * Parse upload-pack request (want/have lines)
 */
export function parseUploadPackRequest(data: Buffer): {
  wants: string[];
  haves: string[];
  done: boolean;
} {
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;

  for (const line of parsePktLines(data)) {
    if (line === null) continue;

    const str = line.toString().trim();
    if (str.startsWith("want ")) {
      wants.push(str.slice(5, 45)); // 40 char hash
    } else if (str.startsWith("have ")) {
      haves.push(str.slice(5, 45));
    } else if (str === "done") {
      done = true;
    }
  }

  return { wants, haves, done };
}

/**
 * Parse receive-pack request (ref updates + packfile)
 */
export function parseReceivePackRequest(data: Buffer): {
  updates: { oldHash: string; newHash: string; refName: string }[];
  packData: Buffer | null;
} {
  const updates: { oldHash: string; newHash: string; refName: string }[] = [];
  let packStart = -1;
  let offset = 0;

  // Parse ref updates
  for (const line of parsePktLines(data)) {
    if (line === null) {
      // Flush packet - pack data follows
      offset = data.indexOf(Buffer.from("0000"), offset) + 4;
      packStart = offset;
      break;
    }

    const str = line.toString();
    // Format: old-hash new-hash refname\0capabilities
    const match = str.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) ([^\0\n]+)/);
    if (match) {
      updates.push({
        oldHash: match[1]!,
        newHash: match[2]!,
        refName: match[3]!,
      });
    }

    offset += 4 + line.length;
  }

  // Check for pack data
  let packData: Buffer | null = null;
  if (packStart >= 0 && packStart < data.length) {
    const remaining = data.slice(packStart);
    if (remaining.slice(0, 4).toString() === "PACK") {
      packData = remaining;
    }
  }

  return { updates, packData };
}

/**
 * Collect all objects reachable from a commit (for generating a pack)
 */
export function collectReachableObjects(
  db: Database,
  startHashes: string[],
  excludeHashes: string[] = []
): string[] {
  const collected = new Set<string>();
  const excluded = new Set(excludeHashes);
  const queue = [...startHashes];

  while (queue.length > 0) {
    const hash = queue.shift()!;
    if (collected.has(hash) || excluded.has(hash)) continue;

    const obj = getObject(db, hash);
    if (!obj) continue;

    collected.add(hash);

    if (obj.type === "commit") {
      // Parse commit to get tree and parents
      const content = obj.data.toString();
      const lines = content.split("\n");
      for (const line of lines) {
        if (line.startsWith("tree ")) {
          queue.push(line.slice(5));
        } else if (line.startsWith("parent ")) {
          queue.push(line.slice(7));
        } else if (line === "") {
          break;
        }
      }
    } else if (obj.type === "tree") {
      // Parse tree to get child entries
      let off = 0;
      const data = obj.data;
      while (off < data.length) {
        const spaceIdx = data.indexOf(0x20, off);
        if (spaceIdx === -1) break;
        const nullIdx = data.indexOf(0x00, spaceIdx + 1);
        if (nullIdx === -1) break;
        const entryHash = data.slice(nullIdx + 1, nullIdx + 21).toString("hex");
        queue.push(entryHash);
        off = nullIdx + 21;
      }
    }
  }

  return Array.from(collected);
}
