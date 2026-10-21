import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { normalizeMessageContent, type WAMessage } from '@whiskeysockets/baileys';

/** One deadline for download + transcription, so a notification never waits indefinitely. */
export const VOICE_TRANSCRIBE_TIMEOUT_MS = 45_000;

export type TranscribeRunner = (file: string, mimeType: string | null, timeoutMs: number) => Promise<string>;

/** Push-to-talk voice notes, not forwarded songs or other audio files. */
export function isVoiceNote(msg: Pick<WAMessage, 'message'>): boolean {
  return normalizeMessageContent(msg.message ?? undefined)?.audioMessage?.ptt === true;
}

const runTranscribeCli: TranscribeRunner = (file, mimeType, timeoutMs) => new Promise((resolve, reject) => {
  const args = mimeType ? ['--mime-type', mimeType.split(';')[0]!.trim(), file] : [file];
  execFile('transcribe', args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error('voice transcription deadline passed'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('voice transcription deadline passed')), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Download a voice note into a temp dir, transcribe it, and delete it.
 * Returns null on any failure or timeout.
 */
export async function transcribeVoiceNote(
  download: () => Promise<Buffer>,
  mimeType: string | null,
  options: { timeoutMs?: number; run?: TranscribeRunner } = {},
): Promise<string | null> {
  const deadline = Date.now() + (options.timeoutMs ?? VOICE_TRANSCRIBE_TIMEOUT_MS);
  const run = options.run ?? runTranscribeCli;
  let dir: string | null = null;
  try {
    const audio = await withDeadline(download(), deadline);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-voice-'));
    const file = path.join(dir, 'voice-note.ogg');
    fs.writeFileSync(file, audio, { mode: 0o600 });
    const transcript = await withDeadline(run(file, mimeType, Math.max(1, deadline - Date.now())), deadline);
    return transcript.replace(/\s+/g, ' ').trim() || null;
  } catch {
    return null;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}
