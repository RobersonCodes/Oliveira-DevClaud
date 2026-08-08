CREATE TABLE "ContractIntelligenceSnapshot" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "commitSha" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContractIntelligenceSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContractIntelligenceSnapshot_workspaceId_commitSha_key" ON "ContractIntelligenceSnapshot"("workspaceId","commitSha");
CREATE INDEX "ContractIntelligenceSnapshot_workspaceId_generatedAt_idx" ON "ContractIntelligenceSnapshot"("workspaceId","generatedAt");
ALTER TABLE "ContractIntelligenceSnapshot" ADD CONSTRAINT "ContractIntelligenceSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
