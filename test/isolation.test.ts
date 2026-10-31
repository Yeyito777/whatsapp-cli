import './setup.js';
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AUTH_DIR, SOCKET_PATH } from '../lib/paths.js';
import { assertIsolatedPaths } from './setup.js';

const here = path.resolve(import.meta.dir);

describe('test isolation', () => {
  test('paths resolve inside a temp test dir', () => {
    expect(() => assertIsolatedPaths({ AUTH_DIR, SOCKET_PATH })).not.toThrow();
  });

  test('the guard refuses real state locations', () => {
    const real = path.resolve(here, '../config/auth');
    expect(() => assertIsolatedPaths({ AUTH_DIR: real })).toThrow(/REFUSING TO RUN TESTS/);
    expect(() => assertIsolatedPaths({ SOCKET_PATH: path.join(os.homedir(), '.runtime/whatsapp-cli/daemon.sock') })).toThrow(/REFUSING/);
    expect(() => assertIsolatedPaths({ AUTH_DIR: path.join(os.tmpdir(), 'elsewhere/auth') })).toThrow(/REFUSING/);
  });

  test('a run from another cwd without the bunfig preload or inherited env is still isolated', () => {
    // Real-state locations stand-in: if isolation failed, AUTH_DIR would be under ../config.
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('WHATSAPP_CLI_') || k === 'EXOCORTEX_CONFIG_DIR') delete env[k];
    const probe = path.join(os.tmpdir(), `whatsapp-cli-probe-${process.pid}`);
    fs.mkdirSync(probe, { recursive: true });
    try {
      const file = path.join(probe, 'probe.test.ts');
      fs.writeFileSync(file, `
import ${JSON.stringify(path.join(here, 'setup.ts'))};
import { test } from 'bun:test';
import { AUTH_DIR, SOCKET_PATH, PID_FILE } from ${JSON.stringify(path.join(here, '../lib/paths.ts'))};
test('probe', () => { console.log('PROBE ' + JSON.stringify({ AUTH_DIR, SOCKET_PATH, PID_FILE })); });
`);
      const run = spawnSync(process.execPath, ['test', file], { cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 30_000 });
      expect(run.status).toBe(0);
      const line = run.stdout.split('\n').find(l => l.startsWith('PROBE ')) ?? run.stderr.split('\n').find(l => l.includes('PROBE '));
      expect(line).toBeTruthy();
      const found = JSON.parse(line!.slice(line!.indexOf('PROBE ') + 6)) as Record<string, string>;
      for (const p of Object.values(found)) {
        expect(p.startsWith(path.join(os.tmpdir(), 'whatsapp-cli-test-'))).toBe(true);
        expect(p.startsWith(path.resolve(here, '..'))).toBe(false);
      }
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  });
});
