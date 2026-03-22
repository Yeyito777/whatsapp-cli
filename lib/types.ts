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
  uptime_seconds: number;
  phone_number: string;
  message_count: number;
  chat_count: number;
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
}

// ─── Row → Domain Converters ──────────────────────────────

export function messageFromRow(row: MessageRow): StoredMessage {
  return {
    ...row,
    is_from_me: row.is_from_me === 1,
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
