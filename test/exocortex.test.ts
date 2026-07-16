import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import {
  sendExocortexIpcRequest,
  type ExocortexIpcCommand,
  type ExocortexIpcEvent,
} from '../lib/exocortex.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface TestCommand extends ExocortexIpcCommand {
  type: 'test_command';
  value: number;
}

interface TestResultEvent extends ExocortexIpcEvent {
  type: 'test_result';
  doubled: number;
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

describe('typed Exocortex IPC helper', () => {
  test('correlates a typed NDJSON response and ignores unrelated events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-exocortex-test-'));
    tempDirs.push(dir);
    const socketPath = path.join(dir, 'exocortexd.sock');
    let received: TestCommand | undefined;
    const server = net.createServer(connection => {
      let buffer = '';
      connection.on('data', chunk => {
        buffer += chunk.toString();
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        received = JSON.parse(buffer.slice(0, newline)) as TestCommand;
        connection.write(JSON.stringify({ type: 'unrelated_event', reqId: 'someone_else' }) + '\n');
        connection.write(JSON.stringify({ type: 'test_result', reqId: received.reqId, doubled: received.value * 2 }) + '\n');
      });
    });
    await listen(server, socketPath);

    try {
      const event = await sendExocortexIpcRequest<TestCommand, TestResultEvent>(
        { type: 'test_command', value: 21 },
        'test_result',
        1_000,
        socketPath,
      );
      expect(received?.type).toBe('test_command');
      expect(received?.reqId).toBeTruthy();
      expect(event.doubled).toBe(42);
      expect(event.reqId).toBe(received?.reqId);
    } finally {
      await close(server);
    }
  });

  test('rejects a correlated daemon error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-exocortex-test-'));
    tempDirs.push(dir);
    const socketPath = path.join(dir, 'exocortexd.sock');
    const server = net.createServer(connection => {
      connection.once('data', chunk => {
        const request = JSON.parse(chunk.toString().trim()) as TestCommand;
        connection.end(JSON.stringify({ type: 'error', reqId: request.reqId, message: 'not allowed' }) + '\n');
      });
    });
    await listen(server, socketPath);

    try {
      await expect(sendExocortexIpcRequest<TestCommand, TestResultEvent>(
        { type: 'test_command', value: 1 },
        'test_result',
        1_000,
        socketPath,
      )).rejects.toThrow('not allowed');
    } finally {
      await close(server);
    }
  });
});
