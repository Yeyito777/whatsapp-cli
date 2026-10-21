/**
 * Shared contact cards (contactMessage / contactsArrayMessage).
 *
 * WhatsApp sends each shared contact as a vCard. We keep the raw vCard (in
 * the stored raw message) and render a readable line per contact:
 *   👤 Luigi Iovanne de Puy · +507 6123-4567 (WhatsApp)
 */
import type { proto } from '@whiskeysockets/baileys';

export const CONTACT_ICON = '👤 ';

export interface SharedContact {
  displayName: string;
  vcard: string;
}

export interface VcardPhone {
  number: string;
  waid: string | null;
}

/** The contact cards in a (normalized) message, in order. */
export function sharedContacts(message: proto.IMessage | null | undefined): SharedContact[] {
  if (!message) return [];
  if (message.contactMessage) {
    return [{ displayName: message.contactMessage.displayName || '', vcard: message.contactMessage.vcard || '' }];
  }
  if (message.contactsArrayMessage) {
    return (message.contactsArrayMessage.contacts || []).map(c => ({
      displayName: c?.displayName || '',
      vcard: c?.vcard || '',
    }));
  }
  return [];
}

/** vCard lines with RFC 6350 folding undone. */
function unfoldedLines(vcard: string): string[] {
  return vcard.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

/** Property name without group prefix (item1.TEL → TEL), upper-cased. */
function propertyName(nameAndParams: string): string {
  const name = nameAndParams.split(';')[0];
  return name.slice(name.lastIndexOf('.') + 1).toUpperCase();
}

function unescapeValue(value: string): string {
  return value.replace(/\\([,;:\\])/g, '$1').replace(/\\n/gi, ' ').trim();
}

export function vcardFullName(vcard: string): string {
  for (const line of unfoldedLines(vcard)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    if (propertyName(line.slice(0, colon)) === 'FN') return unescapeValue(line.slice(colon + 1));
  }
  return '';
}

export function vcardPhones(vcard: string): VcardPhone[] {
  const phones: VcardPhone[] = [];
  for (const line of unfoldedLines(vcard)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    if (propertyName(head) !== 'TEL') continue;
    const waid = /;waid=(\d+)/i.exec(head)?.[1] ?? null;
    const number = unescapeValue(line.slice(colon + 1)).replace(/^tel:/i, '');
    if (number || waid) phones.push({ number, waid });
  }
  return phones;
}

function phoneLabel(phone: VcardPhone): string {
  if (!phone.waid) return phone.number;
  if (!phone.number) return `+${phone.waid} (WhatsApp)`;
  const digits = phone.number.replace(/\D/g, '');
  return digits === phone.waid ? `${phone.number} (WhatsApp)` : `${phone.number} (WhatsApp +${phone.waid})`;
}

/** One readable line for a shared contact. */
export function contactLine(contact: SharedContact): string {
  const name = contact.displayName.trim() || vcardFullName(contact.vcard) || 'Unnamed contact';
  const phones = vcardPhones(contact.vcard).map(phoneLabel);
  return `${CONTACT_ICON}${[name, ...phones].join(' · ')}`;
}

/** Readable lines for every contact card in the message, or '' if none. */
export function contactsSummary(message: proto.IMessage | null | undefined): string {
  return sharedContacts(message).map(contactLine).join('\n');
}

/** All the message's vCards as one .vcf file body, or '' if none. */
export function contactsVcf(message: proto.IMessage | null | undefined): string {
  return sharedContacts(message)
    .map(c => c.vcard.trim())
    .filter(Boolean)
    .map(v => v.replace(/\r?\n/g, '\r\n') + '\r\n')
    .join('');
}
