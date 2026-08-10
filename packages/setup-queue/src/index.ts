import { Queue } from 'bullmq';
import { Redis as IORedis } from 'ioredis';
export const setupConnection = () => new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379',{maxRetriesPerRequest:null});
export class SetupQueue {
  private queue: Queue;
  constructor(){ this.queue=new Queue('oliveira-setup',{connection:setupConnection()}); }
  enqueue(setupJobId:string){ return this.queue.add('provision',{setupJobId},{jobId:setupJobId,attempts:1,removeOnComplete:100,removeOnFail:500}); }
  async remove(setupJobId:string){ const job=await this.queue.getJob(setupJobId); if(job) await job.remove(); }
  async requeue(setupJobId:string){ await this.remove(setupJobId).catch(()=>undefined); return this.enqueue(setupJobId); }
  close(){ return this.queue.close(); }
}
