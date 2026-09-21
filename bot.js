import fs from 'node:fs/promises';
import path from 'node:path';
import {
  sendText,
  sendImage,
  sendVideo,
  sendVoice,
  sendFile,
  sendList,
  editMessage,
  getMessage,
  deleteMessage,
  downloadMedia,
  getParticipants,
  removeParticipants,
  addParticipants,
  promoteParticipants,
  demoteParticipants,
  getInviteCode,
  leaveGroup,
  getMe,
  getSession,
  getGroup as getGroupInfo,
  setGroupMessagesAdminOnly
} from './waha.js';
import {
  buildMainMenuPayload,
  buildCategoryPayload,
  buildTogglePayload,
  extractSelectedRowId,
  parseSelection,
  usageFor
} from './menu.js';
import {
  getSession as getStored,
  upsertSession,
  getGroup,
  setGroup,
  appendCommandLog,
  commandHistory,
  clearHistory,
  getChannelImage,
  listChannelImages,
  getChannelLink,
  setChannelLink
} from './store.js';
import { createPairingSession } from './pairing.js';
import {
  normalizeJid,
  jidNumber,
  jidFromValue,
  parseParticipant,
  extractParticipantList,
  findEntry,
  mergeEntries
} from './participants.js';
import { syncChannelImages, CHANNEL_REF } from './channelSync.js';

const INTRO = 'Santen Kesshun!” — 三天結盾';
const DEFAULT_PREFIX = '.';
const DELAY = Number(process.env.TEMP_MESSAGE_DELAY_MS || 900);
const OWNER_OVERRIDE = (process.env.BOT_OWNER_PHONE || '').replace(/\D/g, '');
const ANTIBOT_JIDS = new Set((process.env.ANTIBOT_JIDS || '').split(',').map((x) => x.trim()).filter(Boolean));
const ANTIBOT_KICK = String(process.env.ANTIBOT_KICK || 'false').toLowerCase() === 'true';
const GAME_SESSIONS = new Map();

// Keywords .kill-sale watches for. Matched as whole words (case-insensitive)
// so it catches "available", "sale", "selling", etc. without nuking messages
// that merely contain them as a substring of an unrelated word.
const SALE_KEYWORDS = [
  'available', 'availability', 'sale', 'sales', 'selling', 'sell', 'sold',
  'price', 'prices', 'pricing', 'discount', 'discounted', 'promo', 'promotion',
  'offer', 'offers', 'deal', 'deals', 'cheap', 'wholesale', 'retail',
  'instock', 'in-stock', 'restock', 'restocked', 'order now', 'buy now',
  'for sale', 'dm to order', 'dm to buy', 'pm to order'
];
const SALE_KEYWORD_REGEX = new RegExp(
  `\\b(${SALE_KEYWORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})\\b`,
  'i'
);

// Menu sections run in a "cool" flow: the glass header, then the commands
// anyone would reach for first (public → fun → games → group), with the more
// technical bot/admin controls toward the end, closing on the brand footer.
function buildMenuText(prefix = '.') {
  return `╭─❰ 🌸 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 · 𝐌𝐃 ❱──╮
　 ⟡ 𝐁𝐎𝐓 𝐈𝐍𝐅𝐎 ⟡
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
　 🤖 𝐍𝐚𝐦𝐞　　: "Orihime MD"
　 👑 𝐎𝐰𝐧𝐞𝐫　　: "Cute Precious"
　 ⚡ 𝐏𝐫𝐞𝐟𝐢𝐱　: "${prefix}"
　 🔖 𝐕𝐞𝐫𝐬𝐢𝐨𝐧: "1.0.0"
╰──────────────────────╯

┏─ ⟢ 🌐 𝐏𝐔𝐁𝐋𝐈𝐂 ⟣ ─┓
┃ ❯ "${prefix}pair <number>"
┃ ❯ "${prefix}link"
┗───────────────────┛

┏─ ⟢ 🎀 𝐅𝐔𝐍 ⟣ ─┓
┃ ❯ "${prefix}blague"
┃ ❯ "${prefix}joke"
┃ ❯ "${prefix}orihime-wipe"
┃ ❯ "${prefix}orihime-history"
┗───────────────────┛

┏─ ⟢ 🎮 𝐆𝐀𝐌𝐄𝐒 ⟣ ─┓
┃ ❯ "${prefix}candy"
┃ ❯ "${prefix}candycrush"
┃ ❯ "${prefix}crossword"
┃ ❯ "${prefix}wordgame"
┃ ❯ "${prefix}2048"
┗───────────────────┛

┏─ ⟢ 👥 𝐆𝐑𝐎𝐔𝐏 ⟣ ─┓
┃ ❯ "${prefix}kick"
┃ ❯ "${prefix}add <number>"
┃ ❯ "${prefix}kickall"
┃ ❯ "${prefix}tagall"
┃ ❯ "${prefix}hidetag"
┃ ❯ "${prefix}invite"
┃ ❯ "${prefix}left on/off"
┃ ❯ "${prefix}leave"
┃ ❯ "${prefix}welcome on/off"
┃ ❯ "${prefix}autod @user"
┃ ❯ "${prefix}announcement"
┃ ❯ "${prefix}close"
┃ ❯ "${prefix}open"
┃ ❯ "${prefix}group-id"
┃ ❯ "${prefix}listadmin"
┃ ❯ "${prefix}vv"
┃ ❯ "${prefix}promote @user"
┃ ❯ "${prefix}demote @user"
┗───────────────────┛

┏─ ⟢ 🛠️ 𝐁𝐎𝐓 ⟣ ─┓
┃ ❯ "${prefix}ping"
┃ ❯ "${prefix}whoami"
┃ ❯ "${prefix}setprefix"
┃ ❯ "${prefix}public"
┃ ❯ "${prefix}private"
┗───────────────────┛

┏─ ⟢ ⚙️ 𝐀𝐃𝐌𝐈𝐍 ⟣ ─┓
┃ ❯ "${prefix}antibot"
┃ ❯ "${prefix}antichannel"
┃ ❯ "${prefix}antilink"
┃ ❯ "${prefix}kill-sale on/off"
┃ ❯ "${prefix}antidemote on/off"
┃ ❯ "${prefix}antipromote on/off"
┗───────────────────┛

╭─❰ 💗 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 ❱──╮
　 🌸 Cute • Simple • Fast
　 ✨ Made with love by
　　"Cute Precious"
╰──────────────────────╯

«「 𝐎𝐫𝐢𝐡𝐢𝐦𝐞 𝐌𝐃 — 𝐘𝐨𝐮𝐫 𝐂𝐮𝐭𝐞 𝐖𝐡𝐚𝐭𝐬𝐀𝐩𝐩 𝐀𝐬𝐬𝐢𝐬𝐭𝐚𝐧𝐭 🌸 」»

© 2026 Orihime MD ♡`;
}

const JOKES = [
  'Why did the phone wear glasses? Because it lost its contacts. 📱😂',
  'I told my bot to take a break. It replied: “I already run in the background.” 🤖',
  'Why was the Wi‑Fi sad? Everyone kept disconnecting from it. 😭📶',
  'What do programmers eat when they are hungry? Microchips. 🍟💻',
  'Why did the emoji cross the chat? To get to the other side of the conversation. 😄'
];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function isGroup(chatId) { return String(chatId || '').endsWith('@g.us'); }

function isLikelyCommand(body, prefix) {
  return typeof body === 'string' && body.trim().startsWith(prefix) && body.trim().length > prefix.length;
}

function parseCommand(body, prefix) {
  const input = String(body || '').trim();
  if (!isLikelyCommand(input, prefix)) return null;
  const without = input.slice(prefix.length).trim();
  if (!without) return null;
  const parts = without.split(/\s+/);
  return { name: parts.shift().toLowerCase(), args: parts, raw: input };
}

function formatRequestedBy(jid) {
  const n = jidNumber(jid);
  return n ? `@${n}` : '@user';
}

// A "frosted glass" panel look for every status reply: a soft dotted divider
// standing in for the blur/translucency a real glassmorphic card would have,
// framed the same way on every command so replies feel like one consistent set.
function statusCaption(title, lines = []) {
  return [
    '╭─❰ 🌸 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 · 𝐌𝐃 ❱──╮',
    `　 ⟡ ${title} ⟡`,
    '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
    ...lines.map((line) => `　 ${line}`),
    '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',
    '　 ✦ 𝐎𝐫𝐢𝐡𝐢𝐦𝐞 𝐌𝐃 ✦',
    '╰──────────────────────╯'
  ].join('\n');
}

// Default media key for a command that doesn't pass its own `imageKey`.
// (Toggle commands like antilink/antidemote/left/welcome always pass an
// explicit `.<command> on`/`.<command> off` key instead, so their on/off
// states can use different media — see their call sites above.)
function commandImageKey(command) {
  return `.${command}`;
}

async function getBotOwner(session) {
  const stored = getStored(session);
  if (stored?.ownerJid) return stored.ownerJid;
  try {
    const me = await getMe(session);
    const ownerJid = normalizeJid(me?.id || me?.wid || '');
    if (ownerJid) {
      await upsertSession(session, { ownerJid });
      return ownerJid;
    }
  } catch {}
  return '';
}

async function sendIntro(session, chatId) {
  const sent = await sendText(session, chatId, INTRO);
  await sleep(DELAY);
  const messageId = sent?.id || sent?.messageId || sent?.data?.id;
  if (messageId) {
    try { await deleteMessage(session, chatId, messageId); } catch {}
  }
}

// A tiny "loading" animation: sends each frame, waits, deletes it, then moves
// to the next — so a command flashes through a couple of anime-style beats
// (✨ / 🌸 / ⚡) before its real, structured reply lands. WhatsApp has no
// native animated-message primitive, so this send→wait→delete sequence is
// what actually produces motion on screen.
async function sendAnimatedFrames(session, chatId, frames = []) {
  for (const frame of frames) {
    const sent = await sendText(session, chatId, `${frame}...`);
    await sleep(400);
    const messageId = sent?.id || sent?.messageId || sent?.data?.id;
    if (messageId) {
      try { await deleteMessage(session, chatId, messageId); } catch {}
    }
  }
}

// Sends whichever channel media is mapped to `key` — picked at random when a
// command has several images/videos attached — as a SINGLE message (the
// media plus its caption, nothing else sent before or after it). Works for
// both images and videos transparently.
async function sendChannelImage(session, chatId, key, caption) {
  const mapping = getChannelImage(key);
  if (!mapping?.localPath) {
    // A quick resync may pick up a newly posted channel image/video before giving the user an error.
    try { await syncChannelImages(session); } catch {}
  }
  const fresh = getChannelImage(key);
  const isVideo = fresh?.kind === 'video' || String(fresh?.mime || '').startsWith('video/');
  const sendFn = isVideo ? sendVideo : sendImage;
  const fallbackMime = isVideo ? 'video/mp4' : 'image/jpeg';
  if (fresh?.localPath) {
    try {
      const buffer = await fs.readFile(fresh.localPath);
      const mime = fresh.mime || fallbackMime;
      return await sendFn(session, chatId, {
        mimetype: mime,
        filename: `${key.replace(/[^a-z0-9]+/gi, '_').replace(/^_/, '') || 'orihime'}.${String(mime).split('/')[1] || (isVideo ? 'mp4' : 'jpg')}`,
        data: buffer.toString('base64')
      }, caption);
    } catch (error) {
      console.error('[bot] local media send failed', error?.message || error);
    }
  }
  const mediaUrl = fresh?.mediaUrl;
  if (mediaUrl) {
    try {
      const media = await downloadMedia(mediaUrl);
      const mime = media.contentType || fallbackMime;
      return await sendFn(session, chatId, {
        mimetype: mime,
        filename: `orihime.${String(mime).split('/')[1] || (isVideo ? 'mp4' : 'jpg')}`,
        data: media.buffer.toString('base64')
      }, caption);
    } catch (error) {
      console.error('[bot] remote media send failed', error?.message || error);
    }
  }
  return await sendText(session, chatId, `${caption}\n\n⚠️ Channel media for ${key} is not synchronized yet.`);
}

// ---------- view-once reveal (.vv) ----------
// Privacy rule for this feature: the media lives ONLY in memory for the few
// seconds it takes to fetch it and send it back. It is never written to disk,
// never put in the store/database, and .vv is not written to the command log.

// Depth-limited search for the object that carries the reply reference
// (GOWS/NOWEB keep it in contextInfo.stanzaID; field casing varies by engine).
function findReplyContext(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 7) return null;
  for (const key of Object.keys(node)) {
    if (key.toLowerCase() === 'stanzaid' && node[key]) return node;
  }
  for (const key of Object.keys(node)) {
    const found = findReplyContext(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

// Every message-id spelling WAHA might accept for the message that was replied to.
function quotedMessageIdCandidates(payload, chatId, selfIds) {
  const replyTo = payload?.replyTo || payload?._data?.replyTo || {};
  const ctx = findReplyContext(payload?._data) || {};
  const rawId = replyTo.id || replyTo.messageId || pickCtx(ctx, 'stanzaid');
  if (!rawId) return [];
  const rawParticipant = replyTo.participant || pickCtx(ctx, 'participant') || '';
  const participantJid = jidFromValue(rawParticipant);
  const fromMe = replyTo.fromMe === true || Boolean(participantJid && selfIds.includes(participantJid));

  const candidates = [String(rawId)];
  if (!String(rawId).includes('_')) {
    // Short id -> WAHA's serialized form: <fromMe>_<chatId>_<id>[_<participant>]
    const base = `${fromMe}_${chatId}_${rawId}`;
    if (isGroup(chatId)) {
      for (const p of [rawParticipant, participantJid]) if (p) candidates.push(`${base}_${p}`);
    }
    candidates.push(base);
    if (!fromMe) candidates.push(`true_${chatId}_${rawId}`);
  }
  return [...new Set(candidates)];
}

function pickCtx(obj, name) {
  for (const key of Object.keys(obj || {})) if (key.toLowerCase() === name) return obj[key];
  return undefined;
}

async function fetchQuotedMedia(session, chatId, payload) {
  const selfIds = await getSelfIds(session);
  const candidates = quotedMessageIdCandidates(payload, chatId, selfIds);
  if (!candidates.length) return { error: 'no-reply' };
  let lastError = '';
  for (const id of candidates) {
    try {
      const message = await getMessage(session, chatId, id);
      if (message?.hasMedia && message?.media?.url) return { message };
      if (message) lastError = message?.media?.error || (message.hasMedia ? 'media-not-downloaded' : 'no-media');
    } catch (error) {
      lastError = error?.response?.status ? `HTTP ${error.response.status}` : (error?.message || 'lookup-failed');
    }
  }
  return { error: lastError || 'not-found' };
}

async function revealViewOnce(session, chatId, payload) {
  const { message, error } = await fetchQuotedMedia(session, chatId, payload);
  if (error === 'no-reply') return sendText(session, chatId, '❌ Reply to a view-once message with .vv');
  if (!message) {
    const hint = error === 'no-media'
      ? 'That message has no image, video, audio or document.'
      : `Could not read that message (${error}). WAHA may not have kept the view-once media.`;
    return sendText(session, chatId, `❌ ${hint}`);
  }

  const wasViewOnce = Boolean(message.isViewOnce) || /viewonce/i.test(JSON.stringify(message._data || {}));
  let media = await downloadMedia(message.media.url); // in-memory only
  try {
    if (!media?.buffer?.length) return sendText(session, chatId, '❌ Could not download the view-once content.');
    const mimetype = String(message.media.mimetype || media.contentType || 'application/octet-stream').split(';')[0];
    const ext = mimetype.split('/')[1]?.split('+')[0] || 'bin';
    const file = {
      mimetype,
      filename: message.media.filename || `viewonce.${ext}`,
      data: media.buffer.toString('base64')
    };
    const caption = wasViewOnce ? '👁️ View-once revealed!' : '👁️ Media revealed!';
    if (mimetype.startsWith('image/')) return await sendImage(session, chatId, file, caption);
    if (mimetype.startsWith('video/')) return await sendVideo(session, chatId, file, caption);
    if (mimetype.startsWith('audio/')) {
      return /ogg|opus/i.test(mimetype) ? await sendVoice(session, chatId, file) : await sendFile(session, chatId, file, caption);
    }
    return await sendFile(session, chatId, file, caption);
  } finally {
    media = null; // drop the buffer; nothing was persisted
  }
}

// Reads the participant list. If the /participants endpoint returns nothing
// usable (empty, or no entry with a readable id), falls back to the group's
// own info object, which carries the same list on every WAHA engine.
async function resolveParticipants(session, groupId, { deep = false } = {}) {
  let list = [];
  let primaryError;
  try {
    list = extractParticipantList(await getParticipants(session, groupId));
  } catch (error) {
    primaryError = error;
  }
  const usable = list.some((p) => parseParticipant(p).ids.length);
  if (deep || !usable) {
    try {
      const info = extractParticipantList(await getGroupInfo(session, groupId));
      if (!usable) list = info.length ? info : list;
      else list = mergeEntries(list.map(parseParticipant), info.map(parseParticipant)).map((e) => e.raw);
    } catch (error) {
      if (!list.length && primaryError) throw primaryError;
    }
  }
  if (!list.length && primaryError) throw primaryError;
  return list;
}

function participantJid(p) { return parseParticipant(p).jid; }
function participantPhoneJid(p) { return parseParticipant(p).phoneJid; }
function participantRole(p) { return parseParticipant(p).role; }
function isParticipantAdmin(p) { return parseParticipant(p).isAdmin; }

// Every identifier we can find for whoever sent this message. In groups,
// payload.from is the GROUP, so the real sender lives in participant/author
// (and, on GOWS, _data.Info.Sender / SenderAlt — which may be the @lid twin).
function senderIdsFromPayload(payload, from) {
  const info = payload?._data?.Info || {};
  const candidates = [
    from,
    payload?.participant,
    payload?.author,
    payload?.sender,
    payload?._data?.participant,
    payload?._data?.author,
    info.Sender,
    info.SenderAlt
  ];
  const ids = [];
  for (const c of candidates) {
    const jid = jidFromValue(c);
    if (jid && !ids.includes(jid)) ids.push(jid);
  }
  return ids;
}

// The linked account's own identifiers (phone JID and, when WAHA reports it, LID).
async function getSelfIds(session) {
  const ids = [];
  try {
    for (const id of parseParticipant(await getMe(session)).ids) if (!ids.includes(id)) ids.push(id);
  } catch {}
  const owner = await getBotOwner(session);
  if (owner && !ids.includes(owner)) ids.push(owner);
  return ids;
}

// ONE source of truth for "who is admin here" — used by .listadmin, .whoami
// and every admin-gated command, so they can never disagree with each other.
async function getGroupAdminStatus(session, chatId, senderJid, payload) {
  const selfIds = await getSelfIds(session);
  const senderIds = senderIdsFromPayload(payload, normalizeJid(senderJid));
  const isSelf = Boolean(payload?.fromMe) || senderIds.some((id) => selfIds.includes(id));
  // The owner typing their own commands: the sender IS the linked account, so
  // match on every identifier the account has (phone JID and LID).
  const lookupIds = isSelf ? [...new Set([...senderIds, ...selfIds])] : senderIds;

  let entries = (await resolveParticipants(session, chatId)).map(parseParticipant);
  let senderEntry = findEntry(entries, lookupIds, { isSelf });
  let botEntry = findEntry(entries, selfIds, { isSelf: true });

  // Not found (or not admin) in the primary list? Cross-check the group info
  // before concluding — one endpoint's quirk shouldn't lock an admin out.
  if (!senderEntry?.isAdmin || !botEntry?.isAdmin) {
    try {
      const deep = (await resolveParticipants(session, chatId, { deep: true })).map(parseParticipant);
      entries = mergeEntries(entries, deep);
      senderEntry = findEntry(entries, lookupIds, { isSelf });
      botEntry = findEntry(entries, selfIds, { isSelf: true });
    } catch {}
  }
  // Sender and bot are provably the same account when the owner types.
  if (isSelf) {
    senderEntry = senderEntry || botEntry;
    botEntry = botEntry || senderEntry;
  }
  return {
    entries,
    admins: entries.filter((e) => e.isAdmin),
    selfIds,
    senderIds: lookupIds,
    isSelf,
    senderEntry,
    botEntry,
    senderIsAdmin: Boolean(senderEntry?.isAdmin),
    botIsAdmin: Boolean(botEntry?.isAdmin)
  };
}

async function assertGroupAdmin(session, chatId, senderJid, payload) {
  if (!isGroup(chatId)) return { ok: false, message: 'This command only works inside a group.' };
  const status = await getGroupAdminStatus(session, chatId, senderJid, payload);
  if (!status.senderEntry) {
    console.warn('[bot] sender not found in group participants', { chatId, senderIds: status.senderIds, participantCount: status.entries.length });
  }
  if (!status.senderIsAdmin) return { ok: false, message: '❌ Only group admins can use this command.' };
  if (!status.botIsAdmin) return { ok: false, message: '❌ I need group admin permission to perform this action.' };
  return { ok: true, participants: status.entries.map((e) => e.raw), ...status };
}

async function isSenderGroupAdmin(session, chatId, senderJid, payload) {
  try {
    return (await getGroupAdminStatus(session, chatId, senderJid, payload)).senderIsAdmin;
  } catch {
    return false;
  }
}

// Deep, engine-agnostic search for a mention list. Different WAHA engines
// (GOWS/NOWEB/WEBJS) put it in different places and under different casing —
// mentionedJid, mentionedJidList, MentionedJID inside ContextInfo, etc — so
// rather than trust one fixed path, walk the raw payload for the first array
// whose key name contains "mentionedjid".
function findMentionedJids(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  for (const key of Object.keys(node)) {
    if (/mentionedjid/i.test(key) && Array.isArray(node[key]) && node[key].length) return node[key];
  }
  for (const key of Object.keys(node)) {
    const found = findMentionedJids(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

// Every target a command like .kick/.promote/.demote/.autod was pointed at:
// every @mention (checked across every field/casing an engine might use),
// falling back to a bare "@number" typed in the args, and finally to whoever
// sent the message this command was replied to — so ".kick" as a reply works
// even with no explicit mention.
function targetsFromPayload(payload, args = []) {
  const direct = payload?.mentionedJid || payload?.mentioned || payload?.mentions
    || payload?._data?.mentionedJid || payload?._data?.mentionedJidList;
  const mentionList = (Array.isArray(direct) && direct.length) ? direct : (findMentionedJids(payload?._data) || []);
  const out = [];
  const push = (jid) => { if (jid && !out.includes(jid)) out.push(jid); };
  for (const m of mentionList) push(jidFromValue(m));
  for (const a of args) {
    if (a.startsWith('@')) push(normalizeJid(a.replace('@', '')));
  }
  if (!out.length) {
    const replyTo = payload?.replyTo || payload?._data?.replyTo || {};
    const ctx = findReplyContext(payload?._data) || {};
    push(jidFromValue(replyTo.participant || pickCtx(ctx, 'participant')));
  }
  return out;
}

function targetFromPayload(payload, args = []) {
  return targetsFromPayload(payload, args)[0] || '';
}

function mentionsFromParticipants(participants) {
  return participants.map(participantJid).filter(Boolean);
}

async function run2048(session, chatId, senderJid, move) {
  const key = `${session}:${chatId}:${senderJid}`;
  let state = GAME_SESSIONS.get(key);
  if (!state) {
    state = { grid: [[2,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]], score: 0 };
    GAME_SESSIONS.set(key, state);
  }
  if (move) state = move2048(state, move);
  const text = render2048(state);
  await sendText(session, chatId, `${text}\n\nUse .2048 up/down/left/right`);
}

function compress(row) {
  const a = row.filter(Boolean);
  const out = [];
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === a[i + 1]) { out.push(a[i] * 2); i += 1; }
    else out.push(a[i]);
  }
  while (out.length < 4) out.push(0);
  return out;
}
function moveGrid(grid, dir) {
  const rotated = dir === 'up' || dir === 'down' ? transpose(grid) : grid.map((r) => [...r]);
  if (dir === 'right') rotated.forEach((r, i) => { rotated[i] = compress([...r].reverse()).reverse(); });
  else if (dir === 'left') rotated.forEach((r, i) => { rotated[i] = compress(r); });
  else if (dir === 'up') rotated.forEach((r, i) => { rotated[i] = compress(r); });
  else if (dir === 'down') rotated.forEach((r, i) => { rotated[i] = compress([...r].reverse()).reverse(); });
  const result = (dir === 'up' || dir === 'down') ? transpose(rotated) : rotated;
  let added = false;
  const empty = [];
  result.forEach((r, i) => r.forEach((v, j) => { if (!v) empty.push([i,j]); }));
  if (empty.length) { const [i,j] = empty[Math.floor(Math.random() * empty.length)]; result[i][j] = Math.random() < 0.9 ? 2 : 4; added = true; }
  return { result, added };
}
function transpose(g) { return g[0].map((_, c) => g.map((r) => r[c])); }
function move2048(state, dir) {
  if (!['up','down','left','right'].includes(dir)) return state;
  const before = JSON.stringify(state.grid);
  const moved = moveGrid(state.grid, dir);
  return { grid: moved.result, score: state.score + (JSON.stringify(moved.result) === before ? 0 : 1) };
}
function render2048(state) {
  return ['╭──── 2048 ────╮', ...state.grid.map((r) => `│ ${r.map((v) => String(v || '·').padStart(4, ' ')).join(' ')} │`), `╰──── Score ${state.score} ────╯`].join('\n');
}

async function genericStatus(session, chatId, command, lines, options = {}) {
  const key = options.imageKey || commandImageKey(command);
  const caption = statusCaption(options.title || command.toUpperCase(), lines);
  return sendChannelImage(session, chatId, key, caption);
}

// Deletes a message and, per policy, always tags the sender with a short
// warning so removal is never silent — used by every auto-moderation path
// (antilink/antibot/antichannel/kill-sale/autod).
async function deleteWithWarning(session, chatId, messageId, senderJid, reason) {
  try { await deleteMessage(session, chatId, messageId); } catch { return; }
  try {
    await sendText(session, chatId, `⚠️ 𝐌𝐄𝐒𝐒𝐀𝐆𝐄 𝐑𝐄𝐌𝐎𝐕𝐄𝐃\n👤 @${jidNumber(senderJid)}\n📝 ${reason}`, { mentions: [senderJid] });
  } catch {}
}


async function groupDetails(session, groupId, fallback = {}) {
  try {
    const group = await getGroupInfo(session, groupId);
    return group || fallback;
  } catch {
    return fallback;
  }
}

function groupSubject(group, fallback = 'this group') {
  return String(group?.subject || group?.name || group?.title || fallback);
}

function groupParticipantsFromPayload(payload) {
  return Array.isArray(payload?.participants) ? payload.participants : [];
}

function eventParticipantJids(payload) {
  return groupParticipantsFromPayload(payload).map(participantJid).filter(Boolean);
}

async function currentMemberCount(session, groupId) {
  try {
    const participants = await resolveParticipants(session, groupId);
    return participants.length;
  } catch {
    return null;
  }
}

async function sendWelcomeOrGoodbye(session, groupId, participantJids, type, groupFromEvent = {}) {
  if (!isGroup(groupId) || !participantJids.length) return;
  const config = getGroup(groupId);
  const enabled = type === 'join' ? config.welcome : config.left;
  if (!enabled) return;
  const group = await groupDetails(session, groupId, groupFromEvent);
  const name = groupSubject(group);
  const count = await currentMemberCount(session, groupId);
  const memberText = participantJids.map((jid) => `@${jidNumber(jid)}`).join(', ');
  const caption = type === 'join'
    ? statusCaption('🌸 𝐖𝐄𝐋𝐂𝐎𝐌𝐄', [
        `👋 Welcome : ${memberText}`,
        `👥 Group : ${name}`,
        `📊 Members : ${count ?? 'Unknown'}`,
        '💗 We are happy to have you here!'
      ])
    : statusCaption('👋 𝐆𝐎𝐎𝐃𝐁𝐘𝐄', [
        `👋 Left : ${memberText}`,
        `👥 Group : ${name}`,
        `📊 Members : ${count ?? 'Unknown'}`
      ]);
  const key = type === 'join' ? '.welcom' : '.left';
  const sent = await sendChannelImage(session, groupId, key, caption);
  // Add mentions to a follow-up only when the channel-image sender cannot attach them.
  // WAHA's image endpoint accepts a caption but mention metadata varies by engine, so keep the greeting reliable.
  return sent;
}

// Loop guard: every promote/demote the bot performs on behalf of
// .antidemote/.antipromote generates its own group.v2.participants webhook
// event. Without this, the bot's own corrective action would immediately
// trigger the opposite rule and the two would fight forever. Each self
// action is remembered for a few seconds — long enough to absorb the
// resulting webhook — then forgotten.
const SELF_ACTIONS = new Map();
function markSelfAction(groupId, jid, type) {
  SELF_ACTIONS.set(`${groupId}:${jid}:${type}`, Date.now());
}
function consumeSelfAction(groupId, jid, type) {
  const key = `${groupId}:${jid}:${type}`;
  const at = SELF_ACTIONS.get(key);
  if (!at) return false;
  SELF_ACTIONS.delete(key);
  return Date.now() - at < 15000;
}

async function handleParticipantsEvent(session, groupId, payload) {
  const type = String(payload?.type || payload?.action || '').toLowerCase();
  if (!['promote', 'demote'].includes(type)) return;
  const config = getGroup(groupId);
  const targets = eventParticipantJids(payload);
  if (!targets.length) return;
  const selfIds = await getSelfIds(session);

  if (type === 'demote' && config.antidemote) {
    for (const target of targets) {
      if (selfIds.includes(target)) continue; // the bot's own role is never auto-restored
      if (consumeSelfAction(groupId, target, 'demote')) continue; // this demote WAS the bot's own antipromote correction — don't fight it
      try {
        await promoteParticipants(session, groupId, [target]);
        markSelfAction(groupId, target, 'promote'); // the promote event this causes is self-caused — antipromote should ignore it
        await sendText(session, groupId, `🛡️ 𝐀𝐍𝐓𝐈𝐃𝐄𝐌𝐎𝐓𝐄\n👤 @${jidNumber(target)} was demoted by another admin and has been restored to admin instantly.`, { mentions: [target] });
      } catch (error) {
        console.error('[antidemote]', error?.response?.data || error?.message || error);
      }
    }
  }

  if (type === 'promote' && config.antipromote) {
    for (const target of targets) {
      if (selfIds.includes(target)) continue;
      if (consumeSelfAction(groupId, target, 'promote')) continue; // this promote WAS the bot's own antidemote correction — don't fight it
      try {
        await demoteParticipants(session, groupId, [target]);
        markSelfAction(groupId, target, 'demote'); // the demote event this causes is self-caused — antidemote should ignore it
        await sendText(session, groupId, `🛡️ 𝐀𝐍𝐓𝐈𝐏𝐑𝐎𝐌𝐎𝐓𝐄\n👤 @${jidNumber(target)} was promoted by an admin and has been demoted back instantly.`, { mentions: [target] });
      } catch (error) {
        console.error('[antipromote]', error?.response?.data || error?.message || error);
      }
    }
  }
}

export async function handleGroupEvent(session, eventName, payload) {
  const groupId = payload?.group?.id || payload?.id;
  if (!isGroup(groupId)) return;
  if (eventName === 'group.v2.participants') {
    try { await handleParticipantsEvent(session, groupId, payload); } catch (error) {
      console.error('[group participants]', error?.response?.data || error?.message || error);
    }
    return;
  }
  const type = payload?.type || (eventName === 'group.v2.join' ? 'join' : eventName === 'group.v2.leave' ? 'leave' : '');
  const participants = eventParticipantJids(payload);
  if (!participants.length || !['join', 'leave'].includes(type)) return;
  try {
    await sendWelcomeOrGoodbye(session, groupId, participants, type, payload?.group || {});
  } catch (error) {
    console.error(`[group ${type}]`, error?.response?.data || error?.message || error);
  }
}

export async function handleWebhookEvent(session, payload) {
  if (!session || !payload) return;
  const chatId = payload.from || payload.chatId || payload._data?.Info?.Chat;

  // Messages the bot receives *from the channel it follows* (to sync command
  // images) are not commands from a user — without this guard, every image
  // posted to the channel with a caption like ".menu" gets parsed as a live
  // command and the reply is sent back into the channel thread instead of
  // wherever a real user actually typed the command.
  if (String(chatId || '').endsWith('@newsletter')) return;

  const body = payload.body || payload.text || payload.caption || '';
  const owner = await getBotOwner(session);
  // WhatsApp reports every message sent by the linked account itself with
  // fromMe: true — that's how the owner's own typed commands arrive. In that
  // case `from`/`sender`/`author` usually describe the chat (or the other
  // party in a DM), not the linked account, so resolve the real sender as
  // the owner directly instead of trusting those fields.
  // In a group, payload.from is the GROUP id — the person who typed is in
  // participant/author — so read those first there, or no one but the owner
  // could ever be recognized as an admin.
  const senderCandidates = isGroup(chatId)
    ? [payload.participant, payload.author, payload.sender, payload._data?.Info?.Sender, payload._data?.Info?.SenderAlt]
    : [payload.from, payload.sender, payload.author, payload._data?.Info?.Sender];
  const resolvedSender = senderCandidates.map(jidFromValue).find(Boolean) || '';
  const from = payload.fromMe ? (owner || resolvedSender) : resolvedSender;

  // Auto-moderation events work independently of commands. Never moderate
  // the linked account's own messages.
  if (chatId && !payload.fromMe) {
    const config = isGroup(chatId) ? getGroup(chatId) : null;
    const autoDeleteUsers = Array.isArray(config?.autoDeleteUsers) ? config.autoDeleteUsers : [];
    if (autoDeleteUsers.length) {
      // Match on EVERY identifier this message could be carrying for its
      // sender (phone JID and/or @lid) — not just the one `from` happened to
      // resolve to — since .autod stores every known id for its target and a
      // message can arrive tagged with either form depending on the engine.
      const candidateIds = senderIdsFromPayload(payload, from);
      if (candidateIds.some((id) => autoDeleteUsers.includes(id))) {
        const id = payload?.id || payload?.messageId || payload?._data?.Info?.ID;
        if (id) await deleteWithWarning(session, chatId, id, from, '🗑️ Auto-delete is active for this member.');
        return;
      }
    }
    await moderateIncoming(session, chatId, payload, from, body);
  }

  const stored = getStored(session);
  const prefix = stored?.prefix || DEFAULT_PREFIX;

  // fromMe always means the linked account sent it, so it's always the owner —
  // no need to double-check a JID match in that case.
  const isOwner = payload.fromMe || Boolean(owner && from === owner) || Boolean(OWNER_OVERRIDE && jidNumber(from) === OWNER_OVERRIDE);
  const mode = stored?.mode || 'PRIVATE';

  // These are intentionally public no matter the session's PRIVATE/PUBLIC
  // mode: .pair lets a brand-new visitor create and link THEIR OWN session
  // (which is the whole point of self-service pairing), and .link just
  // hands out public links — neither exposes anything about this session.
  const ALWAYS_PUBLIC_COMMANDS = new Set(['pair', 'link']);
  const blockedByPrivateMode = (name) => mode === 'PRIVATE' && !isOwner && !ALWAYS_PUBLIC_COMMANDS.has(name);

  // A tap on the interactive menu (list/button reply) arrives as a message
  // event too, but with no ".command" text — it carries a rowId/buttonId
  // instead. Route those through the menu navigator rather than the normal
  // text-command parser.
  const selectedRowId = extractSelectedRowId(payload);
  if (selectedRowId) {
    try {
      await handleMenuSelection({ session, chatId, from, payload, isOwner, prefix, blockedByPrivateMode, rowId: selectedRowId });
    } catch (error) {
      console.error('[bot] menu selection failed:', error?.response?.data || error?.message || error);
    }
    return;
  }

  const parsed = parseCommand(body, prefix);
  if (!parsed) return;

  // .vv is deliberately not logged: nothing about a revealed view-once message is stored.
  if (parsed.name !== 'vv') {
    await appendCommandLog({ session, chatId, sender: from, command: parsed.name, args: parsed.args, raw: body });
  }

  await sendIntro(session, chatId);

  if (blockedByPrivateMode(parsed.name)) {
    await genericStatus(session, chatId, 'repel', [
      '⛔ 𝐀𝐜𝐜𝐞𝐬𝐬 : 𝐃𝐄𝐍𝐈𝐄𝐃',
      '🔒 Mode : 𝐏𝐑𝐈𝐕𝐀𝐓𝐄',
      '👑 Access : 𝐎𝐖𝐍𝐄𝐑 𝐎𝐍𝐋𝐘',
      '❌ Your command was not executed.'
    ], { imageKey: '.repel', title: '⛔ 𝐀𝐂𝐂𝐄𝐒𝐒 𝐃𝐄𝐍𝐈𝐄𝐃' });
    return;
  }

  try {
    await executeCommand({ session, chatId, from, parsed, payload, isOwner });
  } catch (error) {
    console.error(`[bot] ${parsed.name} failed:`, error?.response?.data || error?.message || error);
    await genericStatus(session, chatId, parsed.name, [
      '🔴 Status : 𝐄𝐑𝐑𝐎𝐑',
      `⚠️ ${String(error?.response?.data?.message || error?.message || 'Command failed').slice(0, 250)}`,
      `👤 Requested by : ${formatRequestedBy(from)}`
    ], { title: parsed.name.toUpperCase() });
  }
}

// Sends a WAHA list message, silently falling back to the classic
// plain-text menu (as a normal chat message) if the interactive send fails —
// e.g. because this WAHA session isn't on the NOWEB engine, or the
// connected WhatsApp client doesn't render the message type. This is the
// safety net mentioned in menu.js: `.menu` always produces something usable.
// A single bubble that visibly ANIMATES: send the first frame, then rewrite
// that same message several times (WhatsApp shows it flip through each
// frame in place, tagged "edited") instead of a flicker of separate
// messages. This is what makes .menu feel "moving" rather than static.
// If this session's WAHA engine/version can't edit messages, it quietly
// stops after the first frame — the menu still sends normally either way.
async function sendEditingAnimation(session, chatId, frames = [], holdMs = 450) {
  if (!frames.length) return null;
  let sent;
  try {
    sent = await sendText(session, chatId, frames[0]);
  } catch (error) {
    console.error('[bot] menu animation: initial send failed', error?.message || error);
    return null;
  }
  const messageId = sent?.id || sent?.messageId || sent?.data?.id;
  if (messageId) {
    for (const frame of frames.slice(1)) {
      await sleep(holdMs);
      try {
        await editMessage(session, chatId, messageId, frame);
      } catch (error) {
        // Engine/version doesn't support editing (e.g. WEBJS, or an older
        // WAHA build) — stop animating, leave whatever frame is on screen.
        console.error('[bot] menu animation: edit unsupported, stopping', error?.response?.data || error?.message || error);
        break;
      }
    }
  }
  await sleep(holdMs);
  return { messageId };
}

// The frames .menu flips through before the real interactive list lands —
// a little "materializing" beat, Orihime-styled.
const MENU_ANIMATION_FRAMES = [
  '⋆｡‧˚ʚ🌸ɞ˚‧｡⋆',
  '⋆｡‧˚ʚ🌸ɞ˚‧｡⋆\n✨ waking up Orihime...',
  '⋆｡‧˚ʚ🌸ɞ˚‧｡⋆\n✨✨ loading your menu...',
  '⋆｡‧˚ʚ🌸ɞ˚‧｡⋆\n✨✨✨ almost there...',
  '╭─❰ 🌸 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 · 𝐌𝐃 ❱──╮\n　 ✦ menu is ready ✦\n╰──────────────────────╯'
];

async function sendInteractiveOrFallback(session, chatId, listPayload, fallbackText) {
  try {
    await sendList(session, chatId, listPayload);
  } catch (error) {
    console.error('[menu] interactive send failed, falling back to text:', error?.response?.data || error?.message || error);
    await sendText(session, chatId, fallbackText);
  }
}

// Handles every tap on the interactive menu: opening a category, opening a
// toggle's ON/OFF picker, sending a usage hint for a command that needs free
// text WhatsApp can't collect from a list reply, running a no-arg command,
// or running a toggle with the ON/OFF the user picked.
async function handleMenuSelection({ session, chatId, from, payload, isOwner, prefix, blockedByPrivateMode, rowId }) {
  const selection = parseSelection(rowId);
  if (!selection) return;

  if (selection.type === 'home') {
    return sendInteractiveOrFallback(session, chatId, buildMainMenuPayload(prefix), buildMenuText(prefix));
  }

  if (selection.type === 'category') {
    if (blockedByPrivateMode('menu')) return; // browsing follows the same PRIVATE-mode gate as .menu itself
    const listPayload = buildCategoryPayload(selection.category, prefix);
    if (!listPayload) return;
    return sendInteractiveOrFallback(session, chatId, listPayload, buildMenuText(prefix));
  }

  if (selection.type === 'toggle') {
    if (blockedByPrivateMode(selection.command)) return;
    const listPayload = buildTogglePayload(selection.command, prefix);
    if (!listPayload) return;
    return sendInteractiveOrFallback(session, chatId, listPayload, `Type: ${prefix}${selection.command} on  or  ${prefix}${selection.command} off`);
  }

  if (selection.type === 'hint') {
    if (blockedByPrivateMode(selection.command)) return;
    const text = usageFor(selection.command, prefix);
    if (text) await sendText(session, chatId, text);
    return;
  }

  if (selection.type === 'run') {
    if (blockedByPrivateMode(selection.command)) return;
    const args = selection.arg ? [selection.arg] : [];
    const parsed = { name: selection.command, args, raw: `${prefix}${selection.command} ${args.join(' ')}`.trim() };
    if (parsed.name !== 'vv') {
      await appendCommandLog({ session, chatId, sender: from, command: parsed.name, args: parsed.args, raw: parsed.raw });
    }
    try {
      await executeCommand({ session, chatId, from, parsed, payload, isOwner });
    } catch (error) {
      console.error(`[bot] ${parsed.name} (menu) failed:`, error?.response?.data || error?.message || error);
      await genericStatus(session, chatId, parsed.name, [
        '🔴 Status : 𝐄𝐑𝐑𝐎𝐑',
        `⚠️ ${String(error?.response?.data?.message || error?.message || 'Command failed').slice(0, 250)}`,
        `👤 Requested by : ${formatRequestedBy(from)}`
      ], { title: parsed.name.toUpperCase() });
    }
  }
}

async function executeCommand({ session, chatId, from, parsed, payload, isOwner }) {
  const { name, args } = parsed;
  const joined = args.join(' ');
  const senderMention = formatRequestedBy(from);

  switch (name) {
    case 'menu': {
      const menuPrefix = getStored(session)?.prefix || DEFAULT_PREFIX;
      // Animate a single bubble through a few frames first — this is the
      // "moving" part — then clear it and send the real interactive menu.
      const animation = await sendEditingAnimation(session, chatId, MENU_ANIMATION_FRAMES);
      if (animation?.messageId) {
        try { await deleteMessage(session, chatId, animation.messageId); } catch {}
      }
      // If the operator has posted a ".menu" image/video in the channel,
      // lead with it (silently skipped if none is synced yet — no need to
      // spam a "not synchronized" warning for something optional). The
      // actual navigable menu always goes out right after, as an
      // interactive list.
      if (getChannelImage('.menu')) {
        await sendChannelImage(session, chatId, '.menu', '🌸').catch(() => {});
      }
      await sendInteractiveOrFallback(session, chatId, buildMainMenuPayload(menuPrefix), buildMenuText(menuPrefix));
      return;
    }

    case 'ping': {
      const started = Date.now();
      const remote = await getSession(session);
      const ms = Date.now() - started;
      await genericStatus(session, chatId, 'ping', [
        `🟢 Status : ${remote?.status || 'WORKING'}`,
        `⚡ Speed : ${ms} ms`,
        `👤 Requested by : ${senderMention}`
      ], { title: '⚡ 𝐏𝐈𝐍𝐆' });
      return;
    }

    case 'setprefix': {
      if (!isOwner) return sendText(session, chatId, '❌ Owner only.');
      const next = args[0];
      if (!next || /\s/.test(next) || next.length > 3) {
        return genericStatus(session, chatId, 'setprefix', ['❌ Usage : .setprefix <symbol>', 'Example : .setprefix !'], { title: '⚙️ 𝐒𝐄𝐓 𝐏𝐑𝐄𝐅𝐈𝐗' });
      }
      const before = getStored(session)?.prefix || DEFAULT_PREFIX;
      await upsertSession(session, { prefix: next });
      await genericStatus(session, chatId, 'setprefix', [
        `✅ Status : 𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃`,
        `⚡ Prefix : ${before} → ${next}`,
        `👤 Requested by : ${senderMention}`
      ], { title: '⚙️ 𝐒𝐄𝐓 𝐏𝐑𝐄𝐅𝐈𝐗' });
      return;
    }

    case 'public': {
      if (!isOwner) return sendText(session, chatId, '❌ Owner only.');
      await upsertSession(session, { mode: 'PUBLIC' });
      await genericStatus(session, chatId, 'public', ['🟢 Status : 𝐏𝐔𝐁𝐋𝐈𝐂 𝐌𝐎𝐃𝐄', '👥 Other users can now use commands.', `👤 Requested by : ${senderMention}`], { title: '🌐 𝐏𝐔𝐁𝐋𝐈𝐂' });
      return;
    }

    case 'private': {
      if (!isOwner) return sendText(session, chatId, '❌ Owner only.');
      await upsertSession(session, { mode: 'PRIVATE' });
      await genericStatus(session, chatId, 'private', ['🔒 Status : 𝐏𝐑𝐈𝐕𝐀𝐓𝐄 𝐌𝐎𝐃𝐄', '👑 Only the linked owner can use commands.', `👤 Requested by : ${senderMention}`], { title: '🔒 𝐏𝐑𝐈𝐕𝐀𝐓𝐄' });
      return;
    }

    case 'joke':
    case 'blague': {
      const joke = JOKES[Math.floor(Math.random() * JOKES.length)];
      await genericStatus(session, chatId, name, [`🎀 ${joke}`, `👤 Requested by : ${senderMention}`], { title: name === 'joke' ? '😂 𝐉𝐎𝐊𝐄' : '😂 𝐁𝐋𝐀𝐆𝐔𝐄' });
      await sendText(session, chatId, joke);
      return;
    }

    case 'orihime-wipe': {
      await clearHistory({ session, chatId });
      await genericStatus(session, chatId, name, ['🧹 Status : 𝐖𝐈𝐏𝐄 𝐂𝐎𝐌𝐏𝐋𝐄𝐓𝐄', '🗑️ Recent command history for this chat was cleared.'], { title: '🧹 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 𝐖𝐈𝐏𝐄' });
      return;
    }

    case 'orihime-history': {
      const rows = commandHistory({ session, chatId, limit: 10 });
      const text = rows.length ? rows.map((r) => `• ${new Date(r.timestamp).toLocaleString()} — .${r.command}`).join('\n') : 'No command history yet.';
      await genericStatus(session, chatId, name, ['📜 Recent commands:', text], { title: '📜 𝐇𝐈𝐒𝐓𝐎𝐑𝐘' });
      return;
    }

    case 'antilink':
    case 'antibot':
    case 'antichannel': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      const action = String(args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(action)) {
        return genericStatus(session, chatId, name, [`⚠️ Usage : .${name} on`, `⚠️ Usage : .${name} off`], { title: `⚙️ ${name.toUpperCase()}` });
      }
      const patch = { [name]: action === 'on' };
      await setGroup(chatId, patch);
      await genericStatus(session, chatId, name, [
        `✅ Status : ${action === 'on' ? '𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃' : '𝐃𝐄𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃'}`,
        `⚙️ ${name} : ${action.toUpperCase()}`,
        `👤 Requested by : ${senderMention}`
      ], { imageKey: `.${name} ${action}`, title: `⚙️ ${name.toUpperCase()}`, imageArgs: [action] });
      return;
    }

    case 'kill-sale': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      const action = String(args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(action)) {
        return genericStatus(session, chatId, name, [`⚠️ Usage : .${name} on`, `⚠️ Usage : .${name} off`], { title: `⚙️ ${name.toUpperCase()}` });
      }
      await setGroup(chatId, { killSale: action === 'on' });
      await genericStatus(session, chatId, name, [
        `✅ Status : ${action === 'on' ? '𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃' : '𝐃𝐄𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃'}`,
        `⚙️ ${name} : ${action.toUpperCase()}`,
        action === 'on' ? '🚫 Sale/price/availability messages from non-admins will be deleted.' : '',
        `👤 Requested by : ${senderMention}`
      ].filter(Boolean), { imageKey: `.${name} ${action}`, title: `⚙️ ${name.toUpperCase()}`, imageArgs: [action] });
      return;
    }

    case 'antidemote':
    case 'antipromote': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      const action = String(args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(action)) {
        return genericStatus(session, chatId, name, [`⚠️ Usage : .${name} on`, `⚠️ Usage : .${name} off`], { title: `🛡️ ${name.toUpperCase()}` });
      }
      await setGroup(chatId, { [name]: action === 'on' });
      const explain = name === 'antidemote'
        ? '🛡️ If another admin demotes an admin, they are re-promoted within seconds (the bot itself is never re-promoted this way).'
        : '🛡️ If an admin promotes someone, they are demoted back within seconds.';
      await genericStatus(session, chatId, name, [
        `✅ Status : ${action === 'on' ? '𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃' : '𝐃𝐄𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃'}`,
        `⚙️ ${name} : ${action.toUpperCase()}`,
        action === 'on' ? explain : '',
        `👤 Requested by : ${senderMention}`
      ].filter(Boolean), { imageKey: `.${name} ${action}`, title: `🛡️ ${name.toUpperCase()}` });
      return;
    }

    case 'candy':
    case 'candycrush': {
      const grid = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => ['🍬','🍭','🍫','🍓','🍡'][Math.floor(Math.random() * 5)]));
      GAME_SESSIONS.set(`${session}:${chatId}:${from}:candy`, { grid });
      await genericStatus(session, chatId, name, ['🎮 Game started!', 'Match 3 or more identical candies conceptually.', grid.map((r) => r.join(' ')).join('\n')], { title: name === 'candy' ? '🍬 𝐂𝐀𝐍𝐃𝐘' : '🍭 𝐂𝐀𝐍𝐃𝐘 𝐂𝐑𝐔𝐒𝐇' });
      return;
    }

    case 'crossword': {
      const puzzle = ['╭── Crossword ──╮', '│ 1. WhatsApp bot library (6)', '│ 2. Anime heroine (8)', '│ 3. Number game (4)', '╰────────────────╯', '', 'Reply with: 1 <answer> / 2 <answer> / 3 <answer>'];
      await genericStatus(session, chatId, name, puzzle, { title: '🧩 𝐂𝐑𝐎𝐒𝐒𝐖𝐎𝐑𝐃' });
      return;
    }

    case 'wordgame': {
      const words = ['ORIHIME','KESSHUN','WHATSAPP','ANIME','WAHA','BOT'];
      const answer = words[Math.floor(Math.random() * words.length)];
      const scrambled = answer.split('').sort(() => Math.random() - 0.5).join('');
      GAME_SESSIONS.set(`${session}:${chatId}:${from}:word`, { answer });
      await genericStatus(session, chatId, name, [`🔤 Unscramble : ${scrambled}`, 'Reply with your guess.'], { title: '🔤 𝐖𝐎𝐑𝐃 𝐆𝐀𝐌𝐄' });
      return;
    }

    case '2048': {
      await run2048(session, chatId, from, args[0]);
      return;
    }

    case 'kick':
    case 'promote':
    case 'demote': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      const targets = targetsFromPayload(payload, args);
      if (!targets.length) {
        return sendText(session, chatId, `❌ Mention the user (or reply to their message): .${name} @user`);
      }
      const done = [];
      const failed = [];
      for (const target of targets) {
        try {
          if (name === 'kick') await removeParticipants(session, chatId, [target]);
          else if (name === 'promote') await promoteParticipants(session, chatId, [target]);
          else await demoteParticipants(session, chatId, [target]);
          done.push(target);
        } catch (error) {
          console.error(`[bot] ${name} failed for ${target}:`, error?.response?.data || error?.message || error);
          failed.push(target);
        }
      }
      const verb = name === 'kick' ? '𝐊𝐈𝐂𝐊𝐄𝐃' : name === 'promote' ? '𝐏𝐑𝐎𝐌𝐎𝐓𝐄𝐃' : '𝐃𝐄𝐌𝐎𝐓𝐄𝐃';
      const lines = [
        `${done.length ? '✅' : '🔴'} Status : ${done.length ? verb : '𝐅𝐀𝐈𝐋𝐄𝐃'}`,
        `🛠️ Action : ${name.toUpperCase()}`
      ];
      if (done.length) lines.push(`👤 Target${done.length > 1 ? 's' : ''} : ${done.map((t) => `@${jidNumber(t)}`).join(', ')}`);
      if (failed.length) lines.push(`⚠️ Could not ${name} : ${failed.map((t) => `@${jidNumber(t)}`).join(', ')}`);
      lines.push(`👤 Requested by : ${senderMention}`);
      await genericStatus(session, chatId, name, lines, {
        title: `👥 ${name.toUpperCase()}`
      });
      return;
    }

    case 'add': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      const rawNumber = String(args[0] || '').trim();
      const digits = rawNumber.replace(/\D/g, '');
      if (!digits || digits.length < 7) {
        return sendText(session, chatId, `❌ Usage : .add <phone number>\nExample : .add 15551234567`);
      }
      const target = normalizeJid(digits);
      await addParticipants(session, chatId, [target]);
      await genericStatus(session, chatId, name, [
        `✅ Status : 𝐒𝐔𝐂𝐂𝐄𝐒𝐒`,
        `👤 Added : @${jidNumber(target)}`,
        `🛠️ Action : ADD`
      ], { title: '👥 𝐀𝐃𝐃' });
      return;
    }

    case 'kickall': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      if (String(args[0]).toLowerCase() !== 'confirm') {
        return genericStatus(session, chatId, name, ['⚠️ This removes every non-admin member.', 'Use `.kickall confirm` to continue.'], { title: '⚠️ 𝐊𝐈𝐂𝐊 𝐀𝐋𝐋' });
      }
      const participants = gate.participants;
      const targets = participants.filter((p) => !isParticipantAdmin(p)).map(participantJid).filter(Boolean);
      if (targets.length) await removeParticipants(session, chatId, targets);
      await genericStatus(session, chatId, name, [`✅ Removed : ${targets.length} members.`], { title: '⚠️ 𝐊𝐈𝐂𝐊 𝐀𝐋𝐋' });
      return;
    }

    case 'tagall': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      const participants = gate.participants.map(participantJid).filter(Boolean);
      await genericStatus(session, chatId, name, [`👥 Members : ${participants.length}`, '📣 Tagging one by one...'], { title: '📣 𝐓𝐀𝐆 𝐀𝐋𝐋' });
      for (const member of participants) {
        await sendText(session, chatId, `@${jidNumber(member)}`, { mentions: [member] });
        await sleep(350);
      }
      return;
    }

    case 'hidetag': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      await sendText(session, chatId, joined || '🌸 Orihime MD', { mentions: ['all'] });
      await genericStatus(session, chatId, name, ['✅ Status : 𝐒𝐄𝐍𝐓', '👥 Everyone was mentioned invisibly.'], { title: '👥 𝐇𝐈𝐃𝐄𝐓𝐀𝐆' });
      return;
    }

    case 'invite': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      const invite = await getInviteCode(session, chatId);
      const code = invite?.code || invite?.inviteCode || invite;
      await genericStatus(session, chatId, name, [`🔗 Invite : ${code || 'Unavailable'}`], { title: '🔗 𝐈𝐍𝐕𝐈𝐓𝐄' });
      return;
    }

    case 'link': {
      // Public — anyone can run this, no admin gate.
      await sendAnimatedFrames(session, chatId, ['🔗 Gathering links', '✨ Polishing the card']);
      const owner = await getBotOwner(session);
      const botNumber = jidNumber(owner);
      const stored = getChannelLink('channel');
      const channelUrl = stored?.url || CHANNEL_REF;
      const lines = [
        '╭━━━〔 🔗 𝐋𝐈𝐍𝐊𝐒 〕━━━╮',
        '┃ 📡 𝐎𝐟𝐟𝐢𝐜𝐢𝐚𝐥 𝐂𝐡𝐚𝐧𝐧𝐞𝐥',
        `┃ ${channelUrl}`,
        '┃',
        '┃ 🤖 𝐂𝐡𝐚𝐭 𝐰𝐢𝐭𝐡 𝐭𝐡𝐞 𝐁𝐨𝐭',
        `┃ ${botNumber ? `https://wa.me/${botNumber}` : 'Unavailable — bot is not linked yet'}`,
        '╰━━━━━━━━━━━━━━━━━━━━╯',
        '',
        '💗 Tap either link to open it directly.'
      ];
      if (isGroup(chatId)) {
        try {
          const invite = await getInviteCode(session, chatId);
          const code = invite?.code || invite?.inviteCode;
          if (code) lines.splice(6, 0, '┃', '┃ 👥 𝐓𝐡𝐢𝐬 𝐆𝐫𝐨𝐮𝐩', `┃ https://chat.whatsapp.com/${code}`);
        } catch {} // not a group admin / bot isn't admin here — silently omit
      }
      await genericStatus(session, chatId, name, lines, { title: '🔗 𝐋𝐈𝐍𝐊𝐒' });
      return;
    }

    case 'pair': {
      const rawNumber = String(args[0] || '').trim();
      if (!rawNumber) return sendText(session, chatId, `❌ Usage : .pair <number>\nExample : .pair 2348163201351`);
      await sendAnimatedFrames(session, chatId, ['🌸 Creating your session', '🔐 Requesting your pairing code']);
      const result = await createPairingSession(rawNumber);
      if (!result.ok) {
        await genericStatus(session, chatId, name, [
          '🔴 Status : 𝐅𝐀𝐈𝐋𝐄𝐃',
          `⚠️ ${String(result.error || 'Could not generate a pairing code').slice(0, 200)}`
        ], { title: '🌸 𝐏𝐀𝐈𝐑' });
        return;
      }
      await genericStatus(session, chatId, name, [
        '✅ Status : 𝐂𝐎𝐃𝐄 𝐑𝐄𝐀𝐃𝐘',
        `🔢 Pairing code : ${result.code || 'Check the dashboard'}`,
        `📱 Number ending in : ${result.phoneLast4}`,
        '',
        '📋 𝐇𝐨𝐰 𝐭𝐨 𝐩𝐚𝐢𝐫 :',
        '1️⃣ Open WhatsApp on the phone you gave.',
        '2️⃣ Settings → Linked devices → Link a device.',
        '3️⃣ Tap "Link with phone number instead".',
        '4️⃣ Enter the code above.',
        '',
        '⏳ This code expires quickly — pair right away.'
      ], { title: '🌸 𝐏𝐀𝐈𝐑' });
      return;
    }

    case 'left': {
      if (!isGroup(chatId)) return sendText(session, chatId, '❌ This command only works inside a group.');
      const action = String(args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(action)) {
        return genericStatus(session, chatId, name, ['⚠️ Usage : .left on', '⚠️ Usage : .left off'], { title: '👋 𝐋𝐄𝐅𝐓 𝐀𝐋𝐄𝐑𝐓' });
      }
      await setGroup(chatId, { left: action === 'on' });
      await genericStatus(session, chatId, name, [
        `✅ Status : ${action === 'on' ? '𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃' : '𝐃𝐄𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃'}`,
        `👋 Goodbye alerts : ${action.toUpperCase()}`,
        `👤 Requested by : ${senderMention}`
      ], { imageKey: `.left ${action}`, title: '👋 𝐋𝐄𝐅𝐓 𝐀𝐋𝐄𝐑𝐓' });
      return;
    }

    case 'leave': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      await genericStatus(session, chatId, name, ['👋 Status : 𝐋𝐄𝐀𝐕𝐈𝐍𝐆 𝐆𝐑𝐎𝐔𝐏'], { title: '👋 𝐋𝐄𝐀𝐕𝐄' });
      await leaveGroup(session, chatId);
      return;
    }


    case 'welcome': {
      if (!isGroup(chatId)) return sendText(session, chatId, '❌ This command only works inside a group.');
      const action = String(args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(action)) {
        return genericStatus(session, chatId, name, ['⚠️ Usage : .welcome on', '⚠️ Usage : .welcome off'], { title: '🌸 𝐖𝐄𝐋𝐂𝐎𝐌𝐄' });
      }
      await setGroup(chatId, { welcome: action === 'on' });
      await genericStatus(session, chatId, name, [
        `✅ Status : ${action === 'on' ? '𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃' : '𝐃𝐄𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃'}`,
        `🌸 Welcome messages : ${action.toUpperCase()}`,
        `👤 Requested by : ${senderMention}`
      ], { imageKey: `.welcome ${action}`, title: '🌸 𝐖𝐄𝐋𝐂𝐎𝐌𝐄' });
      return;
    }

    case 'autod': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      const target = targetFromPayload(payload, args);
      if (!target) return sendText(session, chatId, `❌ Mention the user (or reply to their message): .autod @user`);
      // Store EVERY identifier WhatsApp has for this person (phone JID and,
      // if the engine reports one, @lid) — a future message from them may
      // arrive tagged with either form, and matching only one was why
      // messages kept getting through.
      let allIds = [target];
      try {
        const entries = (await resolveParticipants(session, chatId, { deep: true })).map(parseParticipant);
        const entry = findEntry(entries, [target]);
        if (entry?.ids?.length) allIds = entry.ids;
      } catch {}
      const config = getGroup(chatId);
      const users = new Set(Array.isArray(config.autoDeleteUsers) ? config.autoDeleteUsers : []);
      allIds.forEach((id) => users.add(id));
      await setGroup(chatId, { autoDeleteUsers: [...users] });
      await genericStatus(session, chatId, name, [
        '🗑️ Status : 𝐀𝐔𝐓𝐎 𝐃𝐄𝐋𝐄𝐓𝐄 𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃',
        `👤 Target : @${jidNumber(target)}`,
        '⚡ New messages from this user will be deleted, with a warning tag, as soon as they are detected.'
      ], { title: '🗑️ 𝐀𝐔𝐓𝐎 𝐃𝐄𝐋𝐄𝐓𝐄' });
      return;
    }

    case 'announcement': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      if (!joined) return sendText(session, chatId, `❌ Usage : .announcement <text>`);
      const participants = gate.participants.map(participantJid).filter(Boolean);
      await sendText(session, chatId, `📢 ${joined}`, { mentions: participants });
      await genericStatus(session, chatId, name, [
        '📢 Status : 𝐀𝐍𝐍𝐎𝐔𝐍𝐂𝐄𝐌𝐄𝐍𝐓 𝐒𝐄𝐍𝐓',
        `📝 ${joined.slice(0, 220)}`,
        `👥 Tagged : ${participants.length} members`
      ], { title: '📢 𝐀𝐍𝐍𝐎𝐔𝐍𝐂𝐄𝐌𝐄𝐍𝐓' });
      return;
    }

    case 'close':
    case 'open': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      const closed = name === 'close';
      await setGroupMessagesAdminOnly(session, chatId, closed);
      await genericStatus(session, chatId, name, [
        `🔒 Status : ${closed ? '𝐆𝐑𝐎𝐔𝐏 𝐂𝐋𝐎𝐒𝐄𝐃' : '𝐆𝐑𝐎𝐔𝐏 𝐎𝐏𝐄𝐍𝐄𝐃'}`,
        closed ? '👑 Only admins can send messages.' : '👥 Members can send messages again.',
        `👤 Requested by : ${senderMention}`
      ], { title: closed ? '🔒 𝐆𝐑𝐎𝐔𝐏 𝐂𝐋𝐎𝐒𝐄' : '🔓 𝐆𝐑𝐎𝐔𝐏 𝐎𝐏𝐄𝐍' });
      return;
    }

    case 'whoami': {
      // Diagnostic command — doesn't gate on admin status, since the whole
      // point is to see why that check does or doesn't pass.
      const me = normalizeJid((await getMe(session))?.id || '');
      const sender = normalizeJid(from);
      const sameAccount = Boolean(sender && me && sender === me);
      const lines = [
        `🆔 You : ${sender || 'unresolved'}`,
        `🤖 Bot : ${me || 'unresolved'}`,
        `🔗 Same account : ${sameAccount ? 'YES' : 'NO'}`
      ];
      if (isGroup(chatId)) {
        try {
          const status = await getGroupAdminStatus(session, chatId, from, payload);
          const describe = (e) => {
            if (!e) return 'NOT FOUND in participant list';
            return `${e.ids.join(' / ') || '(no id)'} — role=${e.role}`;
          };
          lines.push(
            `👥 Participants loaded : ${status.entries.length}`,
            `👤 Your record : ${describe(status.senderEntry)}`,
            `🤖 Bot record : ${describe(status.botEntry)}`,
            `👑 You are admin : ${status.senderIsAdmin ? 'YES' : 'NO'}`,
            `🛡️ Bot is admin : ${status.botIsAdmin ? 'YES' : 'NO'}`
          );
          const sample = status.entries.slice(0, 8).map((e) => `• ${e.ids.join(' / ') || '?'} — ${e.role}`);
          if (sample.length) lines.push('📋 First 8 entries :', ...sample);
          const unreadable = status.entries.find((e) => !e.ids.length);
          if (unreadable) {
            lines.push(`🧩 Unrecognized fields : ${Object.keys(unreadable.raw).join(', ').slice(0, 200) || '(empty object)'}`);
          }
        } catch (error) {
          lines.push(`⚠️ Could not load participants : ${String(error?.response?.data?.message || error?.message || error).slice(0, 150)}`);
        }
      } else {
        lines.push('ℹ️ Not a group chat — admin checks only apply in groups.');
      }
      await genericStatus(session, chatId, name, lines, { title: '🕵️ 𝐖𝐇𝐎𝐀𝐌𝐈' });
      return;
    }

    case 'listadmin': {
      if (!isGroup(chatId)) return sendText(session, chatId, '❌ This command only works inside a group.');
      const status = await getGroupAdminStatus(session, chatId, from, payload);
      const group = await groupDetails(session, chatId, {});
      const label = (e) => {
        // Show the real phone number when known; a bare @lid isn't a phone
        // number, so say so instead of printing a random-looking one.
        const who = e.phoneJid ? `@${jidNumber(e.phoneJid)}` : `🔒 hidden number (${jidNumber(e.lidJid || e.jid) || 'unknown id'})`;
        const tags = [];
        if (e.isSuperAdmin) tags.push('creator');
        if (status.senderEntry && e.ids.some((id) => status.senderEntry.ids.includes(id))) tags.push('you');
        if (status.botEntry && e.ids.some((id) => status.botEntry.ids.includes(id))) tags.push('bot');
        return `${who}${tags.length ? ` (${tags.join(', ')})` : ''}`;
      };
      const lines = [
        `👥 Group : ${groupSubject(group, chatId)}`,
        `📊 Members : ${status.entries.length}`,
        `👑 Admins : ${status.admins.length}`,
        ''
      ];
      if (status.admins.length) status.admins.forEach((e, i) => lines.push(`${i + 1}. ${label(e)}`));
      else lines.push('⚠️ No admins detected in the participant list.');
      lines.push(
        '',
        `👤 You are admin : ${status.senderIsAdmin ? 'YES ✅' : 'NO ❌'}`,
        `🤖 Bot is admin : ${status.botIsAdmin ? 'YES ✅' : 'NO ❌'}`
      );
      const unreadable = status.entries.find((e) => !e.ids.length);
      if (unreadable) {
        lines.push('', `🧩 Some entries have unrecognized fields : ${Object.keys(unreadable.raw).join(', ').slice(0, 200) || '(empty object)'}`);
      }
      await genericStatus(session, chatId, name, lines, { title: '👑 𝐀𝐃𝐌𝐈𝐍 𝐋𝐈𝐒𝐓' });
      return;
    }

    case 'vv': {
      return revealViewOnce(session, chatId, payload);
    }

    case 'group-id': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      const group = await groupDetails(session, chatId, {});
      await genericStatus(session, chatId, name, [
        `👥 Group : ${groupSubject(group, chatId)}`,
        `🆔 ID : ${chatId}`,
        `📊 Members : ${gate.participants.length}`
      ], { title: '🆔 𝐆𝐑𝐎𝐔𝐏 𝐈𝐃' });
      return;
    }

    default:
      await genericStatus(session, chatId, name, [`❓ Unknown command : .${name}`, 'Use .menu to view available commands.'], { title: '❓ 𝐔𝐍𝐊𝐍𝐎𝐖𝐍 𝐂𝐎𝐌𝐌𝐀𝐍𝐃', imageKey: '.menu' });
  }
}

async function moderateIncoming(session, chatId, payload, senderJid, body) {
  if (!isGroup(chatId)) return;
  const config = getGroup(chatId);

  if (config.antilink && /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/|whatsapp\.com\/)/i.test(String(body || ''))) {
    const id = payload?.id || payload?.messageId;
    if (id) await deleteWithWarning(session, chatId, id, senderJid, '🔗 Links are not allowed in this group.');
    return;
  }

  if (config.antichannel) {
    const directChannel = String(payload?.from || '').endsWith('@newsletter') || String(payload?._data?.Info?.Chat || '').endsWith('@newsletter');
    const quotedChannel = JSON.stringify(payload?._data || {}).includes('@newsletter');
    if (directChannel || quotedChannel) {
      const id = payload?.id || payload?.messageId;
      if (id) await deleteWithWarning(session, chatId, id, senderJid, '📡 Channel forwards are not allowed in this group.');
    }
  }

  if (config.antibot && ANTIBOT_JIDS.has(senderJid)) {
    const id = payload?.id || payload?.messageId;
    if (id) await deleteWithWarning(session, chatId, id, senderJid, '🤖 Bot accounts are not allowed in this group.');
    if (ANTIBOT_KICK) {
      try { await removeParticipants(session, chatId, [senderJid]); } catch {}
    }
  }

  if (config.killSale && SALE_KEYWORD_REGEX.test(String(body || ''))) {
    // Admin posts are exempt — only members' sale/price/availability chatter gets nuked.
    const senderIsAdmin = await isSenderGroupAdmin(session, chatId, senderJid, payload);
    if (!senderIsAdmin) {
      const id = payload?.id || payload?.messageId;
      if (id) await deleteWithWarning(session, chatId, id, senderJid, '🚫 Sale/price/availability posts are not allowed here.');
    }
  }
}
