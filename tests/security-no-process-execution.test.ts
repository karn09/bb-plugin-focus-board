// The process-execution backstop, pinned as a vitest test.
//
// The fetch-seam backstop (tests/security-fetch-seams.test.ts) exists
// because the gate alone failed to stop bad merges for a day (incident
// docs/incidents/2026-10-10-red-security-gate-on-dev.md); this is its
// process sibling: scripts/security-gates.mjs's law "no process execution
// in the plugin runtime" (docs/security-audit-2026-09-28.md,
// docs/security-audit-2026-10-05-1.0.md) gets the same suite-level
// backstop, so the issue #236 regression (a gh CLI spawn in
// lib/tracker-refresh.ts that only `npm run gates` saw) can never ship a
// merge unnoticed again.
//
// The rule has exactly ONE exception, the fork's deliberate one (operator
// decision, 2026-11): lib/jira-exec.ts may run `acli` and `gh` (the Jira
// sync), through execFile with an argument array, never a shell. The seam
// and its shape check live once in scripts/security-seams.mjs, consumed by
// both the gate and this test. The gate scans raw lines, comments included
// (a comment naming `child_process` still trips the real gate), so this
// test scans the same way: zero `child_process` occurrences across the
// shipped file set outside the seam, backstop code excluded.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execSeamViolations, PROCESS_EXEC_SEAM, PROCESS_EXEC_TOOLS } from "../scripts/security-seams.mjs";

function listFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      listFiles(path, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".generated.ts")) {
      acc.push(path);
    }
  }
  return acc;
}

const shippedFiles = ["server.ts", "app.tsx", ...listFiles("lib"), ...listFiles("components")];
const CHILD_PROCESS = /child_process/;

/** The scan the law test runs: every line naming child_process, outside the one seam. */
function childProcessHits(file: string, source: string): string[] {
  if (file === PROCESS_EXEC_SEAM) return [];
  const hits: string[] = [];
  source.split("\n").forEach((line, index) => {
    if (CHILD_PROCESS.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
  });
  return hits;
}

describe("process-execution backstop (shipped code, suite-level)", () => {
  it("scanned the expected shipped files", () => {
    expect(shippedFiles).toContain("server.ts");
    expect(shippedFiles).toContain("app.tsx");
    expect(shippedFiles).toContain("lib/tracker-refresh.ts");
    // Broken-scan guard: the fetch backstop pins the walker's lower bound
    // with today's tree; mirror it so a half-walked tree fails here first
    // instead of passing a hollow scan.
    expect(shippedFiles.length).toBeGreaterThan(60);
  });

  it("the matcher itself works (guard against a dead scan)", () => {
    expect(CHILD_PROCESS.test('import { spawn } from "node:child_process";')).toBe(true);
    expect(CHILD_PROCESS.test('import { readFileSync } from "node:fs";')).toBe(false);
  });

  it("shipped code never references child_process outside the one seam (the no-process law)", () => {
    const failures = shippedFiles.flatMap((file) => childProcessHits(file, readFileSync(file, "utf8")));
    // Backstop code (this test's own walker) is outside the shipped set:
    // `listFiles` runs from the repo root, so tests/ is never scanned.
    expect(failures).toEqual([]);
  });

  it("shell:true stays banned everywhere, the seam included", () => {
    const hits = shippedFiles.filter((f) => /shell:\s*true/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("the seam is lib/jira-exec.ts, it exists, and it runs only acli and gh through execFile", () => {
    expect(PROCESS_EXEC_SEAM).toBe("lib/jira-exec.ts");
    expect(shippedFiles).toContain(PROCESS_EXEC_SEAM);
    expect(PROCESS_EXEC_TOOLS).toEqual(["acli", "gh"]);
    expect(execSeamViolations(readFileSync(PROCESS_EXEC_SEAM, "utf8"))).toEqual([]);
  });

  it("the seam check rejects a shell, other exec calls, and any third tool", () => {
    const ok = readFileSync(PROCESS_EXEC_SEAM, "utf8");
    expect(execSeamViolations(ok.replace("shell: false", "shell: true"))).not.toEqual([]);
    expect(execSeamViolations(ok + "\nexec(cmd);\n")).not.toEqual([]);
    expect(execSeamViolations(ok + "\nexecSync(cmd);\n")).not.toEqual([]);
    expect(execSeamViolations(ok + "\nspawn(cmd);\n")).not.toEqual([]);
    expect(execSeamViolations(ok.replace('["acli", "gh"]', '["acli", "gh", "bash"]'))).not.toEqual([]);
    expect(execSeamViolations(ok.replace('"acli" | "gh"', '"acli" | "gh" | "bb"'))).not.toEqual([]);
    expect(execSeamViolations(ok.replace(/execFile\(/g, "run("))).not.toEqual([]);
  });

  it("the seam check rejects a dynamic import or require, and child_process off its one import line", () => {
    const ok = readFileSync(PROCESS_EXEC_SEAM, "utf8");
    expect(ok).toMatch(/^\/\/.*child_process/m); // a comment naming it stays allowed
    expect(execSeamViolations(ok + '\nconst cp = await import("node:" + "child_" + "process");\n')).toContain("uses import(");
    expect(execSeamViolations(ok + '\nconst cp = require("node:child_process");\n')).toContain("uses require(");
    expect(execSeamViolations(ok + '\nconst m = "node:child_process"; void m;\n')).not.toEqual([]);
  });

  it("another shipped file mentioning child_process still fails the scan", () => {
    expect(childProcessHits("lib/jira-server.ts", 'import { execFile } from "node:child_process";')).toHaveLength(1);
    expect(childProcessHits("lib/jira-sync-core.ts", "// child_process lives in jira-exec")).toHaveLength(1);
    expect(childProcessHits(PROCESS_EXEC_SEAM, 'import { execFile } from "node:child_process";')).toEqual([]);
  });
});
