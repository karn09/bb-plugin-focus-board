// lib/jira-exec.ts: the fork's one process-execution seam (acli and gh only).
// Never runs the real tools: resolution is tested over temp dirs, and the
// execFile path runs a stub named `acli` placed first on PATH.
// tests/helpers/no-real-tools.ts mocks this module for every other test, so
// this file loads the real one with vi.importActual.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type ExecModule = typeof import("../lib/jira-exec");
const real = () => vi.importActual<ExecModule>("../lib/jira-exec");

const stubDir = (name: string, body: string) => {
  const d = mkdtempSync(join(tmpdir(), "jira-exec-"));
  writeFileSync(join(d, name), body);
  chmodSync(join(d, name), 0o755);
  return d;
};

describe("resolveTool", () => {
  it("first existing executable wins; non-executables, directories and relative entries are skipped", async () => {
    const { resolveTool } = await real();
    const a = stubDir("acli", "#!/bin/sh\n");
    const b = stubDir("acli", "#!/bin/sh\n");
    const notExec = mkdtempSync(join(tmpdir(), "jira-exec-"));
    writeFileSync(join(notExec, "acli"), "x"); // mode 0644
    const dirOnly = mkdtempSync(join(tmpdir(), "jira-exec-"));
    mkdirSync(join(dirOnly, "acli"));
    expect(resolveTool("acli", [notExec, dirOnly, "relative/bin", a, b])).toBe(join(a, "acli"));
    expect(resolveTool("gh", [a, b])).toBeNull();
  });
});

describe("runTool", () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
    vi.resetModules();
  });

  it("refuses any tool but acli and gh, before resolving anything", async () => {
    const { runTool } = await real();
    await expect(runTool("bash" as never, ["-c", "echo hi"])).rejects.toThrow(/only acli and gh/);
    await expect(runTool("acli; rm" as never, [])).rejects.toThrow(/only acli and gh/);
  });

  it("runs the resolved tool with an argument array (no shell) and returns stdout", async () => {
    // Each argv entry on its own line: a shell would split or expand "$(x) y".
    const d = stubDir("acli", '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n');
    process.env.PATH = `${d}:${savedPath}`;
    vi.resetModules();
    const { runTool } = await real();
    expect(await runTool("acli", ["jira", "$(echo pwned) two words", "*"])).toBe("jira\n$(echo pwned) two words\n*\n");
  });

  it("a failing tool rejects with `<tool> <first arg> failed: <stderr>`, capped at 500 chars", async () => {
    const d = stubDir("acli", `#!/bin/sh\nprintf 'unauthorized: please login${"x".repeat(600)}' >&2\nexit 1\n`);
    process.env.PATH = `${d}:${savedPath}`;
    vi.resetModules();
    const { runTool } = await real();
    const e = await runTool("acli", ["jira", "workitem"]).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message.startsWith("acli jira failed: unauthorized: please login")).toBe(true);
    expect((e as Error).message.length).toBe(500);
  });
});

describe("no-real-tools guard (every other test)", () => {
  it("the mocked runTool never settles, so a kicked pass runs nothing", async () => {
    const { runTool } = await import("../lib/jira-exec");
    const r = await Promise.race([runTool("acli", ["jira"]).then(() => "settled", () => "settled"), new Promise((ok) => setTimeout(() => ok("pending"), 20))]);
    expect(r).toBe("pending");
  });
});
