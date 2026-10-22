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

type SemanticTone = "accent" | "error" | "info" | "muted" | "success" | "warn";

const SEMANTIC_ANSI: Record<SemanticTone, string> = {
  accent: ANSI.cyan,
  error: ANSI.red,
  info: ANSI.cyan,
  muted: ANSI.dim,
  success: ANSI.green,
  warn: ANSI.yellow,
};

const STAGE_TONE: Record<string, SemanticTone> = {
  todo: "warn",
  "in progress": "accent",
  rework: "error",
  done: "muted",
};

const STATUS_TONE: Record<string, SemanticTone> = {
  completed: "success",
  error: "error",
  failed: "error",
  pending: "muted",
  running: "info",
  skipped: "muted",
  succeeded: "success",
  success: "success",
};

type RetryFailureStage = NonNullable<RetryEntry["failureStage"]>;

const RETRY_STAGE_LABEL: Record<RetryFailureStage, string> = {
  dispatch: "dispatch failure",
  runner: "runner failure",
  verifier: "verifier failure",
  graph: "graph failure",
  planner: "planner failure",
};

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatClock(tsIso: string): string {
  const d = new Date(tsIso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatClockMs(tsMs: number): string {
  if (!Number.isFinite(tsMs)) return "--:--:--";
  return formatClock(new Date(tsMs).toISOString());
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

function truncateMiddle(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);

  const keep = max - 3;
  const left = Math.max(1, Math.ceil(keep / 2));
  const right = Math.max(1, Math.floor(keep / 2));
  return `${s.slice(0, left)}...${s.slice(Math.max(left, s.length - right))}`;
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

function compareIdentifier(a: { issue: { identifier: string } }, b: { issue: { identifier: string } }): number {
  return a.issue.identifier.localeCompare(b.issue.identifier);
}

function bold(s: string): string {
  return style(s, ANSI.bold);
}

function style(s: string, ...codes: string[]): string {
  return `${codes.join("")}${s}${ANSI.reset}`;
}

function tint(tone: SemanticTone, s: string): string {
  return style(s, SEMANTIC_ANSI[tone]);
}

function tintMaybe(tone: SemanticTone | undefined, s: string): string {
  return tone === undefined ? s : tint(tone, s);
}

function muted(s: string): string {
  return tint("muted", s);
}

function accent(s: string): string {
  return tint("accent", s);
}

function info(s: string): string {
  return tint("info", s);
}

function success(s: string): string {
  return tint("success", s);
}

function warn(s: string): string {
  return tint("warn", s);
}

function error(s: string): string {
  return tint("error", s);
}

function sectionTitle(s: string): string {
  return style(s, SEMANTIC_ANSI.accent, ANSI.bold);
}

function colorStage(stage: string): string {
  return tintMaybe(STAGE_TONE[stage.trim().toLowerCase()], stage);
}

function colorToolStatus(status: string | null | undefined): string {
  const s = (status ?? "").trim().toLowerCase();
  if (s === "") return "-";
  return tintMaybe(STATUS_TONE[s], status ?? "-");
}

function boxRule(width: number): string {
  return `+${"-".repeat(Math.max(0, width - 2))}+`;
}

function boxLine(width: number, content: string): string {
  const inner = Math.max(0, width - 4);
  return `| ${padEndAnsi(content, inner)} |`;
}

function boxContentWidth(width: number): number {
  return Math.max(0, width - 4);
}

function wrapSegments(
  segments: Array<string | null | undefined>,
  widthVisible: number,
  separator = "  ",
): string[] {
  if (widthVisible <= 0) return [""];

  const parts = segments
    .filter((segment): segment is string => segment !== null && segment !== undefined && segment !== "")
    .map((segment) => truncateEndAnsi(segment, widthVisible));

  if (parts.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  for (const part of parts) {
    if (current === "") {
      current = part;
      continue;
    }

    const candidate = `${current}${separator}${part}`;
    if (visibleLength(candidate) <= widthVisible) {
      current = candidate;
      continue;
    }

    lines.push(current);
    current = part;
  }

  lines.push(current);
  return lines;
}

function pushWrappedSegments(
  lines: string[],
  width: number,
  segments: Array<string | null | undefined>,
  separator = "  ",
): void {
  for (const line of wrapSegments(segments, boxContentWidth(width), separator)) {
    lines.push(boxLine(width, line));
  }
}

function formatMaybeNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "n/a";
  return Number.isFinite(n) ? String(Math.floor(n)) : "n/a";
}

function compactText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact === "" ? null : compact;
}

function joinParts(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => part !== null && part !== undefined && part !== "").join("  ");
}

function formatCompactList(values: string[], maxItems = 3): string {
  if (values.length === 0) return "-";
  if (values.length <= maxItems) return values.join(", ");
  return `${values.slice(0, maxItems).join(", ")} +${values.length - maxItems}`;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function summarizeVisualGraphMetrics(state: OrchestratorRuntimeState): {
  graphRuns: number;
  graphSucceeded: number;
  plannerRuns: number;
  plannerSucceeded: number;
  averageGraphDurationMs: number | null;
  averageCompletedNodes: number | null;
} {
  return {
    graphRuns: state.graphHistory.length,
    graphSucceeded: state.graphHistory.filter((entry) => entry.status === "succeeded").length,
    plannerRuns: state.plannerHistory.length,
    plannerSucceeded: state.plannerHistory.filter((entry) => entry.status === "succeeded").length,
    averageGraphDurationMs: average(state.graphHistory.map((entry) => entry.endedAtMs - entry.startedAtMs)),
    averageCompletedNodes: average(state.graphHistory.map((entry) => entry.completedNodeCount)),
  };
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
  return `${muted("req")} ${bold(req)} ${muted("tok")} ${bold(tok)}`;
}

function formatPid(pid: number | undefined): string {
  if (pid === undefined) return "-";
  return Number.isFinite(pid) ? String(pid) : "-";
}

function formatNodeAge(node: { startedAtMs?: number; endedAtMs?: number }, nowMs: number): string {
  if (node.startedAtMs === undefined) return "-";
  return formatDuration((node.endedAtMs ?? nowMs) - node.startedAtMs);
}

function formatNodeFiles(files: string[]): string {
  if (files.length === 0) return "-";
  if (files.length === 1) return files[0]!;
  return `${files[0]} +${files.length - 1}`;
}

function formatGraphNodeSegments(
  node: {
    id: string;
    files: string[];
    status: string;
    startedAtMs?: number;
    endedAtMs?: number;
    pid?: number;
    lastSessionId?: string;
    turnCount: number;
    tokenTotal?: number;
    output?: Record<string, unknown>;
    lastEventSummary?: string;
    error?: string;
  },
  nowMs: number,
): string[] {
  const outputSummary = compactText(node.output?.summary);
  const process = node.pid !== undefined ? `pid=${formatPid(node.pid)}` : node.lastSessionId ? `ses=${truncateMiddle(node.lastSessionId, 14)}` : null;
  const detail = node.error
    ? error(`err=${truncateEnd(node.error, 28)}`)
    : outputSummary
      ? `summary=${truncateEnd(outputSummary, 28)}`
      : node.lastEventSummary
        ? `event=${truncateEnd(node.lastEventSummary, 28)}`
        : null;
  return [
    `${bold(node.id)} ${colorToolStatus(node.status)}`,
    `${muted("age")}=${formatNodeAge(node, nowMs)}`,
    `${muted("turn")}=${node.turnCount}`,
    `${muted("files")}=${truncateEnd(formatNodeFiles(node.files), 32)}`,
    `${muted("tok")}=${node.tokenTotal ?? "-"}`,
    process,
    detail,
  ].filter((segment): segment is string => segment !== null);
}

function formatRetryState(entry: RetryEntry, exhausted: boolean): string {
  if (exhausted) return error("EXHAUSTED");
  if (entry.kind === "failure") return error("RETRY");
  if (entry.kind === "no_slots") return warn("CAPACITY");
  return info("CONTINUE");
}

function formatRetryStage(stage: RetryEntry["failureStage"]): string | null {
  if (stage === undefined) return null;
  return error(RETRY_STAGE_LABEL[stage]);
}

function formatRetryReason(entry: RetryEntry): string {
  const reason = compactText(entry.error);
  if (reason !== null) return reason;
  if (entry.kind === "no_slots") return "waiting for agent capacity";
  if (entry.kind === "continuation") return "waiting to resume prior run";
  return "no failure reason recorded";
}

function formatRetryTimingSegments(dueAtMs: number, nowMs: number): string[] {
  const deltaMs = dueAtMs - nowMs;
  const scheduled = `${muted("at")}=${bold(formatClockMs(dueAtMs))}`;
  if (deltaMs > 999) {
    return [`${muted("backoff")}=${bold(formatDuration(deltaMs))}`, scheduled];
  }
  if (deltaMs >= 0) {
    return [warn("READY NOW"), scheduled];
  }
  return [warn(`OVERDUE ${formatDuration(Math.abs(deltaMs))}`), scheduled];
}

function pushRetryEntry(lines: string[], width: number, entry: RetryEntry, nowMs: number, exhausted: boolean): void {
  pushWrappedSegments(lines, width, [
    bold(entry.identifier),
    formatRetryState(entry, exhausted),
    exhausted ? error("TERMINAL") : null,
    formatRetryStage(entry.failureStage),
    `${muted(exhausted ? "attempts" : "attempt")}=${entry.attempt}`,
    ...formatRetryTimingSegments(entry.dueAtMs, nowMs),
  ]);
  pushWrappedSegments(lines, width, [`${muted("reason")}=${truncateEnd(formatRetryReason(entry), 56)}`]);
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
  return `${muted(">")} ${muted(ts)}  ${bold(type)}  ${tool} ${status}${oneLine ? `  ${muted(oneLine)}` : ""}`;
}

function chooseEventFeedLines(width: number): number {
  if (width < 60) return 2;
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
    { key: "id", title: "Job", min: 8, ideal: 10, dropPriority: 0, align: "left" },
    { key: "stage", title: "State", min: 7, ideal: 11, dropPriority: 2, align: "left" },
    { key: "ageTurn", title: "Age/T", min: 6, ideal: 7, dropPriority: 3, align: "left" },
    { key: "tokens", title: "Tok", min: 3, ideal: 6, dropPriority: 4, align: "right" },
    { key: "session", title: "Sess", min: 8, ideal: 12, dropPriority: 5, align: "left" },
    { key: "pid", title: "PID", min: 3, ideal: 5, dropPriority: 6, align: "right" },
    { key: "event", title: "Now", min: 14, ideal: 44, dropPriority: 1, align: "left" },
  ];

  const minWithSpaces = (cols: TableCol[]) => cols.reduce((sum, c) => sum + c.min, 0) + Math.max(0, cols.length - 1);

  let cols = all.slice();
  while (cols.length > 2 && minWithSpaces(cols) > total) {
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
  const shrinkOrder = ["session", "pid", "stage", "tokens", "ageTurn", "id", "event"];
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

  // If still overflow (very narrow), keep shrinking columns until the row fits.
  if (overflow > 0) {
    while (overflow > 0) {
      let shrank = false;
      for (const key of shrinkOrder) {
        if (overflow <= 0) break;
        const c = widths.find((w) => w.key === key);
        if (!c || c.width <= 1) continue;
        c.width -= 1;
        overflow -= 1;
        shrank = true;
      }
      if (!shrank) break;
    }
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
    const v = c.key === "session" ? truncateMiddle(raw, c.width) : truncateEndAnsi(raw, c.width);
    if (c.align === "right") parts.push(padStartAnsi(v, c.width));
    else parts.push(padEndAnsi(v, c.width));
  }
  return parts.join(" ");
}

function formatGraphNodeFocusLine(node: { output?: Record<string, unknown> }): string | null {
  const focus = compactText(node.output?.focus);
  if (focus === null) return null;
  return `${muted("focus")}=${focus}`;
}

function formatGraphRunEventSummary(summary: string | undefined): string | null {
  const compact = compactText(summary);
  if (compact === null || compact === "graph_node_result") return null;
  return compact;
}

function formatPlannerNodePreview(ids: string[]): string | null {
  if (ids.length === 0) return null;
  return `${muted("nodes")}=${truncateEnd(formatCompactList(ids), 44)}`;
}

function chooseRecentResultLimit(width: number): number {
  if (width < 70) return 1;
  if (width < 110) return 2;
  return 3;
}

function formatRecentPlannerResult(entry: OrchestratorRuntimeState["plannerHistory"][number]): string {
  return joinParts([
    bold(entry.identifier),
    colorToolStatus(entry.status),
    `${muted("plan")}=${entry.plannedNodeCount ?? 0}`,
    entry.error ? error(`err=${truncateEnd(entry.error, 18)}`) : null,
  ]);
}

function formatRecentGraphResult(entry: OrchestratorRuntimeState["graphHistory"][number]): string {
  return joinParts([
    bold(entry.identifier),
    `${muted("src")}=${accent(entry.source)}`,
    colorToolStatus(entry.status),
    `${muted("done")}=${entry.completedNodeCount}/${entry.nodeCount}`,
    entry.failedNodeId ? error(`fail=${entry.failedNodeId}`) : null,
  ]);
}

function formatRecentResultSegments(opts: {
  label: string;
  entries: string[];
  emptyText: string;
  width: number;
}): string[] {
  if (opts.entries.length === 0) {
    return [`${muted(opts.label)}: ${muted(opts.emptyText)}`];
  }

  const limit = chooseRecentResultLimit(opts.width);
  const shown = opts.entries.slice(0, limit);
  const first = shown.shift();
  return [
    `${muted(opts.label)}: ${first ?? muted(opts.emptyText)}`,
    ...shown,
    opts.entries.length > limit ? muted(`+${opts.entries.length - limit} more`) : null,
  ].filter((segment): segment is string => segment !== null);
}

function formatRunningMetaLine(r: RunningEntry, visibleColumns: Set<string>): string | null {
  const meta = joinParts([
    r.lastSessionId && !visibleColumns.has("session") ? `${muted("ses")}=${truncateMiddle(r.lastSessionId, 18)}` : null,
    r.pid !== undefined && !visibleColumns.has("pid") ? `${muted("pid")}=${formatPid(r.pid)}` : null,
  ]);
  return meta === "" ? null : meta;
}

function orderGraphNodes(graphRun: {
  graph: { nodes: Array<{ id: string }> };
  nodes: Map<
    string,
    {
      id: string;
      status: string;
      files: string[];
      turnCount: number;
      startedAtMs?: number;
      endedAtMs?: number;
      pid?: number;
      lastSessionId?: string;
      tokenTotal?: number;
      output?: Record<string, unknown>;
      lastEventSummary?: string;
      error?: string;
    }
  >;
  activeNodeIds: Set<string>;
  failedNodeId?: string;
}): Array<{
  id: string;
  status: string;
  files: string[];
  turnCount: number;
  startedAtMs?: number;
  endedAtMs?: number;
  pid?: number;
  lastSessionId?: string;
  tokenTotal?: number;
  output?: Record<string, unknown>;
  lastEventSummary?: string;
  error?: string;
}> {
  return graphRun.graph.nodes
    .map((node) => graphRun.nodes.get(node.id))
    .filter((node) => node !== undefined);
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
  const planning = Array.from(opts.state.plannerRuns.values()).sort(compareIdentifier);
  const graphRunning = Array.from(opts.state.graphRuns.values()).sort(compareIdentifier);
  const retrying = Array.from(opts.state.retryQueue.values()).sort(compareRetry);
  const exhaustedRetries = Array.from(opts.state.exhaustedRetries.values()).sort(compareRetry);
  const metrics = summarizeVisualGraphMetrics(opts.state);

  const lines: string[] = [];

  lines.push(boxRule(width));
  lines.push(boxLine(width, centerAnsi(sectionTitle("SYMPHONY STATUS"), Math.max(0, width - 4))));
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

  pushWrappedSegments(lines, width, [
    `${muted("Agents")}: ${bold(`${running.length + planning.length + graphRunning.length}/${maxAgentsText}`)}`,
    `${muted("Graphs")}: ${bold(String(graphRunning.length))}`,
    `${muted("Planner")}: ${bold(String(planning.length))}`,
    `${muted("Claimed")}: ${String(opts.state.claimed.size)}`,
    `${muted("Runtime")}: ${bold(runtime)}`,
    `${muted("Refresh")}: ${bold(refreshIn)} ${muted(`(${cadence})`)}`,
  ]);
  pushWrappedSegments(lines, width, [
    `${muted("Tokens")}: ${muted("in")} ${bold(tokenIn)} ${muted("out")} ${bold(tokenOut)} ${muted("total")} ${bold(tokenTotal)}`,
    `${muted("Rate limits")}: ${formatRateLimits(opts.state.codexRateLimits)}`,
  ]);
  pushWrappedSegments(lines, width, [
    `${muted("Project")}: ${bold(project)}`,
    `${muted("Workflow")}: ${truncateEnd(opts.workflowPath, 64)}`,
  ]);
  pushWrappedSegments(lines, width, [
    `${muted("Recent graphs")}: ${bold(`${metrics.graphSucceeded}/${metrics.graphRuns}`)}`,
    `${muted("Recent planner")}: ${bold(`${metrics.plannerSucceeded}/${metrics.plannerRuns}`)}`,
    `${muted("Avg graph")}: ${bold(metrics.averageGraphDurationMs === null ? "n/a" : formatDuration(metrics.averageGraphDurationMs))}`,
    `${muted("Avg nodes")}: ${bold(metrics.averageCompletedNodes === null ? "n/a" : String(metrics.averageCompletedNodes))}`,
  ]);

  lines.push(boxRule(width));
  lines.push(boxLine(width, sectionTitle(`RUNNING AGENTS (${running.length})`)));

  const tableInner = boxContentWidth(width);
  const cols = allocateWidths(tableInner, chooseColumns(tableInner));
  const visibleColumns = new Set(cols.map((col) => col.key));

  lines.push(boxLine(width, renderRow(cols, Object.fromEntries(cols.map((c) => [c.key, c.title])))));
  lines.push(boxLine(width, "".padEnd(Math.min(tableInner, cols.reduce((s, c) => s + c.width, 0) + Math.max(0, cols.length - 1)), "-")));

  if (running.length === 0) {
    lines.push(boxLine(width, muted("No running agents")));
  } else {
    const maxRows = 12;
    const maxFeed = chooseEventFeedLines(width);
    for (const [index, r] of running.slice(0, maxRows).entries()) {
      const elapsed = formatDuration(nowMs - r.startedAtMs);
      const ageTurn = `${elapsed} t${r.turnCount}`;
      const tokens = r.tokenTotal !== undefined ? String(r.tokenTotal) : "n/a";
      const session = r.lastSessionId ?? "-";
      const event = r.lastEventSummary ?? "-";
      const stage = colorStage(r.issue.state);

      const ses = r.opencodeSession ?? null;
      const tail = ses?.tail?.length ? ses.tail.slice(Math.max(0, ses.tail.length - maxFeed)) : [];
      const feedLines = tail.map(formatOpencodeTailLine);

      const eventLines = feedLines.length > 0 ? [event, ...feedLines] : [event];

      const firstRow = renderRow(cols, {
        id: `${spinner(opts.frame + index)} ${r.issue.identifier}`,
        stage,
        pid: formatPid(r.pid),
        ageTurn,
        tokens,
        session,
        event: eventLines[0] ?? "-",
      });
      lines.push(boxLine(width, firstRow));

      const meta = formatRunningMetaLine(r, visibleColumns);
      if (meta !== null) {
        const metaRow = renderRow(cols, {
          event: meta,
        });
        lines.push(boxLine(width, metaRow));
      }

      for (const line of eventLines.slice(1)) {
        const cont = renderRow(cols, {
          event: line,
        });
        lines.push(boxLine(width, cont));
      }
    }
    if (running.length > maxRows) {
      lines.push(boxLine(width, muted(`(+${running.length - maxRows} more)`)));
    }
  }

  lines.push(boxRule(width));
  lines.push(boxLine(width, sectionTitle(`PLANNER RUNS (${planning.length})`)));
  if (planning.length === 0) {
    lines.push(boxLine(width, muted("No active planner runs")));
  } else {
    for (const [index, plannerRun] of planning.slice(0, 6).entries()) {
      const plannedNodes = plannerRun.plannedGraph?.nodes.map((node) => node.id) ?? [];
      pushWrappedSegments(lines, width, [
        `${info(spinner(opts.frame + index))} ${bold(plannerRun.issue.identifier)}`,
        colorToolStatus(plannerRun.status),
        `${muted("age")}=${formatDuration(nowMs - plannerRun.startedAtMs)}`,
        `${muted("turn")}=${plannerRun.turnCount}`,
        `${muted("plan")}=${plannerRun.plannedGraph?.nodes.length ?? "-"}`,
        plannerRun.tokenTotal !== undefined ? `${muted("tok")}=${plannerRun.tokenTotal}` : null,
      ]);
      pushWrappedSegments(lines, width, [
        formatPlannerNodePreview(plannedNodes),
        plannerRun.lastSessionId ? `${muted("ses")}=${truncateMiddle(plannerRun.lastSessionId, 18)}` : null,
        plannerRun.error
          ? error(`err=${truncateEnd(plannerRun.error, 36)}`)
          : `${muted("event")}=${truncateEnd(plannerRun.lastEventSummary ?? "-", 36)}`,
      ]);
    }
  }

  lines.push(boxRule(width));
  lines.push(boxLine(width, sectionTitle(`GRAPH RUNS (${graphRunning.length})`)));
  if (graphRunning.length === 0) {
    lines.push(boxLine(width, muted("No active graph runs")));
  } else {
    for (const [index, graphRun] of graphRunning.slice(0, 6).entries()) {
      const eventSummary = formatGraphRunEventSummary(graphRun.lastEventSummary);
      const activeNodes = Array.from(graphRun.activeNodeIds.values());
      pushWrappedSegments(lines, width, [
        `${info(spinner(opts.frame + index))} ${bold(graphRun.issue.identifier)}`,
        `${muted("src")}=${graphRun.source}`,
        colorToolStatus(graphRun.status),
        `${muted("age")}=${formatDuration(nowMs - graphRun.startedAtMs)}`,
        `${muted("done")}=${graphRun.completedNodeIds.size}/${graphRun.graph.nodes.length}`,
        `${muted("active")}=${formatCompactList(activeNodes)}`,
      ]);
      pushWrappedSegments(lines, width, [
        eventSummary === null ? null : `${muted("event")}=${truncateEnd(eventSummary, 28)}`,
        graphRun.failedNodeId ? error(`FAILED ${graphRun.failedNodeId}`) : `${muted("failed")}=-`,
      ]);
      const nodes = orderGraphNodes(graphRun);
      for (const node of nodes.slice(0, 6)) {
        pushWrappedSegments(lines, width, formatGraphNodeSegments(node, nowMs));
        const focusLine = formatGraphNodeFocusLine(node);
        if (focusLine !== null) lines.push(boxLine(width, focusLine));
      }
      if (nodes.length > 6) {
        lines.push(boxLine(width, muted(`(+${nodes.length - 6} more nodes)`)));
      }
    }
  }

  lines.push(boxRule(width));
  lines.push(boxLine(width, sectionTitle("BACKOFF QUEUE")));
  if (retrying.length === 0 && exhaustedRetries.length === 0) {
    lines.push(boxLine(width, muted("No queued or exhausted retries")));
  } else {
    if (retrying.length > 0) {
      lines.push(boxLine(width, muted(`Queued (${retrying.length})`)));
      const maxRows = 8;
      for (const r of retrying.slice(0, maxRows)) {
        pushRetryEntry(lines, width, r, nowMs, false);
      }
      if (retrying.length > maxRows) {
        lines.push(boxLine(width, muted(`(+${retrying.length - maxRows} more queued)`)));
      }
    }
    if (exhaustedRetries.length > 0) {
      lines.push(boxLine(width, error(`Exhausted (${exhaustedRetries.length})`)));
      const maxRows = 6;
      for (const r of exhaustedRetries.slice(0, maxRows)) {
        pushRetryEntry(lines, width, r, nowMs, true);
      }
      if (exhaustedRetries.length > maxRows) {
        lines.push(boxLine(width, muted(`(+${exhaustedRetries.length - maxRows} more exhausted)`)));
      }
    }
  }

  lines.push(boxRule(width));
  lines.push(boxLine(width, sectionTitle("RECENT RESULTS")));
  const recentPlanner = opts.state.plannerHistory
    .slice()
    .sort((a, b) => b.endedAtMs - a.endedAtMs)
    .map(formatRecentPlannerResult);
  const recentGraphs = opts.state.graphHistory
    .slice()
    .sort((a, b) => b.endedAtMs - a.endedAtMs)
    .map(formatRecentGraphResult);
  if (recentPlanner.length === 0 && recentGraphs.length === 0) {
    lines.push(boxLine(width, muted("No completed planner or graph runs yet")));
  } else {
    pushWrappedSegments(
      lines,
      width,
      formatRecentResultSegments({
        label: "Planner",
        entries: recentPlanner,
        emptyText: "none",
        width,
      }),
      muted(" | "),
    );
    pushWrappedSegments(
      lines,
      width,
      formatRecentResultSegments({
        label: "Graph",
        entries: recentGraphs,
        emptyText: "none",
        width,
      }),
      muted(" | "),
    );
  }

  lines.push(boxRule(width));
  lines.push(boxLine(width, muted("Press Ctrl+C to stop.")));
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
