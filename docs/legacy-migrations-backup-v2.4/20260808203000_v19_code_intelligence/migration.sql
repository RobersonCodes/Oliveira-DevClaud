CREATE TABLE "CodeIntelligenceSnapshot" ("id" TEXT NOT NULL,"workspaceId" TEXT NOT NULL,"commitSha" TEXT NOT NULL,"payload" JSONB NOT NULL,"generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "CodeIntelligenceSnapshot_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "CodeIntelligenceSnapshot_workspaceId_commitSha_key" ON "CodeIntelligenceSnapshot"("workspaceId","commitSha");
CREATE INDEX "CodeIntelligenceSnapshot_workspaceId_generatedAt_idx" ON "CodeIntelligenceSnapshot"("workspaceId","generatedAt");
ALTER TABLE "CodeIntelligenceSnapshot" ADD CONSTRAINT "CodeIntelligenceSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
