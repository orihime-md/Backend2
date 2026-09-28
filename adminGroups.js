// Admin-console group management for a linked WhatsApp session.
//
// Everything here talks to WAHA with the SAME calls the in-chat commands use
// (getGroups / getParticipants / promoteParticipants / demoteParticipants /
// getInviteCode / leaveGroup), so an action taken in the console is a real
// WhatsApp action, exactly like typing .promote / .demote / .leave in a group.
//
// Nothing in this file trusts the browser: admin rights, the target's current
// role and the session state are all re-checked against a FRESH participant
// list on the server before anything is sent to WhatsApp.

import {
  getGroups,
  getGroup as getGroupInfo,
  getParticipants,
  getParticipantsV2,
  getInviteCode,
  promoteParticipants,
  demoteParticipants,
  leaveGroup,
  getSession as getRemoteSession
} from './waha.js';
import { getSession as getStored } from './store.js';
import {
  getSessionSelfIds,
  invalidateGroupCaches,
  markConsoleAdminAction,
  unmarkConsoleAdminAction
} from './bot.js';
import {
  parseParticipant,
  extractParticipantList,
  findEntry,
  mergeEntries,
  jidNumber,
  pickField
} from './participants.js';

export class AdminGroupError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- helpers ---

function wahaErrorText(error) {
  const data = error?.response?.data;
  if (typeof data === 'string' && data.trim()) return data.trim().slice(0, 300);
  if (data && typeof data === 'object') {
    const text = data.message || data.error || data.detail || data.details;
    if (text) return String(typeof text === 'string' ? text : JSON.stringify(text)).slice(0, 300);
  }
  return String(error?.message || error || 'Unknown error').slice(0, 300);
}

function assertGroupId(groupId) {
  const id = String(groupId || '').trim();
  if (!/^[\w.:-]+@g\.us$/.test(id)) throw new AdminGroupError(400, 'That is not a valid WhatsApp group id.');
  return id;
}

// The session must exist and really be connected. The stored status can lag
// behind reality (it is webhook-fed), so a non-WORKING stored status is
// double-checked live against WAHA before refusing.
async function assertSessionUsable(session) {
  const stored = getStored(session);
  if (!stored || stored.removed) throw new AdminGroupError(404, 'Session not found.');
  if (String(stored.status || '').toUpperCase() === 'WORKING') return stored;
  let live = '';
  try { live = String((await getRemoteSession(session))?.status || '').toUpperCase(); } catch {}
  if (live !== 'WORKING') {
    throw new AdminGroupError(409, `This WhatsApp session is not connected right now (status: ${live || stored.status || 'UNKNOWN'}).`);
  }
  return stored;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// WAHA engines disagree on the shape of the group id (`id`, `JID`, or an object
// with `_serialized`) — read all of them, case-insensitively.
function groupIdOf(group) {
  const value = pickField(group, ['id', 'jid', 'groupId', 'chatId', 'gid']);
  let id = '';
  if (typeof value === 'string') id = value;
  else if (value && typeof value === 'object') {
    const serialized = pickField(value, ['_serialized', 'serialized']);
    if (serialized) id = String(serialized);
    else {
      const user = pickField(value, ['user']);
      if (user) id = `${user}@${pickField(value, ['server']) || 'g.us'}`;
    }
  }
  return id.endsWith('@g.us') ? id : '';
}

function groupNameOf(group, fallback = '') {
  return String(pickField(group, ['subject', 'name', 'title']) || fallback || '').trim();
}

function extractGroupList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    for (const key of ['groups', 'data', 'result']) {
      const value = pickField(raw, [key]);
      if (Array.isArray(value)) return value;
    }
    // Some engines return an object keyed by group id.
    const keyed = Object.entries(raw).filter(([key, value]) => key.endsWith('@g.us') && value && typeof value === 'object');
    if (keyed.length) return keyed.map(([key, value]) => ({ id: key, ...value }));
  }
  return [];
}

function roleOfEntry(entry) {
  if (!entry) return 'unknown';
  return entry.isSuperAdmin ? 'superadmin' : entry.isAdmin ? 'admin' : 'member';
}

function normalizeInvite(raw) {
  let value = raw;
  if (value && typeof value === 'object') {
    value = pickField(value, ['link', 'url', 'inviteLink', 'inviteUrl', 'code', 'inviteCode', 'invite_code', 'invite']);
  }
  value = String(value ?? '').trim().replace(/^["']|["']$/g, '');
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `https://chat.whatsapp.com/${value.replace(/^\/+/, '')}`;
}

// Reads a group's participants with roles. Uses the fast endpoint first and
// only falls back to the deeper ones when no admin flag was seen at all (every
// real group has at least one admin, so "no admins" means the roles were not
// reported). Bypasses the bot's short-lived caches on purpose: the console
// must act on, and report, the real current state.
async function fetchEntriesFresh(session, groupId) {
  let entries = [];
  let primaryError = null;
  try {
    entries = extractParticipantList(await getParticipants(session, groupId)).map(parseParticipant);
  } catch (error) {
    primaryError = error;
  }
  if (!entries.length || !entries.some((e) => e.isAdmin)) {
    try {
      const v2 = extractParticipantList(await getParticipantsV2(session, groupId)).map(parseParticipant);
      if (v2.length) entries = entries.length ? mergeEntries(entries, v2) : v2;
    } catch {}
  }
  if (!entries.length || !entries.some((e) => e.isAdmin)) {
    try {
      const info = extractParticipantList(await getGroupInfo(session, groupId)).map(parseParticipant);
      if (info.length) entries = entries.length ? mergeEntries(entries, info) : info;
    } catch (error) {
      if (!entries.length) throw primaryError || error;
    }
  }
  if (!entries.length && primaryError) throw primaryError;
  return entries;
}

// ------------------------------------------------------------ group list ---

const LIST_CACHE = new Map(); // session -> { at, data }
const LIST_TTL_MS = 20000;

function dropListCache(session) {
  LIST_CACHE.delete(session);
}

function summarizeGroup(rawGroup, selfIds) {
  const id = groupIdOf(rawGroup);
  if (!id) return null;
  const entries = extractParticipantList(rawGroup).map(parseParticipant);
  const selfEntry = entries.length ? findEntry(entries, selfIds, { isSelf: true }) : null;

  let members = entries.length;
  if (!members) {
    const numeric = Number(pickField(rawGroup, ['size', 'participantsCount', 'participantCount', 'membersCount', 'memberCount']));
    if (Number.isFinite(numeric) && numeric > 0) members = numeric;
  }

  const embeddedInvite = pickField(rawGroup, ['inviteCode', 'inviteLink', 'invite_code', 'invite']);
  return {
    id,
    name: groupNameOf(rawGroup, 'Unnamed group'),
    members,
    role: roleOfEntry(selfEntry),
    isAdmin: Boolean(selfEntry?.isAdmin),
    roleKnown: Boolean(selfEntry),
    inviteLink: typeof embeddedInvite === 'string' ? normalizeInvite(embeddedInvite) || null : null,
    // No participants at all in the list response -> counts/role need a lookup.
    needsLookup: !entries.length
  };
}

export async function listSessionGroups(session, { refresh = false } = {}) {
  await assertSessionUsable(session);
  const cached = LIST_CACHE.get(session);
  if (!refresh && cached && Date.now() - cached.at < LIST_TTL_MS) return cached.data;

  let rawList;
  try {
    rawList = await getGroups(session, {});
  } catch (error) {
    throw new AdminGroupError(502, 'Could not load the group list from WhatsApp.', wahaErrorText(error));
  }
  const selfIds = await getSessionSelfIds(session);
  const rows = extractGroupList(rawList).map((g) => summarizeGroup(g, selfIds)).filter(Boolean);

  // Some WAHA builds return the list without participants. Fill counts and the
  // linked account's role in with a bounded number of parallel lookups.
  const missing = rows.filter((row) => row.needsLookup);
  if (missing.length) {
    await mapLimit(missing, 5, async (row) => {
      try {
        const entries = await fetchEntriesFresh(session, row.id);
        const selfEntry = findEntry(entries, selfIds, { isSelf: true });
        row.members = entries.length;
        row.role = roleOfEntry(selfEntry);
        row.isAdmin = Boolean(selfEntry?.isAdmin);
        row.roleKnown = Boolean(selfEntry);
      } catch (error) {
        console.error(`[admin-groups] lookup failed for ${row.id}:`, wahaErrorText(error));
      }
    });
  }
  for (const row of rows) delete row.needsLookup;

  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const data = {
    session,
    total: rows.length,
    adminCount: rows.filter((r) => r.isAdmin).length,
    unknownRoleCount: rows.filter((r) => !r.roleKnown).length,
    fetchedAt: Date.now(),
    groups: rows
  };
  LIST_CACHE.set(session, { at: Date.now(), data });
  return data;
}

// ---------------------------------------------------------- invite links ---

const INVITE_CACHE = new Map(); // `${session}:${groupId}` -> { at, link }
const INVITE_TTL_MS = 10 * 60 * 1000;

export async function getGroupInvite(session, groupId, { refresh = false } = {}) {
  groupId = assertGroupId(groupId);
  await assertSessionUsable(session);
  const key = `${session}:${groupId}`;
  const cached = INVITE_CACHE.get(key);
  if (!refresh && cached && Date.now() - cached.at < INVITE_TTL_MS) return { groupId, link: cached.link };
  try {
    const link = normalizeInvite(await getInviteCode(session, groupId));
    if (!link) return { groupId, link: null, reason: 'WhatsApp returned no invite link for this group.' };
    INVITE_CACHE.set(key, { at: Date.now(), link });
    return { groupId, link };
  } catch (error) {
    // Normal for groups where the linked account is not allowed to see the link.
    return { groupId, link: null, reason: wahaErrorText(error) };
  }
}

// --------------------------------------------------------------- members ---

function describeMember(entry, selfIds) {
  const phoneJid = entry.phoneJid;
  const isSelf = Boolean(entry.isMe) || entry.ids.some((id) => selfIds.includes(id));
  return {
    id: entry.jid,
    phone: phoneJid ? jidNumber(phoneJid) : '',
    lid: entry.lidJid ? jidNumber(entry.lidJid) : '',
    name: String(pickField(entry.raw, ['pushName', 'notify', 'displayName', 'verifiedName', 'name']) || '').trim(),
    role: entry.role,
    isAdmin: entry.isAdmin,
    isSuperAdmin: entry.isSuperAdmin,
    isSelf
  };
}

function sortMembers(a, b) {
  const rank = (m) => (m.isSuperAdmin ? 0 : m.isAdmin ? 1 : 2);
  return rank(a) - rank(b) || (a.phone || a.lid).localeCompare(b.phone || b.lid);
}

export async function getGroupMembers(session, groupId) {
  groupId = assertGroupId(groupId);
  await assertSessionUsable(session);
  let entries;
  try {
    entries = await fetchEntriesFresh(session, groupId);
  } catch (error) {
    throw new AdminGroupError(502, 'Could not load the members of this group.', wahaErrorText(error));
  }
  const selfIds = await getSessionSelfIds(session);
  const members = entries.map((e) => describeMember(e, selfIds)).sort(sortMembers);
  const me = members.find((m) => m.isSelf);
  return {
    groupId,
    total: members.length,
    adminCount: members.filter((m) => m.isAdmin).length,
    selfRole: me ? me.role : 'unknown',
    selfIsAdmin: Boolean(me?.isAdmin),
    members
  };
}

// --------------------------------------------------- promote / demote -----

async function verifyRole(session, groupId, target, expectAdmin) {
  for (const wait of [800, 1600]) {
    await sleep(wait);
    try {
      const entries = await fetchEntriesFresh(session, groupId);
      const now = findEntry(entries, target.ids);
      if (now && Boolean(now.isAdmin) === expectAdmin) return true;
    } catch {}
  }
  return false;
}

export async function changeMemberRole(session, groupId, action, participantId) {
  groupId = assertGroupId(groupId);
  if (!['promote', 'demote'].includes(action)) throw new AdminGroupError(400, 'Unknown action.');
  if (!participantId) throw new AdminGroupError(400, 'No member was specified.');
  await assertSessionUsable(session);

  let entries;
  try {
    entries = await fetchEntriesFresh(session, groupId);
  } catch (error) {
    throw new AdminGroupError(502, 'Could not read this group from WhatsApp.', wahaErrorText(error));
  }
  const selfIds = await getSessionSelfIds(session);
  const selfEntry = findEntry(entries, selfIds, { isSelf: true });
  if (!selfEntry) {
    throw new AdminGroupError(409, 'Could not confirm the linked account\'s role in this group. Refresh and try again.');
  }
  if (!selfEntry.isAdmin) {
    throw new AdminGroupError(403, 'The linked account is not an admin of this group, so WhatsApp will not allow this.');
  }

  const target = findEntry(entries, [participantId]);
  if (!target) throw new AdminGroupError(404, 'That member is no longer in the group. Refresh the member list.');
  const targetIsSelf = Boolean(target.isMe) || target.ids.some((id) => selfIds.includes(id));

  if (action === 'promote' && target.isAdmin) throw new AdminGroupError(409, 'That member is already an admin.');
  if (action === 'demote') {
    if (!target.isAdmin) throw new AdminGroupError(409, 'That member is not an admin.');
    if (target.isSuperAdmin) throw new AdminGroupError(403, 'The group creator cannot be demoted.');
    if (targetIsSelf) throw new AdminGroupError(400, 'Demoting the linked account itself is blocked here so you do not lock yourself out. Use Leave group if that is what you want.');
  }

  // Try the id exactly as the group reports it first, then its alias forms
  // (phone JID <-> @lid). Whichever one WhatsApp accepts is used.
  const candidates = [...new Set([target.jid, target.phoneJid, target.lidJid].filter(Boolean))];
  const fn = action === 'promote' ? promoteParticipants : demoteParticipants;

  markConsoleAdminAction(session, groupId, action, target.ids);
  let lastError = null;
  let accepted = false;
  for (const id of candidates) {
    try {
      await fn(session, groupId, [id]);
      accepted = true;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!accepted) {
    unmarkConsoleAdminAction(session, groupId, action, target.ids);
    throw new AdminGroupError(502, `WhatsApp rejected the ${action}.`, wahaErrorText(lastError));
  }

  invalidateGroupCaches(session, groupId);
  dropListCache(session);
  const verified = await verifyRole(session, groupId, target, action === 'promote');
  invalidateGroupCaches(session, groupId);

  return {
    ok: true,
    action,
    verified,
    member: {
      id: target.jid,
      phone: target.phoneJid ? jidNumber(target.phoneJid) : '',
      isAdmin: action === 'promote'
    }
  };
}

// ----------------------------------------------------------------- leave ---

export async function leaveGroupAsOwner(session, groupId) {
  groupId = assertGroupId(groupId);
  await assertSessionUsable(session);
  try {
    await leaveGroup(session, groupId);
  } catch (error) {
    throw new AdminGroupError(502, 'WhatsApp did not let the linked account leave this group.', wahaErrorText(error));
  }
  invalidateGroupCaches(session, groupId);
  INVITE_CACHE.delete(`${session}:${groupId}`);
  dropListCache(session);
  return { ok: true, groupId };
}
