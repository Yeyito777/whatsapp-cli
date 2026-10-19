import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { AUTH_DIR, PID_FILE, RUNTIME_DIR, SOCKET_PATH } from '../lib/paths.js';
import { SESSION_LOCK_FILE } from '../lib/session-lock.js';

const cli = path.resolve(import.meta.dir, '../bin/whatsapp');
let server: net.Server | null = null;
let holder: ChildProcess | null = null;

afterEach(async () => {
  if (server) await new Promise<void>(done => server!.close(() => done()));
  server = null;
  holder?.kill();
  holder = null;
  for (const file of [SOCKET_PATH, PID_FILE, SESSION_LOCK_FILE]) fs.rmSync(file, { force: true });
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
});

function run(args: string[]) {
  return spawnSync(cli, args, { encoding: 'utf8', input: '', timeout: 20_000 });
}

/** Fake daemon answering `status` with the given connection state. */
async function daemonInState(connectionState: string): Promise<void> {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
  server = net.createServer(conn => conn.on('data', (data) => {
    const req = JSON.parse(data.toString().trim());
    conn.write(JSON.stringify({ id: req.id, result: { connection_state: connectionState } }) + '\n');
  }));
  await new Promise<void>(done => server!.listen(SOCKET_PATH, () => done()));
}

function writeLinkedCreds(): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  // Shape of a linked device: registered=false, me.id set.
  fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), JSON.stringify({ registered: false, me: { id: '15550009999:3@s.whatsapp.net' } }));
}

describe('login never opens a second connection on a live session', () => {
  test('login --help prints usage and exits without connecting', () => {
    const result = run(['login', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('usage:');
    expect(fs.existsSync(AUTH_DIR)).toBe(false);
  });

  test('unknown login arguments are refused', () => {
    const result = run(['login', '--frobnicate']);
    expect(result.status).toBe(2);
  });

  test('existing linked-device credentials count as already authenticated', () => {
    writeLinkedCreds();
    const result = run(['login']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Already authenticated');
    expect(result.stdout).not.toContain('QR');
  });

  test('login refuses while the daemon is connected or in conflict', async () => {
    await daemonInState('connected');
    const connected = await runAsync(['login']);
    expect(connected.code).toBe(0);
    expect(connected.stdout).toContain('Already linked');

    await new Promise<void>(done => server!.close(() => done()));
    fs.rmSync(SOCKET_PATH, { force: true });
    await daemonInState('conflict');
    const conflict = await runAsync(['login']);
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toContain('daemon restart');
  });

  test('login refuses while another whatsapp-cli process holds the session lock', async () => {
    holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '/x/lib/daemon.ts'], { stdio: 'ignore' });
    await new Promise(done => setTimeout(done, 200));
    fs.mkdirSync(path.dirname(SESSION_LOCK_FILE), { recursive: true });
    fs.writeFileSync(SESSION_LOCK_FILE, JSON.stringify({ pid: holder.pid, role: 'the WhatsApp daemon' }));
    const result = await runAsync(['login']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('in use by the WhatsApp daemon');
  });

  test('a stale lock from a dead process does not block', () => {
    fs.mkdirSync(path.dirname(SESSION_LOCK_FILE), { recursive: true });
    fs.writeFileSync(SESSION_LOCK_FILE, JSON.stringify({ pid: 999_999_9, role: 'the WhatsApp daemon' }));
    writeLinkedCreds();
    const result = run(['login']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Already authenticated');
  });
});

describe('logout and per-command help', () => {
  test('logout without --yes refuses and keeps credentials', () => {
    writeLinkedCreds();
    const result = run(['logout']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--yes');
    expect(fs.existsSync(path.join(AUTH_DIR, 'creds.json'))).toBe(true);
  });

  test('--help on read/messages prints usage instead of resolving "--help" as a chat', () => {
    for (const cmd of ['read', 'messages', 'typing', 'info', 'chats', 'sync']) {
      const result = run([cmd, '--help']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`whatsapp ${cmd}`);
    }
  });
});

function runAsync(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(cli, args, { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => done({ code, stdout, stderr }));
    child.stdin.end();
  });
}
