/**
 * The single source of truth for the shipped-code fetch-seam allowlist:
 * BOTH scripts/security-gates.mjs and tests/security-fetch-seams.test.ts
 * consume this table, so the gate and its suite-level backstop can never
 * drift apart — a seam is added to this table once (with a comment naming
 * the audit that approved it) and both checks enforce it, and a file
 * rename (open-in-new-window.ts → open-in-browser.ts → deleted) or a new
 * fetch site is caught by BOTH a red `npm run gates` and a red
 * `npm test`, instead of only the gate that merges kept skipping.
 * (Incident: docs/incidents/2026-10-10-red-security-gate-on-dev.md.)
 *
 * A seam entry:
 *   - `file`: the shipped path whose `fetch(` sites are approved (the
 *     exact file the gate's shipped-file scan visits; the path is also
 *     asserted to EXIST by the scan test, so renames/deletions break
 *     loudly here first).
 *   - `text`: OPTIONAL exact substring the fetch line must carry — pin a
 *     specific forwarding line when a file may legitimately contain other
 *     fetch-shaped text; omit to approve every fetch site in the file
 *     (only sensible for single-purpose fetch client modules).
 *   - `reason`: what the seam is and which audit document approved it.
 * The seam pattern a new entry must satisfy is documented in
 * scripts/security-gates.mjs's network section.
 */
export const APPROVED_FETCH_SEAMS = [
  {
    file: "lib/workspace-open.ts",
    reason: "the workspace-open loopback daemon client (hardcoded 127.0.0.1, audited in docs/security-audit-2026-10-05-1.0.md finding table)",
  },
  {
    file: "server.ts",
    text: "fetchImpl: (url, init) => fetch(url, init)",
    reason: "the tracker_validate forwarding seam handing the platform fetch into the text-ref existence probe — docs/security-audit-2026-10-09-1.1.md",
  },
  {
    file: "lib/openverse.ts",
    reason: "the Openverse search client (pinned https://api.openverse.org origin refused at call time by requireOpenverseSearchUrl, no credentials/referrer, no redirects followed, 10s deadline composed with the caller's signal, payload read only through the tolerant parser boundary) — docs/security-audit-2026-10-10-openverse-client.md",
  },
];

/**
 * The seam approving a `fetch(` site, or null when the site violates the
 * gate. `file` is the shipped path (no line suffix); `lineText` is the
 * code line. Shared by the gate script and the scan test — never restate
 * this predicate elsewhere.
 */
export function seamForFetch(file, lineText) {
  for (const seam of APPROVED_FETCH_SEAMS) {
    if (seam.file !== file) continue;
    if (seam.text === undefined || lineText.includes(seam.text)) return seam;
  }
  return null;
}
/**
 * The one shipped file allowed to run a process: the fork's deliberate
 * exception (operator decision, 2026-11). The built-in Jira sync runs
 * exactly `acli` and `gh` through it. Every other shipped file must not
 * mention child_process at all, and `shell: true` is banned everywhere,
 * this file included. Consumed by scripts/security-gates.mjs and
 * tests/security-no-process-execution.test.ts.
 */
export const PROCESS_EXEC_SEAM = "lib/jira-exec.ts";
export const PROCESS_EXEC_TOOLS = ["acli", "gh"];

/**
 * What is wrong with the seam's source, as violation lines ([] = ok): it
 * must call execFile (argument array, no shell), never any other way of
 * starting a process or loading a module at runtime (no import( / require(),
 * name child_process only on its one static import line (comment lines
 * aside), and name exactly the two tools above (its tool type and its
 * runtime allowlist both).
 */
export function execSeamViolations(source) {
  const out = [];
  if (!/\bexecFile\(/.test(source)) out.push("no execFile( call");
  for (const [re, what] of [
    [/shell:\s*true/, "shell: true"],
    [/shell:(?!\s*false\b)/, "a shell option other than false"],
    [/\bexec\(/, "exec("],
    [/\bexecSync\b|\bexecFileSync\b|\bspawnSync\b/, "a synchronous exec"],
    [/\bspawn\b/, "spawn"],
    [/\bfork\(/, "fork("],
    [/\bimport\s*\(/, "import("],
    [/\brequire\s*\(/, "require("],
  ]) {
    if (re.test(source)) out.push(`uses ${what}`);
  }
  const imports = source.match(/^import .*child_process.*$/gm) ?? [];
  if (imports.length !== 1 || !/^import \{ execFile \} from "node:child_process";$/.test(imports[0])) {
    out.push(`child_process import must be exactly \`import { execFile } from "node:child_process";\` (found ${imports.length})`);
  }
  // Anywhere else (a string, a second import) is a way around the shape check; comment lines are fine.
  const IMPORT_LINE = 'import { execFile } from "node:child_process";';
  const stray = source.split("\n").filter((l) => /child_process/.test(l) && l !== IMPORT_LINE && !/^\s*(\/\/|\/\*|\*)/.test(l));
  if (stray.length) out.push(`child_process outside its import line: ${stray[0].trim()}`);
  const quoted = PROCESS_EXEC_TOOLS.map((t) => `"${t}"`);
  if (!new RegExp(`export type JiraTool = ${quoted.join(" \\| ")};`).test(source)) out.push(`JiraTool type must be exactly ${quoted.join(" | ")}`);
  if (!new RegExp(`const TOOLS: readonly string\\[\\] = \\[${quoted.join(", ")}\\];`).test(source)) out.push(`TOOLS allowlist must be exactly [${quoted.join(", ")}]`);
  return out;
}
