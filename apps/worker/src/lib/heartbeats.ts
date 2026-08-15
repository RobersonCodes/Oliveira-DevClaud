export type RunningWorkspace = { id: string; containerId: string };
export type RunningAgent = { id: string; containerId: string; orchestrationId?: string | null };

type HeartbeatInput = {
  workspaces: RunningWorkspace[];
  agents: RunningAgent[];
  workspaceIsLive: (containerId: string) => Promise<boolean>;
  agentIsLive: (containerId: string, taskId: string) => Promise<boolean>;
  touchWorkspace: (workspaceId: string, at: Date) => Promise<void>;
  touchAgent: (taskId: string, at: Date) => Promise<void>;
  touchOrchestration: (orchestrationId: string, at: Date) => Promise<void>;
};

export async function refreshRuntimeHeartbeats(input: HeartbeatInput, at = new Date()) {
  let workspaces = 0;
  let agents = 0;
  let orchestrations = 0;
  const touchedOrchestrations = new Set<string>();

  for (const workspace of input.workspaces) {
    try {
      if (!await input.workspaceIsLive(workspace.containerId)) continue;
      await input.touchWorkspace(workspace.id, at);
      workspaces += 1;
    } catch {
      // A failed probe is not proof of liveness. Leave the previous heartbeat stale for recovery.
    }
  }

  for (const agent of input.agents) {
    try {
      if (!await input.agentIsLive(agent.containerId, agent.id)) continue;
      await input.touchAgent(agent.id, at);
      agents += 1;
      if (agent.orchestrationId && !touchedOrchestrations.has(agent.orchestrationId)) {
        await input.touchOrchestration(agent.orchestrationId, at);
        touchedOrchestrations.add(agent.orchestrationId);
        orchestrations += 1;
      }
    } catch {
      // Isolate one broken runtime so other live runtimes still renew their leases.
    }
  }

  return { workspaces, agents, orchestrations };
}
