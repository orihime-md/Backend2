import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import ffmpegPath from 'ffmpeg-static';
import {
  sendText,
  sendImage,
  sendVideo,
  sendVoice,
  sendFile,
  sendSticker,
  sendButtons,
  sendPoll,
  editMessage,
  getMessage,
  deleteMessage,
  downloadMedia,
  getParticipants,
  getParticipantsV2,
  getGroups,
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
  buildMainButtonsPayload,
  buildMoreButtonsPayload,
  buildCategoryButtonsPayload,
  buildToggleButtonsPayload,
  buildMainPollOptions,
  buildCategoryPollOptions,
  buildTogglePollOptions,
  extractSelectedRowId,
  parseSelection,
  commandFromButtonText,
  usageFor
} from './menu.js';
import {
  getSession as getStored,
  upsertSession,
  getGroup,
  setGroup,
  appendCommandLog,
  commandHistory,
  clearHistory
} from './store.js';
import { readCommandMedia } from './commandMedia.js';
import { createPairingSession } from './pairing.js';
import { withMediaSlot } from './mediaGuard.js';
import { sendWebPreviewCard, webPreviewEnabled } from './webPreview.js';
import { extractYoutubeVideoId, rapidApiConfigured, rapidYoutubeDownload, rapidYoutubeSearch } from './rapidapi.js';
import { askGemini, geminiConfigured, GEMINI_MODEL } from './gemini.js';
import {
  EXTRA_JOKES,
  startCandyGame,
  handleCandyText,
  handleCandyPoll,
  handleCandyPollVote,
  stopCandyGame,
  startDance,
  stopDanceForChat,
  isDanceGeneratedMessage,
  listAnimations,
  getAnimation,
  addGeneratedAnimation,
  scheduleGroupAction,
  cancelScheduledGroupAction,
  restoreScheduledGroupActions,
  cloneGroup,
  setUserLanguage,
  getUserLanguage,
  getLanguageMap,
  addLanguage,
  languageList,
  mapEnglishAlphabet,
  detectBotLikeMessage,
  registerMenuPoll,
  handleMenuPollVote
} from './advancedFeatures.js';
import {
  normalizeJid,
  jidNumber,
  jidFromValue,
  parseParticipant,
  extractParticipantList,
  findEntry,
  mergeEntries
} from './participants.js';

const INTRO = 'Santen Kesshun!” — 三天結盾';
const DEFAULT_PREFIX = '.';
const DELAY = Number(process.env.TEMP_MESSAGE_DELAY_MS || 900);
const OWNER_OVERRIDE = (process.env.BOT_OWNER_PHONE || '').replace(/\D/g, '');
const ANTIBOT_JIDS = new Set((process.env.ANTIBOT_JIDS || '').split(',').map((x) => normalizeJid(x) || x.trim()).filter(Boolean));
const ANTIBOT_SCORE_THRESHOLD = Math.max(5, Number(process.env.ANTIBOT_SCORE_THRESHOLD || 10));
const ANTIBOT_MODERATE_ADMINS = String(process.env.ANTIBOT_MODERATE_ADMINS || 'false').toLowerCase() === 'true';
const ANTIBOT_WARN = String(process.env.ANTIBOT_WARN || 'false').toLowerCase() === 'true';
const ANTIBOT_KICK = String(process.env.ANTIBOT_KICK || 'false').toLowerCase() === 'true';
const NO_INTRO_COMMANDS = new Set(['silent-m', 'silentf', 'prefix-d']);
const GAME_SESSIONS = new Map();

// Default .kill-sale words. Groups can replace/add/remove these with
// `.kill-sale set ...`, `.kill-sale add ...`, and `.kill-sale remove ...`.
const SALE_KEYWORDS = [
  'available', 'availability', 'sale', 'sales', 'selling', 'sell', 'sold',
  'price', 'prices', 'pricing', 'discount', 'discounted', 'promo', 'promotion',
  'offer', 'offers', 'deal', 'deals', 'cheap', 'wholesale', 'retail',
  'instock', 'in-stock', 'restock', 'restocked', 'order now', 'buy now',
  'for sale', 'dm to order', 'dm to buy', 'pm to order'
];

function buildKeywordRegex(keywords) {
  const list = [...new Set((Array.isArray(keywords) ? keywords : []).map((x) => String(x || '').trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  return new RegExp(
    `(?<!\\w)(${list.map((w) => w.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&').replace(/\\s+/g, '\\s+')).join('|')})(?!\\w)`,
    'i'
  );
}

function currentSaleKeywords(config) {
  const custom = Array.isArray(config?.killSaleKeywords) ? config.killSaleKeywords.filter(Boolean) : [];
  return custom.length ? custom : SALE_KEYWORDS;
}

function parseKeywordList(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  // Commas/semicolons are the preferred separator because they allow phrases
  // such as `for sale`, `dm me`, etc. Spaces are accepted when no separator is used.
  const values = /[,;|]/.test(raw) ? raw.split(/[,;|]/) : raw.split(/\s+/);
  return [...new Set(values.map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 80);
}

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

┏─ ⟢ 🤖 𝐀𝐈 ⟣ ─┓
┃ ❯ "${prefix}ai <question>"
┃ ❯ "${prefix}summarize"
┃ ❯ "${prefix}translate <lang>"
┃ ❯ "${prefix}prefix-d list"
┃ ❯ "${prefix}prefix-d <animation>"
┗───────────────────┛

┏─ ⟢ 🎬 𝐌𝐄𝐃𝐈𝐀 ⟣ ─┓
┃ ❯ "${prefix}sticker"
┃ ❯ "${prefix}toimg"
┃ ❯ "${prefix}play <song>"
┃ ❯ "${prefix}vv"
┃ ❯ "${prefix}silentF"
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
┃ ❯ "${prefix}autod @user on/off"
┃ ❯ "${prefix}announcement"
┃ ❯ "${prefix}close 30m / 22:00"
┃ ❯ "${prefix}open 10m / 07:00"
┃ ❯ "${prefix}split-gc"
┃ ❯ "${prefix}group-id"
┃ ❯ "${prefix}listadmin"
┃ ❯ "${prefix}vv"
┃ ❯ "${prefix}promote @user"
┃ ❯ "${prefix}demote @user"
┃ ❯ "${prefix}warn @user"
┃ ❯ "${prefix}remindme <mins> <text>"
┗───────────────────┛

┏─ ⟢ 🛠️ 𝐁𝐎𝐓 ⟣ ─┓
┃ ❯ "${prefix}ping"
┃ ❯ "${prefix}whoami"
┃ ❯ "${prefix}setprefix"
┃ ❯ "${prefix}public"
┃ ❯ "${prefix}private"
┃ ❯ "${prefix}silent-m <text>"
┃ ❯ "${prefix}lang-china on/off"
┃ ❯ "${prefix}lang-japanese on/off"
┃ ❯ "${prefix}lang-korea on/off"
┃ ❯ "${prefix}lang-add name|26-chars"
┃ ❯ "${prefix}lang-use <key> on/off"
┗───────────────────┛

┏─ ⟢ ⚙️ 𝐀𝐃𝐌𝐈𝐍 ⟣ ─┓
┃ ❯ "${prefix}antibot"
┃ ❯ "${prefix}antichannel"
┃ ❯ "${prefix}antilink"
┃ ❯ "${prefix}kill-sale on/off/set/add/remove/list/reset"
┃ ❯ "${prefix}antidemote on/off"
┃ ❯ "${prefix}antipromote on/off"
┃ ❯ "${prefix}antispam on/off"
┃ ❯ "${prefix}antidelete on/off"
┃ ❯ "${prefix}badword on/off/set/add/remove/list"
┃ ❯ "${prefix}warnlimit <n>"
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
  'Why did the emoji cross the chat? To get to the other side of the conversation. 😄',
  ...EXTRA_JOKES
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
  const messageId = sent?.id || sent?.messageId || sent?.data?.id;
  if (messageId) {
    setTimeout(() => {
      deleteMessage(session, chatId, messageId).catch(() => {});
    }, Math.max(50, DELAY));
  }
  return sent;
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

// Sends the exact uploaded repository image mapped to a command.
// There is no channel lookup, remote media fetch, or media synchronization here.
async function sendCommandImage(session, chatId, key, caption) {
  const media = await readCommandMedia(key);
  if (!media) return null;
  return sendImage(session, chatId, {
    mimetype: media.mime,
    filename: media.filename,
    data: media.data.toString('base64')
  }, caption);
}

async function sendCommandReply(session, chatId, key, caption) {
  // The web-preview card uses one tiny branded image instead of loading a
  // potentially multi-megabyte command asset into the custom-preview payload.
  // That keeps responses cheap on memory-constrained Render instances.
  if (webPreviewEnabled()) {
    try {
      const sent = await sendWebPreviewCard(session, chatId, {
        command: key || 'response',
        title: `🌸 ${String(key || 'ORIHIME MD').replace(/^\./, '').toUpperCase()}`,
        description: caption,
        body: caption
      });
      if (sent) return sent;
    } catch (error) {
      console.error(`[web-preview] ${key} failed:`, error?.response?.data || error?.message || error);
    }
  }

  let media = null;
  try { media = await readCommandMedia(key); } catch (error) {
    console.error(`[media] ${key} image read failed:`, error?.message || error);
  }
  if (media) {
    try {
      return await withMediaSlot(() => sendCommandImage(session, chatId, key, caption));
    } catch (error) {
      console.error(`[media] ${key} image send failed:`, error?.response?.data || error?.message || error);
    }
  }
  return sendText(session, chatId, caption);
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
  // WAHA includes the quoted message's media object directly on replyTo when
  // the engine has already downloaded it. Prefer that over GET /messages/:id:
  // for view-once messages, the historical lookup can legitimately return 500
  // after WhatsApp has consumed the one-time payload.
  const inlineReply = payload?.replyTo || payload?._data?.replyTo || null;
  if (inlineReply?.hasMedia && inlineReply?.media?.url) {
    return { message: inlineReply, source: 'replyTo' };
  }

  const selfIds = await getSelfIds(session);
  const candidates = quotedMessageIdCandidates(payload, chatId, selfIds);
  if (!candidates.length) return { error: 'no-reply' };
  let lastError = '';
  for (const id of candidates) {
    try {
      const message = await getMessage(session, chatId, id);
      if (message?.hasMedia && message?.media?.url) return { message, source: 'api' };
      if (message) lastError = message?.media?.error || (message.hasMedia ? 'media-not-downloaded' : 'no-media');
    } catch (error) {
      lastError = error?.response?.status ? `HTTP ${error.response.status}` : (error?.message || 'lookup-failed');
    }
  }
  return { error: lastError || 'not-found' };
}

function directRecipientFromPayload(chatId, payload) {
  if (!isGroup(chatId)) {
    const direct = normalizeJid(payload?.from || payload?.chatId || payload?.sender || payload?.author || payload?._data?.Info?.Sender || '');
    if (direct && !direct.endsWith('@g.us') && !direct.endsWith('@newsletter') && !direct.endsWith('@lid')) return direct;
  }
  const candidates = senderIdsFromPayload(payload, '')
    .map(normalizeJid)
    .filter((x) => x && !x.endsWith('@lid') && !x.endsWith('@g.us') && !x.endsWith('@newsletter'));
  return candidates[0] || '';
}

async function revealViewOnce(session, chatId, payload, { silent = false } = {}) {
  const destination = silent ? directRecipientFromPayload(chatId, payload) : chatId;
  const fail = (message) => silent
    ? (destination ? sendText(session, destination, message).catch(() => {}) : Promise.resolve())
    : sendText(session, chatId, message);

  if (silent && !destination) return;
  const selfIds = await getSelfIds(session);
  const candidates = quotedMessageIdCandidates(payload, chatId, selfIds);
  if (!candidates.length) return fail('❌ Reply to a view-once message with .silentF');

  const cached = findCachedViewOnce(session, chatId, candidates);

  let mimetype, filename, buffer, wasViewOnce;
  if (cached) {
    ({ mimetype, filename, buffer } = cached);
    wasViewOnce = true;
  } else {
    const { message, error } = await fetchQuotedMedia(session, chatId, payload);
    if (!message) {
      const hint = error === 'no-media'
        ? 'That message has no image, video, audio or document.'
        : `Could not read that message (${error}). WhatsApp/WAHA may already have consumed the view-once payload, or the current engine may not have exposed its media.`;
      return fail(`❌ ${hint}`);
    }
    wasViewOnce = Boolean(message.isViewOnce) || /viewonce/i.test(JSON.stringify(message._data || {}));
    const media = await withMediaSlot(() => downloadMedia(message.media.url));
    if (!media?.buffer?.length) return fail('❌ Could not download the view-once content.');
    mimetype = String(message.media.mimetype || media.contentType || 'application/octet-stream').split(';')[0];
    filename = message.media.filename || null;
    buffer = media.buffer;
  }

  try {
    const ext = mimetype.split('/')[1]?.split('+')[0] || 'bin';
    const file = { mimetype, filename: filename || `viewonce.${ext}`, data: buffer.toString('base64') };
    const caption = silent ? '👁️ View-once revealed privately.' : (wasViewOnce ? '👁️ View-once revealed!' : '👁️ Media revealed!');
    if (mimetype.startsWith('image/')) return await sendImage(session, destination, file, caption);
    if (mimetype.startsWith('video/')) return await sendVideo(session, destination, file, caption);
    if (mimetype.startsWith('audio/')) {
      return /ogg|opus/i.test(mimetype) ? await sendVoice(session, destination, file) : await sendFile(session, destination, file, caption);
    }
    return await sendFile(session, destination, file, caption);
  } catch (error) {
    console.error('[bot] view-once send failed:', error?.response?.data || error?.message || error);
    return fail('❌ The view-once was found but could not be sent.');
  } finally {
    buffer = null;
  }
}

// Participant lookups (used by every admin-gated command) otherwise hit WAHA
// fresh every single time — often 2-4 sequential API calls per command when
// the first pass doesn't clearly report admin roles. Cache briefly per group
// so back-to-back commands in the same group don't re-pay that cost, and
// invalidate immediately when a group.v2.participants webhook (join/leave/
// promote/demote) tells us the membership actually changed.
const PARTICIPANTS_CACHE = new Map(); // `${session}:${groupId}` -> { list, deep, at }
const PARTICIPANTS_CACHE_TTL = 20000;
function invalidateParticipantsCache(session, groupId) {
  PARTICIPANTS_CACHE.delete(`${session}:${groupId}`);
}

// Reads the participant list. If the /participants endpoint returns nothing
// usable (empty, or no entry with a readable id), falls back to the group's
// own info object, which carries the same list on every WAHA engine.
async function resolveParticipants(session, groupId, { deep = false } = {}) {
  const cacheKey = `${session}:${groupId}`;
  const cached = PARTICIPANTS_CACHE.get(cacheKey);
  if (cached && (!deep || cached.deep) && Date.now() - cached.at < PARTICIPANTS_CACHE_TTL) {
    return cached.list;
  }

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
      const v2 = extractParticipantList(await getParticipantsV2(session, groupId));
      if (v2.length) list = usable ? mergeEntries(list.map(parseParticipant), v2.map(parseParticipant)).map((e) => e.raw) : v2;
    } catch {}
    try {
      const info = extractParticipantList(await getGroupInfo(session, groupId));
      if (!usable) list = info.length ? info : list;
      else list = mergeEntries(list.map(parseParticipant), info.map(parseParticipant)).map((e) => e.raw);
    } catch (error) {
      if (!list.length && primaryError) throw primaryError;
    }
  }
  if (!list.length && primaryError) throw primaryError;
  PARTICIPANTS_CACHE.set(cacheKey, { list, deep, at: Date.now() });
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
// This never changes for a running session, so cache it instead of hitting
// getMe() on every single admin check.
const SELF_IDS_CACHE = new Map(); // session -> { ids, at }
const SELF_IDS_CACHE_TTL = 5 * 60 * 1000;
async function getSelfIds(session) {
  const cached = SELF_IDS_CACHE.get(session);
  if (cached && Date.now() - cached.at < SELF_IDS_CACHE_TTL) return cached.ids;
  const ids = [];
  try {
    for (const id of parseParticipant(await getMe(session)).ids) if (!ids.includes(id)) ids.push(id);
  } catch {}
  const owner = await getBotOwner(session);
  if (owner && !ids.includes(owner)) ids.push(owner);
  SELF_IDS_CACHE.set(session, { ids, at: Date.now() });
  return ids;
}

// ONE source of truth for "who is admin here" — used by .listadmin, .whoami
// and every admin-gated command, so they can never disagree with each other.
const GROUP_ADMIN_STATUS_CACHE = new Map();
const GROUP_ADMIN_STATUS_TTL = Number(process.env.GROUP_ADMIN_CACHE_TTL_MS || 15000);

function adminCacheKey(session, chatId, senderJid) {
  return `${session}:${chatId}:${normalizeJid(senderJid) || senderJid || ''}`;
}

async function getGroupAdminStatus(session, chatId, senderJid, payload, { live = false } = {}) {
  if (!isGroup(chatId)) {
    return {
      entries: [], admins: [], selfIds: [], senderIds: [], isSelf: false,
      senderEntry: null, botEntry: null, senderIsAdmin: false, botIsAdmin: false,
      ownerJid: getStored(session)?.ownerJid || await getBotOwner(session), ownerAdminRecord: null
    };
  }

  const stored = getStored(session);
  const ownerJid = stored?.ownerJid || await getBotOwner(session);
  const senderIds = senderIdsFromPayload(payload, normalizeJid(senderJid));
  const selfIds = await getSelfIds(session);
  const ownerIds = new Set([ownerJid, ...selfIds].filter(Boolean));
  const isSelf = Boolean(payload?.fromMe) || senderIds.some((id) => ownerIds.has(id));

  // Admin data is NEVER pre-scanned or persisted. A live lookup happens only
  // when a command/feature actually needs an admin decision, and the result is
  // held in a short in-memory cache to avoid hammering WAHA on rapid messages.
  const key = adminCacheKey(session, chatId, senderJid);
  const cached = GROUP_ADMIN_STATUS_CACHE.get(key);
  if (cached && Date.now() - cached.at < GROUP_ADMIN_STATUS_TTL) return cached.value;

  let entries = [];
  let senderEntry = null;
  let botEntry = null;
  try {
    entries = (await resolveParticipants(session, chatId, { deep: false })).map(parseParticipant);
    senderEntry = findEntry(entries, isSelf ? [...new Set([...senderIds, ...selfIds])] : senderIds, { isSelf });
    botEntry = findEntry(entries, selfIds, { isSelf: true });
    if (!senderEntry?.isAdmin || !botEntry?.isAdmin) {
      try {
        const deep = (await resolveParticipants(session, chatId, { deep: true })).map(parseParticipant);
        entries = mergeEntries(entries, deep);
        senderEntry = findEntry(entries, isSelf ? [...new Set([...senderIds, ...selfIds])] : senderIds, { isSelf });
        botEntry = findEntry(entries, selfIds, { isSelf: true });
      } catch {}
    }
    if (isSelf) {
      senderEntry = senderEntry || botEntry;
      botEntry = botEntry || senderEntry;
    }
  } catch (error) {
    console.error('[group-admin] participant lookup failed:', error?.response?.data || error?.message || error);
  }

  const value = {
    entries,
    admins: entries.filter((e) => e.isAdmin),
    selfIds,
    senderIds: isSelf ? [...new Set([...senderIds, ...selfIds])] : senderIds,
    isSelf,
    senderEntry,
    botEntry,
    senderIsAdmin: Boolean(senderEntry?.isAdmin),
    botIsAdmin: Boolean(botEntry?.isAdmin),
    ownerJid,
    ownerAdminRecord: null
  };
  GROUP_ADMIN_STATUS_CACHE.set(key, { at: Date.now(), value });
  return value;
}

async function assertGroupAdmin(session, chatId, senderJid, payload) {
  if (!isGroup(chatId)) return { ok: false, message: 'This command only works inside a group.' };
  const status = await getGroupAdminStatus(session, chatId, senderJid, payload, { live: true });
  if (!status.isSelf) {
    return {
      ok: false,
      repel: true,
      message: '⛔ Only the linked owner number can use admin features.'
    };
  }
  if (!status.senderIsAdmin) {
    return { ok: false, message: '❌ The linked owner number is not a group admin here.' };
  }
  return {
    ok: true,
    ownerJid: status.ownerJid,
    ownerAdminRecord: null,
    participants: null,
    ...status
  };
}

async function isSenderGroupAdmin(session, chatId, senderJid, payload) {
  try {
    return (await getGroupAdminStatus(session, chatId, senderJid, payload, { live: true })).senderIsAdmin;
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
    else if (/^\+?[1-9]\d{6,14}$/.test(a)) push(normalizeJid(a));
  }
  if (!out.length) {
    const replyTo = payload?.replyTo || payload?._data?.replyTo || {};
    const ctx = findReplyContext(payload?._data) || {};
    push(jidFromValue(replyTo.participant || pickCtx(ctx, 'participant')));
  }
  return out;
}


async function resolveCommandTargets(session, groupId, payload, args = [], { resolveAliases = false } = {}) {
  const rawTargets = targetsFromPayload(payload, args);
  if (!rawTargets.length) return [];
  // Normal mention/reply targets are already valid WhatsApp JIDs. Avoid the
  // expensive full-participant lookup on the hot command path. Only callers
  // that explicitly need phone/LID alias expansion opt into it.
  if (!resolveAliases) return [...new Set(rawTargets)];

  let participants = [];
  try {
    participants = (await resolveParticipants(session, groupId, { deep: true })).map(parseParticipant);
  } catch (error) {
    console.error('[bot] participant target resolution failed:', error?.message || error);
  }

  const resolved = [];
  for (const raw of rawTargets) {
    const match = participants.find((entry) => entry.ids.includes(raw) || entry.phoneJid === raw || entry.lidJid === raw);
    const canonical = match?.phoneJid || match?.jid || raw;
    if (canonical && !resolved.includes(canonical)) resolved.push(canonical);
  }
  return resolved;
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
  return sendCommandReply(session, chatId, key, caption);
}

// Deletes a message and, per policy, always tags the sender with a short
// warning so removal is never silent — used by every auto-moderation path
// (antilink/antibot/antichannel/kill-sale/autod).
async function sendAdminGateFailure(session, chatId, gate) {
  if (gate?.repel) {
    return genericStatus(session, chatId, 'repel', [
      '⛔ 𝐀𝐂𝐂𝐄𝐒𝐒 : 𝐃𝐄𝐍𝐈𝐄𝐃',
      '🛡️ Admin access : 𝐎𝐖𝐍𝐄𝐑 𝐎𝐍𝐋𝐘',
      String(gate.message || '❌ You are not allowed to use this admin command.')
    ], { imageKey: '.repel', title: '⛔ 𝐀𝐂𝐂𝐄𝐒𝐒 𝐃𝐄𝐍𝐈𝐄𝐃' });
  }
  return sendText(session, chatId, gate?.message || '❌ Admin permission required.');
}

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
  if (Array.isArray(payload?.participants)) return payload.participants;
  if (Array.isArray(payload?.group?.participants)) return payload.group.participants;
  return [];
}

function eventParticipantJids(payload) {
  return groupParticipantsFromPayload(payload)
    .map((participant) => {
      const parsed = parseParticipant(participant);
      return parsed.phoneJid || parsed.jid || parsed.lidJid || '';
    })
    .filter(Boolean);
}

async function sendWelcomeOrGoodbye(session, groupId, participantJids, type, groupFromEvent = {}) {
  if (!isGroup(groupId) || !participantJids.length) return;
  const config = getGroup(session, groupId);
  const enabled = type === 'join' ? config.welcome : config.left;
  if (!enabled) return;
  const group = await groupDetails(session, groupId, groupFromEvent);
  const name = groupSubject(group);
  const memberText = participantJids.map((jid) => `@${jidNumber(jid)}`).join(', ');
  const caption = type === 'join'
    ? statusCaption('🌸 𝐖𝐄𝐋𝐂𝐎𝐌𝐄', [
        `👋 Welcome : ${memberText}`,
        `👥 Group : ${name}`,
        '💗 We are happy to have you here!'
      ])
    : statusCaption('👋 𝐆𝐎𝐎𝐃𝐁𝐘𝐄', [
        `👋 Left : ${memberText}`,
        `👥 Group : ${name}`,
        `📊 Members : ${count ?? 'Unknown'}`
      ]);
  const key = type === 'join' ? '.welcome on' : '.left on';
  const sent = await sendCommandReply(session, groupId, key, caption);
  // Keep greeting delivery reliable across WAHA engines; the local image sender
  // accepts the caption consistently even when mention metadata differs.
  return sent;
}

// Loop guard: every promote/demote the bot performs on behalf of
// .antidemote/.antipromote generates its own group.v2.participants webhook
// event. Without this, the bot's own corrective action would immediately
// trigger the opposite rule and the two would fight forever. Each self
// action is remembered for a few seconds — long enough to absorb the
// resulting webhook — then forgotten.
const SELF_ACTIONS = new Map();
function markSelfAction(session, groupId, jid, type) {
  SELF_ACTIONS.set(`${session}:${groupId}:${jid}:${type}`, Date.now());
}
function consumeSelfAction(session, groupId, jid, type) {
  const key = `${session}:${groupId}:${jid}:${type}`;
  const at = SELF_ACTIONS.get(key);
  if (!at) return false;
  SELF_ACTIONS.delete(key);
  return Date.now() - at < 15000;
}

async function applyAdminAction(session, groupId, action, target) {
  const fn = action === 'promote' ? promoteParticipants : demoteParticipants;
  // Do not perform a second full participant-list lookup here. WhatsApp/WAHA
  // emits group.v2.participants with the changed role; the event handler keeps
  // the saved owner-admin snapshot current without re-enumerating the group.
  return fn(session, groupId, [target]);
}

async function handleParticipantsEvent(session, groupId, payload) {
  const type = String(payload?.type || payload?.action || '').toLowerCase();
  if (!['promote', 'demote'].includes(type)) return;
  const config = getGroup(session, groupId);
  const targets = eventParticipantJids(payload);
  if (!targets.length) return;
  const selfIds = await getSelfIds(session);

  // The webhook contains the changed participant IDs; match directly against
  // the linked account's cached phone/LID identifiers. Never enumerate the
  // whole group just to protect the bot's own account.
  const isBotLinkedUser = (target) => selfIds.includes(target);

  if (type === 'demote' && config.antidemote) {
    for (const target of targets) {
      if (isBotLinkedUser(target)) continue; // the bot's own linked account / owner is never auto-restored
      if (consumeSelfAction(session, groupId, target, 'demote')) continue; // this demote WAS the bot's own antipromote correction — don't fight it
      try {
        const canonicalTarget = (await resolveCommandTargets(session, groupId, { mentionedJid: [target] }, []))[0] || target;
        await applyAdminAction(session, groupId, 'promote', canonicalTarget);
        markSelfAction(session, groupId, target, 'promote');
        if (canonicalTarget !== target) markSelfAction(session, groupId, canonicalTarget, 'promote');
        await sendText(session, groupId, `🛡️ 𝐀𝐍𝐓𝐈𝐃𝐄𝐌𝐎𝐓𝐄\n👤 @${jidNumber(target)} was demoted by another admin and has been restored to admin instantly.`, { mentions: [target] });
      } catch (error) {
        console.error('[antidemote]', error?.response?.data || error?.message || error);
      }
    }
  }

  if (type === 'promote' && config.antipromote) {
    for (const target of targets) {
      if (isBotLinkedUser(target)) continue; // the bot's own linked account / owner is never auto-demoted
      if (consumeSelfAction(session, groupId, target, 'promote')) continue; // this promote WAS the bot's own antidemote correction — don't fight it
      try {
        const canonicalTarget = (await resolveCommandTargets(session, groupId, { mentionedJid: [target] }, []))[0] || target;
        await applyAdminAction(session, groupId, 'demote', canonicalTarget);
        markSelfAction(session, groupId, target, 'demote');
        if (canonicalTarget !== target) markSelfAction(session, groupId, canonicalTarget, 'demote');
        await sendText(session, groupId, `🛡️ 𝐀𝐍𝐓𝐈𝐏𝐑𝐎𝐌𝐎𝐓𝐄\n👤 @${jidNumber(target)} was promoted by an admin and has been demoted back instantly.`, { mentions: [target] });
      } catch (error) {
        console.error('[antipromote]', error?.response?.data || error?.message || error);
      }
    }
  }
}


function extractGroupsList(result) {
  if (Array.isArray(result)) return result;
  for (const key of ['groups', 'data', 'result']) {
    const value = result?.[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function groupIdFromValue(group) {
  const value = group?.id || group?.groupId || group?.chatId || group?._data?.id;
  return String(value || '');
}

function groupNameFromValue(group, fallback) {
  return String(group?.subject || group?.name || group?.title || fallback || '').trim();
}

async function handleGroupEventInternal(session, eventName, payload) {
  const groupId = payload?.group?.id || payload?.id;
  if (!isGroup(groupId)) return;
  if (eventName === 'group.v2.update') {
    invalidateParticipantsCache(session, groupId);
    return;
  }
  if (eventName === 'group.v2.participants') {
    invalidateParticipantsCache(session, groupId);
    const type = String(payload?.type || payload?.action || '').toLowerCase();
    try {
      await handleParticipantsEvent(session, groupId, payload);
      if (type === 'join' || type === 'leave') {
        const participants = eventParticipantJids(payload);
        if (participants.length) await sendWelcomeOrGoodbye(session, groupId, participants, type, payload?.group || {});
      }
    } catch (error) {
      console.error('[group participants]', error?.response?.data || error?.message || error);
    }
    return;
  }
  // group.v2.join/leave describe the linked account joining/leaving a group,
  // not another member joining/leaving. Member welcomes/farewells are driven
  // by group.v2.participants, whose payload contains the changed participants.
}

const CHAT_QUEUES = new Map();
function enqueueChatTask(session, chatId, task) {
  const key = `${session}:${chatId || 'unknown'}`;
  const previous = CHAT_QUEUES.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task).finally(() => {
    if (CHAT_QUEUES.get(key) === next) CHAT_QUEUES.delete(key);
  });
  CHAT_QUEUES.set(key, next);
  return next;
}

const GROUP_EVENT_DEDUPE = new Map();
function shouldProcessGroupEvent(session, eventName, payload) {
  const now = Date.now();
  for (const [key, at] of GROUP_EVENT_DEDUPE) if (now - at > 30000) GROUP_EVENT_DEDUPE.delete(key);
  const groupId = payload?.group?.id || payload?.id || '';
  const participants = groupParticipantsFromPayload(payload).map((p) => parseParticipant(p).ids.join('/')).sort().join(',');
  const stamp = payload?.timestamp || payload?._data?.timestamp || '';
  const type = String(payload?.type || payload?.action || '');
  const key = `${session}:${eventName}:${groupId}:${stamp}:${type}:${participants}`;
  if (GROUP_EVENT_DEDUPE.has(key)) return false;
  GROUP_EVENT_DEDUPE.set(key, now);
  return true;
}

export function handleGroupEvent(session, eventName, payload) {
  const groupId = payload?.group?.id || payload?.id || 'unknown';
  if (!shouldProcessGroupEvent(session, eventName, payload)) return Promise.resolve();
  // Its own queue lane ("grp:") — kept separate from message replies below so
  // a slow antipromote/antidemote correction (which has built-in retry
  // delays) can never make regular chat messages queue up behind it.
  return enqueueChatTask(session, `grp:${groupId}`, () => handleGroupEventInternal(session, eventName, payload));
}

// Recent-message cache used by .antidelete: WAHA's own message.revoked event
// only tells us WHICH message id was deleted, not what it said, so the
// content has to already be sitting in memory from when it first arrived.
// Bounded ring buffer — oldest entries drop once the cap is hit.
const MESSAGE_CACHE = new Map(); // `${session}:${chatId}:${id}` -> { body, senderJid, mediaUrl, mimetype, at }
const MESSAGE_CACHE_MAX = 800;
function cacheMessage(session, chatId, id, entry) {
  if (!id) return;
  const key = `${session}:${chatId}:${id}`;
  MESSAGE_CACHE.set(key, { ...entry, at: Date.now() });
  if (MESSAGE_CACHE.size > MESSAGE_CACHE_MAX) {
    const oldest = MESSAGE_CACHE.keys().next().value;
    if (oldest) MESSAGE_CACHE.delete(oldest);
  }
}

// View-once media cache, keyed the same way as MESSAGE_CACHE. This is the
// real fix for ".vv can't download/read the media": that error means the
// LIVE re-fetch inside revealViewOnce() came back empty, which happens
// whenever WhatsApp has already invalidated the view-once content by the
// time someone types .vv — most commonly because it was already opened on
// the linked phone (any linked device opening it consumes it everywhere).
// The only reliable window to grab it is the moment the message first
// arrives, before anyone (including the linked phone) has viewed it — so
// handleWebhookEventInternal below downloads it eagerly, in the background,
// and revealViewOnce() serves from here first and only falls back to a live
// fetch if nothing was cached. Buffers only, in memory, pruned by TTL/size —
// never written to disk or the store, same privacy rule as the rest of this
// feature (see the comment above revealViewOnce).
const VIEWONCE_CACHE = new Map(); // `${session}:${chatId}:${id}` -> { buffer, mimetype, filename, at }
const VIEWONCE_CACHE_MAX = Math.max(1, Number(process.env.VIEWONCE_CACHE_MAX || 8));
const VIEWONCE_CACHE_TTL_MS = Math.max(60_000, Number(process.env.VIEWONCE_CACHE_TTL_MS || 10 * 60 * 1000));
const VIEWONCE_CACHE_MAX_BYTES = Math.max(1 * 1024 * 1024, Number(process.env.VIEWONCE_CACHE_MAX_BYTES || 20 * 1024 * 1024));

function pruneViewOnceCache() {
  const cutoff = Date.now() - VIEWONCE_CACHE_TTL_MS;
  for (const [key, entry] of VIEWONCE_CACHE) {
    if (entry.at < cutoff) VIEWONCE_CACHE.delete(key);
  }
}

function cacheViewOnceEntry(session, chatId, id, entry) {
  if (!id) return;
  pruneViewOnceCache();
  VIEWONCE_CACHE.set(`${session}:${chatId}:${id}`, { ...entry, at: Date.now() });
  if (VIEWONCE_CACHE.size > VIEWONCE_CACHE_MAX) {
    const oldest = VIEWONCE_CACHE.keys().next().value;
    if (oldest) VIEWONCE_CACHE.delete(oldest);
  }
}

// Fire-and-forget: called from the webhook handler and must never delay or
// break normal message processing if it fails.
async function precacheViewOnceMedia(session, chatId, id, media) {
  if (!id || !media?.url) return;
  try {
    if (Number(media?.size || 0) > VIEWONCE_CACHE_MAX_BYTES) return;
    const downloaded = await withMediaSlot(() => downloadMedia(media.url));
    if (!downloaded?.buffer?.length || downloaded.buffer.length > VIEWONCE_CACHE_MAX_BYTES) return;
    cacheViewOnceEntry(session, chatId, id, {
      buffer: downloaded.buffer,
      mimetype: String(media.mimetype || downloaded.contentType || 'application/octet-stream').split(';')[0],
      filename: media.filename || null
    });
  } catch (error) {
    console.error('[bot] view-once pre-cache failed:', error?.response?.data || error?.message || error);
  }
}

function findCachedViewOnce(session, chatId, candidateIds) {
  for (const id of candidateIds) {
    const hit = VIEWONCE_CACHE.get(`${session}:${chatId}:${id}`);
    if (hit) return hit;
  }
  return null;
}

// Increments a member's warn count, announces it, and auto-kicks once
// config.warnLimit is reached (then resets their count). Shared by the
// manual `.warn` command and the automatic badword/antispam moderation.
async function warnUser(session, chatId, targetJid, reason) {
  const config = getGroup(session, chatId);
  const warns = { ...(config.warns || {}) };
  const count = (warns[targetJid] || 0) + 1;
  const limit = Number(config.warnLimit) > 0 ? Number(config.warnLimit) : 3;
  if (count >= limit) {
    delete warns[targetJid];
    await setGroup(session, chatId, { warns });
    try { await removeParticipants(session, chatId, [targetJid]); } catch {}
    await sendText(session, chatId, `🚫 @${jidNumber(targetJid)} reached ${limit} warns and was removed.\n📝 ${reason}`, { mentions: [targetJid] });
  } else {
    warns[targetJid] = count;
    await setGroup(session, chatId, { warns });
    await sendText(session, chatId, `⚠️ @${jidNumber(targetJid)} warned (${count}/${limit})\n📝 ${reason}`, { mentions: [targetJid] });
  }
}

const WEBHOOK_DEDUPE = new Map();
function webhookEventKey(session, payload) {
  const id = payload?.id || payload?.messageId || payload?._data?.Info?.ID || '';
  if (id) return `${session}:message:${id}`;
  const chat = payload?.from || payload?.chatId || payload?._data?.Info?.Chat || '';
  const stamp = payload?.timestamp || payload?._data?.Info?.Timestamp || '';
  return `${session}:${chat}:${stamp}:${String(payload?.body || payload?.type || '').slice(0, 100)}`;
}
function shouldProcessWebhook(session, payload) {
  const now = Date.now();
  for (const [key, at] of WEBHOOK_DEDUPE) if (now - at > 30000) WEBHOOK_DEDUPE.delete(key);
  const key = webhookEventKey(session, payload);
  if (WEBHOOK_DEDUPE.has(key)) return false;
  WEBHOOK_DEDUPE.set(key, now);
  return true;
}

// Public webhook entry point used by server.js. Keep webhook processing
// deduplicated so retries or duplicate "message"/"message.any" deliveries of
// the exact same message can't double-process. Serialization is scoped to
// (chat, sender) rather than the whole chat: it still stops one person's own
// rapid-fire/duplicate commands from racing each other, but in a group,
// different people's messages no longer queue up behind one another — one
// slow reply (e.g. .ai waiting on Gemini) no longer delays everyone else.
export async function handlePollVote(session, payload) {
  if (!session || !payload) return false;
  const menuHandled = await handleMenuPollVote(session, payload).catch((error) => {
    console.error('[bot] menu poll vote failed:', error?.response?.data || error?.message || error);
    return false;
  });
  if (menuHandled) return true;
  try { return await handleCandyPollVote(session, payload); }
  catch (error) {
    console.error('[bot] candy poll vote failed:', error?.response?.data || error?.message || error);
    return false;
  }
}

export function handleWebhookEvent(session, payload) {
  if (!session || !payload) return Promise.resolve();
  if (!shouldProcessWebhook(session, payload)) return Promise.resolve();
  const chatId = payload?.from || payload?.chatId || payload?._data?.Info?.Chat || 'unknown';
  const senderIds = senderIdsFromPayload(payload, chatId);
  const senderKey = senderIds[0] || 'unknown-sender';
  const queueKey = isGroup(chatId) ? `msg:${chatId}:${senderKey}` : `msg:${chatId}`;
  return enqueueChatTask(session, queueKey, () => handleWebhookEventInternal(session, payload));
}

// message.revoked only carries the id of a deleted message (and where it was
// deleted), not its content — so this looks up what was cached when that
// message first arrived (see cacheMessage above) and, if .antidelete is on
// for that chat, resends it so the group can still see what was removed.
// WAHA's exact revoke payload shape varies by engine/version, so every field
// below is read defensively with fallbacks rather than assumed.
export async function handleMessageRevoked(session, payload) {
  if (!session || !payload) return;
  const chatId = payload?.from || payload?.chatId || payload?._data?.Info?.Chat
    || payload?.key?.remoteJid || payload?._data?.key?.remoteJid;
  if (!chatId || !isGroup(chatId)) return;
  const config = getGroup(session, chatId);
  if (!config.antidelete) return;

  const deletedId = payload?.id || payload?.messageId
    || payload?.key?.id || payload?._data?.key?.id
    || payload?._data?.Info?.ID
    || payload?.protocolMessage?.key?.id || payload?._data?.protocolMessage?.key?.id;
  if (!deletedId) return;

  const cached = MESSAGE_CACHE.get(`${session}:${chatId}:${deletedId}`);
  if (!cached) return; // never seen it, or it aged out of the cache

  const who = cached.senderJid ? `@${jidNumber(cached.senderJid)}` : 'someone';
  const mentions = cached.senderJid ? [cached.senderJid] : [];
  try {
    if (cached.body) {
      await sendText(session, chatId, `🗑️ 𝐀𝐍𝐓𝐈-𝐃𝐄𝐋𝐄𝐓𝐄\n👤 ${who} deleted:\n\n${cached.body}`, { mentions });
    } else if (cached.hasMedia) {
      await sendText(session, chatId, `🗑️ 𝐀𝐍𝐓𝐈-𝐃𝐄𝐋𝐄𝐓𝐄\n👤 ${who} deleted a media message (content wasn't cached, only the fact it was deleted).`, { mentions });
    }
  } catch (error) {
    console.error('[bot] antidelete resend failed:', error?.response?.data || error?.message || error);
  }
}

async function handleWebhookEventInternal(session, payload) {
  if (!session || !payload) return;
  const chatId = payload.from || payload.chatId || payload._data?.Info?.Chat;

  // Ignore WhatsApp Channel/newsletter messages. They are not user command
  // input and should never enter the normal command-response pipeline.
  if (String(chatId || '').endsWith('@newsletter')) return;

  const body = payload.body || payload.text || payload.caption || '';
  const earlyStored = getStored(session);
  const earlyPrefix = earlyStored?.prefix || DEFAULT_PREFIX;
  const earlyParsed = parseCommand(body, earlyPrefix);
  const messageIdForActivity = payload?.id || payload?.messageId || payload?._data?.Info?.ID;
  // Dance edits/frames are sent by the bot itself. Ignore those generated
  // messages so the activeness listener doesn't cancel its own animation.
  if (isDanceGeneratedMessage(messageIdForActivity)) return;
  if (payload?.fromMe && /\u001b\[2J\u001b\[H/.test(String(body || ''))) return;
  // Any new real message in this chat stops an active dance immediately.
  stopDanceForChat(session, chatId);
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

  // Cache this message's content for .antidelete, before anything else can
  // return early. Cheap and bounded (MESSAGE_CACHE_MAX), so it's fine to do
  // unconditionally rather than only when antidelete happens to be on —
  // toggling it on later still finds a scrollback of recent messages.
  if (isGroup(chatId)) {
    const msgId = payload?.id || payload?.messageId || payload?._data?.Info?.ID;
    if (msgId) {
      cacheMessage(session, chatId, msgId, {
        body,
        senderJid: from,
        mediaUrl: payload?.media?.url || null,
        mimetype: payload?.media?.mimetype || null,
        hasMedia: Boolean(payload?.hasMedia)
      });
    }
  }

  // Eagerly grab view-once media the instant it arrives, for .vv — see the
  // comment above VIEWONCE_CACHE for why this can't wait until .vv is typed.
  // Not awaited: this must never delay normal message handling, and DMs get
  // this too (view-once isn't group-only, unlike the antidelete cache above).
  if (payload?.hasMedia && payload?.media?.url) {
    const isViewOnce = Boolean(payload.isViewOnce) || Boolean(payload?.media?.isViewOnce) || /view.?once/i.test(JSON.stringify(payload._data || {}));
    if (isViewOnce) {
      const msgId = payload?.id || payload?.messageId || payload?._data?.Info?.ID;
      if (msgId) precacheViewOnceMedia(session, chatId, msgId, payload.media);
    }

  // A .vv command itself contains a replyTo object. If WAHA already attached
  // the quoted media there, cache it immediately as a second chance before
  // the historical GET-by-id path.
  const quoted = payload?.replyTo || payload?._data?.replyTo;
  const quotedId = quoted?.id || quoted?._data?.Info?.ID;
  const quotedIsViewOnce = Boolean(quoted?.isViewOnce) || Boolean(quoted?.media?.isViewOnce) || /view.?once/i.test(JSON.stringify(quoted?._data || {}));
  if (quotedId && quoted?.hasMedia && quoted?.media?.url && quotedIsViewOnce) {
    precacheViewOnceMedia(session, chatId, quotedId, quoted.media);
  }
  }

  // Auto-moderation events work independently of commands. Never moderate
  // the linked account's own messages.
  if (chatId && !payload.fromMe) {
    const config = isGroup(chatId) ? getGroup(session, chatId) : null;
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
    const moderated = await moderateIncoming(session, chatId, payload, from, body, { fastOnly: Boolean(earlyParsed) });
    if (moderated) return;
  }

  const stored = earlyStored || getStored(session);
  const prefix = stored?.prefix || earlyPrefix || DEFAULT_PREFIX;

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

  const parsed = earlyParsed || parseCommand(body, prefix);
  if (!parsed) {
    // Per-user language mode is a deliberate one-to-one A-Z substitution,
    // not semantic translation. Commands are excluded so the selected prefix
    // and command words still work normally.
    if (!payload?.fromMe && body.trim()) {
      const languageKey = getUserLanguage(session, chatId, from);
      const chars = languageKey ? getLanguageMap(languageKey) : '';
      if (languageKey && chars) {
        const mapped = mapEnglishAlphabet(body, chars);
        const id = payload?.id || payload?.messageId || payload?._data?.Info?.ID;
        if (id) { try { await deleteMessage(session, chatId, id); } catch {} }
        await sendText(session, chatId, mapped);
      }
    }
    return;
  }

  // .vv is deliberately not logged: nothing about a revealed view-once message is stored.
  // Not awaited: logging is a side effect, not something the sender should
  // ever wait on — and with Redis backing it, it no longer needs to be.
  if (!['vv', 'silentf', 'silent-m'].includes(parsed.name)) {
    appendCommandLog({ session, chatId, sender: from, command: parsed.name, args: parsed.args, raw: body })
      .catch((error) => console.error('[bot] command log failed:', error?.message || error));
  }

  if (!NO_INTRO_COMMANDS.has(parsed.name)) await sendIntro(session, chatId);

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

// Once an interactive send fails, remember that for the rest of this
// process's life instead of retrying (and logging) on every single .menu
// call — WAHA's list/button endpoints are gated by engine (e.g. GOWS
// straight-up 501s on sendButtons) and by WAHA Plus tier (sendList), so a
// failure here almost never clears up mid-process.
const interactiveSendBroken = new Set();

// Sends the main menu using the uploaded `15-menu.png` image and animates
// the caption in place. WAHA supports editing media captions, so the image
// stays in the same WhatsApp bubble while the caption moves through several
// Orihime-styled frames before the complete menu caption settles.
async function sendAnimatedMenuImage(session, chatId, text) {
  const media = await readCommandMedia('.menu');
  if (!media) return sendText(session, chatId, text);

  const frames = [
    '⋆｡‧˚ʚ🌸ɞ˚‧｡⋆\n✨ awakening Orihime...',
    '⋆｡‧˚ʚ🌸ɞ˚‧｡⋆\n✨💗 warming the petals...',
    '⋆｡‧˚ʚ🌸ɞ˚‧｡⋆\n✨💗🌸 building your menu...',
    '⋆｡‧˚ʚ🌸ɞ˚‧｡⋆\n✨💗🌸⚡ syncing commands...',
    '⋆｡‧˚ʚ🌸ɞ˚‧｡⋆\n🌸✨ petals dancing...',
    '⋆｡‧˚ʚ🌸ɞ˚‧｡⋆\n💗✨ almost open...',
    '╭─❰ 🌸 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 · 𝐌𝐃 ❱──╮\n　 ✦ opening your menu ✦\n╰──────────────────────╯',
    '⋆｡‧˚ʚ🌸ɞ˚‧｡⋆\n✨💗🌸 ready!'
  ];

  let sent;
  try {
    sent = await sendImage(session, chatId, {
      mimetype: media.mime,
      filename: media.filename,
      data: media.data.toString('base64')
    }, frames[0]);
  } catch (error) {
    console.error('[menu] local image send failed:', error?.response?.data || error?.message || error);
    return sendText(session, chatId, text);
  }

  const messageId = sent?.id || sent?.messageId || sent?.data?.id;
  if (!messageId) return sent;

  for (const frame of frames.slice(1)) {
    await sleep(650);
    try {
      await editMessage(session, chatId, messageId, frame);
    } catch (error) {
      console.error('[menu] caption animation stopped:', error?.response?.data || error?.message || error);
      try {
        await editMessage(session, chatId, messageId, text);
      } catch {
        await sendText(session, chatId, text);
      }
      return sent;
    }
  }

  await sleep(650);
  try {
    await editMessage(session, chatId, messageId, text);
  } catch (error) {
    console.error('[menu] final caption edit failed:', error?.response?.data || error?.message || error);
    await sendText(session, chatId, text);
  }
  return sent;
}

async function trySendButtons(session, chatId, payload) {
  try {
    const result = await sendButtons(session, chatId, payload);
    return { ok: true, result };
  } catch (error) {
    console.warn('[menu] native buttons unavailable; using poll fallback:', error?.response?.data || error?.message || error);
    return { ok: false, error };
  }
}

async function sendMenuPoll(session, chatId, prefix, options, optionMap, title = '🌸 Orihime MD Menu') {
  try {
    const poll = await sendPoll(session, chatId, {
      poll: { name: title, options, multipleAnswers: false }
    });
    const pollId = poll?.id || poll?.messageId || poll?.data?.id;
    if (pollId) {
      registerMenuPoll(pollId, {
        session,
        chatId,
        prefix,
        options: optionMap,
        onAction: async (action, votePayload) => {
          const voter = jidFromValue(votePayload?.vote?.from || '') || jidFromValue(votePayload?.from || '') || '';
          const owner = await getBotOwner(session);
          const stored = getStored(session);
          const mode = stored?.mode || 'PRIVATE';
          const blocked = (command) => mode === 'PRIVATE' && !((votePayload?.vote?.fromMe === true) || Boolean(owner && voter === owner) || Boolean(OWNER_OVERRIDE && jidNumber(voter) === OWNER_OVERRIDE)) && !['menu', 'link', 'pair'].includes(command);
          if (action === 'home') return sendMenuMessage(session, chatId, prefix);
          return handleMenuSelection({
            session,
            chatId,
            from: voter,
            payload: votePayload,
            isOwner: votePayload?.vote?.fromMe === true || Boolean(owner && voter === owner) || Boolean(OWNER_OVERRIDE && jidNumber(voter) === OWNER_OVERRIDE),
            prefix,
            blockedByPrivateMode: blocked,
            rowId: action
          });
        }
      });
    }
    return poll;
  } catch (error) {
    console.warn('[menu] poll fallback failed:', error?.response?.data || error?.message || error);
    return null;
  }
}

function menuActionMapForCategory(category, prefix) {
  const options = buildCategoryPollOptions(category, prefix);
  const out = {};
  for (const label of options) {
    const command = label.slice(prefix.length).trim().split(/\s+/)[0].toLowerCase();
    const toggle = ['left', 'welcome', 'antilink', 'antibot', 'antichannel', 'antispam', 'antidelete', 'kill-sale', 'antidemote', 'antipromote', 'lang-china', 'lang-japanese', 'lang-korea'].includes(command);
    const action = toggle ? `menu:toggle:${command}` : ['pair', 'ai', 'summarize', 'translate', 'play', 'kick', 'add', 'announcement', 'autod', 'promote', 'demote', 'warn', 'remindme', 'setprefix', 'lang-add', 'prefix-d'].includes(command) ? `menu:hint:${command}` : `menu:run:${command}`;
    out[label] = action;
  }
  return { options, out };
}

async function sendCategoryInteractive(session, chatId, category, prefix) {
  const buttons = buildCategoryButtonsPayload(category, prefix);
  if (buttons) await trySendButtons(session, chatId, buttons);
  const mapped = menuActionMapForCategory(category, prefix);
  await sendMenuPoll(session, chatId, prefix, mapped.options, mapped.out, `🌸 ${category} commands`);
}

async function sendToggleInteractive(session, chatId, command, prefix) {
  const buttons = buildToggleButtonsPayload(command, prefix);
  if (buttons) await trySendButtons(session, chatId, buttons);
  const options = buildTogglePollOptions();
  const optionMap = { '✅ ON': `menu:run:${command}:on`, '🚫 OFF': `menu:run:${command}:off`, '↩️ BACK': 'home' };
  await sendMenuPoll(session, chatId, prefix, options, optionMap, `⚙️ ${prefix}${command}`);
}

async function sendMenuMessage(session, chatId, prefix) {
  const text = buildMenuText(prefix);
  await sendAnimatedMenuImage(session, chatId, text);

  // Native buttons are attempted for clients/engines that still render them.
  // Polls are also sent because WAHA currently documents polls as the reliable
  // interactive alternative and they work with GOWS.
  await trySendButtons(session, chatId, buildMainButtonsPayload(prefix));
  await trySendButtons(session, chatId, buildMoreButtonsPayload(prefix));
  const options = buildMainPollOptions();
  const optionMap = Object.fromEntries(options.map((label) => {
    const category = label.replace(/^[^A-Z]+/i, '').trim();
    const key = category.toUpperCase();
    return [label, `menu:cat:${key}`];
  }));
  await sendMenuPoll(session, chatId, prefix, options, optionMap, '🌸 Orihime MD — Menu');
}

async function handleMenuSelection({ session, chatId, from, payload, isOwner, prefix, blockedByPrivateMode, rowId }) {
  let selection = parseSelection(rowId);
  if (selection?.type === 'buttontext') {
    const mapped = commandFromButtonText(selection.text, prefix);
    if (mapped) selection = parseSelection(mapped);
  }
  if (!selection) return;

  if (selection.type === 'home') return sendMenuMessage(session, chatId, prefix);

  if (selection.type === 'category') {
    if (blockedByPrivateMode('menu')) return;
    return sendCategoryInteractive(session, chatId, selection.category, prefix);
  }

  if (selection.type === 'toggle') {
    if (blockedByPrivateMode(selection.command)) return;
    return sendToggleInteractive(session, chatId, selection.command, prefix);
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
    if (!['vv', 'silentf', 'silent-m'].includes(parsed.name)) {
      appendCommandLog({ session, chatId, sender: from, command: parsed.name, args: parsed.args, raw: parsed.raw })
        .catch((error) => console.error('[bot] command log failed:', error?.message || error));
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


async function imageToStickerWebp(buffer) {
  return sharp(buffer, { animated: false })
    .rotate()
    .resize({ width: 512, height: 512, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 82, alphaQuality: 90, effort: 4 })
    .toBuffer();
}

function runFfmpegToBuffer(args, input) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('FFmpeg binary is unavailable'));
    const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    const errors = [];
    proc.stdout.on('data', (chunk) => chunks.push(chunk));
    proc.stderr.on('data', (chunk) => errors.push(chunk));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && chunks.length) return resolve(Buffer.concat(chunks));
      reject(new Error(Buffer.concat(errors).toString('utf8').slice(-800) || `FFmpeg exited with code ${code}`));
    });
    proc.stdin.end(input);
  });
}

async function videoToStickerWebp(buffer) {
  const common = [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
    '-t', '6',
    '-vf', 'fps=10,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba',
    '-an', '-c:v', 'libwebp', '-loop', '0', '-f', 'webp', 'pipe:1'
  ];
  let output = await runFfmpegToBuffer(['-q:v', '70', ...common], buffer);
  if (output.length > 900 * 1024) {
    output = await runFfmpegToBuffer(['-r', '8', '-q:v', '52', ...common], buffer);
  }
  if (output.length > 1 * 1024 * 1024) {
    throw new Error('The resulting sticker is over 1MB. Use a shorter/smaller video.');
  }
  return output;
}

async function makeStickerFile(buffer, mimetype) {
  if (mimetype.startsWith('image/')) {
    const data = await imageToStickerWebp(buffer);
    return { mimetype: 'image/webp', filename: 'sticker.webp', data: data.toString('base64') };
  }
  if (mimetype.startsWith('video/')) {
    const data = await videoToStickerWebp(buffer);
    return { mimetype: 'image/webp', filename: 'sticker.webp', data: data.toString('base64') };
  }
  throw new Error('Sticker source must be an image or video');
}

async function executeCommand({ session, chatId, from, parsed, payload, isOwner }) {
  const { name, args } = parsed;
  const joined = args.join(' ');
  const senderMention = formatRequestedBy(from);

  switch (name) {
    case 'menu': {
      const menuPrefix = getStored(session)?.prefix || DEFAULT_PREFIX;
      await sendMenuMessage(session, chatId, menuPrefix);
      return;
    }

    case 'silent-m': {
      if (!joined) return;
      await sendText(session, chatId, joined);
      return;
    }

    case 'prefix-d': {
      const action = String(args[0] || '').toLowerCase();
      if (!action) return sendText(session, chatId, `🎞️ Usage: .prefix-d <animation>\nExample: .prefix-d woman dancing\nList: .prefix-d list\nAI add: .prefix-d add <description>`);
      if (action === 'list') {
        const items = listAnimations();
        return sendText(session, chatId, ['╭─❰ 🎞️ 𝐏𝐑𝐄𝐅𝐈𝐗-𝐃 𝐀𝐍𝐈𝐌𝐀𝐓𝐈𝐎𝐍𝐒 ❱─╮', ...items.map((x, i) => `${i + 1}. ${x.label}  →  .prefix-d ${x.key}`), '╰──────────────────────────────╯'].join('\n'));
      }
      if (action === 'add') {
        if (!isOwner) return sendText(session, chatId, '❌ Owner only.');
        const description = args.slice(1).join(' ').trim();
        if (!description) return sendText(session, chatId, '❌ Usage: .prefix-d add <animation description>');
        try {
          const made = await addGeneratedAnimation(description);
          await sendText(session, chatId, `✅ Animation added: ${made.label}\nUse: .prefix-d ${made.key}`);
        } catch (error) {
          await sendText(session, chatId, `❌ Could not create animation: ${String(error?.message || error).slice(0, 220)}`);
        }
        return;
      }
      const clean = String(args.join(' ')).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      const items = listAnimations();
      const found = items.find((x) => x.key === clean || x.label.toLowerCase() === args.join(' ').toLowerCase() || x.label.toLowerCase().replace(/\s+/g, '-') === clean);
      if (!found || !getAnimation(found.key)) return sendText(session, chatId, `❌ Unknown animation. Use .prefix-d list`);
      try {
        await startDance(session, chatId, found.key);
      } catch (error) {
        await sendText(session, chatId, `❌ Animation failed: ${String(error?.message || error).slice(0, 180)}`);
      }
      return;
    }

    case 'lang-china':
    case 'lang-japanese':
    case 'lang-korea': {
      const action = String(args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(action)) return sendText(session, chatId, `❌ Usage: .${name} on/off`);
      const language = name === 'lang-china' ? 'china' : name === 'lang-japanese' ? 'japanese' : 'korea';
      await setUserLanguage(session, chatId, from, action === 'on' ? language : '');
      return sendText(session, chatId, action === 'on'
        ? `🌐 ${language} letter mode is ON for you. Your A-Z letters will be replaced with the configured ${language} character map.`
        : `🌐 Language letter mode is OFF for you.`);
    }

    case 'lang-use': {
      const action = String(args.at(-1) || 'on').toLowerCase();
      const language = args.slice(0, -1).join(' ').trim() || args.join(' ').trim();
      if (!language) return sendText(session, chatId, '❌ Usage: .lang-use <language> on/off');
      if (!['on', 'off'].includes(action)) return sendText(session, chatId, '❌ Usage: .lang-use <language> on/off');
      const chars = getLanguageMap(language);
      if (!chars) return sendText(session, chatId, `❌ Unknown language: ${language}. Use .lang-add or one of the built-in languages.`);
      await setUserLanguage(session, chatId, from, action === 'on' ? language : '');
      return sendText(session, chatId, action === 'on' ? `🌐 ${language} letter mode is ON for you.` : '🌐 Language letter mode is OFF for you.');
    }

    case 'lang-add': {
      if (!isOwner) return sendText(session, chatId, '❌ Owner only.');
      const raw = args.join(' ').trim();
      let namePart = '';
      let chars = '';
      if (raw.includes('|') || raw.includes(':')) {
        const sep = raw.includes('|') ? '|' : ':';
        const pieces = raw.split(sep);
        namePart = String(pieces.shift() || '').trim();
        chars = pieces.join(sep).trim();
      } else {
        const pieces = raw.split(/\s+/);
        namePart = pieces.shift() || '';
        chars = pieces.join('');
      }
      if (!namePart || !chars) return sendText(session, chatId, '❌ Usage: .lang-add language|25-or-26-characters');
      try {
        const made = await addLanguage(namePart, chars);
        return sendText(session, chatId, `✅ Custom language added: ${made.label}\nUse: .lang-use ${made.key} on`);
      } catch (error) {
        return sendText(session, chatId, `❌ ${String(error?.message || error).slice(0, 200)}`);
      }
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

    case 'ai': {
      if (!joined) return sendText(session, chatId, `❌ Usage : .ai <question or request>`);
      if (!geminiConfigured()) {
        return genericStatus(session, chatId, name, [
          '🔴 Status : 𝐍𝐎𝐓 𝐂𝐎𝐍𝐅𝐈𝐆𝐔𝐑𝐄𝐃',
          '⚙️ Add GEMINI_API_KEY to the Render environment variables.',
          `🤖 Model : ${GEMINI_MODEL}`
        ], { title: '🤖 𝐀𝐈' });
      }
      try {
        const answer = await askGemini(joined.slice(0, 12000));
        const chunks = [];
        for (let i = 0; i < answer.length; i += 3500) chunks.push(answer.slice(i, i + 3500));
        for (const [index, chunk] of chunks.entries()) {
          const header = chunks.length > 1 ? `🤖 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 𝐀𝐈 〔${index + 1}/${chunks.length}〕\n\n` : '🤖 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 𝐀𝐈\n\n';
          await sendText(session, chatId, `${header}${chunk}`);
        }
      } catch (error) {
        console.error('[gemini]', error?.details || error?.message || error);
        await genericStatus(session, chatId, name, [
          '🔴 Status : 𝐀𝐈 𝐅𝐀𝐈𝐋𝐄𝐃',
          `⚠️ ${String(error?.message || 'Could not contact Gemini').slice(0, 240)}`
        ], { title: '🤖 𝐀𝐈' });
      }
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
      const rows = await commandHistory({ session, chatId, limit: 10 });
      const text = rows.length ? rows.map((r) => `• ${new Date(r.timestamp).toLocaleString()} — .${r.command}`).join('\n') : 'No command history yet.';
      await genericStatus(session, chatId, name, ['📜 Recent commands:', text], { title: '📜 𝐇𝐈𝐒𝐓𝐎𝐑𝐘' });
      return;
    }

    case 'antilink':
    case 'antibot':
    case 'antichannel':
    case 'antispam':
    case 'antidelete': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      const action = String(args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(action)) {
        return genericStatus(session, chatId, name, [`⚠️ Usage : .${name} on`, `⚠️ Usage : .${name} off`], { title: `⚙️ ${name.toUpperCase()}` });
      }
      const patch = { [name]: action === 'on' };
      await setGroup(session, chatId, patch);
      await genericStatus(session, chatId, name, [
        `✅ Status : ${action === 'on' ? '𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃' : '𝐃𝐄𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃'}`,
        `⚙️ ${name} : ${action.toUpperCase()}`,
        `👤 Requested by : ${senderMention}`
      ], { imageKey: `.${name} ${action}`, title: `⚙️ ${name.toUpperCase()}`, imageArgs: [action] });
      return;
    }

    case 'kill-sale': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      const action = String(args[0] || '').toLowerCase();
      const config = getGroup(session, chatId);
      if (action === 'list') {
        const words = currentSaleKeywords(config);
        return genericStatus(session, chatId, name, [
          '📋 Current blocked words/phrases :',
          ...words.slice(0, 60).map((word, i) => `${i + 1}. ${word}`),
          words.length > 60 ? `…and ${words.length - 60} more.` : ''
        ].filter(Boolean), { title: '🚫 𝐊𝐈𝐋𝐋-𝐒𝐀𝐋𝐄 𝐋𝐈𝐒𝐓' });
      }
      if (action === 'reset') {
        await setGroup(session, chatId, { killSaleKeywords: [] });
        return genericStatus(session, chatId, name, ['✅ Custom list reset.', '🧠 Default sale/price keywords are active.'], { title: '🚫 𝐊𝐈𝐋𝐋-𝐒𝐀𝐋𝐄 𝐑𝐄𝐒𝐄𝐓' });
      }
      if (['set', 'add', 'remove'].includes(action)) {
        const nextWords = parseKeywordList(args.slice(1).join(' '));
        if (!nextWords.length) {
          return sendText(session, chatId, `❌ Usage: .kill-sale ${action} sale,price,for sale`);
        }
        const current = Array.isArray(config.killSaleKeywords) && config.killSaleKeywords.length
          ? [...config.killSaleKeywords]
          : [...SALE_KEYWORDS];
        let result = action === 'set' ? nextWords : current;
        if (action === 'add') result = [...new Set([...current, ...nextWords])];
        if (action === 'remove') {
          const drop = new Set(nextWords);
          result = current.filter((word) => !drop.has(String(word).toLowerCase()));
        }
        await setGroup(session, chatId, { killSaleKeywords: result });
        const effective = result.length ? result : SALE_KEYWORDS;
        return genericStatus(session, chatId, name, [
          `✅ Custom list ${action.toUpperCase()} complete.`,
          `📋 Active entries : ${effective.length}`,
          `📝 ${effective.slice(0, 20).join(', ')}`
        ], { title: '🚫 𝐊𝐈𝐋𝐋-𝐒𝐀𝐋𝐄 𝐂𝐔𝐒𝐓𝐎𝐌' });
      }
      if (!['on', 'off'].includes(action)) {
        return genericStatus(session, chatId, name, [
          '⚠️ Usage : .kill-sale on/off',
          '⚙️ Custom : .kill-sale set sale,price,for sale',
          '➕ Add : .kill-sale add word1,word2',
          '➖ Remove : .kill-sale remove word1,word2',
          '📋 List : .kill-sale list',
          '♻️ Reset : .kill-sale reset'
        ], { title: '⚙️ 𝐊𝐈𝐋𝐋-𝐒𝐀𝐋𝐄' });
      }
      await setGroup(session, chatId, { killSale: action === 'on' });
      await genericStatus(session, chatId, name, [
        `✅ Status : ${action === 'on' ? '𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃' : '𝐃𝐄𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃'}`,
        `⚙️ ${name} : ${action.toUpperCase()}`,
        action === 'on' ? `🚫 ${currentSaleKeywords(config).length} blocked words/phrases are active.` : '',
        `👤 Requested by : ${senderMention}`
      ].filter(Boolean), { imageKey: `.${name} ${action}`, title: `⚙️ ${name.toUpperCase()}` });
      return;
    }

    case 'badword': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      const action = String(args[0] || '').toLowerCase();
      const config = getGroup(session, chatId);
      const current = Array.isArray(config.badwords) ? config.badwords : [];
      if (action === 'list') {
        return genericStatus(session, chatId, name, current.length ? [
          '📋 Blocked words :',
          ...current.slice(0, 60).map((word, i) => `${i + 1}. ${word}`)
        ] : ['📋 No blocked words configured yet.', `➕ Add : .badword add word1,word2`], { title: '🚫 𝐁𝐀𝐃𝐖𝐎𝐑𝐃 𝐋𝐈𝐒𝐓' });
      }
      if (['set', 'add', 'remove'].includes(action)) {
        const nextWords = parseKeywordList(args.slice(1).join(' '));
        if (!nextWords.length) return sendText(session, chatId, `❌ Usage: .badword ${action} word1,word2`);
        let result = action === 'set' ? nextWords : current;
        if (action === 'add') result = [...new Set([...current, ...nextWords])];
        if (action === 'remove') {
          const drop = new Set(nextWords);
          result = current.filter((word) => !drop.has(String(word).toLowerCase()));
        }
        await setGroup(session, chatId, { badwords: result });
        return genericStatus(session, chatId, name, [
          `✅ Blocked-word list ${action.toUpperCase()} complete.`,
          `📋 Active entries : ${result.length}`
        ], { title: '🚫 𝐁𝐀𝐃𝐖𝐎𝐑𝐃 𝐂𝐔𝐒𝐓𝐎𝐌' });
      }
      return genericStatus(session, chatId, name, [
        '⚙️ Usage : .badword add word1,word2',
        '➖ Remove : .badword remove word1,word2',
        '📋 List : .badword list',
        'ℹ️ A message matching any blocked word is deleted and the sender is warned (auto-kick at the warn limit).'
      ], { title: '⚙️ 𝐁𝐀𝐃𝐖𝐎𝐑𝐃' });
    }

    case 'warnlimit': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      const n = Number(args[0]);
      if (!Number.isFinite(n) || n < 1 || n > 20) return sendText(session, chatId, '❌ Usage: .warnlimit 3  (1-20)');
      await setGroup(session, chatId, { warnLimit: Math.round(n) });
      return genericStatus(session, chatId, name, [`✅ Warn limit set to ${Math.round(n)}.`], { title: '⚙️ 𝐖𝐀𝐑𝐍 𝐋𝐈𝐌𝐈𝐓' });
    }

    case 'warn': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      const targets = await resolveCommandTargets(session, chatId, payload, args);
      if (!targets.length) return sendText(session, chatId, '❌ Mention the user (or reply to their message): .warn @user');
      const reason = args.slice(1).join(' ') || 'Warned by an admin.';
      for (const target of targets) await warnUser(session, chatId, target, reason);
      return;
    }

    case 'antidemote':
    case 'antipromote': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      const action = String(args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(action)) {
        return genericStatus(session, chatId, name, [`⚠️ Usage : .${name} on`, `⚠️ Usage : .${name} off`], { title: `🛡️ ${name.toUpperCase()}` });
      }
      await setGroup(session, chatId, { [name]: action === 'on' });
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

    case 'candy': {
      const grid = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => ['🍬','🍭','🍫','🍓','🍡'][Math.floor(Math.random() * 5)]));
      GAME_SESSIONS.set(`${session}:${chatId}:${from}:candy`, { grid });
      await genericStatus(session, chatId, name, ['🎮 Game started!', 'Match 3 or more identical candies conceptually.', grid.map((r) => r.join(' ')).join('\n')], { title: '🍬 𝐂𝐀𝐍𝐃𝐘' });
      return;
    }

    case 'candycrush': {
      try {
        await startCandyGame(session, chatId, from);
      } catch (error) {
        await sendText(session, chatId, `❌ Candy Crush could not start: ${String(error?.message || error).slice(0, 180)}`);
      }
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
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      const targets = await resolveCommandTargets(session, chatId, payload, args);
      if (!targets.length) {
        return sendText(session, chatId, `❌ Mention the user (or reply to their message): .${name} @user`);
      }
      const done = [];
      const failed = [];
      for (const target of targets) {
        try {
          if (name === 'kick') await removeParticipants(session, chatId, [target]);
          else if (name === 'promote') await applyAdminAction(session, chatId, 'promote', target);
          else await applyAdminAction(session, chatId, 'demote', target);
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
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
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
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      if (String(args[0]).toLowerCase() !== 'confirm') {
        return genericStatus(session, chatId, name, ['⚠️ This removes every non-admin member.', 'Use `.kickall confirm` to continue.'], { title: '⚠️ 𝐊𝐈𝐂𝐊 𝐀𝐋𝐋' });
      }
      const participants = (await resolveParticipants(session, chatId)).map(parseParticipant);
      const targets = participants.filter((p) => !isParticipantAdmin(p)).map(participantJid).filter(Boolean);
      if (targets.length) await removeParticipants(session, chatId, targets);
      await genericStatus(session, chatId, name, [`✅ Removed : ${targets.length} members.`], { title: '⚠️ 𝐊𝐈𝐂𝐊 𝐀𝐋𝐋' });
      return;
    }

    case 'tagall': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      const participants = (await resolveParticipants(session, chatId)).map(participantJid).filter(Boolean);
      await genericStatus(session, chatId, name, [`👥 Members : ${participants.length}`, '📣 Tagging one by one...'], { title: '📣 𝐓𝐀𝐆 𝐀𝐋𝐋' });
      for (const member of participants) {
        await sendText(session, chatId, `@${jidNumber(member)}`, { mentions: [member] });
        await sleep(350);
      }
      return;
    }

    case 'hidetag': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      await sendText(session, chatId, joined || '🌸 Orihime MD', { mentions: ['all'] });
      await genericStatus(session, chatId, name, ['✅ Status : 𝐒𝐄𝐍𝐓', '👥 Everyone was mentioned invisibly.'], { title: '👥 𝐇𝐈𝐃𝐄𝐓𝐀𝐆' });
      return;
    }

    case 'invite': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      const invite = await getInviteCode(session, chatId);
      const code = invite?.code || invite?.inviteCode || invite;
      await genericStatus(session, chatId, name, [`🔗 Invite : ${code || 'Unavailable'}`], { title: '🔗 𝐈𝐍𝐕𝐈𝐓𝐄' });
      return;
    }

    case 'link': {
      // Public — anyone can run this, no admin gate.
      await sendAnimatedFrames(session, chatId, ['🔗 Gathering links', '✨ Polishing the card']);
      const BOT_LINK = 'https://orihime-md.github.io/-.com/';
      const CHANNEL_LINK = 'https://whatsapp.com/channel/0029VbDOiYGHVvTTnDNd6I2C';
      const lines = [
        '╭━━━〔 🔗 𝐋𝐈𝐍𝐊𝐒 〕━━━╮',
        '┃ 🤖 𝐁𝐨𝐭 𝐥𝐢𝐧𝐤',
        `┃ ${BOT_LINK}`,
        '┃',
        '┃ 📡 𝐂𝐡𝐚𝐧𝐧𝐞𝐥 𝐥𝐢𝐧𝐤',
        `┃ ${CHANNEL_LINK}`,
        '╰━━━━━━━━━━━━━━━━━━━━╯',
        '',
        '💗 Tap either link to open it directly.'
      ];
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
      await setGroup(session, chatId, { left: action === 'on' });
      await genericStatus(session, chatId, name, [
        `✅ Status : ${action === 'on' ? '𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃' : '𝐃𝐄𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃'}`,
        `👋 Goodbye alerts : ${action.toUpperCase()}`,
        `👤 Requested by : ${senderMention}`
      ], { imageKey: `.left ${action}`, title: '👋 𝐋𝐄𝐅𝐓 𝐀𝐋𝐄𝐑𝐓' });
      return;
    }

    case 'leave': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
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
      await setGroup(session, chatId, { welcome: action === 'on' });
      await genericStatus(session, chatId, name, [
        `✅ Status : ${action === 'on' ? '𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃' : '𝐃𝐄𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃'}`,
        `🌸 Welcome messages : ${action.toUpperCase()}`,
        `👤 Requested by : ${senderMention}`
      ], { imageKey: `.welcome ${action}`, title: '🌸 𝐖𝐄𝐋𝐂𝐎𝐌𝐄' });
      return;
    }

    case 'autod': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      const argsCopy = [...args];
      let action = 'on';
      if (String(argsCopy[0] || '').toLowerCase() === 'off' || String(argsCopy.at(-1) || '').toLowerCase() === 'off') action = 'off';
      if (String(argsCopy[0] || '').toLowerCase() === 'on' || String(argsCopy.at(-1) || '').toLowerCase() === 'on') action = 'on';
      const targetArgs = argsCopy.filter((x) => !['on', 'off'].includes(String(x).toLowerCase()));
      if (!targetArgs.length && action === 'off') {
        await setGroup(session, chatId, { autoDeleteUsers: [] });
        return genericStatus(session, chatId, name, ['✅ Status : 𝐀𝐔𝐓𝐎 𝐃𝐄𝐋𝐄𝐓𝐄 𝐎𝐅𝐅', '🗑️ No targeted members will be auto-deleted.'], { title: '🗑️ 𝐀𝐔𝐓𝐎 𝐃𝐄𝐋𝐄𝐓𝐄' });
      }
      const target = (await resolveCommandTargets(session, chatId, payload, targetArgs, { resolveAliases: true }))[0];
      if (!target) return sendText(session, chatId, `❌ Mention the user (or reply to their message): .autod @user on/off`);
      let allIds = [target];
      try {
        const entries = (await resolveParticipants(session, chatId, { deep: true })).map(parseParticipant);
        const entry = findEntry(entries, [target]);
        if (entry?.ids?.length) allIds = entry.ids;
      } catch {}
      const config = getGroup(session, chatId);
      const users = new Set(Array.isArray(config.autoDeleteUsers) ? config.autoDeleteUsers : []);
      if (action === 'off') allIds.forEach((id) => users.delete(id));
      else allIds.forEach((id) => users.add(id));
      await setGroup(session, chatId, { autoDeleteUsers: [...users] });
      await genericStatus(session, chatId, name, [
        `✅ Status : ${action === 'on' ? '𝐀𝐔𝐓𝐎 𝐃𝐄𝐋𝐄𝐓𝐄 𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃' : '𝐀𝐔𝐓𝐎 𝐃𝐄𝐋𝐄𝐓𝐄 𝐃𝐄𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃'}`,
        `👤 Target : @${jidNumber(target)}`,
        action === 'on' ? '⚡ New messages from this user will be deleted immediately.' : '✅ Future messages from this user will no longer be auto-deleted.'
      ], { title: '🗑️ 𝐀𝐔𝐓𝐎 𝐃𝐄𝐋𝐄𝐓𝐄' });
      return;
    }

    case 'announcement': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      if (!joined) return sendText(session, chatId, `❌ Usage : .announcement <text>`);
      const participants = (await resolveParticipants(session, chatId)).map(participantJid).filter(Boolean);
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
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      const requested = String(args[0] || '').trim().toLowerCase();
      if (requested === 'cancel') {
        cancelScheduledGroupAction(session, chatId);
        await setGroup(session, chatId, { scheduledGroupAction: null });
        return genericStatus(session, chatId, name, [
          `✅ Scheduled ${name} action cancelled.`,
          `👤 Requested by : ${senderMention}`
        ], { title: name === 'close' ? '🔒 𝐆𝐑𝐎𝐔𝐏 𝐂𝐋𝐎𝐒𝐄' : '🔓 𝐆𝐑𝐎𝐔𝐏 𝐎𝐏𝐄𝐍' });
      }
      try {
        const result = await scheduleGroupAction(session, chatId, name, requested);
        if (result.immediate) {
          await setGroup(session, chatId, { scheduledGroupAction: null });
          return genericStatus(session, chatId, name, [
            `✅ Status : ${name === 'close' ? '𝐆𝐑𝐎𝐔𝐏 𝐂𝐋𝐎𝐒𝐄𝐃' : '𝐆𝐑𝐎𝐔𝐏 𝐎𝐏𝐄𝐍𝐄𝐃'}`,
            name === 'close' ? '👑 Only admins can send messages.' : '👥 Members can send messages again.',
            `👤 Requested by : ${senderMention}`
          ], { title: name === 'close' ? '🔒 𝐆𝐑𝐎𝐔𝐏 𝐂𝐋𝐎𝐒𝐄' : '🔓 𝐆𝐑𝐎𝐔𝐏 𝐎𝐏𝐄𝐍' });
        }
        return genericStatus(session, chatId, name, [
          `⏰ ${name === 'close' ? 'Close' : 'Open'} scheduled.`,
          `🕒 Time : ${result.when}`,
          `📝 Cancel with : .${name} cancel`,
          `👤 Requested by : ${senderMention}`
        ], { title: name === 'close' ? '🔒 𝐆𝐑𝐎𝐔𝐏 𝐂𝐋𝐎𝐒𝐄' : '🔓 𝐆𝐑𝐎𝐔𝐏 𝐎𝐏𝐄𝐍' });
      } catch (error) {
        return sendText(session, chatId, `❌ ${String(error?.message || error).slice(0, 200)}\nExamples: .${name} 30m | .${name} 2h | .${name} 22:00`);
      }
    }

    case 'split-gc': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      if (!isGroup(chatId)) return sendText(session, chatId, '❌ This command only works inside a group.');
      await sendText(session, chatId, '🪞 Creating an identical group copy and adding the current members...');
      try {
        const source = await groupDetails(session, chatId, { deep: true });
        const botIds = await getSelfIds(session);
        const participants = (await resolveParticipants(session, chatId, { deep: true })).map((p) => p);
        const result = await cloneGroup(session, chatId, source, participants, botIds);
        await sendText(session, chatId, `✅ Split group created.\n👥 Group : ${result.subject}\n🆔 New group ID : ${result.newId}\n👤 Members copied : ${result.targetMembers}\n👑 Admins restored : ${result.admins}${result.verifiedParticipants != null ? `\n✔️ Verified members : ${result.verifiedParticipants}` : ''}`);
      } catch (error) {
        console.error('[split-gc]', error?.response?.data || error?.message || error);
        await sendText(session, chatId, `❌ Could not create the clone: ${String(error?.response?.data?.message || error?.message || error).slice(0, 260)}`);
      }
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
          const status = await getGroupAdminStatus(session, chatId, from, payload, { live: true });
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
      const status = await getGroupAdminStatus(session, chatId, from, payload, { live: true });
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

    case 'silentf': {
      return revealViewOnce(session, chatId, payload, { silent: true });
    }

    case 'vv': {
      return revealViewOnce(session, chatId, payload);
    }

    case 'sticker': {
      const { message, error } = await fetchQuotedMedia(session, chatId, payload);
      if (error === 'no-reply') return sendText(session, chatId, '❌ Reply to an image or a short video with .sticker');
      if (!message) return sendText(session, chatId, `❌ Could not read that message (${error}).`);
      const mimetype = String(message.media?.mimetype || '').split(';')[0].toLowerCase();
      if (!mimetype.startsWith('image/') && !mimetype.startsWith('video/')) {
        return sendText(session, chatId, '❌ Reply to an image or a short video to make a sticker.');
      }
      const media = await withMediaSlot(() => downloadMedia(message.media.url));
      if (!media?.buffer?.length) return sendText(session, chatId, '❌ Could not download that media.');
      try {
        const file = await makeStickerFile(media.buffer, mimetype);
        await sendSticker(session, chatId, file);
      } catch (error) {
        console.error('[bot] sticker failed:', error?.response?.data || error?.message || error);
        await sendText(session, chatId, `❌ Could not create the sticker. ${String(error?.message || '').slice(0, 180)}`.trim());
      }
      return;
    }

    case 'toimg': {
      const { message, error } = await fetchQuotedMedia(session, chatId, payload);
      if (error === 'no-reply') return sendText(session, chatId, '❌ Reply to a sticker with .toimg');
      if (!message) return sendText(session, chatId, `❌ Could not read that message (${error}).`);
      const media = await withMediaSlot(() => downloadMedia(message.media.url));
      if (!media?.buffer?.length) return sendText(session, chatId, '❌ Could not download that sticker.');
      const mimetype = String(message.media.mimetype || 'image/webp').split(';')[0];
      const file = { mimetype, filename: 'sticker.webp', data: media.buffer.toString('base64') };
      try {
        await sendImage(session, chatId, file, '🖼️ Here you go!');
      } catch (error) {
        console.error('[bot] toimg failed:', error?.response?.data || error?.message || error);
        await sendText(session, chatId, '❌ Could not convert that sticker.');
      }
      return;
    }

    // Music/audio helper. RapidAPI is used first when RAPIDAPI_KEY is set,
    // because direct YouTube scraping can trigger Google's bot checks. The
    // existing play-dl implementation remains as a fallback. Use only for
    // media you are permitted to download.
    case 'play': {
      if (!joined) return sendText(session, chatId, '❌ Usage : .play <song name or YouTube link>');
      await sendText(session, chatId, `🔎 Searching for "${joined}"...`);

      let rapidError = null;
      if (rapidApiConfigured()) {
        try {
          let videoId = extractYoutubeVideoId(joined);
          let title = joined.trim();
          if (!videoId) {
            const result = await rapidYoutubeSearch(joined);
            videoId = result.videoId;
            title = result.title || title;
          }
          const downloaded = await withMediaSlot(() => rapidYoutubeDownload(videoId));
          if (!downloaded?.buffer?.length) throw new Error('RapidAPI returned an empty audio file');
          if (downloaded.buffer.length > 60 * 1024 * 1024) throw new Error('That track is over 60MB and cannot be sent.');
          const isOgg = /ogg|opus/i.test(downloaded.contentType);
          const ext = isOgg ? 'ogg' : 'mp3';
          const mimetype = isOgg ? 'audio/ogg; codecs=opus' : 'audio/mpeg';
          const filename = `${String(title).slice(0, 60).replace(/[\\/:*?"<>|]/g, '') || 'track'}.${ext}`;
          await sendFile(session, chatId, { mimetype, filename, data: downloaded.buffer.toString('base64') }, `🎵 ${title}`);
          return;
        } catch (error) {
          rapidError = error;
          console.error('[bot] RapidAPI .play failed', {
            query: joined.slice(0, 160),
            stage: videoId ? 'download' : 'search',
            videoId: videoId || null,
            status: error?.status || error?.response?.status || null,
            code: error?.code || null,
            message: String(error?.message || error).slice(0, 350),
            detail: String(error?.rapidApiDetail || error?.response?.data || '').slice(0, 500)
          });
        }
      }

      let playdl;
      try {
        ({ default: playdl } = await import('play-dl'));
      } catch (error) {
        return genericStatus(session, chatId, name, [
          '🔴 Status : 𝐍𝐎𝐓 𝐈𝐍𝐒𝐓𝐀𝐋𝐋𝐄𝐃',
          '⚙️ The fallback downloader is not installed.',
          rapidError ? `⚠️ RapidAPI: ${String(rapidError.message || rapidError).slice(0, 150)}` : '⚙️ Add RAPIDAPI_KEY in Render for the recommended downloader.'
        ], { title: '🎵 𝐏𝐋𝐀𝐘' });
      }

      try {
        let url = joined.trim();
        let title = url;
        if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) {
          const results = await playdl.search(joined, { limit: 1, source: { youtube: 'video' } });
          if (!results?.length) throw new Error('No results found for that song.');
          url = results[0].url;
          title = results[0].title || joined;
        }
        const { stream, buffer } = await withMediaSlot(async () => {
          const streamInfo = await playdl.stream(url, { discordPlayerCompatibility: false });
          const chunks = [];
          await new Promise((resolve, reject) => {
            streamInfo.stream.on('data', (chunk) => chunks.push(chunk));
            streamInfo.stream.on('end', resolve);
            streamInfo.stream.on('error', reject);
          });
          return { stream: streamInfo, buffer: Buffer.concat(chunks) };
        });
        if (!buffer.length) throw new Error('Could not download audio for that song.');
        if (buffer.length > 60 * 1024 * 1024) throw new Error('That track is over 60MB and cannot be sent.');
        const mimetype = stream.type === 'opus' ? 'audio/ogg; codecs=opus' : 'audio/mpeg';
        const ext = stream.type === 'opus' ? 'ogg' : 'mp3';
        const file = { mimetype, filename: `${String(title).slice(0, 60).replace(/[\\/:*?"<>|]/g, '') || 'track'}.${ext}`, data: buffer.toString('base64') };
        await sendFile(session, chatId, file, `🎵 ${title}`);
      } catch (error) {
        console.error('[bot] play failed:', error?.message || error);
        const details = [
          '🔴 Status : 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 𝐅𝐀𝐈𝐋𝐄𝐃',
          `⚠️ ${String(error?.message || 'Could not fetch that track').slice(0, 180)}`
        ];
        if (rapidError) details.push(`🌐 RapidAPI: ${String(rapidError.message || rapidError).slice(0, 160)}`);
        else details.push('⚙️ Set RAPIDAPI_KEY in Render to avoid YouTube bot-check failures.');
        await genericStatus(session, chatId, name, details, { title: '🎵 𝐏𝐋𝐀𝐘' });
      }
      return;
    }

    case 'summarize': {
      if (!geminiConfigured()) {
        return genericStatus(session, chatId, name, [
          '🔴 Status : 𝐍𝐎𝐓 𝐂𝐎𝐍𝐅𝐈𝐆𝐔𝐑𝐄𝐃',
          '⚙️ Add GEMINI_API_KEY to the Render environment variables.'
        ], { title: '📝 𝐒𝐔𝐌𝐌𝐀𝐑𝐈𝐙𝐄' });
      }
      let text = joined;
      if (!text) {
        const { message } = await fetchQuotedMedia(session, chatId, payload).catch(() => ({}));
        text = message?.body || '';
        if (!text) {
          const quoted = payload?._data?.message?.extendedTextMessage?.text || payload?._data?.quotedMessage?.conversation || '';
          text = quoted;
        }
      }
      if (!text) return sendText(session, chatId, '❌ Reply to a message with .summarize, or use .summarize <text>');
      try {
        const answer = await askGemini(`Summarize the following message concisely, in a few sentences:\n\n${text.slice(0, 12000)}`);
        await sendText(session, chatId, `📝 𝐒𝐔𝐌𝐌𝐀𝐑𝐘\n\n${answer}`);
      } catch (error) {
        console.error('[gemini] summarize', error?.message || error);
        await sendText(session, chatId, '❌ Could not summarize that right now.');
      }
      return;
    }

    case 'translate': {
      if (!geminiConfigured()) {
        return genericStatus(session, chatId, name, [
          '🔴 Status : 𝐍𝐎𝐓 𝐂𝐎𝐍𝐅𝐈𝐆𝐔𝐑𝐄𝐃',
          '⚙️ Add GEMINI_API_KEY to the Render environment variables.'
        ], { title: '🌐 𝐓𝐑𝐀𝐍𝐒𝐋𝐀𝐓𝐄' });
      }
      const targetLang = args[0];
      let text = args.slice(1).join(' ');
      if (!targetLang) return sendText(session, chatId, '❌ Usage : .translate <language> [text]  (or reply to a message with .translate <language>)');
      if (!text) {
        const { message } = await fetchQuotedMedia(session, chatId, payload).catch(() => ({}));
        text = message?.body || payload?._data?.message?.extendedTextMessage?.text || '';
      }
      if (!text) return sendText(session, chatId, '❌ Reply to a message with .translate <language>, or provide text.');
      try {
        const answer = await askGemini(`Translate the following text to ${targetLang}. Reply with ONLY the translation, nothing else:\n\n${text.slice(0, 8000)}`);
        await sendText(session, chatId, `🌐 ${answer}`);
      } catch (error) {
        console.error('[gemini] translate', error?.message || error);
        await sendText(session, chatId, '❌ Could not translate that right now.');
      }
      return;
    }

    case 'remindme': {
      const minutes = Number(args[0]);
      const text = args.slice(1).join(' ');
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440 || !text) {
        return sendText(session, chatId, '❌ Usage : .remindme <minutes 1-1440> <text>');
      }
      await sendText(session, chatId, `⏰ Reminder set for ${minutes} minute${minutes === 1 ? '' : 's'} from now.`);
      // In-memory only: a reminder set right before a restart/redeploy is
      // lost. Fine for casual use; not durable enough to promise for
      // anything important.
      setTimeout(() => {
        sendText(session, chatId, `⏰ 𝐑𝐄𝐌𝐈𝐍𝐃𝐄𝐑 for ${senderMention}\n\n${text}`, { mentions: from ? [from] : [] }).catch(() => {});
      }, minutes * 60000);
      return;
    }

    case 'group-id': {
      const gate = await assertGroupAdmin(session, chatId, from, payload);
      if (!gate.ok) return sendAdminGateFailure(session, chatId, gate);
      const group = await groupDetails(session, chatId, {});
      await genericStatus(session, chatId, name, [
        `👥 Group : ${groupSubject(group, chatId)}`,
        `🆔 ID : ${chatId}`,
        '🛡️ Owner/admin check : saved snapshot used'
      ], { title: '🆔 𝐆𝐑𝐎𝐔𝐏 𝐈𝐃' });
      return;
    }

    default:
      await genericStatus(session, chatId, name, [`❓ Unknown command : .${name}`, 'Use .menu to view available commands.'], { title: '❓ 𝐔𝐍𝐊𝐍𝐎𝐖𝐍 𝐂𝐎𝐌𝐌𝐀𝐍𝐃' });
  }
}

// .antispam flood tracking: sliding window of recent message timestamps per
// (session, chat, sender). Kept in memory only — a false positive here is
// cheap (worst case: one warn), so this doesn't need to survive a restart.
const SPAM_WINDOW = new Map(); // `${session}:${chatId}:${senderJid}` -> number[] (timestamps)
const SPAM_WINDOW_MS = 8000;
const SPAM_MAX_MESSAGES = 6;
function isFlooding(session, chatId, senderJid) {
  const key = `${session}:${chatId}:${senderJid}`;
  const now = Date.now();
  const hits = (SPAM_WINDOW.get(key) || []).filter((t) => now - t < SPAM_WINDOW_MS);
  hits.push(now);
  SPAM_WINDOW.set(key, hits);
  return hits.length > SPAM_MAX_MESSAGES;
}

async function moderateIncoming(session, chatId, payload, senderJid, body, { fastOnly = false } = {}) {
  if (!isGroup(chatId)) return false;
  const config = getGroup(session, chatId);
  const messageId = payload?.id || payload?.messageId || payload?._data?.Info?.ID;

  if (config.antilink && /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/|whatsapp\.com\/)/i.test(String(body || ''))) {
    if (messageId) await deleteWithWarning(session, chatId, messageId, senderJid, '🔗 Links are not allowed in this group.');
    return true;
  }

  if (config.antichannel) {
    const directChannel = String(payload?.from || '').endsWith('@newsletter') || String(payload?._data?.Info?.Chat || '').endsWith('@newsletter');
    const quotedChannel = JSON.stringify(payload?._data || {}).includes('@newsletter');
    if (directChannel || quotedChannel) {
      if (messageId) await deleteWithWarning(session, chatId, messageId, senderJid, '📡 Channel forwards are not allowed in this group.');
      return true;
    }
  }

  if (fastOnly) return false;

  if (config.antibot && !payload?.fromMe) {
    const senderIds = senderIdsFromPayload(payload, senderJid);
    const knownBot = senderIds.some((id) => ANTIBOT_JIDS.has(normalizeJid(id) || id));
    const signal = detectBotLikeMessage(payload, body, { session, chatId, senderJid });
    let senderIsAdmin = false;
    if (!ANTIBOT_MODERATE_ADMINS) {
      try { senderIsAdmin = await isSenderGroupAdmin(session, chatId, senderJid, payload); } catch { senderIsAdmin = false; }
    }
    const shouldDelete = !senderIsAdmin && (knownBot || signal.score >= ANTIBOT_SCORE_THRESHOLD);
    if (shouldDelete) {
      if (messageId) {
        const reason = knownBot
          ? '🤖 Bot account detected — message deleted.'
          : `🤖 Bot-style response detected (${signal.score}/${ANTIBOT_SCORE_THRESHOLD}) — message deleted.`;
        await deleteWithWarning(session, chatId, messageId, senderJid, reason);
      }
      if (ANTIBOT_KICK && knownBot) {
        for (const target of senderIds) {
          try { await removeParticipants(session, chatId, [target]); break; } catch {}
        }
      }
      if (ANTIBOT_WARN && !knownBot) {
        try { await sendText(session, chatId, `🤖 Bot-style message removed. Signals: ${signal.reasons.slice(0, 4).join(', ')}`); } catch {}
      }
      return true;
    }
  }

  const saleRegex = buildKeywordRegex(currentSaleKeywords(config));
  if (config.killSale && saleRegex?.test(String(body || ''))) {
    const senderIsAdmin = await isSenderGroupAdmin(session, chatId, senderJid, payload);
    if (!senderIsAdmin) {
      if (messageId) await deleteWithWarning(session, chatId, messageId, senderJid, '🚫 Sale/price/availability posts are not allowed here.');
      return true;
    }
  }

  const badwordRegex = buildKeywordRegex(config.badwords);
  if (config.badwords?.length && badwordRegex?.test(String(body || ''))) {
    const senderIsAdmin = await isSenderGroupAdmin(session, chatId, senderJid, payload);
    if (!senderIsAdmin) {
      if (messageId) { try { await deleteMessage(session, chatId, messageId); } catch {} }
      await warnUser(session, chatId, senderJid, '🚫 Watch your language — that word is blocked in this group.');
      return true;
    }
  }

  if (config.antispam && !payload?.fromMe) {
    const senderIsAdmin = await isSenderGroupAdmin(session, chatId, senderJid, payload);
    if (!senderIsAdmin && isFlooding(session, chatId, senderJid)) {
      if (messageId) { try { await deleteMessage(session, chatId, messageId); } catch {} }
      await warnUser(session, chatId, senderJid, '📵 Sending messages too quickly — slow down.');
      return true;
    }
  }
  return false;
}

