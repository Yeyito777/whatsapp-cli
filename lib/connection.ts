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
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type WAVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';

import { AUTH_DIR } from './paths.js';
import { loadSecureAuthState } from './auth-state.js';
import { acquireSessionLock, hasLinkedSession, SessionLockedError } from './session-lock.js';
import {
  upsertMessage,
  upsertMessages,
  upsertChat,
  upsertChats,
  upsertContact,
  upsertContacts,
  kvSet,
  kvGet,
  kvDelete,
  getKnownLidJids,
  resolveDisplayName,
} from './db.js';
import {
  waMessageToStored,
  baileysChatToStored,
  baileysContactToStored,
  registerLidMapping,
  translateJid,
  getMessageEphemeralExpiration,
  getOwnJid,
  knownLidMappings,
  learnKeyMappings,
  onNewLidMapping,
  setOwnJid,
} from './converters.js';
import {
  applyHistoryMutations,
  applyMessageUpdates,
  applyReactions,
  type HistoryMessageLike,
  type MessageUpdateLike,
  type ReactionEventLike,
} from './mutations.js';
import { backupDatabaseOnce, mergeLidIdentity, repairStoredIdentities } from './migrations.js';
import { ConnectionReadinessGate } from './readiness.js';
import { backoffDelay, decideOnClose, NETWORK_BACKOFF } from './reconnect-policy.js';
import { HealthMonitor } from './health.js';
import { advanceOutbox, getOutboxEntry, stateForBaileysStatus } from './outbox.js';
import { CatchUpWindow, LIVE_HEARTBEAT_MS, LIVE_UNTIL_KEY, notificationUpsertType } from './catch-up.js';
import {
  publishIncomingMessageNotification,
  publishOwnerAiCommandNotification,
  publishCatchUpSummary,
  shouldPublishIncomingMessage,
  shouldPublishOwnerAiCommand,
} from './notifications.js';
import { isVoiceNote, transcribeVoiceNote } from './transcription.js';

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
let releaseSessionLock: (() => void) | null = null;
let loggingOut = false;
let failureCount = 0;
let conflictCount = 0;
let health: HealthMonitor | null = null;
let catchUp: CatchUpWindow | null = null;
let liveHeartbeat: NodeJS.Timeout | null = null;

function markLive(): void {
  try { kvSet(LIVE_UNTIL_KEY, String(Date.now())); } catch {}
}

function stopLiveHeartbeat(): void {
  if (liveHeartbeat) clearInterval(liveHeartbeat);
  liveHeartbeat = null;
}
let cachedWebVersion: { version: WAVersion | undefined; fetchedAt: number } | null = null;
const WEB_VERSION_TTL_MS = 6 * 60 * 60_000;

let connected = false;
let connectionState: ConnectionState = 'disconnected';
let disconnectReason: number | null = null;
let disconnectReasonName: string | null = null;
let statusMessage: string | null = null;
let actionRequired: string | null = null;
const readiness = new ConnectionReadinessGate('disconnected');

// Baileys is extremely noisy — give it a silent logger
const baileysLogger = pino({ level: 'silent' });

export function getSocket(): WASocket {
  if (!sock) throw new Error('WhatsApp socket not initialized');
  return sock;
}

export function isConnected(): boolean { return connected; }

/** Wait briefly for an in-progress startup/reconnect to become usable. */
export function waitForConnection(timeoutMs = 10_000): Promise<boolean> {
  return readiness.wait(timeoutMs);
}

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

/** Test hook: install a fake socket and mark it connected. */
export function setSocketForTest(fake: WASocket | null): void {
  sock = fake;
  resetConnectionStatus(fake ? 'connected' : 'disconnected');
}

export function prepareForShutdown(): void {
  if (connected) markLive();
  stopLiveHeartbeat();
  stopping = true;
  health?.quiet();
  clearReconnectTimer();
  readiness.cancel();
}

function isCurrentSocket(socketId: number, candidate: WASocket): boolean {
  return socketId === activeSocketId && sock === candidate;
}

function releaseLock(): void {
  releaseSessionLock?.();
  releaseSessionLock = null;
}

/**
 * Unlink this device from the account (it disappears from the phone's Linked
 * Devices), delete the local credentials and stay idle until a new login.
 */
export async function logoutSession(logger: Logger): Promise<{ unlinked: boolean }> {
  loggingOut = true;
  health?.quiet();
  clearReconnectTimer();
  let unlinked = false;
  const current = sock;
  if (current && connected) {
    try {
      await current.logout('Logged out from whatsapp-cli');
      unlinked = true;
    } catch (err) {
      logger.warn({ err }, 'Server-side logout failed; deleting local credentials anyway');
    }
  }
  try { current?.end(undefined); } catch {}
  sock = null;
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  setDisconnectedState('logged_out', DisconnectReason.loggedOut, 'Logged out by request.', 'Run: whatsapp login');
  releaseLock();
  loggingOut = false;
  return { unlinked };
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
  readiness.setState(state);
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
  readiness.setState(state);
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
      failureCount++;
      const delay = backoffDelay(failureCount, NETWORK_BACKOFF);
      logger.error({ err, delayMs: delay }, 'Reconnection failed; retrying');
      health?.disconnected(null, err instanceof Error ? err.message : String(err));
      scheduleReconnect(logger, delay);
    });
  }, delayMs);
  reconnectTimer.unref?.();
}

// ─── Connect ───────────────────────────────────────────────

// Credential saves run one at a time, in order; shutdown waits for them so a
// restart never loses (or half-writes) the latest Signal state.
let credentialWrites: Promise<void> = Promise.resolve();

function queueCredentialSave(saveCreds: () => Promise<void>, logger: Logger): void {
  credentialWrites = credentialWrites
    .then(saveCreds)
    .catch((err) => { logger.error({ err }, 'Failed to save WhatsApp credentials'); });
}

/** Wait (bounded) for queued credential writes; used before exiting. */
export async function flushCredentialWrites(timeoutMs = 3_000): Promise<void> {
  await Promise.race([credentialWrites, new Promise<void>(resolve => setTimeout(resolve, timeoutMs).unref())]);
}

/** The daemon never marks the account online just by connecting. */
export const PRESENCE_SOCKET_OPTIONS = { markOnlineOnConnect: false } as const;

let historyRepaired = false;

/**
 * Merge LID duplicates into phone identities and fix the sender of our own
 * messages, once per process (after a DB backup on the very first run), then
 * keep merging as new mappings are learned.
 */
async function repairHistoryOnce(logger: Logger): Promise<void> {
  if (historyRepaired) return;
  try {
    await backupDatabaseOnce(logger);
    const totals = repairStoredIdentities(knownLidMappings(), getOwnJid());
    logger.info(totals, 'Repaired stored WhatsApp identities');
    onNewLidMapping((lid, pn) => {
      try {
        const counts = mergeLidIdentity(lid, pn);
        if (counts.messagesMoved || counts.messagesDeduplicated || counts.chatsMerged) {
          logger.info({ lid, pn, ...counts }, 'Merged LID history into phone identity');
        }
      } catch (err) {
        logger.warn({ err, lid, pn }, 'Could not merge LID history');
      }
    });
    historyRepaired = true;
  } catch (err) {
    // Never block connecting on a repair; it is retried on the next connect.
    logger.warn({ err }, 'History repair failed; will retry on next connect');
  }
}

/** WA Web version, fetched at most every few hours instead of on every reconnect. */
async function webVersion(logger: Logger): Promise<WAVersion | undefined> {
  if (cachedWebVersion && Date.now() - cachedWebVersion.fetchedAt < WEB_VERSION_TTL_MS) {
    return cachedWebVersion.version;
  }
  const latest = await fetchLatestWaWebVersion({}).catch(() => null);
  if (!latest?.version) {
    logger.warn('Failed to fetch latest WA Web version, using cached/default');
    return cachedWebVersion?.version;
  }
  cachedWebVersion = { version: latest.version, fetchedAt: Date.now() };
  return latest.version;
}

export async function connectWhatsApp(logger: Logger): Promise<void> {
  if (connectPromise) return connectPromise;
  health ??= new HealthMonitor(logger, undefined, undefined, undefined, {
    get: kvGet,
    set: kvSet,
    delete: kvDelete,
  });

  const thisConnect = (async () => {
    stopping = false;
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await loadSecureAuthState(AUTH_DIR, (message, file) => logger.warn({ file }, message));

    // Baileys persists LID↔phone mappings in its auth key store, but it does
    // not replay lid-mapping.update events after a daemon restart. Rehydrate
    // mappings for IDs in local history so phone-number queries still include
    // replies that WhatsApp delivered under their opaque LID identity.
    const knownLids = getKnownLidJids();
    if (knownLids.length > 0) {
      const reverseKeys = knownLids.map(lid => `${lid.split('@')[0].split(':')[0]}_reverse`);
      const mappings = await state.keys.get('lid-mapping', reverseKeys);
      for (let i = 0; i < knownLids.length; i++) {
        const phoneUser = mappings[reverseKeys[i]];
        if (typeof phoneUser === 'string' && phoneUser) {
          registerLidMapping(knownLids[i], `${phoneUser}@s.whatsapp.net`);
        }
      }
    }

    setOwnJid(state.creds.me?.id);
    await repairHistoryOnce(logger);

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
    if (!hasLinkedSession(state.creds)) {
      setDisconnectedState(
        'logged_out',
        DisconnectReason.loggedOut,
        'Not authenticated.',
        'Run: whatsapp login',
      );
      releaseLock();
      health?.loggedOut(null, 'No linked WhatsApp session on this machine.', 'The phone owner must link it: whatsapp login');
      logger.error('Not authenticated. Run: whatsapp login');
      return;
    }

    // Only one process may connect with these credentials (see session-lock).
    if (!releaseSessionLock) {
      try {
        releaseSessionLock = acquireSessionLock('the WhatsApp daemon');
      } catch (err) {
        if (!(err instanceof SessionLockedError)) throw err;
        setDisconnectedState('disconnected', null, `${err.message} Waiting for it to finish.`, null);
        logger.warn({ holder: err.holderPid, role: err.holderRole }, 'Session lock held elsewhere; retrying in 30s');
        scheduleReconnect(logger, 30_000);
        return;
      }
    }

    const version = await webVersion(logger);

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
      ...PRESENCE_SOCKET_OPTIONS,
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

      if (receivedPendingNotifications && catchUp && catchUp.skipped > 0) {
        const skipped = catchUp.skipped;
        void publishCatchUpSummary(skipped, catchUp.sinceMs).catch((err) => {
          logger.warn({ err, skipped }, 'Failed to publish catch-up summary');
        });
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode ?? null;
        const reasonName = disconnectReasonNameFor(reason) ?? 'unknown';

        sock = null;
        clearReconnectTimer();
        if (connected) markLive();
        stopLiveHeartbeat();

        if (stopping || loggingOut) {
          setDisconnectedState('disconnected', reason, 'Daemon shutting down.', null);
          logger.info({ reason, reasonName }, 'Connection closed during shutdown');
          return;
        }

        if (reason === DisconnectReason.connectionReplaced) conflictCount++;
        else failureCount++;
        const decision = decideOnClose(reason, { failures: failureCount, conflicts: conflictCount });

        if (decision.action === 'stop') {
          // Reconnecting cannot fix this and retrying revoked credentials
          // looks abusive; stay up (status keeps answering) and tell the owner.
          releaseLock();
          setDisconnectedState('logged_out', reason, decision.message, decision.actionRequired);
          health?.loggedOut(reason, decision.message, decision.actionRequired);
          logger.warn({ reason, reasonName }, 'Connection closed for good; not reconnecting');
          return;
        }

        setDisconnectedState(decision.state, reason, decision.message, decision.actionRequired);
        if (decision.state === 'conflict') health?.conflict(decision.message, decision.actionRequired);
        else health?.disconnected(reason, `${reasonName} (${reason ?? 'no code'})`);
        logger.info({ reason, reasonName, delayMs: decision.delayMs, failureCount, conflictCount }, 'Connection closed; will reconnect');
        scheduleReconnect(logger, decision.delayMs);
      } else if (connection === 'open') {
        resetConnectionStatus('connected');
        clearReconnectTimer();
        failureCount = 0;
        conflictCount = 0;
        health?.connected();

        // Catch-up window for messages queued while we were away.
        const lastLive = Number(kvGet(LIVE_UNTIL_KEY));
        catchUp = new CatchUpWindow(Number.isFinite(lastLive) && lastLive > 0 ? lastLive : null, Date.now());
        markLive();
        stopLiveHeartbeat();
        liveHeartbeat = setInterval(markLive, LIVE_HEARTBEAT_MS);
        liveHeartbeat.unref?.();
        logger.info('Connected to WhatsApp');

        if (nextSock.user) {
          const phoneUser = nextSock.user.id.split(':')[0];
          const lidUser = nextSock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            registerLidMapping(nextSock.user.lid!, nextSock.user.id);
          }
          kvSet('phone_number', phoneUser);
          setOwnJid(nextSock.user.id);
        }

        // Stay "offline" by default: a headless daemon that announces itself
        // available makes the account look online 24/7 and can stop WhatsApp
        // pushing notifications to the phone.
        nextSock.sendPresenceUpdate('unavailable').catch(() => {});
      }
    });

    nextSock.ev.on('creds.update', () => {
      if (!isCurrentSocket(socketId, nextSock)) return;
      queueCredentialSave(saveCreds, logger);
    });

    // ─── Outgoing message acknowledgements ─────────────────
    // Baileys only surfaces error acks as events, so listen for the raw server
    // ack to tell "written to the socket" apart from "accepted by WhatsApp".

    nextSock.ws.on('CB:ack,class:message', (node: { attrs?: Record<string, string> }) => {
      if (!isCurrentSocket(socketId, nextSock)) return;
      const id = node.attrs?.id;
      if (!id) return;
      if (node.attrs?.error) advanceOutbox(id, 'failed', `WhatsApp error ${node.attrs.error}`);
      else advanceOutbox(id, 'server_ack');
    });

    nextSock.ev.on('messages.update', (updates) => {
      if (!isCurrentSocket(socketId, nextSock)) return;
      const applied = applyMessageUpdates(updates as MessageUpdateLike[]);
      if (applied.edited || applied.deleted) logger.debug(applied, 'Applied message edits/deletes');
      for (const { key, update } of updates) {
        if (!key?.id || !key.fromMe || update.status == null) continue;
        const state = stateForBaileysStatus(update.status);
        if (!state) continue;
        const detail = state === 'failed'
          ? `WhatsApp error ${String(update.messageStubParameters?.[0] ?? 'ack')}`
          : null;
        advanceOutbox(key.id, state, detail);
      }
    });

    nextSock.ev.on('messages.reaction', (reactions) => {
      if (!isCurrentSocket(socketId, nextSock)) return;
      applyReactions(reactions as ReactionEventLike[]);
    });

    nextSock.ev.on('message-receipt.update', (receipts) => {
      if (!isCurrentSocket(socketId, nextSock)) return;
      for (const { key, receipt } of receipts) {
        if (!key?.id || !key.fromMe) continue;
        if (receipt.readTimestamp) advanceOutbox(key.id, 'read');
        else if (receipt.receiptTimestamp) advanceOutbox(key.id, 'delivered');
      }
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
        applyHistoryMutations(messages as HistoryMessageLike[]);
        const stored = messages
          .map(waMessageToStored)
          .filter((m): m is NonNullable<typeof m> => m !== null);
        if (stored.length > 0) {
          upsertMessages(stored);
        }
      }
    });

    // ─── Real-time messages ────────────────────────────────

    nextSock.ev.on('messages.upsert', ({ messages, type }) => {
      if (!isCurrentSocket(socketId, nextSock)) return;

      for (const msg of messages) {
        learnKeyMappings(msg.key as Parameters<typeof learnKeyMappings>[0]);
        const rawChatJid = msg.key?.remoteJid;
        const chatJid = rawChatJid && rawChatJid !== 'status@broadcast' ? translateJid(rawChatJid) : null;
        const ephemeralExpiration = getMessageEphemeralExpiration(msg);
        if (chatJid && ephemeralExpiration !== undefined) {
          upsertChat({ jid: chatJid, ephemeral_expiration: ephemeralExpiration });
        }

        const stored = waMessageToStored(msg);
        if (!stored) {
          applyHistoryMutations([msg as HistoryMessageLike]);
          continue;
        }

        upsertMessage(stored);
        applyHistoryMutations([msg as HistoryMessageLike]);

        upsertChat({
          jid: stored.chat_jid,
          is_group: stored.chat_jid.endsWith('@g.us'),
          last_message_time: stored.timestamp,
          last_message_preview: (stored.content || stored.media_caption || '').slice(0, 100),
          ephemeral_expiration: ephemeralExpiration,
        });

        logger.debug({
          from: stored.sender_name,
          chat: stored.chat_jid,
          preview: stored.content.slice(0, 80),
        }, 'Message received');

        // Baileys uses "notify" for live arrivals and "append" both for
        // history and for messages queued while we were offline. The latter
        // are new, so they publish too when newer than our last-live mark.
        const sentByUs = Boolean(msg.key.id && getOutboxEntry(msg.key.id));
        const timestampMs = Number(msg.messageTimestamp) * 1000;
        const publishType = notificationUpsertType({ upsertType: type, sentByThisClient: sentByUs, timestampMs, window: catchUp });
        if (shouldPublishIncomingMessage({
          upsertType: publishType,
          rawChatJid,
          platformMessageId: msg.key.id,
          isFromMe: stored.is_from_me,
        })) {
          const voiceNote = isVoiceNote(msg) ? msg : null;
          void publishIncomingMessageNotification(stored, resolveDisplayName(stored.chat_jid), {
            ...(voiceNote ? {
              transcribeVoiceNote: () => transcribeVoiceNote(
                () => downloadMediaMessage(voiceNote, 'buffer', {}, {
                  logger,
                  reuploadRequest: (message) => nextSock.updateMediaMessage(message),
                }),
                stored.media_mime_type ?? null,
              ),
            } : {}),
          }).catch((err) => {
            logger.warn({ err, messageId: stored.id, chat: stored.chat_jid }, 'Failed to publish incoming-message notification');
          });
        } else if (shouldPublishOwnerAiCommand({
          upsertType: publishType,
          rawChatJid,
          platformMessageId: msg.key.id,
          isFromMe: stored.is_from_me,
          ownerJid: nextSock.user?.id,
          content: stored.content || stored.media_caption || '',
        })) {
          void publishOwnerAiCommandNotification(
            stored,
            nextSock.user!.id,
            resolveDisplayName(stored.chat_jid),
          ).catch((err) => {
            logger.warn({ err, messageId: stored.id, chat: stored.chat_jid }, 'Failed to publish owner /ai command notification');
          });
        }
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
          jid: translateJid(u.id),
          name: (u as unknown as Record<string, string>).name || '',
          unread_count: u.unreadCount,
          muted: u.muteEndTime != null ? Number(u.muteEndTime) > 0 : undefined,
          pinned: u.pinned != null ? Number(u.pinned) > 0 : undefined,
          archived: u.archived,
          ephemeral_expiration: (u as unknown as { ephemeralExpiration?: number | null }).ephemeralExpiration ?? undefined,
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
