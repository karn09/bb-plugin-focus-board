import { describe, expect, it } from "vitest";
import { JiraSnapshot, QueueOp, OpResult, ThreadJiraRecord } from "../lib/jira-schema";

const ticket = {
  key: "PT-1", summary: "s", status: "In Progress", statusCategory: "indeterminate",
  assignee: { accountId: "a", displayName: "A" }, assignedToMe: true, issueType: "Task",
  isEpic: false, parentKey: null, epicKey: null, openChildren: 0,
  updatedAt: "2026-10-29T00:00:00Z", url: "https://growtherapy.atlassian.net/browse/PT-1",
};
const snap = { version: 1, takenAt: "2026-10-29T00:00:00Z", ok: true, error: null, me: { accountId: "a" }, tickets: [ticket], prs: [], mentions: [] };

describe("JiraSnapshot", () => {
  it("accepts a valid snapshot", () => {
    expect(JiraSnapshot.parse(snap).tickets[0]!.key).toBe("PT-1");
  });
  it("rejects version 2", () => {
    expect(JiraSnapshot.safeParse({ ...snap, version: 2 }).success).toBe(false);
  });
  it("rejects a ticket missing key", () => {
    const { key: _k, ...bad } = ticket;
    expect(JiraSnapshot.safeParse({ ...snap, tickets: [bad] }).success).toBe(false);
  });
});

describe("QueueOp", () => {
  const base = { id: "o1", createdAt: "2026-10-29T00:00:00Z", threadId: null };
  it("accepts each op", () => {
    for (const o of [
      { op: "transition", key: "PT-1", toCategory: "done" },
      { op: "assign", key: "PT-1", to: "me" },
      { op: "comment", key: "PT-1", body: "hi" },
      { op: "create", project: "SRE", issueType: "Task", summary: "s", description: "d", parentKey: null },
    ]) expect(QueueOp.safeParse({ ...base, ...o }).success).toBe(true);
  });
  it("rejects a malformed key", () => {
    expect(QueueOp.safeParse({ ...base, op: "transition", key: "x; rm", toCategory: "done" }).success).toBe(false);
  });
});

describe("OpResult / ThreadJiraRecord", () => {
  it("parses an op result", () => {
    expect(OpResult.parse({ id: "o1", ok: true, error: null, createdKey: "PT-2" }).createdKey).toBe("PT-2");
  });
  const rec = { links: [{ key: "PT-1", role: "owner", source: "auto" }], enrolledAt: null, verifying: null, doneCheck: null, nudgedAt: null, deepCheckedAt: null, reason: null, checkInWith: null };
  it("parses a record and rejects a bad link key", () => {
    expect(ThreadJiraRecord.safeParse(rec).success).toBe(true);
    expect(ThreadJiraRecord.safeParse({ ...rec, links: [{ key: "bad", role: "owner", source: "auto" }] }).success).toBe(false);
  });
});
