CREATE TYPE "PlannerProvider" AS ENUM ('DETERMINISTIC', 'OPENAI', 'ANTHROPIC');
ALTER TABLE "CommandRun"
  ADD COLUMN "plannerProvider" "PlannerProvider" NOT NULL DEFAULT 'DETERMINISTIC',
  ADD COLUMN "plannerFallbackReason" TEXT;
