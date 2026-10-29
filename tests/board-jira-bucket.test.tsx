// @vitest-environment jsdom
// A non-Attention view bucket whose generated id is "jira" (or even the Jira
// column id) is a normal lane: only the Attention view renders the Jira column.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Board } from "../components/board";
import { JIRA_COLUMN_ID } from "../components/grouping";
import { thread } from "./thread-fixture";

afterEach(cleanup);
type BoardProps = Parameters<typeof Board>[0];

function board(groupBy: "group" | "status", id: string) {
  const props = {
    columns: [{ id, label: "jira", threads: [thread({ id: "t1" })] }],
    groupBy, activeThreadId: null, doneIds: new Set<string>(), nestedChildrenByParent: new Map(),
    doneChildrenByParent: new Map(), childCountByParent: new Map(), dimmedIds: new Set<string>(),
    projectNameFor: () => "", repoBaseFor: () => null, statusFor: () => null, linkedIssuesFor: () => [],
    validatedHrefs: {} as never, onOpenThread: () => {}, onNewTask: () => {}, onClosePane: () => {},
    onDropDone: () => {}, onDropUnread: () => {}, onDropPinned: () => {}, menuActionsFor: () => [],
  } as unknown as BoardProps;
  return render(<Board {...props} />);
}

describe("Jira column id never swallows a thread lane", () => {
  it.each(["jira", JIRA_COLUMN_ID])("Group view bucket %s renders as a lane with its card", (id) => {
    board("group", id);
    expect(document.querySelector(`section[data-column-id="${id}"]`)).not.toBeNull();
    expect(document.querySelector('[data-jira-column]')).toBeNull();
  });
  it("Attention view: a bucket named jira is still a lane", () => {
    board("status", "jira");
    expect(document.querySelector('section[data-column-id="jira"]')).not.toBeNull();
  });
});
