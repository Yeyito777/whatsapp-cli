import { describe, expect, test } from 'bun:test';

import { CATCH_UP_SLACK_MS, CatchUpWindow, notificationUpsertType } from '../lib/catch-up.js';
import { shouldPublishIncomingMessage, shouldPublishOwnerAiCommand } from '../lib/notifications.js';

const now = Date.parse('2026-10-19T12:00:00Z');
const lastLive = now - 10 * 60_000; // daemon restarted after a 10 min gap

function publishes(upsertType: string, timestampMs: number, window: CatchUpWindow | null, sentByThisClient = false): boolean {
  return shouldPublishIncomingMessage({
    upsertType: notificationUpsertType({ upsertType, sentByThisClient, timestampMs, window }),
    rawChatJid: '15550001234@s.whatsapp.net',
    platformMessageId: 'ABC',
    isFromMe: false,
  });
}

describe('messages queued while the daemon was offline still notify', () => {
  test('an offline-queued "append" newer than the last-live mark publishes', () => {
    const window = new CatchUpWindow(lastLive, now);
    expect(publishes('append', now - 5 * 60_000, window)).toBe(true);
  });

  test('older "append" messages (history) do not publish', () => {
    const window = new CatchUpWindow(lastLive, now);
    expect(publishes('append', lastLive - CATCH_UP_SLACK_MS - 1, window)).toBe(false);
  });

  test('a first run with no last-live mark publishes no backlog', () => {
    const window = new CatchUpWindow(null, now);
    expect(publishes('append', now - 60_000, window)).toBe(false);
  });

  test('a very long outage only reaches back 24 hours', () => {
    const window = new CatchUpWindow(now - 11 * 24 * 3600_000, now);
    expect(publishes('append', now - 2 * 24 * 3600_000, window)).toBe(false);
    expect(publishes('append', now - 3600_000, window)).toBe(true);
  });

  test('catch-up is capped and the overflow is counted for a summary', () => {
    const window = new CatchUpWindow(lastLive, now, 2);
    const results = [1, 2, 3, 4].map(i => publishes('append', now - i * 1000, window));
    expect(results).toEqual([true, true, false, false]);
    expect(window.skipped).toBe(2);
  });

  test('live "notify" still publishes; messages sent by this CLI never do', () => {
    expect(publishes('notify', now, null)).toBe(true);
    expect(publishes('notify', now, null, true)).toBe(false);
    expect(publishes('append', now - 1000, new CatchUpWindow(lastLive, now), true)).toBe(false);
  });

  test('an agent sending "/ai ..." through the CLI does not trigger an owner command', () => {
    const upsertType = notificationUpsertType({ upsertType: 'append', sentByThisClient: true, timestampMs: now, window: new CatchUpWindow(lastLive, now) });
    expect(shouldPublishOwnerAiCommand({
      upsertType, rawChatJid: '15550001234@s.whatsapp.net', platformMessageId: 'X', isFromMe: true,
      ownerJid: '15550009999@s.whatsapp.net', content: '/ai do something',
    })).toBe(false);
  });
});
