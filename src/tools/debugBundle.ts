import { existsSync } from "node:fs";
import path from "node:path";
import { writeDebugBundle } from "../debug/bundle";

function isFlag(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

function helpText(): string {
  return [
    "Debug bundle\n",
    "\n",
    "Usage:\n",
    "  debug:bundle [path-to-WORKFLOW.md] [--out <path>]\n",
    "\n",
    "Notes:\n",
    "  If no workflow path is provided, ./WORKFLOW.md is used.\n",
  ].join("");
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(helpText());
    return 0;
  }

  const positionals: string[] = [];
  let outPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!isFlag(tok)) {
      positionals.push(tok);
      continue;
    }

    if (tok === "--out") {
      const next = argv[i + 1];
      if (!next) {
        process.stderr.write("Missing value for --out\n\n");
        process.stderr.write(helpText());
        return 1;
      }
      outPath = next;
      i++;
      continue;
    }

    if (tok.startsWith("--out=")) {
      outPath = tok.slice("--out=".length);
      continue;
    }

    process.stderr.write(`Unknown option: ${tok}\n\n`);
    process.stderr.write(helpText());
    return 1;
  }

  const workflowPath = path.resolve(positionals[0] ?? "./WORKFLOW.md");
  if (!existsSync(workflowPath)) {
    process.stderr.write(`Workflow not found: ${workflowPath}\n`);
    return 1;
  }

  const stateRoot = path.join(path.dirname(workflowPath), ".symphony_state");
  const defaultOut = path.join(stateRoot, `debug_bundle_${Date.now()}.json`);
  const out = path.resolve(outPath ?? defaultOut);

  const res = await writeDebugBundle({ workflowPath, outPath: out, stateRoot });
  process.stdout.write(`${res.outPath}\n`);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`debug:bundle failed: ${String(err)}\n`);
    process.exitCode = 1;
  });
