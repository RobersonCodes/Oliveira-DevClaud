export type RecoveryRuntimeStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

export type StaleAgentTask = {
  id: string;
  containerId: string | null;
  orchestrationId?: string | null;
  stepId?: string | null;
};

export type StaleOrchestration = { id: string };

export type RuntimeObservation = {
  status: RecoveryRuntimeStatus;
  exitCode?: number;
};

export type RecoveryDependencies = {
  findStaleAgents: (cutoff: Date) => Promise<StaleAgentTask[]>;
  inspectAgent: (containerId: string, taskId: string) => Promise<RuntimeObservation>;
  claimLiveAgent: (task: StaleAgentTask, cutoff: Date, at: Date) => Promise<boolean>;
  settleAgent: (
    task: StaleAgentTask,
    outcome: 'COMPLETED' | 'FAILED',
    observation: RuntimeObservation,
    cutoff: Date,
    at: Date
  ) => Promise<boolean>;
  findStaleOrchestrations: (cutoff: Date) => Promise<StaleOrchestration[]>;
  claimOrchestration: (orchestrationId: string, cutoff: Date, at: Date) => Promise<boolean>;
  enqueueOrchestration: (orchestrationId: string) => Promise<void>;
};

export type RecoveryResult = {
  liveAgents: number;
  completedAgents: number;
  failedAgents: number;
  orchestrations: number;
  racesLost: number;
  errors: number;
};

export async function recoverInterruptedRuntimeJobs(
  dependencies: RecoveryDependencies,
  options: { at?: Date; staleAfterMs?: number } = {}
): Promise<RecoveryResult> {
  const at = options.at ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? 60_000;
  const cutoff = new Date(at.getTime() - staleAfterMs);
  const result: RecoveryResult = {
    liveAgents: 0,
    completedAgents: 0,
    failedAgents: 0,
    orchestrations: 0,
    racesLost: 0,
    errors: 0
  };
  const enqueued = new Set<string>();

  const enqueueOnce = async (orchestrationId: string) => {
    if (enqueued.has(orchestrationId)) return;
    await dependencies.enqueueOrchestration(orchestrationId);
    enqueued.add(orchestrationId);
    result.orchestrations += 1;
  };

  const staleAgents = await dependencies.findStaleAgents(cutoff);
  for (const task of staleAgents) {
    try {
      const observation = task.containerId
        ? await dependencies.inspectAgent(task.containerId, task.id)
        : { status: 'UNKNOWN' as const };

      if (observation.status === 'RUNNING') {
        if (!await dependencies.claimLiveAgent(task, cutoff, at)) {
          result.racesLost += 1;
          continue;
        }
        result.liveAgents += 1;
        if (task.orchestrationId) await enqueueOnce(task.orchestrationId);
        continue;
      }

      const outcome = observation.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
      if (!await dependencies.settleAgent(task, outcome, observation, cutoff, at)) {
        result.racesLost += 1;
        continue;
      }
      if (outcome === 'COMPLETED') {
        result.completedAgents += 1;
        if (task.orchestrationId) await enqueueOnce(task.orchestrationId);
      } else {
        result.failedAgents += 1;
      }
    } catch {
      // A broker/database failure for one candidate must not prevent recovery of independent jobs.
      result.errors += 1;
    }
  }

  const staleOrchestrations = await dependencies.findStaleOrchestrations(cutoff);
  for (const orchestration of staleOrchestrations) {
    if (enqueued.has(orchestration.id)) continue;
    try {
      if (!await dependencies.claimOrchestration(orchestration.id, cutoff, at)) {
        result.racesLost += 1;
        continue;
      }
      await enqueueOnce(orchestration.id);
    } catch {
      result.errors += 1;
    }
  }

  return result;
}
