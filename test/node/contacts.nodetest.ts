import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import pino from 'pino';

import { upsertMessage } from '../../lib/db.ts';
import { setOwnJid, waMessageToStored } from '../../lib/converters.ts';
import { handleCommand, initHandlers } from '../../lib/handlers.ts';
import { formatMessages } from '../../lib/format.ts';
import { incomingMessageNotificationData } from '../../lib/notifications.ts';
import type { StoredMessage } from '../../lib/types.ts';
import { resetDb } from './helpers.ts';

initHandlers(pino({ level: 'silent' }));
const CHAT = '50760000001@s.whatsapp.net';

// As sent by WhatsApp for iPhone (grouped TEL with waid) and Android (typed TEL).
const IOS_VCARD = 'BEGIN:VCARD\nVERSION:3.0\nN:de Puy;Luigi Iovanne;;;\nFN:Luigi Iovanne de Puy\n'
  + 'item1.TEL;waid=50761234567:+507 6123-4567\nitem1.X-ABLabel:Móvil\nEND:VCARD';
const ANDROID_VCARD = 'BEGIN:VCARD\nVERSION:3.0\nN:;Ana;;;\nFN:Ana Pérez\n'
  + 'TEL;type=CELL;type=VOICE;waid=50769876543:+507 6987-6543\nTEL;type=HOME:+507 222-3333\nEND:VCARD';

function waMessage(id: string, message: Record<string, unknown>) {
  return {
    key: { remoteJid: CHAT, fromMe: false, id },
    message: { ...message, messageContextInfo: { deviceListMetadataVersion: 2 } },
    messageTimestamp: 1792591320,
    pushName: 'Tía Liza',
  } as Parameters<typeof waMessageToStored>[0];
}

function storeAndGet(msg: Parameters<typeof waMessageToStored>[0]): StoredMessage {
  const stored = waMessageToStored(msg);
  assert.ok(stored);
  upsertMessage(stored);
  return stored;
}

async function download(id: string) {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-vcf-'));
  const res = await handleCommand({ id: 1, method: 'download_media', params: { message_id: id, outdir } });
  return res;
}

describe('shared contact cards', () => {
  beforeEach(() => {
    resetDb();
    setOwnJid('50760009999@s.whatsapp.net');
  });

  test('a single contact keeps name, phones and the vCard', async () => {
    const stored = storeAndGet(waMessage('3A242C0B741AFD3ACE3F', {
      contactMessage: { displayName: 'Luigi Iovanne de Puy', vcard: IOS_VCARD },
    }));
    assert.equal(stored.media_type, 'contact');
    assert.equal(stored.content, '👤 Luigi Iovanne de Puy · +507 6123-4567 (WhatsApp)');
    assert.ok(stored.raw_message_json?.includes('BEGIN:VCARD'));

    const res = await handleCommand({ id: 1, method: 'messages', params: { target: CHAT } });
    const text = formatMessages((res.result as { messages: StoredMessage[] }).messages);
    assert.match(text, /Tía Liza: 👤 Luigi Iovanne de Puy · \+507 6123-4567 \(WhatsApp\)\n/);
    assert.doesNotMatch(text, /👤 👤/);

    const dl = await download('3A242C0B741AFD3ACE3F');
    assert.equal(dl.error, undefined);
    const result = dl.result as { path: string; mime_type: string; file_name: string };
    assert.equal(result.mime_type, 'text/vcard');
    assert.equal(result.file_name, 'wa-3A242C0B741AFD3ACE3F.vcf');
    const vcf = fs.readFileSync(result.path, 'utf8');
    assert.equal(vcf, IOS_VCARD.replace(/\n/g, '\r\n') + '\r\n');
  });

  test('a contacts array gives one line per contact and one .vcf with all cards', async () => {
    const stored = storeAndGet(waMessage('3A00000000000000ARR1', {
      contactsArrayMessage: {
        displayName: '2 contacts',
        contacts: [
          { displayName: 'Luigi Iovanne de Puy', vcard: IOS_VCARD },
          { displayName: '', vcard: ANDROID_VCARD },
        ],
      },
    }));
    assert.equal(stored.content, [
      '👤 Luigi Iovanne de Puy · +507 6123-4567 (WhatsApp)',
      '👤 Ana Pérez · +507 6987-6543 (WhatsApp) · +507 222-3333',
    ].join('\n'));

    const data = incomingMessageNotificationData(stored, 'Tía Liza');
    assert.equal(data.content, stored.content);
    assert.deepEqual(data.media, { type: 'contact', caption: stored.content });

    const dl = await download('3A00000000000000ARR1');
    const vcf = fs.readFileSync((dl.result as { path: string }).path, 'utf8');
    assert.equal(vcf.match(/BEGIN:VCARD/g)?.length, 2);
    assert.match(vcf, /FN:Ana Pérez\r\n/);
  });

  test('folded lines, a waid-only TEL and a mismatched waid are all shown', () => {
    const vcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Some\r\n  Body\r\nTEL;waid=50760001111:\r\n'
      + 'TEL;waid=50760002222:+1 555 010 0000\r\nEND:VCARD';
    const stored = waMessageToStored(waMessage('X1', { contactMessage: { vcard } }));
    assert.equal(stored?.content, '👤 Some Body · +50760001111 (WhatsApp) · +1 555 010 0000 (WhatsApp +50760002222)');
  });

  test('old contact rows without a vCard say so instead of downloading', async () => {
    upsertMessage({
      id: 'OLD1', chat_jid: CHAT, sender_jid: CHAT, sender_name: 'Tía Liza', content: '',
      timestamp: '2026-10-21T14:02:00.000Z', is_from_me: false, media_type: 'contact', media_caption: null, quoted_id: null,
    });
    const dl = await download('OLD1');
    assert.match(dl.error ?? '', /vCard for contact message "OLD1" is unavailable/);
  });
});
