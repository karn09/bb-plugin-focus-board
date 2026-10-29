// Zod schemas for the Jira integration's on-disk and wire formats:
// the snapshot the companion script writes, the op queue it drains, op
// results, and the per-thread record under THREAD_JIRA_KEY.
import { z } from "zod";

/** Plugin metadata key holding a thread's ThreadJiraRecord. */
export const THREAD_JIRA_KEY = "jira";

const Key = z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/);
const Iso = z.string();

export const JiraTicket = z.object({
  key: Key,
  summary: z.string(),
  status: z.string(),
  statusCategory: z.enum(["new", "indeterminate", "done"]),
  assignee: z.object({ accountId: z.string(), displayName: z.string() }).nullable(),
  assignedToMe: z.boolean(),
  issueType: z.string(),
  isEpic: z.boolean(),
  parentKey: Key.nullable(),
  epicKey: Key.nullable(),
  openChildren: z.number().int().min(0),
  updatedAt: Iso,
  url: z.string(),
});
export type JiraTicket = z.infer<typeof JiraTicket>;

export const GhPr = z.object({
  repo: z.string(),
  number: z.number().int(),
  state: z.enum(["open", "closed", "merged"]),
  headRef: z.string(),
  title: z.string(),
  body: z.string(),
  checks: z.enum(["pass", "fail", "pending", "none"]),
  reviewDecision: z.enum(["approved", "changes_requested", "review_required"]).nullable(),
  updatedAt: Iso,
});
export type GhPr = z.infer<typeof GhPr>;

export const JiraSnapshot = z.object({
  version: z.literal(1),
  takenAt: Iso,
  ok: z.boolean(),
  error: z.string().nullable(),
  me: z.object({ accountId: z.string() }),
  tickets: z.array(JiraTicket),
  prs: z.array(GhPr),
  mentions: z.array(
    z.object({ key: Key, repo: z.string(), number: z.number().int(), mergedAt: Iso }),
  ),
});
export type JiraSnapshot = z.infer<typeof JiraSnapshot>;

const opBase = { id: z.string(), createdAt: Iso, threadId: z.string().nullable() };
export const QueueOp = z.discriminatedUnion("op", [
  z.object({ ...opBase, op: z.literal("transition"), key: Key, toCategory: z.enum(["indeterminate", "done"]) }),
  z.object({ ...opBase, op: z.literal("assign"), key: Key, to: z.enum(["me", "none"]) }),
  z.object({ ...opBase, op: z.literal("comment"), key: Key, body: z.string() }),
  z.object({
    ...opBase,
    op: z.literal("create"),
    project: z.string().regex(/^[A-Z][A-Z0-9]+$/),
    issueType: z.enum(["Task", "Story", "Epic", "Sub-task"]),
    summary: z.string(),
    description: z.string(),
    parentKey: Key.nullable(),
  }),
]);
export type QueueOp = z.infer<typeof QueueOp>;

export const OpResult = z.object({
  id: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
  createdKey: Key.nullable(),
});
export type OpResult = z.infer<typeof OpResult>;

export const ThreadJiraRecord = z.object({
  links: z.array(
    z.object({
      key: Key,
      role: z.enum(["owner", "watching"]),
      source: z.enum(["auto", "agent", "operator"]),
    }),
  ),
  enrolledAt: Iso.nullable(),
  verifying: z.object({ startedAt: Iso, reasons: z.array(z.string()).optional() }).nullable(),
  doneCheck: z
    .object({
      at: Iso,
      verdict: z.enum(["pass", "fail", "pending-confirm"]),
      reasons: z.array(z.string()),
      skipped: z.literal(true).optional(),
    })
    .nullable(),
  nudgedAt: Iso.nullable(),
  deepCheckedAt: Iso.nullable(),
  reason: z.string().nullable(),
  checkInWith: z.string().nullable(),
  epicSuggested: z.literal(true).optional(),
});
export type ThreadJiraRecord = z.infer<typeof ThreadJiraRecord>;
