import { describe, expect, test } from "bun:test";
import type { TrackerIssue } from "../tracker";
import { DependencyValidationError, selectIndependentBatch, selectReadyTickets, validateDependencies } from "./dependencies";

function issue(identifier: string, opts: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    id: identifier.toLowerCase(),
    identifier,
    title: identifier,
    description: null,
    priority: 1,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
    ...opts,
  };
}

const config = { terminalStates: ["Done"] };

describe("ticket dependencies", () => {
  test("selects completed prerequisites and orders ready tickets by wave and identifier", () => {
    const prerequisite = issue("A-1", { state: "Done", integration_state: "succeeded", workstream_id: "main" });
    const second = issue("A-2", { prerequisite_ids: ["A-1"], workstream_id: "main", wave: 2 });
    const first = issue("A-3", { prerequisite_ids: ["A-1"], workstream_id: "main", wave: 1 });

    expect(selectReadyTickets([second, prerequisite, first], config).map((entry) => entry.identifier)).toEqual(["A-3", "A-2"]);
    expect(selectIndependentBatch([second, prerequisite, first], config).map((entry) => entry.identifier)).toEqual(["A-3", "A-2"]);
  });

  test("rejects missing, cross-workstream, cyclic, duplicate, and invalid terminal dependencies", () => {
    expect(() => validateDependencies([issue("A-2", { prerequisite_ids: ["A-1"] })], config)).toThrow(DependencyValidationError);
    expect(() => validateDependencies([
      issue("A-1", { workstream_id: "one" }),
      issue("A-2", { workstream_id: "two", prerequisite_ids: ["A-1"] }),
    ], config)).toThrow("Cross-workstream");
    expect(() => validateDependencies([
      issue("A-1", { prerequisite_ids: ["A-2"] }),
      issue("A-2", { prerequisite_ids: ["A-1"] }),
    ], config)).toThrow("cycle");
    expect(() => validateDependencies([issue("A-1"), issue("A-1")], config)).toThrow("Duplicate");
    expect(() => validateDependencies([issue("A-1", { state: "Done" }), issue("A-2", { prerequisite_ids: ["A-1"] })], config)).toThrow("terminal");
  });

  test("does not unlock a dependent after prerequisite failure", () => {
    const failed = issue("A-1", { state: "Blocked", integration_state: "failed", workstream_id: "main" });
    const dependent = issue("A-2", { prerequisite_ids: ["A-1"], workstream_id: "main" });
    expect(selectReadyTickets([failed, dependent], config)).toEqual([failed]);
  });
});
