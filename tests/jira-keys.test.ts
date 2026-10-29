import { describe, expect, it } from "vitest";
import { extractJiraKeys, jiraBrowseUrl } from "../lib/jira-keys";

describe("extractJiraKeys", () => {
  it("finds a key in a configured project", () => {
    expect(extractJiraKeys("PT-3879: Karpenter monitors", ["PT", "SRE"])).toEqual(["PT-3879"]);
  });
  it("ignores look-alikes", () => {
    expect(extractJiraKeys("UTF-8 fix, GLM-5, INC-340", ["PT", "SRE"])).toEqual([]);
  });
  it("dedupes, case-sensitive, in order", () => {
    expect(extractJiraKeys("pt-12 PT-12 PT-12", ["PT"])).toEqual(["PT-12"]);
    expect(extractJiraKeys("SRE-2 then PT-1 then SRE-2", ["PT", "SRE"])).toEqual(["SRE-2", "PT-1"]);
  });
  it("is repeatable (global regex state)", () => {
    expect(extractJiraKeys("PT-1", ["PT"])).toEqual(["PT-1"]);
    expect(extractJiraKeys("PT-1", ["PT"])).toEqual(["PT-1"]);
  });
  it("builds the browse url", () => {
    expect(jiraBrowseUrl("PT-1")).toBe("https://growtherapy.atlassian.net/browse/PT-1");
  });
});
