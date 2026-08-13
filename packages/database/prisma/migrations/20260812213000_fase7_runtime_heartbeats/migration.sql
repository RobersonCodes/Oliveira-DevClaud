ALTER TABLE "Workspace" ADD COLUMN "heartbeatAt" TIMESTAMP(3);
ALTER TABLE "AgentTask" ADD COLUMN "heartbeatAt" TIMESTAMP(3);
ALTER TABLE "Orchestration" ADD COLUMN "heartbeatAt" TIMESTAMP(3);

CREATE INDEX "Workspace_status_heartbeatAt_idx" ON "Workspace"("status", "heartbeatAt");
CREATE INDEX "AgentTask_status_heartbeatAt_idx" ON "AgentTask"("status", "heartbeatAt");
CREATE INDEX "Orchestration_status_heartbeatAt_idx" ON "Orchestration"("status", "heartbeatAt");
