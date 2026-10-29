// Jira issue-key helpers. Pure: no host, no SDK.
export const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+)-(\d+)\b/g;

/** Unique keys in order of appearance, limited to the configured projects. */
export function extractJiraKeys(text: string, projects: readonly string[]): string[] {
  const out = new Set<string>();
  // matchAll clones the regex, so the shared global's lastIndex is never touched.
  for (const m of text.matchAll(JIRA_KEY_RE)) {
    if (projects.includes(m[1]!)) out.add(m[0]);
  }
  return [...out];
}

export function jiraBrowseUrl(key: string): string {
  return `https://growtherapy.atlassian.net/browse/${key}`;
}
