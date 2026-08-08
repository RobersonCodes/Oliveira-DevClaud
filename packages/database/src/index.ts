import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __oliveiraPrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__oliveiraPrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalThis.__oliveiraPrisma = prisma;
export * from '@prisma/client';
