/**
 * WhatsApp CLI Daemon — entrypoint.
 *
 * Starts the IPC server, connects to WhatsApp, writes PID file.
 * All the heavy lifting is in connection.ts (Baileys) and handlers.ts (IPC).
 *
 * Usage: npx tsx lib/daemon.ts
 */
import fs from 'fs';
import net from 'net';
import pino from 'pino';

import { CONFIG_DIR, RUNTIME_DIR, SOCKET_PATH, PID_FILE, LOG_FILE } from './paths.js';
import { getDb } from './db.js';
import { connectWhatsApp, getSocket } from './connection.js';
import { handleCommand, initHandlers } from './handlers.js';
import type { IpcRequest } from './types.js';

// ─── Logger ────────────────────────────────────────────────

fs.mkdirSync(CONFIG_DIR, { recursive: true });

const logger = pino({
  level: process.env.WA_LOG_LEVEL || 'warn',
  transport: {
    targets: [
      { target: 'pino/file', options: { destination: LOG_FILE }, level: 'debug' },
      { target: 'pino/file', options: { destination: 1 }, level: 'info' },
    ],
  },
});

// ─── IPC Server ────────────────────────────────────────────

function startIpcServer(): net.Server {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  try { fs.unlinkSync(SOCKET_PATH); } catch {}

  const server = net.createServer((conn) => {
    let buffer = '';

    conn.on('data', (data) => {
      buffer += data.toString();

      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.trim()) continue;

        try {
          const req = JSON.parse(line) as IpcRequest;
          handleCommand(req).then(resp => {
            conn.write(JSON.stringify(resp) + '\n');
          }).catch(err => {
            conn.write(JSON.stringify({ id: req.id, error: String(err) }) + '\n');
          });
        } catch {
          conn.write(JSON.stringify({ id: 0, error: 'Invalid JSON' }) + '\n');
        }
      }
    });

    conn.on('error', () => {});
  });

  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o600);
    logger.info({ socket: SOCKET_PATH }, 'IPC server listening');
  });

  return server;
}

// ─── Lifecycle ─────────────────────────────────────────────

function registerShutdown(server: net.Server): void {
  const shutdown = () => {
    logger.info('Shutting down...');
    server.close();
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    try { fs.unlinkSync(PID_FILE); } catch {}
    try { getSocket()?.end(undefined); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ─── Entrypoint ────────────────────────────────────────────

async function main(): Promise<void> {
  // Ensure single instance
  try {
    const existingPid = fs.readFileSync(PID_FILE, 'utf-8').trim();
    try {
      process.kill(parseInt(existingPid), 0);
      logger.error(`Daemon already running (PID ${existingPid})`);
      process.exit(1);
    } catch {
      // Stale PID file — fine to proceed
    }
  } catch {}

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));

  getDb();
  logger.info('Database initialized');

  initHandlers(logger);
  const server = startIpcServer();
  registerShutdown(server);

  await connectWhatsApp(logger);

  logger.info({ pid: process.pid, socket: SOCKET_PATH }, 'Daemon started');
}

main().catch(err => {
  logger.error({ err }, 'Daemon failed to start');
  try { fs.unlinkSync(PID_FILE); } catch {}
  process.exit(1);
});
