import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkflow } from "./resolve";

function expectWorkflowError(
  fn: () => unknown,
  code: string,
): { message: string } {
  try {
    fn();
  } catch (err) {
    expect(err).toEqual(expect.objectContaining({ code }));
    return { message: err instanceof Error ? err.message : String(err) };
  }
  throw new Error("Expected resolveWorkflow to throw");
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("workflow config resolution", () => {
  test("expands $VAR for tracker.api_key", () => {
    const resolved = resolveWorkflow(
      {
        tracker: {
          api_key: "$LINEAR_API_KEY",
        },
      },
      "Hello",
      { LINEAR_API_KEY: "secret" },
    );

    expect(resolved.config.tracker.apiKey).toBe("secret");
  });

  test("expands $VAR for tracker.project_slug", () => {
    const resolved = resolveWorkflow(
      {
        tracker: {
          project_slug: "$LINEAR_PROJECT_SLUG",
        },
      },
      "Hello",
      { LINEAR_PROJECT_SLUG: "richfairhurst" },
    );

    expect(resolved.config.tracker.projectSlug).toBe("richfairhurst");
  });

  test("missing env token becomes undefined", () => {
    const resolved = resolveWorkflow(
      {
        tracker: {
          api_key: "$LINEAR_API_KEY",
        },
      },
      "Hello",
      {},
    );

    expect(resolved.config.tracker.apiKey).toBeUndefined();
  });

  test("missing project slug env token becomes undefined", () => {
    const resolved = resolveWorkflow(
      {
        tracker: {
          project_slug: "$LINEAR_PROJECT_SLUG",
        },
      },
      "Hello",
      {},
    );

    expect(resolved.config.tracker.projectSlug).toBeUndefined();
  });

  test("workspace.root preserves bare relative names", () => {
    const resolved = resolveWorkflow(
      { workspace: { root: "workspaces" } },
      "Hello",
      {},
    );
    expect(resolved.config.workspace.root).toBe("workspaces");
  });

  test("workspace.root defaults to user-private directory", () => {
    const resolved = resolveWorkflow({}, "Hello", {});
    expect(resolved.config.workspace.root).toBe(
      path.join(os.homedir(), ".symphony", "workspaces"),
    );
  });

  test("workspace.root resolves path separators", () => {
    const resolved = resolveWorkflow(
      { workspace: { root: "./tmp/workspaces" } },
      "Hello",
      {},
    );
    expect(path.isAbsolute(resolved.config.workspace.root)).toBe(true);
  });

  test("rejects unsafe numeric runtime settings", () => {
    const invalidConfigs = [
      { polling: { interval_ms: 0 } },
      { polling: { interval_ms: 86_400_001 } },
      { agent: { max_concurrent_agents: 0 } },
      { agent: { max_turns: -1 } },
      { agent: { max_retry_backoff_ms: -1 } },
      { hooks: { timeout_ms: 0 } },
      { worker: { max_concurrent_agents_per_host: 0 } },
      { opencode: { run_timeout_ms: 0 } },
      { opencode: { event_read_timeout_ms: -1 } },
      { opencode: { stall_timeout_ms: -1 } },
      { server: { port: 65_536 } },
      { agent: { max_concurrent_agents_by_state: { todo: 0 } } },
    ];

    for (const config of invalidConfigs) {
      expectWorkflowError(
        () => resolveWorkflow(config, "Hello", {}),
        "workflow_parse_error",
      );
    }
  });

  test("allows zero runner watchdog timeouts to disable those watchdogs", () => {
    const resolved = resolveWorkflow(
      {
        opencode: {
          event_read_timeout_ms: 0,
          stall_timeout_ms: 0,
        },
      },
      "Hello",
      {},
    );

    expect(resolved.config.opencode.eventReadTimeoutMs).toBe(0);
    expect(resolved.config.opencode.stallTimeoutMs).toBe(0);
  });

  test("resolves explicit local Workstream-Git configuration", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workstream-config-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    mkdirSync(repository);
    const resolved = resolveWorkflow(
      {
        workstream_git: {
          repository,
          base_branch: "main",
          workstream_branch: "workstream/example",
          worktree_root: path.join(root, "worktrees"),
          commit_policy: "controlled_hybrid",
          cleanup_policy: "preserve",
        },
      },
      "Hello",
      {},
    );
    expect(resolved.config.workstreamGit).toEqual({
      repository: path.resolve(repository),
      baseBranch: "main",
      workstreamBranch: "workstream/example",
      worktreeRoot: path.resolve(root, "worktrees"),
      commitPolicy: "controlled_hybrid",
      cleanupPolicy: "preserve",
    });
  });

  test("requires every Workstream-Git field", () => {
    const err = expectWorkflowError(
      () => resolveWorkflow({ workstream_git: {} }, "Hello", {}),
      "workflow_parse_error",
    );
    expect(err.message).toContain("Missing workstream_git.repository");
  });

  test("rejects missing repository and repository files", () => {
    const missing = expectWorkflowError(
      () =>
        resolveWorkflow(
          { workstream_git: { repository: "/does/not/exist" } },
          "Hello",
          {},
        ),
      "workflow_parse_error",
    );
    expect(missing.message).toContain("path does not exist");
  });

  test("expands environment and home-relative Workstream-Git paths", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workstream-config-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    mkdirSync(repository);
    const worktreeRoot = path.join(
      os.homedir(),
      `.symphony-worktrees-${path.basename(root)}`,
    );
    const resolved = resolveWorkflow(
      {
        workstream_git: {
          repository: "$WORKSTREAM_REPOSITORY",
          base_branch: "main",
          workstream_branch: "workstream/example",
          worktree_root: `~/${path.basename(worktreeRoot)}`,
          commit_policy: "controlled_hybrid",
          cleanup_policy: "never",
        },
      },
      "Hello",
      { WORKSTREAM_REPOSITORY: repository },
    );
    expect(resolved.config.workstreamGit?.repository).toBe(
      path.resolve(repository),
    );
    expect(resolved.config.workstreamGit?.worktreeRoot).toBe(worktreeRoot);
  });

  test("rejects unsafe branches and worktree roots", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workstream-config-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    mkdirSync(repository);
    const config = {
      repository,
      base_branch: "main..bad",
      workstream_branch: "workstream/example",
      worktree_root: path.join(root, "worktrees"),
      commit_policy: "controlled_hybrid",
      cleanup_policy: "on_success",
    };
    expectWorkflowError(
      () => resolveWorkflow({ workstream_git: config }, "Hello", {}),
      "workflow_parse_error",
    );
    expectWorkflowError(
      () =>
        resolveWorkflow(
          { workstream_git: { ...config, base_branch: "-main" } },
          "Hello",
          {},
        ),
      "workflow_parse_error",
    );
    expectWorkflowError(
      () =>
        resolveWorkflow(
          {
            workstream_git: {
              ...config,
              base_branch: "main",
              worktree_root: repository,
            },
          },
          "Hello",
          {},
        ),
      "workflow_parse_error",
    );
    expectWorkflowError(
      () =>
        resolveWorkflow(
          {
            workstream_git: {
              ...config,
              base_branch: "main",
              worktree_root: path.parse(repository).root,
            },
          },
          "Hello",
          {},
        ),
      "workflow_parse_error",
    );
    const repositoryChild = path.join(repository, "nested");
    expectWorkflowError(
      () =>
        resolveWorkflow(
          {
            workstream_git: {
              ...config,
              base_branch: "main",
              worktree_root: repositoryChild,
            },
          },
          "Hello",
          {},
        ),
      "workflow_parse_error",
    );
    const repositoryLink = path.join(root, "repository-link");
    symlinkSync(repository, repositoryLink);
    expectWorkflowError(
      () =>
        resolveWorkflow(
          {
            workstream_git: {
              ...config,
              base_branch: "main",
              worktree_root: path.join(repositoryLink, "nested"),
            },
          },
          "Hello",
          {},
        ),
      "workflow_parse_error",
    );
    expectWorkflowError(
      () =>
        resolveWorkflow(
          {
            workstream_git: {
              ...config,
              base_branch: "main",
              workstream_branch: "main",
            },
          },
          "Hello",
          {},
        ),
      "workflow_parse_error",
    );
  });

  test("rejects non-directory repositories and existing worktree roots", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workstream-config-"));
    temporaryDirectories.push(root);
    const repositoryFile = path.join(root, "repository.txt");
    writeFileSync(repositoryFile, "not a repository");
    const config = {
      repository: repositoryFile,
      base_branch: "main",
      workstream_branch: "workstream/example",
      worktree_root: path.join(root, "worktrees"),
      commit_policy: "controlled_hybrid",
      cleanup_policy: "on_success",
    };
    const repositoryError = expectWorkflowError(
      () => resolveWorkflow({ workstream_git: config }, "Hello", {}),
      "workflow_parse_error",
    );
    expect(repositoryError.message).toContain("not a directory");

    const repository = path.join(root, "repository");
    mkdirSync(repository);
    const worktreeFile = path.join(root, "worktrees");
    writeFileSync(worktreeFile, "not a directory");
    const worktreeError = expectWorkflowError(
      () =>
        resolveWorkflow(
          {
            workstream_git: {
              ...config,
              repository,
              worktree_root: worktreeFile,
            },
          },
          "Hello",
          {},
        ),
      "workflow_parse_error",
    );
    expect(worktreeError.message).toContain("worktree_root");
  });

  test("rejects unsupported policy values", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "workstream-config-"));
    temporaryDirectories.push(root);
    const repository = path.join(root, "repository");
    mkdirSync(repository);
    const config = {
      repository,
      base_branch: "main",
      workstream_branch: "workstream/example",
      worktree_root: path.join(root, "worktrees"),
      commit_policy: "automatic",
      cleanup_policy: "on_success",
    };
    const err = expectWorkflowError(
      () => resolveWorkflow({ workstream_git: config }, "Hello", {}),
      "workflow_parse_error",
    );
    expect(err.message).toContain("commit_policy");
    expectWorkflowError(
      () =>
        resolveWorkflow(
          {
            workstream_git: {
              ...config,
              commit_policy: "controlled_hybrid",
              cleanup_policy: "always",
            },
          },
          "Hello",
          {},
        ),
      "workflow_parse_error",
    );
  });

  test("falls back to default prompt when body is empty", () => {
    const resolved = resolveWorkflow({}, "\n\n", {});
    expect(resolved.promptTemplate).toContain("You are working on an issue");
  });

  test("resolves verifier command when configured", () => {
    const resolved = resolveWorkflow(
      { verifier: "bun test && bun run typecheck" },
      "Hello",
      {},
    );
    expect(resolved.config.verifier).toBe("bun test && bun run typecheck");
  });

  test("drops blank verifier command", () => {
    const resolved = resolveWorkflow({ verifier: "   " }, "Hello", {});
    expect(resolved.config.verifier).toBeUndefined();
  });

  test("resolves graph nodes with normalized needs and expects", () => {
    const resolved = resolveWorkflow(
      {
        graph: {
          nodes: [
            {
              id: "plan",
              files: ["src/a.ts", "src/a.ts"],
              prompt: "  Build plan  ",
              expects: ["summary", "summary", "files"],
            },
            {
              id: "apply",
              needs: ["plan", "plan"],
              files: ["src/b.ts"],
              prompt: "Use {{ dependencies.plan.output.summary }}",
            },
          ],
        },
      },
      "Hello",
      {},
    );

    expect(resolved.config.graph).toEqual({
      nodes: [
        {
          id: "plan",
          needs: [],
          files: ["src/a.ts"],
          prompt: "Build plan",
          expects: ["summary", "files"],
          outputSchema: { summary: "unknown", files: "unknown" },
        },
        {
          id: "apply",
          needs: ["plan"],
          files: ["src/b.ts"],
          prompt: "Use {{ dependencies.plan.output.summary }}",
          expects: [],
          outputSchema: {},
        },
      ],
    });
  });

  test("resolves typed graph output schemas", () => {
    const resolved = resolveWorkflow(
      {
        graph: {
          nodes: [
            {
              id: "plan",
              files: ["src/a.ts"],
              prompt: "Build plan",
              expects: {
                summary: "string",
                count: "number",
                done: "boolean",
              },
            },
          ],
        },
      },
      "Hello",
      {},
    );

    expect(resolved.config.graph).toEqual({
      nodes: [
        {
          id: "plan",
          needs: [],
          files: ["src/a.ts"],
          prompt: "Build plan",
          expects: ["summary", "count", "done"],
          outputSchema: {
            summary: "string",
            count: "number",
            done: "boolean",
          },
        },
      ],
    });
  });

  test("resolves graph node branch conditions", () => {
    const resolved = resolveWorkflow(
      {
        graph: {
          nodes: [
            {
              id: "plan",
              files: ["src/a.ts"],
              prompt: "Build plan",
              expects: {
                route: "string",
              },
            },
            {
              id: "apply",
              needs: ["plan"],
              files: ["src/b.ts"],
              prompt: "Use plan",
              when: {
                dependency: "  plan  ",
                key: "  route  ",
                equals: "apply",
              },
            },
          ],
        },
      },
      "Hello",
      {},
    );

    expect(resolved.config.graph?.nodes[1]?.when).toEqual({
      dependency: "plan",
      key: "route",
      equals: "apply",
    });
  });

  test("resolves nested graph nodes", () => {
    const resolved = resolveWorkflow(
      {
        graph: {
          nodes: [
            {
              id: "parent",
              expects: { result: "string" },
              graph: {
                nodes: [
                  {
                    id: "child",
                    files: ["src/out.txt"],
                    prompt: "Child",
                    expects: { result: "string" },
                  },
                ],
              },
            },
          ],
        },
      },
      "Hello",
      {},
    );

    expect(resolved.config.graph?.nodes[0]).toEqual({
      id: "parent",
      needs: [],
      files: [],
      prompt: "",
      expects: ["result"],
      outputSchema: { result: "string" },
      graph: {
        nodes: [
          {
            id: "child",
            needs: [],
            files: ["src/out.txt"],
            prompt: "Child",
            expects: ["result"],
            outputSchema: { result: "string" },
          },
        ],
      },
    });
  });

  test("resolves planner config when enabled", () => {
    const resolved = resolveWorkflow(
      {
        planner: {
          enabled: true,
          files: ["src/core/orchestrator.ts", "src/core/orchestrator.ts"],
          prompt: "  plan it  ",
        },
      },
      "Hello",
      {},
    );

    expect(resolved.config.planner).toEqual({
      enabled: true,
      files: ["src/core/orchestrator.ts"],
      prompt: "plan it",
    });
  });

  test("resolves opencode model when configured", () => {
    const resolved = resolveWorkflow(
      {
        opencode: {
          model: "  opencode/kimi-k2.7-code  ",
        },
      },
      "Hello",
      {},
    );

    expect(resolved.config.opencode.model).toBe("opencode/kimi-k2.7-code");
  });

  test("rejects planner mode with static graph mode", () => {
    expectWorkflowError(
      () =>
        resolveWorkflow(
          {
            planner: { enabled: true },
            graph: {
              nodes: [{ id: "a", files: ["src/a.ts"], prompt: "A" }],
            },
          },
          "Hello",
          {},
        ),
      "workflow_parse_error",
    );
  });

  test("rejects graph cycles", () => {
    expectWorkflowError(
      () =>
        resolveWorkflow(
          {
            graph: {
              nodes: [
                { id: "a", needs: ["b"], files: ["src/a.ts"], prompt: "A" },
                { id: "b", needs: ["a"], files: ["src/b.ts"], prompt: "B" },
              ],
            },
          },
          "Hello",
          {},
        ),
      "workflow_parse_error",
    );
  });

  test("rejects graph nodes with escaping file paths", () => {
    expectWorkflowError(
      () =>
        resolveWorkflow(
          {
            graph: {
              nodes: [{ id: "a", files: ["../secret.txt"], prompt: "A" }],
            },
          },
          "Hello",
          {},
        ),
      "workflow_parse_error",
    );
  });

  test("rejects graph branch conditions that reference outputs outside needs", () => {
    expectWorkflowError(
      () =>
        resolveWorkflow(
          {
            graph: {
              nodes: [
                {
                  id: "plan",
                  files: ["src/a.ts"],
                  prompt: "A",
                  expects: { route: "string" },
                },
                {
                  id: "apply",
                  files: ["src/b.ts"],
                  prompt: "B",
                  when: {
                    dependency: "plan",
                    key: "route",
                    equals: "apply",
                  },
                },
              ],
            },
          },
          "Hello",
          {},
        ),
      "workflow_parse_error",
    );
  });

  test("rejects nested graph nodes that cannot provide parent outputs", () => {
    expectWorkflowError(
      () =>
        resolveWorkflow(
          {
            graph: {
              nodes: [
                {
                  id: "parent",
                  expects: { result: "string" },
                  graph: {
                    nodes: [
                      {
                        id: "child",
                        files: ["src/a.ts"],
                        prompt: "Child",
                        expects: { summary: "string" },
                      },
                    ],
                  },
                },
              ],
            },
          },
          "Hello",
          {},
        ),
      "workflow_parse_error",
    );
  });

  test("accepts codex.* aliases and normalizes into opencode.*", () => {
    const resolved = resolveWorkflow(
      {
        codex: {
          command: "opencode run --format json",
          turn_timeout_ms: 111,
          read_timeout_ms: 222,
          stall_timeout_ms: 333,
        },
      },
      "Hello",
      {},
    );
    expect(resolved.config.opencode.command).toBe("opencode run --format json");
    expect(resolved.config.opencode.runTimeoutMs).toBe(111);
    expect(resolved.config.opencode.eventReadTimeoutMs).toBe(222);
    expect(resolved.config.opencode.stallTimeoutMs).toBe(333);
  });

  test("rejects http tracker.endpoint", () => {
    expectWorkflowError(
      () =>
        resolveWorkflow(
          { tracker: { endpoint: "http://api.linear.app/graphql" } },
          "Hello",
          {},
        ),
      "workflow_invalid_tracker_endpoint",
    );
  });

  test("rejects non-Linear tracker.endpoint by default", () => {
    const err = expectWorkflowError(
      () =>
        resolveWorkflow(
          { tracker: { endpoint: "https://evil.example/graphql" } },
          "Hello",
          {},
        ),
      "workflow_invalid_tracker_endpoint",
    );
    expect(err.message).toContain("https://api.linear.app/graphql");
  });

  test("rejects localhost tracker.endpoint even with unsafe override", () => {
    expectWorkflowError(
      () =>
        resolveWorkflow(
          {
            tracker: {
              endpoint: "https://localhost/graphql",
              allow_unsafe_endpoint: true,
            },
          },
          "Hello",
          {},
        ),
      "workflow_invalid_tracker_endpoint",
    );
  });

  test("allows custom https tracker.endpoint only when unsafe override enabled", () => {
    const resolved = resolveWorkflow(
      {
        tracker: {
          endpoint: "https://evil.example/graphql",
          allow_unsafe_endpoint: true,
        },
      },
      "Hello",
      {},
    );
    expect(resolved.config.tracker.endpoint).toBe(
      "https://evil.example/graphql",
    );
    expect(resolved.config.tracker.allowUnsafeEndpoint).toBe(true);
  });
});
