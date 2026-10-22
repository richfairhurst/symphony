import { describe, expect, test } from "bun:test";
import { FakeLinearClient } from "../testing/fakes/fakeLinearClient";
import { LinearTrackerClient } from "./linear";

describe("LinearTrackerClient", () => {
  test("lists candidate issues and issue states through the tracker interface", async () => {
    const fake = new FakeLinearClient();
    fake.upsertIssue({ id: "i1", identifier: "A-1", state: "Todo" });
    fake.upsertIssue({ id: "i2", identifier: "A-2", state: "Done" });
    const tracker = new LinearTrackerClient({ client: fake });

    const candidates = await tracker.listCandidateIssues({
      projectSlug: "proj",
      activeStates: ["Todo"],
    });
    const states = await tracker.getIssueStatesByIds(["i1", "i2"]);
    const terminal = await tracker.listIssueIdentifiersByStates({
      projectSlug: "proj",
      states: ["Done"],
    });

    expect(candidates.map((issue) => issue.identifier)).toEqual(["A-1"]);
    expect(states.get("i1")?.state).toBe("Todo");
    expect(states.get("i2")?.state).toBe("Done");
    expect(terminal).toEqual(["A-2"]);
  });

  test("updates ticket state and keeps a single workpad comment", async () => {
    const fake = new FakeLinearClient();
    fake.upsertIssue({ id: "i1", identifier: "A-1", state: "Todo" });
    const tracker = new LinearTrackerClient({ client: fake });

    const stateResult = await tracker.setIssueState?.({ identifier: "A-1", state: "In Progress" });
    const workpadCreate = await tracker.upsertWorkpad?.({
      identifier: "A-1",
      body: "Status: Running\n",
    });
    const workpadUpdate = await tracker.upsertWorkpad?.({
      identifier: "A-1",
      body: "Status: Done\n",
    });

    expect(stateResult).toEqual({ identifier: "A-1", state: "In Progress", changed: true });
    expect(workpadCreate?.action).toBe("create");
    expect(workpadUpdate?.action).toBe("update");
    expect(fake.getIssueComments("i1")).toHaveLength(1);
    expect(fake.getIssueComments("i1")[0]?.body).toContain("## Opencode Workpad");
    expect(fake.getIssueComments("i1")[0]?.body).toContain("Status: Done");
  });

  test("uses cached comment id to avoid duplicate workpad comments when reads lag", async () => {
    const fake = new FakeLinearClient();
    fake.upsertIssue({ id: "i1", identifier: "A-1", state: "Todo" });
    const tracker = new LinearTrackerClient({ client: fake });

    const created = await tracker.upsertWorkpad?.({
      identifier: "A-1",
      body: "Status: Running\n",
    });
    fake.hideIssueCommentsOnNextFetch("i1");
    const updated = await tracker.upsertWorkpad?.({
      identifier: "A-1",
      body: "Status: Done\n",
      ...(created?.commentId !== null && created?.commentId !== undefined ? { commentId: created.commentId } : {}),
    });

    expect(created?.action).toBe("create");
    expect(updated?.action).toBe("update");
    expect(fake.getIssueComments("i1")).toHaveLength(1);
    expect(fake.getIssueComments("i1")[0]?.body).toContain("Status: Done");
  });
});
