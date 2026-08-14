import Docker from 'dockerode';
import type { PruneWorkspaceResourcesResult } from '@oliveira/runtime-broker-client';
import {
  disconnectRelayFromWorkspaceNetwork,
  WORKSPACE_NETWORK_ID_LABEL,
  WORKSPACE_NETWORK_LABEL,
  WORKSPACE_NETWORK_VALUE
} from './network.js';
import {
  destroyContainer,
  type BrokerConfig,
  WORKSPACE_CONTAINER_ID_LABEL,
  WORKSPACE_CONTAINER_LABEL,
  WORKSPACE_CONTAINER_VALUE
} from './workspaceContainers.js';

const isDockerNotFound = (error: unknown) => typeof error === 'object' && error !== null
  && 'statusCode' in error && (error as { statusCode: unknown }).statusCode === 404;

function createdBefore(value: string | number | undefined, cutoffMs: number): boolean {
  if (value === undefined) return false;
  const createdMs = typeof value === 'number' ? value * 1_000 : Date.parse(value);
  return Number.isFinite(createdMs) && createdMs <= cutoffMs;
}

/**
 * Removes only resources that satisfy all three independent ownership checks:
 * exact DevCloud label, a workspace id absent from the PostgreSQL snapshot, and creation before
 * the grace cutoff. Networks are never forced while an unknown endpoint remains attached.
 */
export async function pruneOrphanedWorkspaceResources(
  docker: Docker,
  config: BrokerConfig,
  activeWorkspaceIds: ReadonlySet<string>,
  orphanedBefore: Date
): Promise<PruneWorkspaceResourcesResult> {
  const result: PruneWorkspaceResourcesResult = {
    removedContainers: [],
    removedNetworks: [],
    retainedWorkspaceIds: [],
    skippedRecent: 0,
    skippedAttachedNetworks: 0,
    failures: 0
  };
  const retainedWorkspaceIds = new Set<string>();
  const cutoffMs = orphanedBefore.getTime();

  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${WORKSPACE_CONTAINER_LABEL}=${WORKSPACE_CONTAINER_VALUE}`] })
  });
  for (const summary of containers) {
    const workspaceId = summary.Labels?.[WORKSPACE_CONTAINER_ID_LABEL];
    if (!workspaceId || activeWorkspaceIds.has(workspaceId)) continue;
    if (!createdBefore(summary.Created, cutoffMs)) {
      result.skippedRecent += 1;
      retainedWorkspaceIds.add(workspaceId);
      continue;
    }
    try {
      await destroyContainer(docker, config, summary.Id, workspaceId);
      result.removedContainers.push(summary.Id);
    } catch {
      // A partial failure is intentionally retained for the next sweep. One broken resource must
      // not prevent unrelated tenants' orphans from being reclaimed.
      result.failures += 1;
      retainedWorkspaceIds.add(workspaceId);
    }
  }

  const networks = await docker.listNetworks({
    filters: JSON.stringify({ label: [`${WORKSPACE_NETWORK_LABEL}=${WORKSPACE_NETWORK_VALUE}`] })
  });
  for (const summary of networks) {
    const workspaceId = summary.Labels?.[WORKSPACE_NETWORK_ID_LABEL];
    if (!workspaceId || activeWorkspaceIds.has(workspaceId)) continue;
    try {
      const network = docker.getNetwork(summary.Id);
      const before = await network.inspect();
      if (!createdBefore(before.Created, cutoffMs)) {
        result.skippedRecent += 1;
        retainedWorkspaceIds.add(workspaceId);
        continue;
      }
      await disconnectRelayFromWorkspaceNetwork(docker, before.Name, config.relayContainerId);
      const after = await network.inspect();
      if (Object.keys(after.Containers ?? {}).length > 0) {
        result.skippedAttachedNetworks += 1;
        retainedWorkspaceIds.add(workspaceId);
        continue;
      }
      await network.remove();
      result.removedNetworks.push(before.Name);
    } catch (error) {
      if (!isDockerNotFound(error)) {
        result.failures += 1;
        retainedWorkspaceIds.add(workspaceId);
      }
    }
  }

  result.retainedWorkspaceIds = [...retainedWorkspaceIds];
  return result;
}
