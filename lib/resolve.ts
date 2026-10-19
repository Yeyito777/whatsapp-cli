/**
 * Target resolution: alias, name, phone number or JID → exactly one chat.
 *
 * A wrong match here sends a real message to the wrong person, so resolution
 * is strict: exact names (alias, then chat/contact name, then push name) are
 * tried before anything fuzzy, a tier with more than one distinct chat is an
 * error that lists the candidates, and a fuzzy substring match is accepted
 * only when it yields a single candidate.
 */
import { getDb, resolveDisplayName } from './db.js';
import { isKnownLidUser, translateJid } from './converters.js';
import { isGroupJid, isLidJid } from './jid.js';

export type TargetMatch = 'jid' | 'phone' | 'alias' | 'name' | 'push-name' | 'fuzzy';

export interface ResolvedTarget {
  jid: string;
  name: string;
  match: TargetMatch;
}

export interface TargetCandidate {
  jid: string;
  name: string;
  source: string;
}

export class TargetResolutionError extends Error {
  constructor(message: string, readonly candidates: TargetCandidate[] = []) {
    super(message);
  }
}

const MAX_LISTED_CANDIDATES = 10;
const JID_PATTERN = /^[^@\s]+@(s\.whatsapp\.net|g\.us|lid|broadcast|newsletter)$/;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** One chat per person: a LID with a known phone mapping collapses onto it. */
function canonicalJid(jid: string): string {
  return isLidJid(jid) ? translateJid(jid) : jid;
}

function sourceLabel(jid: string, source: string): string {
  return isGroupJid(jid) && source === 'chat' ? 'group' : source;
}

function distinct(rows: Array<{ jid: string; source: string }>): TargetCandidate[] {
  const byJid = new Map<string, TargetCandidate>();
  for (const row of rows) {
    const jid = canonicalJid(row.jid);
    const existing = byJid.get(jid);
    if (existing) {
      if (!existing.source.split('+').includes(row.source)) existing.source += `+${row.source}`;
      continue;
    }
    byJid.set(jid, { jid, name: resolveDisplayName(jid), source: sourceLabel(jid, row.source) });
  }
  return [...byJid.values()];
}

function ambiguous(target: string, kind: string, candidates: TargetCandidate[]): TargetResolutionError {
  const listed = candidates.slice(0, MAX_LISTED_CANDIDATES)
    .map(c => `  ${c.name}  ${c.jid}  (${c.source})`);
  const more = candidates.length > MAX_LISTED_CANDIDATES
    ? [`  … and ${candidates.length - MAX_LISTED_CANDIDATES} more`]
    : [];
  return new TargetResolutionError(
    [`"${target}" matches ${candidates.length} different chats by ${kind}; refusing to guess. Use one of these JIDs:`,
      ...listed, ...more].join('\n'),
    candidates,
  );
}

function knownLidUser(user: string): boolean {
  if (isKnownLidUser(user)) return true;
  const lid = `${user}@lid`;
  const row = getDb().prepare(`
    SELECT 1 FROM chats WHERE jid = @lid
    UNION ALL SELECT 1 FROM contacts WHERE jid = @lid
    UNION ALL SELECT 1 FROM aliases WHERE jid = @lid
    LIMIT 1
  `).get({ lid });
  return Boolean(row);
}

function exactRows(sql: string, name: string): Array<{ jid: string; source: string }> {
  return getDb().prepare(sql).all({ name }) as Array<{ jid: string; source: string }>;
}

export function resolveTarget(rawTarget: string): ResolvedTarget {
  const target = rawTarget.trim().replace(/\s+/g, ' ');
  if (!target) throw new TargetResolutionError('Empty target.');

  // Explicit JID.
  if (target.includes('@')) {
    const jid = target.replace(/@c\.us$/, '@s.whatsapp.net');
    if (!JID_PATTERN.test(jid)) {
      throw new TargetResolutionError(`"${target}" is not a valid WhatsApp JID.`);
    }
    return { jid, name: resolveDisplayName(jid), match: 'jid' };
  }

  // Phone number. LID digits look like phone numbers but are not.
  if (/^\+?[\d\s\-().]+$/.test(target)) {
    const digits = target.replace(/\D/g, '');
    if (/^\d{7,15}$/.test(digits)) {
      if (knownLidUser(digits)) {
        throw new TargetResolutionError(
          `"${target}" is a WhatsApp linked identity (LID), not a phone number. Use ${digits}@lid to address that chat.`,
        );
      }
      const jid = `${digits}@s.whatsapp.net`;
      return { jid, name: resolveDisplayName(jid), match: 'phone' };
    }
  }

  const tiers: Array<{ match: TargetMatch; kind: string; sql: string }> = [
    {
      match: 'alias',
      kind: 'alias',
      sql: `SELECT jid, 'alias' AS source FROM aliases WHERE LOWER(name) = LOWER(@name)`,
    },
    {
      match: 'name',
      kind: 'exact name',
      sql: `SELECT jid, 'chat' AS source FROM chats WHERE name != '' AND LOWER(name) = LOWER(@name)
            UNION ALL
            SELECT jid, 'contact' AS source FROM contacts WHERE name != '' AND LOWER(name) = LOWER(@name)`,
    },
    {
      match: 'push-name',
      kind: 'push name',
      sql: `SELECT jid, 'push name' AS source FROM contacts WHERE notify != '' AND LOWER(notify) = LOWER(@name)`,
    },
  ];

  for (const tier of tiers) {
    const candidates = distinct(exactRows(tier.sql, target));
    if (candidates.length === 1) return { jid: candidates[0].jid, name: candidates[0].name, match: tier.match };
    if (candidates.length > 1) throw ambiguous(target, tier.kind, candidates);
  }

  const pattern = `%${escapeLike(target)}%`;
  const fuzzy = distinct(getDb().prepare(`
    SELECT jid, 'alias' AS source FROM aliases WHERE LOWER(name) LIKE LOWER(@p) ESCAPE '\\'
    UNION ALL
    SELECT jid, 'chat' AS source FROM chats WHERE name != '' AND LOWER(name) LIKE LOWER(@p) ESCAPE '\\'
    UNION ALL
    SELECT jid, 'contact' AS source FROM contacts WHERE name != '' AND LOWER(name) LIKE LOWER(@p) ESCAPE '\\'
    UNION ALL
    SELECT jid, 'push name' AS source FROM contacts WHERE notify != '' AND LOWER(notify) LIKE LOWER(@p) ESCAPE '\\'
  `).all({ p: pattern }) as Array<{ jid: string; source: string }>);

  if (fuzzy.length === 1) return { jid: fuzzy[0].jid, name: fuzzy[0].name, match: 'fuzzy' };
  if (fuzzy.length > 1) throw ambiguous(target, 'partial name', fuzzy);

  throw new TargetResolutionError(
    `Cannot resolve "${target}" to a WhatsApp chat. Use an alias, an exact chat or contact name, a phone number, or a JID (see: whatsapp chats / whatsapp contacts).`,
  );
}

/** Human-readable description of how a target was matched. */
export function describeMatch(match: TargetMatch): string {
  switch (match) {
    case 'jid': return 'JID';
    case 'phone': return 'phone number';
    case 'alias': return 'alias';
    case 'name': return 'exact name';
    case 'push-name': return 'exact push name';
    case 'fuzzy': return 'partial name (only match)';
  }
}
