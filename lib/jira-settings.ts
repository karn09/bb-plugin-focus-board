// Normalises the Jira plugin settings. Accepts either the short names
// (nudgeDays) or the stored setting keys (jiraNudgeDays); bad values fall
// back to defaults.
export type JiraSettings = {
  enabled: boolean;
  projects: string[];
  defaultProject: string;
  nudgeDays: number;
  deepCheckDays: number;
  staleTicketDays: number;
  nudgeTurnsPerPass: number;
  refreshMinutes: number;
};

const num = (raw: Record<string, unknown>, name: string, dflt: number): number => {
  const v = raw[name] ?? raw[`jira${name[0]!.toUpperCase()}${name.slice(1)}`];
  return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.floor(v)) : dflt;
};

export function jiraSettings(raw: Record<string, unknown>): JiraSettings {
  const pick = (n: string) => raw[n] ?? raw[`jira${n[0]!.toUpperCase()}${n.slice(1)}`];
  const p = pick("projects");
  const list = (Array.isArray(p) ? p : typeof p === "string" ? p.split(",") : [])
    .map((s) => String(s).trim().toUpperCase())
    .filter((s) => /^[A-Z][A-Z0-9]+$/.test(s));
  const d = pick("defaultProject");
  const nudgeDays = num(raw, "nudgeDays", 2);
  return {
    enabled: pick("enabled") === true,
    projects: list.length > 0 ? list : ["PT", "SRE"],
    defaultProject: typeof d === "string" && /^[A-Z][A-Z0-9]+$/.test(d.trim().toUpperCase()) ? d.trim().toUpperCase() : "SRE",
    nudgeDays,
    deepCheckDays: Math.max(num(raw, "deepCheckDays", 5), nudgeDays + 1),
    staleTicketDays: num(raw, "staleTicketDays", 30),
    nudgeTurnsPerPass: num(raw, "nudgeTurnsPerPass", 3),
    refreshMinutes: num(raw, "refreshMinutes", 2),
  };
}
