import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Role, SecretKind } from '@oliveira/database';
import { requireOrgRole } from '../lib/auth.js';
import { resolveSecretByKind } from '../lib/secretResolver.js';

async function gh(token: string, path: string) {
  const response = await fetch(`https://api.github.com${path}`, { headers: { Authorization:`Bearer ${token}`, Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28', 'User-Agent':'Oliveira-DevCloud/1.0' } });
  if (!response.ok) throw Object.assign(new Error(`GITHUB_${response.status}`), { statusCode: response.status === 401 ? 401 : 502 });
  return response.json();
}

export async function githubRoutes(app: FastifyInstance) {
  app.get('/status', async request => {
    const q=z.object({ organizationId:z.string().cuid() }).parse(request.query);
    await requireOrgRole(request,q.organizationId,Role.DEVELOPER);
    const token=await resolveSecretByKind(q.organizationId,SecretKind.GITHUB_TOKEN);
    if (!token) return { connected:false };
    const user=await gh(token,'/user') as { login:string; avatar_url?:string };
    return { connected:true, login:user.login, avatarUrl:user.avatar_url };
  });
  app.get('/repositories', async request => {
    const q=z.object({ organizationId:z.string().cuid(), page:z.coerce.number().int().min(1).max(10).default(1) }).parse(request.query);
    await requireOrgRole(request,q.organizationId,Role.DEVELOPER);
    const token=await resolveSecretByKind(q.organizationId,SecretKind.GITHUB_TOKEN);
    if (!token) throw Object.assign(new Error('GITHUB_NOT_CONNECTED'),{statusCode:409});
    const repos=await gh(token,`/user/repos?per_page=50&page=${q.page}&sort=updated&affiliation=owner,collaborator,organization_member`) as any[];
    return repos.map(r=>({ id:r.id, name:r.name, fullName:r.full_name, private:r.private, cloneUrl:r.clone_url, defaultBranch:r.default_branch, updatedAt:r.updated_at }));
  });
}
