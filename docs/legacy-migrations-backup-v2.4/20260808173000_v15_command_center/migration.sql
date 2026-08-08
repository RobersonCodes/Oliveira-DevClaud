CREATE TYPE "CommandRunStatus" AS ENUM ('PLANNING','READY','STARTED','FAILED');
CREATE TABLE "CommandRun" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT,
  "objective" TEXT NOT NULL,
  "status" "CommandRunStatus" NOT NULL DEFAULT 'PLANNING',
  "repositoryContext" JSONB,
  "plan" JSONB,
  "orchestrationId" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  CONSTRAINT "CommandRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CommandRun_workspaceId_createdAt_idx" ON "CommandRun"("workspaceId", "createdAt");
ALTER TABLE "CommandRun" ADD CONSTRAINT "CommandRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommandRun" ADD CONSTRAINT "CommandRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommandRun" ADD CONSTRAINT "CommandRun_orchestrationId_fkey" FOREIGN KEY ("orchestrationId") REFERENCES "Orchestration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
