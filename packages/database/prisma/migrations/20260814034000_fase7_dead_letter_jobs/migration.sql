CREATE TYPE "DeadLetterQueue" AS ENUM ('ORCHESTRATION', 'SETUP');
CREATE TYPE "DeadLetterStatus" AS ENUM ('OPEN', 'REQUEUEING', 'REQUEUED', 'RESOLVED');

CREATE TABLE "DeadLetterJob" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "queue" "DeadLetterQueue" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceJobId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "errorCode" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "status" "DeadLetterStatus" NOT NULL DEFAULT 'OPEN',
    "resolutionNote" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "requeuedSourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeadLetterJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeadLetterJob_organizationId_queue_sourceId_sourceJobId_key"
ON "DeadLetterJob"("organizationId", "queue", "sourceId", "sourceJobId");
CREATE INDEX "DeadLetterJob_organizationId_status_createdAt_idx" ON "DeadLetterJob"("organizationId", "status", "createdAt");
CREATE INDEX "DeadLetterJob_sourceId_idx" ON "DeadLetterJob"("sourceId");

ALTER TABLE "DeadLetterJob" ADD CONSTRAINT "DeadLetterJob_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
