export type RunnerAbortReason =
  | "cancelled"
  | "timeout"
  | "stalled"
  | "event_read_timeout";

export type RunnerIssueRef = {
  id: string;
  identifier: string;
  title: string;
};

export type RunnerStartParams = {
  issue: RunnerIssueRef;
  attempt: number | null;
  host: string;
  workspacePath: string;
  prompt: string;

  command: string;
  agent?: string;
  model?: string;
  attach?: string;

  runTimeoutMs: number;
  stallTimeoutMs: number;
  eventReadTimeoutMs: number;
  cancelGraceMs: number;
};

export type RunnerEvent =
  | {
      type: "process_started";
      ts: number;
      pid: number;
      cwd: string;
      argv: string[];
    }
  | {
      type: "stdout_json";
      ts: number;
      sessionId?: string;
      value: unknown;
    }
  | {
      type: "stdout_malformed";
      ts: number;
      line: string;
      error: string;
    }
  | {
      type: "stderr";
      ts: number;
      line: string;
    }
  | {
      type: "process_exited";
      ts: number;
      code: number | null;
      signal: NodeJS.Signals | null;
      abortReason?: RunnerAbortReason;
      lastEventTs: number;
    };

export type RunnerWaitResult = {
  pid: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  abortReason?: RunnerAbortReason;
  startedAt: number;
  endedAt: number;
  lastEventAt: number;
};

export type RunnerHandle = {
  pid: number;
  events: AsyncIterable<RunnerEvent>;
  abort: (reason?: RunnerAbortReason) => void;
  wait: () => Promise<RunnerWaitResult>;
};

export type Runner = {
  startRun: (params: RunnerStartParams) => RunnerHandle;
};
