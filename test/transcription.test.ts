import fs from 'fs';
import { describe, expect, test } from 'bun:test';

import { isVoiceNote, transcribeVoiceNote } from '../lib/transcription.js';
import {
  formatIncomingMessageNotification,
  incomingMessageNotificationData,
} from '../lib/notifications.js';
import type { StoredMessage } from '../lib/types.js';

const voiceMessage: StoredMessage = {
  id: '3EBVOICE',
  chat_jid: '50760000000@s.whatsapp.net',
  sender_jid: '50760000000@s.whatsapp.net',
  sender_name: 'Mom',
  content: '',
  timestamp: '2026-10-20T12:00:00.000Z',
  is_from_me: false,
  media_type: 'audio',
  media_caption: null,
  quoted_id: null,
};

describe('WhatsApp voice notes', () => {
  test('only push-to-talk audio is a voice note', () => {
    expect(isVoiceNote({ message: { audioMessage: { ptt: true } } })).toBe(true);
    expect(isVoiceNote({ message: { ephemeralMessage: { message: { audioMessage: { ptt: true } } } } })).toBe(true);
    expect(isVoiceNote({ message: { audioMessage: { ptt: false } } })).toBe(false);
    expect(isVoiceNote({ message: { conversation: 'hi' } })).toBe(false);
  });

  test('notification carries the transcript, or a failure line, instead of [audio]', () => {
    const lines = (transcript: string | null) =>
      formatIncomingMessageNotification(voiceMessage, 'Mom', transcript).split('\n').slice(2);
    expect(lines('Call me when you land')).toEqual([
      '→ Mom <50760000000@s.whatsapp.net>:',
      '🎤 Call me when you land',
      '[msg:3EBVOICE]',
    ]);
    expect(lines(null)[1]).toBe('🎤 voice message (transcription failed)');
    expect(formatIncomingMessageNotification(voiceMessage, 'Mom')).toContain('\n[audio]\n');
    expect(incomingMessageNotificationData(voiceMessage, 'Mom', 'hi')).toMatchObject({
      content: '🎤 hi',
      media: { type: 'audio', voiceNote: true, transcript: 'hi' },
    });
  });

  test('transcribes via a temp file that is removed afterwards', async () => {
    let seen = '';
    const transcript = await transcribeVoiceNote(async () => Buffer.from('OggS'), 'audio/ogg; codecs=opus', {
      run: async (file, mimeType, timeoutMs) => {
        seen = file;
        expect(fs.readFileSync(file).toString()).toBe('OggS');
        expect(mimeType).toBe('audio/ogg; codecs=opus');
        expect(timeoutMs).toBeLessThanOrEqual(45_000);
        return ' hello\nthere \n';
      },
    });
    expect(transcript).toBe('hello there');
    expect(fs.existsSync(seen)).toBe(false);
  });

  test('failures and timeouts return null', async () => {
    const audio = async () => Buffer.from('OggS');
    expect(await transcribeVoiceNote(async () => { throw new Error('404'); }, null, { run: async () => 'x' })).toBeNull();
    expect(await transcribeVoiceNote(audio, null, { run: async () => { throw new Error('exit 1'); } })).toBeNull();
    expect(await transcribeVoiceNote(audio, null, { run: async () => '   ' })).toBeNull();
    const started = Date.now();
    expect(await transcribeVoiceNote(audio, null, { timeoutMs: 50, run: () => new Promise(() => {}) })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
