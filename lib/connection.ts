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

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'conflict' | 'logged_out';

export interface ConnectionStatus {
  connected: boolean;
  state: ConnectionState;
  disconnectReason: number | null;
  disconnectReasonName: string | null;
  statusMessage: string | null;
  actionRequired: string | null;
}

// ─── State ─────────────────────────────────────────────────

let sock: WASocket | null = null;
let activeSocketId = 0;
let connectPromise: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let stopping = false;

let connected = false;
let connectionState: ConnectionState = 'disconnected';
let disconnectReason: number | null = null;
let disconnectReasonName: string | null = null;
let statusMessage: string | null = null;
let actionRequired: string | null = null;

// Baileys is extremely noisy — give it a silent logger
const baileysLogger = pino({ level: 'silent' });

export function getSocket(): WASocket {
  if (!sock) throw new Error('WhatsApp socket not initialized');
  return sock;
}

export function isConnected(): boolean { return connected; }

export function getConnectionStatus(): ConnectionStatus {
  return {
    connected,
    state: connectionState,
    disconnectReason,
    disconnectReasonName,
    statusMessage,
    actionRequired,
  };
}

export function prepareForShutdown(): void {
  stopping = true;
  clearReconnectTimer();
}

function isCurrentSocket(socketId: number, candidate: WASocket): boolean {
  return socketId === activeSocketId && sock === candidate;
}

function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function disconnectReasonNameFor(reason: number | null): string | null {
  if (reason == null) return null;
  const name = (DisconnectReason as unknown as Record<number, string>)[reason];
  return typeof name === 'string' ? name : null;
}

function resetConnectionStatus(state: ConnectionState): void {
  connected = state === 'connected';
  connectionState = state;
  disconnectReason = null;
  disconnectReasonName = null;
  statusMessage = null;
  actionRequired = null;
}

function setDisconnectedState(
  state: Extract<ConnectionState, 'disconnected' | 'conflict' | 'logged_out'>,
  reason: number | null,
  message: string,
  action: string | null,
): void {
  connected = false;
  connectionState = state;
  disconnectReason = reason;
  disconnectReasonName = disconnectReasonNameFor(reason);
  statusMessage = message;
  actionRequired = action;
}

function scheduleReconnect(logger: Logger, delayMs: number): void {
  if (reconnectTimer) return;

  logger.info(`Reconnecting in ${Math.round(delayMs / 1000)}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectWhatsApp(logger).catch((err) => {
      logger.error({ err }, 'Reconnection failed, retrying in 10s');
      scheduleReconnect(logger, 10000);
    });
  }, delayMs);
  reconnectTimer.unref?.();
}

// ─── Connect ───────────────────────────────────────────────

export async function connectWhatsApp(logger: Logger): Promise<void> {
  if (connectPromise) return connectPromise;

  const thisConnect = (async () => {
    stopping = false;
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    logger.info({
      authMeId: state.creds.me?.id ?? null,
      authMeLid: state.creds.me?.lid ?? null,
      authName: state.creds.me?.name ?? null,
      registered: state.creds.registered,
      platform: state.creds.platform ?? null,
      accountSyncCounter: state.creds.accountSyncCounter ?? null,
      lastAccountSyncTimestamp: state.creds.lastAccountSyncTimestamp ?? null,
    }, 'Loaded WhatsApp auth state');

    // Check for auth: 'registered' is only true for primary devices.
    // Linked devices (our case) have me.id set instead.
    if (!state.creds.registered && !state.creds.me?.id) {
      setDisconnectedState(
        'logged_out',
        DisconnectReason.loggedOut,
        'Not authenticated.',
        'Run: whatsapp login',
      );
      logger.error('Not authenticated. Run: whatsapp login');
      return;
    }

    const { version } = await fetchLatestWaWebVersion({}).catch(() => {
      logger.warn('Failed to fetch latest WA Web version, using default');
      return { version: undefined };
    });

    const previousSock = sock;
    const socketId = ++activeSocketId;

    clearReconnectTimer();
    resetConnectionStatus('connecting');
    sock = null;

    // Tear down any previous socket before opening a new one so we never keep
    // two live sessions for the same auth state in this process.
    if (previousSock) {
      try { previousSock.end(undefined); } catch {}
    }

    const nextSock = makeWASocket({
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

    sock = nextSock;

    // ─── Connection lifecycle ──────────────────────────────

    nextSock.ev.on('connection.update', (update) => {
      if (!isCurrentSocket(socketId, nextSock)) return;

      const { connection, lastDisconnect, isNewLogin, receivedPendingNotifications, qr } = update;

      logger.info({
        socketId,
        connection: connection ?? null,
        isNewLogin: isNewLogin ?? null,
        receivedPendingNotifications: receivedPendingNotifications ?? null,
        hasQr: Boolean(qr),
        lastDisconnectMessage: lastDisconnect?.error ? String(lastDisconnect.error) : null,
        lastDisconnectData: (lastDisconnect?.error as { data?: unknown } | undefined)?.data ?? null,
        lastDisconnectOutput: (lastDisconnect?.error as { output?: unknown } | undefined)?.output ?? null,
      }, 'connection.update');

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode ?? null;
        const reasonName = disconnectReasonNameFor(reason) ?? 'unknown';

        sock = null;
        clearReconnectTimer();

        if (stopping) {
          setDisconnectedState('disconnected', reason, 'Daemon shutting down.', null);
          logger.info({ reason, reasonName }, 'Connection closed during shutdown');
          return;
        }

        if (reason === DisconnectReason.connectionReplaced) {
          setDisconnectedState(
            'conflict',
            reason,
            'WhatsApp session conflict: this linked-device session was replaced.',
            'Run: whatsapp logout && whatsapp login',
          );
          logger.warn({ reason, reasonName }, 'Connection closed due to session conflict; not reconnecting');
          return;
        }

        if (reason === DisconnectReason.loggedOut) {
          setDisconnectedState(
            'logged_out',
            reason,
            'WhatsApp logged this session out.',
            'Run: whatsapp logout && whatsapp login',
          );
          logger.warn({ reason, reasonName }, 'Connection closed due to logout; not reconnecting');
          return;
        }

        setDisconnectedState('disconnected', reason, 'Connection closed.', null);
        logger.info({ reason, reasonName, shouldReconnect: true }, 'Connection closed');
        scheduleReconnect(logger, 3000);
      } else if (connection === 'open') {
        resetConnectionStatus('connected');
        clearReconnectTimer();
        logger.info('Connected to WhatsApp');

        if (nextSock.user) {
          const phoneUser = nextSock.user.id.split(':')[0];
          const lidUser = nextSock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            registerLidMapping(nextSock.user.lid!, nextSock.user.id);
          }
          kvSet('phone_number', phoneUser);
        }

        nextSock.sendPresenceUpdate('available').catch(() => {});
      }
    });

    nextSock.ev.on('creds.update', () => {
      if (!isCurrentSocket(socketId, nextSock)) return;
      void saveCreds();
    });

    // ─── History sync (older messages) ─────────────────────

    nextSock.ev.on('messaging-history.set', ({ chats, contacts, messages, progress, syncType }) => {
      if (!isCurrentSocket(socketId, nextSock)) return;

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

    nextSock.ev.on('messages.upsert', ({ messages }) => {
      if (!isCurrentSocket(socketId, nextSock)) return;

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

    nextSock.ev.on('chats.upsert', (chats) => {
      if (!isCurrentSocket(socketId, nextSock)) return;
      upsertChats(chats.map(c => baileysChatToStored(c as Record<string, unknown>)));
    });

    nextSock.ev.on('chats.update', (updates) => {
      if (!isCurrentSocket(socketId, nextSock)) return;

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

    nextSock.ev.on('contacts.upsert', (contacts) => {
      if (!isCurrentSocket(socketId, nextSock)) return;
      upsertContacts(contacts.map(baileysContactToStored));
    });

    nextSock.ev.on('contacts.update', (updates) => {
      if (!isCurrentSocket(socketId, nextSock)) return;

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

    nextSock.ev.on('lid-mapping.update', ({ lid, pn }) => {
      if (!isCurrentSocket(socketId, nextSock)) return;
      registerLidMapping(lid, pn);
      logger.debug({ lid, pn }, 'LID mapping updated');
    });
  })();

  connectPromise = thisConnect;
  try {
    await thisConnect;
  } finally {
    if (connectPromise === thisConnect) {
      connectPromise = null;
    }
  }
}
