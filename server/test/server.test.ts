/**
 * Integration tests for zagi-server (SQLite backend)
 *
 * Tests git protocol compatibility - clone, push, pull using real git CLI.
 * No git binary on server - pure SQLite storage.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { rm, mkdir, readFile, writeFile } from "fs/promises";
import { resolve, join } from "path";
import type { Subprocess } from "bun";

const TEST_PORT = 3456;
const TEST_DATA_DIR = resolve(import.meta.dir, ".test-data");
const TEST_CLONE_DIR = resolve(import.meta.dir, ".test-clones");
const BASE_URL = `http://localhost:${TEST_PORT}`;

let serverProcess: Subprocess | null = null;

async function runGit(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function startServer(): Promise<void> {
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
  await rm(TEST_CLONE_DIR, { recursive: true, force: true });
  await mkdir(TEST_DATA_DIR, { recursive: true });
  await mkdir(TEST_CLONE_DIR, { recursive: true });

  serverProcess = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DATA_DIR: TEST_DATA_DIR,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await Bun.sleep(100);
  }
  throw new Error("Server failed to start");
}

async function stopServer(): Promise<void> {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
  await rm(TEST_CLONE_DIR, { recursive: true, force: true });
}

describe("zagi-server (SQLite)", () => {
  beforeAll(async () => {
    await startServer();
  });

  afterAll(async () => {
    await stopServer();
  });

  describe("health and info", () => {
    test("GET /health returns ok", async () => {
      const res = await fetch(`${BASE_URL}/health`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string };
      expect(data.status).toBe("ok");
    });

    test("GET / returns API info", async () => {
      const res = await fetch(BASE_URL);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { name: string; storage: string };
      expect(data.name).toBe("zagi-server");
      expect(data.storage).toBe("SQLite (Durable Objects compatible)");
    });
  });

  describe("git clone", () => {
    test("can clone a user repo", async () => {
      const clonePath = join(TEST_CLONE_DIR, "clone-test");
      const result = await runGit(
        ["clone", `${BASE_URL}/myapp/alice`, clonePath],
        TEST_CLONE_DIR
      );
      expect(result.exitCode).toBe(0);

      // Check git log
      const log = await runGit(["log", "--oneline"], clonePath);
      expect(log.stdout).toContain("Initial commit");
    });

    test("different users get separate repos", async () => {
      const alicePath = join(TEST_CLONE_DIR, "alice-sep");
      const bobPath = join(TEST_CLONE_DIR, "bob-sep");

      await runGit(
        ["clone", `${BASE_URL}/app/alice`, alicePath],
        TEST_CLONE_DIR
      );
      await runGit(["clone", `${BASE_URL}/app/bob`, bobPath], TEST_CLONE_DIR);

      await runGit(["config", "user.email", "alice@test.com"], alicePath);
      await runGit(["config", "user.name", "Alice"], alicePath);
      await runGit(["config", "user.email", "bob@test.com"], bobPath);
      await runGit(["config", "user.name", "Bob"], bobPath);

      // Alice commits
      await writeFile(join(alicePath, "alice.txt"), "Alice's file");
      await runGit(["add", "alice.txt"], alicePath);
      await runGit(["commit", "-m", "Alice commit"], alicePath);
      await runGit(["push", "origin", "main"], alicePath);

      // Bob commits (independently)
      await writeFile(join(bobPath, "bob.txt"), "Bob's file");
      await runGit(["add", "bob.txt"], bobPath);
      await runGit(["commit", "-m", "Bob commit"], bobPath);
      await runGit(["push", "origin", "main"], bobPath);

      // Verify they have different content
      const aliceLog = await runGit(["log", "--oneline"], alicePath);
      const bobLog = await runGit(["log", "--oneline"], bobPath);

      expect(aliceLog.stdout).toContain("Alice commit");
      expect(aliceLog.stdout).not.toContain("Bob commit");
      expect(bobLog.stdout).toContain("Bob commit");
      expect(bobLog.stdout).not.toContain("Alice commit");
    });
  });

  describe("git push", () => {
    test("can push changes to server", async () => {
      const clonePath = join(TEST_CLONE_DIR, "push-test");
      await runGit(
        ["clone", `${BASE_URL}/pushapp/pusher`, clonePath],
        TEST_CLONE_DIR
      );

      await runGit(["config", "user.email", "pusher@test.com"], clonePath);
      await runGit(["config", "user.name", "Pusher"], clonePath);

      await writeFile(join(clonePath, "pushed.txt"), "Pushed content");
      await runGit(["add", "pushed.txt"], clonePath);
      await runGit(["commit", "-m", "Push test"], clonePath);

      const pushResult = await runGit(["push", "origin", "main"], clonePath);
      expect(pushResult.exitCode).toBe(0);
    });
  });

  describe("git pull", () => {
    test("can pull changes after push", async () => {
      const clone1 = join(TEST_CLONE_DIR, "pull-1");
      const clone2 = join(TEST_CLONE_DIR, "pull-2");

      await runGit(
        ["clone", `${BASE_URL}/pullapp/puller`, clone1],
        TEST_CLONE_DIR
      );
      await runGit(
        ["clone", `${BASE_URL}/pullapp/puller`, clone2],
        TEST_CLONE_DIR
      );

      await runGit(["config", "user.email", "puller@test.com"], clone1);
      await runGit(["config", "user.name", "Puller"], clone1);

      // Push from clone1
      await writeFile(join(clone1, "shared.txt"), "Shared");
      await runGit(["add", "shared.txt"], clone1);
      await runGit(["commit", "-m", "Shared commit"], clone1);
      await runGit(["push", "origin", "main"], clone1);

      // Pull in clone2
      const pullResult = await runGit(["pull", "origin", "main"], clone2);
      expect(pullResult.exitCode).toBe(0);

      const content = await readFile(join(clone2, "shared.txt"), "utf-8");
      expect(content).toBe("Shared");
    });
  });

  describe("branches", () => {
    test("can create and push feature branches", async () => {
      const clonePath = join(TEST_CLONE_DIR, "branch-test");
      await runGit(
        ["clone", `${BASE_URL}/branchapp/user`, clonePath],
        TEST_CLONE_DIR
      );

      await runGit(["config", "user.email", "user@test.com"], clonePath);
      await runGit(["config", "user.name", "User"], clonePath);

      // Create feature branch
      await runGit(["checkout", "-b", "feature"], clonePath);
      await writeFile(join(clonePath, "feature.txt"), "Feature");
      await runGit(["add", "feature.txt"], clonePath);
      await runGit(["commit", "-m", "Feature commit"], clonePath);

      // Push feature branch
      const pushResult = await runGit(["push", "origin", "feature"], clonePath);
      expect(pushResult.exitCode).toBe(0);
      expect(pushResult.stderr).toContain("new branch");

      // Fetch and verify
      await runGit(["fetch", "origin"], clonePath);
      const branches = await runGit(["branch", "-a"], clonePath);
      expect(branches.stdout).toContain("origin/feature");
    });

    test("branches are isolated per user", async () => {
      const alice = join(TEST_CLONE_DIR, "branch-alice");
      const bob = join(TEST_CLONE_DIR, "branch-bob");

      await runGit(["clone", `${BASE_URL}/iso/alice`, alice], TEST_CLONE_DIR);
      await runGit(["clone", `${BASE_URL}/iso/bob`, bob], TEST_CLONE_DIR);

      await runGit(["config", "user.email", "a@t.com"], alice);
      await runGit(["config", "user.name", "A"], alice);

      // Alice creates a branch
      await runGit(["checkout", "-b", "alice-feature"], alice);
      await writeFile(join(alice, "a.txt"), "A");
      await runGit(["add", "a.txt"], alice);
      await runGit(["commit", "-m", "A"], alice);
      await runGit(["push", "origin", "alice-feature"], alice);

      // Bob shouldn't see Alice's branch
      await runGit(["fetch", "origin"], bob);
      const bobBranches = await runGit(["branch", "-a"], bob);
      expect(bobBranches.stdout).not.toContain("alice-feature");
    });
  });
});
