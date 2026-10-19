/**
 * JID helpers shared by storage, resolution and formatting.
 *
 * WhatsApp addresses people by phone JIDs (`<digits>@s.whatsapp.net`) and by
 * opaque Linked Identities (`<digits>@lid`). LID digits are NOT phone numbers;
 * rendering them as `+digits` invites an agent to "send to that number" and
 * reach a stranger, so labels keep the two visibly distinct.
 */

export function jidUser(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

export function jidServer(jid: string): string {
  const at = jid.indexOf('@');
  return at === -1 ? '' : jid.slice(at + 1);
}

export function isLidJid(jid: string): boolean {
  return jidServer(jid) === 'lid';
}

export function isPhoneJid(jid: string): boolean {
  return jidServer(jid) === 's.whatsapp.net';
}

export function isGroupJid(jid: string): boolean {
  return jidServer(jid) === 'g.us';
}

/** Fallback label for a JID that has no known name. */
export function jidLabel(jid: string): string {
  const user = jidUser(jid);
  if (isPhoneJid(jid) && /^\d{7,15}$/.test(user)) return `+${user}`;
  if (isLidJid(jid)) return `lid:${user}`;
  return user;
}
