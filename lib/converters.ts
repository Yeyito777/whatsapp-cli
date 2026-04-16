/**
 * Baileys type → StoredX converters.
 *
 * Single source of truth for mapping WhatsApp protocol objects to our
 * domain types. Used by both history sync and real-time event handlers.
 */
import { normalizeMessageContent, proto } from '@whiskeysockets/baileys';

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
  const media = getMediaInfo(normalized);

  const content =
    normalized.conversation ||
    normalized.extendedTextMessage?.text ||
    media.caption ||
    '';

  // Skip protocol messages with no useful content
  if (!content && !media.type) return null;

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
    media_type: media.type,
    media_caption: media.caption,
    quoted_id: quotedId,
    raw_message_json: isDownloadableMediaType(media.type) ? serializeRawMessage(msg) : null,
    media_file_name: media.fileName,
    media_mime_type: media.mimeType,
  };
}

function isDownloadableMediaType(mediaType: string | null): boolean {
  return mediaType === 'image' ||
    mediaType === 'video' ||
    mediaType === 'audio' ||
    mediaType === 'document' ||
    mediaType === 'sticker';
}

function getMediaInfo(normalized: proto.IMessage): {
  type: string | null;
  caption: string | null;
  fileName: string | null;
  mimeType: string | null;
} {
  if (normalized.imageMessage) {
    return {
      type: 'image',
      caption: normalized.imageMessage.caption || null,
      fileName: null,
      mimeType: normalized.imageMessage.mimetype || null,
    };
  }

  if (normalized.videoMessage) {
    return {
      type: 'video',
      caption: normalized.videoMessage.caption || null,
      fileName: null,
      mimeType: normalized.videoMessage.mimetype || null,
    };
  }

  if (normalized.audioMessage) {
    return {
      type: 'audio',
      caption: null,
      fileName: null,
      mimeType: normalized.audioMessage.mimetype || null,
    };
  }

  if (normalized.documentMessage) {
    return {
      type: 'document',
      caption: normalized.documentMessage.caption || null,
      fileName: normalized.documentMessage.fileName || null,
      mimeType: normalized.documentMessage.mimetype || null,
    };
  }

  if (normalized.stickerMessage) {
    return {
      type: 'sticker',
      caption: null,
      fileName: null,
      mimeType: normalized.stickerMessage.mimetype || 'image/webp',
    };
  }

  if (normalized.contactMessage || normalized.contactsArrayMessage) {
    return {
      type: 'contact',
      caption: null,
      fileName: null,
      mimeType: null,
    };
  }

  if (normalized.locationMessage || normalized.liveLocationMessage) {
    return {
      type: 'location',
      caption: null,
      fileName: null,
      mimeType: null,
    };
  }

  return {
    type: null,
    caption: null,
    fileName: null,
    mimeType: null,
  };
}

export function serializeRawMessage(msg: proto.IWebMessageInfo): string {
  const normalized = proto.WebMessageInfo.fromObject(msg);
  const json = proto.WebMessageInfo.toObject(normalized, {
    longs: String,
    enums: String,
    bytes: String,
    defaults: false,
  });
  return JSON.stringify(json);
}

export function deserializeRawMessage(raw: string): proto.IWebMessageInfo {
  return proto.WebMessageInfo.fromObject(JSON.parse(raw) as Record<string, unknown>);
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
