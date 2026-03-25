import { AsyncQueue } from "../utils/asyncQueue";
import type { Runner, RunnerAbortReason, RunnerEvent, RunnerHandle, RunnerStartParams, RunnerWaitResult } from "../runner/types";

export type FakeRunPlan =
  | { kind: "success" }
  | { kind: "fail"; code?: number }
  | { kind: "hang" };

export class FakeRunner implements Runner {
  private plans: FakeRunPlan[];
  public abortCalls: Array<{ pid: number; reason?: RunnerAbortReason }> = [];
  public starts: RunnerStartParams[] = [];

  constructor(plans: FakeRunPlan[] = []) {
    this.plans = [...plans];
  }

  pushPlan(plan: FakeRunPlan): void {
    this.plans.push(plan);
  }

  startRun(params: RunnerStartParams): RunnerHandle {
    this.starts.push(params);
    const plan = this.plans.shift() ?? { kind: "success" };
    const startedAt = Date.now();
    const pid = Math.floor(Math.random() * 10000) + 1;
    const q = new AsyncQueue<RunnerEvent>();
    q.push({ type: "process_started", ts: startedAt, pid, cwd: params.workspacePath, argv: ["fake"] });

    let abortReason: RunnerAbortReason | undefined;

    const waitPromise: Promise<RunnerWaitResult> = new Promise((resolve) => {
      if (plan.kind === "hang") return;
      const endedAt = startedAt + 1;
      const code = plan.kind === "success" ? 0 : (plan.code ?? 1);
      q.push({ type: "process_exited", ts: endedAt, code, signal: null, lastEventTs: endedAt });
      q.close();
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
      abortReason = reason;
      this.abortCalls.push({ pid, reason });
      q.push({
        type: "process_exited",
        ts: Date.now(),
        code: null,
        signal: "SIGTERM",
        abortReason,
        lastEventTs: Date.now(),
      });
      q.close();
    };

    const wait = () => waitPromise;

    return { pid, events: q, abort, wait };
  }
}
