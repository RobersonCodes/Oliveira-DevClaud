import { prisma, SecretKind } from '@oliveira/database';
import { decryptSecret, type EncryptedSecret } from '@oliveira/secret-manager';

export async function resolveSecretByKind(organizationId: string, kind: SecretKind): Promise<string | null> {
  const secret = await prisma.secret.findFirst({ where: { organizationId, kind }, orderBy: { updatedAt: 'desc' } });
  if (!secret) return null;
  const aad = `${secret.organizationId}:${secret.scope}:${secret.name}:${secret.projectId ?? ''}:${secret.workspaceId ?? ''}`;
  return decryptSecret(secret.encryptedValue as unknown as EncryptedSecret, aad);
}
