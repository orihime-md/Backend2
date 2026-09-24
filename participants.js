// Pure helpers for reading group participants from WAHA, whatever engine
// (WEBJS / NOWEB / GOWS) or version produced them. No network, no side effects.
//
// Why this exists: different WAHA engines return participants with different
// field names and casing — `{ id, role }`, `{ JID, PhoneNumber, LID, IsAdmin }`,
// `{ id: { _serialized, user, server }, isAdmin }` and so on. Reading only
// `p.id` made every entry show as "?" / "member" and admins were never found.

export function normalizeJid(input) {
  if (!input) return '';
  const raw = String(input);
  const [userPart, server] = raw.split('@');
  // Multi-device JIDs carry a ":<deviceId>" suffix ("1234567890:14@s.whatsapp.net")
  // that is not part of the phone number.
  const digits = String(userPart || '').split(':')[0].replace(/\D/g, '');
  if (!digits) return '';
  // @lid is WhatsApp's privacy identifier (hidden numbers). Keep it tagged so it
  // is never mistaken for a real phone number.
  if (server === 'lid') return `${digits}@lid`;
  return `${digits}@c.us`;
}

export function jidNumber(jid) {
  return String(jid || '').split('@')[0].replace(/\D/g, '');
}

// Case-insensitive field lookup: pickField(obj, ['isAdmin']) also finds IsAdmin.
export function pickField(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  const wanted = names.map((n) => n.toLowerCase());
  for (const key of Object.keys(obj)) {
    if (!wanted.includes(key.toLowerCase())) continue;
    const value = obj[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

// Turns a string OR an object-shaped JID into a normalized JID (or '').
//   "123@s.whatsapp.net" | "123@lid" | 123
//   { _serialized: "123@c.us" } | { user: "123", server: "lid" } | { User, Server }
export function jidFromValue(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value);
    if (text.endsWith('@g.us') || text.endsWith('@newsletter') || text.endsWith('@broadcast')) return '';
    return normalizeJid(text);
  }
  if (typeof value === 'object') {
    const serialized = pickField(value, ['_serialized', 'serialized']);
    if (serialized) return jidFromValue(serialized);
    const user = pickField(value, ['user']);
    if (user) {
      const server = String(pickField(value, ['server']) || 's.whatsapp.net');
      return jidFromValue(`${user}@${server}`);
    }
    const nested = pickField(value, ['id', 'jid']);
    if (nested) return jidFromValue(nested);
  }
  return '';
}

const truthy = (v) => v === true || v === 1 || String(v).toLowerCase() === 'true';

// Normalizes ONE raw participant (or a getMe() result) into a predictable shape:
// { raw, jid, ids[], phoneJid, lidJid, role, isAdmin, isSuperAdmin, isMe }
export function parseParticipant(input) {
  const p = typeof input === 'string' || typeof input === 'number' ? { id: input } : (input || {});
  const ids = [];
  const add = (value) => {
    const jid = jidFromValue(value);
    if (jid && !ids.includes(jid)) ids.push(jid);
  };

  // Primary identifiers first, then explicit LID, then explicit phone number.
  ['id', 'jid', 'participant', 'wid', 'user'].forEach((f) => add(pickField(p, [f])));
  add(pickField(p, ['lid']));
  ['pn', 'phoneNumber', 'phone_number', 'phone', 'number'].forEach((f) => add(pickField(p, [f])));

  const roleField = String(pickField(p, ['role']) || '').toLowerCase();
  const adminField = pickField(p, ['admin']); // baileys style: 'admin' | 'superadmin' | null
  const adminText = typeof adminField === 'string' ? adminField.toLowerCase() : '';

  const isSuperAdmin = truthy(pickField(p, ['isSuperAdmin', 'is_super_admin', 'superadmin']))
    || roleField === 'superadmin' || adminText === 'superadmin';
  const isAdmin = isSuperAdmin
    || truthy(pickField(p, ['isAdmin', 'is_admin']))
    || truthy(adminField)
    || ['admin', 'administrator'].includes(roleField)
    || adminText === 'admin';

  return {
    raw: p,
    jid: ids[0] || '',
    ids,
    phoneJid: ids.find((id) => !id.endsWith('@lid')) || '',
    lidJid: ids.find((id) => id.endsWith('@lid')) || '',
    role: isSuperAdmin ? 'superadmin' : isAdmin ? 'admin' : 'member',
    isAdmin,
    isSuperAdmin,
    isMe: truthy(pickField(p, ['isMe', 'isSelf']))
  };
}

// Finds the participants array inside whatever WAHA returned.
export function extractParticipantList(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    for (const key of ['participants', 'members', 'data', 'result']) {
      const value = pickField(result, [key]);
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') {
        const inner = extractParticipantList(value);
        if (inner.length) return inner;
      }
    }
  }
  return [];
}

// Finds the entry matching ANY of the given identifiers (string or array).
// `isSelf` also accepts an entry flagged isMe/isSelf by the engine.
export function findEntry(entries, targets, { isSelf = false } = {}) {
  const wanted = (Array.isArray(targets) ? targets : [targets]).map(jidFromValue).filter(Boolean);
  return entries.find((e) => (isSelf && e.isMe) || e.ids.some((id) => wanted.includes(id)));
}

// Merges a second source of entries into the first. If both know the same
// person, the copy that says "admin" wins, so one flaky endpoint reporting
// everyone as "member" can't hide a real admin.
export function mergeEntries(primary, secondary) {
  const merged = [...primary];
  for (const extra of secondary) {
    if (!extra.ids.length) continue; // nothing to identify it by — would only add duplicates
    const index = merged.findIndex((e) => e.ids.some((id) => extra.ids.includes(id)));
    if (index === -1) merged.push(extra);
    else if (extra.isAdmin && !merged[index].isAdmin) merged[index] = extra;
  }
  return merged;
}
