/**
 * Asking the linked phone to resend a message we already have (a
 * "placeholder resend" peer request: it goes only to our own phone, never
 * to the chat). Used to repair rows stored before a message type was
 * understood. The resent copy arrives as a live upsert; it is a repair, not
 * news, so it must not notify again.
 */

const pending = new Map<string, () => void>();

/** Resolves true when the message arrives, false after `timeoutMs`. */
export function awaitRefetch(messageId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.get(messageId) === done) pending.delete(messageId);
      resolve(false);
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    pending.set(messageId, done);
  });
}

/**
 * True (once) when this upserted message is the answer to a refetch. Call it
 * before storing: the waiter runs only after the synchronous handler ends.
 */
export function takeRefetch(messageId: string | null | undefined): boolean {
  if (!messageId) return false;
  const done = pending.get(messageId);
  if (!done) return false;
  pending.delete(messageId);
  done();
  return true;
}
