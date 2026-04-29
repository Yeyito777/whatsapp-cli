// ─── IPC Protocol (CLI ↔ Daemon) ───────────────────────────

export interface IpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface IpcResponse {
  id: number;
  result?: unknown;
  error?: string;
}

// ─── Domain Types ──────────────────────────────────────────

export interface StoredMessage {
  id: string;
  chat_jid: string;
  sender_jid: string;
  sender_name: string;
  content: string;
  timestamp: string;       // ISO 8601
  is_from_me: boolean;
  media_type: string | null;
  media_caption: string | null;
  quoted_id: string | null;

  // Internal persistence fields. These are written to the DB when available,
  // but intentionally omitted from normal CLI list/search output.
  raw_message_json?: string | null;
  media_file_name?: string | null;
  media_mime_type?: string | null;
}

export interface StoredChat {
  jid: string;
  name: string;
  is_group: boolean;
  last_message_time: string;
  last_message_preview: string;
  unread_count: number;
  muted: boolean;
  pinned: boolean;
  archived: boolean;

  // WhatsApp disappearing-message duration for this chat, in seconds.
  // null means unknown/off; 0 means explicitly off.
  ephemeral_expiration: number | null;
}

export interface StoredContact {
  jid: string;
  name: string;          // saved contact name
  notify: string;        // push name (name they set for themselves)
  phone: string;         // phone number
}

export interface GroupInfo {
  jid: string;
  name: string;
  description: string;
  participant_count: number;
  participants: GroupParticipant[];
  created_at: string;
  created_by: string;
}

export interface GroupParticipant {
  jid: string;
  name: string;
  admin: boolean;
  super_admin: boolean;
}

export interface Alias {
  jid: string;
  name: string;
  notes: string;
}

export interface DaemonStatus {
  running: boolean;
  connected: boolean;
  connection_state: 'disconnected' | 'connecting' | 'connected' | 'conflict' | 'logged_out';
  disconnect_reason: number | null;
  disconnect_reason_name: string | null;
  status_message: string | null;
  action_required: string | null;
  uptime_seconds: number;
  phone_number: string;
  message_count: number;
  chat_count: number;
}

export interface StoredMediaMessage {
  id: string;
  chat_jid: string;
  media_type: string | null;
  media_caption: string | null;
  raw_message_json: string | null;
  media_file_name: string | null;
  media_mime_type: string | null;
}

// ─── SQLite Row Types ──────────────────────────────────────
// SQLite returns 0/1 for booleans. These represent what actually
// comes back from better-sqlite3 .all()/.get() before normalization.

export interface MessageRow {
  id: string;
  chat_jid: string;
  sender_jid: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: 0 | 1;
  media_type: string | null;
  media_caption: string | null;
  quoted_id: string | null;
  raw_message_json?: string | null;
  media_file_name?: string | null;
  media_mime_type?: string | null;
}

export interface ChatRow {
  jid: string;
  name: string;
  is_group: 0 | 1;
  last_message_time: string;
  last_message_preview: string;
  unread_count: number;
  muted: 0 | 1;
  pinned: 0 | 1;
  archived: 0 | 1;
  ephemeral_expiration: number | null;
}

// ─── Row → Domain Converters ──────────────────────────────

export function messageFromRow(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    chat_jid: row.chat_jid,
    sender_jid: row.sender_jid,
    sender_name: row.sender_name,
    content: row.content,
    timestamp: row.timestamp,
    is_from_me: row.is_from_me === 1,
    media_type: row.media_type,
    media_caption: row.media_caption,
    quoted_id: row.quoted_id,
  };
}

export function mediaMessageFromRow(row: MessageRow): StoredMediaMessage {
  return {
    id: row.id,
    chat_jid: row.chat_jid,
    media_type: row.media_type,
    media_caption: row.media_caption,
    raw_message_json: row.raw_message_json || null,
    media_file_name: row.media_file_name || null,
    media_mime_type: row.media_mime_type || null,
  };
}

export function chatFromRow(row: ChatRow): StoredChat {
  return {
    ...row,
    is_group: row.is_group === 1,
    muted: row.muted === 1,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
  };
}
