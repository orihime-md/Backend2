import fs from 'node:fs/promises';
import path from 'node:path';
import {
  sendText,
  sendImage,
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
  getSession as getStored,
  upsertSession,
  getGroup,
  setGroup,
  appendCommandLog,
  commandHistory,
  clearHistory,
  getChannelImage,
  listChannelImages
} from './store.js';
import { syncChannelImages } from './channelSync.js';

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

function buildMenuText(prefix = '.') {
  return `╭━━━〔 🌸 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 𝐌𝐃 〕━━━╮
┃ ✦ 𝐁𝐎𝐓 𝐈𝐍𝐅𝐎 ✦
┃
┃ 🤖 𝐍𝐚𝐦𝐞 : "Orihime MD"
┃ 👑 𝐎𝐰𝐧𝐞𝐫 : "Cute Precious"
┃ ⚡ 𝐏𝐫𝐞𝐟𝐢𝐱 : "${prefix}"
┃ 🔖 𝐕𝐞𝐫𝐬𝐢𝐨𝐧 : "1.0.0"
╰━━━━━━━━━━━━━━━━━━━━╯

╭───〔 🛠️ 𝐁𝐎𝐓 〕───╮
│ ❯ "${prefix}ping"
│ ❯ "${prefix}setprefix"
│ ❯ "${prefix}public"
│ ❯ "${prefix}private"
╰━━━━━━━━━━━━━━━━━━╯

╭───〔 🎀 𝐅𝐔𝐍 〕───╮
│ ❯ "${prefix}blague"
│ ❯ "${prefix}joke"
│ ❯ "${prefix}orihime-wipe"
│ ❯ "${prefix}orihime-history"
╰━━━━━━━━━━━━━━━━━━╯

╭───〔 ⚙️ 𝐀𝐃𝐌𝐈𝐍 〕───╮
│ ❯ "${prefix}antibot"
│ ❯ "${prefix}antichannel"
│ ❯ "${prefix}antilink"
│ ❯ "${prefix}kill-sale on/off"
╰━━━━━━━━━━━━━━━━━━━━╯

╭───〔 🎮 𝐆𝐀𝐌𝐄𝐒 〕───╮
│ ❯ "${prefix}candy"
│ ❯ "${prefix}candycrush"
│ ❯ "${prefix}crossword"
│ ❯ "${prefix}wordgame"
│ ❯ "${prefix}2048"
╰━━━━━━━━━━━━━━━━━━━━╯

╭───〔 👥 𝐆𝐑𝐎𝐔𝐏 〕───╮
│ ❯ "${prefix}kick"
│ ❯ "${prefix}add <number>"
│ ❯ "${prefix}kickall"
│ ❯ "${prefix}tagall"
│ ❯ "${prefix}hidetag"
│ ❯ "${prefix}invite"
│ ❯ "${prefix}left on/off"
│ ❯ "${prefix}leave"
│ ❯ "${prefix}welcome on/off"
│ ❯ "${prefix}autod @user"
│ ❯ "${prefix}announcement"
│ ❯ "${prefix}close"
│ ❯ "${prefix}open"
│ ❯ "${prefix}group-id"
│ ❯ "${prefix}promote"
│ ❯ "${prefix}demote"
╰━━━━━━━━━━━━━━━━━━╯

╭───〔 💗 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 〕───╮
│ 🌸 Cute • Simple • Fast
│ ✨ Made with love by
│    "Cute Precious"
╰━━━━━━━━━━━━━━━━━━━━╯

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

function normalizeJid(input) {
  if (!input) return '';
  if (String(input).endsWith('@c.us')) return String(input);
  if (String(input).endsWith('@s.whatsapp.net')) return `${String(input).split('@')[0]}@c.us`;
  return `${String(input).replace(/\D/g, '')}@c.us`;
}

function jidNumber(jid) {
  return String(jid || '').split('@')[0].replace(/\D/g, '');
}

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

function statusCaption(title, lines = []) {
  return [
    '╭━━━〔 🌸 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 𝐌𝐃 〕━━━╮',
    `┃ ✦ ${title} ✦`,
    '┃',
    ...lines.map((line) => `┃ ${line}`),
    '╰━━━━━━━━━━━━━━━━━━━━╯',
    '',
    '«「 𝐎𝐫𝐢𝐡𝐢𝐦𝐞 𝐌𝐃 🌸 」»'
  ].join('\n');
}

function commandImageKey(command, args) {
  const exactArgCommands = new Set(['antilink', 'antibot', 'antichannel', 'kill-sale']);
  if (exactArgCommands.has(command) && args?.length) return `.${command} ${args.join(' ')}`;
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

async function sendChannelImage(session, chatId, key, caption) {
  const mapping = getChannelImage(key);
  if (!mapping?.localPath) {
    // A quick resync may pick up a newly posted channel image before giving the user an error.
    try { await syncChannelImages(session); } catch {}
  }
  const fresh = getChannelImage(key);
  if (fresh?.localPath) {
    try {
      const buffer = await fs.readFile(fresh.localPath);
      return await sendImage(session, chatId, {
        mimetype: fresh.mime || 'image/jpeg',
        filename: `${key.replace(/[^a-z0-9]+/gi, '_').replace(/^_/, '') || 'orihime'}.${String(fresh.mime || 'image/jpeg').split('/')[1] || 'jpg'}`,
        data: buffer.toString('base64')
      }, caption);
    } catch (error) {
      console.error('[bot] local image send failed', error?.message || error);
    }
  }
  const mediaUrl = fresh?.mediaUrl;
  if (mediaUrl) {
    try {
      const media = await downloadMedia(mediaUrl);
      return await sendImage(session, chatId, {
        mimetype: media.contentType || 'image/jpeg',
        filename: `orihime.${String(media.contentType || 'image/jpeg').split('/')[1] || 'jpg'}`,
        data: media.buffer.toString('base64')
      }, caption);
    } catch (error) {
      console.error('[bot] remote image send failed', error?.message || error);
    }
  }
  return await sendText(session, chatId, `${caption}\n\n⚠️ Channel image for ${key} is not synchronized yet.`);
}

async function resolveParticipants(session, groupId) {
  const result = await getParticipants(session, groupId);
  return Array.isArray(result) ? result : (result?.participants || result?.data || []);
}

function participantJid(p) {
  return normalizeJid(p?.id || p?.jid || p?.participant || '');
}

function participantRole(p) {
  return String(p?.role || '').toLowerCase();
}

async function assertGroupAdmin(session, chatId, senderJid) {
  if (!isGroup(chatId)) return { ok: false, message: 'This command only works inside a group.' };
  const participants = await resolveParticipants(session, chatId);
  const me = normalizeJid((await getMe(session))?.id || '');
  const sender = normalizeJid(senderJid);
  const senderRecord = participants.find((p) => participantJid(p) === sender);
  const botRecord = participants.find((p) => participantJid(p) === me);
  const admin = (p) => ['admin', 'superadmin', 'administrator'].includes(participantRole(p)) || p?.isAdmin || p?.isSuperAdmin;
  if (!admin(senderRecord)) return { ok: false, message: '❌ Only group admins can use this command.' };
  if (!admin(botRecord)) return { ok: false, message: '❌ I need group admin permission to perform this action.' };
  return { ok: true, participants, senderRecord, botRecord };
}

async function isSenderGroupAdmin(session, chatId, senderJid) {
  try {
    const participants = await resolveParticipants(session, chatId);
    const sender = normalizeJid(senderJid);
    const senderRecord = participants.find((p) => participantJid(p) === sender);
    return ['admin', 'superadmin', 'administrator'].includes(participantRole(senderRecord)) || Boolean(senderRecord?.isAdmin) || Boolean(senderRecord?.isSuperAdmin);
  } catch {
    return false;
  }
}

function targetFromPayload(payload, args = []) {
  const mentioned = payload?.mentionedJid || payload?.mentioned || payload?._data?.mentionedJid || [];
  if (Array.isArray(mentioned) && mentioned[0]) return normalizeJid(mentioned[0]);
  const first = args.find((x) => x.startsWith('@'));
  return first ? normalizeJid(first.replace('@', '')) : '';
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
  const key = options.imageKey || commandImageKey(command, options.imageArgs || []);
  const caption = statusCaption(options.title || command.toUpperCase(), lines);
  return sendChannelImage(session, chatId, key, caption);
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

export async function handleGroupEvent(session, eventName, payload) {
  const groupId = payload?.group?.id || payload?.id;
  if (!isGroup(groupId)) return;
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
  const from = normalizeJid(payload.from || payload.sender || payload.author || payload._data?.Info?.Sender);

  // Auto-moderation events work independently of commands.
  if (chatId && !payload.fromMe) {
    const config = isGroup(chatId) ? getGroup(chatId) : null;
    const autoDeleteUsers = Array.isArray(config?.autoDeleteUsers) ? config.autoDeleteUsers : [];
    if (autoDeleteUsers.includes(from)) {
      const id = payload?.id || payload?.messageId || payload?._data?.Info?.ID;
      if (id) {
        try { await deleteMessage(session, chatId, id); } catch {}
      }
      return;
    }
    await moderateIncoming(session, chatId, payload, from, body);
  }

  if (payload.fromMe) return;

  const stored = getStored(session);
  const prefix = stored?.prefix || DEFAULT_PREFIX;
  const parsed = parseCommand(body, prefix);
  if (!parsed) return;

  const owner = await getBotOwner(session);
  const isOwner = Boolean(owner && from === owner) || Boolean(OWNER_OVERRIDE && jidNumber(from) === OWNER_OVERRIDE);
  const mode = stored?.mode || 'PRIVATE';

  await appendCommandLog({ session, chatId, sender: from, command: parsed.name, args: parsed.args, raw: body });

  await sendIntro(session, chatId);

  if (mode === 'PRIVATE' && !isOwner) {
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

async function executeCommand({ session, chatId, from, parsed, payload, isOwner }) {
  const { name, args } = parsed;
  const joined = args.join(' ');
  const senderMention = formatRequestedBy(from);

  switch (name) {
    case 'menu':
      await sendChannelImage(session, chatId, '.menu', buildMenuText(getStored(session)?.prefix || DEFAULT_PREFIX));
      return;

    case 'ping': {
      const started = Date.now();
      const remote = await getSession(session);
      const ms = Date.now() - started;
      await genericStatus(session, chatId, 'ping', [
        `🟢 Status : ${remote?.status || 'WORKING'}`,
        `⚡ Speed : ${ms} ms`,
        `👤 Requested by : ${senderMention}`
      ], { imageKey: '.menu', title: '⚡ 𝐏𝐈𝐍𝐆' });
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
      const gate = await assertGroupAdmin(session, chatId, from);
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
      const gate = await assertGroupAdmin(session, chatId, from);
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
      const gate = await assertGroupAdmin(session, chatId, from);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      const target = targetFromPayload(payload, args);
      if (!target) return sendText(session, chatId, `❌ Mention the user: .${name} @user`);
      if (name === 'kick') await removeParticipants(session, chatId, [target]);
      else if (name === 'promote') await promoteParticipants(session, chatId, [target]);
      else await demoteParticipants(session, chatId, [target]);
      await genericStatus(session, chatId, name, [`✅ Status : 𝐒𝐔𝐂𝐂𝐄𝐒𝐒`, `👤 Target : @${jidNumber(target)}`, `🛠️ Action : ${name.toUpperCase()}`], { title: `👥 ${name.toUpperCase()}` });
      return;
    }

    case 'add': {
      const gate = await assertGroupAdmin(session, chatId, from);
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
      const gate = await assertGroupAdmin(session, chatId, from);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      if (String(args[0]).toLowerCase() !== 'confirm') {
        return genericStatus(session, chatId, name, ['⚠️ This removes every non-admin member.', 'Use `.kickall confirm` to continue.'], { title: '⚠️ 𝐊𝐈𝐂𝐊 𝐀𝐋𝐋' });
      }
      const participants = gate.participants;
      const targets = participants.filter((p) => {
        const role = participantRole(p);
        return !['admin','superadmin','administrator'].includes(role) && !p?.isAdmin && !p?.isSuperAdmin;
      }).map(participantJid).filter(Boolean);
      if (targets.length) await removeParticipants(session, chatId, targets);
      await genericStatus(session, chatId, name, [`✅ Removed : ${targets.length} members.`], { title: '⚠️ 𝐊𝐈𝐂𝐊 𝐀𝐋𝐋' });
      return;
    }

    case 'tagall': {
      const gate = await assertGroupAdmin(session, chatId, from);
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
      const gate = await assertGroupAdmin(session, chatId, from);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      await sendText(session, chatId, joined || '🌸 Orihime MD', { mentions: ['all'] });
      await genericStatus(session, chatId, name, ['✅ Status : 𝐒𝐄𝐍𝐓', '👥 Everyone was mentioned invisibly.'], { title: '👥 𝐇𝐈𝐃𝐄𝐓𝐀𝐆' });
      return;
    }

    case 'invite': {
      const gate = await assertGroupAdmin(session, chatId, from);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      const invite = await getInviteCode(session, chatId);
      const code = invite?.code || invite?.inviteCode || invite;
      await genericStatus(session, chatId, name, [`🔗 Invite : ${code || 'Unavailable'}`], { title: '🔗 𝐈𝐍𝐕𝐈𝐓𝐄' });
      return;
    }

    case 'left': {
      const gate = await assertGroupAdmin(session, chatId, from);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      const action = String(args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(action)) {
        return genericStatus(session, chatId, name, ['⚠️ Usage : .left on', '⚠️ Usage : .left off'], { title: '👋 𝐋𝐄𝐅𝐓 𝐀𝐋𝐄𝐑𝐓' });
      }
      await setGroup(chatId, { left: action === 'on' });
      await genericStatus(session, chatId, name, [
        `✅ Status : ${action === 'on' ? '𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃' : '𝐃𝐄𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃'}`,
        `👋 Goodbye alerts : ${action.toUpperCase()}`,
        `👤 Requested by : ${senderMention}`
      ], { imageKey: action === 'on' ? '.left' : '.left off', title: '👋 𝐋𝐄𝐅𝐓 𝐀𝐋𝐄𝐑𝐓' });
      return;
    }

    case 'leave': {
      const gate = await assertGroupAdmin(session, chatId, from);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      await genericStatus(session, chatId, name, ['👋 Status : 𝐋𝐄𝐀𝐕𝐈𝐍𝐆 𝐆𝐑𝐎𝐔𝐏'], { title: '👋 𝐋𝐄𝐀𝐕𝐄' });
      await leaveGroup(session, chatId);
      return;
    }


    case 'welcome': {
      const gate = await assertGroupAdmin(session, chatId, from);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      const action = String(args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(action)) {
        return genericStatus(session, chatId, name, ['⚠️ Usage : .welcome on', '⚠️ Usage : .welcome off'], { title: '🌸 𝐖𝐄𝐋𝐂𝐎𝐌𝐄' });
      }
      await setGroup(chatId, { welcome: action === 'on' });
      await genericStatus(session, chatId, name, [
        `✅ Status : ${action === 'on' ? '𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃' : '𝐃𝐄𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃'}`,
        `🌸 Welcome messages : ${action.toUpperCase()}`,
        `🖼️ Image key : .welcom`,
        `👤 Requested by : ${senderMention}`
      ], { imageKey: '.welcom', title: '🌸 𝐖𝐄𝐋𝐂𝐎𝐌𝐄' });
      return;
    }

    case 'autod': {
      const gate = await assertGroupAdmin(session, chatId, from);
      if (!gate.ok) return sendText(session, chatId, gate.message);
      const target = targetFromPayload(payload, args);
      if (!target) return sendText(session, chatId, `❌ Mention the user: .autod @user`);
      const config = getGroup(chatId);
      const users = new Set(Array.isArray(config.autoDeleteUsers) ? config.autoDeleteUsers : []);
      users.add(target);
      await setGroup(chatId, { autoDeleteUsers: [...users] });
      await genericStatus(session, chatId, name, [
        '🗑️ Status : 𝐀𝐔𝐓𝐎 𝐃𝐄𝐋𝐄𝐓𝐄 𝐀𝐂𝐓𝐈𝐕𝐀𝐓𝐄𝐃',
        `👤 Target : @${jidNumber(target)}`,
        '⚡ New messages from this user will be deleted when detected.'
      ], { title: '🗑️ 𝐀𝐔𝐓𝐎 𝐃𝐄𝐋𝐄𝐓𝐄' });
      return;
    }

    case 'announcement': {
      const gate = await assertGroupAdmin(session, chatId, from);
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
      const gate = await assertGroupAdmin(session, chatId, from);
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

    case 'group-id': {
      const gate = await assertGroupAdmin(session, chatId, from);
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
    if (id) { try { await deleteMessage(session, chatId, id); } catch {} }
    return;
  }

  if (config.antichannel) {
    const directChannel = String(payload?.from || '').endsWith('@newsletter') || String(payload?._data?.Info?.Chat || '').endsWith('@newsletter');
    const quotedChannel = JSON.stringify(payload?._data || {}).includes('@newsletter');
    if (directChannel || quotedChannel) {
      const id = payload?.id || payload?.messageId;
      if (id) { try { await deleteMessage(session, chatId, id); } catch {} }
    }
  }

  if (config.antibot && ANTIBOT_JIDS.has(senderJid)) {
    const id = payload?.id || payload?.messageId;
    if (id) { try { await deleteMessage(session, chatId, id); } catch {} }
    if (ANTIBOT_KICK) {
      try { await removeParticipants(session, chatId, [senderJid]); } catch {}
    }
  }

  if (config.killSale && SALE_KEYWORD_REGEX.test(String(body || ''))) {
    // Admin posts are exempt — only members' sale/price/availability chatter gets nuked.
    const senderIsAdmin = await isSenderGroupAdmin(session, chatId, senderJid);
    if (!senderIsAdmin) {
      const id = payload?.id || payload?.messageId;
      if (id) { try { await deleteMessage(session, chatId, id); } catch {} }
    }
  }
}
