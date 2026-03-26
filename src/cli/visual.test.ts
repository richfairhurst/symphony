import { describe, expect, test } from "bun:test";
import { createEmptyState } from "../core/state";
import type { RunnerHandle, RunnerWaitResult } from "../runner/types";
import { renderVisualScreen, VisualCli } from "./visual";

function makeHandle(): RunnerHandle {
  const wait: RunnerWaitResult = {
    pid: 1,
    code: null,
    signal: null,
    startedAt: 0,
    endedAt: 0,
    lastEventAt: 0,
  };
  return {
    pid: 1,
    events: {
      async *[Symbol.asyncIterator]() {
        // no events
      },
    },
    abort: () => {
      // noop
    },
    wait: async () => wait,
  };
}

describe("visual CLI", () => {
  test("renders running + retrying + activity", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;

    state.running.set("1", {
      issue: {
        id: "1",
        identifier: "RIC-6",
        title: "Add visual CLI",
        description: null,
        priority: null,
        state: "Todo",
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      handle: makeHandle(),
      startedAtMs: nowMs - 65_000,
      lastEventAtMs: nowMs - 2_000,
      logsTail: [],
      activity: {
        stderrLines: 0,
        stdoutJsonEvents: 0,
        stdoutMalformedLines: 0,
        processExitedEvents: 0,
      },
      turnCount: 3,
      stopPolicy: "keep",
    });

    state.retryQueue.set("2", {
      issueId: "2",
      identifier: "RIC-7",
      attempt: 2,
      dueAtMs: nowMs + 10_000,
      kind: "failure",
      error: "exit:1",
    });

    const out = renderVisualScreen({
      nowMs,
      frame: 2,
      state,
      logs: [
        {
          ts: "2026-03-25T20:00:00.000Z",
          level: "info",
          event: "log",
          message: "dispatch tick",
          issue_id: null,
          issue_identifier: null,
          session_id: null,
        },
      ],
      width: 100,
      workflowPath: "/tmp/WORKFLOW.md",
    });

    expect(out).toContain("RUNNING");
    expect(out).toContain("RIC-6");
    expect(out).toContain("RETRYING");
    expect(out).toContain("RIC-7");
    expect(out).toContain("ACTIVITY");
    expect(out).toContain("dispatch tick");
  });

  test("restores cursor on stop", () => {
    const state = createEmptyState();
    let out = "";

    const v = new VisualCli({
      stdout: (c) => {
        out += c;
      },
      state: () => state,
      logs: () => [],
      width: () => 80,
      workflowPath: "/tmp/WORKFLOW.md",
      intervalMs: 10_000,
    });

    v.start();
    v.stop();

    expect(out).toContain("\x1b[?25l");
    expect(out).toContain("\x1b[?25h");
  });
});
