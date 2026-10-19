import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import pino from 'pino';
import type { WASocket } from '@whiskeysockets/baileys';

import { PRESENCE_SOCKET_OPTIONS, setSocketForTest } from '../../lib/connection.ts';
import { handleCommand, initHandlers } from '../../lib/handlers.ts';
import { resetDb } from './helpers.ts';

initHandlers(pino({ level: 'silent' }));

describe('the account is not shown online 24/7', () => {
  test('connecting does not mark the account online', () => {
    assert.equal(PRESENCE_SOCKET_OPTIONS.markOnlineOnConnect, false);
  });

  test('typing goes online only while the indicator is on', async () => {
    resetDb();
    const presence: Array<[string, string | undefined]> = [];
    setSocketForTest({
      async sendPresenceUpdate(type: string, jid?: string) { presence.push([type, jid]); },
    } as unknown as WASocket);
    const on = await handleCommand({ id: 1, method: 'typing', params: { target: '15550001234@s.whatsapp.net', on: true } });
    assert.equal(on.error, undefined);
    await handleCommand({ id: 2, method: 'typing', params: { target: '15550001234@s.whatsapp.net', on: false } });
    assert.deepEqual(presence, [
      ['available', undefined], ['composing', '15550001234@s.whatsapp.net'],
      ['paused', '15550001234@s.whatsapp.net'], ['unavailable', undefined],
    ]);
  });
});
