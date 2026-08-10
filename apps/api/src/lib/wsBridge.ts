import WebSocket, { type RawData } from 'ws';

export interface WsBridgeOptions {
  /** ws:// or wss:// URL of the upstream to relay to (e.g. a workspace container's IDE/preview port). */
  targetUrl: string;
  /** Max time to wait for the upstream connection to open before giving up. */
  connectTimeoutMs?: number;
  /** Max single-message size accepted from the upstream — mirrors the limit already enforced on the
   *  downstream (browser) side by @fastify/websocket's own `maxPayload`. */
  maxPayload?: number;
  /** Outgoing bytes allowed to queue on either socket before the connection is dropped as overloaded,
   *  instead of letting an unbounded amount of unsent data pile up in process memory. */
  maxBufferedBytes?: number;
}

// WebSocket close codes 1004/1005/1006/1015 are reserved by the protocol and MUST NOT be sent over
// the wire (ws's own `.close()` throws if given one) — they only ever describe an abnormal closure
// after the fact. When relaying a close from one side to the other, anything in that reserved range
// (or missing/out of the valid custom range) is remapped to 1011 (server error) as the closest
// honest "something went wrong upstream" signal.
const RESERVED_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);
const FALLBACK_CLOSE_CODE = 1011;
const MAX_CLOSE_REASON_BYTES = 123; // RFC 6455 §7.4.1 control-frame payload limit

function normalizeCloseCode(code: number | undefined): number {
  if (code === undefined || RESERVED_CLOSE_CODES.has(code) || code < 1000 || code > 4999) return FALLBACK_CLOSE_CODE;
  return code;
}

function truncateReason(reason: Buffer | string | undefined): Buffer {
  const buf = Buffer.isBuffer(reason) ? reason : Buffer.from(reason ?? '', 'utf8');
  return buf.subarray(0, MAX_CLOSE_REASON_BYTES);
}

function safeClose(socket: WebSocket, code: number | undefined, reason: Buffer | string | undefined) {
  if (socket.readyState !== WebSocket.OPEN) return;
  try { socket.close(normalizeCloseCode(code), truncateReason(reason)); } catch { socket.terminate(); }
}

/**
 * Relays an already-authenticated, already-upgraded downstream (browser) WebSocket to an upstream
 * WebSocket (typically a workspace container's IDE or preview server), bridging messages, close
 * codes and errors in both directions.
 *
 * All authorization (Origin, session, role, workspace/port ownership) is the caller's
 * responsibility and MUST happen before the downstream socket is ever accepted — this function only
 * concerns itself with the data relay once both ends exist. Resolves once the bridge tears down
 * (either side closed or errored); never rejects.
 */
export function bridgeWebSocket(client: WebSocket, options: WsBridgeOptions): Promise<void> {
  const maxBufferedBytes = options.maxBufferedBytes ?? 4 * 1024 * 1024;
  const maxPayload = options.maxPayload ?? 4 * 1024 * 1024;

  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const upstream = new WebSocket(options.targetUrl, { maxPayload });

    // The client can start sending the instant it's accepted, well before the upstream connection
    // (a fresh outbound TCP + WS handshake) finishes opening. Queue anything that arrives in that
    // window instead of only attaching the real relay listener after `open` — the earlier version
    // of this function did that, and silently dropped every message a fast/local client sent before
    // the upstream connected.
    const pending: Array<{ data: RawData; isBinary: boolean }> = [];
    const queueEarlyClientMessage = (data: RawData, isBinary: boolean) => { pending.push({ data, isBinary }); };
    client.on('message', queueEarlyClientMessage);

    const connectTimeout = setTimeout(() => {
      upstream.terminate();
      safeClose(client, 1013, 'UPSTREAM_CONNECT_TIMEOUT');
      finish();
    }, options.connectTimeoutMs ?? 10_000);

    // If the downstream disappears before the upstream even finishes connecting, there is nothing
    // left to bridge — abandon the upstream connection attempt instead of letting it dangle.
    const onEarlyClientTeardown = () => {
      clearTimeout(connectTimeout);
      upstream.terminate();
      finish();
    };
    client.once('close', onEarlyClientTeardown);
    client.once('error', onEarlyClientTeardown);

    // Errors before `open` mean the upstream never became usable — no relay to tear down, just fail
    // the downstream cleanly. This listener stops mattering once `open` fires (see below).
    const onEarlyUpstreamError = () => {
      clearTimeout(connectTimeout);
      client.removeListener('message', queueEarlyClientMessage);
      client.removeListener('close', onEarlyClientTeardown);
      client.removeListener('error', onEarlyClientTeardown);
      safeClose(client, 1011, 'UPSTREAM_UNAVAILABLE');
      finish();
    };
    upstream.once('error', onEarlyUpstreamError);

    upstream.once('open', () => {
      clearTimeout(connectTimeout);
      upstream.removeListener('error', onEarlyUpstreamError);
      client.removeListener('message', queueEarlyClientMessage);
      client.removeListener('close', onEarlyClientTeardown);
      client.removeListener('error', onEarlyClientTeardown);

      const onClientMessage = (data: RawData, isBinary: boolean) => {
        if (upstream.readyState !== WebSocket.OPEN) return;
        if (upstream.bufferedAmount > maxBufferedBytes) { safeClose(upstream, 1013, 'BACKPRESSURE'); safeClose(client, 1013, 'UPSTREAM_BACKPRESSURE'); return; }
        upstream.send(data, { binary: isBinary });
      };
      const onUpstreamMessage = (data: RawData, isBinary: boolean) => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount > maxBufferedBytes) { safeClose(client, 1013, 'BACKPRESSURE'); safeClose(upstream, 1013, 'CLIENT_BACKPRESSURE'); return; }
        client.send(data, { binary: isBinary });
      };
      const onClientClose = (code: number, reason: Buffer) => { safeClose(upstream, code, reason); finish(); };
      const onUpstreamClose = (code: number, reason: Buffer) => { safeClose(client, code, reason); finish(); };
      const onClientError = () => { upstream.terminate(); finish(); };
      const onUpstreamError = () => { safeClose(client, 1011, 'UPSTREAM_ERROR'); finish(); };

      for (const msg of pending) onClientMessage(msg.data, msg.isBinary);
      pending.length = 0;

      client.on('message', onClientMessage);
      upstream.on('message', onUpstreamMessage);
      client.once('close', onClientClose);
      upstream.once('close', onUpstreamClose);
      client.once('error', onClientError);
      upstream.on('error', onUpstreamError);
    });
  });
}
