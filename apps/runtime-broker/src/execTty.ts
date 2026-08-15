import type Docker from 'dockerode';
import type WebSocket from 'ws';
import { ExecTtyResizeMessageSchema, ExecTtyStartMessageSchema } from '@oliveira/runtime-broker-client';
import { auditLog } from './audit.js';

/**
 * The one genuinely interactive/bidirectional operation the broker exposes — everything else is
 * request/response. Used only by terminal-engine's `connect()` (a live tmux attach). The first
 * client message must be a `start` control frame (JSON text); after that, binary frames are raw
 * stdin bytes each direction and further JSON text frames are `resize` control messages.
 */
export async function handleExecTtySocket(socket: WebSocket, docker: Docker, containerId: string): Promise<void> {
  let exec: Docker.Exec | undefined;
  let stream: NodeJS.ReadWriteStream | undefined;
  let started = false;

  const fail = (message: string) => {
    if (socket.readyState === socket.OPEN) socket.close(1011, message.slice(0, 120));
  };

  socket.on('message', async (data: Buffer, isBinary: boolean) => {
    try {
      if (isBinary) {
        if (stream) stream.write(data);
        return;
      }
      const parsed = JSON.parse(data.toString('utf8'));
      if (!started) {
        const msg = ExecTtyStartMessageSchema.parse(parsed);
        started = true;
        const container = docker.getContainer(containerId);
        exec = await container.exec({
          Cmd: msg.cmd,
          WorkingDir: msg.workingDir,
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: true
        });
        stream = await exec.start({ hijack: true, stdin: true, Tty: true });
        await exec.resize({ w: msg.cols, h: msg.rows });
        stream.on('data', (chunk: Buffer) => {
          if (socket.readyState === socket.OPEN) socket.send(chunk, { binary: true });
        });
        stream.on('end', () => { if (socket.readyState === socket.OPEN) socket.close(1000, 'EXEC_ENDED'); });
        stream.on('error', () => fail('EXEC_STREAM_ERROR'));
      } else if (parsed.type === 'resize') {
        const msg = ExecTtyResizeMessageSchema.parse(parsed);
        if (exec) await exec.resize({ w: msg.cols, h: msg.rows });
      }
    } catch (err) {
      auditLog({ op: 'exec-tty', containerId, success: false, durationMs: 0, error: err instanceof Error ? err.message : String(err) });
      fail('EXEC_TTY_PROTOCOL_ERROR');
    }
  });

  socket.on('close', () => {
    if (stream && 'end' in stream && typeof stream.end === 'function') stream.end();
  });
}
