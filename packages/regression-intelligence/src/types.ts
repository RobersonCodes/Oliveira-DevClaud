import type { RepositoryIntelligence } from '@oliveira/repository-intelligence';
import type { CodeIntelligence } from '@oliveira/code-intelligence';
import type { ContractIntelligence } from '@oliveira/contract-intelligence';
import type { ContractGateResult } from '@oliveira/contract-gate';

export type FileChangeStatus = 'ADDED' | 'MODIFIED' | 'DELETED' | 'RENAMED';
export type FileChange = { status: FileChangeStatus; path: string; previousPath?: string };

export type RegressionSeverity = 'LOW' | 'MEDIUM' | 'HIGH';
export type RegressionConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type RegressionFindingType =
  | 'TEST_REMOVED'
  | 'ENDPOINT_REMOVED'
  | 'SYMBOL_REMOVED'
  | 'CRITICAL_MODULE_CHANGED'
  | 'TEST_COVERAGE_RISK'
  | 'MIGRATION_RISK'
  | 'DEPENDENCY_CHANGE'
  | 'CONFIG_CHANGE';

export type RegressionFinding = {
  id: string;
  type: RegressionFindingType;
  severity: RegressionSeverity;
  confidence: RegressionConfidence;
  /** Whether this specific finding is strong enough evidence to contribute to an automatic block. */
  blocking: boolean;
  title: string;
  description: string;
  files: string[];
  symbols?: string[];
  endpoints?: string[];
  metadata?: Record<string, unknown>;
};

export type IntelligenceSnapshot = {
  repository: RepositoryIntelligence;
  code: CodeIntelligence;
  contracts: ContractIntelligence;
};

export type BaselineMetrics = {
  sourceFileCount: number;
  testFileCount: number;
  endpointCount: number;
  symbolCount: number;
  classCount: number;
  functionCount: number;
  componentCount: number;
  consumerCount: number;
  contractCount: number;
};

export type CandidateMetrics = BaselineMetrics;

export type RegressionChanges = {
  filesAdded: string[];
  filesModified: string[];
  filesDeleted: string[];
  testsAdded: string[];
  testsDeleted: string[];
  endpointsAdded: string[];
  endpointsRemoved: string[];
  symbolsAdded: string[];
  symbolsRemoved: string[];
  criticalSymbolsModified: string[];
};

export type GateSignal = { command: string; ok: boolean; exitCode: number };

export type RiskSignals = {
  contractGateBlocked: boolean;
  testsFailed: boolean;
  buildFailed: boolean;
  lintFailed: boolean;
  gitConflict: boolean;
};

export type RiskAssessment = {
  score: number;
  level: RiskLevel;
  blocking: boolean;
  blockingReasons: string[];
};

export type RegressionReport = {
  generatedAt: string;
  baseline: BaselineMetrics;
  candidate: CandidateMetrics;
  changes: RegressionChanges;
  regressions: RegressionFinding[];
  warnings: RegressionFinding[];
  riskScore: number;
  riskLevel: RiskLevel;
  blocking: boolean;
  blockingReasons: string[];
  summary: string;
};

export type RegressionAnalysisInput = {
  baseline: IntelligenceSnapshot;
  candidate: IntelligenceSnapshot;
  contractGate: ContractGateResult;
  fileChanges: FileChange[];
  gates: GateSignal[];
  conflicts: string[];
};
