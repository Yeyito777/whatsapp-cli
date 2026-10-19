import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beforeEach, describe, test } from 'node:test';

import { getDb, kvGet, setAlias, upsertChat, upsertContact, upsertMessage } from '../../lib/db.ts';
import { getOwnJid, registerLidMapping, setOwnJid, waMessageToStored } from '../../lib/converters.ts';
import { backupDatabaseOnce, repairStoredIdentities } from '../../lib/migrations.ts';
import { resetDb } from './helpers.ts';

const LID = '210987654321098@lid';
const PN = '15550001234@s.whatsapp.net';
const OWN = '15550009999@s.whatsapp.net';
const silent = { info() {}, warn() {} };

function message(id: string, chat: string, extra: Record<string, unknown> = {}) {
  return {
    id, chat_jid: chat, sender_jid: chat, sender_name: '210987654321098', content: `m-${id}`,
    timestamp: `2026-10-19T10:00:0${id.length % 10}.000Z`, is_from_me: false,
    media_type: null, media_caption: null, quoted_id: null, ...extra,
  };
}

const rows = (sql: string, ...args: unknown[]) => getDb().prepare(sql).all(...args) as Array<Record<string, unknown>>;

describe('stored identity repair', () => {
  beforeEach(() => resetDb());

  test('a message stored under both LID and phone JID is kept once, media metadata preserved', () => {
    upsertMessage(message('A', LID, { raw_message_json: '{"raw":1}', media_type: 'image' }));
    upsertMessage(message('A', PN, { media_type: 'image' }));
    upsertMessage(message('B', LID));
    const totals = repairStoredIdentities([[LID, PN]], null);
    assert.equal(totals.messagesDeduplicated, 1);
    assert.equal(totals.messagesMoved, 1);
    const stored = rows('SELECT id, chat_jid, raw_message_json, sender_jid FROM messages ORDER BY id');
    assert.deepEqual(stored, [
      { id: 'A', chat_jid: PN, raw_message_json: '{"raw":1}', sender_jid: PN },
      { id: 'B', chat_jid: PN, raw_message_json: null, sender_jid: PN },
    ]);
  });

  test('duplicate chat and contact rows collapse onto the phone JID without losing names', () => {
    upsertChat({ jid: LID, name: 'Zoe', last_message_time: '2026-10-19T12:00:00.000Z', last_message_preview: 'newest' });
    upsertChat({ jid: PN, last_message_time: '2026-10-18T12:00:00.000Z', last_message_preview: 'older' });
    upsertContact({ jid: LID, notify: 'Zo' });
    setAlias(LID, 'Zoe W', '');
    repairStoredIdentities([[LID, PN]], null);
    assert.deepEqual(rows('SELECT jid, name, last_message_preview FROM chats'), [{ jid: PN, name: 'Zoe', last_message_preview: 'newest' }]);
    assert.deepEqual(rows('SELECT jid, notify FROM contacts'), [{ jid: PN, notify: 'Zo' }]);
    assert.deepEqual(rows('SELECT jid, name FROM aliases'), [{ jid: PN, name: 'Zoe W' }]);
  });

  test('an existing phone alias is never overwritten by a LID alias', () => {
    setAlias(LID, 'Old', '');
    setAlias(PN, 'Keep', '');
    repairStoredIdentities([[LID, PN]], null);
    assert.deepEqual(rows('SELECT jid, name FROM aliases ORDER BY jid'), [{ jid: PN, name: 'Keep' }, { jid: LID, name: 'Old' }]);
  });

  test('our own DM messages get our JID as sender instead of the recipient', () => {
    upsertMessage(message('C', PN, { is_from_me: true, sender_jid: PN, sender_name: '15550001234' }));
    upsertMessage(message('D', PN));
    const totals = repairStoredIdentities([], OWN);
    assert.equal(totals.ownSenders, 1);
    assert.deepEqual(rows('SELECT id, sender_jid, sender_name FROM messages ORDER BY id'), [
      { id: 'C', sender_jid: OWN, sender_name: 'Me' },
      { id: 'D', sender_jid: PN, sender_name: '210987654321098' },
    ]);
  });

  test('the repair is idempotent', () => {
    upsertMessage(message('E', LID));
    repairStoredIdentities([[LID, PN]], OWN);
    const again = repairStoredIdentities([[LID, PN]], OWN);
    assert.deepEqual(Object.values(again).filter(Boolean), []);
  });

  test('the first repair backs the database up first, only once', async () => {
    const first = await backupDatabaseOnce(silent);
    assert.ok(first && fs.existsSync(first));
    assert.equal((fs.statSync(first).mode & 0o777).toString(8), '600');
    assert.equal(await backupDatabaseOnce(silent), null);
    assert.equal(kvGet('migration_backup_v1'), first);
    fs.rmSync(first);
  });
});

describe('new messages are stored under one identity with the right sender', () => {
  test('a LID-addressed message with remoteJidAlt is stored under the phone JID', () => {
    const stored = waMessageToStored({
      key: { remoteJid: '310987654321098@lid', remoteJidAlt: '15550004444@s.whatsapp.net', fromMe: false, id: 'X1' } as never,
      message: { conversation: 'hi' },
      messageTimestamp: 1_760_000_000,
      pushName: 'Lee',
    });
    assert.equal(stored?.chat_jid, '15550004444@s.whatsapp.net');
  });

  test('our own message in a DM has our JID as sender', () => {
    setOwnJid('15550009999:7@s.whatsapp.net');
    assert.equal(getOwnJid(), OWN);
    const stored = waMessageToStored({
      key: { remoteJid: PN, fromMe: true, id: 'X2' },
      message: { conversation: 'mine' },
      messageTimestamp: 1_760_000_000,
    });
    assert.equal(stored?.sender_jid, OWN);
    assert.equal(stored?.is_from_me, true);
  });

  test('registerLidMapping ignores malformed pairs', () => {
    registerLidMapping('15550001111@s.whatsapp.net', '15550002222@s.whatsapp.net');
    assert.equal(rows("SELECT 1 FROM messages WHERE chat_jid = 'x'").length, 0);
  });
});
