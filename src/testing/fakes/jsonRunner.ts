import { AsyncQueue } from "../../utils/asyncQueue";
import type { Runner, RunnerAbortReason, RunnerEvent, RunnerHandle, RunnerStartParams, RunnerWaitResult } from "../../runner/types";

export type JsonRunnerPlan =
  | { kind: "success"; stdoutJson?: unknown[]; stderr?: string[] }
  | { kind: "fail"; code?: number; stdoutJson?: unknown[]; stderr?: string[] }
  | { kind: "hang"; stdoutJson?: unknown[]; stderr?: string[] };

export class JsonRunner implements Runner {
  public starts: RunnerStartParams[] = [];

  constructor(private plans: JsonRunnerPlan[] = []) {}

  pushPlan(plan: JsonRunnerPlan): void {
    this.plans.push(plan);
  }

  startRun(params: RunnerStartParams): RunnerHandle {
    this.starts.push(params);

    const plan = this.plans.shift() ?? { kind: "success" };
    const startedAt = Date.now();
    const pid = Math.floor(Math.random() * 10000) + 1;
    let abortReason: RunnerAbortReason | undefined;

    const q = new AsyncQueue<RunnerEvent>();
    q.push({ type: "process_started", ts: startedAt, pid, cwd: params.workspacePath, argv: ["json-runner"] });

    let finished = false;
    let resolveWait: ((v: RunnerWaitResult) => void) | null = null;

    const pushOutputs = () => {
      const out = plan.stdoutJson ?? [];
      for (const v of out) {
        q.push({ type: "stdout_json", ts: Date.now(), value: v });
      }
      const err = plan.stderr ?? [];
      for (const line of err) {
        q.push({ type: "stderr", ts: Date.now(), line });
      }
    };

    const waitPromise: Promise<RunnerWaitResult> = new Promise((resolve) => {
      resolveWait = resolve;
      if (plan.kind === "hang") return;

      pushOutputs();
      const endedAt = Date.now();
      const code = plan.kind === "success" ? 0 : (plan.code ?? 1);
      q.push({
        type: "process_exited",
        ts: endedAt,
        code,
        signal: null,
        ...(abortReason !== undefined ? { abortReason } : {}),
        lastEventTs: endedAt,
      });
      q.close();
      finished = true;
      resolve({
        pid,
        code,
        signal: null,
        startedAt,
        endedAt,
        lastEventAt: endedAt,
        ...(abortReason !== undefined ? { abortReason } : {}),
      });
    });

    const abort = (reason: RunnerAbortReason = "cancelled") => {
      if (finished) return;
      abortReason = reason;
      pushOutputs();
      const endedAt = Date.now();
      q.push({
        type: "process_exited",
        ts: endedAt,
        code: null,
        signal: "SIGTERM",
        abortReason,
        lastEventTs: endedAt,
      });
      q.close();
      finished = true;
      resolveWait?.({
        pid,
        code: null,
        signal: "SIGTERM",
        startedAt,
        endedAt,
        lastEventAt: endedAt,
        abortReason,
      });
    };

    return { pid, events: q, abort, wait: () => waitPromise };
  }
}
