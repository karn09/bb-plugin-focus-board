// @vitest-environment jsdom
// Ticket chips: each ref renders as [provider glyph][kind glyph] + ref text.
// The provider glyph names the source (GitHub's brand; a generic ticket
// mark when the provider cannot be named — unreachable from text scanning
// now that unvalidatable key-shaped refs never chip, and kept for chip
// sources that one day render without a text provider). The kind glyph
// separates issue from PR and carries the live state color once status
// lands: the old bare dot is gone.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { ThreadCard } from "../components/thread-card";
import { thread } from "./thread-fixture";
import { JiraBoardContext } from "../components/jira-card-badges";

const BASE = "https://github.com/owner/repo";

type CardProps = Parameters<typeof ThreadCard>[0];

function renderCard(title: string, overrides: Partial<CardProps> = {}) {
  const props = {
    thread: thread({ id: "thr_ref", displayTitle: title, updatedAt: 5000 }),
    stateDot: null,
    isActive: false,
    isDone: false,
    projectName: "One",
    repoHrefBase: BASE,
    onOpen: vi.fn(),
    onOpenThread: vi.fn(),
    ...overrides,
  } as unknown as CardProps;
  return render(<ThreadCard {...props} />);
}

function chip(): Element {
  const el = document.querySelector("[data-ticket-chip]");
  if (el === null) throw new Error("missing ticket chip");
  return el;
}

/** A glyph inside the chip, waiting through the extended-icon lazy load. */
async function chipIcon(name: string): Promise<Element> {
  return waitFor(() => {
    const el = chip().querySelector(`[data-icon="${name}"]`);
    if (el === null) throw new Error(`missing chip glyph ${name}`);
    return el;
  });
}

afterEach(cleanup);

describe("ticket chip icons — provider glyph", () => {
  it("a #N ref under a GitHub repo leads with the GitHub brand mark", async () => {
    renderCard("resolve #17: surface a thread's ticket");
    await chipIcon("GithubMark");
    // The mark links to the kind's list page; each ID links to its item.
    expect(chip().querySelector("[data-ticket-chip-mark]")?.getAttribute("href")).toBe(
      `${BASE}/issues`,
    );
    expect(chip().querySelector('[data-ticket-id="#17"]')?.getAttribute("href")).toBe(
      `${BASE}/issues/17`,
    );
    expect(chip().textContent).toContain("#17");
  });

  it("a PROJ-123 key ref renders no chip (word keys cannot validate)", async () => {
    renderCard("Fix PROJ-123 render bug");
    expect(document.querySelector("[data-ticket-chip]")).toBeNull();
  });
});

describe("linked store chips — distinct PR vs issue glyphs", () => {
  const linkedPull: import("../lib/link-metadata").GitHubItemLink = {
    tracker: "github",
    repo: "owner/repo",
    issue: 16,
    kind: "pull",
    href: `${BASE}/pull/16`,
    createdAt: "2026-10-09T00:00:00.000Z",
    source: "agent",
  };
  const linkedIssue: import("../lib/link-metadata").GitHubItemLink = {
    ...linkedPull,
    issue: 12,
    kind: "issue",
    href: `${BASE}/issues/12`,
  };

  it("a store-linked PR leads with the PR glyph before status lands", async () => {
    renderCard("Link thread to issue and update chip status", {
      linkedIssues: [linkedPull],
    });
    await chipIcon("PullRequest");
  });

  it("a store-linked issue keeps the issue glyph", async () => {
    renderCard("File issue on tag support for other threads", {
      linkedIssues: [linkedIssue],
    });
    await chipIcon("IssueOpen");
  });

  it("an external chip shows the favicon and no GitHub kind glyph", async () => {
    renderCard("Explain GLM-5 tag on thread", {
      linkedIssues: [
        {
          tracker: "external",
          url: "https://linear.app/t/PROJ-142",
          hostname: "linear.app",
          label: "PROJ-142",
          createdAt: "2026-10-09T00:00:00.000Z",
          source: "operator",
        },
      ],
    });
    const chipEl = await waitFor(() => {
      const el = document.querySelector("[data-ticket-chip]");
      if (el === null) throw new Error("missing chip");
      return el;
    });
    expect(chipEl.textContent).toContain("PROJ-142");
    expect(chipEl.querySelector('[data-icon="IssueOpen"]')).toBeNull();
    expect(chipEl.querySelector('[data-icon="PullRequest"]')).toBeNull();
    expect(chipEl.querySelector('[data-icon="GithubMark"]')).toBeNull();
    expect(chipEl.querySelector("img")).not.toBeNull();
  });

  describe("Jira-keyed external links", () => {
    const jiraLink = {
      tracker: "external" as const,
      url: "https://x.atlassian.net/browse/PT-1",
      hostname: "x.atlassian.net",
      label: "PT-1",
      jira: { key: "PT-1" },
      createdAt: "2026-10-09T00:00:00.000Z",
      source: "auto" as const,
    };
    const board = (enabled: boolean) =>
      ({ enabled, stale: false, ticketByKey: {}, pendingOps: [], onAction: vi.fn(), threads: {} }) as never;
    const renderWith = (enabled: boolean) =>
      render(
        <JiraBoardContext.Provider value={board(enabled)}>
          <ThreadCard {...({ thread: thread({ id: "thr_j", displayTitle: "plain title", updatedAt: 5000 }), stateDot: null, isActive: false, isDone: false, projectName: "One", repoHrefBase: BASE, onOpen: vi.fn(), onOpenThread: vi.fn(), linkedIssues: [jiraLink] } as unknown as CardProps)} />
        </JiraBoardContext.Provider>,
      );
    it("Jira on: no favicon chip for a jira-keyed link", () => {
      renderWith(true);
      expect(document.querySelector("[data-ticket-chip]")).toBeNull();
    });
    it("Jira off: the favicon chip renders as upstream", async () => {
      renderWith(false);
      await waitFor(() => expect(document.querySelector("[data-ticket-chip] img")).not.toBeNull());
    });
    // Links an agent added earlier as a plain Atlassian URL carry no `jira` field.
    const plainLink = { tracker: "external" as const, url: "https://growtherapy.atlassian.net/browse/PT-3879", hostname: "growtherapy.atlassian.net", label: "PT-3879", createdAt: "2026-10-09T00:00:00.000Z", source: "agent" as const };
    const recWith = (key: string) => ({ links: [{ key, role: "owner" as const, source: "auto" as const }], enrolledAt: null, verifying: null, doneCheck: null, nudgedAt: null, deepCheckedAt: null, reason: null, checkInWith: null });
    const renderPlain = (recordKey: string) =>
      render(
        <JiraBoardContext.Provider value={({ enabled: true, stale: false, ticketByKey: {}, pendingOps: [], onAction: vi.fn(), threads: { thr_p: recWith(recordKey) } }) as never}>
          <ThreadCard {...({ thread: thread({ id: "thr_p", displayTitle: "plain title", updatedAt: 5000 }), stateDot: null, isActive: false, isDone: false, projectName: "One", repoHrefBase: BASE, onOpen: vi.fn(), onOpenThread: vi.fn(), linkedIssues: [plainLink] } as unknown as CardProps)} />
        </JiraBoardContext.Provider>,
      );
    it("Jira on: a plain Atlassian /browse/KEY link the Jira chip already shows is hidden (no duplicate chip)", () => {
      renderPlain("PT-3879");
      expect(document.querySelector("[data-ticket-chip]")).toBeNull();
      expect(document.querySelectorAll("[data-jira-chip] [data-jira-key]")).toHaveLength(1);
    });
    it("Jira on: a plain Atlassian link the Jira chip does not show stays (nothing disappears)", () => {
      renderPlain("PT-9999");
      expect(document.querySelector("[data-ticket-chip]")).not.toBeNull();
    });
  });

  describe("Jira key chip rides the ticket chip row", () => {
    const rec = { links: [{ key: "PT-1", role: "owner" as const, source: "auto" as const }], enrolledAt: null, verifying: null, doneCheck: null, nudgedAt: null, deepCheckedAt: null, reason: "waiting on infra", checkInWith: null };
    const board = (enabled: boolean, threads: object) =>
      ({ enabled, stale: false, ticketByKey: {}, pendingOps: [], onAction: vi.fn(), threads }) as never;
    const renderIn = (title: string, value: never | null) => {
      const card = (
        <ThreadCard {...({ thread: thread({ id: "thr_ref", displayTitle: title, updatedAt: 5000 }), stateDot: null, isActive: false, isDone: false, projectName: "One", repoHrefBase: BASE, onOpen: vi.fn(), onOpenThread: vi.fn() } as unknown as CardProps)} />
      );
      return render(value === null ? card : <JiraBoardContext.Provider value={value}>{card}</JiraBoardContext.Provider>);
    };
    const area = () => document.querySelector("[data-ticket-chip-area]");
    it("the Jira chip shares the GitHub chip's row, after it; the badge row keeps the rest", () => {
      renderIn("resolve #17: surface a thread's ticket", board(true, { thr_ref: rec }));
      const jira = document.querySelector("[data-jira-key]")!.closest("[data-jira-chip]")!;
      expect(jira.closest("[data-ticket-chip-area]")).toBe(chip().closest("[data-ticket-chip-area]"));
      expect(chip().compareDocumentPosition(jira) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const badges = document.querySelector("[data-jira-badges]")!;
      expect(badges.querySelector("[data-jira-key]")).toBeNull();
      expect(badges.querySelector("[data-jira-reason]")).not.toBeNull();
    });
    it("no GitHub chip: the row still renders, holding only the Jira chip", () => {
      renderIn("plain title", board(true, { thr_ref: rec }));
      expect(area()).not.toBeNull();
      expect(area()!.querySelector("[data-ticket-chip]")).toBeNull();
      expect(area()!.querySelectorAll("[data-jira-chip]")).toHaveLength(1);
    });
    it("Jira off, or on with no links: the chip row DOM is upstream's", () => {
      renderIn("resolve #17: surface a thread's ticket", null);
      const upstream = area()!.outerHTML;
      cleanup();
      renderIn("resolve #17: surface a thread's ticket", board(false, { thr_ref: rec }));
      expect(area()!.outerHTML).toBe(upstream);
      cleanup();
      renderIn("resolve #17: surface a thread's ticket", board(true, {}));
      expect(area()!.outerHTML).toBe(upstream);
      cleanup();
      renderIn("plain title", board(true, {}));
      expect(area()).toBeNull();
    });
  });

  it("a forgejo PR id leads with the PR glyph, beside the site favicon", async () => {
    renderCard("Fix render-configs.sh placeholder substitution", {
      repoHrefBase: "https://git.cove/cristos/Homelab",
      linkedIssues: [
        {
          tracker: "external",
          url: "https://git.cove/cristos/Homelab/pulls/42",
          hostname: "git.cove",
          createdAt: "2026-10-11T21:46:04.559Z",
          source: "agent",
        },
      ],
    });
    const chipEl = await waitFor(() => {
      const el = document.querySelector("[data-ticket-chip]");
      if (el === null) throw new Error("missing chip");
      return el;
    });
    // The id is its number, not the host; the glyph names its kind.
    expect(chipEl.querySelector('[data-ticket-id="#42"]')).not.toBeNull();
    expect(chipEl.textContent).toContain("#42");
    expect(chipEl.textContent).not.toContain("git.cove");
    expect(chipEl.querySelector('[data-icon="PullRequest"]')).not.toBeNull();
    expect(chipEl.querySelector('[data-icon="GithubMark"]')).toBeNull();
    expect(chipEl.querySelector("img")?.getAttribute("src")).toBe("https://git.cove/favicon.ico");
  });

  it("a forgejo PR and issue from the store render as two chips, issue first", async () => {
    renderCard("purge MetaMCP remnants", {
      repoHrefBase: "https://git.cove/cristos/Homelab",
      linkedIssues: [
        { tracker: "external", url: "https://git.cove/cristos/Homelab/pulls/42", hostname: "git.cove", createdAt: "a", source: "agent" },
        { tracker: "external", url: "https://git.cove/cristos/Homelab/issues/39", hostname: "git.cove", createdAt: "b", source: "agent" },
      ],
    });
    const chips = await waitFor(() => {
      const els = document.querySelectorAll("[data-ticket-chip]");
      if (els.length < 2) throw new Error("want two chips");
      return els;
    });
    // Issue #104 moved the pair out of one per-provider row into the card's
    // issues and pulls regions; both chips keep the same provider key.
    expect(chips[0].getAttribute("data-provider-row")).toBe("git.cove");
    expect(chips[1].getAttribute("data-provider-row")).toBe("git.cove");
    expect(chips[0].querySelector('[data-ticket-id="#39"]')).not.toBeNull();
    expect(chips[1].querySelector('[data-ticket-id="#42"]')).not.toBeNull();
    expect(chips[0].querySelector('[data-icon="IssueOpen"]')).not.toBeNull();
    expect(chips[1].querySelector('[data-icon="PullRequest"]')).not.toBeNull();
    expect(chips[0].closest('[data-ticket-chip-region="issues"]')).not.toBeNull();
    expect(chips[1].closest('[data-ticket-chip-region="pulls"]')).not.toBeNull();
  });

  it("a three-item Cove thread renders all three ids, each linking its own item", async () => {
    renderCard("purge MetaMCP remnants (issue #39)", {
      repoHrefBase: "https://git.cove/cristos/Homelab",
      linkedIssues: [
        { tracker: "external", url: "https://git.cove/cristos/Homelab/pulls/42", hostname: "git.cove", createdAt: "a", source: "agent" },
        { tracker: "external", url: "https://git.cove/cristos/Homelab/pulls/41", hostname: "git.cove", createdAt: "b", source: "agent" },
        { tracker: "external", url: "https://git.cove/cristos/Homelab/issues/39", hostname: "git.cove", createdAt: "c", source: "agent" },
      ],
    });
    const ids = await waitFor(() => {
      const els = document.querySelectorAll("[data-ticket-id]");
      if (els.length < 3) throw new Error(`only ${els.length} ids`);
      return els;
    });
    const hrefs = [...ids].map((el) => el.getAttribute("href"));
    expect(hrefs).toContain("https://git.cove/cristos/Homelab/pulls/42");
    expect(hrefs).toContain("https://git.cove/cristos/Homelab/pulls/41");
    expect(hrefs).toContain("https://git.cove/cristos/Homelab/issues/39");
  });

  it("a forgejo text ref's chip mark links the base's list page, not github.com", async () => {
    renderCard("resolve #7", { repoHrefBase: "https://git.cove/cristos/Homelab" });
    const mark = await waitFor(() => {
      const el = document.querySelector("[data-ticket-chip-mark]");
      if (el === null) throw new Error("missing mark");
      return el;
    });
    expect(mark.getAttribute("href")).toBe("https://git.cove/cristos/Homelab/issues");
    expect(mark.querySelector('[data-icon="GithubMark"]')).toBeNull();
  });

  it("a merged store-linked PR still shows the merge glyph purple", async () => {
    renderCard("Link thread to issue and update chip status", {
      linkedIssues: [linkedPull],
      statusFor: (repo, num) =>
        repo === "owner/repo" && num === 16 ? { kind: "pull", state: "MERGED" } : undefined,
    });
    await chipIcon("Merge");
  });
});

describe("ticket chip icons — issue vs PR glyph", () => {
  it("a kindless #N ref renders the open-issue glyph before status lands", async () => {
    renderCard("resolve #17: surface a thread's ticket");
    await chipIcon("IssueOpen");
  });

  it("a /pull/ URL renders the PR glyph even before status lands", async () => {
    renderCard(`merged https://github.com/owner/repo/pull/45`);
    await chipIcon("PullRequest");
    const issueGlyph = chip().querySelector('[data-icon="IssueOpen"]');
    expect(issueGlyph).toBeNull();
  });

  it("a PROJ-123 key ref renders no chip (word keys are never PRs, never chips)", async () => {
    renderCard("Fix PROJ-123 render bug");
    expect(document.querySelector("[data-ticket-chip]")).toBeNull();
  });

  it("live open-issue status colors the open-issue glyph emerald", async () => {
    renderCard("resolve #17", {
      statusFor: (repo, num) =>
        repo === "owner/repo" && num === 17 ? { kind: "issue", state: "OPEN" } : undefined,
    });
    const glyph = await chipIcon("IssueOpen");
    expect(glyph.getAttribute("class")).toContain("text-emerald-500");
    expect(glyph.getAttribute("aria-label")).toBe("issue OPEN");
  });

  it("live merged-PR status swaps in the merge glyph with the ids dimmed and struck", async () => {
    renderCard("resolve #17", {
      statusFor: (repo, num) =>
        repo === "owner/repo" && num === 17 ? { kind: "pull", state: "MERGED" } : undefined,
    });
    const glyph = await chipIcon("Merge");
    // The merged glyph carries no state color (open's emerald is the only
    // colored glyph); the merged id reads dimmed grey with a strikethrough,
    // and hover changes size, never color.
    expect(glyph.getAttribute("class") ?? "").not.toMatch(/text-purple-500/);
    const idSpan = chip().querySelector('[data-ticket-id="#17"] > span');
    expect(idSpan?.getAttribute("class") ?? "").toContain("line-through");
    expect(idSpan?.getAttribute("class") ?? "").toContain("opacity-60");
  });

  it("each id carries a hover bubble naming it, clear of the pointer", () => {
    renderCard("resolve #17");
    const anchor = chip().querySelector('[data-ticket-id="#17"]');
    const tip = anchor?.querySelector("[data-ticket-tip]");
    expect(tip?.textContent).toBe("#17");
    // The bubble sits above the id and reveals on that id's hover, so the
    // OS pays it no attention and the pointer can never cover it.
    expect(tip?.getAttribute("class") ?? "").toContain("bottom-full");
    expect(tip?.getAttribute("class") ?? "").toContain("group-hover/id:block");
    // The native title tooltip is gone (it renders under the pointer).
    expect(anchor?.getAttribute("title")).toBeNull();
    expect(anchor?.getAttribute("aria-label") ?? "").toContain("#17");
  });

  it("ids flow in a wrapping flex row and enlarge on hover by transform", () => {
    renderCard("#101 #102 #103 #104 #105 #106 #107 #108 resolve");
    const flow = chip().querySelector("[data-ticket-chip] > [data-ticket-ids]");
    expect(flow).not.toBeNull();
    // The ids wrap as they run out of width: flex-wrap, not a fixed
    // max-content grid whose tracks refuse to shrink (a long external label
    // like "cove 0dac60e" would overflow the card instead of wrapping).
    expect(flow?.className).toContain("flex");
    expect(flow?.className).toContain("flex-wrap");
    expect(flow?.className).toContain("min-w-0");
    expect(flow?.className).not.toContain("grid-cols");
    const ids = chip().querySelectorAll("[data-ticket-id]");
    expect(ids.length).toBeGreaterThanOrEqual(4);
    const anchor = ids[0];
    expect(anchor.getAttribute("class") ?? "").toContain("hover:scale-110");
    expect(anchor.getAttribute("class") ?? "").toContain("origin-left");
    expect(anchor.getAttribute("class") ?? "").not.toContain("hover:text-");
  });

  it("a single-id chip reserves no phantom width — a flex flow holds no empty tracks", () => {
    renderCard("Mark thread done rename worktree #32");
    const flow = chip().querySelector("[data-ticket-chip] > [data-ticket-ids]");
    expect(flow?.className).toContain("flex");
    // A fixed multi-column grid would still collect empty tracks' column
    // gaps, leaving the chip wider than its one id.
    expect(flow?.className).not.toContain("grid-cols");
    expect(chip().querySelectorAll("[data-ticket-id]")).toHaveLength(1);
  });

  it("two ids share the wrapping flow like any other count", () => {
    renderCard("Watch the pair #61 #62 settle");
    const flow = chip().querySelector("[data-ticket-chip] > [data-ticket-ids]");
    expect(flow?.className).toContain("flex-wrap");
    expect(flow?.className).not.toContain("grid-cols");
  });

  it("a single-row chip centers its content vertically; a wrapped chip stays top-anchored", () => {
    const single = renderCard("Follow-ups #17 #21 #30 chip mix");
    expect(chip().className).toContain("items-center");
    single.unmount();
    renderCard("#101 #102 #103 #104 #105 #106 #107 #108 resolve");
    expect(chip().className).toContain("items-start");
    expect(chip().className).not.toContain("items-center");
  });

  it("a chip with many ids wraps onto extra lines instead of overflowing", () => {
    renderCard("#101 #102 #103 #104 #105 #106 #107 #108 resolve");
    const chipEl = chip();
    const flowEl = chipEl.querySelector("[data-ticket-chip] > [data-ticket-ids]");
    expect(flowEl?.className).toContain("flex-wrap");
    // The shell must shrink to the card's width, letting the inner flow do
    // the wrapping — the un-shrinkable grid made the whole shell overflow.
    expect(flowEl?.className).toContain("min-w-0");
    expect(chipEl.className).not.toContain("flex-wrap");
  });

  it("live closed-PR status swaps in the closed-PR glyph muted", async () => {
    renderCard("resolve #17", {
      statusFor: (repo, num) =>
        repo === "owner/repo" && num === 17 ? { kind: "pull", state: "CLOSED" } : undefined,
    });
    const glyph = await chipIcon("PullRequestClosed");
    expect(glyph.getAttribute("class")).toContain("text-muted-foreground/50");
  });

  it("live closed-issue status swaps in the closed-issue glyph muted", async () => {
    renderCard("resolve #17", {
      statusFor: (repo, num) =>
        repo === "owner/repo" && num === 17 ? { kind: "issue", state: "CLOSED" } : undefined,
    });
    const glyph = await chipIcon("IssueClosed");
    expect(glyph.getAttribute("class")).toContain("text-muted-foreground/50");
  });
});

describe("DOM validity — no link nests inside the card's own link (issue #171)", () => {
  it("a chip's mark and id anchors render outside the card's content anchor", async () => {
    renderCard("resolve #17: surface a thread's ticket");
    await chipIcon("GithubMark");
    const card = document.querySelector('[data-thread-card="thr_ref"]');
    if (card === null) throw new Error("missing card");
    // The board must stay HTML-valid: a chip's per-ticket link (the mark's
    // list-page href and each id's item href) may not sit inside the card's
    // own content anchor — React logs "In HTML, <a> cannot be a descendant
    // of <a>" for every affected card otherwise.
    const anchors = Array.from(card.querySelectorAll("a"));
    // The content anchor plus the chip's mark and id anchors are all present.
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    const nested = anchors.filter((el) => el.parentElement?.closest("a") !== null);
    expect(nested.map((el) => el.getAttribute("href"))).toEqual([]);
  });
});

// Issue #104's placement contract: issues first row left (capped at the
// midpoint when it holds several ids), PRs first row right (bumped only when
// the issues claim the room), tags bottom-right and right-anchored under a PR
// (riding row one when there is none). Geometry is the UAT suite's job; these
// pins hold the DOM model the CSS reads.
describe("chip placement contract (issue #104)", () => {
  type Link = import("../lib/link-metadata").GitHubItemLink;
  type External = import("../lib/link-metadata").ExternalItemLink;

  const issue = (n: number): Link => ({
    tracker: "github",
    repo: "owner/repo",
    issue: n,
    kind: "issue",
    href: `${BASE}/issues/${n}`,
    createdAt: "2026-10-09T00:00:00.000Z",
    source: "agent",
  });
  const pull = (n: number): Link => ({ ...issue(n), kind: "pull", href: `${BASE}/pull/${n}` });
  /** An external tracker ITEM: an item URL plus a display label (a key). */
  const extItem = (label: string, n: number): External => ({
    tracker: "external",
    url: `https://forge.example/org/app/issues/${n}`,
    hostname: "forge.example",
    label,
    createdAt: "2026-10-09T00:00:00.000Z",
    source: "agent",
  });
  /** A free-text label: no item number, no tracker key shape. */
  const tag = (label: string): External => ({
    tracker: "external",
    url: `https://linear.app/t/${label}`,
    hostname: "linear.app",
    label,
    createdAt: "2026-10-09T00:00:00.000Z",
    source: "operator",
  });

  function region(name: "issues" | "pulls" | "tags"): Element {
    const el = document.querySelector(`[data-ticket-chip-region="${name}"]`);
    if (el === null) throw new Error(`missing ${name} region`);
    return el;
  }
  function regionClass(name: "issues" | "pulls" | "tags"): string {
    return region(name).getAttribute("class") ?? "";
  }

  it("a short issue sits in the issues region and the PR in the pulls region", async () => {
    renderCard("Card teleport effect on rank", { linkedIssues: [issue(142), pull(87)] });
    await waitFor(() => {
      if (region("issues").querySelector('[data-ticket-id="#142"]') === null) {
        throw new Error("issue not in the issues region");
      }
    });
    expect(region("pulls").querySelector('[data-ticket-id="#87"]')).not.toBeNull();
    // The PR region is right-anchored — `ml-auto` is the whole mechanism.
    expect(regionClass("pulls")).toContain("ml-auto");
    // A single id may claim the whole row; the cap only holds a list.
    expect(regionClass("issues")).toContain("max-w-full");
    expect(regionClass("issues")).not.toContain("max-w-[calc(50%-2px)]");
  });

  it("several issue ids hold the issues region to the midpoint cap", async () => {
    renderCard("Board teleport effect", {
      linkedIssues: [issue(44), issue(102), issue(7), pull(41)],
    });
    await waitFor(() => {
      if (region("issues").querySelectorAll("[data-ticket-id]").length < 3) {
        throw new Error("issue ids not grouped");
      }
    });
    // Midpoint + gutter: the list reflows inside the left half, so the PR chip
    // keeps the first row's right end.
    expect(regionClass("issues")).toContain("max-w-[calc(50%-2px)]");
    // Surplus ids wrap onto fresh lines INSIDE the region.
    expect(regionClass("issues")).toContain("flex-wrap");
    expect(region("pulls").querySelector('[data-ticket-id="#41"]')).not.toBeNull();
  });

  it("a lone long ticket may take the whole first row and bump the PR", async () => {
    renderCard("Lane resize guard for the family card", {
      linkedIssues: [extItem("MOBDEVLONG-100323", 100323), pull(87)],
    });
    await waitFor(() => {
      if (region("issues").querySelector('[data-ticket-id="MOBDEVLONG-100323"]') === null) {
        throw new Error("long external ticket missing");
      }
    });
    expect(regionClass("issues")).toContain("max-w-full");
    expect(regionClass("issues")).not.toContain("max-w-[calc(50%-2px)]");
    // Still right-anchored: when the issues region fills row one, the pulls
    // region wraps and `ml-auto` keeps it at that line's right end.
    expect(regionClass("pulls")).toContain("ml-auto");
    expect(regionClass("pulls")).toContain("flex-wrap");
  });

  it("no ticket id ever breaks across lines", () => {
    renderCard("#101 #102 #103 #104 #105 #106 #107 #108 resolve");
    const ids = Array.from(document.querySelectorAll("[data-ticket-id]"));
    expect(ids.length).toBeGreaterThanOrEqual(4);
    for (const id of ids) {
      expect(id.getAttribute("class") ?? "").toContain("whitespace-nowrap");
    }
  });

  it("a long id arms the fit path; a short id never measures", () => {
    const long = renderCard("Notification preferences export", {
      linkedIssues: [extItem("MOBDEVSERVICENOTIFICATIONSPREFERENCES-100323", 100323)],
    });
    const fitFlow = document.querySelector("[data-ticket-ids-fit]");
    expect(fitFlow).not.toBeNull();
    expect(fitFlow?.getAttribute("class") ?? "").toContain("flex-wrap");
    long.unmount();
    renderCard("resolve #17");
    expect(document.querySelector("[data-ticket-ids-fit]")).toBeNull();
  });

  it("with a PR present the tag block takes its own line under it", async () => {
    renderCard("Card teleport effect", {
      linkedIssues: [issue(142), pull(87), tag("triage")],
    });
    await waitFor(() => {
      if (region("tags").querySelector('[data-ticket-id="triage"]') === null) {
        throw new Error("tag not in the tags region");
      }
    });
    const cls = regionClass("tags");
    expect(cls).toContain("basis-full");
    expect(cls).toContain("ml-auto");
    expect(cls).toContain("max-w-[75%]");
    expect(cls).toContain("items-end");
  });

  it("with no PR a tag may ride the first line's right end", async () => {
    renderCard("Rank handles drag", { linkedIssues: [issue(44), tag("badging")] });
    await waitFor(() => {
      if (region("tags").querySelector('[data-ticket-id="badging"]') === null) {
        throw new Error("tag not in the tags region");
      }
    });
    expect(regionClass("tags")).not.toContain("basis-full");
    expect(regionClass("tags")).toContain("ml-auto");
  });

  it("a tag wraps at its hyphens, never shrinks, and never breaks mid-word", async () => {
    renderCard("Card teleport effect", {
      linkedIssues: [issue(142), pull(87), tag("mobile-notifications-badging-rollout-v12-alpha")],
    });
    const tagText = await waitFor(() => {
      const el = region("tags").querySelector(
        '[data-ticket-id="mobile-notifications-badging-rollout-v12-alpha"]',
      );
      if (el === null) throw new Error("long tag missing");
      return el;
    });
    // Normal wrapping: CSS breaks at hyphens, and `word-break: normal` keeps it
    // from breaking inside a word. No nowrap, no fit hook — the tag keeps its
    // text size.
    expect(tagText.getAttribute("class") ?? "").toContain("break-normal");
    expect(tagText.getAttribute("class") ?? "").not.toContain("whitespace-nowrap");
    expect(region("tags").querySelectorAll("[data-ticket-ids-fit]").length).toBe(0);
  });

  it("a tag chip is marked by the generic globe, not a provider mark", async () => {
    renderCard("Rank handles drag", { linkedIssues: [tag("triage")] });
    const globe = await waitFor(() => {
      const el = region("tags").querySelector('[data-icon="Globe"]');
      if (el === null) throw new Error("tag is missing its globe mark");
      return el;
    });
    expect(globe).not.toBeNull();
    // The item chips' GitHub mark never appears in the tag block.
    expect(region("tags").querySelector('[data-icon="GithubMark"]')).toBeNull();
    expect(region("tags").querySelector("img")).toBeNull();
  });
});