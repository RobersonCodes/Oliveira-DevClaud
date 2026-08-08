CREATE TYPE "AgentReviewStatus" AS ENUM ('PENDING', 'READY', 'MERGED', 'REJECTED');
ALTER TABLE "AgentTask"
  ADD COLUMN "branchName" TEXT,
  ADD COLUMN "worktreePath" TEXT,
  ADD COLUMN "baseCommit" TEXT,
  ADD COLUMN "reviewStatus" "AgentReviewStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "mergeCommit" TEXT,
  ADD COLUMN "mergedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedAt" TIMESTAMP(3);
