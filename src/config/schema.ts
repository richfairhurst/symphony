import { z } from "zod";

function intFromStringish(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  }
  return value;
}

const stringList = z.array(z.string());

export const rawWorkflowConfigSchema = z
  .object({
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
        interval_ms: z.preprocess(intFromStringish, z.number().int()).optional(),
      })
      .passthrough()
      .optional(),
    workspace: z
      .object({
        root: z.string().optional(),
      })
      .passthrough()
      .optional(),
    hooks: z
      .object({
        after_create: z.string().optional(),
        before_run: z.string().optional(),
        after_run: z.string().optional(),
        before_remove: z.string().optional(),
        timeout_ms: z.preprocess(intFromStringish, z.number().int()).optional(),
      })
      .passthrough()
      .optional(),
    agent: z
      .object({
        max_concurrent_agents: z.preprocess(intFromStringish, z.number().int()).optional(),
        max_turns: z.preprocess(intFromStringish, z.number().int()).optional(),
        max_retry_backoff_ms: z.preprocess(intFromStringish, z.number().int()).optional(),
        max_concurrent_agents_by_state: z
          .record(z.string(), z.union([z.number(), z.string()]))
          .optional(),
      })
      .passthrough()
      .optional(),
    server: z
      .object({
        port: z.preprocess(intFromStringish, z.number().int()).optional(),
      })
      .passthrough()
      .optional(),
    worker: z
      .object({
        ssh_hosts: z.array(z.string()).optional(),
        max_concurrent_agents_per_host: z
          .preprocess(intFromStringish, z.number().int())
          .optional(),
      })
      .passthrough()
      .optional(),
    opencode: z
      .object({
        command: z.string().optional(),
        run_timeout_ms: z.preprocess(intFromStringish, z.number().int()).optional(),
        event_read_timeout_ms: z.preprocess(intFromStringish, z.number().int()).optional(),
        stall_timeout_ms: z.preprocess(intFromStringish, z.number().int()).optional(),
      })
      .passthrough()
      .optional(),
    codex: z
      .object({
        command: z.string().optional(),
        turn_timeout_ms: z.preprocess(intFromStringish, z.number().int()).optional(),
        read_timeout_ms: z.preprocess(intFromStringish, z.number().int()).optional(),
        stall_timeout_ms: z.preprocess(intFromStringish, z.number().int()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type RawWorkflowConfig = z.infer<typeof rawWorkflowConfigSchema>;
