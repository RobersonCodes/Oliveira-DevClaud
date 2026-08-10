import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import fs from 'node:fs/promises';
import { prisma } from '@oliveira/database';
import { requireHostAdmin } from '../lib/auth.js';

export async function systemRoutes(app:FastifyInstance) {
  app.get('/metrics-summary', async (request)=>{
    await requireHostAdmin(request);
    const [workspaces,agents,projects,orchestrations]=await Promise.all([
      prisma.workspace.count({where:{status:'RUNNING'}}), prisma.agentTask.count({where:{status:'RUNNING'}}), prisma.project.count(), prisma.orchestration.count({where:{status:'RUNNING'}})
    ]);
    let disk:any=null;
    try { const stat=await fs.statfs(process.env.WORKSPACE_ROOT ?? '/tmp'); disk={ totalBytes:stat.blocks*stat.bsize, freeBytes:stat.bavail*stat.bsize }; } catch {}
    return { host:{ cpus:os.cpus().length, load:os.loadavg(), memoryTotal:os.totalmem(), memoryFree:os.freemem(), uptimeSeconds:os.uptime(), disk }, platform:{runningWorkspaces:workspaces,runningAgents:agents,projects,runningOrchestrations:orchestrations} };
  });
}
