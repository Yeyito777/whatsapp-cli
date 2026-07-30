import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { resolve } from 'path';

import {
  PayloadUsageError,
  decodeExactUtf8,
  parseSendStructure,
} from '../lib/payload.js';

const cli = resolve(import.meta.dir, '../bin/whatsapp');

describe('WhatsApp send stdin payloads', () => {
  test('preserves exact UTF-8 without trimming or escape decoding', () => {
    const payload = '  `$HOME` ${USER} \\n\n```json\n{}\n``` 👁️  \n';
    expect(decodeExactUtf8(Buffer.from(payload), 'message text')).toBe(payload);
  });

  test('keeps targets, files, replies, and flags structural in argv', () => {
    expect(parseSendStructure(['Mom', '--reply', 'message-1'])).toEqual({
      target: 'Mom',
      replyTo: 'message-1',
    });
    expect(parseSendStructure(['Mom', '--file', './photo.jpg'])).toEqual({
      target: 'Mom',
      file: './photo.jpg',
    });
  });

  test('rejects legacy inline message and caption forms', () => {
    expect(() => parseSendStructure(['Mom', 'inline message'])).toThrow(
      'message text must be provided via stdin; inline text is not accepted',
    );
    expect(() => parseSendStructure(['Mom', 'inline caption', '--file', 'photo.jpg'])).toThrow(
      'file caption must be provided via stdin; inline text is not accepted',
    );
    expect(() => parseSendStructure(['Mom', '--file', 'photo.jpg', '--caption', 'inline'])).toThrow(
      'file caption must be provided via stdin; --caption is not accepted',
    );
  });

  test('requires text messages but permits captionless files', () => {
    expect(() => decodeExactUtf8(new Uint8Array(), 'message text')).toThrow(
      'message text is required on stdin',
    );
    expect(decodeExactUtf8(new Uint8Array(), 'file caption', { required: false })).toBeUndefined();
  });

  test('rejects invalid UTF-8', () => {
    expect(() => decodeExactUtf8(Uint8Array.of(0xff), 'message text')).toThrow(PayloadUsageError);
    expect(() => decodeExactUtf8(Uint8Array.of(0xff), 'message text')).toThrow(
      'message text on stdin must be valid UTF-8',
    );
  });

  test('CLI rejects inline and missing text before daemon access', () => {
    for (const [args, expected] of [
      [['send', 'Mom', 'inline'], 'message text must be provided via stdin'],
      [['send', 'Mom'], 'message text is required on stdin'],
      [['send', 'Mom', '--file', 'photo.jpg', '--caption', 'inline'], '--caption is not accepted'],
    ] as const) {
      const result = spawnSync(cli, args, { input: '', encoding: 'utf8' });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(expected);
      expect(result.stderr).not.toContain('Daemon not running');
    }
  });

  test('top-level and send help document the stdin contract', () => {
    const top = spawnSync(cli, ['-h'], { encoding: 'utf8' });
    const send = spawnSync(cli, ['send', '-h'], { encoding: 'utf8' });
    expect(top.stdout).toContain('exact UTF-8 message text or file captions from stdin');
    expect(send.stdout).toContain('Message text is required as exact UTF-8 on stdin');
    expect(send.stdout).toContain('stdin is the optional exact caption');
  });
});
