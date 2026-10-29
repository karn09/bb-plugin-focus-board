// Linked-issue helpers for the board's ticket chips.
//
// A "link" = per-thread plugin metadata in the board's own namespace: key
// "linkedIssues" → ThreadLink[] (first entry is the primary). This is the
// store threads and cards use when neither the title nor the branch name
// carries a text ticket ref: the builtin GitHub plugin persists its own
// thread↔issue links in bb.db rows under its own plugin namespace, which
// focus-board cannot read (no cross-plugin surface in BbPluginApi), so the
// board keeps its own record. These helpers are pure — no host, no SDK —
// so the RPC layer, the chip merge, and tests can drive them without a bb
// host.
import type { JsonValue } from "@get-bb/plugin-sdk";
import { findTicketRefs, forgejoItemUrl, type TicketRef } from "./tickets";

/** The board's linked-issues key inside its thread plugin-metadata namespace. */
export const LINK_METADATA_KEY = "linkedIssues";

/** One thread→tracker-item link. First entry in the array is the primary. */
export type ThreadLink = GitHubItemLink | ExternalItemLink;

/** GitHub-shaped link: the repo/number identity the board's dots can decorate. */
export type GitHubItemLink = {
  tracker: "github";
  /** "owner/repo" slug. */
  repo: string;
  /** Issue/PR number, positive integer. */
  issue: number;
  kind: "issue" | "pull";
  /** Full https URL; the chip uses it directly, so a stale href still opens. */
  href: string;
  /** ISO-8601 stamp of the link's write. */
  createdAt: string;
  /** Who wrote it: a thread agent (tool), the operator (CLI), auto-detect. */
  source: "agent" | "operator" | "auto";
};

/**
 * External tracker item (Jira, Linear, Clickup, Forgejo, anything): the URL
 * is the identity — agents set these through the link tool when the
 * conversation turns one up, and the chip renders the site's favicon. No
 * repo/number pair, no GitHub status dot.
 */
export type ExternalItemLink = {
  tracker: "external";
  /** Canonical https URL of the item; dedupes by exact URL. */
  url: string;
  /** Derived at parse from the URL hostname; never trusted from storage. */
  hostname: string;
  /** Optional display text (e.g. "PROJ-142"); falls back to the hostname. */
  label?: string;
  /** Jira issue this link points at, when the Jira integration wrote it. */
  jira?: { key: string };
  createdAt: string;
  source: "agent" | "operator" | "auto";
};

const JIRA_KEY_OK = /^[A-Z][A-Z0-9]+-\d+$/;
const LINK_SOURCES = new Set(["agent", "operator", "auto"]);
const LINK_KINDS = new Set(["issue", "pull"]);

/**
 * Full URL for a linked item. GitHub redirects /issues/N ↔ /pull/N when the
 * kind is wrong, so a mislabeled kind still opens the right page.
 */
export function linkHref(repo: string, kind: "issue" | "pull", issue: number): string {
  return `https://github.com/${repo}/${kind === "pull" ? "pull" : "issues"}/${issue}`;
}

/**
 * Parse a full GitHub issue/PR URL into its repo, number, and kind. Null on
 * anything else (the caller decides whether that means an external item or
 * bad input — parseGithubItemUrl itself stays silent either way).
 */
export function parseGithubItemUrl(
  url: string,
): { repo: string; issue: number; kind: "issue" | "pull" } | null {
  const match = url.match(
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/(issues|pull)\/(\d+)\/?$/,
  );
  if (match === null) return null;
  const [, owner, repo, kind, issue] = match;
  return {
    repo: `${owner}/${repo}`,
    issue: Number(issue),
    kind: kind === "pull" ? "pull" : "issue",
  };
}

/**
 * Build an external link record at a write boundary (agent tool, CLI, RPC):
 * the hostname always derives from the URL here, never from caller input,
 * and the URL must be https (fail loud otherwise). Label optional, 1..80 —
 * the same bound parse enforces on stored records.
 */
export function makeExternalLink(
  url: string,
  label: string | undefined,
  source: ThreadLink["source"],
  now: Date,
): ExternalItemLink {
  if (!/^https:\/\//.test(url)) {
    throw new Error(`external link: url must be https, got ${JSON.stringify(url)}`);
  }
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`external link: unparseable url ${JSON.stringify(url)}`);
  }
  if (label !== undefined && (label.length < 1 || label.length > 80)) {
    throw new Error(`external link: label must be 1..80 chars, got ${label.length}`);
  }
  const link: ExternalItemLink = {
    tracker: "external",
    url,
    hostname,
    createdAt: now.toISOString(),
    source,
  };
  if (label !== undefined) link.label = label;
  return link;
}

function parseLink(value: JsonValue, index: number): ThreadLink {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    const got = Array.isArray(value) ? "array" : typeof value;
    throw new Error(`linked issues: entry ${index}: expected object, got ${got}`);
  }
  const entry = value as { [key: string]: JsonValue };
  expect(entry["createdAt"], "createdAt", index, (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
  expect(entry["source"], "source", index, (v) => typeof v === "string" && LINK_SOURCES.has(v));
  const createdAt = entry["createdAt"] as string;
  const source = entry["source"] as ThreadLink["source"];
  // Records written before the external variant existed carry no tracker —
  // they are GitHub links by shape (repo + issue + kind + github href).
  const tracker = entry["tracker"] === undefined ? "github" : entry["tracker"];
  expect(tracker, "tracker", index, (v) => v === "github" || v === "external");
  if (tracker === "external") {
    expect(entry["url"], "url", index, (v) => typeof v === "string" && /^https:\/\//.test(v));
    const url = entry["url"] as string;
    // Hostname derives from the URL; a stored value is never trusted.
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      throw new Error(`linked issues: entry ${index}: invalid url ${JSON.stringify(url)}`);
    }
    if (entry["label"] !== undefined) {
      expect(entry["label"], "label", index, (v) => typeof v === "string" && v.length > 0 && v.length <= 80);
    }
    const link: ExternalItemLink = { tracker, url, hostname, createdAt, source };
    if (typeof entry["label"] === "string" && entry["label"].length > 0) {
      link.label = entry["label"];
    }
    // A malformed jira field is dropped, not fatal: the link is still valid.
    const jira = entry["jira"];
    if (typeof jira === "object" && jira !== null && !Array.isArray(jira)) {
      const key = jira["key"];
      if (typeof key === "string" && JIRA_KEY_OK.test(key)) link.jira = { key };
    }
    return link;
  }
  expect(entry["repo"], "repo", index, (v) => typeof v === "string" && v.includes("/") && /[\w.-]+\/[\w.-]+/.test(v));
  expect(entry["issue"], "issue", index, (v) => typeof v === "number" && Number.isInteger(v) && v > 0);
  expect(entry["kind"], "kind", index, (v) => typeof v === "string" && LINK_KINDS.has(v));
  expect(entry["href"], "href", index, (v) => typeof v === "string" && v.startsWith("https://github.com/"));
  return {
    tracker: "github",
    repo: entry["repo"] as string,
    issue: entry["issue"] as number,
    kind: entry["kind"] as GitHubItemLink["kind"],
    href: entry["href"] as string,
    createdAt,
    source,
  };
}

function expect(
  value: JsonValue | undefined,
  field: string,
  index: number,
  ok: (value: unknown) => boolean,
): void {
  if (ok(value)) return;
  throw new Error(
    `linked issues: entry ${index}: invalid ${field} ${JSON.stringify(value)}`,
  );
}

/**
 * Parse a metadata value into ThreadLink[]. Absent (undefined) and null mean
 * "no links" → null. A malformed present value throws (fail loud, never
 * coerce): links must round-trip exactly between board, CLI, and agent tool,
 * so a wrong shape is a bug to surface, not data to paper over.
 */
export function parseLinkedIssues(value: JsonValue | undefined): ThreadLink[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error(
      `linked issues: expected array, got ${typeof value}`,
    );
  }
  return value.map(parseLink);
}

function sameItem(a: ThreadLink, b: ThreadLink): boolean {
  // GitHub redirects /issues/N ↔ /pull/N, so kind does not take part in
  // identity: repo + number is the item. External items are their URL.
  if (a.tracker === "external" || b.tracker === "external") {
    return a.tracker === "external" && b.tracker === "external" && a.url === b.url;
  }
  return a.repo === b.repo && a.issue === b.issue;
}

/**
 * Upsert one link: a new item goes first (primary); a re-set item moves to
 * the front and carries the fresh stamp and source (the newest write wins
 * the record, matching the done store's refresh rule).
 */
export function stampLinkedIssues(
  existing: ThreadLink[] | null,
  link: ThreadLink,
  opts?: { append?: boolean },
): ThreadLink[] {
  const rest = (existing ?? []).filter((entry) => !sameItem(entry, link));
  // append: an auto-detected link never takes over the primary chip.
  return opts?.append === true ? [...rest, link] : [link, ...rest];
}

/**
 * Remove one GitHub repo+number pair (number given), or everything (absent).
 * A number only ever matches GitHub links; external links clear via the
 * no-number form. Returns null when nothing remains, so the caller can
 * remove the key rather than store an empty array.
 */
export function clearLinkedIssues(
  existing: ThreadLink[] | null,
  issue: number | undefined,
): ThreadLink[] | null {
  if (existing === null) return null;
  const remaining =
    issue === undefined
      ? []
      : existing.filter(
          (entry) => entry.tracker !== "github" || entry.issue !== issue,
        );
  return remaining.length === 0 ? null : remaining;
}

/**
 * Chip merge: turn link records into TicketRefs for the card's chip row.
 * Dedupe by href against the text refs a title/branch scan already found —
 * when the title carries the full URL, the scan's chip wins (same target,
 * richer raw text); when the title's "#12" has no href (no repo base), the
 * link's stored href still earns the chip.
 */
export function linkedTicketRefs(
  links: ThreadLink[] | null | undefined,
  textRefs: TicketRef[] = [],
): TicketRef[] {
  if (!links || links.length === 0) return [];
  const known = new Set(
    textRefs.filter((ref) => ref.href !== undefined).map((ref) => ref.href!),
  );
  const seen = new Set<string>();
  const refs: TicketRef[] = [];
  for (const link of links) {
    const href = link.tracker === "external" ? link.url : link.href;
    if (known.has(href)) continue;
    if (link.tracker === "external") {
      // External items are their URL (identity by exact href), so dedupe by
      // href: two Forgejo items on one host share no raw text, and keying on
      // the label-or-hostname would collapse a whole host's items into one
      // chip. Where the URL is a Forgejo-shaped item (/issues/N, /pulls/N),
      // hydrate its number and kind so the chip shows "#42" with the PR
      // glyph instead of the bare hostname. A stored label overrides the id
      // text; anything else keeps the hostname fallback.
      if (seen.has(href)) continue;
      seen.add(href);
      const item = forgejoItemUrl(link.url);
      refs.push({
        raw: link.label ?? (item !== null ? `#${item.number}` : link.hostname),
        tracker: "external",
        href,
        hostname: link.hostname,
        ...(item !== null ? { kind: item.kind, number: item.number } : {}),
      });
      continue;
    }
    // GitHub links: chip rows key chips by raw text, and "#12" can repeat
    // across repos — stampLinkedIssues dedupes per repo+number but not across
    // repos. First entry wins (the array's primary link is first).
    const raw = `#${link.issue}`;
    if (seen.has(raw)) continue;
    seen.add(raw);
    refs.push({
      raw,
      tracker: "github",
      number: link.issue,
      href,
      // The store knows issue vs PR exactly (the URL said so); carrying
      // it means the PR glyph leads before any status lands.
      kind: link.kind,
    });
  }
  return refs;
}

/**
 * "owner/repo#number" strings for a thread's GitHub links, the batched
 * tracker_status lookup key (app.tsx groups visible refs per repo). External
 * links take no part: the dot path is GitHub-only.
 */
export function linkedRefKeys(
  links: ThreadLink[] | null | undefined,
): string[] {
  return (links ?? [])
    .filter((link) => link.tracker === "github")
    .map((link) => `${link.repo}#${link.issue}`);
}

/**
 * The full chip row for a thread: title/branch text refs after the chip
 * gate, joined by the store's link refs. The ONE definition of what a card
 * shows — ThreadCard renders it, and the toolbar search matches against it,
 * so a "#38" query finds every card carrying a #38 chip. (The chip rule
 * applies here too when `validatedHrefs` is wired: a text ref the tracker
 * never confirmed shows no chip and is not a search hit either; store links
 * are trusted by construction and always count.)
 */
export function cardTicketRefs(args: {
  title: string;
  /** Branch text refs scan too (ThreadCard's `extraText`). */
  branch?: string;
  /** Project's GitHub base; when present, #N text refs gain hrefs. */
  repoHrefBase?: string;
  linkedIssues?: ThreadLink[] | null;
  /** tracker_validate-confirmed hrefs; undefined keeps the pre-validation behavior. */
  validatedHrefs?: ReadonlySet<string>;
}): TicketRef[] {
  const scanned = findTicketRefs(args.title, {
    ...(args.branch !== undefined ? { extraText: args.branch } : {}),
    ...(args.repoHrefBase !== undefined ? { repoHrefBase: args.repoHrefBase } : {}),
  });
  // Same gate as the card: a TEXT ref chips only when the item was confirmed;
  // store links skip the gate entirely.
  const validated =
    args.validatedHrefs === undefined
      ? scanned
      : scanned.filter((ref) => ref.href !== undefined && args.validatedHrefs!.has(ref.href));
  return validated.concat(linkedTicketRefs(args.linkedIssues, validated));
}