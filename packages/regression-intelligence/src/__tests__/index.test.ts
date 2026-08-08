import { test } from 'vitest';
import assert from 'node:assert/strict';
import { buildRegressionReport } from '../index.js';
import { analysisInput, snapshot, symbol, contractGate } from './fixtures.js';

test('buildRegressionReport: clean diff produces a LOW-risk, non-blocking report', () => {
  const baseline = snapshot({ files: ['src/a.ts'] });
  const candidate = snapshot({ files: ['src/a.ts', 'src/b.ts'] });
  const report = buildRegressionReport(analysisInput({ baseline, candidate, fileChanges: [{ status: 'ADDED', path: 'src/b.ts' }] }));
  assert.equal(report.riskLevel, 'LOW');
  assert.equal(report.blocking, false);
  assert.deepEqual(report.regressions, []);
});

test('buildRegressionReport: splits findings into regressions (MEDIUM/HIGH) vs warnings (LOW)', () => {
  const baseline = snapshot({ files: [], symbols: [symbol({ name: 'internalHelper', kind: 'function', file: 'src/util.ts', exported: false })] });
  const candidate = snapshot({ files: [] });
  const report = buildRegressionReport(analysisInput({ baseline, candidate, fileChanges: [] }));
  assert.equal(report.regressions.length, 0);
  assert.equal(report.warnings.length, 1);
  assert.equal(report.warnings[0].type, 'SYMBOL_REMOVED');
});

test('buildRegressionReport: a consumed removed endpoint blocks the merge end-to-end', () => {
  const baseline = snapshot({ files: [] });
  const candidate = snapshot({ files: [] });
  const gate = contractGate({
    ok: false,
    blocking: [{ severity: 'BLOCK', kind: 'ENDPOINT_REMOVED', endpoint: 'POST /checkout', message: 'removed', details: { consumed: true } }]
  });
  const report = buildRegressionReport(analysisInput({ baseline, candidate, fileChanges: [], contractGate: gate }));
  assert.equal(report.blocking, true);
  assert.ok(report.riskScore >= 80);
  assert.equal(report.riskLevel, 'CRITICAL');
});

test('buildRegressionReport: git conflicts block regardless of otherwise-clean diff', () => {
  const baseline = snapshot({ files: [] });
  const candidate = snapshot({ files: [] });
  const report = buildRegressionReport(analysisInput({ baseline, candidate, fileChanges: [], conflicts: ['src/a.ts'] }));
  assert.equal(report.blocking, true);
  assert.ok(report.riskScore >= 90);
});

test('buildRegressionReport: changes summary reflects endpoint/symbol/file diffs', () => {
  const baseline = snapshot({
    files: ['src/a.ts'],
    symbols: [symbol({ name: 'Foo', kind: 'class', file: 'src/a.ts', exported: true })],
    apiContracts: [{ id: '1', method: 'GET', path: '/old', file: 'src/a.ts', line: 1, requestFields: [], responseFields: [], schemaHints: [] }]
  });
  const candidate = snapshot({
    files: ['src/a.ts', 'src/b.ts'],
    symbols: [
      symbol({ name: 'Foo', kind: 'class', file: 'src/a.ts', exported: true }),
      symbol({ name: 'Bar', kind: 'class', file: 'src/b.ts', exported: true })
    ],
    apiContracts: [{ id: '2', method: 'GET', path: '/new', file: 'src/b.ts', line: 1, requestFields: [], responseFields: [], schemaHints: [] }]
  });
  const report = buildRegressionReport(analysisInput({ baseline, candidate, fileChanges: [{ status: 'ADDED', path: 'src/b.ts' }] }));
  assert.deepEqual(report.changes.filesAdded, ['src/b.ts']);
  assert.deepEqual(report.changes.symbolsAdded, ['class:Bar']);
  assert.deepEqual(report.changes.endpointsAdded, ['GET /new']);
  assert.deepEqual(report.changes.endpointsRemoved, ['GET /old']);
});
