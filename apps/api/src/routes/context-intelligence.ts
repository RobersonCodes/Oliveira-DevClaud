import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Role } from '@oliveira/database';
import { requireOrgRole } from '../lib/auth.js';
import { getRepositoryIntelligenceCached } from '../lib/repositoryIntelligenceCache.js';
import { getCodeIntelligenceCached } from '../lib/codeIntelligenceCache.js';
import { buildFocusedCodeContext } from '@oliveira/context-engine';

const querySchema=z.object({objective:z.string().min(3).max(5000),refresh:z.enum(['true','false']).optional()});

export async function contextIntelligenceRoutes(app:FastifyInstance){
  app.get('/:workspaceId',async request=>{
    const {workspaceId}=z.object({workspaceId:z.string().cuid()}).parse(request.params);
    const query=querySchema.parse(request.query);
    const ws=await prisma.workspace.findUnique({where:{id:workspaceId},include:{project:true}});
    if(!ws)throw Object.assign(new Error('WORKSPACE_NOT_FOUND'),{statusCode:404});
    await requireOrgRole(request,ws.project.organizationId,Role.DEVELOPER);
    if(!ws.containerId)throw Object.assign(new Error('WORKSPACE_HAS_NO_CONTAINER'),{statusCode:409});
    const repository=await getRepositoryIntelligenceCached({workspaceId,containerId:ws.containerId,force:query.refresh==='true'});
    const code=await getCodeIntelligenceCached({workspaceId,containerId:ws.containerId,repository:repository.intelligence,force:query.refresh==='true'});
    const focused=buildFocusedCodeContext(query.objective,code.intelligence);
    return {focused,cache:{repository:repository.cache,code:code.cache}};
  });
}
