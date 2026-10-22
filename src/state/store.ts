import path from "node:path";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import {
  getIssueStateDir,
  getIssueStateFilePath,
  getWorkstreamStateFilePath,
} from "./paths";
import type { TicketLifecycleState } from "./index";

const MAX_PERSISTED_JSON_BYTES = 10 * 1024 * 1024;

export class FilesystemStateStore {
  private readonly root: string;

  constructor(opts: { root: string }) {
    this.root = opts.root;
  }

  getRootDir(): string {
    return path.resolve(this.root);
  }

  async listIssueKeys(): Promise<string[]> {
    const root = this.getRootDir();
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if (err && typeof err === "object" && "code" in err) {
        const code = (err as { code?: unknown }).code;
        if (code === "ENOENT") return [];
      }
      throw err;
    }
  }

  getIssueDir(issueKey: string): string {
    return getIssueStateDir(this.root, issueKey).issueDir;
  }

  async readJson<T>(issueKey: string, name: string): Promise<T | undefined> {
    const filePath = getIssueStateFilePath(this.root, issueKey, name);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch (err) {
      if (err && typeof err === "object" && "code" in err) {
        const code = (err as { code?: unknown }).code;
        if (code === "ENOENT") return undefined;
      }
      throw err;
    }
  }

  async quarantineJson(
    issueKey: string,
    name: string,
  ): Promise<string | undefined> {
    const { issueDir } = getIssueStateDir(this.root, issueKey);
    const source = getIssueStateFilePath(this.root, issueKey, name);
    const target = path.join(issueDir, `.${name}.corrupt.${Date.now()}`);
    try {
      await fs.rename(source, target);
      return target;
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "ENOENT")
        return undefined;
      throw err;
    }
  }

  async writeJsonAtomic(
    issueKey: string,
    name: string,
    value: unknown,
  ): Promise<void> {
    const { issueDir } = getIssueStateDir(this.root, issueKey);
    await fs.mkdir(issueDir, { recursive: true, mode: 0o700 });
    // Best-effort: tighten perms even when dir already existed.
    await fs.chmod(issueDir, 0o700).catch(() => undefined);

    const targetPath = getIssueStateFilePath(this.root, issueKey, name);
    const tmpPath = path.join(
      issueDir,
      `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`,
    );

    const payload = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_PERSISTED_JSON_BYTES) {
      throw new Error(
        `persisted state exceeds ${MAX_PERSISTED_JSON_BYTES} bytes: ${name}`,
      );
    }
    await fs.writeFile(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmpPath, targetPath);
  }

  async writeRootJsonAtomic(name: string, value: unknown): Promise<void> {
    const root = this.getRootDir();
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    // Best-effort: tighten perms even when dir already existed.
    await fs.chmod(root, 0o700).catch(() => undefined);

    const base = `${name}`.replace(/[^A-Za-z0-9._-]/g, "_");
    const targetPath = path.join(root, `${base}.json`);
    const tmpPath = path.join(root, `.${base}.${crypto.randomUUID()}.tmp`);

    const payload = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_PERSISTED_JSON_BYTES) {
      throw new Error(
        `persisted state exceeds ${MAX_PERSISTED_JSON_BYTES} bytes: ${name}`,
      );
    }
    await fs.writeFile(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmpPath, targetPath);
  }

  async readRootJson<T>(name: string): Promise<T | undefined> {
    try {
      return JSON.parse(
        await fs.readFile(getWorkstreamStateFilePath(this.root, name), "utf8"),
      ) as T;
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "ENOENT")
        return undefined;
      throw err;
    }
  }

  async writeLifecycle(value: TicketLifecycleState): Promise<void> {
    await this.writeJsonAtomic(value.issueId, "lifecycle", value);
  }

  async readLifecycle(
    issueId: string,
  ): Promise<TicketLifecycleState | undefined> {
    return await this.readJson<TicketLifecycleState>(issueId, "lifecycle");
  }

  async listLifecycles(): Promise<TicketLifecycleState[]> {
    const records: TicketLifecycleState[] = [];
    for (const key of await this.listIssueKeys()) {
      const record = await this.readLifecycle(key);
      if (record !== undefined) records.push(record);
    }
    return records;
  }
}
