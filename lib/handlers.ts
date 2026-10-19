/**
 * IPC command handlers — maps incoming method calls to actions.
 */
import fs from 'fs';
import path from 'path';
import type { Logger } from 'pino';
import { downloadMediaMessage, type AnyMessageContent, type WAMessage } from '@whiskeysockets/baileys';

import {
  getMessagesForJids,
  searchMessages,
  getAllChats,
  getGroups,
  getAllContacts,
  getMessageCount,
  getChatCount,
  getMessageMediaById,
  upsertMessage,
  upsertChat,
  kvGet,
  getChatEphemeralExpiration,
  hasLocalChat,
  getAllAliases,
  setAlias,
  removeAlias,
  findAliasesByExactName,
  resolveDisplayName,
} from './db.js';
import { describeMatch, resolveTarget, type ResolvedTarget } from './resolve.js';
import { getSocket, getConnectionStatus, isConnected, logoutSession, waitForConnection } from './connection.js';
import { deserializeRawMessage, equivalentJids, waMessageToStored } from './converters.js';
import {
  advanceOutbox,
  generateOutgoingMessageId,
  getOutboxEntry,
  isSentState,
  isValidOutgoingMessageId,
  listOutbox,
  recordSending,
  waitForOutboxState,
  type OutboxEntry,
} from './outbox.js';
import type {
  IpcRequest,
  IpcResponse,
  StoredMessage,
  Alias,
  DaemonStatus,
  GroupInfo,
  GroupParticipant,
} from './types.js';

let startTime: number;
let logger: Logger;

export function initHandlers(log: Logger): void {
  startTime = Date.now();
  logger = log;
}

// ─── Target resolution ─────────────────────────────────────

function resolve(target: string): string {
  return resolveTarget(target).jid;
}

/**
 * Resolve a send target. A bare phone number that has no local chat history is
 * checked against WhatsApp first so a typo or a non-WhatsApp number fails
 * instead of silently going nowhere (or to a stranger).
 */
async function resolveSendTarget(target: string): Promise<ResolvedTarget> {
  const resolved = resolveTarget(target);
  if (resolved.match !== 'phone' || hasLocalChat(resolved.jid)) return resolved;
  const results = await withTimeout(getSocket().onWhatsApp(resolved.jid), METADATA_TIMEOUT_MS, 'WhatsApp number lookup');
  const hit = results?.find(r => r.exists);
  if (!hit) throw new Error(`${resolved.jid} is not a WhatsApp account; nothing was sent.`);
  return resolved;
}

function targetSummary(resolved: ResolvedTarget): { jid: string; name: string; match: string } {
  return { jid: resolved.jid, name: resolved.name, match: describeMatch(resolved.match) };
}

const CONNECTION_READY_TIMEOUT_MS = 10_000;
const METADATA_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function requireConnected(req: IpcRequest): Promise<IpcResponse | null> {
  if (await waitForConnection(CONNECTION_READY_TIMEOUT_MS)) return null;

  const status = getConnectionStatus();
  const parts = ['Not connected to WhatsApp'];
  if (status.statusMessage) parts.push(status.statusMessage);
  if (status.actionRequired) parts.push(status.actionRequired);

  return { id: req.id, error: parts.join('. ') };
}

// ─── Dispatch ──────────────────────────────────────────────

export async function handleCommand(req: IpcRequest): Promise<IpcResponse> {
  try {
    const { method, params } = req;

    switch (method) {
      case 'status':        return cmdStatus(req);
      case 'chats':         return cmdChats(req);
      case 'groups':        return cmdGroups(req);
      case 'contacts':      return cmdContacts(req);
      case 'messages':      return cmdMessages(req, params);
      case 'search':        return cmdSearch(req, params);
      case 'send':          return await cmdSend(req, params);
      case 'send_file':     return await cmdSendFile(req, params);
      case 'download_media':return await cmdDownloadMedia(req, params);
      case 'typing':        return await cmdTyping(req, params);
      case 'mark_read':     return await cmdMarkRead(req, params);
      case 'group_info':    return await cmdGroupInfo(req, params);
      case 'sync_groups':   return await cmdSyncGroups(req);
      case 'alias_list':    return cmdAliasList(req);
      case 'alias_set':     return cmdAliasSet(req, params);
      case 'alias_remove':  return cmdAliasRemove(req, params);
      case 'context':       return cmdContext(req);
      case 'resolve':       return cmdResolve(req, params);
      case 'outbox':        return cmdOutbox(req, params);
      case 'ping':          return { id: req.id, result: 'pong' };
      case 'shutdown':      return cmdShutdown(req);
      case 'logout':        return { id: req.id, result: await logoutSession(logger) };
      default:
        return { id: req.id, error: `Unknown method: ${method}` };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, method: req.method }, 'Command error');
    return { id: req.id, error: message };
  }
}

// ─── Read commands (no connection required) ────────────────

function cmdStatus(req: IpcRequest): IpcResponse {
  const conn = getConnectionStatus();
  const status: DaemonStatus = {
    running: true,
    connected: conn.connected,
    connection_state: conn.state,
    disconnect_reason: conn.disconnectReason,
    disconnect_reason_name: conn.disconnectReasonName,
    status_message: conn.statusMessage,
    action_required: conn.actionRequired,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    phone_number: kvGet('phone_number') || '',
    message_count: getMessageCount(),
    chat_count: getChatCount(),
  };
  return { id: req.id, result: status };
}

function cmdChats(req: IpcRequest): IpcResponse {
  return { id: req.id, result: getAllChats() };
}

function cmdGroups(req: IpcRequest): IpcResponse {
  return { id: req.id, result: getGroups() };
}

function cmdContacts(req: IpcRequest): IpcResponse {
  return { id: req.id, result: getAllContacts() };
}

function cmdMessages(req: IpcRequest, params?: Record<string, unknown>): IpcResponse {
  const target = params?.target as string;
  if (!target) return { id: req.id, error: 'Missing target (JID or name)' };

  const resolved = resolveTarget(target);
  const [primaryJid, alternateJid] = equivalentJids(resolved.jid);
  const limit = (params?.limit as number) || 50;
  const before = params?.before as string | undefined;
  const msgs = getMessagesForJids(primaryJid, alternateJid, limit, before);
  return { id: req.id, result: { chat: targetSummary(resolved), messages: msgs.reverse() } };
}

function cmdSearch(req: IpcRequest, params?: Record<string, unknown>): IpcResponse {
  const query = params?.query as string;
  if (!query) return { id: req.id, error: 'Missing search query' };
  const limit = (params?.limit as number) || 50;
  return { id: req.id, result: searchMessages(query, limit) };
}

// ─── Write commands (connection required) ──────────────────

async function sendOptionsForChat(jid: string): Promise<Record<string, unknown> | undefined> {
  const cachedExpiration = getChatEphemeralExpiration(jid);
  if (cachedExpiration && cachedExpiration > 0) {
    return { ephemeralExpiration: cachedExpiration };
  }

  // If the cache has no setting yet, group metadata can provide it on demand.
  // There is no equivalent public metadata query for 1:1 chats in Baileys.
  if (cachedExpiration == null && jid.endsWith('@g.us')) {
    try {
      const metadata = await withTimeout(getSocket().groupMetadata(jid), METADATA_TIMEOUT_MS, 'group metadata');
      const metadataExpiration = metadata.ephemeralDuration;
      if (metadataExpiration != null) {
        upsertChat({ jid, ephemeral_expiration: metadataExpiration });
        if (metadataExpiration > 0) {
          return { ephemeralExpiration: metadataExpiration };
        }
      }
    } catch {
      // Best-effort only. Sending should not fail just because metadata lookup did.
    }
  }

  return undefined;
}

const SERVER_ACK_WAIT_MS = Number(process.env.WHATSAPP_CLI_ACK_WAIT_MS) || 8_000;

interface SendRequest {
  messageId: string;
  resolved: ResolvedTarget;
  kind: OutboxEntry['kind'];
  content: AnyMessageContent;
  /** Local copy stored once the message is written (text sends). */
  stored?: (sent: WAMessage) => StoredMessage | null;
}

/**
 * Send with a pre-assigned message ID recorded in the outbox first. A repeat
 * of an ID that already reached WhatsApp returns the recorded outcome without
 * sending again.
 */
async function performSend(req: IpcRequest, send: SendRequest): Promise<IpcResponse> {
  const { messageId, resolved } = send;
  const existing = getOutboxEntry(messageId);
  if (existing && existing.chat_jid !== resolved.jid) {
    return { id: req.id, error: `Message ID ${messageId} was already used for ${existing.chat_jid}; nothing was sent.` };
  }
  if (existing && (isSentState(existing.state) || existing.state === 'sending')) {
    return { id: req.id, result: sendResult(existing, resolved, true) };
  }

  recordSending(messageId, resolved.jid, send.kind);
  let sent: WAMessage | undefined;
  try {
    const options = { ...(await sendOptionsForChat(resolved.jid)), messageId };
    sent = await getSocket().sendMessage(resolved.jid, send.content, options);
  } catch (err) {
    // Baileys throws before the stanza is written (encryption, device lookup,
    // media upload, socket closed): nothing reached WhatsApp.
    const message = err instanceof Error ? err.message : String(err);
    advanceOutbox(messageId, 'failed', message);
    return { id: req.id, error: `Not sent (${message}).` };
  }

  advanceOutbox(messageId, 'written');
  if (sent && send.stored) {
    const stored = send.stored(sent);
    if (stored) upsertMessage(stored);
  }

  const entry = await waitForOutboxState(messageId, 'server_ack', SERVER_ACK_WAIT_MS);
  if (entry?.state === 'failed') {
    return { id: req.id, error: `WhatsApp rejected the message (${entry.error ?? 'error ack'}).` };
  }
  return { id: req.id, result: sendResult(entry ?? getOutboxEntry(messageId)!, resolved, false) };
}

function sendResult(entry: OutboxEntry, resolved: ResolvedTarget, duplicate: boolean): Record<string, unknown> {
  return {
    status: entry.state,
    id: entry.id,
    jid: resolved.jid,
    chat: targetSummary(resolved),
    duplicate,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function requestMessageId(params?: Record<string, unknown>): string {
  const provided = params?.message_id;
  if (provided === undefined) return generateOutgoingMessageId();
  if (typeof provided !== 'string' || !isValidOutgoingMessageId(provided)) {
    throw new Error('Invalid message ID (expected 8-64 letters/digits).');
  }
  return provided;
}

async function cmdSend(req: IpcRequest, params?: Record<string, unknown>): Promise<IpcResponse> {
  const err = await requireConnected(req);
  if (err) return err;

  const target = params?.target as string;
  const text = params?.text as string;
  if (!target) return { id: req.id, error: 'Missing target (JID or name)' };
  if (!text) return { id: req.id, error: 'Missing message text' };

  const messageId = requestMessageId(params);
  const resolved = await resolveSendTarget(target);
  const replyTo = params?.reply_to as string | undefined;
  const content: Record<string, unknown> = { text };
  if (replyTo) {
    content.contextInfo = {
      stanzaId: replyTo,
      participant: resolved.jid.endsWith('@g.us') ? undefined : resolved.jid,
    };
  }

  return performSend(req, {
    messageId,
    resolved,
    kind: 'text',
    content: content as AnyMessageContent,
    stored: (sent) => waMessageToStored(sent),
  });
}

async function cmdSendFile(req: IpcRequest, params?: Record<string, unknown>): Promise<IpcResponse> {
  const err = await requireConnected(req);
  if (err) return err;

  const target = params?.target as string;
  const filePath = params?.file as string;
  const caption = (params?.caption as string) || undefined;
  if (!target) return { id: req.id, error: 'Missing target' };
  if (!filePath) return { id: req.id, error: 'Missing file path' };
  if (!fs.existsSync(filePath)) return { id: req.id, error: `File not found: ${filePath}` };

  const messageId = requestMessageId(params);
  const resolved = await resolveSendTarget(target);
  const buf = await fs.promises.readFile(filePath);
  return performSend(req, {
    messageId,
    resolved,
    kind: 'file',
    content: buildFilePayload(filePath, buf, caption) as unknown as AnyMessageContent,
  });
}

async function cmdDownloadMedia(req: IpcRequest, params?: Record<string, unknown>): Promise<IpcResponse> {
  const err = await requireConnected(req);
  if (err) return err;

  const messageId = params?.message_id as string;
  const outDir = params?.outdir as string;
  if (!messageId) return { id: req.id, error: 'Missing message ID' };
  if (!outDir) return { id: req.id, error: 'Missing output directory' };

  const mediaMsg = getMessageMediaById(messageId);
  if (!isDownloadableMediaType(mediaMsg.media_type)) {
    return { id: req.id, error: `Message "${messageId}" does not have downloadable media.` };
  }
  if (!mediaMsg.raw_message_json) {
    return {
      id: req.id,
      error: `Media metadata for message "${messageId}" is unavailable. The message may have been stored before media-download support was added.`,
    };
  }

  ensureDirectory(outDir);

  const sock = getSocket();
  const rawMessage = deserializeRawMessage(mediaMsg.raw_message_json) as WAMessage;
  const buffer = await downloadMediaMessage(rawMessage, 'buffer', {}, {
    logger,
    reuploadRequest: (message) => sock.updateMediaMessage(message),
  });

  const fileName = buildMediaFileName({
    messageId,
    mediaType: mediaMsg.media_type,
    originalFileName: mediaMsg.media_file_name,
    mimeType: mediaMsg.media_mime_type,
  });
  const outputPath = uniquePath(path.join(outDir, fileName));

  fs.writeFileSync(outputPath, buffer);

  logger.info({ messageId, outputPath, bytes: buffer.length }, 'Media downloaded');

  return {
    id: req.id,
    result: {
      status: 'downloaded',
      message_id: messageId,
      chat_jid: mediaMsg.chat_jid,
      media_type: mediaMsg.media_type,
      mime_type: mediaMsg.media_mime_type,
      file_name: path.basename(outputPath),
      path: outputPath,
      size_bytes: buffer.length,
    },
  };
}

function isDownloadableMediaType(mediaType: string | null): boolean {
  return mediaType === 'image' ||
    mediaType === 'video' ||
    mediaType === 'audio' ||
    mediaType === 'document' ||
    mediaType === 'sticker';
}

function buildFilePayload(filePath: string, buf: Buffer, caption?: string): Record<string, unknown> {
  const ext = path.extname(filePath).toLowerCase();

  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
  const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv']);
  const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.m4a', '.wav', '.opus']);

  if (IMAGE_EXTS.has(ext)) return { image: buf, caption };
  if (VIDEO_EXTS.has(ext)) return { video: buf, caption };
  if (AUDIO_EXTS.has(ext)) return { audio: buf, mimetype: 'audio/mp4', ptt: false };
  return {
    document: buf,
    fileName: path.basename(filePath),
    mimetype: 'application/octet-stream',
    caption,
  };
}

function ensureDirectory(outDir: string): void {
  if (fs.existsSync(outDir) && !fs.statSync(outDir).isDirectory()) {
    throw new Error(`Output path is not a directory: ${outDir}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
}

function buildMediaFileName(args: {
  messageId: string;
  mediaType: string | null;
  originalFileName: string | null;
  mimeType: string | null;
}): string {
  const requestedName = sanitizeFileName(args.originalFileName || '');
  if (requestedName) {
    return requestedName;
  }

  const ext = extensionForMime(args.mimeType) || extensionForMediaType(args.mediaType);
  return `wa-${args.messageId}${ext}`;
}

function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return base.replace(/^\.+$/, '').trim();
}

function extensionForMediaType(mediaType: string | null): string {
  switch (mediaType) {
    case 'image': return '.jpg';
    case 'video': return '.mp4';
    case 'audio': return '.ogg';
    case 'document': return '.bin';
    case 'sticker': return '.webp';
    default: return '';
  }
}

function extensionForMime(mimeType: string | null): string {
  const normalized = mimeType?.split(';')[0]?.trim().toLowerCase();
  if (!normalized) return '';

  const known: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'audio/ogg': '.ogg',
    'audio/ogg; codecs=opus': '.ogg',
    'audio/mp4': '.m4a',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'text/plain': '.txt',
  };

  if (known[normalized]) return known[normalized];

  const subtype = normalized.split('/')[1];
  if (!subtype) return '';

  const ext = subtype.split('+')[0].replace(/^x-/, '');
  return /^[a-z0-9.-]+$/.test(ext) ? `.${ext}` : '';
}

function uniquePath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath;

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);

  for (let i = 2; i < 10_000; i++) {
    const candidate = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`Could not allocate output file name in ${dir}`);
}

async function cmdTyping(req: IpcRequest, params?: Record<string, unknown>): Promise<IpcResponse> {
  const err = await requireConnected(req);
  if (err) return err;

  const target = params?.target as string;
  const on = params?.on as boolean;
  if (!target) return { id: req.id, error: 'Missing target' };

  const jid = resolve(target);
  await getSocket().sendPresenceUpdate(on ? 'composing' : 'paused', jid);
  return { id: req.id, result: { status: on ? 'typing' : 'paused', jid } };
}

async function cmdMarkRead(req: IpcRequest, params?: Record<string, unknown>): Promise<IpcResponse> {
  const err = await requireConnected(req);
  if (err) return err;

  const target = params?.target as string;
  if (!target) return { id: req.id, error: 'Missing target' };

  const jid = resolve(target);
  const [primaryJid, alternateJid] = equivalentJids(jid);
  const lastMsgs = getMessagesForJids(primaryJid, alternateJid, 1);
  if (lastMsgs.length > 0) {
    await getSocket().readMessages([{ remoteJid: lastMsgs[0].chat_jid, id: lastMsgs[0].id }]);
  }
  return { id: req.id, result: { status: 'read', jid } };
}

async function cmdGroupInfo(req: IpcRequest, params?: Record<string, unknown>): Promise<IpcResponse> {
  const err = await requireConnected(req);
  if (err) return err;

  const target = params?.target as string;
  if (!target) return { id: req.id, error: 'Missing target' };

  const jid = resolve(target);
  if (!jid.endsWith('@g.us')) return { id: req.id, error: 'Not a group JID' };

  const metadata = await getSocket().groupMetadata(jid);
  upsertChat({
    jid,
    name: metadata.subject || '',
    is_group: true,
    ephemeral_expiration: metadata.ephemeralDuration ?? undefined,
  });
  const info: GroupInfo = {
    jid,
    name: metadata.subject || '',
    description: metadata.desc || '',
    participant_count: metadata.participants.length,
    participants: metadata.participants.map((p): GroupParticipant => ({
      jid: p.id,
      name: p.name || p.notify || resolveDisplayName(p.id),
      admin: p.admin === 'admin' || p.admin === 'superadmin',
      super_admin: p.admin === 'superadmin',
    })),
    created_at: metadata.creation ? new Date(metadata.creation * 1000).toISOString() : '',
    created_by: metadata.owner || '',
  };
  return { id: req.id, result: info };
}

async function cmdSyncGroups(req: IpcRequest): Promise<IpcResponse> {
  const err = await requireConnected(req);
  if (err) return err;

  const groups = await getSocket().groupFetchAllParticipating();
  let count = 0;
  for (const [jid, metadata] of Object.entries(groups)) {
    if (metadata.subject) {
      upsertChat({
        jid,
        name: metadata.subject,
        is_group: true,
        ephemeral_expiration: metadata.ephemeralDuration ?? undefined,
      });
      count++;
    }
  }
  return { id: req.id, result: { synced: count } };
}

// ─── Alias commands (no connection required) ───────────────

function cmdAliasList(req: IpcRequest): IpcResponse {
  return { id: req.id, result: getAllAliases() };
}

function cmdAliasSet(req: IpcRequest, params?: Record<string, unknown>): IpcResponse {
  const target = (params?.target as string) || (params?.jid as string);
  const name = (params?.name as string)?.trim();
  const notes = (params?.notes as string) || '';
  if (!target || !name) return { id: req.id, error: 'Missing target or name' };
  const resolved = resolveTarget(target);
  if (resolved.match !== 'jid' && resolved.match !== 'phone') {
    return { id: req.id, error: `Alias targets must be a phone number or JID (got ${describeMatch(resolved.match)} match for ${resolved.name} ${resolved.jid}).` };
  }
  const clashes = findAliasesByExactName(name).filter(alias => alias.jid !== resolved.jid);
  if (clashes.length > 0) {
    return { id: req.id, error: `Alias "${name}" already points to ${clashes.map(a => a.jid).join(', ')}. Remove it first.` };
  }
  setAlias(resolved.jid, name, notes);
  return { id: req.id, result: { jid: resolved.jid, name, notes } };
}

function cmdAliasRemove(req: IpcRequest, params?: Record<string, unknown>): IpcResponse {
  const target = params?.target as string;
  if (!target) return { id: req.id, error: 'Missing target (alias name or JID)' };

  // Try as JID first, then as alias name
  let jid = target;
  if (!target.includes('@')) {
    const aliases = findAliasesByExactName(target);
    if (aliases.length === 0) return { id: req.id, error: `Alias "${target}" not found` };
    if (aliases.length > 1) return { id: req.id, error: `Alias "${target}" is ambiguous: ${aliases.map(a => a.jid).join(', ')}. Remove by JID.` };
    jid = aliases[0].jid;
  }

  const removed = removeAlias(jid);
  if (!removed) return { id: req.id, error: `No alias for ${jid}` };
  return { id: req.id, result: { removed: jid } };
}

function cmdResolve(req: IpcRequest, params?: Record<string, unknown>): IpcResponse {
  const target = params?.target as string;
  if (!target) return { id: req.id, error: 'Missing target' };
  return { id: req.id, result: targetSummary(resolveTarget(target)) };
}

// ─── Context command ───────────────────────────────────────

function cmdContext(req: IpcRequest): IpcResponse {
  const aliases = getAllAliases();
  const chats = getAllChats();
  const phoneNumber = kvGet('phone_number') || '';

  // Recent DMs (non-group chats with recent activity)
  const recentDms = chats
    .filter(c => !c.is_group && c.last_message_time)
    .slice(0, 15)
    .map(c => ({
      name: resolveDisplayName(c.jid),
      jid: c.jid,
      last_message_time: c.last_message_time,
      last_message_preview: c.last_message_preview,
      unread_count: c.unread_count,
    }));

  // Recent groups
  const recentGroups = chats
    .filter(c => c.is_group && c.last_message_time)
    .slice(0, 10)
    .map(c => ({
      name: c.name || resolveDisplayName(c.jid),
      jid: c.jid,
      last_message_time: c.last_message_time,
      last_message_preview: c.last_message_preview,
      unread_count: c.unread_count,
    }));

  return {
    id: req.id,
    result: {
      account: {
        phone_number: phoneNumber,
        connected: isConnected(),
        uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
        message_count: getMessageCount(),
        chat_count: getChatCount(),
      },
      aliases,
      recent_dms: recentDms,
      recent_groups: recentGroups,
    },
  };
}

function cmdOutbox(req: IpcRequest, params?: Record<string, unknown>): IpcResponse {
  const id = params?.id as string | undefined;
  if (id) {
    const entry = getOutboxEntry(id);
    if (!entry) return { id: req.id, error: `No outgoing message with ID ${id} (it never reached the daemon).` };
    return { id: req.id, result: { ...entry, name: resolveDisplayName(entry.chat_jid) } };
  }
  const limit = (params?.limit as number) || 20;
  return { id: req.id, result: listOutbox(limit).map(entry => ({ ...entry, name: resolveDisplayName(entry.chat_jid) })) };
}

function cmdShutdown(req: IpcRequest): IpcResponse {
  logger.info('Shutdown requested via IPC');
  setTimeout(() => process.exit(0), 500);
  return { id: req.id, result: { status: 'shutting_down' } };
}
