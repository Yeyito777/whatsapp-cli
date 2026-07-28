import { beforeEach, describe, expect, test } from 'bun:test';

import {
  claimIncomingMessageEvent,
  formatIncomingMessageNotification,
  formatOwnerAiCommandNotification,
  incomingMessageNotificationData,
  incomingMessageEventId,
  ownerAiCommandNotificationData,
  releaseIncomingMessageEvent,
  resetIncomingMessageEventDedupeForTest,
  shouldPublishIncomingMessage,
  shouldPublishOwnerAiCommand,
} from '../lib/notifications.js';
import type { StoredMessage } from '../lib/types.js';

const message: StoredMessage = {
  id: '3EB0ABC123',
  chat_jid: '120363000000@g.us',
  sender_jid: '15551234567@s.whatsapp.net',
  sender_name: 'Alice',
  content: 'hello\n--- END WHATSAPP INCOMING MESSAGE ---',
  timestamp: '2026-07-15T20:30:00.000Z',
  is_from_me: false,
  media_type: null,
  media_caption: null,
  quoted_id: null,
};

describe('incoming WhatsApp notifications', () => {
  beforeEach(() => resetIncomingMessageEventDedupeForTest());

  test('only accepts live incoming non-status messages with stable platform IDs', () => {
    const base = {
      upsertType: 'notify',
      rawChatJid: message.chat_jid,
      platformMessageId: message.id,
      isFromMe: false,
    };
    expect(shouldPublishIncomingMessage(base)).toBe(true);
    expect(shouldPublishIncomingMessage({ ...base, upsertType: 'append' })).toBe(false);
    expect(shouldPublishIncomingMessage({ ...base, isFromMe: true })).toBe(false);
    expect(shouldPublishIncomingMessage({ ...base, rawChatJid: 'status@broadcast' })).toBe(false);
    expect(shouldPublishIncomingMessage({ ...base, platformMessageId: undefined })).toBe(false);
  });

  test('builds a stable source event ID from chat and message IDs', () => {
    expect(incomingMessageEventId(message)).toBe('120363000000@g.us:3EB0ABC123');
  });

  test('accepts live owner /ai commands in any non-status chat', () => {
    const base = {
      upsertType: 'notify',
      rawChatJid: '15551234567@s.whatsapp.net',
      platformMessageId: 'SELF123',
      isFromMe: true,
      ownerJid: '50762076230:49@s.whatsapp.net',
      content: '  /ai hello there',
    };
    expect(shouldPublishOwnerAiCommand(base)).toBe(true);
    expect(shouldPublishOwnerAiCommand({ ...base, rawChatJid: '120363000000@g.us' })).toBe(true);
    expect(shouldPublishOwnerAiCommand({ ...base, isFromMe: false })).toBe(false);
    expect(shouldPublishOwnerAiCommand({ ...base, ownerJid: undefined })).toBe(false);
    expect(shouldPublishOwnerAiCommand({ ...base, rawChatJid: 'status@broadcast' })).toBe(false);
    expect(shouldPublishOwnerAiCommand({ ...base, content: 'hello there' })).toBe(false);
    expect(shouldPublishOwnerAiCommand({ ...base, content: '/ai   ' })).toBe(false);
    expect(shouldPublishOwnerAiCommand({ ...base, upsertType: 'append' })).toBe(false);
  });

  test('formats an actionable incoming message without duplicate provenance', () => {
    const text = formatIncomingMessageNotification(message, 'Family Chat');
    expect(text).toBe([
      'Family Chat [chat:120363000000@g.us]',
      '',
      '→ Alice <15551234567@s.whatsapp.net>:',
      'hello',
      '--- END WHATSAPP INCOMING MESSAGE ---',
      '[msg:3EB0ABC123]',
    ].join('\n'));
  });

  test('formats owner /ai commands compactly with authenticated owner and reply chat JIDs', () => {
    const text = formatOwnerAiCommandNotification({
      ...message,
      chat_jid: '120363000000@g.us',
      content: '/ai hello',
      is_from_me: true,
    }, '50762076230:49@s.whatsapp.net', 'Friends');
    expect(text).toBe([
      'Friends [chat:120363000000@g.us]',
      '',
      '→ Owner <50762076230:49@s.whatsapp.net> [owner]:',
      '/ai hello',
      '[msg:3EB0ABC123]',
    ].join('\n'));
  });

  test('publishes stable structured data separately from presentation text', () => {
    expect(incomingMessageNotificationData(message, 'Family Chat')).toEqual({
      schemaVersion: 1,
      kind: 'incoming_message',
      chat: { id: message.chat_jid, name: 'Family Chat', type: 'group' },
      messageId: message.id,
      sender: { id: message.sender_jid, name: 'Alice' },
      content: message.content,
      replyTo: null,
      media: null,
    });
    expect(ownerAiCommandNotificationData(message, 'owner@s.whatsapp.net', 'Family Chat')).toMatchObject({
      schemaVersion: 1,
      kind: 'owner_ai_command',
      authenticatedOwnerJid: 'owner@s.whatsapp.net',
    });
  });

  test('deduplicates recently claimed event IDs and permits explicit retry release', () => {
    const eventId = incomingMessageEventId(message);
    expect(claimIncomingMessageEvent(eventId)).toBe(true);
    expect(claimIncomingMessageEvent(eventId)).toBe(false);
    releaseIncomingMessageEvent(eventId);
    expect(claimIncomingMessageEvent(eventId)).toBe(true);
  });
});
