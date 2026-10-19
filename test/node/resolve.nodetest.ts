import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { resolveDisplayName, setAlias, upsertChat, upsertContact } from '../../lib/db.js';
import { registerLidMapping } from '../../lib/converters.js';
import { resolveTarget, TargetResolutionError } from '../../lib/resolve.js';
import { resetDb } from './helpers.ts';

function assertMatch(actual: object, expected: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(expected)) {
    assert.equal((actual as Record<string, unknown>)[key], value, `${key} of ${JSON.stringify(actual)}`);
  }
}

function seed(): void {
  setAlias('111111111@s.whatsapp.net', 'Daniela', 'colleague');
  upsertContact({ jid: '222222222@s.whatsapp.net', name: 'Dan', notify: 'Dan' });
  upsertChat({ jid: '333333333@s.whatsapp.net', name: 'Anabel', last_message_time: '2026-10-19T10:00:00.000Z' });
  upsertContact({ jid: '444444444@s.whatsapp.net', name: 'Ana' });
  upsertChat({ jid: '120363000000000000@g.us', name: 'Family', is_group: true, last_message_time: '2026-10-19T11:00:00.000Z' });
}

function resolutionError(target: string): TargetResolutionError {
  try {
    resolveTarget(target);
  } catch (err) {
    assert.ok(err instanceof TargetResolutionError, String(err));
    return err;
  }
  throw new Error(`expected "${target}" to be refused`);
}

describe('target resolution never guesses a recipient', () => {
  beforeEach(() => {
    resetDb();
    seed();
  });

  test('an exact contact name beats a partial alias match', () => {
    assertMatch(resolveTarget('Dan'), { jid: '222222222@s.whatsapp.net', match: 'name' });
  });

  test('an exact contact name beats a partial chat-name match', () => {
    assertMatch(resolveTarget('ana'), { jid: '444444444@s.whatsapp.net', match: 'name' });
  });

  test('a unique partial match is accepted and labelled as such', () => {
    assertMatch(resolveTarget('fami'), { jid: '120363000000000000@g.us', match: 'fuzzy', name: 'Family' });
  });

  test('a partial match with several candidates is refused with the candidates listed', () => {
    const err = resolutionError('a');
    assert.ok(err.candidates.length > 1);
    assert.ok(err.message.includes('refusing to guess'), err.message);
    assert.ok(err.message.includes('111111111@s.whatsapp.net'), err.message);
  });

  test('LIKE wildcards are literal characters', () => {
    assert.ok(resolutionError('_').message.includes('Cannot resolve'), resolutionError('_').message);
    assert.ok(resolutionError('%').message.includes('Cannot resolve'), resolutionError('%').message);
  });

  test('two different chats with the same exact name are refused', () => {
    upsertContact({ jid: '555555555@s.whatsapp.net', name: 'Family' });
    const err = resolutionError('Family');
    assert.deepEqual(err.candidates.map(c => c.jid).sort(), ['120363000000000000@g.us', '555555555@s.whatsapp.net']);
  });

  test('a LID and its phone JID are one candidate, reported as the phone JID', () => {
    registerLidMapping('99887766554433@lid', '15550001111@s.whatsapp.net');
    upsertChat({ jid: '99887766554433@lid', name: 'Zed' });
    upsertContact({ jid: '15550001111@s.whatsapp.net', name: 'Zed' });
    assertMatch(resolveTarget('Zed'), { jid: '15550001111@s.whatsapp.net', match: 'name' });
  });

  test('alias beats other exact names; duplicate alias names are refused', () => {
    setAlias('666666666@s.whatsapp.net', 'Dan', '');
    assertMatch(resolveTarget('Dan'), { jid: '666666666@s.whatsapp.net', match: 'alias' });
    setAlias('777777777@s.whatsapp.net', 'dan', '');
    assert.equal(resolutionError('Dan').candidates.length, 2);
  });

  test('phone numbers and JIDs resolve directly; malformed JIDs are refused', () => {
    assertMatch(resolveTarget('+1 (415) 555-0100'), { jid: '14155550100@s.whatsapp.net', match: 'phone' });
    assertMatch(resolveTarget('14155550100@c.us'), { jid: '14155550100@s.whatsapp.net', match: 'jid' });
    assert.ok(resolutionError('foo@bar').message.includes('not a valid WhatsApp JID'), resolutionError('foo@bar').message);
  });
});

describe('linked identities are never treated as phone numbers', () => {
  beforeEach(() => resetDb());

  test('a known LID typed as digits is refused instead of becoming a phone JID', () => {
    upsertChat({ jid: '123456789012345@lid', last_message_time: '2026-10-19T10:00:00.000Z' });
    const err = resolutionError('+123456789012345');
    assert.ok(err.message.includes('123456789012345@lid'), err.message);
  });

  test('a LID with no name is labelled lid:, not +digits', () => {
    assert.equal(resolveDisplayName('123456789012346@lid'), 'lid:123456789012346');
    assert.equal(resolveDisplayName('14155550100@s.whatsapp.net'), '+14155550100');
  });

  test('a mapped LID borrows the phone contact name', () => {
    registerLidMapping('55544433322211@lid', '15550002222@s.whatsapp.net');
    upsertContact({ jid: '15550002222@s.whatsapp.net', name: 'Bea' });
    assert.equal(resolveDisplayName('55544433322211@lid'), 'Bea');
  });
});
