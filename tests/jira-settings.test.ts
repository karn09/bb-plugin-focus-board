import { describe, expect, it } from "vitest";
import { jiraSettings } from "../lib/jira-settings";

describe("jiraSettings", () => {
  it("defaults", () => {
    expect(jiraSettings({})).toEqual({
      enabled: false, projects: ["PT", "SRE"], defaultProject: "SRE", nudgeDays: 2,
      deepCheckDays: 5, staleTicketDays: 30, nudgeTurnsPerPass: 3, refreshMinutes: 2,
    });
  });
  it("clamps deepCheckDays above nudgeDays", () => {
    expect(jiraSettings({ nudgeDays: 4, deepCheckDays: 3 }).deepCheckDays).toBe(5);
  });
  it("floors days at 1 and ignores garbage", () => {
    const s = jiraSettings({ nudgeDays: 0, staleTicketDays: "x" });
    expect(s.nudgeDays).toBe(1);
    expect(s.staleTicketDays).toBe(30);
  });
  it("reads prefixed setting keys and comma-separated projects", () => {
    const s = jiraSettings({ jiraEnabled: true, jiraProjects: "pt, ops" });
    expect(s.enabled).toBe(true);
    expect(s.projects).toEqual(["PT", "OPS"]);
  });
});
