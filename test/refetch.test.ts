import { describe, expect, test } from 'bun:test';

import { awaitRefetch, takeRefetch } from '../lib/refetch.js';
import { shouldPublishIncomingMessage } from '../lib/notifications.js';

describe('refetched messages', () => {
  test('a requested resend is claimed once and resolves the wait', async () => {
    const arrived = awaitRefetch('3A242C0B741AFD3ACE3F', 1_000);
    expect(takeRefetch('3A242C0B741AFD3ACE3F')).toBe(true);
    expect(await arrived).toBe(true);
    expect(takeRefetch('3A242C0B741AFD3ACE3F')).toBe(false);
  });

  test('unrequested messages are not claimed, and an unanswered wait times out', async () => {
    expect(takeRefetch('OTHER')).toBe(false);
    expect(takeRefetch(null)).toBe(false);
    expect(await awaitRefetch('SLOW', 10)).toBe(false);
    expect(takeRefetch('SLOW')).toBe(false);
  });

  test('the refetch upsert type never notifies', () => {
    expect(shouldPublishIncomingMessage({
      upsertType: 'refetch',
      rawChatJid: '50761125636@s.whatsapp.net',
      platformMessageId: '3A242C0B741AFD3ACE3F',
      isFromMe: false,
    })).toBe(false);
  });
});
