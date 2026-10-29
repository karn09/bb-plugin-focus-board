// Unit C: the focus_board_link_issue agent tool (the AGENTS.md-style
// nudge surface). Red-first against the unregistered tool, then green.
import { describe, expect, it } from "vitest";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { setup, linksOf } from "./helpers/link-fake-host";

function registered(host: FakePluginHost) {
  return host.harness.inspection.registrations.agentTools;
}

describe("focus_board_link_issue external URL forms", () => {
  it("links an external tracker URL with its label", async () => {
    const { harness, meta } = await setup({ threads: ["thread-test"] });
    await harness.callAgentTool("focus_board_link_issue", {
      url: "https://linear.app/team/item/PROJ-142",
      label: "PROJ-142",
    });
    const links = linksOf(meta, "thread-test");
    expect(links).toHaveLength(1);
    expect(links![0]).toMatchObject({
      tracker: "external",
      url: "https://linear.app/team/item/PROJ-142",
      hostname: "linear.app",
      label: "PROJ-142",
      source: "agent",
    });
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "link-changed",
      payload: { threadIds: ["thread-test"] },
    });
  });

  it("an external URL without a label falls back to the hostname", async () => {
    const { harness, meta } = await setup({ threads: ["thread-test"] });
    await harness.callAgentTool("focus_board_link_issue", {
      url: "https://jira.internal.acme.com/browse/ENG-482",
    });
    const links = linksOf(meta, "thread-test")!;
    expect(links[0].tracker).toBe("external");
    if (links[0].tracker === "external") {
      expect(links[0].hostname).toBe("jira.internal.acme.com");
      expect(links[0].label).toBeUndefined();
    }
  });

  it("rejects http:// urls (https only)", async () => {
    const { harness } = await setup();
    await expect(
      harness.callAgentTool("focus_board_link_issue", { url: "http://a.example/item/1" }),
    ).rejects.toThrow();
  });

  it("rejects a label alongside the number form", async () => {
    const { harness } = await setup();
    await expect(
      harness.callAgentTool("focus_board_link_issue", { number: 12, label: "PROJ-1" }),
    ).rejects.toThrow();
  });
});

describe("focus_board_link_issue registration", () => {
  it("registers exactly the link, group and Jira tools (no misnamed extras)", async () => {
    const { host } = await setup();
    const tools = registered(host);
    // The Jira tools are registered always; configure selects them only while jiraEnabled.
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "focus_board_done_verdict",
      "focus_board_group_set",
      "focus_board_jira_link",
      "focus_board_link_issue",
      "focus_board_spawn_child",
    ]);
  });

  it("carries a sub-4096-char instructions nudge (the AGENTS.md-style push)", async () => {
    const { host } = await setup();
    const tool = registered(host)[0];
    expect(typeof tool.instructions).toBe("string");
    expect(tool.instructions!.length).toBeGreaterThan(40);
    expect(tool.instructions!.length).toBeLessThanOrEqual(4096);
    expect(tool.instructions).toMatch(/focus_board_link_issue/);
  });

  // Copilot CLI (gh-copilot) sessions accept ACP session/new's mcpServers but
  // never register the bb-bridge tools, so the tool call itself fails there
  // with the agent's own "tool isn't available in this session" message. The
  // instructions must hand those sessions a working fallback instead.
  it("nudge teaches the bb focus-board link set CLI fallback for sessions without the tool", async () => {
    const { host } = await setup();
    const instructions = registered(host)[0].instructions!;
    expect(instructions).toMatch(/focus-board link set/);
    expect(instructions).toMatch(/BB_THREAD_ID/);
  });
});

describe("focus_board_link_issue execution (url form)", () => {
  it("links the calling thread from a full GitHub URL", async () => {
    const { host, harness, meta } = await setup({ threads: ["thread-test"] });
    await harness.callAgentTool("focus_board_link_issue", {
      url: "https://github.com/cristoslc/bb-plugin-focus-board/issues/12",
    });
    const links = linksOf(meta, "thread-test");
    expect(links).toHaveLength(1);
    expect(links![0]).toMatchObject({
      repo: "cristoslc/bb-plugin-focus-board",
      issue: 12,
      kind: "issue",
      source: "agent",
    });
    expect(harness.inspection.realtimeSignals).toContainEqual({
      channel: "link-changed",
      payload: { threadIds: ["thread-test"] },
    });
  });

  it("parses pull URLs with their kind", async () => {
    const { host, harness, meta } = await setup({ threads: ["thread-test"] });
    await harness.callAgentTool("focus_board_link_issue", {
      url: "https://github.com/a/b/pull/9",
    });
    expect(linksOf(meta, "thread-test")![0].kind).toBe("pull");
  });
});

describe("focus_board_link_issue execution (number form)", () => {
  it("resolves the repo from the calling project's GitHub remote", async () => {
    const { host, harness, meta } = await setup({ threads: ["thread-test"] });
    await harness.callAgentTool("focus_board_link_issue", { number: 12 });
    const links = linksOf(meta, "thread-test");
    expect(links![0]).toMatchObject({
      repo: "a/b",
      issue: 12,
      kind: "issue",
      source: "agent",
    });
  });

  it("fails as an error result when no GitHub remote resolves (agent-retryable)", async () => {
    const { host, harness } = await setup({ threads: ["thread-test"], projectRemote: null });
    const result = await harness.callAgentTool("focus_board_link_issue", {
      number: 12,
    });
    expect(typeof result).toBe("object");
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toMatch(/github/i);
    expect(text).toMatch(/url/i);
  });
});

describe("focus_board_link_issue validation", () => {
  it("rejects input with neither url nor number (parse failure throws)", async () => {
    const { host, harness } = await setup();
    await expect(harness.callAgentTool("focus_board_link_issue", {})).rejects.toThrow();
  });

  it("rejects both url and number together (exactly one)", async () => {
    const { host, harness } = await setup();
    await expect(
      harness.callAgentTool("focus_board_link_issue", {
        url: "https://github.com/a/b/issues/12",
        number: 12,
      }),
    ).rejects.toThrow();
  });

  it("rejects an out-of-range number", async () => {
    const { host, harness } = await setup();
    await expect(
      harness.callAgentTool("focus_board_link_issue", { number: 0 }),
    ).rejects.toThrow();
  });
});