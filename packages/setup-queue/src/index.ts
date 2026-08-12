import { Queue, type JobsOptions } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
export const setupConnection = () => new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379',{maxRetriesPerRequest:null});
export const SETUP_PROVISION_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000, jitter: 0.25 },
  removeOnComplete: 100,
  removeOnFail: 500
} satisfies JobsOptions;
export class SetupQueue {
  readonly queue: Queue;
  constructor(
    url = process.env.REDIS_URL ?? 'redis://localhost:6379',
    queueName = 'oliveira-setup'
  ){ this.queue=new Queue(queueName,{connection:new IORedis(url,{maxRetriesPerRequest:null})}); }
  enqueue(setupJobId:string){ return this.queue.add('provision',{setupJobId},{...SETUP_PROVISION_JOB_OPTIONS,jobId:setupJobId}); }
  async remove(setupJobId:string){ const job=await this.queue.getJob(setupJobId); if(job) await job.remove(); }
  async requeue(setupJobId:string){ await this.remove(setupJobId).catch(()=>undefined); return this.enqueue(setupJobId); }
  close(){ return this.queue.close(); }
}
