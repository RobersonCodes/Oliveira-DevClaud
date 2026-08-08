CREATE TYPE "OrchestrationReviewStatus" AS ENUM ('NOT_READY','ANALYZING','CONFLICT','GATE_FAILED','READY','APPROVED','REJECTED','MERGED');
ALTER TABLE "Orchestration"
  ADD COLUMN "reviewStatus" "OrchestrationReviewStatus" NOT NULL DEFAULT 'NOT_READY',
  ADD COLUMN "reviewBranch" TEXT,
  ADD COLUMN "reviewWorktreePath" TEXT,
  ADD COLUMN "reviewBaseCommit" TEXT,
  ADD COLUMN "reviewSummary" JSONB,
  ADD COLUMN "mergeCommit" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "mergedAt" TIMESTAMP(3);
