import { describe, expect, test } from "bun:test";
import { compareIssuesForDispatch, isDispatchEligible, sortIssuesForDispatch } from "./eligibility";
import type { LinearIssue } from "./model";

const base: Omit<LinearIssue, "id" | "identifier" | "title" | "state"> = {
  description: null,
  priority: null,
  branch_name: null,
  url: null,
  labels: [],
  blocked_by: [],
  created_at: null,
  updated_at: null,
};

describe("isDispatchEligible", () => {
  test("requires active state and not terminal", () => {
    const cfg = { activeStates: ["Todo", "In Progress"], terminalStates: ["Done"] };
    const issue: LinearIssue = {
      ...base,
      id: "1",
      identifier: "ABC-1",
      title: "t",
      state: "In Progress",
    };
    expect(isDispatchEligible(issue, cfg)).toBe(true);

    expect(isDispatchEligible({ ...issue, state: "Done" }, cfg)).toBe(false);
    expect(isDispatchEligible({ ...issue, state: "Backlog" }, cfg)).toBe(false);
  });

  test("todo blocker rule is case-insensitive", () => {
    const cfg = { activeStates: ["todo"], terminalStates: ["done", "canceled"] };
    const issue: LinearIssue = {
      ...base,
      id: "1",
      identifier: "ABC-1",
      title: "t",
      state: "TODO",
      blocked_by: [{ id: "b", identifier: "ABC-2", state: "In Progress" }],
    };
    expect(isDispatchEligible(issue, cfg)).toBe(false);
    expect(isDispatchEligible({ ...issue, blocked_by: [{ id: "b", identifier: "ABC-2", state: "Done" }] }, cfg)).toBe(
      true,
    );
  });
});

describe("sorting", () => {
  test("compareIssuesForDispatch sorts priority, created_at, identifier", () => {
    const a: LinearIssue = {
      ...base,
      id: "1",
      identifier: "ABC-2",
      title: "t",
      state: "Todo",
      priority: 2,
      created_at: "2025-01-02T00:00:00.000Z",
    };
    const b: LinearIssue = {
      ...base,
      id: "2",
      identifier: "ABC-1",
      title: "t",
      state: "Todo",
      priority: 1,
      created_at: "2025-01-03T00:00:00.000Z",
    };
    const c: LinearIssue = {
      ...base,
      id: "3",
      identifier: "ABC-3",
      title: "t",
      state: "Todo",
      priority: 2,
      created_at: "2025-01-01T00:00:00.000Z",
    };
    const d: LinearIssue = {
      ...base,
      id: "4",
      identifier: "ABC-0",
      title: "t",
      state: "Todo",
      priority: null,
      created_at: "2025-01-01T00:00:00.000Z",
    };

    expect(compareIssuesForDispatch(a, b)).toBeGreaterThan(0);
    expect(sortIssuesForDispatch([a, b, c, d]).map((i) => i.identifier)).toEqual([
      "ABC-1",
      "ABC-3",
      "ABC-2",
      "ABC-0",
    ]);
  });
});
