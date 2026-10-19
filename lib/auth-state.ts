/**
 * Crash-safe, owner-only Baileys auth state.
 *
 * Adapted from Record's src/whatsapp/auth.ts. Baileys' useMultiFileAuthState
 * rewrites files in place (a crash mid-write leaves truncated JSON) and, on a
 * truncated creds.json, silently starts a brand-new unlinked identity. Here:
 *   - every write goes to a 0600 temp file, is fsynced, then renamed over
 *     the old one; the 0700 directory is fsynced;
 *   - a corrupt creds.json is an error (the daemon refuses to start rather
 *     than throwing away the link);
 *   - a corrupt individual key file is treated as missing, as Baileys does,
 *     so one damaged Signal session cannot stop the daemon;
 *   - symlinks and unexpected entries are refused.
 * File names are identical to useMultiFileAuthState's, so existing state
 * loads unchanged.
 */
import { constants } from 'fs';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join } from 'path';

import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys';

export interface AuthStateBundle {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const TEMP_PREFIX = '.wa-auth-';
const fileLocks = new Map<string, Promise<void>>();

type Warn = (message: string, file: string) => void;

function fixedFileName(file: string): string {
  return file.replace(/\//g, '__').replace(/:/g, '-');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Owner-only, flat directory of regular files; fails closed on anything else. */
export async function hardenAuthDirectory(authDirectory: string): Promise<void> {
  await mkdir(authDirectory, { recursive: true, mode: DIRECTORY_MODE });
  const root = await lstat(authDirectory);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error(`Refusing unsafe WhatsApp auth directory: ${authDirectory}`);
  }
  await chmod(authDirectory, DIRECTORY_MODE);
  for (const child of await readdir(authDirectory)) {
    const entry = join(authDirectory, child);
    let info;
    try {
      info = await lstat(entry);
    } catch (error) {
      if (isMissing(error)) continue; // renamed by a concurrent atomic write
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Refusing a symlink in WhatsApp auth state: ${entry}`);
    if (!info.isFile()) throw new Error(`Unexpected entry in WhatsApp auth state: ${entry}`);
    if ((info.mode & 0o777) !== FILE_MODE) await chmod(entry, FILE_MODE);
  }
}

async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  fileLocks.set(path, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (fileLocks.get(path) === current) fileLocks.delete(path);
  }
}

async function assertRegularOrMissing(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing unsafe WhatsApp auth state entry: ${path}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWriteJson(authDirectory: string, file: string, data: unknown): Promise<void> {
  const destination = join(authDirectory, fixedFileName(file));
  await withFileLock(destination, async () => {
    await assertRegularOrMissing(destination);
    const temporary = join(authDirectory, `${TEMP_PREFIX}${randomUUID()}.tmp`);
    let handle;
    try {
      const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, FILE_MODE);
      await handle.writeFile(JSON.stringify(data, BufferJSON.replacer), { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);
      await syncDirectory(authDirectory);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  });
}

/** null when missing; throws on unsafe entries; `onCorrupt` decides about bad JSON. */
async function readJson(authDirectory: string, file: string, onCorrupt: (error: unknown) => null): Promise<unknown | null> {
  const path = join(authDirectory, fixedFileName(file));
  return withFileLock(path, async () => {
    let serialized: string;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing unsafe WhatsApp auth state entry: ${path}`);
      serialized = await readFile(path, 'utf8');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      return JSON.parse(serialized, BufferJSON.reviver);
    } catch (error) {
      return onCorrupt(error);
    }
  });
}

async function removeFile(authDirectory: string, file: string): Promise<void> {
  const path = join(authDirectory, fixedFileName(file));
  await withFileLock(path, async () => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing unsafe WhatsApp auth state entry: ${path}`);
      await unlink(path);
      await syncDirectory(authDirectory);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  });
}

async function removeStaleTemporaryFiles(authDirectory: string): Promise<void> {
  for (const entry of await readdir(authDirectory)) {
    if (!entry.startsWith(TEMP_PREFIX) || !entry.endsWith('.tmp')) continue;
    await unlink(join(authDirectory, entry)).catch((error) => { if (!isMissing(error)) throw error; });
  }
}

export async function loadSecureAuthState(authDirectory: string, warn: Warn = () => {}): Promise<AuthStateBundle> {
  // Temp files first: an interrupted write leaves one behind, and it must not
  // trip the "unexpected entry" checks.
  await mkdir(authDirectory, { recursive: true, mode: DIRECTORY_MODE });
  await removeStaleTemporaryFiles(authDirectory);
  await hardenAuthDirectory(authDirectory);

  const storedCreds = await readJson(authDirectory, 'creds.json', (error) => {
    throw new Error(`WhatsApp credentials (${join(authDirectory, 'creds.json')}) are corrupt; refusing to start a new identity over them: ${String(error)}`);
  });
  const creds = (storedCreds ?? initAuthCreds()) as AuthenticationState['creds'];

  const keys: SignalKeyStore = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      await Promise.all(ids.map(async (id) => {
        const file = `${type}-${id}.json`;
        let value = await readJson(authDirectory, file, () => {
          warn('Corrupt WhatsApp key file treated as missing', file);
          return null;
        }) as SignalDataTypeMap[T] | null;
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value as unknown as Record<string, unknown>) as unknown as SignalDataTypeMap[T];
        }
        if (value != null) result[id] = value;
      }));
      return result;
    },
    set: async (data: SignalDataSet) => {
      const writes: Promise<void>[] = [];
      for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
        const entries = data[category];
        if (!entries) continue;
        for (const [id, value] of Object.entries(entries)) {
          const file = `${category}-${id}.json`;
          writes.push(value == null ? removeFile(authDirectory, file) : atomicWriteJson(authDirectory, file, value));
        }
      }
      await Promise.all(writes);
    },
  };

  return {
    state: { creds, keys },
    saveCreds: () => atomicWriteJson(authDirectory, 'creds.json', creds),
  };
}
