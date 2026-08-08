-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'DEVELOPER');

-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('CREATING', 'RUNNING', 'STOPPED', 'ERROR', 'DESTROYING');

-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('CODEX', 'CLAUDE');

-- CreateEnum
CREATE TYPE "AgentTaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgentReviewStatus" AS ENUM ('PENDING', 'READY', 'MERGED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OrchestrationStatus" AS ENUM ('DRAFT', 'QUEUED', 'RUNNING', 'WAITING_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrchestrationStepType" AS ENUM ('AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "OrchestrationStepStatus" AS ENUM ('BLOCKED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "OrchestrationReviewStatus" AS ENUM ('NOT_READY', 'ANALYZING', 'CONFLICT', 'GATE_FAILED', 'READY', 'APPROVED', 'REJECTED', 'MERGED');

-- CreateEnum
CREATE TYPE "SecretScope" AS ENUM ('ORGANIZATION', 'PROJECT', 'WORKSPACE');

-- CreateEnum
CREATE TYPE "SecretKind" AS ENUM ('GENERIC', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY');

-- CreateEnum
CREATE TYPE "SetupJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SetupStage" AS ENUM ('QUEUED', 'CREATING_CONTAINER', 'CLONING_REPOSITORY', 'DETECTING_STACK', 'INSTALLING_DEPS', 'CONFIGURING_PORTS', 'STARTING_IDE', 'READY', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CommandRunStatus" AS ENUM ('PLANNING', 'READY', 'STARTED', 'FAILED');

-- CreateEnum
CREATE TYPE "PlannerProvider" AS ENUM ('DETERMINISTIC', 'OPENAI', 'ANTHROPIC');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'DEVELOPER',

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "repositoryUrl" TEXT,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "containerId" TEXT,
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'CREATING',
    "cpuLimit" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "memoryMb" INTEGER NOT NULL DEFAULT 2048,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerminalSession" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tmuxName" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Terminal',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "cols" INTEGER NOT NULL DEFAULT 120,
    "rows" INTEGER NOT NULL DEFAULT 34,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TerminalSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspacePort" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "label" TEXT,
    "protocol" TEXT NOT NULL DEFAULT 'http',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspacePort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdeSession" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "port" INTEGER NOT NULL DEFAULT 13337,
    "startedAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTask" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agent" "AgentType" NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" "AgentTaskStatus" NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "exitCode" INTEGER,
    "metadata" JSONB,
    "branchName" TEXT,
    "worktreePath" TEXT,
    "baseCommit" TEXT,
    "reviewStatus" "AgentReviewStatus" NOT NULL DEFAULT 'PENDING',
    "mergeCommit" TEXT,
    "mergedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),

    CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionName" TEXT NOT NULL,
    "statusFile" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "exitCode" INTEGER,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Orchestration" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" "OrchestrationStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "reviewStatus" "OrchestrationReviewStatus" NOT NULL DEFAULT 'NOT_READY',
    "reviewBranch" TEXT,
    "reviewWorktreePath" TEXT,
    "reviewBaseCommit" TEXT,
    "reviewSummary" JSONB,
    "mergeCommit" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "mergedAt" TIMESTAMP(3),

    CONSTRAINT "Orchestration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrchestrationStep" (
    "id" TEXT NOT NULL,
    "orchestrationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "OrchestrationStepType" NOT NULL,
    "status" "OrchestrationStepStatus" NOT NULL DEFAULT 'BLOCKED',
    "agent" "AgentType",
    "prompt" TEXT,
    "taskContext" JSONB,
    "command" TEXT,
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agentTaskId" TEXT,
    "exitCode" INTEGER,
    "output" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "OrchestrationStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "ipAddress" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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
    "heartbeatAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "parentJobId" TEXT,

    CONSTRAINT "SetupJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SetupJobLog" (
    "id" TEXT NOT NULL,
    "setupJobId" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "stage" "SetupStage",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SetupJobLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepositorySnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "branch" TEXT,
    "payload" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepositorySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommandRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "objective" TEXT NOT NULL,
    "status" "CommandRunStatus" NOT NULL DEFAULT 'PLANNING',
    "repositoryContext" JSONB,
    "plan" JSONB,
    "plannerProvider" "PlannerProvider" NOT NULL DEFAULT 'DETERMINISTIC',
    "plannerFallbackReason" TEXT,
    "orchestrationId" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),

    CONSTRAINT "CommandRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeIntelligenceSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeIntelligenceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractIntelligenceSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractIntelligenceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "OrganizationMember_userId_idx" ON "OrganizationMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "Project_organizationId_idx" ON "Project"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_organizationId_slug_key" ON "Project"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "Workspace_projectId_idx" ON "Workspace"("projectId");

-- CreateIndex
CREATE INDEX "TerminalSession_workspaceId_active_idx" ON "TerminalSession"("workspaceId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "TerminalSession_workspaceId_tmuxName_key" ON "TerminalSession"("workspaceId", "tmuxName");

-- CreateIndex
CREATE INDEX "WorkspacePort_workspaceId_idx" ON "WorkspacePort"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspacePort_workspaceId_port_key" ON "WorkspacePort"("workspaceId", "port");

-- CreateIndex
CREATE UNIQUE INDEX "IdeSession_workspaceId_key" ON "IdeSession"("workspaceId");

-- CreateIndex
CREATE INDEX "AgentTask_workspaceId_status_idx" ON "AgentTask"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "AgentRun_taskId_startedAt_idx" ON "AgentRun"("taskId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentRun_workspaceId_startedAt_idx" ON "AgentRun"("workspaceId", "startedAt");

-- CreateIndex
CREATE INDEX "Orchestration_workspaceId_status_idx" ON "Orchestration"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OrchestrationStep_agentTaskId_key" ON "OrchestrationStep"("agentTaskId");

-- CreateIndex
CREATE INDEX "OrchestrationStep_orchestrationId_status_idx" ON "OrchestrationStep"("orchestrationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OrchestrationStep_orchestrationId_key_key" ON "OrchestrationStep"("orchestrationId", "key");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Secret_organizationId_kind_idx" ON "Secret"("organizationId", "kind");

-- CreateIndex
CREATE INDEX "Secret_projectId_idx" ON "Secret"("projectId");

-- CreateIndex
CREATE INDEX "Secret_workspaceId_idx" ON "Secret"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Secret_organizationId_scope_name_projectId_workspaceId_key" ON "Secret"("organizationId", "scope", "name", "projectId", "workspaceId");

-- CreateIndex
CREATE INDEX "SetupJob_workspaceId_createdAt_idx" ON "SetupJob"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "SetupJob_organizationId_status_idx" ON "SetupJob"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SetupJobLog_setupJobId_createdAt_idx" ON "SetupJobLog"("setupJobId", "createdAt");

-- CreateIndex
CREATE INDEX "RepositorySnapshot_workspaceId_generatedAt_idx" ON "RepositorySnapshot"("workspaceId", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RepositorySnapshot_workspaceId_commitSha_key" ON "RepositorySnapshot"("workspaceId", "commitSha");

-- CreateIndex
CREATE INDEX "CommandRun_workspaceId_createdAt_idx" ON "CommandRun"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "CodeIntelligenceSnapshot_workspaceId_generatedAt_idx" ON "CodeIntelligenceSnapshot"("workspaceId", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CodeIntelligenceSnapshot_workspaceId_commitSha_key" ON "CodeIntelligenceSnapshot"("workspaceId", "commitSha");

-- CreateIndex
CREATE INDEX "ContractIntelligenceSnapshot_workspaceId_generatedAt_idx" ON "ContractIntelligenceSnapshot"("workspaceId", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContractIntelligenceSnapshot_workspaceId_commitSha_key" ON "ContractIntelligenceSnapshot"("workspaceId", "commitSha");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminalSession" ADD CONSTRAINT "TerminalSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspacePort" ADD CONSTRAINT "WorkspacePort_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdeSession" ADD CONSTRAINT "IdeSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Orchestration" ADD CONSTRAINT "Orchestration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrchestrationStep" ADD CONSTRAINT "OrchestrationStep_orchestrationId_fkey" FOREIGN KEY ("orchestrationId") REFERENCES "Orchestration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrchestrationStep" ADD CONSTRAINT "OrchestrationStep_agentTaskId_fkey" FOREIGN KEY ("agentTaskId") REFERENCES "AgentTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Secret" ADD CONSTRAINT "Secret_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Secret" ADD CONSTRAINT "Secret_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Secret" ADD CONSTRAINT "Secret_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupJob" ADD CONSTRAINT "SetupJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SetupJobLog" ADD CONSTRAINT "SetupJobLog_setupJobId_fkey" FOREIGN KEY ("setupJobId") REFERENCES "SetupJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositorySnapshot" ADD CONSTRAINT "RepositorySnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommandRun" ADD CONSTRAINT "CommandRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommandRun" ADD CONSTRAINT "CommandRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommandRun" ADD CONSTRAINT "CommandRun_orchestrationId_fkey" FOREIGN KEY ("orchestrationId") REFERENCES "Orchestration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeIntelligenceSnapshot" ADD CONSTRAINT "CodeIntelligenceSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractIntelligenceSnapshot" ADD CONSTRAINT "ContractIntelligenceSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
