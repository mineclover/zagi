/**
 * zagi-server: Git proxy for multi-user trajectories
 *
 * A git-compatible server where each user gets their own "repo" stored in SQLite.
 * No git binary required - can run in Durable Objects.
 *
 * URL scheme: http://server/<repo>/<user-id>
 * Example: git clone http://localhost:3000/my-app/alice
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { join, resolve } from "path";

import { handleGitHttpSqlite } from "./git-http-sqlite.ts";

// Configuration
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const DATA_DIR = resolve(process.env.DATA_DIR ?? "./.data");
const DBS_DIR = join(DATA_DIR, "dbs"); // Per-user SQLite databases

// Cache of open databases
const dbCache = new Map<string, Database>();

/**
 * Get or create a database for a repo/user combination
 */
function getDb(repo: string, userId: string): Database {
  const key = `${repo}/${userId}`;

  // Check cache
  let db = dbCache.get(key);
  if (db) return db;

  // Create/open database
  const dbPath = join(DBS_DIR, repo, `${userId}.sqlite`);
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent performance
  db.run("PRAGMA journal_mode = WAL");

  dbCache.set(key, db);
  return db;
}

/**
 * Main server
 */
async function main() {
  // Ensure data directories exist
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(DBS_DIR, { recursive: true });

  console.log(`data: ${DATA_DIR}`);

  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // Health check
      if (path === "/health") {
        return Response.json({ status: "ok" });
      }

      // Git HTTP protocol: /<repo>/<user>/info/refs, /git-upload-pack, /git-receive-pack
      const gitResponse = await handleGitHttpSqlite(req, url, {
        getDb: (repo, userId) => {
          // Ensure repo directory exists
          const repoDir = join(DBS_DIR, repo);
          if (!existsSync(repoDir)) {
            Bun.spawnSync(["mkdir", "-p", repoDir]);
          }
          return getDb(repo, userId);
        },
      });
      if (gitResponse) return gitResponse;

      // API info
      if (path === "/" || path === "/api") {
        return Response.json({
          name: "zagi-server",
          version: "0.3.0",
          description: "Git proxy with SQLite storage - no git binary needed",
          usage: {
            clone: "git clone http://localhost:3000/<repo>/<user-id>",
            push: "git push origin main",
            pull: "git pull origin main",
          },
          storage: "SQLite (Durable Objects compatible)",
        });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

  console.log(`server: http://localhost:${server.port}`);
  console.log(`\nUsage:`);
  console.log(`  git clone http://localhost:${server.port}/my-app/alice`);
  console.log(`  cd my-app`);
  console.log(`  # make changes...`);
  console.log(`  git push origin main`);
  console.log(`\nStorage: SQLite databases in ${DBS_DIR}/<repo>/<user>.sqlite`);
}

// Run
main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
