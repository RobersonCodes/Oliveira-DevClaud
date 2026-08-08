import type { ApiContract, ContractIntelligence, ContractIssue } from '@oliveira/contract-intelligence';

export type ContractGateSeverity = 'BLOCK' | 'WARN' | 'INFO';
export type ContractGateFindingKind =
  | 'ENDPOINT_REMOVED'
  | 'METHOD_CHANGED'
  | 'RESPONSE_FIELD_REMOVED'
  | 'REQUEST_SHAPE_CHANGED'
  | 'NEW_HIGH_RISK_ISSUE';

export type ContractGateFinding = {
  severity: ContractGateSeverity;
  kind: ContractGateFindingKind;
  endpoint?: string;
  message: string;
  details?: Record<string, unknown>;
};

export type ContractGateResult = {
  ok: boolean;
  baseline: ContractIntelligence['summary'];
  candidate: ContractIntelligence['summary'];
  blocking: ContractGateFinding[];
  warnings: ContractGateFinding[];
  info: ContractGateFinding[];
  generatedAt: string;
};

const endpointKey = (contract: Pick<ApiContract, 'method' | 'path'>) => `${contract.method.toUpperCase()} ${contract.path}`;
const issueKey = (issue: ContractIssue) => `${issue.kind}|${issue.producerId ?? ''}|${issue.consumerId ?? ''}|${issue.message}`;
const names = (items: Array<{name: string}>) => new Set(items.map(item => item.name));
const difference = (left: Set<string>, right: Set<string>) => [...left].filter(value => !right.has(value));

/**
 * Contract Gate is intentionally conservative: it blocks only high-confidence integration regressions.
 * Heuristic request/response inference is surfaced as warnings unless an existing consumed endpoint disappears
 * or a new HIGH risk contract issue is introduced.
 */
export function evaluateContractGate(baseline: ContractIntelligence, candidate: ContractIntelligence): ContractGateResult {
  const blocking: ContractGateFinding[] = [];
  const warnings: ContractGateFinding[] = [];
  const info: ContractGateFinding[] = [];

  const candidateByKey = new Map(candidate.contracts.map(contract => [endpointKey(contract), contract]));
  const candidateByPath = new Map<string, ApiContract[]>();
  for (const contract of candidate.contracts) {
    const list = candidateByPath.get(contract.path) ?? [];
    list.push(contract);
    candidateByPath.set(contract.path, list);
  }

  const baselineConsumers = new Set(baseline.consumers.map(consumer => `${consumer.method.toUpperCase()} ${consumer.path}`));

  for (const previous of baseline.contracts) {
    const key = endpointKey(previous);
    const next = candidateByKey.get(key);
    if (!next) {
      const samePath = candidateByPath.get(previous.path) ?? [];
      const consumed = baselineConsumers.has(key);
      if (samePath.length && !samePath.some(contract => contract.method === previous.method)) {
        const finding: ContractGateFinding = {
          severity: consumed ? 'BLOCK' : 'WARN',
          kind: 'METHOD_CHANGED',
          endpoint: key,
          message: `${key} deixou de existir com o mesmo método; agora o caminho expõe ${samePath.map(x => x.method).join('/')}.`,
          details: { consumed, candidateMethods: samePath.map(x => x.method) }
        };
        (consumed ? blocking : warnings).push(finding);
      } else {
        const finding: ContractGateFinding = {
          severity: consumed ? 'BLOCK' : 'WARN',
          kind: 'ENDPOINT_REMOVED',
          endpoint: key,
          message: `${key} existia na baseline e não foi detectado na integração candidata.`,
          details: { consumed }
        };
        (consumed ? blocking : warnings).push(finding);
      }
      continue;
    }

    const removedResponse = difference(names(previous.responseFields), names(next.responseFields));
    if (removedResponse.length) {
      warnings.push({
        severity: 'WARN',
        kind: 'RESPONSE_FIELD_REMOVED',
        endpoint: key,
        message: `${key} deixou de expor campos de resposta inferidos: ${removedResponse.join(', ')}.`,
        details: { removedFields: removedResponse }
      });
    }

    const previousRequest = names(previous.requestFields);
    const nextRequest = names(next.requestFields);
    const removedRequest = difference(previousRequest, nextRequest);
    const addedRequest = difference(nextRequest, previousRequest);
    if (removedRequest.length || addedRequest.length) {
      warnings.push({
        severity: 'WARN',
        kind: 'REQUEST_SHAPE_CHANGED',
        endpoint: key,
        message: `${key} teve alteração no request inferido.`,
        details: { removedFields: removedRequest, addedFields: addedRequest }
      });
    }
  }

  const baselineHigh = new Set(baseline.issues.filter(issue => issue.severity === 'HIGH').map(issueKey));
  for (const issue of candidate.issues.filter(issue => issue.severity === 'HIGH')) {
    if (baselineHigh.has(issueKey(issue))) continue;
    blocking.push({
      severity: 'BLOCK',
      kind: 'NEW_HIGH_RISK_ISSUE',
      message: `Novo risco de contrato: ${issue.message}`,
      details: { issueKind: issue.kind, producerId: issue.producerId, consumerId: issue.consumerId }
    });
  }

  const baselineKeys = new Set(baseline.contracts.map(endpointKey));
  const added = candidate.contracts.filter(contract => !baselineKeys.has(endpointKey(contract))).map(endpointKey);
  if (added.length) info.push({ severity: 'INFO', kind: 'REQUEST_SHAPE_CHANGED', message: `${added.length} endpoint(s) novo(s) detectado(s).`, details: { endpoints: added.slice(0, 30) } });

  return {
    ok: blocking.length === 0,
    baseline: baseline.summary,
    candidate: candidate.summary,
    blocking,
    warnings,
    info,
    generatedAt: new Date().toISOString()
  };
}
