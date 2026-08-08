CREATE TYPE "SecretScope" AS ENUM ('ORGANIZATION', 'PROJECT', 'WORKSPACE');
CREATE TYPE "SecretKind" AS ENUM ('GENERIC', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY');
CREATE TABLE "Secret" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId" TEXT,
  "workspaceId" TEXT,
  "scope" "SecretScope" NOT NULL DEFAULT 'ORGANIZATION',
  "kind" "SecretKind" NOT NULL DEFAULT 'GENERIC',
  "name" TEXT NOT NULL,
  "encryptedValue" JSONB NOT NULL,
  "maskedValue" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Secret_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Secret_organizationId_scope_name_projectId_workspaceId_key" ON "Secret"("organizationId","scope","name","projectId","workspaceId");
CREATE INDEX "Secret_organizationId_kind_idx" ON "Secret"("organizationId","kind");
CREATE INDEX "Secret_projectId_idx" ON "Secret"("projectId");
CREATE INDEX "Secret_workspaceId_idx" ON "Secret"("workspaceId");
ALTER TABLE "Secret" ADD CONSTRAINT "Secret_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Secret" ADD CONSTRAINT "Secret_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Secret" ADD CONSTRAINT "Secret_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
