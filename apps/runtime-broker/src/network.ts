import Docker from 'dockerode';
import { WORKSPACE_NETWORK_NAME_PREFIX } from '@oliveira/runtime-broker-client';

export const WORKSPACE_NETWORK_LABEL = 'dev.oliveira.devcloud';
export const WORKSPACE_NETWORK_ID_LABEL = 'dev.oliveira.workspace-id';
export const WORKSPACE_NETWORK_VALUE = 'workspace-network';
export { WORKSPACE_NETWORK_NAME_PREFIX };

const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 64);

/** Deterministic, idempotent-by-construction name — never derived from a random nonce. */
export function workspaceNetworkName(workspaceId: string): string {
  return `${WORKSPACE_NETWORK_NAME_PREFIX}${safeId(workspaceId)}`;
}

function isDockerError(err: unknown, statusCode: number): boolean {
  return typeof err === 'object' && err !== null && 'statusCode' in err && (err as { statusCode: unknown }).statusCode === statusCode;
}

/**
 * Creates (or reuses) the single Docker network a workspace's container is attached to. Isolation
 * relies on Docker's default behavior of not routing between distinct user-defined bridge networks
 * — no `Internal: true` here, since workspaces still need outbound internet access (git clone, npm
 * install, agent CLIs).
 */
export async function ensureWorkspaceNetwork(docker: Docker, workspaceId: string): Promise<string> {
  const name = workspaceNetworkName(workspaceId);
  try {
    await docker.getNetwork(name).inspect();
    return name;
  } catch (err) {
    if (!isDockerError(err, 404)) throw err;
  }
  try {
    await docker.createNetwork({
      Name: name,
      Driver: 'bridge',
      CheckDuplicate: true,
      Labels: {
        [WORKSPACE_NETWORK_LABEL]: WORKSPACE_NETWORK_VALUE,
        [WORKSPACE_NETWORK_ID_LABEL]: workspaceId
      }
    });
  } catch (err) {
    // Lost a create race against another process — the network now exists either way.
    if (!isDockerError(err, 409)) throw err;
  }
  return name;
}

/**
 * Connects the relay (the process proxying IDE/preview traffic — the `api` container in
 * production, identified by `RELAY_CONTAINER_NAME`) to a workspace's dedicated network so it can
 * reach the workspace container by IP. Unset in dev/CI, where the broker itself runs directly on
 * the host — the host can already route to any Docker bridge network's containers without an
 * explicit `network connect`.
 */
export async function connectRelayToWorkspaceNetwork(docker: Docker, networkName: string, relayContainerId: string | undefined): Promise<void> {
  if (!relayContainerId) return;
  try {
    await docker.getNetwork(networkName).connect({ Container: relayContainerId });
  } catch (err) {
    // Already connected (e.g. a retried create()) — not an error.
    if (!isDockerError(err, 403) && !isDockerError(err, 409)) throw err;
  }
}

export async function disconnectRelayFromWorkspaceNetwork(docker: Docker, networkName: string, relayContainerId: string | undefined): Promise<void> {
  if (!relayContainerId) return;
  try {
    await docker.getNetwork(networkName).disconnect({ Container: relayContainerId, Force: true });
  } catch (err) {
    if (!isDockerError(err, 404) && !isDockerError(err, 500)) throw err;
  }
}

/**
 * Removes a workspace's dedicated network. Only ever called with a name this module derived
 * deterministically from a workspaceId, so it can never target a network it does not own. Safe to
 * call after the workspace container itself is already gone; if the network still has endpoints
 * (e.g. a disconnect above failed) Docker rejects the removal and it is left for the orphan sweep
 * in `pruneOrphanedNetworks` rather than forced.
 */
export async function removeWorkspaceNetwork(docker: Docker, workspaceId: string): Promise<void> {
  const name = workspaceNetworkName(workspaceId);
  try {
    await docker.getNetwork(name).remove();
  } catch (err) {
    if (!isDockerError(err, 404) && !isDockerError(err, 403)) throw err;
  }
}

/**
 * Best-effort sweep for workspace networks left behind by a crash between container removal and
 * network removal (or an interrupted destroy()). Only removes networks carrying this module's own
 * label and that currently have zero containers attached — never a network in active use. Exposed
 * over `POST /v1/maintenance/prune-networks`, intended to be invoked periodically by the Fase 7
 * reaper; also safe to call ad hoc.
 */
export async function pruneOrphanedNetworks(docker: Docker): Promise<string[]> {
  const networks = await docker.listNetworks({ filters: JSON.stringify({ label: [`${WORKSPACE_NETWORK_LABEL}=${WORKSPACE_NETWORK_VALUE}`] }) });
  const removed: string[] = [];
  for (const summary of networks) {
    if (!summary.Name) continue;
    const containers = summary.Containers ? Object.keys(summary.Containers) : [];
    if (containers.length > 0) continue;
    try {
      await docker.getNetwork(summary.Name).remove();
      removed.push(summary.Name);
    } catch (err) {
      if (!isDockerError(err, 404) && !isDockerError(err, 403)) throw err;
    }
  }
  return removed;
}
