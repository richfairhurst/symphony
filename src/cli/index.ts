import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { watchWorkflow } from "../config/watch";
import { Orchestrator } from "../core/orchestrator";
import { LinearClient } from "../linear/client";
import { OpencodeCliRunner } from "../runner/opencodeCli";
import { FilesystemStateStore } from "../state/store";
import { WorkspaceManager } from "../workspace/manager";
import type { WorkspaceHooks } from "../workspace/manager";
import { startApiServer } from "../api/server";
import { createJsonlFileSink, createLogger, makeLegacyLogger, type LogSink, type StructuredLogger } from "../obs/log";
import { HybridRunner, HybridWorkspaceManager, SshOpencodeRunner, SshWorkspaceManager } from "../worker/ssh";
import { createMemoryLogSink, createTeeSink, VisualCli } from "./visual";
import { createDemoLinearClient, createDemoRunner, isDemoTracker } from "./demo";

export type CliIo = {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  isTTY?: boolean;
  columns?: number;
};

export function selectCliMode(opts: {
  forceJson: boolean;
  forceVisual: boolean;
  isTty: boolean;
}): "json" | "visual" {
  if (opts.forceJson) return "json";
  if (opts.forceVisual) return "visual";
  return opts.isTty ? "visual" : "json";
}

function isFlag(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

function parsePort(raw: string): number | null {
  if (!/^-?\d+$/.test(raw.trim())) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 65535) return null;
  return n;
}

function makeStdoutJsonLogger(io: CliIo): StructuredLogger {
  const stdout = io.stdout ?? ((chunk) => process.stdout.write(chunk));
  const sink: LogSink = {
    write: (entry) => {
      stdout(`${JSON.stringify(entry)}\n`);
    },
  };
  return createLogger(sink);
}

export function getHelpText(): string {
  return [
    "Symphony Orchestrator (opencode)\n",
    "\n",
    "Usage:\n",
    "  orchestrator [start] [path-to-WORKFLOW.md] [--port <n>]\n",
    "\n",
    "Options:\n",
    "  --help, -h     Show help\n",
    "  --visual        Render a visual terminal UI (default when stdout is a TTY)\n",
    "  --json          Emit JSONL structured logs (default when stdout is not a TTY)\n",
    "  --port <n>      Start HTTP server on port n (0 = ephemeral); overrides workflow server.port\n",
    "\n",
    "Notes:\n",
    "  If no workflow path is provided, ./WORKFLOW.md is used.\n",
  ].join("");
}

export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const stdout = io.stdout ?? ((chunk) => process.stdout.write(chunk));
  const stderr = io.stderr ?? ((chunk) => process.stderr.write(chunk));
  const isTty = io.isTTY ?? process.stdout.isTTY;
  const columns = io.columns ?? process.stdout.columns ?? 100;

  if (argv.includes("--help") || argv.includes("-h")) {
    stdout(getHelpText());
    return 0;
  }

  const positionals: string[] = [];
  let portOverride: number | undefined;
  let forceJson = false;
  let forceVisual = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!isFlag(tok)) {
      positionals.push(tok);
      continue;
    }

    if (tok === "--port") {
      const next = argv[i + 1];
      if (next === undefined) {
        stderr("Missing value for --port\n\n");
        stderr(getHelpText());
        return 1;
      }
      const parsed = parsePort(next);
      if (parsed === null) {
        stderr(`Invalid --port: ${next}\n\n`);
        stderr(getHelpText());
        return 1;
      }
      portOverride = parsed;
      i++;
      continue;
    }

    if (tok === "--json") {
      forceJson = true;
      continue;
    }

    if (tok === "--visual") {
      forceVisual = true;
      continue;
    }

    if (tok.startsWith("--port=")) {
      const raw = tok.slice("--port=".length);
      const parsed = parsePort(raw);
      if (parsed === null) {
        stderr(`Invalid --port: ${raw}\n\n`);
        stderr(getHelpText());
        return 1;
      }
      portOverride = parsed;
      continue;
    }

    stderr(`Unknown option: ${tok}\n\n`);
    stderr(getHelpText());
    return 1;
  }

  const cmd = positionals[0] === "start" ? "start" : "start";
  const workflowArg = positionals[0] === "start" ? positionals[1] : positionals[0];
  if (positionals[0] === "start" && positionals.length > 2) {
    stderr(`Unexpected arguments: ${positionals.slice(2).join(" ")}\n\n`);
    stderr(getHelpText());
    return 1;
  }
  if (positionals[0] !== "start" && positionals.length > 1) {
    stderr(`Unexpected arguments: ${positionals.slice(1).join(" ")}\n\n`);
    stderr(getHelpText());
    return 1;
  }
  void cmd;

  const workflowPath = workflowArg ?? path.resolve("./WORKFLOW.md");
  if (!existsSync(workflowPath)) {
    stderr(`Workflow not found: ${workflowPath}\n\n`);
    stderr(getHelpText());
    return 1;
  }

  if (forceJson && forceVisual) {
    stderr("Cannot use --json and --visual together\n\n");
    stderr(getHelpText());
    return 1;
  }

  const stateRoot = path.join(path.dirname(path.resolve(workflowPath)), ".symphony_state");

  const mode = selectCliMode({ forceJson, forceVisual, isTty });

  const memLogs = mode === "visual" ? createMemoryLogSink({ limit: 200 }) : null;
  if (mode === "visual") {
    try {
      await fs.mkdir(stateRoot, { recursive: true });
    } catch {
      // ignore
    }
  }

  const logger: StructuredLogger = (() => {
    if (mode === "json") return makeStdoutJsonLogger(io);

    const sinks: LogSink[] = [];
    if (memLogs) sinks.push(memLogs.sink);
    try {
      sinks.push(createJsonlFileSink(path.join(stateRoot, "cli.jsonl")));
    } catch {
      // ignore file sink errors; visual mode still works
    }
    return createLogger(createTeeSink(sinks));
  })();

  let visual: VisualCli | null = null;

  logger.info("cli_start", { workflow_path: workflowPath, port_override: portOverride ?? null, mode });

  const watcher = watchWorkflow(workflowPath, { env: process.env });
  const snap = watcher.getSnapshot();
  const cfg = snap.resolved.config;

  const legacyLogger = makeLegacyLogger(logger);
  const stateStore = new FilesystemStateStore({ root: stateRoot });
  const hooks: WorkspaceHooks = {
    timeoutMs: cfg.hooks.timeoutMs,
    ...(cfg.hooks.afterCreate !== undefined ? { afterCreate: cfg.hooks.afterCreate } : {}),
    ...(cfg.hooks.beforeRun !== undefined ? { beforeRun: cfg.hooks.beforeRun } : {}),
    ...(cfg.hooks.afterRun !== undefined ? { afterRun: cfg.hooks.afterRun } : {}),
    ...(cfg.hooks.beforeRemove !== undefined ? { beforeRemove: cfg.hooks.beforeRemove } : {}),
  };
  const workspaceManager = new WorkspaceManager({
    workspaceRoot: cfg.workspace.root,
    hooks,
    logger: legacyLogger,
  });

  const useDemo = isDemoTracker(cfg.tracker.kind);
  const linearClient = useDemo
    ? createDemoLinearClient()
    : new LinearClient({ endpoint: cfg.tracker.endpoint, apiKey: cfg.tracker.apiKey ?? "" });

  const localRunner = useDemo ? createDemoRunner() : new OpencodeCliRunner({ env: process.env });
  const sshHosts = cfg.worker.sshHosts;
  const runner =
    sshHosts !== undefined && sshHosts.length > 0
      ? new HybridRunner(localRunner, new SshOpencodeRunner({ env: process.env }))
      : localRunner;

  const effectiveWorkspaceManager =
    sshHosts !== undefined && sshHosts.length > 0
      ? new HybridWorkspaceManager(
          workspaceManager,
          new SshWorkspaceManager({ workspaceRoot: cfg.workspace.root, hooks, logger: legacyLogger }),
        )
      : workspaceManager;

  const orch = new Orchestrator({
    workflowWatcher: watcher,
    linearClient,
    workspaceManager: effectiveWorkspaceManager,
    runner,
    stateStore,
    logger: legacyLogger,
  });

  let api: { stop: () => void; port: number } | null = null;

  try {
    await orch.start();
    if (mode === "visual" && memLogs) {
      visual = new VisualCli({
        stdout,
        state: () => orch.getRuntimeState(),
        logs: memLogs.get,
        width: () => columns,
        workflowPath,
      });
      visual.start();
    }
  } catch (err) {
    logger.error("cli_start_failed", { error: err });
    watcher.close();
    return 1;
  }

  const effectivePort = portOverride ?? cfg.server.port;
  if (effectivePort !== undefined) {
    api = startApiServer({
      orchestrator: orch,
      stateStore,
      workspaceManager: effectiveWorkspaceManager,
      port: effectivePort,
      logger,
    });
  }

  const shutdown = new Promise<void>((resolve) => {
    const onSignal = (sig: string) => {
      logger.info("cli_shutdown_signal", { signal: sig });
      resolve();
    };
    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));
  });

  await shutdown;

  try {
    if (api) api.stop();
    await orch.stop();
    if (visual) visual.stop();
  } catch (err) {
    if (visual) visual.stop();
    logger.error("cli_shutdown_failed", { error: err });
    watcher.close();
    return 1;
  }

  watcher.close();
  logger.info("cli_stopped", { api_port: api?.port ?? null });
  return 0;
}
