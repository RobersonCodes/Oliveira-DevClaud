import { DETECTORS } from './detectors.js';
import { calculateRisk } from './riskEngine.js';
import { isCriticalModuleFile, isTestFile } from './patterns.js';
import type {
  BaselineMetrics,
  GateSignal,
  IntelligenceSnapshot,
  RegressionAnalysisInput,
  RegressionChanges,
  RegressionFinding,
  RegressionReport,
  RiskSignals
} from './types.js';

export * from './types.js';
export * from './patterns.js';
export * from './detectors.js';
export * from './riskEngine.js';

const endpointKey = (contract: { method: string; path: string }) => `${contract.method.toUpperCase()} ${contract.path}`;
const symbolKey = (s: { kind: string; name: string }) => `${s.kind}:${s.name}`;

function buildMetrics(snapshot: IntelligenceSnapshot): BaselineMetrics {
  return {
    sourceFileCount: snapshot.repository.sourceFiles,
    testFileCount: snapshot.repository.testFiles,
    endpointCount: snapshot.code.endpoints.length,
    symbolCount: snapshot.code.symbols.length,
    classCount: snapshot.code.summary.classes,
    functionCount: snapshot.code.summary.functions,
    componentCount: snapshot.code.summary.components,
    consumerCount: snapshot.contracts.consumers.length,
    contractCount: snapshot.contracts.contracts.length
  };
}

function buildChanges(input: RegressionAnalysisInput): RegressionChanges {
  const added = input.fileChanges.filter(c => c.status === 'ADDED').map(c => c.path);
  const modified = input.fileChanges.filter(c => c.status === 'MODIFIED' || c.status === 'RENAMED').map(c => c.path);
  const deleted = input.fileChanges.filter(c => c.status === 'DELETED').map(c => c.path);

  const baselineEndpointKeys = new Set(input.baseline.contracts.contracts.map(endpointKey));
  const candidateEndpointKeys = new Set(input.candidate.contracts.contracts.map(endpointKey));
  const baselineSymbolKeys = new Set(input.baseline.code.symbols.map(symbolKey));
  const candidateSymbolKeys = new Set(input.candidate.code.symbols.map(symbolKey));

  const modifiedCriticalFiles = new Set(
    input.fileChanges.filter(c => c.status === 'MODIFIED' && isCriticalModuleFile(c.path)).map(c => c.path)
  );
  const criticalSymbolsModified = [...new Set(
    input.candidate.code.symbols.filter(s => modifiedCriticalFiles.has(s.file)).map(s => s.name)
  )].slice(0, 50);

  return {
    filesAdded: added,
    filesModified: modified,
    filesDeleted: deleted,
    testsAdded: added.filter(isTestFile),
    testsDeleted: deleted.filter(isTestFile),
    endpointsAdded: [...candidateEndpointKeys].filter(k => !baselineEndpointKeys.has(k)),
    endpointsRemoved: [...baselineEndpointKeys].filter(k => !candidateEndpointKeys.has(k)),
    symbolsAdded: [...candidateSymbolKeys].filter(k => !baselineSymbolKeys.has(k)),
    symbolsRemoved: [...baselineSymbolKeys].filter(k => !candidateSymbolKeys.has(k)),
    criticalSymbolsModified
  };
}

function deriveRiskSignals(contractGateBlocked: boolean, gates: GateSignal[], conflicts: string[]): RiskSignals {
  const failed = (needle: RegExp) => gates.some(g => needle.test(g.command) && !g.ok);
  return {
    contractGateBlocked,
    testsFailed: failed(/\btest\b/i),
    buildFailed: failed(/\bbuild\b/i),
    lintFailed: failed(/\blint\b/i),
    gitConflict: conflicts.length > 0
  };
}

function summarize(report: Pick<RegressionReport, 'riskLevel' | 'riskScore' | 'regressions' | 'warnings' | 'blocking'>): string {
  const high = report.regressions.filter(f => f.severity === 'HIGH').length;
  const medium = report.regressions.filter(f => f.severity === 'MEDIUM').length;
  const parts = [`MERGE RISK: ${report.riskLevel} (${report.riskScore}/100)`];
  if (high || medium) parts.push(`${high} regressão(ões) HIGH, ${medium} MEDIUM`);
  if (report.warnings.length) parts.push(`${report.warnings.length} warning(s)`);
  parts.push(report.blocking ? 'merge bloqueado automaticamente' : 'sem bloqueio automático');
  return parts.join(' — ');
}

export function buildRegressionReport(input: RegressionAnalysisInput): RegressionReport {
  const allFindings: RegressionFinding[] = DETECTORS.flatMap(detector => detector(input));
  const regressions = allFindings.filter(f => f.severity !== 'LOW').sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const warnings = allFindings.filter(f => f.severity === 'LOW');

  const signals = deriveRiskSignals(!input.contractGate.ok, input.gates, input.conflicts);
  const risk = calculateRisk(allFindings, signals);

  const partial = {
    riskLevel: risk.level,
    riskScore: risk.score,
    regressions,
    warnings,
    blocking: risk.blocking
  };

  return {
    generatedAt: new Date().toISOString(),
    baseline: buildMetrics(input.baseline),
    candidate: buildMetrics(input.candidate),
    changes: buildChanges(input),
    regressions,
    warnings,
    riskScore: risk.score,
    riskLevel: risk.level,
    blocking: risk.blocking,
    blockingReasons: risk.blockingReasons,
    summary: summarize(partial)
  };
}

function severityRank(severity: RegressionFinding['severity']): number {
  return severity === 'HIGH' ? 2 : severity === 'MEDIUM' ? 1 : 0;
}
