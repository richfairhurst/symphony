# symphony-opencode-orchestrator

TypeScript/Bun implementation of the Symphony orchestrator, using `opencode` as the coding agent runner.

## Development

- Install deps: `bun install`
- Run tests: `bun test`
- Typecheck: `bun run typecheck`

## Workflow File

The orchestrator reads a `WORKFLOW.md` file (defaults to `./WORKFLOW.md`) containing YAML front matter plus a markdown prompt body.

The prompt body supports Liquid templating and receives a small input object (e.g. `issue`, `attempt`).

## Security: Prompt Template Trust Boundary

`WORKFLOW.md` is operator-controlled, but templates are still hardened.

- Filesystem-backed template loading is disabled to prevent accidental local file exfiltration into prompts.
- Liquid tags `{% include %}`, `{% render %}`, and `{% layout %}` are rejected.
