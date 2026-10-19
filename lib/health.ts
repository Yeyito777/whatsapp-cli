/**
 * Connection health alerts.
 *
 * A disconnected WhatsApp daemon is silent by nature: no messages arrive, so
 * nothing wakes anyone. These alerts make outages visible to Exocortex:
 *   - conflict (another client took the session), first time per outage;
 *   - logged out / refused (needs the phone owner);
 *   - offline for longer than OFFLINE_ALERT_MS for any other reason;
 *   - recovered, after any outage that produced an alert.
 *
 * Alerts go to the `connection-health` source. If nobody subscribes to it,
 * they also go to the incoming-messages subscribers (data.kind
 * "connection_health"), since those are the conversations relying on
 * WhatsApp staying up.
 */
import type { Logger } from 'pino';

import { publishExternalNotification, registerExternalNotificationSource } from './exocortex.js';
import { INCOMING_MESSAGES_SOURCE, WHATSAPP_TOOL_NAME } from './notifications.js';

export const CONNECTION_HEALTH_SOURCE = {
  id: 'connection-health',
  label: 'WhatsApp connection health',
  description: 'WhatsApp went offline, was logged out, hit a session conflict, or recovered.',
} as const;

export const OFFLINE_ALERT_MS = 30 * 60_000;

export type HealthKind = 'conflict' | 'logged_out' | 'offline' | 'recovered';

export interface HealthEvent {
  kind: HealthKind;
  message: string;
  actionRequired: string | null;
  disconnectReason: number | null;
  since: number;
}

type Publisher = (event: HealthEvent, eventId: string) => Promise<void>;

/** Persists the logged-out episode so daemon restarts do not re-alert it. */
export interface HealthStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

const LOGGED_OUT_SINCE_KEY = 'health_logged_out_since';

export function formatHealthNotification(event: HealthEvent): string {
  const title: Record<HealthKind, string> = {
    conflict: 'WhatsApp session conflict — reconnecting slowly',
    logged_out: 'WhatsApp is logged out — no messages will arrive',
    offline: 'WhatsApp has been offline for a while',
    recovered: 'WhatsApp is connected again',
  };
  const lines = [title[event.kind], event.message];
  if (event.actionRequired) lines.push(`Action: ${event.actionRequired}`);
  if (event.kind !== 'recovered') lines.push(`Since: ${new Date(event.since).toISOString()}`);
  lines.push('Status: whatsapp daemon status');
  return lines.join('\n');
}

async function publishToExocortex(event: HealthEvent, eventId: string): Promise<void> {
  const text = formatHealthNotification(event);
  const data = {
    schemaVersion: 1,
    kind: 'connection_health',
    health: event.kind,
    message: event.message,
    actionRequired: event.actionRequired,
    disconnectReason: event.disconnectReason,
    since: event.since,
  };
  await registerExternalNotificationSource(WHATSAPP_TOOL_NAME, CONNECTION_HEALTH_SOURCE);
  const result = await publishExternalNotification({
    toolName: WHATSAPP_TOOL_NAME,
    sourceId: CONNECTION_HEALTH_SOURCE.id,
    eventId,
    text,
    data,
  });
  if (result.deliveries.length === 0) {
    await publishExternalNotification({
      toolName: WHATSAPP_TOOL_NAME,
      sourceId: INCOMING_MESSAGES_SOURCE.id,
      eventId,
      text,
      data,
    });
  }
}

/**
 * Tracks one outage at a time and decides which alerts to send. Time and the
 * publisher are injectable for tests.
 */
export class HealthMonitor {
  private outageSince: number | null = null;
  private alerted = new Set<HealthKind>();
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReason: number | null = null;

  constructor(
    private readonly logger: Pick<Logger, 'warn' | 'info'>,
    private readonly publish: Publisher = publishToExocortex,
    private readonly now: () => number = Date.now,
    private readonly offlineAlertMs = OFFLINE_ALERT_MS,
    private readonly store: HealthStore | null = null,
  ) {}

  /** The connection is down (any reason). Starts the offline clock once per outage. */
  disconnected(reason: number | null, message: string): void {
    this.lastReason = reason;
    if (this.outageSince === null) this.outageSince = this.now();
    if (this.offlineTimer || this.alerted.has('offline')) return;
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      if (this.alerted.has('logged_out')) return;
      this.raise('offline', `Not connected since ${new Date(this.outageSince ?? this.now()).toISOString()}. Last close: ${message}`, null);
    }, this.offlineAlertMs);
    this.offlineTimer.unref?.();
  }

  conflict(message: string, actionRequired: string | null): void {
    this.disconnected(440, message);
    this.raise('conflict', message, actionRequired);
  }

  loggedOut(reason: number | null, message: string, actionRequired: string | null): void {
    this.disconnected(reason, message);
    const stored = Number(this.store?.get(LOGGED_OUT_SINCE_KEY));
    if (Number.isFinite(stored) && stored > 0) {
      // Already alerted before a restart; the event ID stays the same.
      this.outageSince = Math.min(this.outageSince ?? stored, stored);
    } else {
      this.store?.set(LOGGED_OUT_SINCE_KEY, String(this.outageSince));
    }
    this.raise('logged_out', message, actionRequired);
  }

  connected(): void {
    this.store?.delete(LOGGED_OUT_SINCE_KEY);
    if (this.offlineTimer) clearTimeout(this.offlineTimer);
    this.offlineTimer = null;
    const since = this.outageSince;
    const hadAlert = this.alerted.size > 0;
    this.outageSince = null;
    this.alerted.clear();
    if (since !== null && hadAlert) {
      const minutes = Math.max(1, Math.round((this.now() - since) / 60_000));
      this.send({ kind: 'recovered', message: `Reconnected after about ${minutes} min offline.`, actionRequired: null, disconnectReason: null, since });
    }
  }

  /** Intentional logout or shutdown: no alerts. */
  quiet(): void {
    if (this.offlineTimer) clearTimeout(this.offlineTimer);
    this.offlineTimer = null;
  }

  private raise(kind: HealthKind, message: string, actionRequired: string | null): void {
    if (this.alerted.has(kind)) return;
    this.alerted.add(kind);
    this.send({ kind, message, actionRequired, disconnectReason: this.lastReason, since: this.outageSince ?? this.now() });
  }

  private send(event: HealthEvent): void {
    const eventId = `health:${event.kind}:${event.since}`;
    // exocortexd de-duplicates by event ID, so a logged-out alert repeated
    // after a daemon restart (same persisted `since`) is delivered once.
    this.logger.warn({ health: event.kind, message: event.message }, 'WhatsApp connection health alert');
    void this.publish(event, eventId).catch((err) => {
      this.logger.warn({ err, health: event.kind }, 'Could not publish WhatsApp health alert');
    });
  }
}
