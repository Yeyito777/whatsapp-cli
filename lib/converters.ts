/**
 * Baileys type → StoredX converters.
 *
 * Single source of truth for mapping WhatsApp protocol objects to our
 * domain types. Used by both history sync and real-time event handlers.
 */
import { normalizeMessageContent } from '@whiskeysockets/baileys';
import type { proto } from '@whiskeysockets/baileys';

import type { StoredMessage, StoredChat, StoredContact } from './types.js';

// ─── JID Translation ───────────────────────────────────────

// LID (Linked Identity) → phone JID mapping. WhatsApp sometimes uses
// opaque LID identifiers instead of phone-based JIDs. We cache
// translations as we discover them.
const lidToPhoneMap: Record<string, string> = {};

export function registerLidMapping(lid: string, phone: string): void {
  const lidUser = lid.split('@')[0].split(':')[0];
  const phoneUser = phone.split('@')[0].split(':')[0];
  lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
}

export function translateJid(jid: string): string {
  if (!jid.endsWith('@lid')) return jid;
  const lidUser = jid.split('@')[0].split(':')[0];
  return lidToPhoneMap[lidUser] || jid;
}

// ─── Messages ──────────────────────────────────────────────

export function waMessageToStored(msg: proto.IWebMessageInfo): StoredMessage | null {
  if (!msg.message) return null;

  const normalized = normalizeMessageContent(msg.message);
  if (!normalized) return null;

  const rawJid = msg.key?.remoteJid;
  if (!rawJid || rawJid === 'status@broadcast') return null;

  const chatJid = translateJid(rawJid);

  const content =
    normalized.conversation ||
    normalized.extendedTextMessage?.text ||
    normalized.imageMessage?.caption ||
    normalized.videoMessage?.caption ||
    normalized.documentMessage?.caption ||
    '';

  const mediaType = detectMediaType(normalized);

  // Skip protocol messages with no useful content
  if (!content && !mediaType) return null;

  const mediaCaption =
    normalized.imageMessage?.caption ||
    normalized.videoMessage?.caption ||
    normalized.documentMessage?.caption ||
    null;

  const quotedId = normalized.extendedTextMessage?.contextInfo?.stanzaId || null;

  const sender = msg.key?.participant || msg.key?.remoteJid || '';
  const senderName = msg.pushName || sender.split('@')[0];

  const timestamp = msg.messageTimestamp
    ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
    : new Date().toISOString();

  return {
    id: msg.key?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: chatJid,
    sender_jid: translateJid(sender),
    sender_name: senderName,
    content,
    timestamp,
    is_from_me: msg.key?.fromMe || false,
    media_type: mediaType,
    media_caption: mediaCaption,
    quoted_id: quotedId,
  };
}

function detectMediaType(normalized: proto.IMessage): string | null {
  if (normalized.imageMessage) return 'image';
  if (normalized.videoMessage) return 'video';
  if (normalized.audioMessage) return 'audio';
  if (normalized.documentMessage) return 'document';
  if (normalized.stickerMessage) return 'sticker';
  if (normalized.contactMessage || normalized.contactsArrayMessage) return 'contact';
  if (normalized.locationMessage || normalized.liveLocationMessage) return 'location';
  return null;
}

// ─── Chats ─────────────────────────────────────────────────

/** Convert a Baileys chat object (from sync or upsert) to a StoredChat partial. */
export function baileysChatToStored(c: proto.IConversation & Record<string, unknown>): Partial<StoredChat> & { jid: string } {
  return {
    jid: (c.id as string) || '',
    name: (c.name as string) || '',
    is_group: (c.id as string)?.endsWith('@g.us') || false,
    last_message_time: c.lastMessageRecvTimestamp
      ? new Date(Number(c.lastMessageRecvTimestamp) * 1000).toISOString()
      : '',
    last_message_preview: '',
    unread_count: (c.unreadCount as number) || 0,
    muted: Number(c.muteEndTime || 0) > 0,
    pinned: Number(c.pinned || 0) > 0,
    archived: (c.archived as boolean) || false,
  };
}

// ─── Contacts ──────────────────────────────────────────────

/** Convert a Baileys contact to a StoredContact partial. */
export function baileysContactToStored(c: { id: string; name?: string | null; notify?: string | null; phoneNumber?: string | null }): Partial<StoredContact> & { jid: string } {
  return {
    jid: c.id,
    name: c.name || '',
    notify: c.notify || '',
    phone: c.phoneNumber || c.id.split('@')[0] || '',
  };
}

// ─── JID Resolution ────────────────────────────────────────

/**
 * Resolve a user-provided target (name, phone number, or JID) to a JID.
 * Needs a name→jid lookup function injected to avoid circular deps with db.
 */
export function resolveJid(target: string, findByName: (name: string) => string | undefined): string {
  // Already a JID
  if (target.includes('@')) return target;

  // Phone number → JID
  const digits = target.replace(/[\s\-\+\(\)]/g, '');
  if (/^\d{7,15}$/.test(digits)) return `${digits}@s.whatsapp.net`;

  // Name lookup
  const jid = findByName(target);
  if (jid) return jid;

  throw new Error(`Cannot resolve "${target}" to a WhatsApp JID. Use a phone number or exact chat name.`);
}
