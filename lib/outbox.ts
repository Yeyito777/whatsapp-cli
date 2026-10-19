/**
 * Outbound message ledger.
 *
 * Every send carries a message ID chosen by the CLI before the request leaves
 * it. The daemon records the ID before handing the message to Baileys and
 * advances its state as WhatsApp confirms it, so:
 *   - a retry with the same ID never sends a second copy once one was written;
 *   - an interrupted request can be checked (`whatsapp outbox <id>`) instead
 *     of blindly re-sent;
 *   - "written to the socket" and "acknowledged by the WhatsApp server" are
 *     reported as different outcomes.
 */
import { getDb } from './db.js';

export { generateOutgoingMessageId, isValidOutgoingMessageId } from './message-id.js';

export type OutboxState =
  | 'sending'     // handed to Baileys, not yet written
  | 'written'     // written to the WhatsApp connection; no server ack yet
  | 'server_ack'  // WhatsApp's server accepted it
  | 'delivered'   // recipient device received it
  | 'read'        // recipient read/played it
  | 'failed'      // definitely not sent, or rejected by the server
  | 'unknown';    // the daemon stopped mid-send; outcome cannot be known

export interface OutboxEntry {
  id: string;
  chat_jid: string;
  kind: 'text' | 'file';
  state: OutboxState;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const PROGRESS: Record<OutboxState, number> = {
  sending: 0,
  unknown: 0,
  failed: 0,
  written: 1,
  server_ack: 2,
  delivered: 3,
  read: 4,
};

/** States that mean a copy reached WhatsApp; re-sending would duplicate it. */
export function isSentState(state: OutboxState): boolean {
  return PROGRESS[state] >= 1;
}

let schemaReady = false;

function ensureSchema(): void {
  if (schemaReady) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at DESC);
  `);
  schemaReady = true;
}

export function getOutboxEntry(id: string): OutboxEntry | undefined {
  ensureSchema();
  return getDb().prepare('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxEntry | undefined;
}

export function listOutbox(limit = 20): OutboxEntry[] {
  ensureSchema();
  return getDb().prepare('SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?').all(limit) as OutboxEntry[];
}

export function recordSending(id: string, chatJid: string, kind: OutboxEntry['kind']): void {
  ensureSchema();
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO outbox (id, chat_jid, kind, state, error, created_at, updated_at)
    VALUES (@id, @chat_jid, @kind, 'sending', NULL, @now, @now)
    ON CONFLICT(id) DO UPDATE SET state = 'sending', error = NULL, updated_at = @now
  `).run({ id, chat_jid: chatJid, kind, now });
}

/**
 * Move an entry forward. Acknowledgement states only ever advance; `failed`
 * from an error ack overrides anything short of delivery.
 */
export function advanceOutbox(id: string, state: OutboxState, error: string | null = null): OutboxEntry | undefined {
  ensureSchema();
  const entry = getOutboxEntry(id);
  if (!entry) return undefined;
  const allowed = state === 'failed'
    ? PROGRESS[entry.state] < PROGRESS.delivered
    : state === 'unknown'
      ? entry.state === 'sending'
      : PROGRESS[state] > PROGRESS[entry.state] || entry.state === 'sending';
  if (!allowed) return entry;
  getDb().prepare('UPDATE outbox SET state = ?, error = ?, updated_at = ? WHERE id = ?')
    .run(state, error, new Date().toISOString(), id);
  notifyWaiters(id);
  return getOutboxEntry(id);
}

/** After a crash or restart, anything still "sending" has an unknown outcome. */
export function markInterruptedSendsUnknown(): number {
  ensureSchema();
  return getDb().prepare(`UPDATE outbox SET state = 'unknown', updated_at = ? WHERE state = 'sending'`)
    .run(new Date().toISOString()).changes;
}

// ─── Waiting for acknowledgements ──────────────────────────

const waiters = new Map<string, Set<() => void>>();

function notifyWaiters(id: string): void {
  const set = waiters.get(id);
  if (!set) return;
  waiters.delete(id);
  for (const wake of set) wake();
}

/** Resolve once the entry reaches `state` (or fails), or after `timeoutMs`. */
export async function waitForOutboxState(id: string, state: OutboxState, timeoutMs: number): Promise<OutboxEntry | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entry = getOutboxEntry(id);
    if (!entry || entry.state === 'failed' || PROGRESS[entry.state] >= PROGRESS[state]) return entry;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return entry;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, remaining);
      function done(): void {
        clearTimeout(timer);
        waiters.get(id)?.delete(done);
        resolve();
      }
      let set = waiters.get(id);
      if (!set) waiters.set(id, set = new Set());
      set.add(done);
    });
  }
}

/** Map a Baileys WebMessageInfo.Status value to an outbox state. */
export function stateForBaileysStatus(status: number | null | undefined): OutboxState | null {
  switch (status) {
    case 0: return 'failed';      // ERROR
    case 2: return 'server_ack';  // SERVER_ACK
    case 3: return 'delivered';   // DELIVERY_ACK
    case 4:                       // READ
    case 5: return 'read';        // PLAYED
    default: return null;
  }
}
