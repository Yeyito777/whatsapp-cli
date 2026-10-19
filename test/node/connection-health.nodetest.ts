import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { backoffDelay, CONFLICT_DELAYS_MS, decideOnClose, NETWORK_BACKOFF } from '../../lib/reconnect-policy.ts';
import { HealthMonitor, type HealthEvent } from '../../lib/health.ts';
import { rotateIfLarge } from '../../lib/log-file.ts';

const half = () => 0.5;
const silent = { warn() {}, info() {} };

describe('reconnect policy', () => {
  test('network failures back off exponentially up to a minute, without giving up', () => {
    const delays = [1, 2, 3, 4, 5, 6, 10, 100].map(n => backoffDelay(n, NETWORK_BACKOFF, half));
    assert.deepEqual(delays, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    const decision = decideOnClose(408, { failures: 50, conflicts: 0 }, half);
    assert.equal(decision.action, 'reconnect');
    assert.equal(decision.action === 'reconnect' && decision.delayMs, 60_000);
  });

  test('a session conflict reconnects slowly instead of staying dead', () => {
    const first = decideOnClose(440, { failures: 0, conflicts: 1 });
    const later = decideOnClose(440, { failures: 0, conflicts: 9 });
    assert.equal(first.action, 'reconnect');
    assert.equal(first.state, 'conflict');
    assert.equal(first.action === 'reconnect' && first.delayMs, CONFLICT_DELAYS_MS[0]);
    assert.equal(later.action === 'reconnect' && later.delayMs, 60 * 60_000);
    assert.doesNotMatch(first.actionRequired ?? '', /logout/);
  });

  test('revoked or refused sessions stop instead of hammering WhatsApp', () => {
    for (const code of [401, 403, 411]) {
      const decision = decideOnClose(code, { failures: 1, conflicts: 0 });
      assert.equal(decision.action, 'stop', `code ${code}`);
      assert.equal(decision.state, 'logged_out');
    }
  });
});

function monitor(offlineAlertMs = 50) {
  const events: HealthEvent[] = [];
  const ids: string[] = [];
  const store = new Map<string, string>();
  const health = new HealthMonitor(silent, async (event, id) => { events.push(event); ids.push(id); }, Date.now, offlineAlertMs, {
    get: k => store.get(k), set: (k, v) => { store.set(k, v); }, delete: k => { store.delete(k); },
  });
  return { health, events, ids, store };
}

const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

describe('connection health alerts', () => {
  test('a long outage alerts once and recovery is announced', async () => {
    const { health, events } = monitor();
    health.disconnected(408, 'timedOut');
    health.disconnected(408, 'timedOut');
    await wait(80);
    health.connected();
    assert.deepEqual(events.map(e => e.kind), ['offline', 'recovered']);
  });

  test('a short blip produces no alert at all', async () => {
    const { health, events } = monitor();
    health.disconnected(408, 'timedOut');
    health.connected();
    await wait(80);
    assert.equal(events.length, 0);
  });

  test('a conflict alerts immediately, once per outage', () => {
    const { health, events } = monitor(10_000);
    health.conflict('conflict', 'stop the other copy');
    health.conflict('conflict', 'stop the other copy');
    assert.deepEqual(events.map(e => e.kind), ['conflict']);
    health.quiet();
  });

  test('a logged-out alert keeps the same event ID across daemon restarts', () => {
    const first = monitor(10_000);
    first.health.loggedOut(401, 'logged out', 'whatsapp login');
    first.health.quiet();
    const restarted = new HealthMonitor(silent, async (_e, id) => { first.ids.push(id); }, Date.now, 10_000, {
      get: k => first.store.get(k), set: (k, v) => { first.store.set(k, v); }, delete: k => { first.store.delete(k); },
    });
    restarted.loggedOut(401, 'logged out', 'whatsapp login');
    restarted.quiet();
    assert.equal(first.ids.length, 2);
    assert.equal(first.ids[0], first.ids[1]);
  });

  test('an intentional shutdown cancels the pending offline alert', async () => {
    const { health, events } = monitor();
    health.disconnected(428, 'closed');
    health.quiet();
    await wait(80);
    assert.equal(events.length, 0);
  });
});

describe('daemon log rotation', () => {
  test('a log above the cap is rotated to .1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-log-'));
    const file = path.join(dir, 'daemon.log');
    fs.writeFileSync(file, 'x'.repeat(2048));
    assert.equal(rotateIfLarge(file, 1024), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.statSync(`${file}.1`).size, 2048);
    assert.equal(rotateIfLarge(`${file}.missing`, 1024), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
