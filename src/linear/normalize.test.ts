import { describe, expect, test } from "bun:test";
import { normalizeLinearIssue } from "./normalize";

describe("normalizeLinearIssue", () => {
  test("normalizes labels + blocked_by", () => {
    const out = normalizeLinearIssue({
      id: "i1",
      identifier: "ABC-123",
      title: "T",
      description: null,
      priority: 2,
      branchName: "feature/abc-123",
      url: "https://linear.app/x",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-02T00:00:00Z",
      state: { name: "Todo" },
      labels: { nodes: [{ name: "Bug" }, { name: "P1" }] },
      inverseRelations: {
        nodes: [
          {
            type: "blocks",
            issue: { id: "b1", identifier: "ABC-1", state: { name: "Done" } },
          },
          { type: "relates", issue: { id: "x" } },
        ],
      },
    });

    expect(out.labels).toEqual(["bug", "p1"]);
    expect(out.blocked_by).toEqual([{ id: "b1", identifier: "ABC-1", state: "Done" }]);
    expect(out.branch_name).toBe("feature/abc-123");
    expect(out.created_at).toBe("2025-01-01T00:00:00.000Z");
    expect(out.updated_at).toBe("2025-01-02T00:00:00.000Z");
  });

  test("missing required fields -> linear_unknown_payload", () => {
    expect(() => normalizeLinearIssue({ title: "x" })).toThrow(
      expect.objectContaining({ code: "linear_unknown_payload" }),
    );
  });
});
