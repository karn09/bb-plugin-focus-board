// Agent side of the Jira feature: the ticket-matching instructions that
// bb.agents.configure contributes, the one-off turn texts behind the
// find-ticket and promote-epic card buttons, and the two tools' parameter
// schemas. Pure: no host, no SDK. Every ticket or record value put into text
// is JSON.stringify-quoted (it is untrusted metadata, not directions).
import { z } from "zod";
import type { PluginAgents } from "@get-bb/plugin-sdk";
import { JiraTicket, ThreadJiraRecord } from "./jira-schema";
import type { JiraSettings } from "./jira-settings";
import { extractJiraKeys } from "./jira-keys";

export const JIRA_LINK_TOOL = "focus_board_jira_link";
export const JIRA_SPAWN_TOOL = "focus_board_spawn_child";
export const JIRA_AGENT_TOOLS = [JIRA_LINK_TOOL, JIRA_SPAWN_TOOL];

const Key = JiraTicket.shape.key;

/** bb.agents.registerTool that also records each name: the plugin's one configure selects every recorded tool. */
export function trackedRegisterTool(agents: PluginAgents, names: string[]): PluginAgents["registerTool"] {
  return ((tool: { name: string }) => {
    names.push(tool.name);
    agents.registerTool(tool as never);
  }) as PluginAgents["registerTool"];
}

export const JiraLinkParams = z
  .object({
    key: Key,
    role: z.enum(["owner", "watching"]),
    ownerName: z.string().min(1).max(80).optional(),
    claimed: z.boolean(),
  })
  .refine((p) => p.role !== "watching" || p.ownerName !== undefined, { message: "ownerName is required when watching", path: ["ownerName"] });

export const SpawnChildParams = z.object({
  title: z.string().min(1).max(200),
  prompt: z.string().min(1),
  ticketKey: Key,
});

type Projects = Pick<JiraSettings, "projects" | "defaultProject">;

/** The matching instruction, also the find-ticket card's one-off turn. */
export function findTicketText(s: Projects): string {
  const jql = `project in (${s.projects.join(",")}) AND resolution = Unresolved AND text ~ "<terms>"`;
  return [
    "Jira ticket matching: this thread has no Jira ticket yet.",
    "When you can describe this thread's work in one sentence, and before creating a branch or editing files, find its Jira ticket.",
    `- Search with \`acli jira workitem search --jql '${jql}' --json\`. Search the operator's own tickets first (add \`AND assignee = currentUser()\`), then everything.`,
    "- Show the operator up to 5 candidates with their owners, and wait for a choice.",
    "- Unowned ticket: assign it to the operator and move it to In Progress with acli, then call focus_board_jira_link with role \"owner\" and claimed true.",
    "- The operator's own ticket: move it to In Progress if needed, then call focus_board_jira_link with role \"owner\" and claimed true.",
    "- Someone else's ticket: call focus_board_jira_link with role \"watching\" and ownerName, then stop and tell the operator who owns it. No Jira write.",
    `- No match: draft a ticket (summary, description, project, type, parent epic). The project defaults to ${JSON.stringify(s.defaultProject)}. Judge whether the work is ticket-shaped or epic-shaped (several deliverables, likely child threads, or weeks of work), and propose a parent epic or a new epic. Confirm with the operator, create it with acli, then link it.`,
    "- If the first user message contains a Jira key or a browse URL, link it immediately.",
  ].join("\n");
}

function linkedText(rec: ThreadJiraRecord): string {
  const keys = rec.links.map((l) => l.key);
  const main = (rec.links.find((l) => l.role === "owner") ?? rec.links[0]!).key;
  return [
    `Jira: this thread is linked to ${keys.map((k) => JSON.stringify(k)).join(", ")} (data).`,
    `- Put ${JSON.stringify(main)} in branch names and PR titles.`,
    "- Spin off child threads only through focus_board_spawn_child, never `bb thread spawn`. First draft the child's ticket from its prompt (a story or task in the epic when this ticket is an epic, otherwise a subtask of this ticket), confirm it with the operator, create it with acli, then pass its key as ticketKey.",
  ].join("\n");
}

/** What configure contributes for one thread: nothing while Jira is off. */
export function jiraConfigure(enabled: boolean, s: Projects, pluginMetadata: Record<string, unknown>): { tools: string[]; instructions?: string } {
  if (!enabled) return { tools: [] };
  const rec = ThreadJiraRecord.safeParse(pluginMetadata.jira);
  const linked = rec.success && rec.data.links.length > 0;
  return { tools: JIRA_AGENT_TOOLS, instructions: linked ? linkedText(rec.data) : findTicketText(s) };
}

export function promoteEpicText(key: string): string {
  return [
    `The operator asked to promote ${JSON.stringify(key)} to an epic: this thread has spun off two or more child threads.`,
    "Confirm with the operator first. Then convert the ticket to an epic with acli (change its issue type to Epic), and move its child tickets under it if needed.",
    "If acli cannot change the issue type, tell the operator to do it in Jira. Change nothing else.",
  ].join("\n");
}

/** `KEY: title`, unless the title already carries that key. */
export function titleWithKey(title: string, key: string): string {
  return extractJiraKeys(title, [key.split("-")[0]!]).includes(key) ? title : `${key}: ${title}`;
}
