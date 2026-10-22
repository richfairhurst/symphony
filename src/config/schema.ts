import { z } from "zod";

function intFromStringish(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  }
  return value;
}

const MAX_DURATION_MS = 86_400_000;
const MAX_CONCURRENT_AGENTS = 1_000;
const MAX_AGENT_TURNS = 1_000;

const boundedPositiveDuration = z.number().int().min(1).max(MAX_DURATION_MS);
const boundedNonNegativeDuration = z.number().int().min(0).max(MAX_DURATION_MS);
const boundedPositiveConcurrency = z
  .number()
  .int()
  .min(1)
  .max(MAX_CONCURRENT_AGENTS);
const boundedAgentTurns = z.number().int().min(1).max(MAX_AGENT_TURNS);
const boundedPort = z.number().int().min(0).max(65_535);

const stringList = z.array(z.string());
const rawGraphConditionValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
const rawGraphConditionSchema = z.object({
  dependency: z.string(),
  key: z.string(),
  equals: rawGraphConditionValue,
});
const rawGraphOutputSchema = z.record(
  z.string(),
  z.enum(["unknown", "string", "number", "boolean", "object", "array"]),
);
type RawGraphNodeConfig = {
  id: string;
  needs?: string[] | undefined;
  files?: string[] | undefined;
  prompt?: string | undefined;
  expects?:
    | string[]
    | Record<
        string,
        "unknown" | "string" | "number" | "boolean" | "object" | "array"
      >
    | undefined;
  when?:
    | {
    dependency: string;
    key: string;
    equals: string | number | boolean | null;
      }
    | undefined;
  graph?: RawGraphConfig | undefined;
};

type RawGraphConfig = {
  nodes: RawGraphNodeConfig[];
};

const rawGraphNodeSchema: z.ZodType<RawGraphNodeConfig> = z.lazy(() =>
  z.object({
    id: z.string(),
    needs: stringList.optional(),
    files: stringList.optional(),
    prompt: z.string().optional(),
    expects: z.union([stringList, rawGraphOutputSchema]).optional(),
    when: rawGraphConditionSchema.optional(),
    graph: rawGraphConfigSchema.optional(),
  }),
);

export const rawGraphConfigSchema: z.ZodType<RawGraphConfig> = z.lazy(() =>
  z.object({
    nodes: z.array(rawGraphNodeSchema),
  }),
);

export const rawWorkflowConfigSchema = z
  .object({
    verifier: z.string().optional(),
    graph: rawGraphConfigSchema.optional(),
    planner: z
      .object({
        enabled: z.boolean().optional(),
        prompt: z.string().optional(),
        files: stringList.optional(),
      })
      .passthrough()
      .optional(),
    tracker: z
      .object({
        kind: z.string().optional(),
        endpoint: z.string().optional(),
        allow_unsafe_endpoint: z.boolean().optional(),
        api_key: z.string().optional(),
        project_slug: z.string().optional(),
        active_states: stringList.optional(),
        terminal_states: stringList.optional(),
      })
      .passthrough()
      .optional(),
    polling: z
      .object({
        interval_ms: z
          .preprocess(intFromStringish, boundedPositiveDuration)
          .optional(),
      })
      .passthrough()
      .optional(),
    workspace: z
      .object({
        root: z.string().optional(),
      })
      .passthrough()
      .optional(),
    workstream_git: z
      .object({
        repository: z.string().optional(),
        base_branch: z.string().optional(),
        workstream_branch: z.string().optional(),
        worktree_root: z.string().optional(),
        commit_policy: z.string().optional(),
        cleanup_policy: z.string().optional(),
      })
      .passthrough()
      .optional(),
    hooks: z
      .object({
        after_create: z.string().optional(),
        before_run: z.string().optional(),
        after_run: z.string().optional(),
        before_remove: z.string().optional(),
        timeout_ms: z
          .preprocess(intFromStringish, boundedPositiveDuration)
          .optional(),
      })
      .passthrough()
      .optional(),
    agent: z
      .object({
        max_concurrent_agents: z
          .preprocess(intFromStringish, boundedPositiveConcurrency)
          .optional(),
        max_turns: z.preprocess(intFromStringish, boundedAgentTurns).optional(),
        max_retry_backoff_ms: z
          .preprocess(intFromStringish, boundedNonNegativeDuration)
          .optional(),
        max_concurrent_agents_by_state: z
          .record(
            z.string(),
            z.preprocess(intFromStringish, boundedPositiveConcurrency),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
    server: z
      .object({
        port: z.preprocess(intFromStringish, boundedPort).optional(),
      })
      .passthrough()
      .optional(),
    worker: z
      .object({
        ssh_hosts: z.array(z.string()).optional(),
        max_concurrent_agents_per_host: z
          .preprocess(intFromStringish, boundedPositiveConcurrency)
          .optional(),
      })
      .passthrough()
      .optional(),
    opencode: z
      .object({
        model: z.string().optional(),
        command: z.string().optional(),
        run_timeout_ms: z
          .preprocess(intFromStringish, boundedPositiveDuration)
          .optional(),
        event_read_timeout_ms: z
          .preprocess(intFromStringish, boundedNonNegativeDuration)
          .optional(),
        stall_timeout_ms: z
          .preprocess(intFromStringish, boundedNonNegativeDuration)
          .optional(),
      })
      .passthrough()
      .optional(),
    codex: z
      .object({
        command: z.string().optional(),
        turn_timeout_ms: z
          .preprocess(intFromStringish, boundedPositiveDuration)
          .optional(),
        read_timeout_ms: z
          .preprocess(intFromStringish, boundedNonNegativeDuration)
          .optional(),
        stall_timeout_ms: z
          .preprocess(intFromStringish, boundedNonNegativeDuration)
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type RawWorkflowConfig = z.infer<typeof rawWorkflowConfigSchema>;
