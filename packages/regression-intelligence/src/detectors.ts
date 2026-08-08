import type { RegressionAnalysisInput, RegressionFinding, RegressionSeverity } from './types.js';
import { isCriticalModuleFile, isDependencyManifest, isConfigFile, isHighImpactConfigFile, isMigrationFile, isTestFile } from './patterns.js';

const symbolKey = (s: { kind: string; name: string }) => `${s.kind}:${s.name}`;
const PUBLIC_SURFACE_KINDS = new Set(['class', 'interface', 'component', 'route']);

/** TEST_REMOVED — test files present in the baseline that are gone from the candidate. */
export function detectTestRemoved(input: RegressionAnalysisInput): RegressionFinding[] {
  const baselineTests = new Set(input.baseline.repository.files.filter(isTestFile));
  const candidateTests = new Set(input.candidate.repository.files.filter(isTestFile));
  const removed = [...baselineTests].filter(f => !candidateTests.has(f));
  if (!removed.length) return [];
  const ratio = baselineTests.size ? removed.length / baselineTests.size : 0;
  // A single deleted test in a small repository is meaningful, but it is not a
  // "significant share" event. Only apply the ratio escalation once there is a
  // representative baseline sample.
  const high = removed.length >= 5 || (baselineTests.size >= 5 && ratio >= 0.3);
  return [{
    id: 'test-removed',
    type: 'TEST_REMOVED',
    severity: high ? 'HIGH' : 'MEDIUM',
    confidence: 'HIGH',
    blocking: false,
    title: `${removed.length} arquivo(s) de teste removido(s)`,
    description: high
      ? `Uma parcela significativa dos testes da baseline (${removed.length} de ${baselineTests.size}) não existe mais no candidato.`
      : `${removed.length} arquivo(s) de teste presentes na baseline não foram encontrados no candidato.`,
    files: removed.slice(0, 50),
    metadata: { baselineTestFiles: baselineTests.size, candidateTestFiles: candidateTests.size, removedRatio: Number(ratio.toFixed(2)) }
  }];
}

/** ENDPOINT_REMOVED — reuses Contract Gate's own comparison instead of re-deriving it. */
export function detectEndpointRemoved(input: RegressionAnalysisInput): RegressionFinding[] {
  const relevantKinds = new Set(['ENDPOINT_REMOVED', 'METHOD_CHANGED']);
  const findings: RegressionFinding[] = [];
  for (const finding of [...input.contractGate.blocking, ...input.contractGate.warnings]) {
    if (!relevantKinds.has(finding.kind)) continue;
    const consumed = Boolean((finding.details as Record<string, unknown> | undefined)?.consumed);
    findings.push({
      id: `endpoint-removed-${finding.endpoint ?? findings.length}`,
      type: 'ENDPOINT_REMOVED',
      severity: consumed ? 'HIGH' : 'MEDIUM',
      confidence: 'HIGH',
      blocking: consumed,
      title: finding.endpoint ? `Endpoint alterado: ${finding.endpoint}` : 'Endpoint alterado',
      description: finding.message,
      files: [],
      endpoints: finding.endpoint ? [finding.endpoint] : [],
      metadata: { consumed, contractGateSeverity: finding.severity }
    });
  }
  return findings;
}

/** SYMBOL_REMOVED — regex-derived, so confidence stays MEDIUM and it never auto-blocks. */
export function detectSymbolRemoved(input: RegressionAnalysisInput): RegressionFinding[] {
  const candidateKeys = new Set(input.candidate.code.symbols.map(symbolKey));
  const findings: RegressionFinding[] = [];
  for (const symbol of input.baseline.code.symbols) {
    const key = symbolKey(symbol);
    if (candidateKeys.has(key)) continue;
    const exported = Boolean(symbol.exported);
    const publicSurface = PUBLIC_SURFACE_KINDS.has(symbol.kind);
    const severity: RegressionSeverity = exported && publicSurface ? 'HIGH' : exported ? 'MEDIUM' : 'LOW';
    findings.push({
      id: `symbol-removed-${key}-${symbol.file}`,
      type: 'SYMBOL_REMOVED',
      severity,
      confidence: 'MEDIUM',
      blocking: false,
      title: `${symbol.kind} removido: ${symbol.name}`,
      description: exported
        ? `${symbol.name} (${symbol.kind}) parecia exportado/público na baseline (${symbol.file}) e não foi encontrado no candidato.`
        : `${symbol.name} (${symbol.kind}) não foi encontrado no candidato (${symbol.file}).`,
      files: [symbol.file],
      symbols: [symbol.name],
      metadata: { kind: symbol.kind, exported }
    });
  }
  return findings.slice(0, 40);
}

/** CRITICAL_MODULE_CHANGED — sensitive paths touched (auth/security/payments/rbac/secrets/...). */
export function detectCriticalModuleChanged(input: RegressionAnalysisInput): RegressionFinding[] {
  const criticalFiles = input.fileChanges.filter(c => c.status !== 'DELETED' && isCriticalModuleFile(c.path)).map(c => c.path);
  if (!criticalFiles.length) return [];
  const severity: RegressionSeverity = criticalFiles.length >= 3 ? 'HIGH' : 'MEDIUM';
  return [{
    id: 'critical-module-changed',
    type: 'CRITICAL_MODULE_CHANGED',
    severity,
    confidence: 'HIGH',
    blocking: false,
    title: `${criticalFiles.length} arquivo(s) em módulo(s) sensível(is) alterado(s)`,
    description: `Alterações em áreas sensíveis (auth, security, payments, checkout, permissions, rbac, secrets, workspace-engine, docker-engine, agent-engine): ${criticalFiles.slice(0, 10).join(', ')}.`,
    files: criticalFiles.slice(0, 50)
  }];
}

function relatedTestExists(filePath: string, testPaths: string[]): boolean {
  const base = filePath.split('/').pop()?.replace(/\.[^./]+$/, '') ?? filePath;
  const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  return testPaths.some(t => t.includes(base) || (dir.length > 0 && t.startsWith(`${dir}/`)));
}

/**
 * TEST_COVERAGE_RISK — this project has no real coverage tool wired up, so this is deliberately
 * an indicator ("critical file changed with no related test file touched"), never a fabricated
 * coverage percentage. Always LOW severity, so it always lands in the report's warnings bucket.
 */
export function detectTestCoverageRisk(input: RegressionAnalysisInput): RegressionFinding[] {
  const changedTestPaths = input.fileChanges.filter(c => isTestFile(c.path)).map(c => c.path);
  const riskyFiles = input.fileChanges
    .filter(c => c.status !== 'DELETED' && !isTestFile(c.path) && (isCriticalModuleFile(c.path) || isMigrationFile(c.path)))
    .map(c => c.path)
    .filter(f => !relatedTestExists(f, changedTestPaths));
  if (!riskyFiles.length) return [];
  return [{
    id: 'test-coverage-risk',
    type: 'TEST_COVERAGE_RISK',
    severity: 'LOW',
    confidence: 'LOW',
    blocking: false,
    title: `${riskyFiles.length} arquivo(s) crítico(s) alterado(s) sem teste relacionado detectado`,
    description: `Indicador heurístico (não é cobertura real): ${riskyFiles.slice(0, 10).join(', ')}.`,
    files: riskyFiles.slice(0, 50)
  }];
}

/**
 * MIGRATION_RISK — schema.prisma/migrations touched. This package only receives file paths, not
 * diff content, so it deliberately never claims to detect destructive changes (DROP/TRUNCATE) —
 * doing so without reading the actual SQL would be exactly the kind of unfounded inference the spec
 * forbids. Always MEDIUM until a future version wires in real diff content (see docs/V2.5.md).
 */
export function detectMigrationRisk(input: RegressionAnalysisInput): RegressionFinding[] {
  const migrationFiles = input.fileChanges.filter(c => isMigrationFile(c.path)).map(c => c.path);
  if (!migrationFiles.length) return [];
  return [{
    id: 'migration-risk',
    type: 'MIGRATION_RISK',
    severity: 'MEDIUM',
    confidence: 'MEDIUM',
    blocking: false,
    title: `${migrationFiles.length} arquivo(s) de schema/migration alterado(s)`,
    description: `Alterações em schema.prisma ou migrations exigem revisão manual: ${migrationFiles.slice(0, 10).join(', ')}.`,
    files: migrationFiles.slice(0, 50)
  }];
}

/** DEPENDENCY_CHANGE — manifest/lockfile touched; names added/removed derived from the root package.json. */
export function detectDependencyChange(input: RegressionAnalysisInput): RegressionFinding[] {
  const manifestFiles = input.fileChanges.filter(c => isDependencyManifest(c.path)).map(c => c.path);
  if (!manifestFiles.length) return [];
  const baselineDeps = new Set([...input.baseline.repository.dependencies, ...input.baseline.repository.devDependencies]);
  const candidateDeps = new Set([...input.candidate.repository.dependencies, ...input.candidate.repository.devDependencies]);
  const added = [...candidateDeps].filter(d => !baselineDeps.has(d));
  const removed = [...baselineDeps].filter(d => !candidateDeps.has(d));
  const namedChange = added.length > 0 || removed.length > 0;
  return [{
    id: 'dependency-change',
    type: 'DEPENDENCY_CHANGE',
    severity: namedChange ? 'MEDIUM' : 'LOW',
    confidence: namedChange ? 'HIGH' : 'MEDIUM',
    blocking: false,
    title: namedChange ? `Dependências alteradas (${added.length} adicionada(s), ${removed.length} removida(s))` : 'Manifesto/lockfile de dependências alterado',
    description: namedChange
      ? `Pacotes adicionados: ${added.slice(0, 10).join(', ') || '—'}. Pacotes removidos: ${removed.slice(0, 10).join(', ') || '—'}.`
      : `${manifestFiles.join(', ')} foi alterado, mas a lista de dependências do package.json raiz não mudou (provável só lockfile/versão).`,
    files: manifestFiles.slice(0, 50),
    metadata: { added, removed }
  }];
}

/** CONFIG_CHANGE — Dockerfile/compose/nginx/CI/env.example touched. */
export function detectConfigChange(input: RegressionAnalysisInput): RegressionFinding[] {
  const configFiles = input.fileChanges.filter(c => c.status !== 'DELETED' && isConfigFile(c.path)).map(c => c.path);
  if (!configFiles.length) return [];
  const highImpact = configFiles.some(isHighImpactConfigFile);
  return [{
    id: 'config-change',
    type: 'CONFIG_CHANGE',
    severity: highImpact ? 'MEDIUM' : 'LOW',
    confidence: 'HIGH',
    blocking: false,
    title: `${configFiles.length} arquivo(s) de configuração/deploy alterado(s)`,
    description: `Alterações em infraestrutura/deploy: ${configFiles.slice(0, 10).join(', ')}.`,
    files: configFiles.slice(0, 50)
  }];
}

export const DETECTORS = [
  detectTestRemoved,
  detectEndpointRemoved,
  detectSymbolRemoved,
  detectCriticalModuleChanged,
  detectTestCoverageRisk,
  detectMigrationRisk,
  detectDependencyChange,
  detectConfigChange
];
