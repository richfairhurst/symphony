import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

type SqliteDatabase = {
  close: () => void;
  query: (sql: string) => { get: (...params: any[]) => any; all: (...params: any[]) => any[] };
};

const DEFAULT_DB_PATH = "~/.local/share/opencode/opencode.db";

export type OpencodeSessionTailEntry = {
  ts: string;
  type: string | null;
  tool: string | null;
  status: string | null;
  text: string | null;
};

export type OpencodeSessionView = {
  id: string;
  updated_at: string;
  summary: string;
  tail: OpencodeSessionTailEntry[];
};

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolveOpencodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.OPENCODE_DB_PATH ?? "").trim();
  return expandTilde(raw !== "" ? raw : DEFAULT_DB_PATH);
}

function safeIsoFromEpoch(epoch: number): string {
  // opencode currently stores ms epoch.
  const ms = epoch > 1_000_000_000_000 ? epoch : epoch * 1000;
  return new Date(ms).toISOString();
}

function safeString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function safeNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function formatAgeShort(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r}s`;
  if (m < 60) return `${m}m${r}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h${mm}m`;
}

export function redactObviousSecrets(input: string): string {
  let s = input;

  const patterns: Array<{ re: RegExp; replace: string }>
    = [
      { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replace: "[REDACTED_PRIVATE_KEY]" },
      { re: /\b(sk-[A-Za-z0-9]{20,})\b/g, replace: "[REDACTED_OPENAI_KEY]" },
      { re: /\b(ghp_[A-Za-z0-9]{20,})\b/g, replace: "[REDACTED_GITHUB_TOKEN]" },
      { re: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, replace: "[REDACTED_SLACK_TOKEN]" },
      { re: /\b(AIza[0-9A-Za-z\-_]{20,})\b/g, replace: "[REDACTED_GOOGLE_KEY]" },
      { re: /\b(authorization)\s*:\s*bearer\s+[A-Za-z0-9\-_.=]+/gi, replace: "$1: Bearer [REDACTED]" },
      { re: /\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*[^\s]+/gi, replace: "$1=[REDACTED]" },
    ];

  for (const p of patterns) s = s.replace(p.re, p.replace);
  return s;
}

function makeSummary(opts: {
  nowMs: number;
  newestUpdatedAtMs: number | null;
  newestType: string | null;
  newestTool: string | null;
  newestStatus: string | null;
  newestText: string | null;
}): string {
  const t = opts.newestType?.trim() || null;
  const tool = opts.newestTool?.trim() || null;
  const status = opts.newestStatus?.trim() || null;
  const ageMs =
    opts.newestUpdatedAtMs !== null && Number.isFinite(opts.newestUpdatedAtMs)
      ? Math.max(0, opts.nowMs - opts.newestUpdatedAtMs)
      : null;

  const ageSuffix =
    ageMs !== null && (status === "pending" || status === "running") && ageMs >= 120_000
      ? ` for ${formatAgeShort(ageMs)}`
      : "";

  if (t === "tool" && tool) return `${tool} ${status ?? ""}`.trim() + ageSuffix;
  if (t === "reasoning") {
    const txt = (opts.newestText ?? "").trim();
    if (txt !== "") return `reasoning: ${truncateOneLine(txt, 80)}`;
    return "reasoning";
  }
  if (t === "step-start") return "step starting";
  if (t === "step-finish") return "step finished";
  if (t) return t;
  return "n/a";
}

function truncateOneLine(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  if (max <= 3) return one.slice(0, max);
  return one.slice(0, max - 3) + "...";
}

function bestEffortPathKey(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

export class OpencodeSessionIntrospector {
  private db: SqliteDatabase | null = null;
  private dbPath: string | null = null;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts?: { env?: NodeJS.ProcessEnv }) {
    this.env = opts?.env ?? process.env;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // ignore: close best-effort; DB may already be closed
    }
    this.db = null;
    this.dbPath = null;
  }

  getSessionView(opts: {
    workspacePath: string;
    nowMs: number;
    tailLimit?: number;
  }): OpencodeSessionView | null {
    const tailLimit = Math.max(1, Math.min(opts.tailLimit ?? 60, 200));
    const dbPath = resolveOpencodeDbPath(this.env);
    if (!fs.existsSync(dbPath)) return null;

    let db: SqliteDatabase;
    try {
      if (this.db === null || this.dbPath !== dbPath) {
        this.close();
        this.db = new (Database as unknown as new (p: string, opts?: any) => SqliteDatabase)(dbPath, { readonly: true });
        this.dbPath = dbPath;
      }
      db = this.db;
      if (db === null) return null;
    } catch {
      this.close();
      return null;
    }

    const targetKey = bestEffortPathKey(opts.workspacePath);
    const pickSession = (): { id: string; time_updated: number } | null => {
      try {
        const q = db.query(
          "SELECT id, time_updated FROM session WHERE directory = ? ORDER BY time_updated DESC LIMIT 1",
        );
        const row = q.get(opts.workspacePath);
        const id = safeString(row?.id);
        const updated = safeNumber(row?.time_updated);
        if (id && updated !== null) return { id, time_updated: updated };
      } catch {
        // ignore: sqlite query best-effort; fall back to broader scan
      }

      try {
        const q = db.query(
          "SELECT id, directory, time_updated FROM session ORDER BY time_updated DESC LIMIT 50",
        );
        const rows = q.all();
        for (const r of rows) {
          const id = safeString(r?.id);
          const dir = safeString(r?.directory);
          const updated = safeNumber(r?.time_updated);
          if (!id || !dir || updated === null) continue;
          if (bestEffortPathKey(dir) === targetKey) return { id, time_updated: updated };
        }
      } catch {
        // ignore: sqlite scan best-effort; return null when unavailable
      }

      return null;
    };

    const ses = pickSession();
    if (!ses) return null;

    let parts: Array<{
      time_updated: number;
      type: string | null;
      tool: string | null;
      status: string | null;
      text: string | null;
    }> = [];

    try {
      const q = db.query(
        "SELECT time_updated, json_extract(data,'$.type') as type, json_extract(data,'$.tool') as tool, json_extract(data,'$.state.status') as status, json_extract(data,'$.text') as text FROM part WHERE session_id = ? ORDER BY time_updated DESC LIMIT ?",
      );
      const rows = q.all(ses.id, tailLimit);
      parts = rows
        .map((r) => ({
          time_updated: safeNumber(r?.time_updated) ?? 0,
          type: safeString(r?.type),
          tool: safeString(r?.tool),
          status: safeString(r?.status),
          text: safeString(r?.text),
        }))
        .filter((r) => r.time_updated > 0);
    } catch {
      return null;
    }

    parts.reverse();
    const tail: OpencodeSessionTailEntry[] = parts.map((p) => {
      const txt = p.text ? redactObviousSecrets(p.text) : null;
      const prefix = txt ? truncateOneLine(txt, 140) : null;
      return {
        ts: safeIsoFromEpoch(p.time_updated),
        type: p.type,
        tool: p.tool,
        status: p.status,
        text: prefix,
      };
    });

    const newest = parts.length > 0 ? parts[parts.length - 1]! : null;
    const summary = makeSummary({
      nowMs: opts.nowMs,
      newestUpdatedAtMs: newest?.time_updated ?? null,
      newestType: newest?.type ?? null,
      newestTool: newest?.tool ?? null,
      newestStatus: newest?.status ?? null,
      newestText: newest?.text ? redactObviousSecrets(newest.text) : null,
    });

    return {
      id: ses.id,
      updated_at: safeIsoFromEpoch(ses.time_updated),
      summary,
      tail,
    };
  }
}
