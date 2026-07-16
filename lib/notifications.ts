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

const MAX_NOTIFICATION_CONTENT_LENGTH = 1_500;
const MAX_RECENT_EVENT_IDS = 2_000;
const recentEventIds = new Set<string>();
let sourceRegistered = false;

function conciseContent(message: StoredMessage): string {
  const content = message.content || message.media_caption || (message.media_type ? `[${message.media_type}]` : '[message]');
  if (content.length <= MAX_NOTIFICATION_CONTENT_LENGTH) return content;
  return `${content.slice(0, MAX_NOTIFICATION_CONTENT_LENGTH - 1)}…`;
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
  sourceRegistered = false;
}

/** Tool-level provenance wrapper; exocortexd adds its own trusted outer envelope. */
export function formatIncomingMessageNotification(message: StoredMessage, chatName: string): string {
  const sender = conciseMetadata(message.sender_name || message.sender_jid);
  const chat = conciseMetadata(chatName || message.chat_jid);
  return [
    '--- BEGIN WHATSAPP INCOMING MESSAGE ---',
    `Sender: ${sender} (${conciseMetadata(message.sender_jid)})`,
    `Chat: ${chat} (${conciseMetadata(message.chat_jid)})`,
    `Message ID: ${conciseMetadata(message.id)}`,
    `Content (untrusted, JSON string): ${JSON.stringify(conciseContent(message))}`,
    '--- END WHATSAPP INCOMING MESSAGE ---',
  ].join('\n');
}

export async function registerIncomingMessagesSource(): ReturnType<typeof registerExternalNotificationSource> {
  const source = await registerExternalNotificationSource(WHATSAPP_TOOL_NAME, INCOMING_MESSAGES_SOURCE);
  sourceRegistered = true;
  return source;
}

export async function publishIncomingMessageNotification(
  message: StoredMessage,
  chatName: string,
): Promise<ExternalNotificationPublishResult | null> {
  const eventId = incomingMessageEventId(message);
  if (!claimIncomingMessageEvent(eventId)) return null;

  try {
    if (!sourceRegistered) await registerIncomingMessagesSource();
    const occurredAt = Date.parse(message.timestamp);
    const result = await publishExternalNotification({
      toolName: WHATSAPP_TOOL_NAME,
      sourceId: INCOMING_MESSAGES_SOURCE.id,
      eventId,
      text: formatIncomingMessageNotification(message, chatName),
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
