/**
 * IPC command handlers — maps incoming method calls to actions.
 */
import fs from 'fs';
import path from 'path';
import type { Logger } from 'pino';
import { downloadMediaMessage, type WAMessage } from '@whiskeysockets/baileys';

import {
  getMessages,
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
  getAllAliases,
  setAlias,
  removeAlias,
  findAliasByName,
  resolveTargetToJid,
  resolveDisplayName,
} from './db.js';
import { getSocket, getConnectionStatus, isConnected } from './connection.js';
import { deserializeRawMessage } from './converters.js';
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

// ─── JID resolution helper ─────────────────────────────────

function resolve(target: string): string {
  return resolveTargetToJid(target);
}

function requireConnected(req: IpcRequest): IpcResponse | null {
  if (isConnected()) return null;

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
      case 'ping':          return { id: req.id, result: 'pong' };
      case 'shutdown':      return cmdShutdown(req);
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

  const jid = resolve(target);
  const limit = (params?.limit as number) || 50;
  const before = params?.before as string | undefined;
  const msgs = getMessages(jid, limit, before);
  return { id: req.id, result: msgs.reverse() };
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
      const metadata = await getSocket().groupMetadata(jid);
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

async function cmdSend(req: IpcRequest, params?: Record<string, unknown>): Promise<IpcResponse> {
  const err = requireConnected(req);
  if (err) return err;

  const target = params?.target as string;
  const text = params?.text as string;
  if (!target) return { id: req.id, error: 'Missing target (JID or name)' };
  if (!text) return { id: req.id, error: 'Missing message text' };

  const jid = resolve(target);
  const sock = getSocket();

  const replyTo = params?.reply_to as string | undefined;
  const sendOpts: Record<string, unknown> = { text };
  if (replyTo) {
    sendOpts.contextInfo = {
      stanzaId: replyTo,
      participant: jid.endsWith('@g.us') ? undefined : jid,
    };
  }

  const sent = await sock.sendMessage(jid, sendOpts as { text: string }, await sendOptionsForChat(jid));
  const sentMsg: StoredMessage = {
    id: sent?.key?.id || `${Date.now()}`,
    chat_jid: jid,
    sender_jid: sock.user?.id || '',
    sender_name: 'Me',
    content: text,
    timestamp: new Date().toISOString(),
    is_from_me: true,
    media_type: null,
    media_caption: null,
    quoted_id: replyTo || null,
  };
  upsertMessage(sentMsg);
  return { id: req.id, result: { status: 'sent', id: sentMsg.id, jid, timestamp: sentMsg.timestamp } };
}

async function cmdSendFile(req: IpcRequest, params?: Record<string, unknown>): Promise<IpcResponse> {
  const err = requireConnected(req);
  if (err) return err;

  const target = params?.target as string;
  const filePath = params?.file as string;
  const caption = (params?.caption as string) || undefined;
  if (!target) return { id: req.id, error: 'Missing target' };
  if (!filePath) return { id: req.id, error: 'Missing file path' };
  if (!fs.existsSync(filePath)) return { id: req.id, error: `File not found: ${filePath}` };

  const jid = resolve(target);
  const sock = getSocket();
  const buf = fs.readFileSync(filePath);
  const sendPayload = buildFilePayload(filePath, buf, caption);

  const sent = await sock.sendMessage(jid, sendPayload as Parameters<typeof sock.sendMessage>[1], await sendOptionsForChat(jid));
  return { id: req.id, result: { status: 'sent', id: sent?.key?.id, jid } };
}

async function cmdDownloadMedia(req: IpcRequest, params?: Record<string, unknown>): Promise<IpcResponse> {
  const err = requireConnected(req);
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
  const err = requireConnected(req);
  if (err) return err;

  const target = params?.target as string;
  const on = params?.on as boolean;
  if (!target) return { id: req.id, error: 'Missing target' };

  const jid = resolve(target);
  await getSocket().sendPresenceUpdate(on ? 'composing' : 'paused', jid);
  return { id: req.id, result: { status: on ? 'typing' : 'paused', jid } };
}

async function cmdMarkRead(req: IpcRequest, params?: Record<string, unknown>): Promise<IpcResponse> {
  const err = requireConnected(req);
  if (err) return err;

  const target = params?.target as string;
  if (!target) return { id: req.id, error: 'Missing target' };

  const jid = resolve(target);
  const lastMsgs = getMessages(jid, 1);
  if (lastMsgs.length > 0) {
    await getSocket().readMessages([{ remoteJid: jid, id: lastMsgs[0].id }]);
  }
  return { id: req.id, result: { status: 'read', jid } };
}

async function cmdGroupInfo(req: IpcRequest, params?: Record<string, unknown>): Promise<IpcResponse> {
  const err = requireConnected(req);
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
      name: p.name || p.notify || p.id.split('@')[0],
      admin: p.admin === 'admin' || p.admin === 'superadmin',
      super_admin: p.admin === 'superadmin',
    })),
    created_at: metadata.creation ? new Date(metadata.creation * 1000).toISOString() : '',
    created_by: metadata.owner || '',
  };
  return { id: req.id, result: info };
}

async function cmdSyncGroups(req: IpcRequest): Promise<IpcResponse> {
  const err = requireConnected(req);
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
  const jid = params?.jid as string;
  const name = params?.name as string;
  const notes = (params?.notes as string) || '';
  if (!jid || !name) return { id: req.id, error: 'Missing jid or name' };
  setAlias(jid, name, notes);
  return { id: req.id, result: { jid, name, notes } };
}

function cmdAliasRemove(req: IpcRequest, params?: Record<string, unknown>): IpcResponse {
  const target = params?.target as string;
  if (!target) return { id: req.id, error: 'Missing target (alias name or JID)' };

  // Try as JID first, then as alias name
  let jid = target;
  if (!target.includes('@')) {
    const alias = findAliasByName(target);
    if (!alias) return { id: req.id, error: `Alias "${target}" not found` };
    jid = alias.jid;
  }

  const removed = removeAlias(jid);
  if (!removed) return { id: req.id, error: `No alias for ${jid}` };
  return { id: req.id, result: { removed: jid } };
}

function cmdResolve(req: IpcRequest, params?: Record<string, unknown>): IpcResponse {
  const target = params?.target as string;
  if (!target) return { id: req.id, error: 'Missing target' };
  const jid = resolve(target);
  const displayName = resolveDisplayName(jid);
  return { id: req.id, result: { jid, name: displayName } };
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

function cmdShutdown(req: IpcRequest): IpcResponse {
  logger.info('Shutdown requested via IPC');
  setTimeout(() => process.exit(0), 500);
  return { id: req.id, result: { status: 'shutting_down' } };
}
