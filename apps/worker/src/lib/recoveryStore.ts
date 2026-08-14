import type { PrismaClient } from '@oliveira/database';
import type { RecoveryDependencies, StaleAgentTask } from './recovery.js';

const staleHeartbeatWhere = (cutoff: Date) => ({
  OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: cutoff } }]
});

export function createPrismaRuntimeRecoveryDependencies(input: {
  database: PrismaClient;
  inspectAgent: RecoveryDependencies['inspectAgent'];
  enqueueOrchestration: RecoveryDependencies['enqueueOrchestration'];
}): RecoveryDependencies {
  const { database } = input;
  return {
    findStaleAgents: async cutoff => (await database.agentTask.findMany({
      where: { status: 'RUNNING', ...staleHeartbeatWhere(cutoff) },
      select: {
        id: true,
        workspace: { select: { containerId: true } },
        orchestrationStep: { select: { id: true, orchestrationId: true } }
      }
    })).map(task => ({
      id: task.id,
      containerId: task.workspace.containerId,
      stepId: task.orchestrationStep?.id,
      orchestrationId: task.orchestrationStep?.orchestrationId
    })),
    inspectAgent: input.inspectAgent,
    claimLiveAgent: async (task, cutoff, at) => database.$transaction(async tx => {
      const claimed = await tx.agentTask.updateMany({
        where: { id: task.id, status: 'RUNNING', ...staleHeartbeatWhere(cutoff) },
        data: { heartbeatAt: at }
      });
      if (claimed.count === 0) return false;
      if (task.orchestrationId) {
        await tx.orchestration.updateMany({
          where: { id: task.orchestrationId, status: 'RUNNING' },
          data: { heartbeatAt: at }
        });
      }
      return true;
    }),
    settleAgent: async (task: StaleAgentTask, outcome, observation, cutoff, at) => {
      try {
        return await database.$transaction(async tx => {
          const taskClaim = await tx.agentTask.updateMany({
            where: { id: task.id, status: 'RUNNING', ...staleHeartbeatWhere(cutoff) },
            data: {
              status: outcome,
              exitCode: observation.exitCode ?? null,
              finishedAt: at,
              heartbeatAt: at,
              reviewStatus: 'READY'
            }
          });
          if (taskClaim.count === 0) return false;

          if (task.stepId) {
            const interrupted = outcome === 'FAILED' && ['UNKNOWN', 'CANCELLED'].includes(observation.status);
            const stepClaim = await tx.orchestrationStep.updateMany({
              where: { id: task.stepId, status: 'RUNNING', agentTaskId: task.id },
              data: {
                status: outcome,
                exitCode: observation.exitCode ?? null,
                finishedAt: at,
                output: interrupted ? 'Agent runtime was lost after its heartbeat expired' : undefined
              }
            });
            if (stepClaim.count === 0) throw new Error('RUNTIME_RECOVERY_STATE_CHANGED');
          }

          await tx.agentRun.updateMany({
            where: { taskId: task.id, finishedAt: null },
            data: { finishedAt: at, exitCode: observation.exitCode ?? null }
          });
          if (task.orchestrationId) {
            if (outcome === 'FAILED') {
              await tx.orchestration.updateMany({
                where: { id: task.orchestrationId, status: { in: ['QUEUED', 'RUNNING'] } },
                data: { status: 'FAILED', finishedAt: at, heartbeatAt: at }
              });
            } else {
              await tx.orchestration.updateMany({
                where: { id: task.orchestrationId, status: 'RUNNING' },
                data: { heartbeatAt: at }
              });
            }
          }
          return true;
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'RUNTIME_RECOVERY_STATE_CHANGED') return false;
        throw error;
      }
    },
    findStaleOrchestrations: async cutoff => database.orchestration.findMany({
      where: { status: 'RUNNING', reviewStatus: 'NOT_READY', ...staleHeartbeatWhere(cutoff) },
      select: { id: true }
    }),
    claimOrchestration: async (orchestrationId, cutoff, at) => (await database.orchestration.updateMany({
      where: {
        id: orchestrationId,
        status: 'RUNNING',
        reviewStatus: 'NOT_READY',
        ...staleHeartbeatWhere(cutoff)
      },
      data: { heartbeatAt: at }
    })).count > 0,
    enqueueOrchestration: input.enqueueOrchestration
  };
}
