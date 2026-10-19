/**
 * Messages delivered after an offline gap.
 *
 * WhatsApp queues messages while the daemon is down (restart, network
 * outage, conflict) and Baileys delivers them as upsert type "append", not
 * "notify". They are genuinely new, so they must still notify — but only
 * those newer than the last time the daemon was known to be live, so history
 * replays never notify, and with a cap so a long outage cannot flood an agent.
 */

/** How far before the last-live mark to look, covering the heartbeat interval. */
export const CATCH_UP_SLACK_MS = 2 * 60_000;
export const CATCH_UP_MAX_AGE_MS = 24 * 60 * 60_000;
export const CATCH_UP_MAX_MESSAGES = 100;
export const LIVE_HEARTBEAT_MS = 60_000;
export const LIVE_UNTIL_KEY = 'live_until_ms';

export class CatchUpWindow {
  private published = 0;
  private skippedCount = 0;
  readonly sinceMs: number;

  /**
   * @param lastLiveMs last time this daemon was known connected and
   *   processing, or null on a first run (no backlog is notified then).
   */
  constructor(lastLiveMs: number | null, private readonly nowMs: number, private readonly maxMessages = CATCH_UP_MAX_MESSAGES) {
    const since = lastLiveMs == null ? nowMs : lastLiveMs - CATCH_UP_SLACK_MS;
    this.sinceMs = Math.max(since, nowMs - CATCH_UP_MAX_AGE_MS);
  }

  /** Should this "append" message be published as a catch-up notification? */
  allow(timestampMs: number, sentByThisClient: boolean): boolean {
    if (sentByThisClient || !Number.isFinite(timestampMs) || timestampMs < this.sinceMs) return false;
    if (this.published >= this.maxMessages) {
      this.skippedCount++;
      return false;
    }
    this.published++;
    return true;
  }

  get skipped(): number {
    return this.skippedCount;
  }
}

/**
 * Upsert type to judge notifications by: own CLI sends never notify, and an
 * "append" inside the catch-up window counts as a live "notify".
 */
export function notificationUpsertType(input: {
  upsertType: string;
  sentByThisClient: boolean;
  timestampMs: number;
  window: CatchUpWindow | null;
}): string {
  if (input.sentByThisClient) return 'own-send';
  if (input.upsertType === 'append' && input.window?.allow(input.timestampMs, false)) return 'notify';
  return input.upsertType;
}
