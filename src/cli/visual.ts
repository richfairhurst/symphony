import type { OrchestratorRuntimeState, RetryEntry, RunningEntry } from "../core/state";
import type { LogEntry, LogSink } from "../obs/log";

type WriteFn = (chunk: string) => void;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatClock(tsIso: string): string {
  const d = new Date(tsIso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h${pad2(mm)}m`;
  }
  return `${m}:${pad2(r)}`;
}

function truncateEnd(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  return `${s.slice(0, max - 3)}...`;
}

function spinner(frame: number): string {
  const frames = ["-", "\\", "|", "/"] as const;
  return frames[frame % frames.length]!;
}

function compareRetry(a: RetryEntry, b: RetryEntry): number {
  if (a.dueAtMs !== b.dueAtMs) return a.dueAtMs - b.dueAtMs;
  return a.identifier.localeCompare(b.identifier);
}

function compareRunning(a: RunningEntry, b: RunningEntry): number {
  return a.issue.identifier.localeCompare(b.issue.identifier);
}

export function renderVisualScreen(opts: {
  nowMs: number;
  frame: number;
  state: OrchestratorRuntimeState;
  logs: LogEntry[];
  width: number;
  workflowPath: string;
}): string {
  const width = Math.max(60, opts.width);
  const nowMs = opts.nowMs;

  const running = Array.from(opts.state.running.values()).sort(compareRunning);
  const retrying = Array.from(opts.state.retryQueue.values()).sort(compareRetry);

  const headerLeft = `Symphony Orchestrator  ${spinner(opts.frame)}  ${running.length} running, ${retrying.length} retrying`;
  const headerRight = truncateEnd(opts.workflowPath, Math.max(0, width - headerLeft.length - 3));
  const header = headerRight.length > 0 ? `${headerLeft}  ${headerRight}` : headerLeft;

  const lines: string[] = [];
  lines.push(truncateEnd(header, width));
  lines.push("".padEnd(Math.min(width, header.length), "-"));
  lines.push("");

  lines.push("RUNNING");
  if (running.length === 0) {
    lines.push("  (none)");
  } else {
    for (const r of running) {
      const elapsed = formatDuration(nowMs - r.startedAtMs);
      const idle = formatDuration(nowMs - r.lastEventAtMs);
      const attempt = r.attempt === null ? "-" : String(r.attempt);
      const base = `${r.issue.identifier}  a=${attempt}  turns=${r.turnCount}  host=${r.host}  up=${elapsed}  idle=${idle}`;
      const title = r.issue.title ? `  ${r.issue.title}` : "";
      lines.push(`  ${truncateEnd(base + title, width - 2)}`);
    }
  }
  lines.push("");

  lines.push("RETRYING");
  if (retrying.length === 0) {
    lines.push("  (none)");
  } else {
    for (const r of retrying.slice(0, 10)) {
      const dueIn = formatDuration(r.dueAtMs - nowMs);
      const err = r.error ? `  err=${r.error}` : "";
      const base = `${r.identifier}  a=${r.attempt}  due_in=${dueIn}  kind=${r.kind}`;
      lines.push(`  ${truncateEnd(base + err, width - 2)}`);
    }
    if (retrying.length > 10) {
      lines.push(`  (+${retrying.length - 10} more)`);
    }
  }
  lines.push("");

  lines.push("ACTIVITY");
  const activity = opts.logs
    .filter((e) => e.message !== undefined || e.event === "log")
    .slice(-8);
  if (activity.length === 0) {
    lines.push("  (none)");
  } else {
    for (const e of activity) {
      const t = formatClock(e.ts);
      const msg = (e.message ?? e.event) + (e.error ? ` (${e.error.message})` : "");
      const base = `${t} ${e.level} ${msg}`;
      lines.push(`  ${truncateEnd(base, width - 2)}`);
    }
  }

  lines.push("");
  lines.push("Press Ctrl+C to stop.");

  return lines.map((l) => truncateEnd(l, width)).join("\n") + "\n";
}

export function createMemoryLogSink(opts: { limit: number }): { sink: LogSink; get: () => LogEntry[] } {
  const buf: LogEntry[] = [];
  const push = (e: LogEntry) => {
    buf.push(e);
    if (buf.length > opts.limit) buf.splice(0, buf.length - opts.limit);
  };
  return {
    sink: { write: push },
    get: () => buf.slice(),
  };
}

export function createTeeSink(sinks: LogSink[]): LogSink {
  return {
    write: (entry) => {
      for (const s of sinks) s.write(entry);
    },
    close: () => {
      for (const s of sinks) s.close?.();
    },
  };
}

export class VisualCli {
  private readonly stdout: WriteFn;
  private readonly state: () => OrchestratorRuntimeState;
  private readonly logs: () => LogEntry[];
  private readonly width: () => number;
  private readonly workflowPath: string;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private started = false;

  constructor(opts: {
    stdout: WriteFn;
    state: () => OrchestratorRuntimeState;
    logs: () => LogEntry[];
    width: () => number;
    workflowPath: string;
    intervalMs?: number;
  }) {
    this.stdout = opts.stdout;
    this.state = opts.state;
    this.logs = opts.logs;
    this.width = opts.width;
    this.workflowPath = opts.workflowPath;
    this.intervalMs = opts.intervalMs ?? 250;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stdout("\x1b[?25l\x1b[2J\x1b[H");
    this.renderOnce();
    this.timer = setInterval(() => this.renderOnce(), this.intervalMs);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    try {
      this.renderOnce();
    } catch {
      // ignore; cleanup should still restore the cursor
    } finally {
      this.stdout("\x1b[?25h\n");
    }
  }

  private renderOnce(): void {
    const nowMs = Date.now();
    const screen = renderVisualScreen({
      nowMs,
      frame: this.frame++,
      state: this.state(),
      logs: this.logs(),
      width: this.width(),
      workflowPath: this.workflowPath,
    });
    this.stdout(`\x1b[H${screen}\x1b[J`);
  }
}
