/**
 * Repairs to stored history.
 *
 * - Merge LID rows into phone rows: before LID mappings were applied
 *   consistently, the same message could be stored twice (once per identity)
 *   and the same person could appear as two chats/contacts.
 * - Our own DM messages were stored with the recipient as sender.
 *
 * Both are idempotent. The first run backs the database up before touching
 * anything.
 */
import fs from 'fs';
import type { Logger } from 'pino';

import { getDb, kvGet, kvSet } from './db.js';
import { DB_PATH } from './paths.js';

const BACKUP_DONE_KEY = 'migration_backup_v1';

/** One-time online backup next to the DB (0600), before the first repair. */
export async function backupDatabaseOnce(logger: Pick<Logger, 'info' | 'warn'>): Promise<string | null> {
  if (kvGet(BACKUP_DONE_KEY)) return null;
  const target = `${DB_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await getDb().backup(target);
  fs.chmodSync(target, 0o600);
  kvSet(BACKUP_DONE_KEY, target);
  logger.info({ backup: target }, 'Backed up WhatsApp DB before history repairs');
  return target;
}

export interface MergeCounts {
  messagesDeduplicated: number;
  messagesMoved: number;
  sendersRewritten: number;
  chatsMerged: number;
  contactsMerged: number;
  aliasesMoved: number;
}

/** Fold everything stored under `lid` into `pn` (the same person). */
export function mergeLidIdentity(lid: string, pn: string): MergeCounts {
  const db = getDb();
  const p = { lid, pn };
  const run = (sql: string) => db.prepare(sql).run(p).changes;

  return db.transaction((): MergeCounts => {
    // Keep media metadata from the LID copy when the phone copy lacks it.
    run(`
      UPDATE messages SET
        raw_message_json = COALESCE(raw_message_json, (SELECT l.raw_message_json FROM messages l WHERE l.id = messages.id AND l.chat_jid = @lid)),
        media_file_name  = COALESCE(media_file_name,  (SELECT l.media_file_name  FROM messages l WHERE l.id = messages.id AND l.chat_jid = @lid)),
        media_mime_type  = COALESCE(media_mime_type,  (SELECT l.media_mime_type  FROM messages l WHERE l.id = messages.id AND l.chat_jid = @lid))
      WHERE chat_jid = @pn AND id IN (SELECT id FROM messages WHERE chat_jid = @lid)
    `);
    const messagesDeduplicated = run(`DELETE FROM messages WHERE chat_jid = @lid AND id IN (SELECT id FROM messages WHERE chat_jid = @pn)`);
    const messagesMoved = run(`UPDATE messages SET chat_jid = @pn WHERE chat_jid = @lid`);
    const sendersRewritten = run(`UPDATE messages SET sender_jid = @pn WHERE sender_jid = @lid`);

    let chatsMerged = 0;
    const lidChat = db.prepare('SELECT * FROM chats WHERE jid = @lid').get(p) as Record<string, unknown> | undefined;
    if (lidChat) {
      run(`INSERT OR IGNORE INTO chats (jid) VALUES (@pn)`);
      run(`
        UPDATE chats SET
          name = CASE WHEN name = '' THEN (SELECT name FROM chats WHERE jid = @lid) ELSE name END,
          last_message_preview = CASE WHEN (SELECT last_message_time FROM chats WHERE jid = @lid) > last_message_time
            THEN (SELECT last_message_preview FROM chats WHERE jid = @lid) ELSE last_message_preview END,
          last_message_time = MAX(last_message_time, (SELECT last_message_time FROM chats WHERE jid = @lid)),
          unread_count = MAX(unread_count, (SELECT unread_count FROM chats WHERE jid = @lid)),
          pinned = MAX(pinned, (SELECT pinned FROM chats WHERE jid = @lid)),
          ephemeral_expiration = COALESCE(ephemeral_expiration, (SELECT ephemeral_expiration FROM chats WHERE jid = @lid))
        WHERE jid = @pn
      `);
      chatsMerged = run(`DELETE FROM chats WHERE jid = @lid`);
    }

    let contactsMerged = 0;
    const lidContact = db.prepare('SELECT * FROM contacts WHERE jid = @lid').get(p);
    if (lidContact) {
      run(`INSERT OR IGNORE INTO contacts (jid, phone) VALUES (@pn, substr(@pn, 1, instr(@pn, '@') - 1))`);
      run(`
        UPDATE contacts SET
          name   = CASE WHEN name   = '' THEN (SELECT name   FROM contacts WHERE jid = @lid) ELSE name   END,
          notify = CASE WHEN notify = '' THEN (SELECT notify FROM contacts WHERE jid = @lid) ELSE notify END
        WHERE jid = @pn
      `);
      contactsMerged = run(`DELETE FROM contacts WHERE jid = @lid`);
    }

    // Move a LID alias only when the phone JID has none (never overwrite).
    const aliasesMoved = run(`
      UPDATE aliases SET jid = @pn
      WHERE jid = @lid AND NOT EXISTS (SELECT 1 FROM aliases WHERE jid = @pn)
    `);

    return { messagesDeduplicated, messagesMoved, sendersRewritten, chatsMerged, contactsMerged, aliasesMoved };
  })();
}

/** Our own messages (any chat) get our own JID as sender. */
export function normalizeOwnSender(ownJid: string): number {
  return getDb().prepare(`
    UPDATE messages SET sender_jid = @own, sender_name = CASE WHEN sender_name = '' OR sender_name = substr(sender_jid, 1, instr(sender_jid, '@') - 1) THEN 'Me' ELSE sender_name END
    WHERE is_from_me = 1 AND sender_jid != @own
  `).run({ own: ownJid }).changes;
}

/** Run all repairs for the given mappings; returns totals for logging. */
export function repairStoredIdentities(mappings: Array<[string, string]>, ownJid: string | null): MergeCounts & { ownSenders: number } {
  const totals: MergeCounts & { ownSenders: number } = {
    messagesDeduplicated: 0, messagesMoved: 0, sendersRewritten: 0, chatsMerged: 0, contactsMerged: 0, aliasesMoved: 0, ownSenders: 0,
  };
  for (const [lid, pn] of mappings) {
    const counts = mergeLidIdentity(lid, pn);
    for (const key of Object.keys(counts) as Array<keyof MergeCounts>) totals[key] += counts[key];
  }
  if (ownJid) totals.ownSenders = normalizeOwnSender(ownJid);
  return totals;
}
