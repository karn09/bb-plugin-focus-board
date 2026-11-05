// The fork's ONE deliberate process-execution exception (operator decision,
// 2026-11): the built-in Jira sync runs `acli` and `gh`, and nothing else.
// This is the only shipped file allowed to import node:child_process; the
// rule and this file's shape (execFile with an argument array, no shell,
// exactly these two tool names) are enforced by scripts/security-gates.mjs
// and tests/security-no-process-execution.test.ts through the shared check
// in scripts/security-seams.mjs. Upstream has no such exception.
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type JiraTool = "acli" | "gh";
const TOOLS: readonly string[] = ["acli", "gh"];
const FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/** The first executable file named `tool` in `dirs` (absolute dirs only), else null. */
export function resolveTool(tool: JiraTool, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    if (!dir || !isAbsolute(dir)) continue; // a relative PATH entry would resolve against the cwd
    const path = join(dir, tool);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {
      // not here; try the next dir
    }
  }
  return null;
}

// Found paths only: a tool installed after a miss is picked up on the next call.
const resolved = new Map<JiraTool, string>();

export function runTool(tool: JiraTool, args: readonly string[]): Promise<string> {
  if (!TOOLS.includes(tool)) return Promise.reject(new Error(`refusing to run ${JSON.stringify(String(tool))}: only acli and gh`));
  let path = resolved.get(tool);
  if (path === undefined) {
    const found = resolveTool(tool, [...(process.env.PATH ?? "").split(delimiter), ...FALLBACK_DIRS]);
    if (found === null) return Promise.reject(new Error(`${tool} not found on PATH`));
    resolved.set(tool, (path = found));
  }
  return new Promise((resolve, reject) => {
    execFile(
      path,
      [...args],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024, shell: false, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) return resolve(stdout);
        reject(new Error(`${tool} ${args[0] ?? ""} failed: ${(stderr || error.message || "").toString().trim()}`.slice(0, 500)));
      },
    );
  });
}
