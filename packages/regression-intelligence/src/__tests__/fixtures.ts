import type { RepositoryIntelligence } from '@oliveira/repository-intelligence';
import type { CodeIntelligence, CodeSymbol } from '@oliveira/code-intelligence';
import type { ContractIntelligence, ApiContract, ApiConsumer } from '@oliveira/contract-intelligence';
import type { ContractGateResult } from '@oliveira/contract-gate';
import type { FileChange, IntelligenceSnapshot, RegressionAnalysisInput } from '../types.js';

export function repository(overrides: Partial<RepositoryIntelligence> & { files: string[] }): RepositoryIntelligence {
  return {
    generatedAt: new Date().toISOString(),
    root: '/workspace/repository',
    tree: [],
    topLevelDirectories: [],
    manifests: ['package.json'],
    scripts: {},
    dependencies: [],
    devDependencies: [],
    architectureHints: [],
    testFiles: overrides.files.filter(f => /\.test\.[^.]+$/.test(f)).length,
    routeFiles: 0,
    sourceFiles: overrides.files.length,
    git: { branch: 'main', head: 'HEAD', changedFiles: [], clean: true, recentCommits: [] },
    warnings: [],
    ...overrides
  };
}

export function code(overrides: Partial<CodeIntelligence> & { symbols?: CodeSymbol[] }): CodeIntelligence {
  const symbols = overrides.symbols ?? [];
  return {
    generatedAt: new Date().toISOString(),
    filesAnalyzed: 0,
    symbols,
    edges: [],
    endpoints: [],
    summary: {
      classes: symbols.filter(s => s.kind === 'class').length,
      functions: symbols.filter(s => s.kind === 'function' || s.kind === 'method').length,
      components: symbols.filter(s => s.kind === 'component').length,
      routes: 0,
      models: 0
    },
    warnings: [],
    ...overrides
  };
}

export function contracts(overrides: Partial<ContractIntelligence> & { contracts?: ApiContract[]; consumers?: ApiConsumer[] }): ContractIntelligence {
  const c = overrides.contracts ?? [];
  const consumers = overrides.consumers ?? [];
  return {
    generatedAt: new Date().toISOString(),
    filesAnalyzed: 0,
    contracts: c,
    consumers,
    issues: [],
    summary: { contracts: c.length, consumers: consumers.length, issues: 0, highRisk: 0 },
    warnings: [],
    ...overrides
  };
}

export function contractGate(overrides: Partial<ContractGateResult> = {}): ContractGateResult {
  return {
    ok: true,
    baseline: { contracts: 0, consumers: 0, issues: 0, highRisk: 0 },
    candidate: { contracts: 0, consumers: 0, issues: 0, highRisk: 0 },
    blocking: [],
    warnings: [],
    info: [],
    generatedAt: new Date().toISOString(),
    ...overrides
  };
}

export function snapshot(input: { files: string[]; symbols?: CodeSymbol[]; apiContracts?: ApiContract[]; consumers?: ApiConsumer[]; dependencies?: string[]; devDependencies?: string[] }): IntelligenceSnapshot {
  return {
    repository: repository({ files: input.files, dependencies: input.dependencies ?? [], devDependencies: input.devDependencies ?? [] }),
    code: code({ symbols: input.symbols ?? [] }),
    contracts: contracts({ contracts: input.apiContracts ?? [], consumers: input.consumers ?? [] })
  };
}

export function analysisInput(overrides: Partial<RegressionAnalysisInput> & { baseline: IntelligenceSnapshot; candidate: IntelligenceSnapshot; fileChanges: FileChange[] }): RegressionAnalysisInput {
  return {
    contractGate: contractGate(),
    gates: [],
    conflicts: [],
    ...overrides
  };
}

export function symbol(overrides: Partial<CodeSymbol> & { name: string; kind: CodeSymbol['kind']; file: string }): CodeSymbol {
  return { id: `${overrides.file}:${overrides.kind}:${overrides.name}`, line: 1, ...overrides };
}
