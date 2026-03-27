import type { OrchestratorRuntimeState, RetryEntry, RunningEntry } from "../core/state";
import type { LogEntry, LogSink } from "../obs/log";

type WriteFn = (chunk: string) => void;

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
} as const;

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

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

function visibleLength(s: string): number {
  return s.replace(ANSI_PATTERN, "").length;
}

function takeVisiblePrefix(s: string, maxVisible: number): string {
  if (maxVisible <= 0) return "";
  let out = "";
  let visible = 0;
  for (let i = 0; i < s.length && visible < maxVisible; ) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i]!;
    i++;
    visible++;
  }
  return out;
}

function truncateEndAnsi(s: string, maxVisible: number): string {
  if (maxVisible <= 0) return "";
  const vis = visibleLength(s);
  if (vis <= maxVisible) return s;
  if (maxVisible <= 3) return takeVisiblePrefix(s, maxVisible) + ANSI.reset;
  return takeVisiblePrefix(s, maxVisible - 3) + "..." + ANSI.reset;
}

function padEndAnsi(s: string, widthVisible: number): string {
  const vis = visibleLength(s);
  if (vis >= widthVisible) return truncateEndAnsi(s, widthVisible);
  return s + " ".repeat(widthVisible - vis);
}

function padStartAnsi(s: string, widthVisible: number): string {
  const vis = visibleLength(s);
  if (vis >= widthVisible) return truncateEndAnsi(s, widthVisible);
  return " ".repeat(widthVisible - vis) + s;
}

function centerAnsi(s: string, widthVisible: number): string {
  const vis = visibleLength(s);
  if (vis >= widthVisible) return truncateEndAnsi(s, widthVisible);
  const pad = widthVisible - vis;
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return " ".repeat(left) + s + " ".repeat(right);
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

function dim(s: string): string {
  return `${ANSI.dim}${s}${ANSI.reset}`;
}

function bold(s: string): string {
  return `${ANSI.bold}${s}${ANSI.reset}`;
}

function colorStage(stage: string): string {
  const normalized = stage.trim().toLowerCase();
  if (normalized === "todo") return `${ANSI.yellow}${stage}${ANSI.reset}`;
  if (normalized === "in progress") return `${ANSI.green}${stage}${ANSI.reset}`;
  if (normalized === "rework") return `${ANSI.red}${stage}${ANSI.reset}`;
  if (normalized === "done") return `${ANSI.dim}${stage}${ANSI.reset}`;
  return stage;
}

function colorToolStatus(status: string | null | undefined): string {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "pending") return `${ANSI.red}${status}${ANSI.reset}`;
  if (s === "running") return `${ANSI.yellow}${status}${ANSI.reset}`;
  if (s === "failed" || s === "error") return `${ANSI.red}${status}${ANSI.reset}`;
  if (s === "completed" || s === "success") return `${ANSI.green}${status}${ANSI.reset}`;
  if (s === "") return "-";
  return status ?? "-";
}

function boxRule(width: number): string {
  return `+${"-".repeat(Math.max(0, width - 2))}+`;
}

function boxLine(width: number, content: string): string {
  const inner = Math.max(0, width - 4);
  return `| ${padEndAnsi(content, inner)} |`;
}

function formatMaybeNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  return Number.isFinite(n) ? String(Math.floor(n)) : "n/a";
}

function readRateNumber(obj: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!obj) return undefined;

  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }

  const requests = obj.requests;
  if (requests && typeof requests === "object" && !Array.isArray(requests)) {
    const r = requests as Record<string, unknown>;
    for (const k of keys) {
      const v = r[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
  }

  const tokens = obj.tokens;
  if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) {
    const t = tokens as Record<string, unknown>;
    for (const k of keys) {
      const v = t[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
  }

  return undefined;
}

function formatRateLimits(rateLimits: Record<string, unknown> | null): string {
  const reqRemaining = readRateNumber(rateLimits, [
    "requests_remaining",
    "requestsRemaining",
    "remaining_requests",
    "remainingRequests",
    "request_remaining",
    "requestRemaining",
  ]);
  const reqLimit = readRateNumber(rateLimits, [
    "requests_limit",
    "requestsLimit",
    "limit_requests",
    "limitRequests",
    "request_limit",
    "requestLimit",
  ]);

  const tokRemaining = readRateNumber(rateLimits, [
    "tokens_remaining",
    "tokensRemaining",
    "remaining_tokens",
    "remainingTokens",
    "token_remaining",
    "tokenRemaining",
  ]);
  const tokLimit = readRateNumber(rateLimits, [
    "tokens_limit",
    "tokensLimit",
    "limit_tokens",
    "limitTokens",
    "token_limit",
    "tokenLimit",
  ]);

  const req = `${formatMaybeNumber(reqRemaining)}/${formatMaybeNumber(reqLimit)}`;
  const tok = `${formatMaybeNumber(tokRemaining)}/${formatMaybeNumber(tokLimit)}`;
  return `${dim("req")} ${bold(req)} ${dim("tok")} ${bold(tok)}`;
}

function formatPid(pid: number | undefined): string {
  if (pid === undefined) return "-";
  return Number.isFinite(pid) ? String(pid) : "-";
}

function formatOpencodeTailLine(e: {
  ts: string;
  type: string | null;
  tool: string | null;
  status: string | null;
  text: string | null;
}): string {
  const ts = formatClock(e.ts);
  const type = e.type ?? "-";
  const tool = e.tool ?? "-";
  const status = colorToolStatus(e.status);
  const text = (e.text ?? "").trim();
  const oneLine = text === "" ? "" : truncateEnd(text.replace(/\s+/g, " "), 160);
  return `${dim(ts)}  ${bold(type)}  ${tool} ${status}${oneLine ? `  ${dim(oneLine)}` : ""}`;
}

function chooseEventFeedLines(width: number): number {
  if (width < 80) return 3;
  if (width < 110) return 4;
  return 6;
}

type TableCol = {
  key: string;
  title: string;
  min: number;
  ideal: number;
  dropPriority: number;
  align: "left" | "right";
};

function chooseColumns(total: number): TableCol[] {
  const all: TableCol[] = [
    { key: "id", title: "ID", min: 6, ideal: 8, dropPriority: 0, align: "left" },
    { key: "stage", title: "Stage", min: 4, ideal: 12, dropPriority: 2, align: "left" },
    { key: "pid", title: "PID", min: 3, ideal: 5, dropPriority: 5, align: "right" },
    { key: "ageTurn", title: "Age/Turn", min: 7, ideal: 9, dropPriority: 1, align: "left" },
    { key: "tokens", title: "Tokens", min: 4, ideal: 7, dropPriority: 4, align: "right" },
    { key: "session", title: "Session", min: 6, ideal: 8, dropPriority: 6, align: "left" },
    { key: "event", title: "Event", min: 10, ideal: 34, dropPriority: 3, align: "left" },
  ];

  const minWithSpaces = (cols: TableCol[]) => cols.reduce((sum, c) => sum + c.min, 0) + Math.max(0, cols.length - 1);

  let cols = all.slice();
  while (cols.length > 3 && minWithSpaces(cols) > total) {
    const drop = cols.reduce((best, c) => (c.dropPriority > best.dropPriority ? c : best), cols[0]!);
    cols = cols.filter((c) => c.key !== drop.key);
  }
  return cols;
}

function allocateWidths(total: number, cols: TableCol[]): Array<TableCol & { width: number }> {
  const widths = cols.map((c) => ({ ...c, width: c.ideal }));
  const sumWidths = () => widths.reduce((s, c) => s + c.width, 0) + Math.max(0, widths.length - 1);

  // Shrink to fit.
  let overflow = sumWidths() - total;
  const shrinkOrder = ["event", "session", "stage", "tokens", "ageTurn", "pid", "id"];
  for (const key of shrinkOrder) {
    if (overflow <= 0) break;
    const c = widths.find((w) => w.key === key);
    if (!c) continue;
    const can = c.width - c.min;
    if (can <= 0) continue;
    const take = Math.min(can, overflow);
    c.width -= take;
    overflow -= take;
  }

  // If still overflow (very narrow), clamp everything proportionally down to 1.
  if (overflow > 0) {
    for (const c of widths) c.width = Math.max(1, Math.min(c.width, c.min));
  }

  // Grow remaining space into the event column.
  let remaining = total - sumWidths();
  if (remaining > 0) {
    const ev = widths.find((w) => w.key === "event");
    if (ev) ev.width += remaining;
  }
  return widths;
}

function renderRow(cols: Array<TableCol & { width: number }>, values: Record<string, string>): string {
  const parts: string[] = [];
  for (const c of cols) {
    const raw = values[c.key] ?? "";
    const v = truncateEndAnsi(raw, c.width);
    if (c.align === "right") parts.push(padStartAnsi(v, c.width));
    else parts.push(padEndAnsi(v, c.width));
  }
  return parts.join(" ");
}

export function renderVisualScreen(opts: {
  nowMs: number;
  frame: number;
  state: OrchestratorRuntimeState;
  logs: LogEntry[];
  width: number;
  workflowPath: string;
}): string {
  const width = Math.max(20, opts.width);
  const nowMs = opts.nowMs;

  const running = Array.from(opts.state.running.values()).sort(compareRunning);
  const retrying = Array.from(opts.state.retryQueue.values()).sort(compareRetry);

  const lines: string[] = [];

  lines.push(boxRule(width));
  lines.push(boxLine(width, centerAnsi(bold("SYMPHONY STATUS"), Math.max(0, width - 4))));
  lines.push(boxRule(width));

  const maxAgents = opts.state.maxConcurrentAgents;
  const maxAgentsText = maxAgents === null ? "n/a" : String(maxAgents);
  const startedAt = opts.state.orchestratorStartedAtMs;
  const runtime = startedAt === null ? "n/a" : formatDuration(nowMs - startedAt);
  const nextTick = opts.state.nextTickDueAtMs;
  const poll = opts.state.pollIntervalMs;
  const refreshIn = nextTick === null ? "n/a" : formatDuration(nextTick - nowMs);
  const cadence = poll === null ? "n/a" : `${Math.floor(poll / 1000)}s`;

  const tokenIn = formatMaybeNumber(opts.state.tokenInputTotal);
  const tokenOut = formatMaybeNumber(opts.state.tokenOutputTotal);
  const tokenTotal = formatMaybeNumber(opts.state.tokenTotal);
  const project = opts.state.projectSlug ?? "n/a";

  lines.push(
    boxLine(
      width,
      [
        `${dim("Agents")}: ${bold(`${running.length}/${maxAgentsText}`)}`,
        `${dim("Claimed")}: ${String(opts.state.claimed.size)}`,
        `${dim("Runtime")}: ${bold(runtime)}`,
        `${dim("Refresh")}: ${bold(refreshIn)} ${dim(`(${cadence})`)}`,
      ].join("  "),
    ),
  );
  lines.push(
    boxLine(
      width,
      [
        `${dim("Tokens")}: ${dim("in")} ${bold(tokenIn)} ${dim("out")} ${bold(tokenOut)} ${dim("total")} ${bold(tokenTotal)}`,
        `${dim("Rate limits")}: ${formatRateLimits(opts.state.codexRateLimits)}`,
      ].join("  "),
    ),
  );
  lines.push(
    boxLine(
      width,
      [
        `${dim("Project")}: ${bold(project)}`,
        `${dim("Workflow")}: ${truncateEnd(opts.workflowPath, 64)}`,
      ].join("  "),
    ),
  );

  lines.push(boxRule(width));
  lines.push(boxLine(width, bold("RUNNING AGENTS")));

  const tableInner = Math.max(0, width - 4);
  const cols = allocateWidths(tableInner, chooseColumns(tableInner));

  lines.push(boxLine(width, renderRow(cols, Object.fromEntries(cols.map((c) => [c.key, c.title])))));
  lines.push(boxLine(width, "".padEnd(Math.min(tableInner, cols.reduce((s, c) => s + c.width, 0) + Math.max(0, cols.length - 1)), "-")));

  if (running.length === 0) {
    lines.push(boxLine(width, dim("No running agents")));
  } else {
    const maxRows = 12;
    const maxFeed = chooseEventFeedLines(width);
    for (const r of running.slice(0, maxRows)) {
      const elapsed = formatDuration(nowMs - r.startedAtMs);
      const ageTurn = `${elapsed}/${r.turnCount}`;
      const tokens = r.tokenTotal !== undefined ? String(r.tokenTotal) : "n/a";
      const session = r.lastSessionId ?? "-";
      const event = r.lastEventSummary ?? "-";
      const stage = colorStage(r.issue.state);

      const ses = r.opencodeSession ?? null;
      const tail = ses?.tail?.length ? ses.tail.slice(Math.max(0, ses.tail.length - maxFeed)) : [];
      const feedLines = tail.map(formatOpencodeTailLine);

      const eventLines = feedLines.length > 0 ? [event, ...feedLines] : [event];

      const firstRow = renderRow(cols, {
        id: r.issue.identifier,
        stage,
        pid: formatPid(r.pid),
        ageTurn,
        tokens,
        session,
        event: eventLines[0] ?? "-",
      });
      lines.push(boxLine(width, firstRow));

      for (const line of eventLines.slice(1)) {
        const cont = renderRow(cols, {
          event: line,
        });
        lines.push(boxLine(width, cont));
      }
    }
    if (running.length > maxRows) {
      lines.push(boxLine(width, dim(`(+${running.length - maxRows} more)`)));
    }
  }

  lines.push(boxRule(width));
  lines.push(boxLine(width, bold("BACKOFF QUEUE")));
  if (retrying.length === 0) {
    lines.push(boxLine(width, dim("No queued retries")));
  } else {
    const maxRows = 8;
    for (const r of retrying.slice(0, maxRows)) {
      const dueIn = formatDuration(r.dueAtMs - nowMs);
      const err = r.error ? `  ${dim("err")}=${truncateEnd(r.error, 36)}` : "";
      const base = `${bold(r.identifier)}  ${dim("attempt")}=${r.attempt}  ${dim("due in")}=${bold(dueIn)}  ${dim("kind")}=${r.kind}`;
      lines.push(boxLine(width, base + err));
    }
    if (retrying.length > maxRows) {
      lines.push(boxLine(width, dim(`(+${retrying.length - maxRows} more)`)));
    }
  }

  lines.push(boxRule(width));
  lines.push(boxLine(width, dim("Press Ctrl+C to stop.")));
  lines.push(boxRule(width));

  return lines.map((l) => truncateEndAnsi(l, width)).join("\n") + "\n";
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
      // ignore: cleanup render best-effort; restore cursor anyway
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
