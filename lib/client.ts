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

export function sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SOCKET_PATH)) {
      reject(new Error('Daemon not running. Start with: whatsapp daemon start'));
      return;
    }

    const id = ++requestId;
    const req: IpcRequest = { id, method, params };

    const conn = net.createConnection(SOCKET_PATH);
    let buffer = '';
    const timeout = setTimeout(() => {
      conn.destroy();
      reject(new Error('Command timed out (30s)'));
    }, 30000);

    conn.on('connect', () => {
      conn.write(JSON.stringify(req) + '\n');
    });

    conn.on('data', (data) => {
      buffer += data.toString();
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        clearTimeout(timeout);
        const line = buffer.slice(0, newlineIdx);
        conn.end();

        try {
          const resp = JSON.parse(line) as IpcResponse;
          if (resp.error) {
            reject(new Error(resp.error));
          } else {
            resolve(resp.result);
          }
        } catch {
          reject(new Error('Invalid response from daemon'));
        }
      }
    });

    conn.on('error', (err) => {
      clearTimeout(timeout);
      if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ||
          (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('Daemon not running. Start with: whatsapp daemon start'));
      } else {
        reject(err);
      }
    });
  });
}
