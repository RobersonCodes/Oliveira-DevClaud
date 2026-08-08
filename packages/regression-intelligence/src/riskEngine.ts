import type { RegressionFinding, RegressionSeverity, RiskAssessment, RiskLevel, RiskSignals } from './types.js';

// Risk Engine is intentionally separate from the scanners (detectors.ts): scanners only observe and
// classify, this module is the only place that turns observations into a score/decision.
const SEVERITY_WEIGHT: Record<RegressionSeverity, number> = { HIGH: 25, MEDIUM: 10, LOW: 3 };

const LEVEL_THRESHOLDS: Array<[number, RiskLevel]> = [
  [75, 'CRITICAL'],
  [50, 'HIGH'],
  [25, 'MEDIUM'],
  [0, 'LOW']
];

export function levelForScore(score: number): RiskLevel {
  for (const [min, level] of LEVEL_THRESHOLDS) if (score >= min) return level;
  return 'LOW';
}

/**
 * Conservative blocking policy (spec Fase 7): only strong, unambiguous evidence blocks
 * automatically — Contract Gate BLOCK, failing tests/build, unresolved git conflicts, or a
 * regression finding explicitly marked `blocking: true` by its own detector (currently only
 * ENDPOINT_REMOVED-with-known-consumer). Symbol/critical-module heuristics never auto-block on
 * their own; they raise the score and surface as regressions/warnings for human review instead.
 */
export function calculateRisk(findings: RegressionFinding[], signals: RiskSignals): RiskAssessment {
  let score = 0;
  for (const finding of findings) score += SEVERITY_WEIGHT[finding.severity];

  let blocking = false;
  const blockingReasons: string[] = [];

  if (signals.contractGateBlocked) {
    score = Math.max(score, 80);
    blocking = true;
    blockingReasons.push('Contract Gate bloqueou regressões de contrato de alta confiança.');
  }
  if (signals.buildFailed) {
    score = Math.max(score, 85);
    blocking = true;
    blockingReasons.push('Build falhou na worktree de integração.');
  }
  if (signals.testsFailed) {
    score = Math.max(score, 85);
    blocking = true;
    blockingReasons.push('Testes falharam na worktree de integração.');
  }
  if (signals.gitConflict) {
    score = Math.max(score, 90);
    blocking = true;
    blockingReasons.push('Conflitos de merge não resolvidos na worktree de integração.');
  }

  for (const finding of findings) {
    if (!finding.blocking) continue;
    blocking = true;
    blockingReasons.push(finding.title);
  }

  score = Math.min(100, Math.round(score));
  return { score, level: levelForScore(score), blocking, blockingReasons: [...new Set(blockingReasons)] };
}
