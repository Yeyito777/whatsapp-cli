import { describe, expect, test } from 'bun:test';

import { equivalentJids, registerLidMapping, translateJid } from '../lib/converters.js';

describe('LID mapping', () => {
  test('translates a known LID to its phone JID', () => {
    registerLidMapping('185108912951372@lid', '50765242222@s.whatsapp.net');
    expect(translateJid('185108912951372@lid')).toBe('50765242222@s.whatsapp.net');
  });

  test('returns both stored identities when queried by phone number', () => {
    registerLidMapping('185108912951372@lid', '50765242222@s.whatsapp.net');
    expect(equivalentJids('50765242222@s.whatsapp.net')).toEqual([
      '50765242222@s.whatsapp.net',
      '185108912951372@lid',
    ]);
  });

  test('leaves groups and unknown identities alone', () => {
    expect(equivalentJids('120363000000@g.us')).toEqual([
      '120363000000@g.us',
      '120363000000@g.us',
    ]);
  });
});
