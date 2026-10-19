import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import { resolve } from 'path';

import { IpcOutcomeUnknownError, sendCommand } from '../lib/client.js';
import { PID_FILE, RUNTIME_DIR, SOCKET_PATH } from '../lib/paths.js';

const cli = resolve(import.meta.dir, '../bin/whatsapp');
let server: net.Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>(done => server!.close(() => done()));
  server = null;
  fs.rmSync(SOCKET_PATH, { force: true });
  fs.rmSync(PID_FILE, { force: true });
});

/** A daemon that accepts requests and never answers (stuck send, slow upload). */
async function silentDaemon(onRequest?: (line: string) => void): Promise<void> {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
  server = net.createServer(conn => conn.on('data', d => onRequest?.(d.toString())));
  await new Promise<void>(done => server!.listen(SOCKET_PATH, () => done()));
}

function runCli(args: string[], input: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(cli, args, { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => done({ code, stdout, stderr }));
    child.stdin.end(input);
  }, 30_000);
}

describe('send outcome reporting', () => {
  test('no reply after the request was written is "outcome unknown", not a failure', async () => {
    await silentDaemon();
    const err = await sendCommand('send', {}, 200).catch(e => e);
    expect(err).toBeInstanceOf(IpcOutcomeUnknownError);
  }, 30_000);

  test('no daemon at all is a plain failure', async () => {
    const err = await sendCommand('send', {}, 200).catch(e => e);
    expect(err).not.toBeInstanceOf(IpcOutcomeUnknownError);
  }, 30_000);

  test('the CLI exits 75 with the message ID and safe-retry instructions', async () => {
    let request = '';
    await silentDaemon(line => { request += line; });
    const result = await runCli(['send', 'Mom'], 'hello', { WHATSAPP_CLI_SEND_TIMEOUT_MS: '300' });
    expect(result.code).toBe(75);
    const id = JSON.parse(request.trim()).params.message_id as string;
    expect(id).toMatch(/^3EB0[0-9A-F]{18}$/);
    expect(result.stderr).toContain('OUTCOME UNKNOWN');
    expect(result.stderr).toContain(`whatsapp outbox ${id}`);
    expect(result.stderr).toContain(`--id ${id}`);
  }, 30_000);

  test('a retry with --id reuses the same message ID', async () => {
    let request = '';
    await silentDaemon(line => { request += line; });
    await runCli(['send', 'Mom', '--id', '3EB0ABCDEF0123456789AB'], 'hello', { WHATSAPP_CLI_SEND_TIMEOUT_MS: '300' });
    expect(JSON.parse(request.trim()).params.message_id).toBe('3EB0ABCDEF0123456789AB');
  }, 30_000);
});
