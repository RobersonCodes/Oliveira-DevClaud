import { describe, expect, it, vi } from 'vitest';
import { refreshRuntimeHeartbeats } from './heartbeats.js';

describe('runtime heartbeats', () => {
  it('touches only runtimes whose liveness probe succeeds', async () => {
    const at = new Date('2026-08-12T21:30:00.000Z');
    const touchWorkspace = vi.fn(async () => undefined);
    const touchAgent = vi.fn(async () => undefined);
    const touchOrchestration = vi.fn(async () => undefined);
    const result = await refreshRuntimeHeartbeats({
      workspaces: [{ id: 'ws-live', containerId: 'live' }, { id: 'ws-dead', containerId: 'dead' }],
      agents: [
        { id: 'agent-live', containerId: 'live', orchestrationId: 'orch-1' },
        { id: 'agent-dead', containerId: 'dead', orchestrationId: 'orch-2' }
      ],
      workspaceIsLive: async id => id === 'live',
      agentIsLive: async id => id === 'live',
      touchWorkspace, touchAgent, touchOrchestration
    }, at);

    expect(result).toEqual({ workspaces: 1, agents: 1, orchestrations: 1 });
    expect(touchWorkspace).toHaveBeenCalledWith('ws-live', at);
    expect(touchAgent).toHaveBeenCalledWith('agent-live', at);
    expect(touchOrchestration).toHaveBeenCalledWith('orch-1', at);
  });

  it('isolates probe failures and touches one orchestration once for multiple live agents', async () => {
    const touchAgent = vi.fn(async () => undefined);
    const touchOrchestration = vi.fn(async () => undefined);
    const result = await refreshRuntimeHeartbeats({
      workspaces: [{ id: 'broken', containerId: 'broken' }],
      agents: [
        { id: 'a', containerId: 'live', orchestrationId: 'orch' },
        { id: 'b', containerId: 'live', orchestrationId: 'orch' }
      ],
      workspaceIsLive: async () => { throw new Error('BROKER_DOWN'); },
      agentIsLive: async () => true,
      touchWorkspace: vi.fn(async () => undefined),
      touchAgent, touchOrchestration
    });

    expect(result).toEqual({ workspaces: 0, agents: 2, orchestrations: 1 });
    expect(touchAgent).toHaveBeenCalledTimes(2);
    expect(touchOrchestration).toHaveBeenCalledTimes(1);
  });
});
