/**
 * One WhatsApp connection per linked-device session.
 *
 * Two processes connecting with the same credentials make WhatsApp drop the
 * older one (440 "conflict"), and both write the same Signal key files. The
 * daemon and `whatsapp login` therefore take this lock before opening a
 * socket; whoever holds it owns the session.
 */
import fs from 'fs';
import path from 'path';

import { CONFIG_DIR } from './paths.js';

export const SESSION_LOCK_FILE = path.join(CONFIG_DIR, 'session.lock');

export class SessionLockedError extends Error {
  constructor(readonly holderPid: number, readonly holderRole: string) {
    super(`WhatsApp session is in use by ${holderRole} (PID ${holderPid}).`);
  }
}

interface LockInfo {
  pid: number;
  role: string;
}

function readLock(): LockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_LOCK_FILE, 'utf-8')) as Partial<LockInfo>;
    if (typeof parsed.pid === 'number' && typeof parsed.role === 'string') return parsed as LockInfo;
  } catch {}
  return null;
}

/** Alive and still a whatsapp-cli process (guards against PID reuse). */
function holderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    return /lib[/\\](daemon|auth)\.ts/.test(cmdline);
  } catch {
    return true; // no /proc: trust the PID
  }
}

/** Who holds the lock, if anyone alive does. */
export function sessionLockHolder(): LockInfo | null {
  const info = readLock();
  if (!info || info.pid === process.pid) return null;
  return holderAlive(info.pid) ? info : null;
}

export function acquireSessionLock(role: string): () => void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(SESSION_LOCK_FILE, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, role }));
      fs.closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (readLock()?.pid === process.pid) fs.rmSync(SESSION_LOCK_FILE, { force: true });
      };
      process.once('exit', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readLock();
      if (holder && holder.pid !== process.pid && holderAlive(holder.pid)) {
        throw new SessionLockedError(holder.pid, holder.role);
      }
      // Stale lock from a dead process.
      fs.rmSync(SESSION_LOCK_FILE, { force: true });
    }
  }
  throw new Error(`Could not acquire ${SESSION_LOCK_FILE}`);
}

/** Linked devices have `me.id`; `registered` is only true for primary phones. */
export function hasLinkedSession(creds: { registered?: boolean; me?: { id?: string } | null }): boolean {
  return Boolean(creds.registered || creds.me?.id);
}
