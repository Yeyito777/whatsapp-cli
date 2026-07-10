import { describe, expect, test } from 'bun:test';

import { ConnectionReadinessGate } from '../lib/readiness.js';

describe('ConnectionReadinessGate', () => {
  test('returns immediately when already connected', async () => {
    const gate = new ConnectionReadinessGate('connected');
    expect(await gate.wait(100)).toBe(true);
  });

  test('waits through startup until connected', async () => {
    const gate = new ConnectionReadinessGate('connecting');
    const result = gate.wait(500);
    setTimeout(() => gate.setState('connected'), 10);
    expect(await result).toBe(true);
  });

  test('keeps waiting across a reconnecting disconnected state', async () => {
    const gate = new ConnectionReadinessGate('connected');
    gate.setState('disconnected');
    const result = gate.wait(500);
    gate.setState('connecting');
    setTimeout(() => gate.setState('connected'), 10);
    expect(await result).toBe(true);
  });

  test('fails immediately for terminal auth states', async () => {
    for (const state of ['conflict', 'logged_out'] as const) {
      const gate = new ConnectionReadinessGate(state);
      expect(await gate.wait(500)).toBe(false);
    }
  });

  test('times out when reconnect never finishes', async () => {
    const gate = new ConnectionReadinessGate('connecting');
    expect(await gate.wait(15)).toBe(false);
  });

  test('releases every waiting command when connected', async () => {
    const gate = new ConnectionReadinessGate('connecting');
    const results = Promise.all([gate.wait(500), gate.wait(500), gate.wait(500)]);
    gate.setState('connected');
    expect(await results).toEqual([true, true, true]);
  });

  test('cancels waiters during daemon shutdown', async () => {
    const gate = new ConnectionReadinessGate('connecting');
    const result = gate.wait(500);
    gate.cancel();
    expect(await result).toBe(false);
  });
});
