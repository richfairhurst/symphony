import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { OpencodeSessionIntrospector, redactObviousSecrets, resolveOpencodeDbPath } from "./sessionIntrospection";

describe("opencode session introspection", () => {
  test("resolveOpencodeDbPath expands tilde", () => {
    const p = resolveOpencodeDbPath({ OPENCODE_DB_PATH: "~/x.db" } as any);
    expect(p.includes("x.db")).toBe(true);
    expect(p.startsWith(os.homedir())).toBe(true);
  });

  test("redactObviousSecrets redacts common tokens", () => {
    const s = "Authorization: Bearer abcdef\nsk-123456789012345678901234567890\npassword=lol";
    const out = redactObviousSecrets(s);
    expect(out).not.toContain("sk-123456");
    expect(out).toContain("[REDACTED_OPENAI_KEY]");
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).toContain("password=[REDACTED]");
  });

  test("selects most recent session and extracts tail", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "opencode-db-test-"));
    const dbPath = path.join(dir, "opencode.db");

    const db = new Database(dbPath);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_updated INTEGER NOT NULL);");
    db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);");

    db.exec("INSERT INTO session(id, directory, time_updated) VALUES ('ses_old', '/tmp/ws', 1000);");
    db.exec("INSERT INTO session(id, directory, time_updated) VALUES ('ses_new', '/tmp/ws', 2000);");

    const ins = db.query("INSERT INTO part(id, session_id, time_updated, data) VALUES (?,?,?,?)");
    ins.run("p1", "ses_new", 1500, JSON.stringify({ type: "reasoning", text: "sk-123456789012345678901234567890" }));
    ins.run(
      "p2",
      "ses_new",
      1600,
      JSON.stringify({ type: "tool", tool: "apply_patch", state: { status: "pending" } }),
    );
    db.close();

    const intro = new OpencodeSessionIntrospector({ env: { OPENCODE_DB_PATH: dbPath } as any });
    const view = intro.getSessionView({ workspacePath: "/tmp/ws", nowMs: 1601, tailLimit: 10 });
    expect(view).not.toBe(null);
    expect(view!.id).toBe("ses_new");
    expect(view!.summary).toBe("apply_patch pending");
    expect(view!.tail.length).toBe(2);
    expect(view!.tail[0]!.type).toBe("reasoning");
    expect(view!.tail[0]!.text).toContain("[REDACTED_OPENAI_KEY]");
    expect(view!.tail[1]!.tool).toBe("apply_patch");
    expect(view!.tail[1]!.status).toBe("pending");
  });

  test("missing db yields null", () => {
    const intro = new OpencodeSessionIntrospector({ env: { OPENCODE_DB_PATH: "/nope/does-not-exist.db" } as any });
    expect(intro.getSessionView({ workspacePath: "/tmp/ws", nowMs: Date.now() })).toBe(null);
  });
});
