import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { resolve } from "path";
import { writeFileSync, rmSync, existsSync, mkdirSync } from "fs";

const ZAGI_BIN = resolve(__dirname, "../../zig-out/bin/zagi");
let REPO_DIR: string;

interface CommandResult {
  output: string;
  exitCode: number;
}

function runCommand(
  cmd: string,
  args: string[],
  cwd?: string,
  expectFail = false
): CommandResult {
  try {
    const output = execFileSync(cmd, args, {
      cwd: cwd ?? REPO_DIR,
      encoding: "utf-8",
    });
    return { output, exitCode: 0 };
  } catch (e: any) {
    if (!expectFail) throw e;
    return {
      output: e.stdout || e.stderr || "",
      exitCode: e.status || 1,
    };
  }
}

function createTestRepo(): string {
  const repoId = `fork-test-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  const repoDir = resolve(__dirname, "../fixtures/repos", repoId);

  mkdirSync(resolve(__dirname, "../fixtures/repos"), { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
  });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir });

  writeFileSync(resolve(repoDir, "file.txt"), "initial content\n");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoDir });

  return repoDir;
}

beforeEach(() => {
  REPO_DIR = createTestRepo();
});

afterEach(() => {
  if (REPO_DIR) {
    rmSync(REPO_DIR, { recursive: true, force: true });
  }
});

describe("git fork", () => {
  test("creates a fork", () => {
    const result = runCommand(ZAGI_BIN, ["fork", "test-fork"]);

    expect(result.output).toContain("forked: test-fork");
    expect(result.output).toContain(".forks/test-fork/");
    expect(result.exitCode).toBe(0);

    // Verify directory exists
    expect(existsSync(resolve(REPO_DIR, ".forks/test-fork"))).toBe(true);
  });

  test("lists forks when no args", () => {
    runCommand(ZAGI_BIN, ["fork", "alpha"]);
    runCommand(ZAGI_BIN, ["fork", "beta"]);

    const result = runCommand(ZAGI_BIN, ["fork"]);

    expect(result.output).toContain("forks:");
    expect(result.output).toContain("alpha");
    expect(result.output).toContain("beta");
  });

  test("shows no forks message", () => {
    const result = runCommand(ZAGI_BIN, ["fork"]);
    expect(result.output).toBe("no forks\n");
  });

  test("shows commits ahead count", () => {
    runCommand(ZAGI_BIN, ["fork", "feature"]);

    // Make a commit in the fork
    const forkDir = resolve(REPO_DIR, ".forks/feature");
    writeFileSync(resolve(forkDir, "new.txt"), "new file\n");
    execFileSync("git", ["add", "."], { cwd: forkDir });
    execFileSync("git", ["commit", "-m", "Add new file"], { cwd: forkDir });

    const result = runCommand(ZAGI_BIN, ["fork"]);

    expect(result.output).toContain("feature");
    expect(result.output).toContain("1 commit ahead");
  });

  test("errors when inside a fork", () => {
    runCommand(ZAGI_BIN, ["fork", "test"]);

    const forkDir = resolve(REPO_DIR, ".forks/test");
    const result = runCommand(ZAGI_BIN, ["fork", "nested"], forkDir, true);

    expect(result.output).toContain("already in a fork");
    expect(result.output).toContain("run from base");
    expect(result.exitCode).toBe(1);
  });

  test("auto-adds .forks/ to .gitignore on first fork", () => {
    // No .gitignore exists initially
    expect(existsSync(resolve(REPO_DIR, ".gitignore"))).toBe(false);

    runCommand(ZAGI_BIN, ["fork", "test"]);

    // .gitignore should now exist with .forks/
    expect(existsSync(resolve(REPO_DIR, ".gitignore"))).toBe(true);
    const content = execFileSync("cat", [".gitignore"], {
      cwd: REPO_DIR,
      encoding: "utf-8",
    });
    expect(content).toContain(".forks/");
  });
});

describe("git fork --promote", () => {
  test("promotes fork commits to base", () => {
    runCommand(ZAGI_BIN, ["fork", "feature"]);

    // Make changes in fork
    const forkDir = resolve(REPO_DIR, ".forks/feature");
    writeFileSync(resolve(forkDir, "file.txt"), "updated content\n");
    execFileSync("git", ["add", "."], { cwd: forkDir });
    execFileSync("git", ["commit", "-m", "Update file"], { cwd: forkDir });

    // Promote the fork
    const result = runCommand(ZAGI_BIN, ["fork", "--promote", "feature"]);

    expect(result.output).toContain("promoted: feature");
    expect(result.output).toContain("1 commit");
    expect(result.output).toContain("applied to base");

    // Verify base has the changes
    const content = execFileSync("cat", ["file.txt"], {
      cwd: REPO_DIR,
      encoding: "utf-8",
    });
    expect(content).toBe("updated content\n");
  });

  test("errors for non-existent fork", () => {
    const result = runCommand(
      ZAGI_BIN,
      ["fork", "--promote", "nonexistent"],
      undefined,
      true
    );

    expect(result.output).toContain("not found");
    expect(result.exitCode).toBe(128);
  });

  test("preserves local uncommitted changes when fork has no new commits", () => {
    // Create a fork (no changes made in fork)
    runCommand(ZAGI_BIN, ["fork", "empty-fork"]);

    // Make local uncommitted changes in base
    writeFileSync(resolve(REPO_DIR, "local-changes.txt"), "my local work\n");
    writeFileSync(resolve(REPO_DIR, "file.txt"), "modified locally\n");

    // Promote the fork (which has no commits ahead)
    const result = runCommand(ZAGI_BIN, ["fork", "--promote", "empty-fork"]);

    expect(result.output).toContain("promoted: empty-fork");
    expect(result.exitCode).toBe(0);

    // Verify local changes are preserved
    const localFile = execFileSync("cat", ["local-changes.txt"], {
      cwd: REPO_DIR,
      encoding: "utf-8",
    });
    expect(localFile).toBe("my local work\n");

    const modifiedFile = execFileSync("cat", ["file.txt"], {
      cwd: REPO_DIR,
      encoding: "utf-8",
    });
    expect(modifiedFile).toBe("modified locally\n");
  });

  test("preserves local uncommitted changes when fork has non-conflicting commits", () => {
    runCommand(ZAGI_BIN, ["fork", "feature"]);

    // Make changes in fork to a DIFFERENT file
    const forkDir = resolve(REPO_DIR, ".forks/feature");
    writeFileSync(resolve(forkDir, "new-feature.txt"), "feature content\n");
    execFileSync("git", ["add", "."], { cwd: forkDir });
    execFileSync("git", ["commit", "-m", "Add feature"], { cwd: forkDir });

    // Make local uncommitted changes in base to a DIFFERENT file
    writeFileSync(resolve(REPO_DIR, "local-work.txt"), "my local work\n");

    // Promote the fork
    const result = runCommand(ZAGI_BIN, ["fork", "--promote", "feature"]);

    expect(result.output).toContain("promoted: feature");
    expect(result.exitCode).toBe(0);

    // Verify fork changes are applied
    expect(existsSync(resolve(REPO_DIR, "new-feature.txt"))).toBe(true);
    const featureFile = execFileSync("cat", ["new-feature.txt"], {
      cwd: REPO_DIR,
      encoding: "utf-8",
    });
    expect(featureFile).toBe("feature content\n");

    // Verify local uncommitted changes are preserved
    const localFile = execFileSync("cat", ["local-work.txt"], {
      cwd: REPO_DIR,
      encoding: "utf-8",
    });
    expect(localFile).toBe("my local work\n");
  });

  test("fails safely when fork has conflicting changes", () => {
    runCommand(ZAGI_BIN, ["fork", "conflict"]);

    // Make changes in fork to file.txt
    const forkDir = resolve(REPO_DIR, ".forks/conflict");
    writeFileSync(resolve(forkDir, "file.txt"), "fork version\n");
    execFileSync("git", ["add", "."], { cwd: forkDir });
    execFileSync("git", ["commit", "-m", "Change file"], { cwd: forkDir });

    // Make local uncommitted changes to the SAME file in base
    writeFileSync(resolve(REPO_DIR, "file.txt"), "local version\n");

    // Promote should fail due to conflict
    const result = runCommand(
      ZAGI_BIN,
      ["fork", "--promote", "conflict"],
      undefined,
      true
    );

    expect(result.exitCode).not.toBe(0);

    // Verify local changes are still preserved (not overwritten)
    const content = execFileSync("cat", ["file.txt"], {
      cwd: REPO_DIR,
      encoding: "utf-8",
    });
    expect(content).toBe("local version\n");
  });
});

describe("git fork --delete", () => {
  test("deletes a specific fork", () => {
    runCommand(ZAGI_BIN, ["fork", "to-delete"]);
    expect(existsSync(resolve(REPO_DIR, ".forks/to-delete"))).toBe(true);

    const result = runCommand(ZAGI_BIN, ["fork", "--delete", "to-delete"]);

    expect(result.output).toContain("deleted: to-delete");
    expect(existsSync(resolve(REPO_DIR, ".forks/to-delete"))).toBe(false);
  });

  test("errors for non-existent fork", () => {
    const result = runCommand(
      ZAGI_BIN,
      ["fork", "--delete", "nonexistent"],
      undefined,
      true
    );

    expect(result.output).toContain("not found");
    expect(result.exitCode).toBe(128);
  });
});

describe("git fork --delete-all", () => {
  test("deletes all forks", () => {
    runCommand(ZAGI_BIN, ["fork", "a"]);
    runCommand(ZAGI_BIN, ["fork", "b"]);
    runCommand(ZAGI_BIN, ["fork", "c"]);

    const result = runCommand(ZAGI_BIN, ["fork", "--delete-all"]);

    expect(result.output).toContain("deleted:");
    expect(result.output).toContain("a");
    expect(result.output).toContain("b");
    expect(result.output).toContain("c");

    // Verify forks are gone
    const listResult = runCommand(ZAGI_BIN, ["fork"]);
    expect(listResult.output).toBe("no forks\n");
  });

  test("shows message when no forks exist", () => {
    const result = runCommand(ZAGI_BIN, ["fork", "--delete-all"]);
    expect(result.output).toContain("no forks to delete");
  });
});

describe("git fork --pick", () => {
  test("merges fork commits to base (fast-forward)", () => {
    runCommand(ZAGI_BIN, ["fork", "feature"]);

    // Make changes in fork
    const forkDir = resolve(REPO_DIR, ".forks/feature");
    writeFileSync(resolve(forkDir, "new.txt"), "new content\n");
    execFileSync("git", ["add", "."], { cwd: forkDir });
    execFileSync("git", ["commit", "-m", "Add new file"], { cwd: forkDir });

    // Pick the fork (should fast-forward since base hasn't changed)
    const result = runCommand(ZAGI_BIN, ["fork", "--pick", "feature"]);

    expect(result.output).toContain("picked: feature");
    expect(result.output).toContain("fast-forward");
    expect(result.exitCode).toBe(0);

    // Verify base has the changes
    const content = execFileSync("cat", ["new.txt"], {
      cwd: REPO_DIR,
      encoding: "utf-8",
    });
    expect(content).toBe("new content\n");
  });

  test("creates merge commit when base has diverged", () => {
    runCommand(ZAGI_BIN, ["fork", "feature"]);

    // Make changes in fork
    const forkDir = resolve(REPO_DIR, ".forks/feature");
    writeFileSync(resolve(forkDir, "fork-file.txt"), "fork content\n");
    execFileSync("git", ["add", "."], { cwd: forkDir });
    execFileSync("git", ["commit", "-m", "Fork commit"], { cwd: forkDir });

    // Make different changes in base (diverge)
    writeFileSync(resolve(REPO_DIR, "base-file.txt"), "base content\n");
    execFileSync("git", ["add", "."], { cwd: REPO_DIR });
    execFileSync("git", ["commit", "-m", "Base commit"], { cwd: REPO_DIR });

    // Pick the fork (should create merge commit)
    const result = runCommand(ZAGI_BIN, ["fork", "--pick", "feature"]);

    expect(result.output).toContain("picked: feature");
    expect(result.output).toContain("merged");
    expect(result.exitCode).toBe(0);

    // Verify both files exist (merge succeeded)
    expect(existsSync(resolve(REPO_DIR, "fork-file.txt"))).toBe(true);
    expect(existsSync(resolve(REPO_DIR, "base-file.txt"))).toBe(true);

    // Verify merge commit was created (should have 2 parents)
    const logOutput = execFileSync(
      "git",
      ["log", "--oneline", "--merges", "-1"],
      {
        cwd: REPO_DIR,
        encoding: "utf-8",
      }
    );
    expect(logOutput).toContain("Merge fork");
  });

  test("reports already up to date", () => {
    runCommand(ZAGI_BIN, ["fork", "empty-fork"]);

    // Pick without making any changes in fork
    const result = runCommand(ZAGI_BIN, ["fork", "--pick", "empty-fork"]);

    expect(result.output).toContain("already up to date");
    expect(result.exitCode).toBe(0);
  });

  test("handles merge conflicts gracefully", () => {
    runCommand(ZAGI_BIN, ["fork", "conflict"]);

    // Make changes in fork to file.txt
    const forkDir = resolve(REPO_DIR, ".forks/conflict");
    writeFileSync(resolve(forkDir, "file.txt"), "fork version\n");
    execFileSync("git", ["add", "."], { cwd: forkDir });
    execFileSync("git", ["commit", "-m", "Fork change"], { cwd: forkDir });

    // Make conflicting changes to same file in base
    writeFileSync(resolve(REPO_DIR, "file.txt"), "base version\n");
    execFileSync("git", ["add", "."], { cwd: REPO_DIR });
    execFileSync("git", ["commit", "-m", "Base change"], { cwd: REPO_DIR });

    // Pick should succeed but report conflicts
    const result = runCommand(ZAGI_BIN, ["fork", "--pick", "conflict"]);

    expect(result.output).toContain("picked: conflict");
    expect(result.output).toContain("conflicts");
    expect(result.output).toContain("resolve conflicts");
    expect(result.exitCode).toBe(0);
  });

  test("errors for non-existent fork", () => {
    const result = runCommand(
      ZAGI_BIN,
      ["fork", "--pick", "nonexistent"],
      undefined,
      true
    );

    expect(result.output).toContain("not found");
    expect(result.exitCode).toBe(128);
  });

  test("preserves local uncommitted changes", () => {
    runCommand(ZAGI_BIN, ["fork", "feature"]);

    // Make changes in fork to a different file
    const forkDir = resolve(REPO_DIR, ".forks/feature");
    writeFileSync(resolve(forkDir, "new-feature.txt"), "feature content\n");
    execFileSync("git", ["add", "."], { cwd: forkDir });
    execFileSync("git", ["commit", "-m", "Add feature"], { cwd: forkDir });

    // Make local uncommitted changes in base
    writeFileSync(resolve(REPO_DIR, "local-work.txt"), "my local work\n");

    // Pick the fork
    const result = runCommand(ZAGI_BIN, ["fork", "--pick", "feature"]);

    expect(result.output).toContain("picked: feature");
    expect(result.exitCode).toBe(0);

    // Verify fork changes are applied
    expect(existsSync(resolve(REPO_DIR, "new-feature.txt"))).toBe(true);

    // Verify local uncommitted changes are preserved
    const localFile = execFileSync("cat", ["local-work.txt"], {
      cwd: REPO_DIR,
      encoding: "utf-8",
    });
    expect(localFile).toBe("my local work\n");
  });
});

describe("git fork --help", () => {
  test("shows help", () => {
    const result = runCommand(ZAGI_BIN, ["fork", "--help"]);

    expect(result.output).toContain("usage:");
    expect(result.output).toContain("--pick");
    expect(result.output).toContain("--promote");
    expect(result.output).toContain("--delete");
    expect(result.output).toContain("--delete-all");
  });
});

describe("git fork validation", () => {
  test("rejects empty fork name", () => {
    const result = runCommand(ZAGI_BIN, ["fork", ""], undefined, true);

    expect(result.output).toContain("fork name cannot be empty");
    expect(result.exitCode).toBe(1);
  });

  test("rejects fork name with slash", () => {
    const result = runCommand(
      ZAGI_BIN,
      ["fork", "my/nested/fork"],
      undefined,
      true
    );

    expect(result.output).toContain("cannot contain");
    expect(result.exitCode).toBe(1);
  });

  test("rejects fork name starting with dot", () => {
    const result = runCommand(ZAGI_BIN, ["fork", ".hidden"], undefined, true);

    expect(result.output).toContain("cannot contain");
    expect(result.exitCode).toBe(1);
  });

  test("rejects fork name with path traversal", () => {
    const result = runCommand(
      ZAGI_BIN,
      ["fork", "../../escape"],
      undefined,
      true
    );

    expect(result.output).toContain("cannot contain");
    expect(result.exitCode).toBe(1);
  });

  test("rejects fork name matching existing branch", () => {
    const result = runCommand(ZAGI_BIN, ["fork", "main"], undefined, true);

    expect(result.output).toContain("branch 'main' already exists");
    expect(result.exitCode).toBe(1);
  });

  test("rejects creating duplicate fork", () => {
    runCommand(ZAGI_BIN, ["fork", "existing"]);

    const result = runCommand(ZAGI_BIN, ["fork", "existing"], undefined, true);

    expect(result.output).toContain("already exists");
    expect(result.exitCode).toBe(1);
  });

  test("--pick errors in detached HEAD state", () => {
    runCommand(ZAGI_BIN, ["fork", "test-fork"]);

    // Detach HEAD
    execFileSync("git", ["checkout", "HEAD~0"], { cwd: REPO_DIR });

    const result = runCommand(
      ZAGI_BIN,
      ["fork", "--pick", "test-fork"],
      undefined,
      true
    );

    expect(result.output).toContain("detached HEAD");
    expect(result.output).toContain("checkout a branch");
    expect(result.exitCode).toBe(1);
  });

  test("--promote errors in detached HEAD state", () => {
    runCommand(ZAGI_BIN, ["fork", "test-fork"]);

    // Detach HEAD
    execFileSync("git", ["checkout", "HEAD~0"], { cwd: REPO_DIR });

    const result = runCommand(
      ZAGI_BIN,
      ["fork", "--promote", "test-fork"],
      undefined,
      true
    );

    expect(result.output).toContain("detached HEAD");
    expect(result.output).toContain("checkout a branch");
    expect(result.exitCode).toBe(1);
  });

  test("--pick shows conflict resolution hints", () => {
    runCommand(ZAGI_BIN, ["fork", "conflict"]);

    // Make conflicting changes
    const forkDir = resolve(REPO_DIR, ".forks/conflict");
    writeFileSync(resolve(forkDir, "file.txt"), "fork version\n");
    execFileSync("git", ["add", "."], { cwd: forkDir });
    execFileSync("git", ["commit", "-m", "Fork change"], { cwd: forkDir });

    writeFileSync(resolve(REPO_DIR, "file.txt"), "base version\n");
    execFileSync("git", ["add", "."], { cwd: REPO_DIR });
    execFileSync("git", ["commit", "-m", "Base change"], { cwd: REPO_DIR });

    const result = runCommand(ZAGI_BIN, ["fork", "--pick", "conflict"]);

    expect(result.output).toContain("conflicts");
    expect(result.output).toContain("git add");
    expect(result.output).toContain("git commit");
    expect(result.output).toContain("git merge --abort");
  });

  test("--pick errors when merge already in progress", () => {
    runCommand(ZAGI_BIN, ["fork", "conflict"]);

    // Create a conflict situation
    const forkDir = resolve(REPO_DIR, ".forks/conflict");
    writeFileSync(resolve(forkDir, "file.txt"), "fork version\n");
    execFileSync("git", ["add", "."], { cwd: forkDir });
    execFileSync("git", ["commit", "-m", "Fork change"], { cwd: forkDir });

    writeFileSync(resolve(REPO_DIR, "file.txt"), "base version\n");
    execFileSync("git", ["add", "."], { cwd: REPO_DIR });
    execFileSync("git", ["commit", "-m", "Base change"], { cwd: REPO_DIR });

    // First pick creates merge state
    runCommand(ZAGI_BIN, ["fork", "--pick", "conflict"]);

    // Second pick should error
    const result = runCommand(
      ZAGI_BIN,
      ["fork", "--pick", "conflict"],
      undefined,
      true
    );

    expect(result.output).toContain("merge is already in progress");
    expect(result.output).toContain("git merge --abort");
    expect(result.exitCode).toBe(1);
  });

  test("rejects fork name that would exceed path limit", () => {
    // Create a name that's very long (should exceed path limit with workdir)
    const longName = "a".repeat(4000);

    const result = runCommand(ZAGI_BIN, ["fork", longName], undefined, true);

    expect(result.output).toContain("too long");
    expect(result.exitCode).toBe(1);
  });
});
