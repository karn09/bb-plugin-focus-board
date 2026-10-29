// Unit A: lib/link-metadata pure helpers. Red-first against the stub
// module (fails at import before the module exists), then green.
import { describe, expect, it } from "vitest";
import {
  LINK_METADATA_KEY,
  linkHref,
  parseLinkedIssues,
  linkedTicketRefs,
  linkedRefKeys,
  clearLinkedIssues,
  stampLinkedIssues,
  makeExternalLink,
  type ExternalItemLink,
  type GitHubItemLink,
  type ThreadLink,
} from "../lib/link-metadata";
import type { JsonValue } from "@get-bb/plugin-sdk";

const GITHUB: GitHubItemLink = {
  tracker: "github",
  repo: "cristoslc/bb-plugin-focus-board",
  issue: 12,
  kind: "issue",
  href: "https://github.com/cristoslc/bb-plugin-focus-board/issues/12",
  createdAt: "2026-10-05T22:00:00.000Z",
  source: "operator",
};
const LINK: ThreadLink = GITHUB;
const OTHER: ThreadLink = {
  tracker: "github",
  repo: "cristoslc/bb-plugin-focus-board",
  issue: 9,
  kind: "pull",
  href: "https://github.com/cristoslc/bb-plugin-focus-board/pull/9",
  createdAt: "2026-10-05T21:00:00.000Z",
  source: "agent",
};

describe("parseLinkedIssues", () => {
  it("absent and null metadata mean unlinked → null", () => {
    expect(parseLinkedIssues(undefined)).toBeNull();
    expect(parseLinkedIssues(null)).toBeNull();
  });

  it("parses a well-formed array round-trip", () => {
    const value = [LINK, OTHER] as unknown as JsonValue;
    expect(parseLinkedIssues(value)).toEqual([LINK, OTHER]);
  });

  it("throws on a malformed present value (never coerces)", () => {
    expect(() => parseLinkedIssues("nope" as unknown as JsonValue)).toThrow(
      /linked issues/,
    );
    expect(() =>
      parseLinkedIssues([{ repo: "a/b", issue: 0, kind: "issue", href: "https://github.com/a/b/issues/0", createdAt: "2026-10-05T22:00:00.000Z", source: "auto" }] as unknown as JsonValue),
    ).toThrow(/issue/);
    expect(() =>
      parseLinkedIssues([{ repo: "a/b", issue: 12, kind: "war", href: "https://github.com/a/b/issues/12", createdAt: "2026-10-05T22:00:00.000Z", source: "auto" }] as unknown as JsonValue),
    ).toThrow(/kind/);
    expect(() =>
      parseLinkedIssues([{ repo: "a/b", issue: 12, kind: "issue", href: "https://gitlab.com/a/b/issues/12", createdAt: "2026-10-05T22:00:00.000Z", source: "auto" }] as unknown as JsonValue),
    ).toThrow(/href/);
    expect(() =>
      parseLinkedIssues([{ repo: "a/b", issue: 12, kind: "issue", href: "https://github.com/a/b/issues/12", createdAt: "not a date", source: "auto" }] as unknown as JsonValue),
    ).toThrow(/createdAt/);
    expect(() =>
      parseLinkedIssues([{ repo: "a/b", issue: 12, kind: "issue", href: "https://github.com/a/b/issues/12", createdAt: "2026-10-05T22:00:00.000Z", source: "ghost" }] as unknown as JsonValue),
    ).toThrow(/source/);
  });

  it("rejects a non-positive, non-integer issue number", () => {
    expect(() =>
      parseLinkedIssues([{ repo: "a/b", issue: 12.5, kind: "issue", href: "https://github.com/a/b/issues/12", createdAt: "2026-10-05T22:00:00.000Z", source: "auto" }] as unknown as JsonValue),
    ).toThrow(/issue/);
  });
});

describe("stampLinkedIssues", () => {
  it("append puts a new link last and keeps the existing primary", () => {
    expect(stampLinkedIssues([OTHER], LINK, { append: true }).map((l) => (l as GitHubItemLink).issue)).toEqual([9, 12]);
  });

  it("puts the new link first (primary), preserving older entries", () => {
    const next = stampLinkedIssues([OTHER], LINK);
    expect(next[0].issue).toBe(12);
    expect(next[1].issue).toBe(9);
  });

  it("upserts by repo+issue: same number moves to front, keeps its stamp", () => {
    const next = stampLinkedIssues([{ ...LINK, createdAt: LINK.createdAt }, OTHER], {
      ...LINK,
      createdAt: "2026-10-06T00:00:00.000Z",
      source: "agent",
    });
    expect(next).toHaveLength(2);
    expect(next[0].issue).toBe(12);
    // Re-linking refreshes the stamp: the newest link wins the record.
    expect(next[0].createdAt).toBe("2026-10-06T00:00:00.000Z");
    // Same repo+number but a different kind is still the same item (GitHub
    // redirects /issues/N ↔ /pull/N); the refreshed record's kind wins.
    const sameNumber = stampLinkedIssues([{ ...LINK, kind: "issue" }], {
      ...LINK,
      kind: "pull",
    });
    expect(sameNumber).toHaveLength(1);
    expect(sameNumber[0].kind).toBe("pull");
  });

  it("tracks the same number from a different repo separately", () => {
    const crossRepo: ThreadLink = {
      ...LINK,
      repo: "cristoslc/research-keeper",
      href: "https://github.com/cristoslc/research-keeper/issues/12",
    };
    const next = stampLinkedIssues([LINK], crossRepo);
    expect(next.filter((l) => l.issue === 12)).toHaveLength(2);
  });
});

describe("clearLinkedIssues", () => {
  it("clears everything when no number is given", () => {
    expect(clearLinkedIssues([LINK, OTHER], undefined)).toBeNull();
  });

  it("clears one number across repos", () => {
    const next = clearLinkedIssues([LINK, OTHER], 12);
    expect(next).toEqual([OTHER]);
  });

  it("clearing an unlinked number keeps the rest", () => {
    const next = clearLinkedIssues([OTHER], 12);
    expect(next).toEqual([OTHER]);
  });

  it("clearing the last link returns null so the key can be removed", () => {
    expect(clearLinkedIssues([LINK], 12)).toBeNull();
  });
});

describe("linkHref", () => {
  it("builds the full URL from repo, kind, and number", () => {
    expect(linkHref("a/b", "issue", 12)).toBe("https://github.com/a/b/issues/12");
    expect(linkHref("a/b", "pull", 9)).toBe("https://github.com/a/b/pull/9");
  });
});

describe("linkedTicketRefs (chip merge)", () => {
  it("turns links into TicketRefs carrying the stored href and kind", () => {
    const refs = linkedTicketRefs([LINK, OTHER]);
    expect(refs).toEqual([
      {
        raw: "#12",
        tracker: "github",
        number: 12,
        href: "https://github.com/cristoslc/bb-plugin-focus-board/issues/12",
        kind: "issue",
      },
      {
        raw: "#9",
        tracker: "github",
        number: 9,
        href: "https://github.com/cristoslc/bb-plugin-focus-board/pull/9",
        kind: "pull",
      },
    ]);
  });

  it("a linked PR emits kind pull so its chip leads with the PR glyph", () => {
    const [ref] = linkedTicketRefs([OTHER]);
    expect(ref.kind).toBe("pull");
  });

  it("skips a link whose href a text ref already renders", () => {
    const textRefs = [
      {
        raw: "https://github.com/cristoslc/bb-plugin-focus-board/issues/12",
        tracker: "github" as const,
        number: 12,
        href: "https://github.com/cristoslc/bb-plugin-focus-board/issues/12",
      },
    ];
    expect(linkedTicketRefs([LINK], textRefs)).toEqual([]);
  });

  it("renders a link whose text duplicate lacks an href (no repo base)", () => {
    const textRefs = [
      { raw: "#12", tracker: "github" as const, number: 12 },
    ];
    expect(linkedTicketRefs([LINK], textRefs)).toHaveLength(1);
  });

  it("does not skip a text URL ref pointing at a different issue", () => {
    const textRefs = [
      {
        raw: "https://github.com/cristoslc/bb-plugin-focus-board/issues/4",
        tracker: "github" as const,
        number: 4,
        href: "https://github.com/cristoslc/bb-plugin-focus-board/issues/4",
      },
    ];
    const refs = linkedTicketRefs([LINK], textRefs);
    expect(refs.map((r) => r.number)).toEqual([12]);
  });
});

describe("key contract", () => {
  it("uses the documented metadata key", () => {
    expect(LINK_METADATA_KEY).toBe("linkedIssues");
  });
});

describe("raw-dedupe among emitted links", () => {
  it("emits one chip per raw text: a cross-repo same-number pair keeps the primary", () => {
    // stampLinkedIssues dedupes per repo+number, but two different repos can
    // still carry the same number; both would emit raw "#12" and the chip row
    // keys chips by raw. First entry (primary) wins.
    const cross = { ...LINK, href: "https://github.com/other/repo/issues/12", createdAt: "2026-10-05T23:00:00.000Z" };
    const refs = linkedTicketRefs([LINK, cross]);
    expect(refs).toHaveLength(1);
    expect(refs[0].href).toBe(LINK.href);
  });

  it("dedupes against an emitted ref, not just the input order", () => {
    const newer = { ...LINK, createdAt: "2026-10-05T23:00:00.000Z" };
    expect(linkedTicketRefs([newer, LINK] as ThreadLink[])).toHaveLength(1);
  });
});

describe("linkedRefKeys", () => {
  it("maps links to owner-repo#number strings for the status fetch", () => {
    expect(linkedRefKeys([LINK, OTHER])).toEqual([
      "cristoslc/bb-plugin-focus-board#12",
      "cristoslc/bb-plugin-focus-board#9",
    ]);
  });

  it("returns nothing for an absent or empty record", () => {
    expect(linkedRefKeys(null)).toEqual([]);
    expect(linkedRefKeys([])).toEqual([]);
  });
});
describe("external links — parse", () => {
  /**
   * Unit E: an external tracker item the conversation turned up (a Linear
   * ticket, a Forgejo issue, any https page) can be linked by URL; the URL
   * is the identity. The hostname is derived from the URL at parse time,
   * never trusted from storage.
   */
  const EXT: ExternalItemLink = {
    tracker: "external",
    url: "https://linear.app/cove/issue/PROJ-142",
    hostname: "linear.app",
    label: "PROJ-142",
    createdAt: "2026-10-08T10:00:00.000Z",
    source: "agent",
  };

  it("accepts a well-formed external link (round-trip)", () => {
    const value = [EXT, GITHUB] as unknown as JsonValue;
    expect(parseLinkedIssues(value)).toEqual([EXT, GITHUB]);
  });

  it("accepts a legacy GitHub record without a tracker field", () => {
    const legacy = { repo: "a/b", issue: 3, kind: "issue", href: "https://github.com/a/b/issues/3", createdAt: "2026-10-05T22:00:00.000Z", source: "auto" };
    expect(parseLinkedIssues([legacy] as unknown as JsonValue)).toMatchObject([
      { tracker: "github", issue: 3 },
    ]);
  });

  it("derives the hostname from the URL, ignoring a stored impostor", () => {
    const impostor = { ...EXT, url: "https://good.example.com/item/PROJ-1", hostname: "evil.example" };
    const [parsed] = parseLinkedIssues([impostor] as unknown as JsonValue)!;
    expect(parsed.hostname).toBe("good.example.com");
  });

  it("throws on a non-https URL, an unparseable URL, and a bad label", () => {
    expect(() =>
      parseLinkedIssues([{ tracker: "external", url: "http://insecure.example/x", hostname: "insecure.example", createdAt: "2026-10-08T10:00:00.000Z", source: "agent" }] as unknown as JsonValue),
    ).toThrow(/url/i);
    expect(() =>
      parseLinkedIssues([{ tracker: "external", url: "not a url", createdAt: "2026-10-08T10:00:00.000Z", source: "agent" }] as unknown as JsonValue),
    ).toThrow(/url/i);
    expect(() =>
      parseLinkedIssues([{ ...EXT, label: "" }] as unknown as JsonValue),
    ).toThrow(/label/i);
    expect(() =>
      parseLinkedIssues([{ ...EXT, label: "x".repeat(81) }] as unknown as JsonValue),
    ).toThrow(/label/i);
  });
});

describe("external links — stamp upserts by URL", () => {
  const EXT: ExternalItemLink = {
    tracker: "external",
    url: "https://linear.app/cove/issue/PROJ-142",
    hostname: "linear.app",
    createdAt: "2026-10-08T10:00:00.000Z",
    source: "operator",
  };

  it("a re-set of the same URL moves to the front with a fresh stamp", () => {
    const next = stampLinkedIssues([EXT], { ...EXT, createdAt: "2026-10-08T11:00:00.000Z", source: "agent" });
    expect(next).toHaveLength(1);
    expect(next[0].createdAt).toBe("2026-10-08T11:00:00.000Z");
    expect(next[0].source).toBe("agent");
  });

  it("an external link coexists with GitHub links", () => {
    const next = stampLinkedIssues([GITHUB], EXT);
    expect(next).toHaveLength(2);
    expect(next[0].tracker).toBe("external");
  });

  it("different URLs are different items even with equal labels", () => {
    const next = stampLinkedIssues([EXT], { ...EXT, url: "https://linear.app/cove/issue/PROJ-143" });
    expect(next).toHaveLength(2);
  });
});

describe("external links — clear", () => {
  const EXT: ExternalItemLink = {
    tracker: "external",
    url: "https://linear.app/cove/issue/PROJ-142",
    hostname: "linear.app",
    createdAt: "2026-10-08T10:00:00.000Z",
    source: "operator",
  };

  it("clearing a GitHub number keeps external links (they have none)", () => {
    expect(clearLinkedIssues([EXT, GITHUB], 12)).toEqual([EXT]);
  });

  it("clearing everything removes externals too", () => {
    expect(clearLinkedIssues([EXT, GITHUB], undefined)).toBeNull();
  });
});

describe("external links — chip merge and dot path", () => {
  const EXT: ExternalItemLink = {
    tracker: "external",
    url: "https://linear.app/cove/issue/PROJ-142",
    hostname: "linear.app",
    label: "PROJ-142",
    createdAt: "2026-10-08T10:00:00.000Z",
    source: "agent",
  };

  it("an external link chips under its label with the stored href and hostname", () => {
    expect(linkedTicketRefs([EXT, GITHUB])).toEqual([
      { raw: "PROJ-142", tracker: "external", href: EXT.url, hostname: "linear.app" },
      { raw: "#12", tracker: "github", number: 12, href: GITHUB.href, kind: "issue" },
    ]);
  });

  it("an external link without a label falls back to the hostname", () => {
    const [ref] = linkedTicketRefs([{ ...EXT, label: undefined } as ThreadLink]);
    expect(ref.raw).toBe("linear.app");
  });

  it("hydrates an external item URL into its number and kind (id text, not the host)", () => {
    const cove = {
      tracker: "external",
      url: "https://git.cove/cristos/Homelab/pulls/42",
      hostname: "git.cove",
      createdAt: "2026-10-11T21:46:04.559Z",
      source: "agent",
    } as ThreadLink;
    expect(linkedTicketRefs([cove])).toEqual([
      {
        raw: "#42",
        tracker: "external",
        href: cove.url,
        hostname: "git.cove",
        kind: "pull",
        number: 42,
      },
    ]);
  });

  it("a three-item Cove thread emits three refs, one per item", () => {
    const items = [
      { tracker: "external", url: "https://git.cove/cristos/Homelab/pulls/42", hostname: "git.cove", createdAt: "a", source: "agent" },
      { tracker: "external", url: "https://git.cove/cristos/Homelab/pulls/41", hostname: "git.cove", createdAt: "b", source: "agent" },
      { tracker: "external", url: "https://git.cove/cristos/Homelab/issues/39", hostname: "git.cove", createdAt: "c", source: "agent" },
    ] as ThreadLink[];
    expect(linkedTicketRefs(items).map((ref) => ref.raw)).toEqual(["#42", "#41", "#39"]);
  });

  it("two external items of the same host with no label stay two refs", () => {
    const a = { tracker: "external", url: "https://git.cove/o/r/issues/1", hostname: "git.cove", createdAt: "a", source: "agent" } as ThreadLink;
    const b = { tracker: "external", url: "https://git.cove/o/r/issues/2", hostname: "git.cove", createdAt: "b", source: "agent" } as ThreadLink;
    expect(linkedTicketRefs([a, b])).toHaveLength(2);
  });

  it("an external link whose href a text ref already renders is skipped", () => {
    const textRefs = [{ raw: "PROJ-142", tracker: "external" as const, href: EXT.url, hostname: "linear.app" }];
    expect(linkedTicketRefs([EXT], textRefs)).toEqual([]);
  });

  it("equal-label externals on different URLs stay two refs (identity is the URL)", () => {
    const other = { ...EXT, url: "https://other-site.example/PROJ-142", createdAt: "2026-10-08T11:00:00.000Z" } as ThreadLink;
    const refs = linkedTicketRefs([EXT, other]);
    // Two different tracker items that happen to share a label are two items;
    // keying the dedupe on raw text used to collapse them into one chip.
    expect(refs).toHaveLength(2);
    expect(refs.map((ref) => ref.href)).toEqual([EXT.url, other.url]);
  });

  it("the same external URL twice emits one ref (href is identity)", () => {
    const older = { ...EXT, createdAt: "2026-10-08T09:00:00.000Z" } as ThreadLink;
    const refs = linkedTicketRefs([EXT, older]);
    expect(refs).toHaveLength(1);
    expect(refs[0].href).toBe(EXT.url);
  });

  it("external links never enter the GitHub status-dot batch", () => {
    expect(linkedRefKeys([EXT, GITHUB])).toEqual(["cristoslc/bb-plugin-focus-board#12"]);
    expect(linkedRefKeys([EXT])).toEqual([]);
  });
});

describe("makeExternalLink", () => {
  it("derives the hostname from the URL and omits an absent label", () => {
    const link = makeExternalLink(
      "https://linear.app/team/item/PROJ-142",
      undefined,
      "agent",
      new Date("2026-10-08T12:00:00.000Z"),
    );
    expect(link).toEqual({
      tracker: "external",
      url: "https://linear.app/team/item/PROJ-142",
      hostname: "linear.app",
      createdAt: "2026-10-08T12:00:00.000Z",
      source: "agent",
    });
  });

  it("carries a label when given", () => {
    const link = makeExternalLink(
      "https://linear.app/x/1",
      "PROJ-142",
      "operator",
      new Date("2026-10-08T12:00:00.000Z"),
    );
    expect(link.label).toBe("PROJ-142");
  });

  it("throws on a plain-parseable but non-https URL (fail loud)", () => {
    expect(() => makeExternalLink("http://a.example/1", undefined, "operator", new Date())).toThrow(
      /https/,
    );
  });

  it("throws on an unparseable URL", () => {
    expect(() => makeExternalLink("not a url", undefined, "operator", new Date())).toThrow();
  });
});

describe("jira external link field", () => {
  const base = { tracker: "external", url: "https://growtherapy.atlassian.net/browse/PT-1", createdAt: "2026-10-29T00:00:00Z", source: "auto" };
  it("round-trips a valid jira key", () => {
    const [l] = parseLinkedIssues([{ ...base, jira: { key: "PT-1" } }])!;
    expect(l).toMatchObject({ jira: { key: "PT-1" } });
  });
  it("drops a malformed jira field", () => {
    const [l] = parseLinkedIssues([{ ...base, jira: { key: "x; rm" } }])!;
    expect(l).not.toHaveProperty("jira");
  });
});
