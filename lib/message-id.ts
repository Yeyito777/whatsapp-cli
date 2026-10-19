import { randomBytes } from 'crypto';

/** WhatsApp Web style message ID ("3EB0" + 18 hex digits), chosen before sending. */
export function generateOutgoingMessageId(): string {
  return `3EB0${randomBytes(9).toString('hex').toUpperCase()}`;
}

export function isValidOutgoingMessageId(id: string): boolean {
  return /^[0-9A-Za-z]{8,64}$/.test(id);
}
