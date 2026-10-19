/**
 * Size-capped daemon log: one live file plus one rotated generation.
 *
 * The daemon used to write every line to daemon.log and to stdout (which the
 * supervisor captures as service.log), with no rotation; both reached ~45 MB.
 */
import fs from 'fs';
import pino from 'pino';

export const MAX_LOG_BYTES = 20 * 1024 * 1024;

export function rotateIfLarge(file: string, maxBytes = MAX_LOG_BYTES): boolean {
  try {
    if (fs.statSync(file).size <= maxBytes) return false;
  } catch {
    return false;
  }
  fs.renameSync(file, `${file}.1`);
  try { fs.chmodSync(`${file}.1`, 0o600); } catch {}
  return true;
}

/**
 * pino logger: info+ to the size-capped file, warn+ to stdout (so the
 * supervisor's service.log only gets what matters). Rotation is checked
 * periodically; the destination is reopened after a rename.
 */
export function createDaemonLogger(file: string, level: string, checkEveryMs = 10 * 60_000): pino.Logger {
  rotateIfLarge(file);
  const destination = pino.destination({ dest: file, sync: true, mkdir: true });
  try { fs.chmodSync(file, 0o600); } catch {}
  const logger = pino({ level }, pino.multistream([
    { level: 'debug', stream: destination },
    { level: 'warn', stream: process.stdout },
  ]));
  const timer = setInterval(() => {
    if (rotateIfLarge(file)) {
      destination.reopen();
      try { fs.chmodSync(file, 0o600); } catch {}
    }
  }, checkEveryMs);
  timer.unref();
  return logger;
}
