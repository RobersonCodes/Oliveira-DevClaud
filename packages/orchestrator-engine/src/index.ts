import { Queue, type JobsOptions } from 'bullmq';
import { Redis as IORedis } from 'ioredis';

export type PlanStep = {
  key: string;
  title: string;
  type: 'AGENT' | 'SYSTEM';
  agent?: 'CODEX' | 'CLAUDE';
  prompt?: string;
  command?: string;
  dependsOn?: string[];
};

export function validateDag(steps: PlanStep[]) {
  if (!steps.length) throw new Error('PLAN_REQUIRES_STEPS');
  const keys = new Set<string>();
  for (const step of steps) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(step.key)) throw new Error(`INVALID_STEP_KEY:${step.key}`);
    if (keys.has(step.key)) throw new Error(`DUPLICATE_STEP_KEY:${step.key}`);
    keys.add(step.key);
    if (step.type === 'AGENT' && (!step.agent || !step.prompt)) throw new Error(`INVALID_AGENT_STEP:${step.key}`);
    if (step.type === 'SYSTEM' && !step.command) throw new Error(`INVALID_SYSTEM_STEP:${step.key}`);
  }
  for (const step of steps) for (const dep of step.dependsOn ?? []) if (!keys.has(dep)) throw new Error(`UNKNOWN_DEPENDENCY:${dep}`);
  const visiting = new Set<string>(), visited = new Set<string>();
  const byKey = new Map(steps.map(s => [s.key, s]));
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error('PLAN_HAS_CYCLE');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dep of byKey.get(key)?.dependsOn ?? []) visit(dep);
    visiting.delete(key); visited.add(key);
  };
  for (const key of keys) visit(key);
  return true;
}

export function readyStepKeys(steps: Array<{key:string; status:string; dependsOn:string[]}>) {
  const completed = new Set(steps.filter(s => s.status === 'COMPLETED').map(s => s.key));
  return steps.filter(s => s.status === 'BLOCKED' && s.dependsOn.every(d => completed.has(d))).map(s => s.key);
}

export const ORCHESTRATION_TICK_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000, jitter: 0.25 },
  // Keep a bounded window so the host-admin metrics endpoint can calculate queue wait/runtime and
  // retry samples. Payload contains only orchestrationId; no prompt or source is stored in BullMQ.
  removeOnComplete: 500,
  removeOnFail: 500
} satisfies JobsOptions;

export const QUEUE_METRICS_OPTIONS = { maxDataPoints: 1_440 } as const;

export const orchestrationTickDeduplicationId = (orchestrationId: string) => `tick-${orchestrationId}`;

export class OrchestrationQueue {
  readonly queue: Queue;
  constructor(
    url = process.env.REDIS_URL ?? 'redis://localhost:6379',
    queueName = 'oliveira-orchestrations'
  ) {
    const connection = new IORedis(url, { maxRetriesPerRequest: null });
    this.queue = new Queue(queueName, { connection });
  }
  async tick(orchestrationId: string) {
    // Coalesce concurrent callers while preserving one trailing tick when the active tick requests
    // its continuation. A stable jobId alone discards that continuation because the active job owns
    // the id until it completes; keepLastIfActive explicitly retains the latest pending request.
    return this.queue.add('tick', { orchestrationId }, {
      ...ORCHESTRATION_TICK_JOB_OPTIONS,
      deduplication: { id: orchestrationTickDeduplicationId(orchestrationId), keepLastIfActive: true },
    });
  }
}
