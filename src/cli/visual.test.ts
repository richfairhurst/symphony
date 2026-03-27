import { describe, expect, test } from "bun:test";
import { createEmptyState } from "../core/state";
import type { RunnerHandle, RunnerWaitResult } from "../runner/types";
import { renderVisualScreen, VisualCli } from "./visual";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

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
  test("renders status header + running + backoff", () => {
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
        branch_name: null,
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

    const out = stripAnsi(
      renderVisualScreen({
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
      }),
    );

    expect(out).toContain("SYMPHONY STATUS");
    expect(out).toContain("RUNNING AGENTS");
    expect(out).toContain("RIC-6");
    expect(out).not.toContain("OPENCODE SESSION");
    expect(out).toContain("BACKOFF QUEUE");
    expect(out).toContain("RIC-7");
  });

  test("inlines per-agent opencode session tail into Event column", () => {
    const state = createEmptyState();

    const mkRunning = (identifier: string) => ({
      issue: {
        id: identifier,
        identifier,
        title: "t",
        description: null,
        priority: null,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      handle: makeHandle(),
      startedAtMs: 0,
      lastEventAtMs: 0,
      logsTail: [],
      activity: {
        stderrLines: 0,
        stdoutJsonEvents: 0,
        stdoutMalformedLines: 0,
        processExitedEvents: 0,
      },
      lastEventSummary: "step_start",
      opencodeSession: {
        id: `ses_${identifier}`,
        updated_at: "2026-03-25T20:00:00.000Z",
        summary: "ok",
        tail: [
          {
            ts: "2026-03-25T20:00:00.000Z",
            type: "reasoning",
            tool: null,
            status: null,
            text: `tail-${identifier}`,
          },
        ],
      },
      turnCount: 0,
      stopPolicy: "keep" as const,
    });

    state.running.set("1", mkRunning("RIC-26"));
    state.running.set("2", mkRunning("RIC-25"));

    const renderHeaderLine = (nowMs: number): string => {
      const out = stripAnsi(
        renderVisualScreen({
          nowMs,
          frame: 0,
          state,
          logs: [],
          width: 100,
          workflowPath: "/tmp/WORKFLOW.md",
        }),
      );
      const lines = out.split("\n");
      const idx = lines.findIndex((l) => l.includes("OPENCODE SESSION"));
      return idx >= 0 ? (lines[idx + 1] ?? "") : "";
    };

    expect(renderHeaderLine(10_000)).toContain("RIC-25");
    expect(renderHeaderLine(10_000)).toContain("(1/2)");

    expect(renderHeaderLine(15_000)).toContain("RIC-26");
    expect(renderHeaderLine(15_000)).toContain("(2/2)");
  });

  test("does not show rotation position for a single agent", () => {
    const state = createEmptyState();
    state.running.set("1", {
      issue: {
        id: "1",
        identifier: "RIC-1",
        title: "t",
        description: null,
        priority: null,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      handle: makeHandle(),
      startedAtMs: 0,
      lastEventAtMs: 0,
      logsTail: [],
      activity: {
        stderrLines: 0,
        stdoutJsonEvents: 0,
        stdoutMalformedLines: 0,
        processExitedEvents: 0,
      },
      turnCount: 0,
      stopPolicy: "keep",
    });

    const out = stripAnsi(
      renderVisualScreen({
        nowMs: 10_000,
        frame: 0,
        state,
        logs: [],
        width: 100,
        workflowPath: "/tmp/WORKFLOW.md",
      }),
    );

    expect(out).not.toContain("OPENCODE SESSION");
    expect(out).toContain("RIC-25");
    expect(out).toContain("tail-RIC-25");
    expect(out).toContain("RIC-26");
    expect(out).toContain("tail-RIC-26");
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

  test("never exceeds the configured width", () => {
    const state = createEmptyState();
    const nowMs = 1_700_000_000_000;

    state.running.set("1", {
      issue: {
        id: "1",
        identifier: "RIC-123",
        title: "Long title that should be truncated",
        description: null,
        priority: null,
        state: "In Progress",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null,
      },
      attempt: 1,
      host: "local",
      handle: makeHandle(),
      pid: 12345,
      startedAtMs: nowMs - 65_000,
      lastEventAtMs: nowMs - 2_000,
      logsTail: [],
      activity: {
        stderrLines: 0,
        stdoutJsonEvents: 0,
        stdoutMalformedLines: 0,
        processExitedEvents: 0,
      },
      turnCount: 999,
      lastSessionId: "sess_abcdefghijklmnopqrstuvwxyz0123456789",
      lastEventSummary: "a very long event summary that should be truncated to fit the terminal width",
      opencodeSession: {
        id: "ses_1",
        updated_at: "2026-03-25T20:00:00.000Z",
        summary: "ok",
        tail: [
          {
            ts: "2026-03-25T20:00:00.000Z",
            type: "reasoning",
            tool: null,
            status: null,
            text: "a very long opencode tail line that should also be truncated to fit the terminal width",
          },
        ],
      },
      tokenTotal: 123456,
      stopPolicy: "keep",
    });

    const width = 60;
    const out = renderVisualScreen({
      nowMs,
      frame: 2,
      state,
      logs: [],
      width,
      workflowPath: "/a/really/long/path/to/a/workflow/file/that/should/not/wrap/WORKFLOW.md",
    });

    for (const line of out.split("\n")) {
      if (line === "") continue;
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});
