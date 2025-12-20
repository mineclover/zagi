/**
 * Pure SQLite Git Storage
 *
 * Implements git object storage without requiring the git binary.
 * This can run in Durable Objects with just SQLite.
 *
 * Git objects are content-addressed by SHA-1:
 * - blob: file content
 * - tree: directory listing (mode, name, hash)
 * - commit: tree hash, parent(s), author, message
 *
 * Refs are named pointers to commits (branches, tags, HEAD).
 */

import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { deflate, inflate } from "zlib";
import { promisify } from "util";

const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);

// Git object types
export type GitObjectType = "blob" | "tree" | "commit" | "tag";

export interface GitObject {
  type: GitObjectType;
  size: number;
  data: Buffer;
}

export interface TreeEntry {
  mode: string; // "100644" for file, "040000" for dir, "100755" for executable
  name: string;
  hash: string;
}

export interface CommitData {
  tree: string;
  parents: string[];
  author: { name: string; email: string; timestamp: number; tz: string };
  committer: { name: string; email: string; timestamp: number; tz: string };
  message: string;
}

/**
 * Initialize the SQLite schema for git storage
 */
export function initGitStorage(db: Database): void {
  // Git objects table - stores blobs, trees, commits, tags
  db.run(`
    CREATE TABLE IF NOT EXISTS git_objects (
      hash TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BLOB NOT NULL
    )
  `);

  // Refs table - branches, tags, HEAD
  db.run(`
    CREATE TABLE IF NOT EXISTS git_refs (
      name TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      symbolic INTEGER DEFAULT 0
    )
  `);

  // Create index for faster type lookups
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_git_objects_type ON git_objects(type)
  `);
}

/**
 * Compute SHA-1 hash of a git object
 * Git hashes: SHA1(type + ' ' + size + '\0' + content)
 */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`);
  const full = Buffer.concat([header, data]);
  return createHash("sha1").update(full).digest("hex");
}

/**
 * Store a git object
 */
export function storeObject(
  db: Database,
  type: GitObjectType,
  data: Buffer
): string {
  const hash = hashObject(type, data);

  // Check if already exists
  const existing = db
    .query("SELECT 1 FROM git_objects WHERE hash = ?")
    .get(hash);
  if (existing) return hash;

  // Store compressed
  db.run("INSERT INTO git_objects (hash, type, size, data) VALUES (?, ?, ?, ?)", [
    hash,
    type,
    data.length,
    data, // Store raw for now, could compress with zlib
  ]);

  return hash;
}

/**
 * Retrieve a git object
 */
export function getObject(db: Database, hash: string): GitObject | null {
  const row = db
    .query("SELECT type, size, data FROM git_objects WHERE hash = ?")
    .get(hash) as { type: string; size: number; data: Buffer } | null;

  if (!row) return null;

  return {
    type: row.type as GitObjectType,
    size: row.size,
    data: Buffer.from(row.data),
  };
}

/**
 * Check if an object exists
 */
export function hasObject(db: Database, hash: string): boolean {
  const row = db
    .query("SELECT 1 FROM git_objects WHERE hash = ?")
    .get(hash);
  return row !== null;
}

/**
 * Store a blob (file content)
 */
export function storeBlob(db: Database, content: Buffer | string): string {
  const data = typeof content === "string" ? Buffer.from(content) : content;
  return storeObject(db, "blob", data);
}

/**
 * Get blob content
 */
export function getBlob(db: Database, hash: string): Buffer | null {
  const obj = getObject(db, hash);
  if (!obj || obj.type !== "blob") return null;
  return obj.data;
}

/**
 * Create a tree object from entries
 */
export function createTree(db: Database, entries: TreeEntry[]): string {
  // Sort entries by name (git requirement)
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

  // Build tree data: mode + ' ' + name + '\0' + hash_bytes
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const modeName = Buffer.from(`${entry.mode} ${entry.name}\0`);
    const hashBytes = Buffer.from(entry.hash, "hex");
    parts.push(modeName, hashBytes);
  }

  const data = Buffer.concat(parts);
  return storeObject(db, "tree", data);
}

/**
 * Parse a tree object into entries
 */
export function parseTree(db: Database, hash: string): TreeEntry[] | null {
  const obj = getObject(db, hash);
  if (!obj || obj.type !== "tree") return null;

  const entries: TreeEntry[] = [];
  let offset = 0;
  const data = obj.data;

  while (offset < data.length) {
    // Find space after mode
    const spaceIdx = data.indexOf(0x20, offset);
    if (spaceIdx === -1) break;

    const mode = data.slice(offset, spaceIdx).toString();

    // Find null after name
    const nullIdx = data.indexOf(0x00, spaceIdx + 1);
    if (nullIdx === -1) break;

    const name = data.slice(spaceIdx + 1, nullIdx).toString();

    // Next 20 bytes are the hash
    const hashBytes = data.slice(nullIdx + 1, nullIdx + 21);
    const entryHash = hashBytes.toString("hex");

    entries.push({ mode, name, hash: entryHash });
    offset = nullIdx + 21;
  }

  return entries;
}

/**
 * Create a commit object
 */
export function createCommit(db: Database, commit: CommitData): string {
  const lines: string[] = [];

  lines.push(`tree ${commit.tree}`);
  for (const parent of commit.parents) {
    lines.push(`parent ${parent}`);
  }

  const { author, committer } = commit;
  lines.push(
    `author ${author.name} <${author.email}> ${author.timestamp} ${author.tz}`
  );
  lines.push(
    `committer ${committer.name} <${committer.email}> ${committer.timestamp} ${committer.tz}`
  );
  lines.push("");
  lines.push(commit.message);

  const data = Buffer.from(lines.join("\n"));
  return storeObject(db, "commit", data);
}

/**
 * Parse a commit object
 */
export function parseCommit(db: Database, hash: string): CommitData | null {
  const obj = getObject(db, hash);
  if (!obj || obj.type !== "commit") return null;

  const content = obj.data.toString();
  const lines = content.split("\n");

  let tree = "";
  const parents: string[] = [];
  let author = { name: "", email: "", timestamp: 0, tz: "+0000" };
  let committer = { name: "", email: "", timestamp: 0, tz: "+0000" };
  let messageStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") {
      messageStart = i + 1;
      break;
    }

    if (line.startsWith("tree ")) {
      tree = line.slice(5);
    } else if (line.startsWith("parent ")) {
      parents.push(line.slice(7));
    } else if (line.startsWith("author ")) {
      author = parseAuthorLine(line.slice(7));
    } else if (line.startsWith("committer ")) {
      committer = parseAuthorLine(line.slice(10));
    }
  }

  const message = lines.slice(messageStart).join("\n");

  return { tree, parents, author, committer, message };
}

/**
 * Parse author/committer line: "Name <email> timestamp tz"
 */
function parseAuthorLine(line: string): {
  name: string;
  email: string;
  timestamp: number;
  tz: string;
} {
  const match = line.match(/^(.+) <(.+)> (\d+) ([+-]\d{4})$/);
  if (!match) {
    return { name: "Unknown", email: "unknown@unknown", timestamp: 0, tz: "+0000" };
  }
  return {
    name: match[1]!,
    email: match[2]!,
    timestamp: parseInt(match[3]!, 10),
    tz: match[4]!,
  };
}

/**
 * Get a ref (branch, tag, HEAD)
 */
export function getRef(db: Database, name: string): string | null {
  const row = db
    .query("SELECT hash, symbolic FROM git_refs WHERE name = ?")
    .get(name) as { hash: string; symbolic: number } | null;

  if (!row) return null;

  // If symbolic ref, follow it
  if (row.symbolic) {
    return getRef(db, row.hash);
  }

  return row.hash;
}

/**
 * Set a ref
 */
export function setRef(
  db: Database,
  name: string,
  hash: string,
  symbolic = false
): void {
  db.run(
    `INSERT OR REPLACE INTO git_refs (name, hash, symbolic) VALUES (?, ?, ?)`,
    [name, hash, symbolic ? 1 : 0]
  );
}

/**
 * Delete a ref
 */
export function deleteRef(db: Database, name: string): boolean {
  const result = db.run("DELETE FROM git_refs WHERE name = ?", [name]);
  return result.changes > 0;
}

/**
 * List all refs matching a pattern
 */
export function listRefs(
  db: Database,
  prefix = ""
): { name: string; hash: string }[] {
  const rows = db
    .query("SELECT name, hash, symbolic FROM git_refs WHERE name LIKE ?")
    .all(`${prefix}%`) as { name: string; hash: string; symbolic: number }[];

  return rows.map((row) => ({
    name: row.name,
    hash: row.symbolic ? getRef(db, row.hash) ?? row.hash : row.hash,
  }));
}

/**
 * Get all branches (refs/heads/*)
 */
export function listBranches(db: Database): { name: string; hash: string }[] {
  return listRefs(db, "refs/heads/").map((ref) => ({
    name: ref.name.replace("refs/heads/", ""),
    hash: ref.hash,
  }));
}

/**
 * Initialize a new repository with an empty commit
 */
export function initRepository(db: Database): string {
  initGitStorage(db);

  // Create empty tree
  const emptyTreeHash = createTree(db, []);

  // Create initial commit
  const now = Math.floor(Date.now() / 1000);
  const initialCommit = createCommit(db, {
    tree: emptyTreeHash,
    parents: [],
    author: { name: "System", email: "system@zagi.local", timestamp: now, tz: "+0000" },
    committer: { name: "System", email: "system@zagi.local", timestamp: now, tz: "+0000" },
    message: "Initial commit",
  });

  // Set refs
  setRef(db, "refs/heads/main", initialCommit);
  setRef(db, "HEAD", "refs/heads/main", true); // symbolic ref

  return initialCommit;
}

/**
 * Create a simple commit with file changes
 * This is a helper for basic operations - real git uses more complex staging
 */
export function simpleCommit(
  db: Database,
  branch: string,
  files: { path: string; content: string }[],
  message: string,
  author: { name: string; email: string }
): string {
  // Get current branch head
  const parentHash = getRef(db, `refs/heads/${branch}`);
  const parents = parentHash ? [parentHash] : [];

  // Get parent tree entries (if any)
  let existingEntries: TreeEntry[] = [];
  if (parentHash) {
    const parentCommit = parseCommit(db, parentHash);
    if (parentCommit) {
      existingEntries = parseTree(db, parentCommit.tree) ?? [];
    }
  }

  // Build new tree with file changes
  // Note: This is simplified - doesn't handle nested directories properly
  const entriesMap = new Map<string, TreeEntry>();
  for (const entry of existingEntries) {
    entriesMap.set(entry.name, entry);
  }

  for (const file of files) {
    const blobHash = storeBlob(db, file.content);
    entriesMap.set(file.path, {
      mode: "100644",
      name: file.path,
      hash: blobHash,
    });
  }

  const treeHash = createTree(db, Array.from(entriesMap.values()));

  // Create commit
  const now = Math.floor(Date.now() / 1000);
  const commitHash = createCommit(db, {
    tree: treeHash,
    parents,
    author: { ...author, timestamp: now, tz: "+0000" },
    committer: { ...author, timestamp: now, tz: "+0000" },
    message,
  });

  // Update branch ref
  setRef(db, `refs/heads/${branch}`, commitHash);

  return commitHash;
}

/**
 * Get commit history for a branch
 */
export function getHistory(
  db: Database,
  startHash: string,
  limit = 10
): CommitData[] {
  const history: CommitData[] = [];
  const seen = new Set<string>();
  const queue = [startHash];

  while (queue.length > 0 && history.length < limit) {
    const hash = queue.shift()!;
    if (seen.has(hash)) continue;
    seen.add(hash);

    const commit = parseCommit(db, hash);
    if (!commit) continue;

    history.push(commit);
    queue.push(...commit.parents);
  }

  return history;
}
