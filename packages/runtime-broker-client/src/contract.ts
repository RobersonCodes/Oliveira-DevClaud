import { z } from 'zod';

// Shared between the broker (server, packages consumed by apps/runtime-broker) and every caller of
// this client — the broker validates every request body against these exact schemas, so the two
// sides can never drift silently. Keeping the contract intentionally narrow (domain-specific
// operations, not a generic Docker passthrough) is what makes the allowlist enforceable: none of
// these shapes has a field for `Privileged`, `CapAdd`, arbitrary `Binds`, or an arbitrary Docker
// network name — those are either hardcoded broker-side or derived from a validated workspaceId,
// never accepted from a caller.

export const EXEC_ALLOWED_USERS = ['devcloud'] as const;

// Shared with ide-engine, which needs to recognize a workspace's dedicated network by name when
// picking an IP out of a container's NetworkSettings — defined here (not in the broker) so a
// non-broker package can depend on just this lightweight client rather than the broker service.
export const WORKSPACE_NETWORK_NAME_PREFIX = 'odc-ws-net-';

export const WORKSPACE_LIMIT_DEFAULTS = {
  cpuLimit: 1,
  memoryMb: 2048,
  pidsLimit: 512,
  diskMb: 10_240,
  maxRuntimeMinutes: 480
} as const;

export const CreateWorkspaceContainerSchema = z.object({
  projectId: z.string().min(1),
  defaultBranch: z.string().min(1).max(255).optional(),
  limits: z.object({
    cpuLimit: z.number().positive(),
    memoryMb: z.number().positive(),
    pidsLimit: z.number().int().min(64).max(4096).default(WORKSPACE_LIMIT_DEFAULTS.pidsLimit),
    diskMb: z.number().int().min(512).max(102_400).default(WORKSPACE_LIMIT_DEFAULTS.diskMb),
    maxRuntimeMinutes: z.number().int().min(15).max(10_080).default(WORKSPACE_LIMIT_DEFAULTS.maxRuntimeMinutes)
  })
});
export type CreateWorkspaceContainerInput = z.input<typeof CreateWorkspaceContainerSchema>;
export type ValidatedCreateWorkspaceContainerInput = z.output<typeof CreateWorkspaceContainerSchema>;

export const StopOrRestartSchema = z.object({
  timeoutSeconds: z.number().int().positive().max(120).default(10)
});

export const ExecRequestSchema = z.object({
  cmd: z.array(z.string()).min(1).max(64),
  workingDir: z.string().min(1).optional(),
  user: z.enum(EXEC_ALLOWED_USERS).optional(),
  env: z.array(z.string()).max(32).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional()
});
export type ExecRequestInput = z.infer<typeof ExecRequestSchema>;

export const ExecTtyStartMessageSchema = z.object({
  type: z.literal('start'),
  cmd: z.array(z.string()).min(1).max(16),
  workingDir: z.string().min(1).optional(),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000)
});
export const ExecTtyResizeMessageSchema = z.object({
  type: z.literal('resize'),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000)
});

export type ExecResult = { exitCode: number; output: string };

export type ContainerNetworkInfo = { ipAddress: string | null };

export type ContainerInspectResult = {
  id: string;
  name: string;
  status: string;
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  networks: Record<string, ContainerNetworkInfo>;
  labels: Record<string, string>;
};

export type WorkspaceContainerResult = { containerId: string; name: string; status: string };

export const PruneWorkspaceResourcesSchema = z.object({
  // This is a snapshot of the PostgreSQL source of truth, supplied by the API. The broker still
  // applies its own exact-label and age checks before deleting anything.
  activeWorkspaceIds: z.array(z.string().cuid()).max(10_000),
  orphanedBefore: z.string().datetime()
});
export type PruneWorkspaceResourcesInput = z.infer<typeof PruneWorkspaceResourcesSchema>;
export type PruneWorkspaceResourcesResult = {
  removedContainers: string[];
  removedNetworks: string[];
  retainedWorkspaceIds: string[];
  skippedRecent: number;
  skippedAttachedNetworks: number;
  failures: number;
};
