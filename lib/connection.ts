/**
 * Baileys WebSocket connection lifecycle and event→DB wiring.
 *
 * Owns the socket, handles connect/reconnect/disconnect, and maps
 * all WhatsApp events into SQLite via the db module.
 */
import fs from 'fs';
import type { Logger } from 'pino';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';

import { AUTH_DIR } from './paths.js';
import {
  upsertMessage,
  upsertMessages,
  upsertChat,
  upsertChats,
  upsertContact,
  upsertContacts,
  kvSet,
} from './db.js';
import {
  waMessageToStored,
  baileysChatToStored,
  baileysContactToStored,
  registerLidMapping,
} from './converters.js';

// ─── State ─────────────────────────────────────────────────

let sock: WASocket;
let connected = false;

// Baileys is extremely noisy — give it a silent logger
const baileysLogger = pino({ level: 'silent' });

export function getSocket(): WASocket { return sock; }
export function isConnected(): boolean { return connected; }

// ─── Connect ───────────────────────────────────────────────

export async function connectWhatsApp(logger: Logger): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // Check for auth: 'registered' is only true for primary devices.
  // Linked devices (our case) have me.id set instead.
  if (!state.creds.registered && !state.creds.me?.id) {
    logger.error('Not authenticated. Run: whatsapp auth');
    process.exit(1);
  }

  const { version } = await fetchLatestWaWebVersion({}).catch(() => {
    logger.warn('Failed to fetch latest WA Web version, using default');
    return { version: undefined };
  });

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    printQRInTerminal: false,
    logger: baileysLogger,
    browser: Browsers.macOS('Chrome'),
    syncFullHistory: true,
  });

  // ─── Connection lifecycle ──────────────────────────────

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      connected = false;
      const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;

      logger.info({ reason, shouldReconnect }, 'Connection closed');

      if (shouldReconnect) {
        logger.info('Reconnecting in 3s...');
        setTimeout(() => connectWhatsApp(logger).catch(err => {
          logger.error({ err }, 'Reconnection failed, retrying in 10s');
          setTimeout(() => connectWhatsApp(logger).catch(() => {}), 10000);
        }), 3000);
      } else {
        logger.info('Logged out. Run: whatsapp auth');
        process.exit(0);
      }
    } else if (connection === 'open') {
      connected = true;
      logger.info('Connected to WhatsApp');

      if (sock.user) {
        const phoneUser = sock.user.id.split(':')[0];
        const lidUser = sock.user.lid?.split(':')[0];
        if (lidUser && phoneUser) {
          registerLidMapping(sock.user.lid!, sock.user.id);
        }
        kvSet('phone_number', phoneUser);
      }

      sock.sendPresenceUpdate('available').catch(() => {});
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ─── History sync (older messages) ─────────────────────

  sock.ev.on('messaging-history.set', ({ chats, contacts, messages, progress, syncType }) => {
    logger.info({
      chatCount: chats.length,
      contactCount: contacts.length,
      messageCount: messages.length,
      progress,
      syncType,
    }, 'History sync received');

    if (contacts.length > 0) {
      upsertContacts(contacts.map(baileysContactToStored));
    }

    if (chats.length > 0) {
      upsertChats(chats.map(c => baileysChatToStored(c as Record<string, unknown>)));
    }

    if (messages.length > 0) {
      const stored = messages
        .map(waMessageToStored)
        .filter((m): m is NonNullable<typeof m> => m !== null);
      if (stored.length > 0) {
        upsertMessages(stored);
      }
    }
  });

  // ─── Real-time messages ────────────────────────────────

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      const stored = waMessageToStored(msg);
      if (!stored) continue;

      upsertMessage(stored);

      upsertChat({
        jid: stored.chat_jid,
        is_group: stored.chat_jid.endsWith('@g.us'),
        last_message_time: stored.timestamp,
        last_message_preview: (stored.content || stored.media_caption || '').slice(0, 100),
      });

      logger.debug({
        from: stored.sender_name,
        chat: stored.chat_jid,
        preview: stored.content.slice(0, 80),
      }, 'Message received');
    }
  });

  // ─── Chat updates ─────────────────────────────────────

  sock.ev.on('chats.upsert', (chats) => {
    upsertChats(chats.map(c => baileysChatToStored(c as Record<string, unknown>)));
  });

  sock.ev.on('chats.update', (updates) => {
    for (const u of updates) {
      if (!u.id) continue;
      upsertChat({
        jid: u.id,
        name: (u as unknown as Record<string, string>).name || '',
        unread_count: u.unreadCount,
        muted: u.muteEndTime != null ? Number(u.muteEndTime) > 0 : undefined,
        pinned: u.pinned != null ? Number(u.pinned) > 0 : undefined,
        archived: u.archived,
      } as Partial<import('./types.js').StoredChat> & { jid: string });
    }
  });

  // ─── Contact updates ──────────────────────────────────

  sock.ev.on('contacts.upsert', (contacts) => {
    upsertContacts(contacts.map(baileysContactToStored));
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const u of updates) {
      if (!u.id) continue;
      upsertContact(baileysContactToStored({
        id: u.id,
        name: u.name,
        notify: u.notify,
      }));
    }
  });

  // ─── LID mapping ──────────────────────────────────────

  sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
    registerLidMapping(lid, pn);
    logger.debug({ lid, pn }, 'LID mapping updated');
  });
}
