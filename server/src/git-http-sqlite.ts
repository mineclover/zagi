/**
 * Git Smart HTTP Handler - SQLite Backend
 *
 * This implements the git smart HTTP protocol using pure SQLite storage.
 * No git binary required - works in Durable Objects.
 *
 * URL scheme: /<repo>/<user-id>/[info/refs|git-upload-pack|git-receive-pack]
 */

import { Database } from "bun:sqlite";
import {
  initGitStorage,
  initRepository,
  getRef,
  setRef,
  listRefs,
  getObject,
  hasObject,
} from "./git-storage.ts";
import {
  pktLine,
  pktFlush,
  parsePackfile,
  generatePackfile,
  generateRefAdvertisement,
  parseUploadPackRequest,
  parseReceivePackRequest,
  collectReachableObjects,
} from "./git-pack.ts";

export interface GitHttpSqliteContext {
  getDb: (repo: string, userId: string) => Database;
}

/**
 * Parse the URL to extract repo name and user ID
 */
function parseGitUrl(pathname: string): {
  repo: string;
  userId: string;
  service: string | null;
} | null {
  const match = pathname.match(
    /^\/([^/]+)\/([^/]+)(\/info\/refs|\/git-upload-pack|\/git-receive-pack)?$/
  );
  if (!match) return null;

  return {
    repo: match[1]!,
    userId: match[2]!,
    service: match[3] ?? null,
  };
}

/**
 * Get or create a user's git database
 */
function ensureUserDb(
  ctx: GitHttpSqliteContext,
  repo: string,
  userId: string
): Database {
  const db = ctx.getDb(repo, userId);

  // Check if initialized
  const hasRefs = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='git_refs'")
    .get();

  if (!hasRefs) {
    // Initialize new repo
    initRepository(db);
  }

  return db;
}

/**
 * Handle GET /info/refs?service=git-upload-pack or git-receive-pack
 */
async function handleInfoRefs(
  db: Database,
  service: string
): Promise<Response> {
  // Get all refs
  const allRefs = listRefs(db);

  // Format refs for advertisement
  // Convert internal names and add HEAD
  const head = getRef(db, "HEAD");
  const refs: { name: string; hash: string }[] = [];

  if (head) {
    refs.push({ name: "HEAD", hash: head });
  }

  for (const ref of allRefs) {
    refs.push(ref);
  }

  const body = generateRefAdvertisement(db, service, refs);

  return new Response(body, {
    headers: {
      "Content-Type": `application/x-${service}-advertisement`,
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * Handle POST /git-upload-pack (fetch/clone)
 */
async function handleUploadPack(
  req: Request,
  db: Database
): Promise<Response> {
  const body = Buffer.from(await req.arrayBuffer());
  const { wants, haves, done } = parseUploadPackRequest(body);

  if (wants.length === 0) {
    // No objects wanted - return empty
    return new Response(pktFlush(), {
      headers: {
        "Content-Type": "application/x-git-upload-pack-result",
        "Cache-Control": "no-cache",
      },
    });
  }

  // Collect objects to send
  // Start from wanted commits, exclude objects the client already has
  const objectsToSend = collectReachableObjects(db, wants, haves);

  // Generate response
  const parts: Buffer[] = [];

  // NAK if no common objects, or ACK for each have we recognize
  if (haves.length === 0) {
    parts.push(pktLine("NAK\n"));
  } else {
    for (const have of haves) {
      if (hasObject(db, have)) {
        parts.push(pktLine(`ACK ${have}\n`));
      }
    }
    if (parts.length === 0) {
      parts.push(pktLine("NAK\n"));
    }
  }

  // Generate and send packfile (without side-band for simplicity)
  if (objectsToSend.length > 0) {
    const packfile = generatePackfile(db, objectsToSend);
    parts.push(packfile);
  }

  return new Response(Buffer.concat(parts), {
    headers: {
      "Content-Type": "application/x-git-upload-pack-result",
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * Handle POST /git-receive-pack (push)
 */
async function handleReceivePack(
  req: Request,
  db: Database
): Promise<Response> {
  const body = Buffer.from(await req.arrayBuffer());
  const { updates, packData } = parseReceivePackRequest(body);

  const results: { refName: string; ok: boolean; error?: string }[] = [];

  // Process packfile first (if any)
  if (packData) {
    try {
      parsePackfile(db, packData);
    } catch (e) {
      const error = e instanceof Error ? e.message : "Pack error";
      // All updates fail if pack fails
      for (const update of updates) {
        results.push({ refName: update.refName, ok: false, error });
      }

      return generateReceivePackResponse(results);
    }
  }

  // Process ref updates
  for (const update of updates) {
    try {
      const { oldHash, newHash, refName } = update;

      // Verify old hash matches current ref (for non-create operations)
      const currentHash = getRef(db, refName);
      const isCreate = oldHash === "0000000000000000000000000000000000000000";
      const isDelete = newHash === "0000000000000000000000000000000000000000";

      if (!isCreate && currentHash !== oldHash) {
        results.push({
          refName,
          ok: false,
          error: "non-fast-forward",
        });
        continue;
      }

      if (isDelete) {
        // Delete ref
        db.run("DELETE FROM git_refs WHERE name = ?", [refName]);
      } else {
        // Verify new object exists
        if (!hasObject(db, newHash)) {
          results.push({
            refName,
            ok: false,
            error: "missing object",
          });
          continue;
        }

        // Update ref
        setRef(db, refName, newHash);
      }

      results.push({ refName, ok: true });
    } catch (e) {
      const error = e instanceof Error ? e.message : "Update failed";
      results.push({ refName: update.refName, ok: false, error });
    }
  }

  return generateReceivePackResponse(results);
}

/**
 * Generate receive-pack response with status
 */
function generateReceivePackResponse(
  results: { refName: string; ok: boolean; error?: string }[]
): Response {
  const parts: Buffer[] = [];

  // Unpack status
  parts.push(pktLine("unpack ok\n"));

  // Ref statuses
  for (const result of results) {
    if (result.ok) {
      parts.push(pktLine(`ok ${result.refName}\n`));
    } else {
      parts.push(pktLine(`ng ${result.refName} ${result.error}\n`));
    }
  }

  parts.push(pktFlush());

  return new Response(Buffer.concat(parts), {
    headers: {
      "Content-Type": "application/x-git-receive-pack-result",
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * Main handler for git HTTP requests using SQLite storage
 */
export async function handleGitHttpSqlite(
  req: Request,
  url: URL,
  ctx: GitHttpSqliteContext
): Promise<Response | null> {
  const parsed = parseGitUrl(url.pathname);
  if (!parsed) return null;

  const { repo, userId, service } = parsed;

  // Get or create user's database
  const db = ensureUserDb(ctx, repo, userId);

  // GET /info/refs?service=git-upload-pack or git-receive-pack
  if (req.method === "GET" && service === "/info/refs") {
    const requestedService = url.searchParams.get("service");
    if (!requestedService) {
      return new Response("service parameter required", { status: 400 });
    }
    if (
      requestedService !== "git-upload-pack" &&
      requestedService !== "git-receive-pack"
    ) {
      return new Response("Invalid service", { status: 400 });
    }
    return handleInfoRefs(db, requestedService);
  }

  // POST /git-upload-pack
  if (req.method === "POST" && service === "/git-upload-pack") {
    return handleUploadPack(req, db);
  }

  // POST /git-receive-pack
  if (req.method === "POST" && service === "/git-receive-pack") {
    return handleReceivePack(req, db);
  }

  return null;
}
