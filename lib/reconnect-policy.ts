/**
 * What to do when the WhatsApp connection closes.
 *
 * Pure so it can be tested: given the close reason and how many times in a
 * row we have failed, decide whether to reconnect, after how long, and what
 * to tell the user.
 */
import { DisconnectReason } from '@whiskeysockets/baileys';

export interface BackoffPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  /** Proportion in [0, 1] applied symmetrically around the delay. */
  jitterRatio: number;
}

export const NETWORK_BACKOFF: BackoffPolicy = { initialDelayMs: 2_000, maxDelayMs: 60_000, jitterRatio: 0.2 };

/**
 * A 440 conflict means another client connected with these credentials. It is
 * usually short-lived (a stray copy, an accidental login), so retry — but
 * slowly, so two real clients do not keep knocking each other off.
 */
export const CONFLICT_DELAYS_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];

export function backoffDelay(attempt: number, policy: BackoffPolicy, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 30);
  const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** exponent);
  const unit = Math.min(1, Math.max(0, random()));
  const factor = 1 - policy.jitterRatio + 2 * policy.jitterRatio * unit;
  return Math.max(0, Math.min(policy.maxDelayMs, Math.round(base * factor)));
}

export type CloseDecision =
  | {
      action: 'reconnect';
      delayMs: number;
      state: 'disconnected' | 'conflict';
      message: string;
      actionRequired: string | null;
    }
  | {
      action: 'stop';
      state: 'logged_out';
      message: string;
      actionRequired: string;
    };

export function decideOnClose(
  reason: number | null,
  counters: { failures: number; conflicts: number },
  random: () => number = Math.random,
): CloseDecision {
  switch (reason) {
    case DisconnectReason.loggedOut:
      return {
        action: 'stop',
        state: 'logged_out',
        message: 'WhatsApp logged this device out (it was removed from Linked Devices or the session expired).',
        actionRequired: 'The phone owner must re-link it: whatsapp login',
      };
    case DisconnectReason.forbidden:
      return {
        action: 'stop',
        state: 'logged_out',
        message: 'WhatsApp refused this session (403 forbidden). Reconnecting automatically could look like abuse.',
        actionRequired: 'Check the account on the phone, then: whatsapp daemon restart',
      };
    case DisconnectReason.multideviceMismatch:
      return {
        action: 'stop',
        state: 'logged_out',
        message: 'WhatsApp reported a multi-device mismatch; this link is no longer valid.',
        actionRequired: 'The phone owner must re-link it: whatsapp login',
      };
    case DisconnectReason.connectionReplaced: {
      const delayMs = CONFLICT_DELAYS_MS[Math.min(Math.max(counters.conflicts, 1) - 1, CONFLICT_DELAYS_MS.length - 1)];
      return {
        action: 'reconnect',
        delayMs,
        state: 'conflict',
        message: `Another client connected with this session and WhatsApp dropped ours (conflict). Retrying in ${Math.round(delayMs / 60_000)} min.`,
        actionRequired: 'If it keeps happening, another copy of this client is running with the same credentials; stop it, then: whatsapp daemon restart',
      };
    }
    case DisconnectReason.restartRequired:
      return { action: 'reconnect', delayMs: 500, state: 'disconnected', message: 'WhatsApp asked for a reconnect.', actionRequired: null };
    default: {
      const delayMs = backoffDelay(counters.failures, NETWORK_BACKOFF, random);
      return {
        action: 'reconnect',
        delayMs,
        state: 'disconnected',
        message: `Connection closed; reconnecting in ${Math.round(delayMs / 1000)}s.`,
        actionRequired: null,
      };
    }
  }
}
