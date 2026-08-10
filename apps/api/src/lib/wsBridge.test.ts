import net from 'node:net';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { bridgeWebSocket } from './wsBridge.js';

const openServers: Array<{ close: () => void }> = [];
afterEach(() => { while (openServers.length) openServers.pop()!.close(); });

function listen(wss: WebSocketServer): Promise<number> {
  openServers.push({ close: () => wss.close() });
  return new Promise(resolve => wss.once('listening', () => resolve((wss.address() as { port: number }).port)));
}

/** A real WebSocket server that relays every downstream connection through bridgeWebSocket to `targetUrl`. */
async function startBridgedServer(targetUrl: string, opts: Partial<{ connectTimeoutMs: number; maxPayload: number; maxBufferedBytes: number }> = {}): Promise<number> {
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', client => { void bridgeWebSocket(client, { targetUrl, ...opts }); });
  return listen(wss);
}

function connectClient(port: number): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const client = new WsClient(`ws://127.0.0.1:${port}`);
    client.once('open', () => resolve(client));
    client.once('error', reject);
  });
}

function nextMessage(socket: WsClient): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise(resolve => socket.once('message', (data: Buffer, isBinary: boolean) => resolve({ data, isBinary })));
}

function nextClose(socket: WsClient): Promise<{ code: number; reason: string }> {
  return new Promise(resolve => socket.once('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() })));
}

describe('bridgeWebSocket — real upstream WebSocket echo server', () => {
  it('relays a text message downstream -> upstream -> downstream, even sent immediately on open (regression: early messages used to be silently dropped while the upstream was still connecting)', async () => {
    const echo = new WebSocketServer({ port: 0 });
    echo.on('connection', ws => ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary })));
    const echoPort = await listen(echo);
    const bridgedPort = await startBridgedServer(`ws://127.0.0.1:${echoPort}`);

    const client = await connectClient(bridgedPort);
    const reply = nextMessage(client);
    // Sent the instant the downstream socket opens — on localhost this reliably races ahead of the
    // bridge's own outbound connection to the upstream, which is exactly the window that used to
    // lose messages before they were queued.
    client.send('hello over the bridge');
    const { data, isBinary } = await reply;
    expect(isBinary).toBe(false);
    expect(data.toString('utf8')).toBe('hello over the bridge');
    client.close();
  });

  it('relays a binary message downstream -> upstream -> downstream, byte-for-byte', async () => {
    const echo = new WebSocketServer({ port: 0 });
    echo.on('connection', ws => ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary })));
    const echoPort = await listen(echo);
    const bridgedPort = await startBridgedServer(`ws://127.0.0.1:${echoPort}`);

    const client = await connectClient(bridgedPort);
    const reply = nextMessage(client);
    const payload = Buffer.from([0, 1, 2, 254, 255, 42]);
    client.send(payload, { binary: true });
    const { data, isBinary } = await reply;
    expect(isBinary).toBe(true);
    expect(Buffer.compare(data, payload)).toBe(0);
    client.close();
  });

  it('relays a message upstream -> downstream initiated by the upstream side', async () => {
    const echo = new WebSocketServer({ port: 0 });
    echo.on('connection', ws => ws.send('greetings from the workspace container'));
    const echoPort = await listen(echo);
    const bridgedPort = await startBridgedServer(`ws://127.0.0.1:${echoPort}`);

    const client = await connectClient(bridgedPort);
    const { data } = await nextMessage(client);
    expect(data.toString('utf8')).toBe('greetings from the workspace container');
    client.close();
  });

  it('propagates a normal close code and reason from upstream to the downstream client', async () => {
    const upstreamCloser = new WebSocketServer({ port: 0 });
    upstreamCloser.on('connection', ws => ws.close(4001, 'custom-upstream-close'));
    const upstreamPort = await listen(upstreamCloser);
    const bridgedPort = await startBridgedServer(`ws://127.0.0.1:${upstreamPort}`);

    const client = await connectClient(bridgedPort);
    const closed = await nextClose(client);
    expect(closed.code).toBe(4001);
    expect(closed.reason).toBe('custom-upstream-close');
  });

  it('propagates a close initiated by the downstream client to the upstream', async () => {
    const upstream = new WebSocketServer({ port: 0 });
    const upstreamClosed = new Promise<{ code: number; reason: string }>(resolve => {
      upstream.on('connection', ws => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    });
    const upstreamPort = await listen(upstream);
    const bridgedPort = await startBridgedServer(`ws://127.0.0.1:${upstreamPort}`);

    const client = await connectClient(bridgedPort);
    client.close(4002, 'client-initiated-close');
    const closed = await upstreamClosed;
    expect(closed.code).toBe(4002);
    expect(closed.reason).toBe('client-initiated-close');
  });

  it('remaps a reserved/abnormal upstream close code (1006, from an abrupt terminate) to a valid one downstream', async () => {
    const upstream = new WebSocketServer({ port: 0 });
    upstream.on('connection', ws => ws.terminate()); // abrupt — no close frame, reported as 1006 on our end
    const upstreamPort = await listen(upstream);
    const bridgedPort = await startBridgedServer(`ws://127.0.0.1:${upstreamPort}`);

    const client = await connectClient(bridgedPort);
    const closed = await nextClose(client);
    expect(closed.code).not.toBe(1006);
    expect(closed.code).toBe(1011);
  });

  it('closes the downstream client if the upstream refuses the connection outright', async () => {
    const stub = net.createServer();
    await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve));
    const deadPort = (stub.address() as net.AddressInfo).port;
    stub.close(); // frees the port immediately — nothing will ever be listening on it

    const bridgedPort = await startBridgedServer(`ws://127.0.0.1:${deadPort}`);
    const client = await connectClient(bridgedPort);
    const closed = await nextClose(client);
    expect(closed.code).toBe(1011);
  });

  it('closes the downstream client if the upstream never completes its handshake within connectTimeoutMs', async () => {
    const stub = net.createServer(socket => { socket.on('data', () => {}); }); // accepts, never responds
    await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve));
    const stubPort = (stub.address() as net.AddressInfo).port;
    openServers.push({ close: () => stub.close() });

    const bridgedPort = await startBridgedServer(`ws://127.0.0.1:${stubPort}`, { connectTimeoutMs: 300 });
    const client = await connectClient(bridgedPort);
    const start = Date.now();
    const closed = await nextClose(client);
    expect(closed.code).toBe(1013);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it('enforces maxPayload against the upstream: an oversized upstream message closes the connection instead of being relayed', async () => {
    const upstream = new WebSocketServer({ port: 0 });
    upstream.on('connection', ws => ws.send(Buffer.alloc(1024, 1))); // 1KB, larger than the 16-byte limit below
    const upstreamPort = await listen(upstream);
    const bridgedPort = await startBridgedServer(`ws://127.0.0.1:${upstreamPort}`, { maxPayload: 16 });

    const client = await connectClient(bridgedPort);
    const closed = await nextClose(client);
    // ws's own oversized-message handling closes with 1009 (message too big); either way it must
    // not silently deliver the oversized payload downstream.
    expect([1009, 1011]).toContain(closed.code);
  });
});

describe('bridgeWebSocket — backpressure guard (deterministic, via a controllable fake downstream)', () => {
  // `bufferedAmount` reflects real, live OS socket buffer state — genuinely overflowing it on a fast
  // loopback connection is not a reliable thing to assert timing around. This exercises the guard
  // logic itself deterministically: a fake "client" whose bufferedAmount we control directly, wired
  // to a real upstream, proves the relay refuses to keep pushing data at an overloaded receiver
  // instead of buffering it unboundedly in process memory.
  class FakeClient extends EventEmitter {
    readyState: number = WsClient.OPEN;
    bufferedAmount: number;
    sent: unknown[] = [];
    closedWith?: { code: number; reason: string };
    constructor(bufferedAmount: number) { super(); this.bufferedAmount = bufferedAmount; }
    send(data: unknown) { this.sent.push(data); }
    close(code?: number, reason?: Buffer | string) {
      this.readyState = WsClient.CLOSED;
      this.closedWith = { code: code ?? 1000, reason: (reason ?? '').toString() };
      this.emit('close', code, Buffer.from(reason ?? ''));
    }
  }

  it('drops the relay instead of forwarding when the downstream client is already overloaded', async () => {
    const upstream = new WebSocketServer({ port: 0 });
    const upstreamPort = await listen(upstream);
    const upstreamConnected = new Promise<import('ws').WebSocket>(resolve => upstream.once('connection', resolve));

    const fakeClient = new FakeClient(10 * 1024 * 1024); // already 10MB queued — way over any sane limit
    const bridgeDone = bridgeWebSocket(fakeClient as unknown as import('ws').WebSocket, {
      targetUrl: `ws://127.0.0.1:${upstreamPort}`,
      maxBufferedBytes: 1024 * 1024
    });

    const upstreamSocket = await upstreamConnected;
    upstreamSocket.send('this should not reach the overloaded client');
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(fakeClient.sent).toHaveLength(0);
    expect(fakeClient.closedWith?.code).toBe(1013);
    await bridgeDone;
  });
});
