/**
 * Message edits, deletes-for-everyone and reactions.
 *
 * Baileys reports these as `messages.update` (edit / revoke) and
 * `messages.reaction`; history sync carries revoke stubs and a `reactions`
 * list on each message. Without them an agent would act on text the sender
 * already changed or deleted.
 */
import { WAMessageStubType, type proto } from '@whiskeysockets/baileys';

import { applyMessageEdit, applyMessageRevoke, setReaction } from './db.js';
import { getOwnJid, learnKeyMappings, messageText, translateJid } from './converters.js';

type Key = proto.IMessageKey & { remoteJidAlt?: string | null; participantAlt?: string | null };

function chatOf(key: Key | null | undefined): string | null {
  if (!key?.remoteJid || key.remoteJid === 'status@broadcast') return null;
  learnKeyMappings(key);
  return translateJid(key.remoteJid);
}

function isoFromSeconds(value: unknown, fallback = Date.now()): string {
  const n = Number(value);
  return new Date(Number.isFinite(n) && n > 0 ? n * 1000 : fallback).toISOString();
}

function isoFromMillis(value: unknown, fallback = Date.now()): string {
  const n = Number(value);
  return new Date(Number.isFinite(n) && n > 0 ? n : fallback).toISOString();
}

export interface MessageUpdateLike {
  key: Key;
  update: {
    message?: proto.IMessage | null;
    messageStubType?: number | null;
    messageTimestamp?: unknown;
  };
}

/** Apply edits and revokes from `messages.update`. Status-only updates are ignored here. */
export function applyMessageUpdates(updates: MessageUpdateLike[]): { edited: number; deleted: number } {
  let edited = 0;
  let deleted = 0;
  for (const { key, update } of updates) {
    const chat = chatOf(key);
    if (!chat || !key.id) continue;
    if (update.messageStubType === WAMessageStubType.REVOKE || (update.message === null && 'message' in update)) {
      if (applyMessageRevoke(chat, key.id, new Date().toISOString())) deleted++;
      continue;
    }
    const editedMessage = update.message?.editedMessage?.message;
    if (editedMessage) {
      const text = messageText(editedMessage);
      if (applyMessageEdit(chat, key.id, text, isoFromSeconds(update.messageTimestamp))) edited++;
    }
  }
  return { edited, deleted };
}

export interface ReactionEventLike {
  /** The message reacted to. */
  key: Key;
  reaction: { key?: Key | null; text?: string | null; senderTimestampMs?: unknown };
}

function reactorJid(reactionKey: Key | null | undefined, targetChat: string): string | null {
  if (!reactionKey) return null;
  if (reactionKey.fromMe) return getOwnJid();
  const participant = reactionKey.participant || reactionKey.participantAlt;
  if (participant) return translateJid(participant);
  return reactionKey.remoteJid ? translateJid(reactionKey.remoteJid) : targetChat;
}

/** Apply `messages.reaction` events. */
export function applyReactions(events: ReactionEventLike[]): number {
  let applied = 0;
  for (const { key, reaction } of events) {
    const chat = chatOf(key);
    if (!chat || !key.id) continue;
    const reactor = reactorJid(reaction.key, chat);
    if (!reactor) continue;
    setReaction(chat, key.id, reactor, reaction.text ?? '', isoFromMillis(reaction.senderTimestampMs));
    applied++;
  }
  return applied;
}

export interface HistoryMessageLike {
  key?: Key | null;
  message?: proto.IMessage | null;
  messageStubType?: number | null;
  reactions?: Array<{ key?: Key | null; text?: string | null; senderTimestampMs?: unknown }> | null;
}

/** Revoke stubs and reaction lists carried by history-sync / offline messages. */
export function applyHistoryMutations(messages: HistoryMessageLike[]): void {
  for (const msg of messages) {
    const key = msg.key;
    const chat = chatOf(key);
    if (!chat || !key?.id) continue;
    if (msg.messageStubType === WAMessageStubType.REVOKE) {
      applyMessageRevoke(chat, key.id, new Date().toISOString());
      continue;
    }
    if (msg.reactions?.length) {
      applyReactions(msg.reactions.map(reaction => ({ key, reaction })));
    }
  }
}
