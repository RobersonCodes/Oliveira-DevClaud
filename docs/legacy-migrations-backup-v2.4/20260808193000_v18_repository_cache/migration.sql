CREATE TABLE "RepositorySnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "branch" TEXT,
    "payload" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RepositorySnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RepositorySnapshot_workspaceId_commitSha_key" ON "RepositorySnapshot"("workspaceId", "commitSha");
CREATE INDEX "RepositorySnapshot_workspaceId_generatedAt_idx" ON "RepositorySnapshot"("workspaceId", "generatedAt");
ALTER TABLE "RepositorySnapshot" ADD CONSTRAINT "RepositorySnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
