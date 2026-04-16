import Database from 'better-sqlite3';
import fs from 'fs';

import { CONFIG_DIR, DB_PATH } from './paths.js';
import type {
  StoredMessage,
  StoredChat,
  StoredContact,
  Alias,
  MessageRow,
  ChatRow,
  StoredMediaMessage,
} from './types.js';
import { messageFromRow, chatFromRow, mediaMessageFromRow } from './types.js';

// ─── Initialization ────────────────────────────────────────

let db: Database.Database;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  initSchema();
  prepareStatements();
  return db;
}

function initSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      sender_jid TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      is_from_me INTEGER NOT NULL DEFAULT 0,
      media_type TEXT,
      media_caption TEXT,
      quoted_id TEXT,
      raw_message_json TEXT,
      media_file_name TEXT,
      media_mime_type TEXT,
      PRIMARY KEY (id, chat_jid)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_time
      ON messages(chat_jid, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_messages_content
      ON messages(content);

    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      is_group INTEGER NOT NULL DEFAULT 0,
      last_message_time TEXT NOT NULL DEFAULT '',
      last_message_preview TEXT NOT NULL DEFAULT '',
      unread_count INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS contacts (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      notify TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS aliases (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  ensureColumn('messages', 'raw_message_json', 'TEXT');
  ensureColumn('messages', 'media_file_name', 'TEXT');
  ensureColumn('messages', 'media_mime_type', 'TEXT');
}

function ensureColumn(table: 'messages', column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some(row => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// ─── Prepared Statements ───────────────────────────────────
// All statements are prepared once at init and reused.

let stmts: {
  upsertMessage: Database.Statement;
  getMessages: Database.Statement;
  getMessagesBefore: Database.Statement;
  searchMessages: Database.Statement;
  messageById: Database.Statement;
  messageCount: Database.Statement;
  upsertChat: Database.Statement;
  allChats: Database.Statement;
  groups: Database.Statement;
  chatCount: Database.Statement;
  chatByNameExact: Database.Statement;
  chatByNameFuzzy: Database.Statement;
  upsertContact: Database.Statement;
  allContacts: Database.Statement;
  kvGet: Database.Statement;
  kvSet: Database.Statement;
  chatNameByJid: Database.Statement;
  upsertAlias: Database.Statement;
  deleteAlias: Database.Statement;
  allAliases: Database.Statement;
  aliasByJid: Database.Statement;
  aliasByNameExact: Database.Statement;
  aliasByNameFuzzy: Database.Statement;
  contactByNameExact: Database.Statement;
  contactByNameFuzzy: Database.Statement;
  contactByJid: Database.Statement;
};

function prepareStatements(): void {
  stmts = {
    upsertMessage: db.prepare(`
      INSERT INTO messages (
        id,
        chat_jid,
        sender_jid,
        sender_name,
        content,
        timestamp,
        is_from_me,
        media_type,
        media_caption,
        quoted_id,
        raw_message_json,
        media_file_name,
        media_mime_type
      )
      VALUES (
        @id,
        @chat_jid,
        @sender_jid,
        @sender_name,
        @content,
        @timestamp,
        @is_from_me,
        @media_type,
        @media_caption,
        @quoted_id,
        @raw_message_json,
        @media_file_name,
        @media_mime_type
      )
      ON CONFLICT(id, chat_jid) DO UPDATE SET
        sender_name      = excluded.sender_name,
        content          = excluded.content,
        media_type       = excluded.media_type,
        media_caption    = excluded.media_caption,
        raw_message_json = CASE WHEN excluded.raw_message_json IS NOT NULL THEN excluded.raw_message_json ELSE messages.raw_message_json END,
        media_file_name  = CASE WHEN excluded.media_file_name  IS NOT NULL THEN excluded.media_file_name  ELSE messages.media_file_name  END,
        media_mime_type  = CASE WHEN excluded.media_mime_type  IS NOT NULL THEN excluded.media_mime_type  ELSE messages.media_mime_type  END
    `),

    getMessages: db.prepare(
      `SELECT id, chat_jid, sender_jid, sender_name, content, timestamp, is_from_me, media_type, media_caption, quoted_id
       FROM messages
       WHERE chat_jid = ?
       ORDER BY timestamp DESC
       LIMIT ?`
    ),
    getMessagesBefore: db.prepare(
      `SELECT id, chat_jid, sender_jid, sender_name, content, timestamp, is_from_me, media_type, media_caption, quoted_id
       FROM messages
       WHERE chat_jid = ? AND timestamp < ?
       ORDER BY timestamp DESC
       LIMIT ?`
    ),
    searchMessages: db.prepare(
      `SELECT id, chat_jid, sender_jid, sender_name, content, timestamp, is_from_me, media_type, media_caption, quoted_id
       FROM messages
       WHERE content LIKE ?
       ORDER BY timestamp DESC
       LIMIT ?`
    ),
    messageById: db.prepare(
      `SELECT id, chat_jid, media_type, media_caption, raw_message_json, media_file_name, media_mime_type
       FROM messages
       WHERE id = ?`
    ),
    messageCount: db.prepare('SELECT COUNT(*) as c FROM messages'),

    // Chat upsert: only overwrites fields when the new value is meaningful.
    // Empty strings, 0, and -1 are treated as "no data" and won't clobber existing values.
    upsertChat: db.prepare(`
      INSERT INTO chats (jid, name, is_group, last_message_time, last_message_preview, unread_count, muted, pinned, archived)
      VALUES (@jid, @name, @is_group, @last_message_time, @last_message_preview, @unread_count, @muted, @pinned, @archived)
      ON CONFLICT(jid) DO UPDATE SET
        name                = CASE WHEN excluded.name != ''  THEN excluded.name                ELSE chats.name                END,
        is_group            = CASE WHEN excluded.is_group > 0 THEN excluded.is_group            ELSE chats.is_group            END,
        last_message_time   = CASE WHEN excluded.last_message_time > chats.last_message_time
                                   THEN excluded.last_message_time   ELSE chats.last_message_time   END,
        last_message_preview= CASE WHEN excluded.last_message_time > chats.last_message_time
                                   THEN excluded.last_message_preview ELSE chats.last_message_preview END,
        unread_count        = CASE WHEN excluded.unread_count >= 0 THEN excluded.unread_count   ELSE chats.unread_count        END,
        muted               = CASE WHEN excluded.muted   >= 0 THEN excluded.muted              ELSE chats.muted               END,
        pinned              = CASE WHEN excluded.pinned  >= 0 THEN excluded.pinned             ELSE chats.pinned              END,
        archived            = CASE WHEN excluded.archived >= 0 THEN excluded.archived           ELSE chats.archived            END
    `),
    allChats: db.prepare(
      `SELECT * FROM chats ORDER BY pinned DESC, last_message_time DESC`
    ),
    groups: db.prepare(
      `SELECT * FROM chats WHERE is_group = 1 ORDER BY last_message_time DESC`
    ),
    chatCount: db.prepare('SELECT COUNT(*) as c FROM chats'),
    chatByNameExact: db.prepare(
      `SELECT * FROM chats WHERE LOWER(name) = LOWER(?) LIMIT 1`
    ),
    chatByNameFuzzy: db.prepare(
      `SELECT * FROM chats WHERE LOWER(name) LIKE LOWER(?) ORDER BY last_message_time DESC LIMIT 1`
    ),
    chatNameByJid: db.prepare(
      `SELECT name FROM chats WHERE jid = ?`
    ),

    upsertContact: db.prepare(`
      INSERT INTO contacts (jid, name, notify, phone)
      VALUES (@jid, @name, @notify, @phone)
      ON CONFLICT(jid) DO UPDATE SET
        name   = CASE WHEN excluded.name   != '' THEN excluded.name   ELSE contacts.name   END,
        notify = CASE WHEN excluded.notify != '' THEN excluded.notify ELSE contacts.notify END,
        phone  = CASE WHEN excluded.phone  != '' THEN excluded.phone  ELSE contacts.phone  END
    `),
    allContacts: db.prepare(
      `SELECT * FROM contacts ORDER BY CASE WHEN name != '' THEN name ELSE notify END`
    ),

    kvGet: db.prepare('SELECT value FROM kv WHERE key = ?'),
    kvSet: db.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ),

    upsertAlias: db.prepare(`
      INSERT INTO aliases (jid, name, notes)
      VALUES (@jid, @name, @notes)
      ON CONFLICT(jid) DO UPDATE SET
        name  = excluded.name,
        notes = excluded.notes
    `),
    deleteAlias: db.prepare('DELETE FROM aliases WHERE jid = ?'),
    allAliases: db.prepare('SELECT * FROM aliases ORDER BY name'),
    aliasByJid: db.prepare('SELECT * FROM aliases WHERE jid = ?'),
    aliasByNameExact: db.prepare('SELECT * FROM aliases WHERE LOWER(name) = LOWER(?)'),
    aliasByNameFuzzy: db.prepare('SELECT * FROM aliases WHERE LOWER(name) LIKE LOWER(?)'),
    contactByNameExact: db.prepare(
      `SELECT * FROM contacts WHERE LOWER(name) = LOWER(?) OR LOWER(notify) = LOWER(?) LIMIT 1`
    ),
    contactByNameFuzzy: db.prepare(
      `SELECT * FROM contacts WHERE LOWER(name) LIKE LOWER(?) OR LOWER(notify) LIKE LOWER(?) ORDER BY name LIMIT 1`
    ),
    contactByJid: db.prepare(
      `SELECT name, notify FROM contacts WHERE jid = ?`
    ),
  };
}

// ─── Messages ──────────────────────────────────────────────

function messageToParams(msg: StoredMessage): Record<string, unknown> {
  return {
    id: msg.id,
    chat_jid: msg.chat_jid,
    sender_jid: msg.sender_jid,
    sender_name: msg.sender_name,
    content: msg.content,
    timestamp: msg.timestamp,
    is_from_me: msg.is_from_me ? 1 : 0,
    media_type: msg.media_type || null,
    media_caption: msg.media_caption || null,
    quoted_id: msg.quoted_id || null,
    raw_message_json: msg.raw_message_json || null,
    media_file_name: msg.media_file_name || null,
    media_mime_type: msg.media_mime_type || null,
  };
}

export function upsertMessage(msg: StoredMessage): void {
  stmts.upsertMessage.run(messageToParams(msg));
}

export function upsertMessages(msgs: StoredMessage[]): void {
  const tx = getDb().transaction((messages: StoredMessage[]) => {
    for (const msg of messages) {
      stmts.upsertMessage.run(messageToParams(msg));
    }
  });
  tx(msgs);
}

export function getMessages(chatJid: string, limit = 50, before?: string): StoredMessage[] {
  const rows = before
    ? stmts.getMessagesBefore.all(chatJid, before, limit) as MessageRow[]
    : stmts.getMessages.all(chatJid, limit) as MessageRow[];
  return rows.map(messageFromRow);
}

export function searchMessages(query: string, limit = 50): StoredMessage[] {
  const rows = stmts.searchMessages.all(`%${query}%`, limit) as MessageRow[];
  return rows.map(messageFromRow);
}

export function getMessageMediaById(messageId: string): StoredMediaMessage {
  const rows = stmts.messageById.all(messageId) as MessageRow[];
  if (rows.length === 0) {
    throw new Error(`Message "${messageId}" not found.`);
  }
  if (rows.length > 1) {
    const chats = rows.map(row => row.chat_jid).join(', ');
    throw new Error(`Message ID "${messageId}" is ambiguous across multiple chats: ${chats}`);
  }
  return mediaMessageFromRow(rows[0]);
}

export function getMessageCount(): number {
  return (stmts.messageCount.get() as { c: number }).c;
}

// ─── Chats ─────────────────────────────────────────────────

/**
 * Upsert a chat. Pass `undefined` for fields you don't have data for —
 * they'll be sent as -1 to the SQL, which the CASE guards will ignore.
 */
export function upsertChat(chat: Partial<StoredChat> & { jid: string }): void {
  stmts.upsertChat.run({
    jid: chat.jid,
    name: chat.name || '',
    is_group: chat.is_group === true ? 1 : chat.is_group === false ? 0 : 0,
    last_message_time: chat.last_message_time || '',
    last_message_preview: chat.last_message_preview || '',
    unread_count: chat.unread_count ?? -1,
    muted: chat.muted === true ? 1 : chat.muted === false ? 0 : -1,
    pinned: chat.pinned === true ? 1 : chat.pinned === false ? 0 : -1,
    archived: chat.archived === true ? 1 : chat.archived === false ? 0 : -1,
  });
}

export function upsertChats(chats: Array<Partial<StoredChat> & { jid: string }>): void {
  const tx = getDb().transaction((items: typeof chats) => {
    for (const chat of items) upsertChat(chat);
  });
  tx(chats);
}

export function getAllChats(): StoredChat[] {
  return (stmts.allChats.all() as ChatRow[]).map(chatFromRow);
}

export function getGroups(): StoredChat[] {
  return (stmts.groups.all() as ChatRow[]).map(chatFromRow);
}

export function getChatCount(): number {
  return (stmts.chatCount.get() as { c: number }).c;
}

export function findChatByName(name: string): StoredChat | undefined {
  const exact = stmts.chatByNameExact.get(name) as ChatRow | undefined;
  if (exact) return chatFromRow(exact);

  const fuzzy = stmts.chatByNameFuzzy.get(`%${name}%`) as ChatRow | undefined;
  return fuzzy ? chatFromRow(fuzzy) : undefined;
}

export function getChatName(jid: string): string | undefined {
  const row = stmts.chatNameByJid.get(jid) as { name: string } | undefined;
  return row?.name || undefined;
}

// ─── Contacts ──────────────────────────────────────────────

export function upsertContact(contact: Partial<StoredContact> & { jid: string }): void {
  stmts.upsertContact.run({
    jid: contact.jid,
    name: contact.name || '',
    notify: contact.notify || '',
    phone: contact.phone || '',
  });
}

export function upsertContacts(contacts: Array<Partial<StoredContact> & { jid: string }>): void {
  const tx = getDb().transaction((items: typeof contacts) => {
    for (const c of items) upsertContact(c);
  });
  tx(contacts);
}

export function getAllContacts(): StoredContact[] {
  return stmts.allContacts.all() as StoredContact[];
}

// ─── Aliases ───────────────────────────────────────────────

export function setAlias(jid: string, name: string, notes = ''): void {
  stmts.upsertAlias.run({ jid, name, notes });
}

export function removeAlias(jid: string): boolean {
  return stmts.deleteAlias.run(jid).changes > 0;
}

export function getAllAliases(): Alias[] {
  return stmts.allAliases.all() as Alias[];
}

export function getAliasByJid(jid: string): Alias | undefined {
  return stmts.aliasByJid.get(jid) as Alias | undefined;
}

export function findAliasByName(name: string): Alias | undefined {
  const exact = stmts.aliasByNameExact.get(name) as Alias | undefined;
  if (exact) return exact;
  return stmts.aliasByNameFuzzy.get(`%${name}%`) as Alias | undefined;
}

// ─── Unified Name Resolution ───────────────────────────────

/**
 * Resolve a JID to the best human-readable name.
 * Priority: alias → contact.name → contact.notify → chat.name → phone number
 */
export function resolveDisplayName(jid: string): string {
  // 1. Alias (highest priority — user-defined)
  const alias = stmts.aliasByJid.get(jid) as Alias | undefined;
  if (alias) return alias.name;

  // 2. Contact (server-synced)
  const contactRow = stmts.contactByJid.get(jid) as { name: string; notify: string } | undefined;
  if (contactRow?.name) return contactRow.name;
  if (contactRow?.notify) return contactRow.notify;

  // 3. Chat name (for groups)
  const chatName = getChatName(jid);
  if (chatName) return chatName;

  // 4. Fallback: formatted phone number
  const user = jid.split('@')[0];
  if (/^\d{7,15}$/.test(user)) return `+${user}`;
  return user;
}

/**
 * Resolve a user-provided target (alias, name, phone, JID) to a JID.
 * Priority: alias → chat name → contact name → phone number → raw JID
 */
export function resolveTargetToJid(target: string): string {
  // Already a JID
  if (target.includes('@')) return target;

  // Phone number
  const digits = target.replace(/[\s\-\+\(\)]/g, '');
  if (/^\d{7,15}$/.test(digits)) return `${digits}@s.whatsapp.net`;

  // Alias lookup
  const alias = findAliasByName(target);
  if (alias) return alias.jid;

  // Chat name lookup
  const chat = findChatByName(target);
  if (chat) return chat.jid;

  // Contact name lookup
  const contactExact = stmts.contactByNameExact.get(target, target) as StoredContact | undefined;
  if (contactExact) return contactExact.jid;
  const contactFuzzy = stmts.contactByNameFuzzy.get(`%${target}%`, `%${target}%`) as StoredContact | undefined;
  if (contactFuzzy) return contactFuzzy.jid;

  throw new Error(`Cannot resolve "${target}" to a WhatsApp JID. Use a phone number, alias, or chat name.`);
}

// ─── KV Store ──────────────────────────────────────────────

export function kvGet(key: string): string | undefined {
  const row = stmts.kvGet.get(key) as { value: string } | undefined;
  return row?.value;
}

export function kvSet(key: string, value: string): void {
  stmts.kvSet.run(key, value);
}
