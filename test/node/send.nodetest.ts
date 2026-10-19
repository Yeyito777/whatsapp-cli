import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import pino from 'pino';
import type { WASocket } from '@whiskeysockets/baileys';

import { setSocketForTest } from '../../lib/connection.ts';
import { handleCommand, initHandlers } from '../../lib/handlers.ts';
import { upsertChat, upsertContact, upsertMessage } from '../../lib/db.ts';
import { advanceOutbox, getOutboxEntry, markInterruptedSendsUnknown, recordSending } from '../../lib/outbox.ts';
import { resetDb } from './helpers.ts';

initHandlers(pino({ level: 'silent' }));

interface SentCall { jid: string; content: Record<string, unknown>; options: Record<string, unknown> }

function fakeSocket(behaviour: { fail?: Error; ack?: 'server' | 'error' } = {}) {
  const calls: SentCall[] = [];
  const sock = {
    user: { id: '15550009999:3@s.whatsapp.net' },
    async sendMessage(jid: string, content: Record<string, unknown>, options: Record<string, unknown>) {
      calls.push({ jid, content, options });
      if (behaviour.fail) throw behaviour.fail;
      const id = options.messageId as string;
      if (behaviour.ack === 'server') setTimeout(() => advanceOutbox(id, 'server_ack'), 10);
      if (behaviour.ack === 'error') setTimeout(() => advanceOutbox(id, 'failed', 'WhatsApp error 479'), 10);
      return {
        key: { remoteJid: jid, fromMe: true, id },
        message: { conversation: content.text },
        messageTimestamp: Math.floor(Date.now() / 1000),
      };
    },
    async onWhatsApp() { return [{ jid: '', exists: true }]; },
  };
  setSocketForTest(sock as unknown as WASocket);
  return calls;
}

async function send(params: Record<string, unknown>) {
  return handleCommand({ id: 1, method: 'send', params });
}

describe('sends are idempotent per message ID', () => {
  beforeEach(() => {
    resetDb();
    upsertContact({ jid: '15550001234@s.whatsapp.net', name: 'Bob' });
  });

  test('the pre-assigned ID is used on the wire and a repeat is not sent again', async () => {
    const calls = fakeSocket({ ack: 'server' });
    const first = await send({ target: 'Bob', text: 'hi', message_id: '3EB0AAAAAAAAAAAAAAAAAA' });
    assert.equal(first.error, undefined);
    assert.equal((first.result as { status: string }).status, 'server_ack');
    assert.equal(calls[0].options.messageId, '3EB0AAAAAAAAAAAAAAAAAA');

    const retry = await send({ target: 'Bob', text: 'hi', message_id: '3EB0AAAAAAAAAAAAAAAAAA' });
    assert.equal(calls.length, 1, 'retry must not send a second copy');
    assert.equal((retry.result as { duplicate: boolean }).duplicate, true);
  });

  test('written-but-unacknowledged is reported as written, not as confirmed', async () => {
    fakeSocket();
    const res = await send({ target: 'Bob', text: 'hi', message_id: '3EB0BBBBBBBBBBBBBBBBBB' });
    assert.equal((res.result as { status: string }).status, 'written');
  });

  test('an error ack is a failure', async () => {
    fakeSocket({ ack: 'error' });
    const res = await send({ target: 'Bob', text: 'hi', message_id: '3EB0CCCCCCCCCCCCCCCCCC' });
    assert.match(res.error ?? '', /rejected/);
    assert.equal(getOutboxEntry('3EB0CCCCCCCCCCCCCCCCCC')?.state, 'failed');
  });

  test('a Baileys error before writing is "not sent" and may be retried with the same ID', async () => {
    let calls = fakeSocket({ fail: new Error('socket closed') });
    const res = await send({ target: 'Bob', text: 'hi', message_id: '3EB0DDDDDDDDDDDDDDDDDD' });
    assert.match(res.error ?? '', /^Not sent/);
    calls = fakeSocket({ ack: 'server' });
    const retry = await send({ target: 'Bob', text: 'hi', message_id: '3EB0DDDDDDDDDDDDDDDDDD' });
    assert.equal(calls.length, 1);
    assert.equal((retry.result as { status: string }).status, 'server_ack');
  });

  test('an ID cannot be reused for a different chat', async () => {
    fakeSocket({ ack: 'server' });
    upsertContact({ jid: '15550004321@s.whatsapp.net', name: 'Carol' });
    await send({ target: 'Bob', text: 'hi', message_id: '3EB0EEEEEEEEEEEEEEEEEE' });
    const res = await send({ target: 'Carol', text: 'hi', message_id: '3EB0EEEEEEEEEEEEEEEEEE' });
    assert.match(res.error ?? '', /already used/);
  });

  test('sends interrupted by a daemon stop become "unknown" on the next start', () => {
    recordSending('3EB0FFFFFFFFFFFFFFFFFF', '15550001234@s.whatsapp.net', 'text');
    assert.equal(markInterruptedSendsUnknown(), 1);
    assert.equal(getOutboxEntry('3EB0FFFFFFFFFFFFFFFFFF')?.state, 'unknown');
  });

  test('acknowledgements only move forward', () => {
    recordSending('3EB0GGGGGGGGGGGGGGGGGG', '15550001234@s.whatsapp.net', 'text');
    advanceOutbox('3EB0GGGGGGGGGGGGGGGGGG', 'delivered');
    advanceOutbox('3EB0GGGGGGGGGGGGGGGGGG', 'server_ack');
    assert.equal(getOutboxEntry('3EB0GGGGGGGGGGGGGGGGGG')?.state, 'delivered');
  });
});

describe('replies and read receipts', () => {
  beforeEach(() => {
    resetDb();
    upsertContact({ jid: '15550001234@s.whatsapp.net', name: 'Bob' });
  });

  test('a reply passes the stored message as quoted, with our own JID for our messages', async () => {
    const calls = fakeSocket({ ack: 'server' });
    upsertMessage({
      id: 'Q1', chat_jid: '15550001234@s.whatsapp.net', sender_jid: '15550009999@s.whatsapp.net', sender_name: 'Me',
      content: 'see you at 5', timestamp: '2026-10-19T10:00:00.000Z', is_from_me: true,
      media_type: null, media_caption: null, quoted_id: null,
    });
    const res = await send({ target: 'Bob', text: 'ok', reply_to: 'Q1', message_id: '3EB0HHHHHHHHHHHHHHHHHH' });
    assert.equal(res.error, undefined);
    const quoted = calls[0].options.quoted as { key: Record<string, unknown>; message: Record<string, unknown> };
    assert.deepEqual(quoted.key, { remoteJid: '15550001234@s.whatsapp.net', fromMe: true, id: 'Q1' });
    assert.equal(quoted.message.conversation, 'see you at 5');
    assert.equal(calls[0].content.contextInfo, undefined, 'no hand-built contextInfo');
  });

  test('a group reply names the quoted sender', async () => {
    const calls = fakeSocket({ ack: 'server' });
    upsertChat({ jid: '120363000000000001@g.us', name: 'Team', is_group: true });
    upsertMessage({
      id: 'Q2', chat_jid: '120363000000000001@g.us', sender_jid: '15550005555@s.whatsapp.net', sender_name: 'Ann',
      content: 'who is in?', timestamp: '2026-10-19T10:00:00.000Z', is_from_me: false,
      media_type: null, media_caption: null, quoted_id: null,
    });
    await send({ target: 'Team', text: 'me', reply_to: 'Q2', message_id: '3EB0IIIIIIIIIIIIIIIIII' });
    const quoted = calls[0].options.quoted as { key: Record<string, unknown> };
    assert.equal(quoted.key.participant, '15550005555@s.whatsapp.net');
  });

  test('replying to a message from another chat is refused before sending', async () => {
    const calls = fakeSocket({ ack: 'server' });
    upsertMessage({
      id: 'Q3', chat_jid: '15550007777@s.whatsapp.net', sender_jid: '15550007777@s.whatsapp.net', sender_name: 'Eve',
      content: 'secret', timestamp: '2026-10-19T10:00:00.000Z', is_from_me: false,
      media_type: null, media_caption: null, quoted_id: null,
    });
    const res = await send({ target: 'Bob', text: 'ok', reply_to: 'Q3', message_id: '3EB0JJJJJJJJJJJJJJJJJJ' });
    assert.match(res.error ?? '', /not in Bob/);
    assert.equal(calls.length, 0);
  });

  test('read marks the latest incoming message and names the group sender', async () => {
    const reads: unknown[] = [];
    fakeSocket();
    const sock = (await import('../../lib/connection.ts')).getSocket() as unknown as Record<string, unknown>;
    sock.readMessages = async (keys: unknown[]) => { reads.push(...keys); };
    upsertChat({ jid: '120363000000000002@g.us', name: 'Club', is_group: true });
    upsertMessage({
      id: 'R1', chat_jid: '120363000000000002@g.us', sender_jid: '15550006666@s.whatsapp.net', sender_name: 'Kim',
      content: 'hi', timestamp: '2026-10-19T10:00:00.000Z', is_from_me: false, media_type: null, media_caption: null, quoted_id: null,
    });
    upsertMessage({
      id: 'R2', chat_jid: '120363000000000002@g.us', sender_jid: '15550009999@s.whatsapp.net', sender_name: 'Me',
      content: 'hey', timestamp: '2026-10-19T10:01:00.000Z', is_from_me: true, media_type: null, media_caption: null, quoted_id: null,
    });
    await handleCommand({ id: 2, method: 'mark_read', params: { target: 'Club' } });
    assert.deepEqual(reads, [{ remoteJid: '120363000000000002@g.us', id: 'R1', fromMe: false, participant: '15550006666@s.whatsapp.net' }]);
  });
});
