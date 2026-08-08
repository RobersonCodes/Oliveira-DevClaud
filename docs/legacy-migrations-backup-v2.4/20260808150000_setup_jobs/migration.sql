CREATE TYPE "SetupJobStatus" AS ENUM ('QUEUED','RUNNING','READY','FAILED','CANCELLED');
CREATE TYPE "SetupStage" AS ENUM ('QUEUED','CREATING_CONTAINER','CLONING_REPOSITORY','DETECTING_STACK','INSTALLING_DEPS','CONFIGURING_PORTS','STARTING_IDE','READY','FAILED');
CREATE TABLE "SetupJob" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT,
  "organizationId" TEXT NOT NULL,
  "status" "SetupJobStatus" NOT NULL DEFAULT 'QUEUED',
  "stage" "SetupStage" NOT NULL DEFAULT 'QUEUED',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "message" TEXT,
  "options" JSONB,
  "result" JSONB,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SetupJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SetupJob_workspaceId_createdAt_idx" ON "SetupJob"("workspaceId","createdAt");
CREATE INDEX "SetupJob_organizationId_status_idx" ON "SetupJob"("organizationId","status");
ALTER TABLE "SetupJob" ADD CONSTRAINT "SetupJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
