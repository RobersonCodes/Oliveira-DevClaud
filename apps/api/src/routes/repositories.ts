import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Role, SecretKind } from '@oliveira/database';
import { requireOrgRole } from '../lib/auth.js';
import { resolveSecretByKind } from '../lib/secretResolver.js';
import { bootstrapRepository } from '../lib/repositoryBootstrap.js';
import { audit } from '../lib/audit.js';

export async function repositoryRoutes(app:FastifyInstance) {
  app.post('/:workspaceId/bootstrap', async (request,reply)=>{
    const { workspaceId }=request.params as {workspaceId:string};
    const body=z.object({ force:z.boolean().default(false) }).parse(request.body ?? {});
    const ws=await prisma.workspace.findUniqueOrThrow({ where:{id:workspaceId}, include:{project:true} });
    const { user }=await requireOrgRole(request,ws.project.organizationId,Role.ADMIN);
    if (!ws.containerId || ws.status!=='RUNNING') throw Object.assign(new Error('WORKSPACE_NOT_RUNNING'),{statusCode:409});
    if (!ws.project.repositoryUrl) throw Object.assign(new Error('PROJECT_HAS_NO_REPOSITORY'),{statusCode:409});
    if (body.force) throw Object.assign(new Error('FORCE_BOOTSTRAP_NOT_AVAILABLE_IN_V1'),{statusCode:400});
    const token=await resolveSecretByKind(ws.project.organizationId,SecretKind.GITHUB_TOKEN);
    await bootstrapRepository({containerId:ws.containerId,repositoryUrl:ws.project.repositoryUrl,defaultBranch:ws.project.defaultBranch,githubToken:token});
    await audit({userId:user.id,organizationId:ws.project.organizationId,action:'REPOSITORY_BOOTSTRAPPED',resource:'Workspace',resourceId:ws.id,ipAddress:request.ip,metadata:{ repositoryUrl:ws.project.repositoryUrl, branch:ws.project.defaultBranch }});
    return reply.code(201).send({ok:true,workspaceId});
  });
}
