import { describe, test, expect } from "vitest";
import { execFileSync } from "child_process";
import { resolve } from "path";

const ZAGI_BIN = resolve(__dirname, "../../zig-out/bin/zagi");
const REPO_DIR = resolve(__dirname, "../..");

interface CommandResult {
  output: string;
  duration: number;
  bytes: number;
  lines: number;
}

function runCommand(cmd: string, args: string[]): CommandResult {
  const start = performance.now();
  const output = execFileSync(cmd, args, {
    cwd: REPO_DIR,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const duration = performance.now() - start;

  return {
    output,
    duration,
    bytes: Buffer.byteLength(output, "utf-8"),
    lines: output.split("\n").filter((l) => l.length > 0).length,
  };
}

describe("zagi log", () => {
  test("produces smaller output than git log", () => {
    const zagi = runCommand(ZAGI_BIN, ["log"]);
    const git = runCommand("git", ["log", "-n", "10"]);

    console.log(`\nOutput size comparison:`);
    console.log(`  zagi log: ${zagi.bytes} bytes, ${zagi.lines} lines`);
    console.log(`  git log:  ${git.bytes} bytes, ${git.lines} lines`);
    console.log(
      `  Reduction: ${(((git.bytes - zagi.bytes) / git.bytes) * 100).toFixed(1)}%`
    );

    expect(zagi.bytes).toBeLessThan(git.bytes);
  });

  test("defaults to 10 commits", () => {
    const result = runCommand(ZAGI_BIN, ["log"]);
    // Count commit lines (each starts with 7-char hash)
    const commitLines = result.output
      .split("\n")
      .filter((l) => /^[a-f0-9]{7} /.test(l));
    expect(commitLines.length).toBeLessThanOrEqual(10);
  });

  test("respects -n flag", () => {
    const result = runCommand(ZAGI_BIN, ["log", "-n", "3"]);
    const commitLines = result.output
      .split("\n")
      .filter((l) => /^[a-f0-9]{7} /.test(l));
    expect(commitLines.length).toBeLessThanOrEqual(3);
  });

  test("--full produces verbose output", () => {
    const concise = runCommand(ZAGI_BIN, ["log", "-n", "1"]);
    const full = runCommand(ZAGI_BIN, ["log", "--full", "-n", "1"]);

    expect(full.bytes).toBeGreaterThan(concise.bytes);
    expect(full.output).toContain("Author:");
    expect(full.output).toContain("Date:");
  });

  test("output format matches spec", () => {
    const result = runCommand(ZAGI_BIN, ["log", "-n", "1"]);
    // Format: abc123f (2025-01-15) Alice: Subject line
    const line = result.output.split("\n")[0];
    expect(line).toMatch(/^[a-f0-9]{7} \(\d{4}-\d{2}-\d{2}\) \w+: .+$/);
  });
});

describe("performance", () => {
  test("zagi log is reasonably fast", () => {
    const iterations = 10;
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const result = runCommand(ZAGI_BIN, ["log"]);
      times.push(result.duration);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);

    console.log(`\nPerformance (${iterations} iterations):`);
    console.log(`  Average: ${avg.toFixed(2)}ms`);
    console.log(`  Min: ${min.toFixed(2)}ms`);
    console.log(`  Max: ${max.toFixed(2)}ms`);

    // Should complete in under 100ms on average
    expect(avg).toBeLessThan(100);
  });

  test("zagi overhead vs git is minimal", () => {
    const zagiTimes: number[] = [];
    const gitTimes: number[] = [];
    const iterations = 5;

    for (let i = 0; i < iterations; i++) {
      const zagi = runCommand(ZAGI_BIN, ["log", "-n", "5"]);
      const git = runCommand("git", ["log", "--oneline", "-n", "5"]);
      zagiTimes.push(zagi.duration);
      gitTimes.push(git.duration);
    }

    const zagiAvg = zagiTimes.reduce((a, b) => a + b, 0) / iterations;
    const gitAvg = gitTimes.reduce((a, b) => a + b, 0) / iterations;
    const overhead = zagiAvg - gitAvg;

    console.log(`\nOverhead comparison:`);
    console.log(`  zagi avg: ${zagiAvg.toFixed(2)}ms`);
    console.log(`  git avg:  ${gitAvg.toFixed(2)}ms`);
    console.log(`  Overhead: ${overhead.toFixed(2)}ms`);

    // Overhead should be less than 50ms
    expect(overhead).toBeLessThan(50);
  });
});
