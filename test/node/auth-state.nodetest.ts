import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { initAuthCreds, useMultiFileAuthState } from '@whiskeysockets/baileys';

import { loadSecureAuthState } from '../../lib/auth-state.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auth-'));
  dirs.push(dir);
  return path.join(dir, 'auth');
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const mode = (p: string) => (fs.statSync(p).mode & 0o777).toString(8);

describe('crash-safe, owner-only WhatsApp credential store', () => {
  test('reads state written by Baileys useMultiFileAuthState (same file names)', async () => {
    const dir = tempDir();
    const legacy = await useMultiFileAuthState(dir);
    legacy.state.creds.me = { id: '15550009999:3@s.whatsapp.net' } as never;
    await legacy.saveCreds();
    await legacy.state.keys.set({ 'lid-mapping': { '123_reverse': '15550001234' as never }, session: { '15550001234.0': Buffer.from('abc') as never } });

    const secure = await loadSecureAuthState(dir);
    assert.equal(secure.state.creds.me?.id, '15550009999:3@s.whatsapp.net');
    const keys = await secure.state.keys.get('lid-mapping', ['123_reverse', 'missing']);
    assert.equal(keys['123_reverse'], '15550001234');
    assert.equal('missing' in keys, false);
    const sessions = await secure.state.keys.get('session', ['15550001234.0']);
    assert.ok(Buffer.from(sessions['15550001234.0'] as never).equals(Buffer.from('abc')));
  });

  test('loading tightens an existing world-readable store to 0700/0600', async () => {
    const dir = tempDir();
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(initAuthCreds()), { mode: 0o644 });
    fs.chmodSync(path.join(dir, 'creds.json'), 0o644);
    await loadSecureAuthState(dir);
    assert.equal(mode(dir), '700');
    assert.equal(mode(path.join(dir, 'creds.json')), '600');
  });

  test('writes are 0600 and replace the file atomically (new inode, no temp left)', async () => {
    const dir = tempDir();
    const auth = await loadSecureAuthState(dir);
    await auth.saveCreds();
    const file = path.join(dir, 'creds.json');
    const before = fs.statSync(file).ino;
    auth.state.creds.me = { id: '1@s.whatsapp.net' } as never;
    await auth.saveCreds();
    assert.notEqual(fs.statSync(file).ino, before);
    assert.equal(mode(file), '600');
    await auth.state.keys.set({ 'pre-key': { '7': { public: Buffer.alloc(32), private: Buffer.alloc(32) } as never } });
    assert.equal(mode(path.join(dir, 'pre-key-7.json')), '600');
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
    await auth.state.keys.set({ 'pre-key': { '7': null as never } });
    assert.equal(fs.existsSync(path.join(dir, 'pre-key-7.json')), false);
  });

  test('a truncated creds.json is an error, not a silent new identity', async () => {
    const dir = tempDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'creds.json'), '{"noiseKey": {"priv');
    await assert.rejects(loadSecureAuthState(dir), /creds\.json/);
    const legacy = await useMultiFileAuthState(dir);
    assert.equal(legacy.state.creds.me, undefined, 'Baileys would have started a fresh, unlinked identity');
  });

  test('a corrupt key file is treated as missing so one bad session cannot stop the daemon', async () => {
    const dir = tempDir();
    const auth = await loadSecureAuthState(dir);
    fs.writeFileSync(path.join(dir, 'session-9.0.json'), '{bad');
    const got = await auth.state.keys.get('session', ['9.0']);
    assert.deepEqual(got, {});
  });

  test('symlinks and stale temp files are handled safely', async () => {
    const dir = tempDir();
    await loadSecureAuthState(dir);
    fs.writeFileSync(path.join(dir, '.wa-auth-stale.tmp'), 'x');
    await loadSecureAuthState(dir);
    assert.equal(fs.existsSync(path.join(dir, '.wa-auth-stale.tmp')), false);
    fs.symlinkSync('/etc/passwd', path.join(dir, 'session-1.0.json'));
    await assert.rejects(loadSecureAuthState(dir), /symlink/);
  });
});
