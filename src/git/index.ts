export { GitCommandAdapter } from "./commands";
export { WorkstreamGit, WorkstreamManager } from "./workstream";
export { TicketWorktreeGit, TicketWorktreeManager } from "./ticketWorktree";
export { IntegrationManager, TicketIntegrationManager } from "./integration";
export type { IntegrationOptions, IntegrationPrerequisite, IntegrationResult, IntegrationStatus, IntegrationVerifier, TicketIntegration } from "./integration";
export type { TicketWorktree, TicketWorktreeConfig, TicketWorktreeInspection } from "./ticketWorktree";
export type { WorkstreamBootstrapResult, WorkstreamGitConfig, WorkstreamState, WorkstreamStateStore } from "./workstream";
export type { Spawned } from "./commands";
export type {
  DirtyState,
  GitAdapterOptions,
  GitCommandOptions,
  GitCommandResult,
  GitInspectionResult,
  GitSpawnFn,
  RepositoryIdentity,
  Worktree,
} from "./types";
