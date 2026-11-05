// Global test setup: no test ever runs the real acli or gh. Every test that
// loads the plugin (server.ts) gets this mocked seam, whose runTool never
// settles, so a sync pass kicked by a test (startup, Refresh, a Done data
// wait) stops at its first tool call and changes nothing. Tests that drive
// the sync inject their own fake runner (registerJira deps.run, or
// createSyncCore's run). tests/jira-exec.test.ts loads the real module with
// vi.importActual.
import { vi } from "vitest";

vi.mock("../../lib/jira-exec", async (importActual) => ({
  ...(await importActual<typeof import("../../lib/jira-exec")>()),
  runTool: () => new Promise<string>(() => {}),
}));
