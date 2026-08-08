import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  detectTestRemoved,
  detectEndpointRemoved,
  detectSymbolRemoved,
  detectCriticalModuleChanged,
  detectTestCoverageRisk,
  detectMigrationRisk,
  detectDependencyChange,
  detectConfigChange
} from '../detectors.js';
import { analysisInput, snapshot, symbol, contractGate } from './fixtures.js';

test('TEST_REMOVED: flags baseline test files missing from the candidate as MEDIUM by default', () => {
  const baseline = snapshot({ files: ['src/a.ts', 'src/a.test.ts'] });
  const candidate = snapshot({ files: ['src/a.ts'] });
  const [finding] = detectTestRemoved(analysisInput({ baseline, candidate, fileChanges: [] }));
  assert.equal(finding.type, 'TEST_REMOVED');
  assert.equal(finding.severity, 'MEDIUM');
  assert.deepEqual(finding.files, ['src/a.test.ts']);
});

test('TEST_REMOVED: escalates to HIGH when many tests disappear at once', () => {
  const testFiles = Array.from({ length: 6 }, (_, i) => `src/f${i}.test.ts`);
  const baseline = snapshot({ files: testFiles });
  const candidate = snapshot({ files: [] });
  const [finding] = detectTestRemoved(analysisInput({ baseline, candidate, fileChanges: [] }));
  assert.equal(finding.severity, 'HIGH');
});

test('TEST_REMOVED: no finding when nothing was removed', () => {
  const baseline = snapshot({ files: ['src/a.test.ts'] });
  const candidate = snapshot({ files: ['src/a.test.ts'] });
  assert.deepEqual(detectTestRemoved(analysisInput({ baseline, candidate, fileChanges: [] })), []);
});

test('ENDPOINT_REMOVED: consumed endpoint from Contract Gate becomes a HIGH, blocking finding', () => {
  const baseline = snapshot({ files: [] });
  const candidate = snapshot({ files: [] });
  const gate = contractGate({
    ok: false,
    blocking: [{ severity: 'BLOCK', kind: 'ENDPOINT_REMOVED', endpoint: 'POST /checkout', message: 'removed', details: { consumed: true } }]
  });
  const [finding] = detectEndpointRemoved(analysisInput({ baseline, candidate, fileChanges: [], contractGate: gate }));
  assert.equal(finding.severity, 'HIGH');
  assert.equal(finding.blocking, true);
  assert.deepEqual(finding.endpoints, ['POST /checkout']);
});

test('ENDPOINT_REMOVED: non-consumed endpoint becomes MEDIUM and non-blocking', () => {
  const baseline = snapshot({ files: [] });
  const candidate = snapshot({ files: [] });
  const gate = contractGate({
    warnings: [{ severity: 'WARN', kind: 'ENDPOINT_REMOVED', endpoint: 'GET /debug', message: 'removed', details: { consumed: false } }]
  });
  const [finding] = detectEndpointRemoved(analysisInput({ baseline, candidate, fileChanges: [], contractGate: gate }));
  assert.equal(finding.severity, 'MEDIUM');
  assert.equal(finding.blocking, false);
});

test('SYMBOL_REMOVED: exported class removal is HIGH but never auto-blocking (regex confidence)', () => {
  const baseline = snapshot({ files: [], symbols: [symbol({ name: 'PaymentService', kind: 'class', file: 'src/payments.ts', exported: true })] });
  const candidate = snapshot({ files: [], symbols: [] });
  const [finding] = detectSymbolRemoved(analysisInput({ baseline, candidate, fileChanges: [] }));
  assert.equal(finding.severity, 'HIGH');
  assert.equal(finding.blocking, false);
  assert.equal(finding.confidence, 'MEDIUM');
});

test('SYMBOL_REMOVED: non-exported helper removal is LOW severity', () => {
  const baseline = snapshot({ files: [], symbols: [symbol({ name: 'helper', kind: 'function', file: 'src/util.ts', exported: false })] });
  const candidate = snapshot({ files: [], symbols: [] });
  const [finding] = detectSymbolRemoved(analysisInput({ baseline, candidate, fileChanges: [] }));
  assert.equal(finding.severity, 'LOW');
});

test('SYMBOL_REMOVED: symbol present in both baseline and candidate is not flagged', () => {
  const s = symbol({ name: 'Foo', kind: 'class', file: 'src/foo.ts', exported: true });
  const baseline = snapshot({ files: [], symbols: [s] });
  const candidate = snapshot({ files: [], symbols: [s] });
  assert.deepEqual(detectSymbolRemoved(analysisInput({ baseline, candidate, fileChanges: [] })), []);
});

test('CRITICAL_MODULE_CHANGED: touching auth/ raises a finding, migrations are excluded', () => {
  const baseline = snapshot({ files: [] });
  const candidate = snapshot({ files: [] });
  const input = analysisInput({
    baseline, candidate,
    fileChanges: [
      { status: 'MODIFIED', path: 'apps/api/src/lib/auth.ts' },
      { status: 'MODIFIED', path: 'packages/database/prisma/migrations/x/migration.sql' }
    ]
  });
  const [finding] = detectCriticalModuleChanged(input);
  assert.equal(finding.severity, 'MEDIUM');
  assert.deepEqual(finding.files, ['apps/api/src/lib/auth.ts']);
});

test('CRITICAL_MODULE_CHANGED: 3+ sensitive files escalates to HIGH', () => {
  const baseline = snapshot({ files: [] });
  const candidate = snapshot({ files: [] });
  const input = analysisInput({
    baseline, candidate,
    fileChanges: [
      { status: 'MODIFIED', path: 'apps/api/src/lib/auth.ts' },
      { status: 'MODIFIED', path: 'apps/api/src/routes/secrets.ts' },
      { status: 'MODIFIED', path: 'apps/api/src/lib/rbac.ts' }
    ]
  });
  const [finding] = detectCriticalModuleChanged(input);
  assert.equal(finding.severity, 'HIGH');
});

test('TEST_COVERAGE_RISK: critical file changed without a related test change is a LOW warning-only signal', () => {
  const baseline = snapshot({ files: [] });
  const candidate = snapshot({ files: [] });
  const input = analysisInput({
    baseline, candidate,
    fileChanges: [{ status: 'MODIFIED', path: 'apps/api/src/lib/payments.ts' }]
  });
  const [finding] = detectTestCoverageRisk(input);
  assert.equal(finding.severity, 'LOW');
});

test('TEST_COVERAGE_RISK: no finding when a related test file changed too', () => {
  const baseline = snapshot({ files: [] });
  const candidate = snapshot({ files: [] });
  const input = analysisInput({
    baseline, candidate,
    fileChanges: [
      { status: 'MODIFIED', path: 'apps/api/src/lib/payments.ts' },
      { status: 'MODIFIED', path: 'apps/api/src/lib/payments.test.ts' }
    ]
  });
  assert.deepEqual(detectTestCoverageRisk(input), []);
});

test('MIGRATION_RISK: schema.prisma change is always MEDIUM (no destructive inference without diff content)', () => {
  const baseline = snapshot({ files: [] });
  const candidate = snapshot({ files: [] });
  const input = analysisInput({
    baseline, candidate,
    fileChanges: [{ status: 'MODIFIED', path: 'packages/database/prisma/schema.prisma' }]
  });
  const [finding] = detectMigrationRisk(input);
  assert.equal(finding.severity, 'MEDIUM');
});

test('DEPENDENCY_CHANGE: added/removed root dependency names raise it to MEDIUM', () => {
  const baseline = snapshot({ files: [], dependencies: ['fastify'] });
  const candidate = snapshot({ files: [], dependencies: ['fastify', 'axios'] });
  const input = analysisInput({
    baseline, candidate,
    fileChanges: [{ status: 'MODIFIED', path: 'package.json' }]
  });
  const [finding] = detectDependencyChange(input);
  assert.equal(finding.severity, 'MEDIUM');
  assert.deepEqual(finding.metadata?.added, ['axios']);
});

test('DEPENDENCY_CHANGE: lockfile-only change stays LOW', () => {
  const baseline = snapshot({ files: [], dependencies: ['fastify'] });
  const candidate = snapshot({ files: [], dependencies: ['fastify'] });
  const input = analysisInput({
    baseline, candidate,
    fileChanges: [{ status: 'MODIFIED', path: 'package-lock.json' }]
  });
  const [finding] = detectDependencyChange(input);
  assert.equal(finding.severity, 'LOW');
});

test('CONFIG_CHANGE: Dockerfile change is MEDIUM, generic config is LOW', () => {
  const baseline = snapshot({ files: [] });
  const candidate = snapshot({ files: [] });
  const dockerfileInput = analysisInput({ baseline, candidate, fileChanges: [{ status: 'MODIFIED', path: 'infra/production/Dockerfile.api' }] });
  assert.equal(detectConfigChange(dockerfileInput)[0].severity, 'MEDIUM');

  const nginxInput = analysisInput({ baseline, candidate, fileChanges: [{ status: 'MODIFIED', path: 'infra/nginx/devcloud.conf' }] });
  assert.equal(detectConfigChange(nginxInput)[0].severity, 'LOW');
});
