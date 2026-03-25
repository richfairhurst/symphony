import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { OpencodeCliRunner, type SpawnFn } from "./opencodeCli";
import type { RunnerEvent } from "./types";

function makeWritableSink(): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

describe("opencode CLI runner", () => {
  test("spawns with cwd and expected args", async () => {
    const calls: Array<{ argv0: string; argv: string[]; cwd: string }> = [];

    const spawnFn: SpawnFn = (argv0, argv, opts) => {
      calls.push({ argv0, argv, cwd: opts.cwd });
      return {
        pid: 123,
        stdin: makeWritableSink(),
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        kill: () => true,
        exited: Promise.resolve({ code: 0, signal: null }),
      };
    };

    const runner = new OpencodeCliRunner({ spawnFn });
    const handle = runner.startRun({
      issue: { id: "i1", identifier: "ABC-1", title: "Hello" },
      attempt: null,
      host: "local",
      workspacePath: "/tmp/ws",
      prompt: "do it",
      command: "opencode run --format json",
      agent: "scarlett",
      model: "gpt-5",
      attach: "http://127.0.0.1:1234",
      runTimeoutMs: 10_000,
      stallTimeoutMs: 10_000,
      eventReadTimeoutMs: 10_000,
      cancelGraceMs: 10,
    });
    await handle.wait();

    expect(calls.length).toBe(1);
    expect(calls[0]!.argv0).toBe("opencode");
    expect(calls[0]!.cwd).toBe("/tmp/ws");
    expect(calls[0]!.argv).toEqual([
      "run",
      "--format",
      "json",
      "--title",
      "ABC-1: Hello",
      "--agent",
      "scarlett",
      "--model",
      "gpt-5",
      "--attach",
      "http://127.0.0.1:1234",
      "--",
      "do it",
    ]);
    expect(handle.pid).toBe(123);
  });

  test("parses stdout JSON and tolerates malformed lines", async () => {
    const spawnFn: SpawnFn = () => {
      return {
        pid: 1,
        stdin: makeWritableSink(),
        stdout: Readable.from(["not json\n", '{"event":"ok","session_id":"s1"}\n']),
        stderr: Readable.from([]),
        kill: () => true,
        exited: Promise.resolve({ code: 0, signal: null }),
      };
    };

    const runner = new OpencodeCliRunner({ spawnFn });
    const handle = runner.startRun({
      issue: { id: "i1", identifier: "ABC-2", title: "T" },
      attempt: null,
      host: "local",
      workspacePath: "/tmp/ws",
      prompt: "p",
      command: "opencode run --format json",
      runTimeoutMs: 10_000,
      stallTimeoutMs: 10_000,
      eventReadTimeoutMs: 10_000,
      cancelGraceMs: 10,
    });

    const events: RunnerEvent[] = [];
    for await (const e of handle.events) events.push(e);
    const malformed = events.find((e) => e.type === "stdout_malformed");
    const json = events.find((e) => e.type === "stdout_json");
    expect(malformed).toBeTruthy();
    expect(json).toBeTruthy();
    expect((json as Extract<RunnerEvent, { type: "stdout_json" }>).sessionId).toBe("s1");
  });

  test("emits stderr diagnostics", async () => {
    const spawnFn: SpawnFn = () => {
      return {
        pid: 1,
        stdin: makeWritableSink(),
        stdout: Readable.from([]),
        stderr: Readable.from(["warn one\n"]),
        kill: () => true,
        exited: Promise.resolve({ code: 0, signal: null }),
      };
    };

    const runner = new OpencodeCliRunner({ spawnFn });
    const handle = runner.startRun({
      issue: { id: "i1", identifier: "ABC-3", title: "T" },
      attempt: null,
      host: "local",
      workspacePath: "/tmp/ws",
      prompt: "p",
      command: "opencode run --format json",
      runTimeoutMs: 10_000,
      stallTimeoutMs: 10_000,
      eventReadTimeoutMs: 10_000,
      cancelGraceMs: 10,
    });

    const events: RunnerEvent[] = [];
    for await (const e of handle.events) events.push(e);
    expect(events.some((e) => e.type === "stderr" && e.line === "warn one")).toBe(true);
  });

  test("cancellation sends SIGTERM then SIGKILL after grace", async () => {
    const signals: string[] = [];
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      setTimeout(() => resolve({ code: null, signal: "SIGKILL" }), 200);
    });

    const spawnFn: SpawnFn = () => {
      return {
        pid: 9,
        stdin: makeWritableSink(),
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        kill: (sig) => {
          signals.push(sig);
          return true;
        },
        exited,
      };
    };

    const runner = new OpencodeCliRunner({ spawnFn });
    const handle = runner.startRun({
      issue: { id: "i1", identifier: "ABC-4", title: "T" },
      attempt: null,
      host: "local",
      workspacePath: "/tmp/ws",
      prompt: "p",
      command: "opencode run --format json",
      runTimeoutMs: 10_000,
      stallTimeoutMs: 10_000,
      eventReadTimeoutMs: 10_000,
      cancelGraceMs: 20,
    });

    handle.abort("cancelled");
    await new Promise((r) => setTimeout(r, 60));

    expect(signals[0]).toBe("SIGTERM");
    expect(signals).toContain("SIGKILL");
    await handle.wait();
  });
});
