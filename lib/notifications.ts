import type { StoredMessage } from './types.js';
import {
  publishExternalNotification,
  registerExternalNotificationSource,
  type ExternalNotificationPublishResult,
} from './exocortex.js';

export const WHATSAPP_TOOL_NAME = 'whatsapp';
export const INCOMING_MESSAGES_SOURCE = {
  id: 'incoming-messages',
  label: 'Incoming WhatsApp messages',
  description: 'New incoming, non-status WhatsApp messages received in real time.',
} as const;

export const OWNER_AI_COMMANDS_SOURCE = {
  id: 'self-ai-commands',
  label: 'WhatsApp owner /ai commands',
  description: 'New /ai commands sent by the authenticated account owner in any WhatsApp chat.',
} as const;

const MAX_RECENT_EVENT_IDS = 2_000;
const recentEventIds = new Set<string>();
let incomingSourceRegistered = false;
let ownerAiSourceRegistered = false;

function messageContent(message: StoredMessage): string {
  return message.content || message.media_caption || (message.media_type ? `[${message.media_type}]` : '[message]');
}

function conciseMetadata(value: string, maxLength = 300): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 1)}…`;
}

/** Stable within the WhatsApp source, including the chat to avoid rare stanza-id collisions. */
export function incomingMessageEventId(message: Pick<StoredMessage, 'chat_jid' | 'id'>): string {
  return `${message.chat_jid}:${message.id}`;
}

export function shouldPublishIncomingMessage(input: {
  upsertType: string;
  rawChatJid: string | null | undefined;
  platformMessageId: string | null | undefined;
  isFromMe: boolean;
}): boolean {
  return input.upsertType === 'notify'
    && Boolean(input.platformMessageId)
    && Boolean(input.rawChatJid)
    && input.rawChatJid !== 'status@broadcast'
    && !input.isFromMe;
}

export function shouldPublishOwnerAiCommand(input: {
  upsertType: string;
  rawChatJid: string | null | undefined;
  platformMessageId: string | null | undefined;
  isFromMe: boolean;
  ownerJid: string | null | undefined;
  content: string;
}): boolean {
  return input.upsertType === 'notify'
    && Boolean(input.platformMessageId)
    && Boolean(input.rawChatJid)
    && input.rawChatJid !== 'status@broadcast'
    && input.isFromMe
    && Boolean(input.ownerJid)
    && /^\s*\/ai\s+\S/.test(input.content);
}

/**
 * Claim an event id in a bounded process-local dedupe window. exocortexd also
 * deduplicates per subscription, while this avoids needless duplicate IPC.
 */
export function claimIncomingMessageEvent(eventId: string): boolean {
  if (recentEventIds.has(eventId)) return false;
  recentEventIds.add(eventId);
  if (recentEventIds.size > MAX_RECENT_EVENT_IDS) {
    const oldest = recentEventIds.values().next().value as string | undefined;
    if (oldest) recentEventIds.delete(oldest);
  }
  return true;
}

export function releaseIncomingMessageEvent(eventId: string): void {
  recentEventIds.delete(eventId);
}

export function resetIncomingMessageEventDedupeForTest(): void {
  recentEventIds.clear();
  incomingSourceRegistered = false;
  ownerAiSourceRegistered = false;
}

export function formatIncomingMessageNotification(message: StoredMessage, chatName: string): string {
  const sender = conciseMetadata(message.sender_name || message.sender_jid);
  const chat = conciseMetadata(chatName || message.chat_jid);
  const reply = message.quoted_id ? ` ↳ [reply-to:${conciseMetadata(message.quoted_id)}]` : '';
  return [
    `${chat} [chat:${conciseMetadata(message.chat_jid)}]`,
    '',
    `→ ${sender} <${conciseMetadata(message.sender_jid)}>${reply}:`,
    messageContent(message),
    `[msg:${conciseMetadata(message.id)}]`,
  ].join('\n');
}

export function formatOwnerAiCommandNotification(message: StoredMessage, ownerJid: string, chatName: string): string {
  const chat = conciseMetadata(chatName || message.chat_jid);
  const reply = message.quoted_id ? ` ↳ [reply-to:${conciseMetadata(message.quoted_id)}]` : '';
  return [
    `${chat} [chat:${conciseMetadata(message.chat_jid)}]`,
    '',
    `→ Owner <${conciseMetadata(ownerJid)}> [owner]${reply}:`,
    messageContent(message),
    `[msg:${conciseMetadata(message.id)}]`,
  ].join('\n');
}

export function incomingMessageNotificationData(message: StoredMessage, chatName: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'incoming_message',
    chat: {
      id: message.chat_jid,
      name: chatName || message.chat_jid,
      type: message.chat_jid.endsWith('@g.us') ? 'group' : 'dm',
    },
    messageId: message.id,
    sender: {
      id: message.sender_jid,
      name: message.sender_name || message.sender_jid,
    },
    content: messageContent(message),
    replyTo: message.quoted_id ? { messageId: message.quoted_id } : null,
    media: message.media_type ? { type: message.media_type, caption: message.media_caption } : null,
  };
}

export function ownerAiCommandNotificationData(
  message: StoredMessage,
  ownerJid: string,
  chatName: string,
): Record<string, unknown> {
  return {
    ...incomingMessageNotificationData(message, chatName),
    kind: 'owner_ai_command',
    authenticatedOwnerJid: ownerJid,
  };
}

export async function registerIncomingMessagesSource(): ReturnType<typeof registerExternalNotificationSource> {
  const source = await registerExternalNotificationSource(WHATSAPP_TOOL_NAME, INCOMING_MESSAGES_SOURCE);
  incomingSourceRegistered = true;
  return source;
}

export async function registerOwnerAiCommandsSource(): ReturnType<typeof registerExternalNotificationSource> {
  const source = await registerExternalNotificationSource(WHATSAPP_TOOL_NAME, OWNER_AI_COMMANDS_SOURCE);
  ownerAiSourceRegistered = true;
  return source;
}

export async function publishIncomingMessageNotification(
  message: StoredMessage,
  chatName: string,
): Promise<ExternalNotificationPublishResult | null> {
  const eventId = incomingMessageEventId(message);
  if (!claimIncomingMessageEvent(eventId)) return null;

  try {
    if (!incomingSourceRegistered) await registerIncomingMessagesSource();
    const occurredAt = Date.parse(message.timestamp);
    const result = await publishExternalNotification({
      toolName: WHATSAPP_TOOL_NAME,
      sourceId: INCOMING_MESSAGES_SOURCE.id,
      eventId,
      text: formatIncomingMessageNotification(message, chatName),
      data: incomingMessageNotificationData(message, chatName),
      ...(Number.isFinite(occurredAt) ? { occurredAt } : {}),
    });
    const failures = result.deliveries.filter(delivery => delivery.status === 'failed');
    if (failures.length > 0) {
      throw new Error(`Exocortex rejected ${failures.length} WhatsApp notification delivery target(s)`);
    }
    return result;
  } catch (error) {
    // Permit a repeated Baileys delivery to retry when IPC itself failed.
    releaseIncomingMessageEvent(eventId);
    throw error;
  }
}

export async function publishOwnerAiCommandNotification(
  message: StoredMessage,
  ownerJid: string,
  chatName: string,
): Promise<ExternalNotificationPublishResult | null> {
  const eventId = incomingMessageEventId(message);
  if (!claimIncomingMessageEvent(eventId)) return null;

  try {
    if (!ownerAiSourceRegistered) await registerOwnerAiCommandsSource();
    const occurredAt = Date.parse(message.timestamp);
    const result = await publishExternalNotification({
      toolName: WHATSAPP_TOOL_NAME,
      sourceId: OWNER_AI_COMMANDS_SOURCE.id,
      eventId,
      text: formatOwnerAiCommandNotification(message, ownerJid, chatName),
      data: ownerAiCommandNotificationData(message, ownerJid, chatName),
      ...(Number.isFinite(occurredAt) ? { occurredAt } : {}),
    });
    const failures = result.deliveries.filter(delivery => delivery.status === 'failed');
    if (failures.length > 0) {
      throw new Error(`Exocortex rejected ${failures.length} WhatsApp owner-command delivery target(s)`);
    }
    return result;
  } catch (error) {
    releaseIncomingMessageEvent(eventId);
    throw error;
  }
}
