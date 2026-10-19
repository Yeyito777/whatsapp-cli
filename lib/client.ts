/**
 * IPC client — sends commands to the daemon over Unix socket.
 */
import fs from 'fs';
import net from 'net';

import { SOCKET_PATH, PID_FILE } from './paths.js';
import type { IpcRequest, IpcResponse } from './types.js';

let requestId = 0;

export function isDaemonRunning(): boolean {
  try {
    const pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
    process.kill(parseInt(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export function getDaemonPid(): number | null {
  try {
    const pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
    process.kill(parseInt(pid), 0);
    return parseInt(pid);
  } catch {
    return null;
  }
}

/**
 * The request reached the daemon but no reply came back (timeout, daemon
 * restart). For sends this means the outcome is unknown, not that it failed.
 */
export class IpcOutcomeUnknownError extends Error {}

export const DEFAULT_IPC_TIMEOUT_MS = 30_000;

export function sendCommand(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = DEFAULT_IPC_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SOCKET_PATH)) {
      reject(new Error('Daemon not running. Start with: whatsapp daemon start'));
      return;
    }

    const id = ++requestId;
    const req: IpcRequest = { id, method, params };

    const conn = net.createConnection(SOCKET_PATH);
    let buffer = '';
    let written = false;
    let settled = false;
    const finish = (err: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      conn.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      finish(written
        ? new IpcOutcomeUnknownError(`No reply from the WhatsApp daemon within ${Math.round(timeoutMs / 1000)}s`)
        : new Error(`Could not reach the WhatsApp daemon within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    conn.on('connect', () => {
      conn.write(JSON.stringify(req) + '\n', () => { written = true; });
    });

    conn.on('data', (data) => {
      buffer += data.toString();
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return;
      const line = buffer.slice(0, newlineIdx);
      try {
        const resp = JSON.parse(line) as IpcResponse;
        if (resp.error) finish(new Error(resp.error));
        else finish(null, resp.result);
      } catch {
        finish(new IpcOutcomeUnknownError('Invalid response from daemon'));
      }
    });

    conn.on('close', () => {
      if (written) finish(new IpcOutcomeUnknownError('The WhatsApp daemon closed the connection before replying'));
      else finish(new Error('Daemon not running. Start with: whatsapp daemon start'));
    });

    conn.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (!written && (code === 'ECONNREFUSED' || code === 'ENOENT')) {
        finish(new Error('Daemon not running. Start with: whatsapp daemon start'));
      } else if (written) {
        finish(new IpcOutcomeUnknownError(`Lost the connection to the WhatsApp daemon (${err.message})`));
      } else {
        finish(err);
      }
    });
  });
}
