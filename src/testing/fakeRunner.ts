import { AsyncQueue } from "../utils/asyncQueue";
import type { Runner, RunnerAbortReason, RunnerEvent, RunnerHandle, RunnerStartParams, RunnerWaitResult } from "../runner/types";

export type FakeRunPlan =
  ({ events?: RunnerEvent[] } & ({ kind: "success" } | { kind: "fail"; code?: number } | { kind: "hang" }));

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

    for (const ev of plan.events ?? []) q.push(ev);

    let abortReason: RunnerAbortReason | undefined;

    let resolveWait: ((v: RunnerWaitResult) => void) | null = null;
    let resolved = false;
    const waitPromise: Promise<RunnerWaitResult> = new Promise((resolve) => {
      resolveWait = resolve;
    });

    const resolveOnce = (v: RunnerWaitResult) => {
      if (resolved) return;
      resolved = true;
      resolveWait?.(v);
    };

    const finish = (opts: { endedAt: number; code: number | null; signal: NodeJS.Signals | null; abortReason?: RunnerAbortReason }) => {
      q.push({
        type: "process_exited",
        ts: opts.endedAt,
        code: opts.code,
        signal: opts.signal,
        ...(opts.abortReason !== undefined ? { abortReason: opts.abortReason } : {}),
        lastEventTs: opts.endedAt,
      });
      q.close();
      resolveOnce({
        pid,
        code: opts.code,
        signal: opts.signal,
        startedAt,
        endedAt: opts.endedAt,
        lastEventAt: opts.endedAt,
        ...(opts.abortReason !== undefined ? { abortReason: opts.abortReason } : {}),
      });
    };

    if (plan.kind !== "hang") {
      const endedAt = startedAt + 1;
      const code = plan.kind === "success" ? 0 : (plan.code ?? 1);
      finish({ endedAt, code, signal: null });
    }

    const abort = (reason: RunnerAbortReason = "cancelled") => {
      abortReason = reason;
      this.abortCalls.push({ pid, reason });
      finish({ endedAt: Date.now(), code: null, signal: "SIGTERM", abortReason });
    };

    const wait = () => waitPromise;

    return { pid, events: q, abort, wait };
  }
}
