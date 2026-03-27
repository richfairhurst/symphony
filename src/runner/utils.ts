export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let esc = false;

  const push = () => {
    if (cur !== "") out.push(cur);
    cur = "";
  };

  for (const ch of command) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (quote === null) {
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === " " || ch === "\t" || ch === "\n") {
        push();
        continue;
      }
      cur += ch;
      continue;
    }

    if (ch === quote) {
      quote = null;
      continue;
    }
    cur += ch;
  }

  if (esc || quote !== null) {
    throw new Error("Invalid command: unclosed escape/quote");
  }
  push();
  return out;
}

export function extractSessionId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const anyObj = value as Record<string, unknown>;

  const candidates = [
    anyObj.session_id,
    anyObj.sessionId,
    anyObj.sessionID,
    anyObj.run_id,
    anyObj.runId,
    anyObj.id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c;
  }

  const session = anyObj.session;
  if (session && typeof session === "object") {
    const s = session as Record<string, unknown>;
    const nested = [s.id, s.session_id, s.sessionId, s.sessionID];
    for (const c of nested) {
      if (typeof c === "string" && c.trim() !== "") return c;
    }
  }

  const part = anyObj.part;
  if (part && typeof part === "object") {
    const p = part as Record<string, unknown>;
    const nested = [p.session_id, p.sessionId, p.sessionID];
    for (const c of nested) {
      if (typeof c === "string" && c.trim() !== "") return c;
    }
  }

  return undefined;
}
