import { describe, expect, it, vi } from 'vitest';
import { recoverInterruptedRuntimeJobs, type RecoveryDependencies } from './recovery.js';

const at = new Date('2026-08-14T12:00:00.000Z');
const cutoff = new Date('2026-08-14T11:59:00.000Z');

function dependencies(overrides: Partial<RecoveryDependencies> = {}): RecoveryDependencies {
  return {
    findStaleAgents: async () => [],
    inspectAgent: async () => ({ status: 'RUNNING' }),
    claimLiveAgent: async () => true,
    settleAgent: async () => true,
    findStaleOrchestrations: async () => [],
    claimOrchestration: async () => true,
    enqueueOrchestration: async () => undefined,
    ...overrides
  };
}

describe('interrupted runtime recovery', () => {
  it('claims a live agent lease and resumes its orchestration exactly once', async () => {
    const claimLiveAgent = vi.fn(async () => true);
    const claimOrchestration = vi.fn(async () => true);
    const enqueueOrchestration = vi.fn(async () => undefined);
    const result = await recoverInterruptedRuntimeJobs(dependencies({
      findStaleAgents: async () => [{ id: 'agent-1', containerId: 'container-1', orchestrationId: 'orch-1', stepId: 'step-1' }],
      claimLiveAgent,
      findStaleOrchestrations: async () => [{ id: 'orch-1' }],
      claimOrchestration,
      enqueueOrchestration
    }), { at });

    expect(claimLiveAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent-1' }), cutoff, at);
    expect(enqueueOrchestration).toHaveBeenCalledTimes(1);
    expect(enqueueOrchestration).toHaveBeenCalledWith('orch-1');
    expect(claimOrchestration).not.toHaveBeenCalled();
    expect(result).toEqual({ liveAgents: 1, completedAgents: 0, failedAgents: 0, orchestrations: 1, racesLost: 0, errors: 0 });
  });

  it('reconciles completed and lost runtimes while only completed work resumes the DAG', async () => {
    const settleAgent = vi.fn(async () => true);
    const enqueueOrchestration = vi.fn(async () => undefined);
    const result = await recoverInterruptedRuntimeJobs(dependencies({
      findStaleAgents: async () => [
        { id: 'completed', containerId: 'container', orchestrationId: 'orch-completed', stepId: 'step-completed' },
        { id: 'lost', containerId: null, orchestrationId: 'orch-lost', stepId: 'step-lost' }
      ],
      inspectAgent: async (_containerId, taskId) => taskId === 'completed'
        ? { status: 'COMPLETED', exitCode: 0 }
        : { status: 'UNKNOWN' },
      settleAgent,
      enqueueOrchestration
    }), { at });

    expect(settleAgent).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'completed' }), 'COMPLETED', { status: 'COMPLETED', exitCode: 0 }, cutoff, at);
    expect(settleAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'lost' }), 'FAILED', { status: 'UNKNOWN' }, cutoff, at);
    expect(enqueueOrchestration).toHaveBeenCalledTimes(1);
    expect(enqueueOrchestration).toHaveBeenCalledWith('orch-completed');
    expect(result).toEqual({ liveAgents: 0, completedAgents: 1, failedAgents: 1, orchestrations: 1, racesLost: 0, errors: 0 });
  });

  it('does not enqueue when a concurrent terminal transition wins the CAS', async () => {
    const enqueueOrchestration = vi.fn(async () => undefined);
    const result = await recoverInterruptedRuntimeJobs(dependencies({
      findStaleAgents: async () => [{ id: 'agent-race', containerId: 'container', orchestrationId: 'orch-race' }],
      claimLiveAgent: async () => false,
      findStaleOrchestrations: async () => [{ id: 'orch-terminal' }],
      claimOrchestration: async () => false,
      enqueueOrchestration
    }), { at });

    expect(enqueueOrchestration).not.toHaveBeenCalled();
    expect(result.racesLost).toBe(2);
  });

  it('isolates a failed probe and claims an independent stale orchestration', async () => {
    const enqueueOrchestration = vi.fn(async () => undefined);
    const result = await recoverInterruptedRuntimeJobs(dependencies({
      findStaleAgents: async () => [
        { id: 'broken', containerId: 'broken' },
        { id: 'live', containerId: 'live' }
      ],
      inspectAgent: async containerId => {
        if (containerId === 'broken') throw new Error('BROKER_DOWN');
        return { status: 'RUNNING' };
      },
      findStaleOrchestrations: async () => [{ id: 'orch-independent' }],
      enqueueOrchestration
    }), { at });

    expect(enqueueOrchestration).toHaveBeenCalledWith('orch-independent');
    expect(result).toEqual({ liveAgents: 1, completedAgents: 0, failedAgents: 0, orchestrations: 1, racesLost: 0, errors: 1 });
  });
});
