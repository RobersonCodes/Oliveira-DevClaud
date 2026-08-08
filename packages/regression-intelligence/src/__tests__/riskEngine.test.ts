import { test } from 'vitest';
import assert from 'node:assert/strict';
import { calculateRisk, levelForScore } from '../riskEngine.js';
import type { RegressionFinding, RiskSignals } from '../types.js';

const noSignals: RiskSignals = { contractGateBlocked: false, testsFailed: false, buildFailed: false, lintFailed: false, gitConflict: false };

function finding(overrides: Partial<RegressionFinding>): RegressionFinding {
  return {
    id: 'f', type: 'SYMBOL_REMOVED', severity: 'MEDIUM', confidence: 'MEDIUM', blocking: false,
    title: 't', description: 'd', files: [], ...overrides
  };
}

test('levelForScore thresholds match the spec bands', () => {
  assert.equal(levelForScore(0), 'LOW');
  assert.equal(levelForScore(24), 'LOW');
  assert.equal(levelForScore(25), 'MEDIUM');
  assert.equal(levelForScore(49), 'MEDIUM');
  assert.equal(levelForScore(50), 'HIGH');
  assert.equal(levelForScore(74), 'HIGH');
  assert.equal(levelForScore(75), 'CRITICAL');
  assert.equal(levelForScore(100), 'CRITICAL');
});

test('score sums severity weights and caps at 100', () => {
  const findings = Array.from({ length: 5 }, () => finding({ severity: 'HIGH' }));
  const result = calculateRisk(findings, noSignals);
  assert.equal(result.score, 100);
  assert.equal(result.level, 'CRITICAL');
});

test('no findings and no signals is LOW risk, not blocking', () => {
  const result = calculateRisk([], noSignals);
  assert.equal(result.score, 0);
  assert.equal(result.level, 'LOW');
  assert.equal(result.blocking, false);
});

test('Contract Gate block forces a minimum score of 80 and blocks', () => {
  const result = calculateRisk([], { ...noSignals, contractGateBlocked: true });
  assert.ok(result.score >= 80);
  assert.equal(result.blocking, true);
});

test('failing build/tests force a minimum score of 85 and block', () => {
  const buildResult = calculateRisk([], { ...noSignals, buildFailed: true });
  assert.ok(buildResult.score >= 85);
  assert.equal(buildResult.blocking, true);

  const testResult = calculateRisk([], { ...noSignals, testsFailed: true });
  assert.ok(testResult.score >= 85);
  assert.equal(testResult.blocking, true);
});

test('unresolved git conflicts force a minimum score of 90 and block', () => {
  const result = calculateRisk([], { ...noSignals, gitConflict: true });
  assert.ok(result.score >= 90);
  assert.equal(result.blocking, true);
});

test('a single MEDIUM regression finding never blocks on its own', () => {
  const result = calculateRisk([finding({ severity: 'MEDIUM' })], noSignals);
  assert.equal(result.blocking, false);
});

test('a finding explicitly marked blocking forces blocking=true regardless of signals', () => {
  const result = calculateRisk([finding({ severity: 'HIGH', blocking: true, title: 'consumed endpoint removed' })], noSignals);
  assert.equal(result.blocking, true);
  assert.ok(result.blockingReasons.includes('consumed endpoint removed'));
});

test('lint failure alone does not force a minimum score or block', () => {
  const result = calculateRisk([], { ...noSignals, lintFailed: true });
  assert.equal(result.score, 0);
  assert.equal(result.blocking, false);
});
