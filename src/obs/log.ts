import { createWriteStream, fchmodSync, type WriteStream } from "node:fs";
import path from "node:path";

export type LogLevel = "info" | "warn" | "error";

export type StableLogFields = {
  issue_id: string | null;
  issue_identifier: string | null;
  session_id: string | null;
};

export type SerializedError = {
  code?: string;
  message: string;
};

export type LogEntry = StableLogFields & {
  ts: string;
  level: LogLevel;
  event: string;
  message?: string;
  error?: SerializedError;
  [k: string]: unknown;
};

export type LogSink = {
  write: (entry: LogEntry) => void;
  close?: () => void;
};

function isoNow(): string {
  return new Date().toISOString();
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const anyErr = err as Error & { code?: unknown };
    const code = typeof anyErr.code === "string" ? anyErr.code : undefined;
    return { ...(code ? { code } : {}), message: err.message };
  }
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    return { message: typeof msg === "string" ? msg : "error" };
  }
  return { message: typeof err === "string" ? err : "error" };
}

export function createJsonlFileSink(filePath: string): LogSink {
  const abs = path.resolve(filePath);
  const stream: WriteStream = createWriteStream(abs, { flags: "a", mode: 0o600 });
  stream.on("open", (fd) => {
    try {
      fchmodSync(fd, 0o600);
    } catch {
      // ignore
    }
  });

  return {
    write: (entry) => {
      stream.write(`${JSON.stringify(entry)}\n`);
    },
    close: () => {
      stream.end();
    },
  };
}

export type StructuredLogger = {
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
  error: (event: string, fields?: Record<string, unknown>) => void;
  child: (fields: Partial<StableLogFields>) => StructuredLogger;
};

export function createLogger(sink: LogSink, base: Partial<StableLogFields> = {}): StructuredLogger {
  const stable: StableLogFields = {
    issue_id: base.issue_id ?? null,
    issue_identifier: base.issue_identifier ?? null,
    session_id: base.session_id ?? null,
  };

  const write = (level: LogLevel, event: string, fields: Record<string, unknown> = {}) => {
    const entry: LogEntry = {
      ts: isoNow(),
      level,
      event,
      ...stable,
    };

    for (const [k, v] of Object.entries(fields)) {
      if (k === "error") entry.error = serializeError(v);
      else (entry as Record<string, unknown>)[k] = v;
    }

    sink.write(entry);
  };

  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (fields) =>
      createLogger(sink, {
        issue_id: fields.issue_id ?? stable.issue_id,
        issue_identifier: fields.issue_identifier ?? stable.issue_identifier,
        session_id: fields.session_id ?? stable.session_id,
      }),
  };
}

export function makeLegacyLogger(logger: StructuredLogger): {
  info: (m: string) => void;
  warn: (m: string) => void;
} {
  return {
    info: (m) => logger.info("log", { message: m }),
    warn: (m) => logger.warn("log", { message: m }),
  };
}
