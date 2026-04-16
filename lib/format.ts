/**
 * Terminal output formatting for WhatsApp data.
 *
 * Pure formatting — no DB access. When a chat name lookup is needed,
 * the caller provides a resolver function.
 */
import type { StoredMessage, StoredChat, StoredContact, Alias, DaemonStatus, GroupInfo } from './types.js';

// ─── Helpers ───────────────────────────────────────────────

function relativeTime(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function shortTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (isToday) return time;
  if (isYesterday) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function mediaIcon(mediaType?: string | null): string {
  switch (mediaType) {
    case 'image': return '📷 ';
    case 'video': return '🎥 ';
    case 'audio': return '🎵 ';
    case 'document': return '📄 ';
    case 'sticker': return '🏷️ ';
    case 'contact': return '👤 ';
    case 'location': return '📍 ';
    default: return '';
  }
}

/** Best human-readable label for a JID. */
function jidLabel(jid: string): string {
  const user = jid.split('@')[0];
  // If it looks like a phone number, format it
  if (/^\d{7,15}$/.test(user)) return `+${user}`;
  return user;
}

// ─── Chat List ─────────────────────────────────────────────

export function formatChats(chats: StoredChat[]): string {
  if (chats.length === 0) return 'No chats found.';

  const lines: string[] = [];
  for (const chat of chats) {
    const pin = chat.pinned ? '📌 ' : '';
    const mute = chat.muted ? '🔇 ' : '';
    const group = chat.is_group ? '👥 ' : '';
    const unread = chat.unread_count > 0 ? ` (${chat.unread_count})` : '';
    const time = relativeTime(chat.last_message_time);
    const preview = truncate(chat.last_message_preview, 60);

    lines.push(`${pin}${mute}${group}${chat.name || jidLabel(chat.jid)}${unread}  ${time}`);
    if (preview) {
      lines.push(`  ${preview}`);
    }
    lines.push(`  ${chat.jid}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Messages ──────────────────────────────────────────────

export function formatMessages(messages: StoredMessage[]): string {
  if (messages.length === 0) return 'No messages.';

  const lines: string[] = [];
  let lastDate = '';

  for (const msg of messages) {
    const date = new Date(msg.timestamp).toLocaleDateString();
    if (date !== lastDate) {
      if (lastDate) lines.push('');
      lines.push(`── ${date} ──`);
      lastDate = date;
    }

    const time = shortTime(msg.timestamp);
    const sender = msg.is_from_me ? 'You' : msg.sender_name;
    const media = mediaIcon(msg.media_type);
    const reply = msg.quoted_id ? '↩ ' : '';
    const content = msg.content || (msg.media_type ? `[${msg.media_type}]` : '');

    lines.push(`[${time}] ${reply}${sender}: ${media}${content}`);
    lines.push(`  id: ${msg.id}`);
  }

  return lines.join('\n');
}

// ─── Contacts ──────────────────────────────────────────────

export function formatContacts(contacts: StoredContact[]): string {
  if (contacts.length === 0) return 'No contacts found.';

  const lines: string[] = [];
  for (const c of contacts) {
    const name = c.name || c.notify || c.phone || jidLabel(c.jid);
    const extra = c.name && c.notify && c.name !== c.notify ? ` (${c.notify})` : '';
    const phone = c.phone && c.phone !== c.jid.split('@')[0] ? `  +${c.phone}` : '';
    lines.push(`${name}${extra}${phone}`);
    lines.push(`  ${c.jid}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Search Results ────────────────────────────────────────

/**
 * Format search results. Accepts an optional JID→name map so results
 * display human-readable chat names instead of raw JIDs.
 */
export function formatSearchResults(
  messages: StoredMessage[],
  chatNames?: Record<string, string>,
): string {
  if (messages.length === 0) return 'No results.';

  const lines: string[] = [];
  for (const msg of messages) {
    const time = shortTime(msg.timestamp);
    const sender = msg.is_from_me ? 'You' : msg.sender_name;
    const chatLabel = chatNames?.[msg.chat_jid] || jidLabel(msg.chat_jid);
    lines.push(`[${time}] ${sender} in ${chatLabel}`);
    lines.push(`  ${truncate(msg.content, 120)}`);
    lines.push(`  id: ${msg.id}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Group Info ────────────────────────────────────────────

export function formatGroupInfo(info: GroupInfo): string {
  const lines: string[] = [
    `👥 ${info.name}`,
    `   ${info.jid}`,
    `   ${info.participant_count} participants`,
  ];
  if (info.description) {
    lines.push(`   ${info.description}`);
  }
  if (info.created_at) {
    lines.push(`   Created: ${shortTime(info.created_at)}`);
  }
  lines.push('');
  lines.push('Participants:');
  for (const p of info.participants) {
    const role = p.super_admin ? ' 👑' : p.admin ? ' ⭐' : '';
    lines.push(`  ${p.name}${role}  ${p.jid}`);
  }
  return lines.join('\n');
}

// ─── Status ────────────────────────────────────────────────

export function formatStatus(s: DaemonStatus): string {
  const uptime = formatUptime(s.uptime_seconds);
  let conn = '✗ Disconnected';
  if (s.connection_state === 'connected') conn = '✓ Connected';
  else if (s.connection_state === 'connecting') conn = '… Connecting';
  else if (s.connection_state === 'conflict') conn = '⚠ Session conflict';
  else if (s.connection_state === 'logged_out') conn = '✗ Logged out';

  const lines = [
    conn,
    `Phone: +${s.phone_number || '?'}`,
    `Uptime: ${uptime}`,
    `Messages: ${s.message_count}`,
    `Chats: ${s.chat_count}`,
  ];

  if (s.status_message) lines.push(`Status: ${s.status_message}`);
  if (s.disconnect_reason != null) {
    const suffix = s.disconnect_reason_name ? ` (${s.disconnect_reason_name})` : '';
    lines.push(`Disconnect reason: ${s.disconnect_reason}${suffix}`);
  }
  if (s.action_required) lines.push(`Action: ${s.action_required}`);

  return lines.join('\n');
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── Aliases ───────────────────────────────────────────────

export function formatAliases(aliases: Alias[]): string {
  if (aliases.length === 0) return 'No aliases set. Use: whatsapp alias set <jid_or_number> "Name" --note "description"';

  const lines: string[] = [];
  for (const a of aliases) {
    const note = a.notes ? `  (${a.notes})` : '';
    lines.push(`${a.name}${note}`);
    lines.push(`  ${a.jid}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── Context ───────────────────────────────────────────────

interface ContextData {
  account: {
    phone_number: string;
    connected: boolean;
    uptime_seconds: number;
    message_count: number;
    chat_count: number;
  };
  aliases: Alias[];
  recent_dms: Array<{ name: string; jid: string; last_message_time: string; last_message_preview: string; unread_count: number }>;
  recent_groups: Array<{ name: string; jid: string; last_message_time: string; last_message_preview: string; unread_count: number }>;
}

export function formatContext(ctx: ContextData): string {
  const lines: string[] = [];
  const a = ctx.account;
  const conn = a.connected ? '✓ Connected' : '✗ Disconnected';
  const uptime = formatUptime(a.uptime_seconds);

  lines.push(`Account: +${a.phone_number || '?'}  ${conn}  Uptime: ${uptime}`);
  lines.push(`${a.message_count} messages, ${a.chat_count} chats`);
  lines.push('');

  if (ctx.aliases.length > 0) {
    lines.push(`Aliases (${ctx.aliases.length}):`);
    for (const al of ctx.aliases) {
      const note = al.notes ? ` — ${al.notes}` : '';
      lines.push(`  ${al.name.padEnd(20)} ${al.jid}${note}`);
    }
    lines.push('');
  } else {
    lines.push('Aliases: none set');
    lines.push('');
  }

  if (ctx.recent_dms.length > 0) {
    lines.push(`Recent DMs:`);
    for (const dm of ctx.recent_dms) {
      const time = relativeTime(dm.last_message_time);
      const unread = dm.unread_count > 0 ? ` (${dm.unread_count})` : '';
      const preview = dm.last_message_preview ? `  "${truncate(dm.last_message_preview, 50)}"` : '';
      lines.push(`  ${dm.name.padEnd(20)} ${time}${unread}${preview}`);
    }
    lines.push('');
  }

  if (ctx.recent_groups.length > 0) {
    lines.push(`Recent Groups:`);
    for (const g of ctx.recent_groups) {
      const time = relativeTime(g.last_message_time);
      const unread = g.unread_count > 0 ? ` (${g.unread_count})` : '';
      lines.push(`  👥 ${g.name.padEnd(18)} ${time}${unread}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── JSON ──────────────────────────────────────────────────

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
