import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import pino from 'pino';

import { upsertContact, upsertMessage } from '../../lib/db.ts';
import { setOwnJid, waMessageToStored } from '../../lib/converters.ts';
import { applyHistoryMutations, applyMessageUpdates, applyReactions } from '../../lib/mutations.ts';
import { handleCommand, initHandlers } from '../../lib/handlers.ts';
import { formatMessages } from '../../lib/format.ts';
import { resetDb } from './helpers.ts';

initHandlers(pino({ level: 'silent' }));
const CHAT = '15550001234@s.whatsapp.net';
const GROUP = '120363000000000009@g.us';
const OWN = '15550009999@s.whatsapp.net';

function store(id: string, chat: string, content: string, extra: Record<string, unknown> = {}) {
  upsertMessage({
    id, chat_jid: chat, sender_jid: chat, sender_name: 'Bob', content, timestamp: '2026-10-19T10:00:00.000Z',
    is_from_me: false, media_type: null, media_caption: null, quoted_id: null, ...extra,
  });
}

async function read(target: string) {
  const res = await handleCommand({ id: 1, method: 'messages', params: { target } });
  assert.equal(res.error, undefined);
  return res.result as { chat: { jid: string; name: string; match: string }; messages: Array<Record<string, unknown>> };
}

describe('edits, deletes and reactions are stored and shown', () => {
  beforeEach(() => {
    resetDb();
    setOwnJid(OWN);
    upsertContact({ jid: CHAT, name: 'Bob' });
  });

  test('an edit replaces the content and is marked edited', async () => {
    store('E1', CHAT, 'meet at 5');
    applyMessageUpdates([{
      key: { remoteJid: CHAT, fromMe: false, id: 'E1' },
      update: { message: { editedMessage: { message: { conversation: 'meet at 7' } } }, messageTimestamp: 1_760_900_000 },
    }]);
    const { messages } = await read('Bob');
    assert.equal(messages[0].content, 'meet at 7');
    assert.ok(messages[0].edited_at);
    const text = formatMessages(messages as never);
    assert.match(text, /meet at 7 \(edited\)/);
    assert.doesNotMatch(text, /meet at 5/);
  });

  test('an edit of an image caption updates the caption', async () => {
    store('E2', CHAT, 'old caption', { media_type: 'image', media_caption: 'old caption' });
    applyMessageUpdates([{
      key: { remoteJid: CHAT, fromMe: false, id: 'E2' },
      update: { message: { editedMessage: { message: { imageMessage: { caption: 'new caption' } } } } },
    }]);
    const { messages } = await read('Bob');
    assert.equal(messages[0].content, 'new caption');
    assert.equal(messages[0].media_caption, 'new caption');
  });

  test('a delete-for-everyone removes the text and shows [deleted]', async () => {
    store('D1', CHAT, 'oops wrong chat');
    applyMessageUpdates([{
      key: { remoteJid: CHAT, fromMe: false, id: 'D1' },
      update: { message: null, messageStubType: 1 },
    }]);
    const { messages } = await read('Bob');
    assert.equal(messages[0].content, '');
    assert.ok(messages[0].deleted_at);
    const text = formatMessages(messages as never);
    assert.match(text, /\[deleted\]/);
    assert.doesNotMatch(text, /oops/);
  });

  test('a history-sync revoke stub also deletes, and history reactions are kept', async () => {
    store('D2', CHAT, 'secret');
    store('H1', CHAT, 'hello');
    applyHistoryMutations([
      { key: { remoteJid: CHAT, fromMe: false, id: 'D2' }, messageStubType: 1 },
      { key: { remoteJid: CHAT, fromMe: false, id: 'H1' }, message: { conversation: 'hello' },
        reactions: [{ key: { remoteJid: CHAT, fromMe: true, id: 'R0' }, text: '👍', senderTimestampMs: 1_760_900_000_000 }] },
    ] as never);
    const { messages } = await read('Bob');
    const byId = Object.fromEntries(messages.map(m => [m.id, m]));
    assert.equal(byId.D2.content, '');
    assert.deepEqual((byId.H1.reactions as Array<Record<string, unknown>>).map(r => [r.emoji, r.from_me]), [['👍', true]]);
  });

  test('reactions are stored per reactor, replaced, removed, and shown with names', async () => {
    store('R1', GROUP, 'who is in?');
    upsertContact({ jid: '15550005555@s.whatsapp.net', name: 'Ann' });
    applyReactions([
      { key: { remoteJid: GROUP, fromMe: false, id: 'R1', participant: '15550001234@s.whatsapp.net' },
        reaction: { key: { remoteJid: GROUP, fromMe: false, id: 'x1', participant: '15550005555@s.whatsapp.net' }, text: '👍' } },
      { key: { remoteJid: GROUP, fromMe: false, id: 'R1' },
        reaction: { key: { remoteJid: GROUP, fromMe: true, id: 'x2' }, text: '❤️' } },
      { key: { remoteJid: GROUP, fromMe: false, id: 'R1' },
        reaction: { key: { remoteJid: GROUP, fromMe: false, id: 'x3', participant: '15550005555@s.whatsapp.net' }, text: '😂' } },
    ]);
    let { messages } = await read(GROUP);
    const reactions = messages[0].reactions as Array<Record<string, unknown>>;
    assert.deepEqual(reactions.map(r => [r.emoji, r.from_name]).sort(), [['❤️', 'You'], ['😂', 'Ann']]);
    assert.match(formatMessages(messages as never), /reactions: .*😂 Ann/);

    applyReactions([{ key: { remoteJid: GROUP, fromMe: false, id: 'R1' },
      reaction: { key: { remoteJid: GROUP, fromMe: true, id: 'x4' }, text: '' } }]);
    ({ messages } = await read(GROUP));
    assert.deepEqual((messages[0].reactions as Array<Record<string, unknown>>).map(r => r.emoji), ['😂']);
  });

  test('a reaction upsert is not stored as an empty message', () => {
    const stored = waMessageToStored({
      key: { remoteJid: CHAT, fromMe: false, id: 'RX' },
      message: { reactionMessage: { key: { remoteJid: CHAT, id: 'R1' }, text: '👍' } },
      messageTimestamp: 1_760_900_000,
    });
    assert.equal(stored, null);
  });
});
