import {
  sendText,
  sendPoll,
  editMessage,
  createGroup,
  getGroup,
  getGroups,
  getGroupPicture,
  setGroupPicture,
  setGroupSubject,
  setGroupDescription,
  addParticipants,
  promoteParticipants,
  getGroupSecurity,
  setGroupSecurity,
  setGroupMessagesAdminOnly
} from './waha.js';
import { getState, persistState } from './store.js';
import { askGemini, geminiConfigured } from './gemini.js';
import { jidFromValue, normalizeJid, parseParticipant } from './participants.js';
import { readCommandMedia } from './commandMedia.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------- Jokes ------------------------------------
export const EXTRA_JOKES = [
  'I asked the Wi-Fi for a password. It said: “Sorry, we are not connected.” 📶😂',
  'Why did the keyboard break up with the mouse? It felt there were too many clicks. ⌨️😂',
  'My password is “incorrect”. Now whenever I forget it, the computer tells me what it is. 🤣',
  'Why did the developer go broke? Because he used up all his cache. 💸💻',
  'I told my phone I needed space. It opened the settings page. 📱🚀',
  'Why was the computer cold? It left its Windows open. 🪟🥶',
  'The bot wanted a vacation, but it had too many commits. 🤖🏝️',
  'Why did the server blush? Someone pinged it at 2 AM. 🖥️😳',
  'I tried to catch some fog yesterday. I mist. 🌫️😂',
  'Why did the tomato turn red? It saw the salad dressing. 🍅😂',
  'What do you call fake spaghetti? An impasta. 🍝🤣',
  'Why did the bicycle fall over? It was two-tired. 🚲😂',
  'Why don’t eggs tell jokes? They might crack each other up. 🥚🤣',
  'What did one wall say to the other? “I’ll meet you at the corner.” 🧱😂',
  'Why did the math book look sad? It had too many problems. 📚😂',
  'I asked the bot to sing. It said it only knows infinite loops. 🎵🤖',
  'Why did the emoji go to school? It wanted to improve its expressions. 😎📚',
  'A programmer’s favorite place to relax? The cache-cabana. 💻🏖️',
  'Why did the update refuse to arrive? It was still installing its confidence. 🔄😂',
  'The group admin said “be quiet.” The bot replied “mute mode activated.” 🤫🤖'
];

// -------------------------- Dance engine -----------------------------
const ANIMATION_CHARSET = `*"::!!?'-_/()+@#$~\`|•√π÷×§∆¢¢¥^°={}\\£%©®™✓[]1235467890`;
const DANCE_FRAME_MS = Math.max(90, Number(process.env.DANCE_FRAME_MS || 130));
const MAX_ANIMATION_FRAMES = Math.max(4, Math.min(60, Number(process.env.MAX_ANIMATION_FRAMES || 24)));
// Safety net for the now-continuous loop below: if nobody sends another
// message or runs .prefix-d stop, this is the outer bound on how long one
// animation can keep editing a message and consuming WAHA calls.
const DANCE_MAX_DURATION_MS = Math.max(30000, Number(process.env.DANCE_MAX_DURATION_MS || 10 * 60 * 1000));
const DANCES = new Map(); // `${session}:${chat}` -> { stop, messageId }
const GENERATED_MESSAGE_IDS = new Set();

function symbolAt(i) {
  return ANIMATION_CHARSET[Math.abs(i) % ANIMATION_CHARSET.length];
}

function markGeneratedMessage(id) {
  if (!id) return;
  GENERATED_MESSAGE_IDS.add(String(id));
  if (GENERATED_MESSAGE_IDS.size > 300) {
    const first = GENERATED_MESSAGE_IDS.values().next().value;
    if (first) GENERATED_MESSAGE_IDS.delete(first);
  }
}

export function isDanceGeneratedMessage(id) {
  return Boolean(id && GENERATED_MESSAGE_IDS.has(String(id)));
}

function personFrame(type, frame) {
  // The accent symbols change every 2 frames instead of every single frame.
  // At full rate, EVERY character was changing EVERY frame — including the
  // ones filling most of each frame's body/torso area — which drowns out
  // the actual limb motion (which only cycles every 8 frames via `f` below)
  // and is exactly why this read as random flicker rather than a dance.
  const s = (n) => symbolAt(Math.floor(frame / 2) * 7 + n);
  const f = ((frame % 8) + 8) % 8;
  const arm = type === 'ninja' ? ['\\', '/', '>', '<'][f % 4] : ['/', '\\', '—', '\\', '/', '—', '\\', '/'][f];
  const arm2 = type === 'ninja' ? ['/', '\\', '<', '>'][f % 4] : ['\\', '/', '—', '/', '\\', '—', '/', '\\'][f];
  const leg = ['/', '\\', '/', '\\', '/', '\\', '/', '\\'][f];
  const leg2 = ['\\', '/', '\\', '/', '\\', '/', '\\', '/'][f];
  const hipShift = f % 2 ? '  ' : '';
  const spin = f % 3 === 0 ? `${s(2)}${s(4)}` : `${s(4)}${s(2)}`;
  if (type === 'ninja') {
    return [
      `          ${s(1)}${s(1)}${s(1)}`,
      `         ${s(5)}${s(2)}${s(5)}`,
      `      ${arm} ${s(7)}${s(0)}${s(7)} ${arm2}`,
      `       ${s(3)}${s(1)}${s(3)}${s(1)}${s(3)}`,
      `      ${leg}${s(5)}${s(5)}${s(5)}${leg2}`,
      `    ${leg2}   ${s(8)}   ${leg}`,
      `      ${s(1)}${s(2)}${s(3)} ${spin}`,
      `  ${s(0)}${s(4)}${s(0)}${s(4)}${s(0)}${s(4)}${s(0)}${s(4)}${s(0)}`
    ].join('\n');
  }
  if (type === 'robot') {
    const shoulder = f % 2 ? `<>` : `><`;
    return [
      `          ${s(1)}${s(1)}${s(1)}${s(1)}`,
      `          ${s(3)}${s(7)}${s(7)}${s(5)}`,
      `       ${shoulder}${s(0)}${s(4)}${s(2)}${s(0)}${s(4)}${s(2)}${shoulder}`,
      `       [${s(6)}${s(1)}${s(8)}${s(1)}${s(6)}]`,
      `       |${s(2)}${s(4)}${s(2)}${s(4)}${s(2)}|`,
      `       |${s(5)}${s(0)}${s(5)}${s(0)}${s(5)}|`,
      `        ${leg}${s(4)}${s(4)}${s(4)}${leg2}`,
      `       ${leg2} ${s(8)} ${leg}`
    ].join('\n');
  }
  if (type === 'breakdance') {
    return [
      `        ${s(1)}${s(1)}${s(1)}`,
      `       ${s(5)}${s(2)}${s(5)}${s(7)}`,
      `     ${arm}==${s(0)}${s(2)}${s(4)}==${arm2}`,
      `       ${s(3)}${s(1)}${s(8)}${s(6)}${s(3)}`,
      `      ${arm2} ${s(7)}${s(0)} ${arm}`,
      `   ${leg2}   ${s(6)} ${s(3)}   ${leg}`,
      `  ${s(0)}${s(4)}${s(0)}${s(4)}${s(0)}${s(4)}${s(0)}${s(4)}${s(0)}`
    ].join('\n');
  }
  // woman dancing
  const head = f % 4 === 0 ? '  ' : '';
  return [
    `${head}        ${s(1)}${s(1)}${s(1)}`,
    `${head}       ${s(5)}${s(2)}${s(5)}`,
    `${arm}     ${s(7)}${s(0)}${s(7)}     ${arm2}`,
    `        ${s(3)}${s(1)}${s(3)}${s(1)}${s(3)}`,
    `       /${s(5)}${s(4)}${s(5)}\\`,
    `      ${leg} ${s(0)}${s(2)} ${leg2}`,
    `     ${leg2}  ${s(6)}  ${leg}`,
    `   ${s(0)}${s(4)}${s(0)}${s(4)}${s(0)}${s(4)}${s(0)}${s(4)}${s(0)}`
  ].join('\n');
}

function builtInDanceFrames(kind) {
  const key = String(kind || '').toLowerCase().replace(/\s+/g, '-');
  const aliases = {
    'woman': 'woman-dancing', 'woman-dance': 'woman-dancing', 'dancing-woman': 'woman-dancing',
    'ninja': 'ninja-fighting', 'ninja-fight': 'ninja-fighting',
    'robot': 'robot-dancing', 'break': 'breakdance', 'break-dance': 'breakdance'
  };
  const name = aliases[key] || key;
  if (!['woman-dancing', 'ninja-fighting', 'robot-dancing', 'breakdance'].includes(name)) return null;
  const type = name === 'ninja-fighting' ? 'ninja' : name === 'robot-dancing' ? 'robot' : name === 'breakdance' ? 'breakdance' : 'woman';
  return { name, frames: Array.from({ length: 16 }, (_, i) => personFrame(type, i)) };
}

export function listAnimations() {
  const custom = getState().animations || {};
  return [
    { key: 'woman-dancing', label: 'Woman dancing' },
    { key: 'ninja-fighting', label: 'Ninja fighting' },
    { key: 'robot-dancing', label: 'Robot dancing' },
    { key: 'breakdance', label: 'Breakdance' },
    ...Object.values(custom).map((a) => ({ key: a.key, label: a.label || a.key }))
  ];
}

export async function addGeneratedAnimation(description) {
  if (!geminiConfigured()) throw new Error('GEMINI_API_KEY is not configured.');
  const clean = String(description || '').trim().slice(0, 500);
  if (!clean) throw new Error('Give a description, e.g. .prefix-d add samurai waving.');
  const prompt = `Create a compact text-animation for a WhatsApp terminal-style bot. User wants: ${clean}
Return ONLY valid JSON with this shape: {"label":"...","frames":["frame1","frame2", ...]}
Rules: 8-18 frames, each frame under 700 characters, monospaced ASCII/sign art only, use punctuation/symbol characters rather than emoji, keep the subject centered, and make frame-to-frame placement changes obvious. Do not use markdown fences.`;
  const answer = await askGemini(prompt);
  const match = answer.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Gemini did not return the animation JSON.');
  const parsed = JSON.parse(match[0]);
  const frames = Array.isArray(parsed.frames)
    ? parsed.frames.map((x) => String(x || '')).filter(Boolean).slice(0, MAX_ANIMATION_FRAMES)
    : [];
  if (frames.length < 4) throw new Error('The generated animation needs at least 4 frames.');
  const key = `custom-${Date.now().toString(36)}`;
  const record = { key, label: String(parsed.label || clean).slice(0, 80), description: clean, frames };
  const state = getState();
  state.animations ||= {};
  state.animations[key] = record;
  await persistState();
  return record;
}

export function getAnimation(key) {
  const built = builtInDanceFrames(key);
  if (built) return built;
  return getState().animations?.[key] || getState().animations?.[String(key || '').toLowerCase()];
}

export function stopDanceForChat(session, chatId) {
  const key = `${session}:${chatId}`;
  const current = DANCES.get(key);
  if (current) {
    current.stop = true;
    DANCES.delete(key);
  }
}

async function runDanceLoop(session, chatId, animation, control) {
  const frames = animation.frames.slice(0, MAX_ANIMATION_FRAMES);
  const mapKey = `${session}:${chatId}`;
  try {
    // Loop the frame sequence continuously (wrap back to frame 0) instead of
    // running through it once and stopping — a "for i < frames.length" loop
    // is exactly why this used to play once and then just... stop, needing
    // another command to restart it. It now only ever stops via
    // stopDanceForChat (an explicit .prefix-d stop, or the next real message
    // in the chat — see bot.js).
    let i = 1;
    const startedAt = Date.now();
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, DANCE_FRAME_MS));
      if (control.stop || DANCES.get(mapKey) !== control) break;
      if (Date.now() - startedAt > DANCE_MAX_DURATION_MS) {
        try { await sendText(session, chatId, '💃 Animation auto-stopped after running a while — .prefix-d again to restart it.'); } catch {}
        break;
      }
      if (control.messageId) {
        try {
          await editMessage(session, chatId, control.messageId, `\`\`\`\n${frames[i % frames.length]}\n\`\`\``);
        } catch (error) {
          console.error('[dance] edit failed:', error?.response?.data || error?.message || error);
          break;
        }
      }
      i += 1;
    }
  } finally {
    if (DANCES.get(mapKey) === control) DANCES.delete(mapKey);
  }
}

export async function startDance(session, chatId, key) {
  stopDanceForChat(session, chatId);
  const animation = getAnimation(key);
  if (!animation) throw new Error(`Unknown animation "${key}". Use .prefix-d list.`);
  const frames = animation.frames.slice(0, MAX_ANIMATION_FRAMES);
  const control = { stop: false, messageId: null };
  const mapKey = `${session}:${chatId}`;
  DANCES.set(mapKey, control);

  try {
    const sent = await sendText(session, chatId, `\`\`\`\n${frames[0]}\n\`\`\``);
    control.messageId = sent?.id || sent?.messageId || sent?.data?.id || null;
    markGeneratedMessage(control.messageId);
    // Do not await the animation. The next incoming message must be able to
    // reach stopDanceForChat immediately instead of waiting behind a long
    // per-chat command queue.
    void runDanceLoop(session, chatId, animation, control);
    return { key: animation.key || key, frames: frames.length, messageId: control.messageId };
  } catch (error) {
    if (DANCES.get(mapKey) === control) DANCES.delete(mapKey);
    throw error;
  }
}

// -------------------------- Scheduled close/open ---------------------
const TIMERS = new Map();
function parseDelay(input, now = Date.now()) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return now;
  if (/^\d+(\.\d+)?ms$/.test(raw)) return now + Number(raw.slice(0, -2));
  const match = raw.match(/^(\d+(?:\.\d+)?)(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const mult = /^s/.test(unit) ? 1000 : /^m/.test(unit) ? 60000 : /^h/.test(unit) ? 3600000 : 86400000;
    return now + amount * mult;
  }
  const clock = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) {
    const d = new Date(now);
    d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

function formatDue(at) { return new Date(at).toLocaleString(); }

export function cancelScheduledGroupAction(session, chatId) {
  const key = `${session}:${chatId}`;
  const timer = TIMERS.get(key);
  if (timer) clearTimeout(timer);
  TIMERS.delete(key);
}

export async function scheduleGroupAction(session, chatId, action, whenInput) {
  cancelScheduledGroupAction(session, chatId);
  const at = parseDelay(whenInput);
  if (at === null) throw new Error('Time format not understood. Use 30s, 10m, 2h, 1d or HH:MM.');
  if (at <= Date.now()) {
    await setGroupMessagesAdminOnly(session, chatId, action === 'close');
    return { immediate: true, at: Date.now(), action };
  }
  const record = { action, at, createdAt: Date.now() };
  const timer = setTimeout(async () => {
    try {
      await setGroupMessagesAdminOnly(session, chatId, action === 'close');
      await sendText(session, chatId, action === 'close'
        ? `🔒 Scheduled close executed at ${formatDue(at)}.`
        : `🔓 Scheduled open executed at ${formatDue(at)}.`);
    } catch (error) {
      console.error('[schedule] action failed:', error?.response?.data || error?.message || error);
    } finally {
      TIMERS.delete(`${session}:${chatId}`);
      try { const state = getState(); const key = `${session}::${chatId}`; if (state.groups?.[key]) { delete state.groups[key].scheduledGroupAction; await persistState(); } } catch {}
    }
  }, Math.max(1, at - Date.now()));
  timer.unref?.();
  TIMERS.set(`${session}:${chatId}`, timer);
  const state = getState();
  state.groups ||= {};
  const key = `${session}::${chatId}`;
  state.groups[key] = { ...(state.groups[key] || { groupId: chatId, session }), scheduledGroupAction: record };
  await persistState();
  return { immediate: false, ...record, when: formatDue(at) };
}

export async function restoreScheduledGroupActions() {
  const groups = getState().groups || {};
  for (const record of Object.values(groups)) {
    const action = record?.scheduledGroupAction;
    if (!action?.at || !action?.action || !record.session || !record.groupId) continue;
    if (action.at <= Date.now()) {
      try { await setGroupMessagesAdminOnly(record.session, record.groupId, action.action === 'close'); } catch {}
      try { delete record.scheduledGroupAction; } catch {}
      continue;
    }
    await scheduleGroupAction(record.session, record.groupId, action.action, `${Math.max(1, action.at - Date.now())}ms`).catch((e) => console.error('[schedule] restore failed:', e?.message || e));
  }
  await persistState();
}

// -------------------------- Candy Crush ------------------------------
const CANDY = ['🍬', '🍭', '🍫', '🍓', '🍡'];
const CANDY_SESSIONS = new Map();
const CANDY_POLLS = new Map();
function candyKey(session, chatId, user) { return `${session}:${chatId}:${user || 'any'}`; }
function hasMatch(board, r, c) {
  const v = board[r][c];
  if (!v) return false;
  let n = 1;
  for (let x = c - 1; x >= 0 && board[r][x] === v; x--) n++;
  for (let x = c + 1; x < board[r].length && board[r][x] === v; x++) n++;
  if (n >= 3) return true;
  n = 1;
  for (let y = r - 1; y >= 0 && board[y][c] === v; y--) n++;
  for (let y = r + 1; y < board.length && board[y][c] === v; y++) n++;
  return n >= 3;
}
function boardHasMatch(board) {
  for (let r = 0; r < board.length; r++) for (let c = 0; c < board[r].length; c++) if (hasMatch(board, r, c)) return true;
  return false;
}
function randomCandy(except = '') {
  const values = CANDY.filter((x) => x !== except);
  return values[Math.floor(Math.random() * values.length)];
}
function newCandyBoard(size = 6) {
  const board = Array.from({ length: size }, () => Array(size).fill(''));
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const left = c >= 2 ? board[r][c - 1] === board[r][c - 2] : false;
    const up = r >= 2 ? board[r - 1][c] === board[r - 2][c] : false;
    board[r][c] = randomCandy(left ? board[r][c - 1] : up ? board[r - 1][c] : '');
  }
  return board;
}
function cloneBoard(b) { return b.map((r) => [...r]); }
function swapCells(board, a, b) {
  const copy = cloneBoard(board);
  [copy[a.r][a.c], copy[b.r][b.c]] = [copy[b.r][b.c], copy[a.r][a.c]];
  return copy;
}
function clearMatches(board) {
  const dead = new Set();
  for (let r = 0; r < board.length; r++) {
    let c = 0;
    while (c < board[r].length) {
      let end = c + 1;
      while (end < board[r].length && board[r][end] === board[r][c]) end++;
      if (end - c >= 3) for (let x = c; x < end; x++) dead.add(`${r}:${x}`);
      c = end;
    }
  }
  for (let c = 0; c < board[0].length; c++) {
    let r = 0;
    while (r < board.length) {
      let end = r + 1;
      while (end < board.length && board[end][c] === board[r][c]) end++;
      if (end - r >= 3) for (let y = r; y < end; y++) dead.add(`${y}:${c}`);
      r = end;
    }
  }
  if (!dead.size) return 0;
  for (const key of dead) { const [r,c] = key.split(':').map(Number); board[r][c] = ''; }
  for (let c = 0; c < board[0].length; c++) {
    const stack = [];
    for (let r = board.length - 1; r >= 0; r--) if (board[r][c]) stack.push(board[r][c]);
    for (let r = board.length - 1, i = 0; r >= 0; r--, i++) board[r][c] = stack[i] || CANDY[Math.floor(Math.random() * CANDY.length)];
  }
  return dead.size;
}
function firstValidSwap(board) {
  for (let r = 0; r < board.length; r++) for (let c = 0; c < board[r].length; c++) {
    for (const [dr, dc] of [[0,1],[1,0]]) {
      const nr = r + dr, nc = c + dc;
      if (nr >= board.length || nc >= board.length) continue;
      const test = swapCells(board, {r,c}, {r:nr,c:nc});
      if (boardHasMatch(test)) return [{r,c}, {r:nr,c:nc}];
    }
  }
  return null;
}

export function renderCandy(game) {
  return [
    '╭────── 🍭 CANDY CRUSH ──────╮',
    ...game.board.map((row, r) => `│ ${row.map((x, c) => (r === game.cursor.r && c === game.cursor.c ? `[${x}]` : ` ${x} `)).join('')} │`),
    `╰──── Score: ${game.score} • Moves: ${game.moves} ────╯`,
    '🎮 Controller: ⬅️ ➡️ ⬆️ ⬇️  • 🍬 Auto Swap • 🛑 Stop',
    '⌨️ Or type: .candycrush left/right/up/down | .candycrush swap left'
  ].join('\n');
}

export async function startCandyGame(session, chatId, user) {
  const board = newCandyBoard();
  const key = candyKey(session, chatId, user);
  const game = { board, cursor: { r: 2, c: 2 }, score: 0, moves: 0 };
  CANDY_SESSIONS.set(key, game);
  const firstBoard = await sendText(session, chatId, renderCandy(game));
  game.messageId = firstBoard?.id || firstBoard?.messageId || firstBoard?.data?.id || null;
  const poll = await sendPoll(session, chatId, {
    poll: { name: '🍭 Candy Crush controller', options: ['⬅️ Left', '➡️ Right', '⬆️ Up', '⬇️ Down', '🍬 Auto Swap', '🛑 Stop'], multipleAnswers: false }
  });
  const pollId = poll?.id || poll?.messageId || poll?.data?.id;
  if (pollId) {
    CANDY_POLLS.set(String(pollId), { session, chatId, user, createdAt: Date.now() });
    if (CANDY_POLLS.size > 100) CANDY_POLLS.delete(CANDY_POLLS.keys().next().value);
  }
  return { game, poll, pollId };
}

function findGame(session, chatId, user) {
  return CANDY_SESSIONS.get(candyKey(session, chatId, user)) || CANDY_SESSIONS.get(candyKey(session, chatId, 'any'));
}

export function stopCandyGame(session, chatId, user) {
  const key = candyKey(session, chatId, user);
  CANDY_SESSIONS.delete(key);
  CANDY_SESSIONS.delete(candyKey(session, chatId, 'any'));
}

async function applyCandyAction(session, chatId, user, action) {
  const game = findGame(session, chatId, user);
  if (!game) return sendText(session, chatId, '🎮 No Candy Crush game is running. Type .candycrush to start one.');
  const key = String(action || '').toLowerCase();
  if (key === 'stop') { stopCandyGame(session, chatId, user); return sendText(session, chatId, '🛑 Candy Crush stopped.'); }
  const direction = key.replace(/[^a-z]/g, '');
  if (['left','right','up','down'].includes(direction)) {
    if (direction === 'left') game.cursor.c = Math.max(0, game.cursor.c - 1);
    if (direction === 'right') game.cursor.c = Math.min(game.board.length - 1, game.cursor.c + 1);
    if (direction === 'up') game.cursor.r = Math.max(0, game.cursor.r - 1);
    if (direction === 'down') game.cursor.r = Math.min(game.board.length - 1, game.cursor.r + 1);
    game.moves++;
    return updateCandyBoard(session, chatId, game);
  }
  if (key === 'auto-swap' || key === 'swap' || key === 'crush') {
    const pair = firstValidSwap(game.board);
    if (!pair) return sendText(session, chatId, '🍬 No valid match found. Move around and try again.');
    game.board = swapCells(game.board, pair[0], pair[1]);
    const cleared = clearMatches(game.board);
    game.score += cleared * 10;
    game.moves++;
    return updateCandyBoard(session, chatId, game);
  }
}

async function updateCandyBoard(session, chatId, game) {
  const text = renderCandy(game);
  if (game?.messageId) {
    try { return await editMessage(session, chatId, game.messageId, text); } catch {}
  }
  const sent = await sendText(session, chatId, text);
  game.messageId = sent?.id || sent?.messageId || sent?.data?.id || game.messageId || null;
  return sent;
}

export async function handleCandyText(session, chatId, user, args) {
  const first = String(args?.[0] || '').toLowerCase();
  if (first === 'swap') return applyCandyAction(session, chatId, user, args[1] || 'auto-swap');
  return applyCandyAction(session, chatId, user, first);
}

export async function handleCandyPoll(session, chatId, user, selected) {
  const map = { '⬅️ Left': 'left', '➡️ Right': 'right', '⬆️ Up': 'up', '⬇️ Down': 'down', '🍬 Auto Swap': 'auto-swap', '🛑 Stop': 'stop' };
  return applyCandyAction(session, chatId, user, map[selected] || selected);
}

export async function handleCandyPollVote(session, payload) {
  const pollId = payload?.poll?.id || payload?._data?.poll?.id;
  const record = CANDY_POLLS.get(String(pollId || ''));
  if (!record || record.session !== session) return false;
  const selected = payload?.vote?.selectedOptions?.[0] || '';
  const user = normalizeJid(payload?.vote?.from || '') || record.user;
  if (selected) await handleCandyPoll(session, record.chatId, user, selected);
  return true;
}

// -------------------------- Language substitution -------------------
const BUILTIN_LANGUAGES = {
  china: {
    label: 'Chinese-style',
    chars: '阿波次德鹅佛格哈伊吉卡乐米讷哦佩去若斯特乌维西亚泽啊'
  },
  japanese: {
    label: 'Japanese-style',
    chars: 'アイウエオカキクケコサシスセソタチツテトナニヌネノハ'
  },
  korea: {
    label: 'Korean-style',
    chars: '가나다라마바사아자차카타파하거너더러머버서어저주추쿠'
  }
};

function normalizeLanguageKey(name) { return String(name || '').trim().toLowerCase().replace(/\s+/g, '-'); }

export function languageList() {
  const custom = Object.values(getState().customLanguages || {});
  return [...Object.entries(BUILTIN_LANGUAGES).map(([key, v]) => ({ key, label: v.label })), ...custom.map((v) => ({ key: v.key, label: v.label }))];
}

export function getLanguageMap(key) {
  const normalized = normalizeLanguageKey(key);
  const builtin = BUILTIN_LANGUAGES[normalized];
  const custom = getState().customLanguages?.[normalized];
  return builtin?.chars || custom?.chars || '';
}

export function setUserLanguage(session, chatId, senderJid, language) {
  const state = getState();
  state.languageModes ||= {};
  state.languageModes[session] ||= {};
  state.languageModes[session][chatId] ||= {};
  const key = normalizeLanguageKey(language);
  if (!key) delete state.languageModes[session][chatId][normalizeJid(senderJid)];
  else state.languageModes[session][chatId][normalizeJid(senderJid)] = key;
  return persistState();
}

export function getUserLanguage(session, chatId, senderJid) {
  return getState().languageModes?.[session]?.[chatId]?.[normalizeJid(senderJid)] || '';
}

export async function addLanguage(name, chars) {
  const key = normalizeLanguageKey(name);
  if (!key) throw new Error('Language name is required.');
  const clean = Array.from(String(chars || '').trim());
  if (clean.length !== 25 && clean.length !== 26) throw new Error('Provide 25 or 26 replacement characters.');
  const state = getState();
  state.customLanguages ||= {};
  state.customLanguages[key] = { key, label: String(name).trim().slice(0, 60), chars: clean.join(''), createdAt: Date.now() };
  await persistState();
  return state.customLanguages[key];
}

export function mapEnglishAlphabet(text, chars) {
  const map = Array.from(chars || '');
  return String(text || '').replace(/[A-Za-z]/g, (letter) => {
    const index = letter.toLowerCase().charCodeAt(0) - 97;
    const value = map[index] || letter;
    return letter === letter.toUpperCase() ? value : value;
  });
}

// -------------------------- Bot-message detector --------------------
const BOT_WORDS = ['bot', 'menu', 'commands', 'prefix', 'owner', 'version', 'runtime', 'uptime', 'powered by', 'features', 'help', 'developer', 'status', 'pairing', 'sticker', 'download'];
const MENU_SHAPES = ['╭', '╮', '╰', '╯', '┏', '┓', '┗', '┛', '┃', '│', '─', '━', '❯', '⟡', '『', '』', '「', '」', '╔', '╗', '╚', '╝', '║', '═'];
const BOT_FINGERPRINTS = new Map();
const BOT_FINGERPRINT_TTL_MS = Math.max(60_000, Number(process.env.ANTIBOT_FINGERPRINT_TTL_MS || 15 * 60 * 1000));

function responseShapeFingerprint(text) {
  const value = String(text || '').trim();
  const lines = value.split('\n').filter(Boolean);
  const shapeChars = MENU_SHAPES.filter((c) => value.includes(c)).length;
  const commands = lines.filter((line) => /(^|\s)[.!#$\\/()[\]{}:+_-][a-z0-9][\w-]*/i.test(line)).length;
  const hasBox = /[╭╮╰╯┏┓┗┛┃│─━╔╗╚╝║═]/.test(value);
  const hasMeta = /(powered by|owner|developer|version|runtime|uptime|prefix|commands|pairing)/i.test(value);
  const symbolRatio = (value.match(/[.!#$%&*+\-/?:=[\]{}()<>]/g) || []).length / Math.max(1, value.length);
  return [Math.min(12, lines.length), Math.min(14, shapeChars), commands >= 2 ? 'cmds' : 'nocmds', hasBox ? 'box' : 'nobox', hasMeta ? 'meta' : 'nometa', symbolRatio > 0.13 ? 'symbols' : 'plain'].join('|');
}

function rememberFingerprint(context, fingerprint, score) {
  if (!context?.session || !context?.chatId || !context?.senderJid || !fingerprint) return null;
  const sender = normalizeJid(context.senderJid);
  if (!sender) return null;
  const key = `${context.session}:${context.chatId}:${sender}`;
  const now = Date.now();
  const previous = BOT_FINGERPRINTS.get(key);
  const profile = previous && now - previous.lastAt < BOT_FINGERPRINT_TTL_MS
    ? previous
    : { counts: new Map(), messageCount: 0, lastAt: now, maxScore: 0 };
  profile.messageCount += 1;
  profile.lastAt = now;
  profile.maxScore = Math.max(profile.maxScore, score);
  profile.counts.set(fingerprint, Number(profile.counts.get(fingerprint) || 0) + 1);
  BOT_FINGERPRINTS.set(key, profile);
  while (BOT_FINGERPRINTS.size > 1000) BOT_FINGERPRINTS.delete(BOT_FINGERPRINTS.keys().next().value);
  return {
    repeatedShape: Number(profile.counts.get(fingerprint) || 0),
    senderMessages: profile.messageCount
  };
}

export function detectBotLikeMessage(payload, body, context = {}) {
  const text = String(body || payload?.caption || payload?.media?.caption || '').trim();
  const raw = JSON.stringify(payload?._data || {});
  let score = 0;
  const reasons = [];
  const push = (n, reason) => { score += n; reasons.push(reason); };

  if (payload?.fromMe) return { score: 0, reasons: ['from-me'], knownBot: false };

  const notify = String(payload?.notifyName || payload?._data?.Info?.PushName || '').toLowerCase();
  if (/(^|[._ -])(bot|assistant|autobot|auto-reply|chatbot|wa-bot|md)([._ -]|$)/i.test(notify) || notify.includes('bot')) push(8, 'sender-name-bot');
  if (/\b(bot|assistant|automation|auto-reply|auto reply|chatbot)\b/i.test(text)) push(5, 'bot-word');

  const lower = text.toLowerCase();
  const botHits = BOT_WORDS.filter((word) => lower.includes(word)).length;
  if (botHits >= 2) push(Math.min(10, botHits * 2), `bot-vocabulary:${botHits}`);

  const shapeHits = MENU_SHAPES.filter((c) => text.includes(c)).length;
  if (shapeHits >= 5) push(Math.min(10, shapeHits), `menu-shape:${shapeHits}`);

  const lines = text.split('\n').filter(Boolean);
  const commandLines = lines.filter((line) => /(^|\s)[.!#$\\/()[\]{}:+_-][a-z0-9][\w-]*/i.test(line)).length;
  if (commandLines >= 2) push(Math.min(10, commandLines + 2), `command-layout:${commandLines}`);
  if (lines.length >= 7 && text.length >= 180) push(4, 'structured-response');

  if (raw) {
    if (/dynamicReplyButtons|listResponseMessage|buttonsResponseMessage|interactiveMessage|listMessage|buttonsMessage|templateMessage/i.test(raw)) push(7, 'interactive-payload');
    if (/contextInfo|quotedMessage|botCommand|buttonsResponse|listResponse/i.test(raw) && text.length > 80) push(3, 'automation-payload');
  }

  const caption = String(payload?.media?.caption || '').trim();
  if (caption && caption !== text) {
    const captionHits = BOT_WORDS.filter((word) => caption.toLowerCase().includes(word)).length;
    if (captionHits >= 2) push(5, 'bot-media-caption');
  }

  const commandDensity = (text.match(/[.!#$%&*+\-/?:=[\]{}()<>]/g) || []).length / Math.max(1, text.length);
  if (commandDensity > 0.13 && lines.length >= 4) push(4, 'symbol-heavy');

  const hasListOfCommands = lines.filter((line) => /^[\s>*_~`|╭╰┃│┆•·]*(?:[.!#$\\/()[\]{}:+_-])[A-Za-z0-9]/.test(line)).length >= 3;
  if (hasListOfCommands && (shapeHits >= 3 || botHits >= 2)) push(5, 'bot-menu-layout');

  const fingerprint = responseShapeFingerprint(text);
  const profile = rememberFingerprint(context, fingerprint, score);
  if (profile?.repeatedShape >= 2 && score >= 5) push(5, `repeated-response-shape:${profile.repeatedShape}`);
  if (profile?.senderMessages >= 3 && score >= 4) push(4, `repeated-sender-pattern:${profile.senderMessages}`);

  return { score, reasons, knownBot: false, fingerprint, profile };
}

// -------------------------- Group clone ------------------------------
function uniqueIds(participants) {
  const out = [];
  for (const raw of participants || []) {
    const p = parseParticipant(raw);
    const id = p.phoneJid || p.jid;
    if (id && !id.endsWith('@lid') && !out.includes(id)) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------
// .split-gc used to run entirely in memory: one detached async function
// holding the full member list in a closure and sleeping between batches.
// That's cheap on CPU (it's mostly `await sleep()`), but it has zero
// resilience — a redeploy, a restart, or the process getting killed for
// any reason mid-job silently threw away all progress after whatever
// batch was in flight, with nothing left to resume it and no error
// surfaced beyond a console log. From the outside that looked exactly
// like "it added 5 people and just stopped".
//
// The fix isn't a lighter loop (there was nothing heavy to lighten) — it's
// checkpointing. Progress is now written into the same Postgres-backed
// `state.groups[...]` blob every store.js write already goes through, so:
//   - every batch's progress survives a restart/redeploy
//   - resumeSplitGcJobs() (called once at boot, see server.js) picks any
//     unfinished job back up and keeps going from where it left off,
//     instead of forcing you to re-run `.split-gc` from zero
//   - only one job can run per source group at a time (SPLIT_GC_RUNNING),
//     so a resume can't race a manual re-run of the command
// Pacing itself is unchanged and deliberately conservative — see the note
// on SPLIT_GC_BATCH_SIZE/DELAY below; "slower is safer" still applies.
function splitGcKey(session, sourceGroupId) {
  return `${String(session || 'legacy')}::${String(sourceGroupId || '')}`;
}

// Guards against a resume and a fresh `.split-gc` run colliding for the
// same source group. In-memory only — on boot there's nothing running yet,
// so resumeSplitGcJobs() never needs to check this before starting.
const SPLIT_GC_RUNNING = new Set();

function saveSplitGcJob(session, sourceGroupId, job) {
  const state = getState();
  state.groups ||= {};
  const key = splitGcKey(session, sourceGroupId);
  state.groups[key] = { ...(state.groups[key] || { groupId: sourceGroupId, session }), splitGcJob: job };
  return persistState();
}

function clearSplitGcJob(session, sourceGroupId) {
  const state = getState();
  const key = splitGcKey(session, sourceGroupId);
  if (state.groups?.[key]?.splitGcJob) {
    delete state.groups[key].splitGcJob;
    return persistState();
  }
  return Promise.resolve();
}

// Adding many members to a brand-new group in one or two huge bursts is
// exactly the pattern WhatsApp's spam detection watches for, and is the
// actual cause of the ban you were hitting. Pacing it out — a handful of
// adds, then a real pause, repeated until everyone's in — measurably lowers
// that risk. It is NOT a guarantee: mass-adding people to a new group
// without their own individual consent is against WhatsApp's terms
// regardless of pacing, and WhatsApp can still act on it. These are
// deliberately conservative defaults; override via env vars if you want to
// tune them, but slower is safer, not faster.
export const SPLIT_GC_BATCH_SIZE = Math.max(1, Number(process.env.SPLIT_GC_BATCH_SIZE || 5));
const SPLIT_GC_BATCH_DELAY_MS = Math.max(5000, Number(process.env.SPLIT_GC_BATCH_DELAY_MS || 25000));

async function generateBotStyleDescription(subject) {
  const fallback = `✨ ${subject} ✨\n\nKept and moderated by Orihime MD — your friendly WhatsApp group companion. 🌸\nBe kind, stay on topic, and enjoy the chat!`;
  if (!geminiConfigured()) return fallback;
  try {
    const prompt = `Write a short, warm WhatsApp group description (2-3 sentences, 1-2 emoji) for a group called "${subject}", in the voice of a friendly WhatsApp group-management bot named Orihime MD. Reply with ONLY the description text, nothing else.`;
    const text = await askGemini(prompt);
    return text?.trim()?.slice(0, 512) || fallback;
  } catch {
    return fallback;
  }
}

// Starts a brand-new split-gc job: snapshots the member/admin list once (so
// a later resume adds the same people even if the source group's
// membership changes mid-run), persists it, then runs it.
export async function startSplitGc(session, sourceGroupId, sourceGroup, participants, botIds = [], options = {}) {
  const key = splitGcKey(session, sourceGroupId);
  if (SPLIT_GC_RUNNING.has(key)) {
    throw new Error('A .split-gc job for this group is already in progress. Wait for it to finish before starting another.');
  }
  const botSet = new Set((botIds || []).map(normalizeJid).filter(Boolean));
  const memberIds = uniqueIds(participants).filter((id) => !botSet.has(id));
  if (!memberIds.length) throw new Error('No addable phone JIDs were found in the original group.');
  const admins = (participants || []).map(parseParticipant).filter((p) => p.isAdmin && (p.phoneJid || p.jid) && !botSet.has(p.phoneJid || p.jid)).map((p) => p.phoneJid || p.jid);
  const uniqueAdmins = [...new Set(admins)];
  const subject = String(sourceGroup?.subject || sourceGroup?.name || 'Orihime Clone').slice(0, 100);
  const description = await generateBotStyleDescription(subject);

  const job = {
    session, sourceGroupId,
    subject, description,
    memberIds, admins: uniqueAdmins,
    newId: null,
    // See findGroupIdBySubject/extractGroupId below — createSubject is a
    // tagged version of `subject` used only for the create call and the
    // id-lookup fallback, persisted BEFORE createGroup is called so a
    // resume can look the already-created group up instead of creating a
    // second one if the process dies between the create call succeeding
    // and its id being recorded.
    createSubject: null,
    added: 0,
    promoted: 0,
    securityCopied: false,
    status: 'creating',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  await saveSplitGcJob(session, sourceGroupId, job);
  return runSplitGcJob(session, sourceGroupId, job, options);
}

// WAHA's create-group response shape is undocumented and genuinely differs
// by engine — GOWS in particular has been seen returning the raw Go struct
// (PascalCase `JID`, not `id`/`groupId`/`gid`) instead of the normalized
// shape the WEBJS-oriented docs show. Checking every key we've seen in the
// wild here is cheap insurance; findGroupIdBySubject below is the real
// fallback for whatever shape isn't covered.
function extractGroupId(created) {
  if (!created) return null;
  if (typeof created === 'string') return created.includes('@g.us') ? created : null;
  const direct = created.id || created.groupId || created.gid || created.chatId
    || created.JID || created.Jid || created.jid
    || created?.group?.id || created?.group?.JID
    || created?.data?.id || created?.data?.JID;
  return direct ? String(direct) : null;
}

// Fallback for when the create response has no usable id at all: look the
// new group up by the unique tagged subject we created it with. Retries
// with a short delay because a freshly created group can take a moment to
// show up in GET /groups on some engines.
async function findGroupIdBySubject(session, createSubject, { attempts = 1, delayMs = 3000 } = {}) {
  if (!createSubject) return null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    try {
      const groups = await getGroups(session, {});
      const list = Array.isArray(groups) ? groups : (groups?.groups || groups?.data || []);
      const match = list.find((g) => (g?.name || g?.subject || g?.Name) === createSubject);
      const id = extractGroupId(match);
      if (id) return id;
    } catch (error) {
      console.error('[split-gc] group lookup by subject failed:', error?.response?.data || error?.message || error);
    }
  }
  return null;
}

// Runs (or resumes) a job from whatever checkpoint it's at. Safe to call
// again on a job that already has `newId`/`added`/`promoted` set — it picks
// up from there instead of redoing finished work.
export async function runSplitGcJob(session, sourceGroupId, job, options = {}) {
  const { onProgress } = options;
  const key = splitGcKey(session, sourceGroupId);
  if (SPLIT_GC_RUNNING.has(key)) return null;
  SPLIT_GC_RUNNING.add(key);
  try {
    const { memberIds, admins: uniqueAdmins } = job;

    if (!job.newId) {
      const first = memberIds.slice(0, SPLIT_GC_BATCH_SIZE).map((id) => ({ id }));

      // Persisted BEFORE createGroup is called — see the comment on
      // job.createSubject in startSplitGc. If this is a resume and the
      // group was actually already created last time (WAHA/GOWS created
      // it fine, we just crashed before recording the id), check for it
      // by this tag first instead of blindly creating a second group.
      if (!job.createSubject) {
        const tempTag = Math.random().toString(36).slice(2, 8);
        job.createSubject = `${String(job.subject || '').slice(0, 88)} #${tempTag}`.slice(0, 100);
        await saveSplitGcJob(session, sourceGroupId, job);
      } else {
        const existing = await findGroupIdBySubject(session, job.createSubject);
        if (existing) job.newId = existing;
      }

      if (!job.newId) {
        const created = await createGroup(session, job.createSubject, first);
        let newId = extractGroupId(created);
        if (!newId) {
          // Genuinely unknown response shape from this WAHA build/engine —
          // log it in full so it can be added to extractGroupId(), then
          // fall back to finding the group we just created by its (unique,
          // tagged) subject instead of failing outright.
          console.error('[split-gc] createGroup returned no recognizable id field, raw response:', JSON.stringify(created)?.slice(0, 800));
          newId = await findGroupIdBySubject(session, job.createSubject, { attempts: 6, delayMs: 3000 });
        }
        if (!newId) {
          throw new Error('WAHA created the group but returned no id, and it could not be found afterwards either. It may still show up in a few minutes — check your groups list before retrying .split-gc, to avoid creating a duplicate.');
        }
        job.newId = newId;
      }

      job.added = first.length;
      job.status = 'adding';
      await saveSplitGcJob(session, sourceGroupId, job);

      const newIdForSetup = job.newId;
      try { await setGroupSubject(session, newIdForSetup, job.subject); } catch {}
      if (job.description) { try { await setGroupDescription(session, newIdForSetup, job.description); } catch {} }

      // Branding: the bot's own .link image, not the source group's picture —
      // every cloned group carries the bot's own look rather than copying
      // whatever the original group happened to have set.
      try {
        const media = await readCommandMedia('.link');
        if (media?.data) {
          await setGroupPicture(session, newIdForSetup, {
            mimetype: media.mime,
            filename: media.filename,
            data: media.data.toString('base64')
          });
        }
      } catch (error) {
        console.error('[split-gc] picture set failed:', error?.response?.data || error?.message || error);
      }

      if (onProgress) { try { await onProgress({ added: job.added, total: memberIds.length }); } catch {} }
    }

    const newId = job.newId;
    while (job.added < memberIds.length) {
      await sleep(SPLIT_GC_BATCH_DELAY_MS);
      const chunk = memberIds.slice(job.added, job.added + SPLIT_GC_BATCH_SIZE).map((id) => ({ id }));
      try {
        await addParticipants(session, newId, chunk);
      } catch (error) {
        console.error('[split-gc] add chunk failed:', error?.response?.data || error?.message || error);
      }
      // Advance the checkpoint whether or not the chunk fully succeeded —
      // the old behaviour also just logged a failed chunk and moved on, and
      // retrying the same chunk forever would stall the job if WAHA keeps
      // rejecting it (e.g. a since-departed number).
      job.added += chunk.length;
      job.updatedAt = Date.now();
      await saveSplitGcJob(session, sourceGroupId, job);
      if (onProgress) { try { await onProgress({ added: Math.min(job.added, memberIds.length), total: memberIds.length }); } catch {} }
    }

    if (!job.securityCopied) {
      const security = [
        ['info-admin-only', 'adminsOnly'],
        ['messages-admin-only', 'adminsOnly'],
        ['member-add-mode', 'membersCanAddNewMember'],
        ['membership-approval', 'newMembersApprovalRequired']
      ];
      for (const [secName, field] of security) {
        try {
          const val = await getGroupSecurity(session, sourceGroupId, secName);
          if (val?.[field] !== undefined) await setGroupSecurity(session, newId, secName, { [field]: Boolean(val[field]) });
        } catch {}
      }
      job.securityCopied = true;
      job.status = 'promoting';
      await saveSplitGcJob(session, sourceGroupId, job);
    }

    while (job.promoted < uniqueAdmins.length) {
      if (job.promoted > 0) await sleep(SPLIT_GC_BATCH_DELAY_MS);
      const chunk = uniqueAdmins.slice(job.promoted, job.promoted + SPLIT_GC_BATCH_SIZE).map((id) => ({ id }));
      try { await promoteParticipants(session, newId, chunk); } catch (error) { console.error('[split-gc] admin restore failed:', error?.response?.data || error?.message || error); }
      job.promoted += chunk.length;
      job.updatedAt = Date.now();
      await saveSplitGcJob(session, sourceGroupId, job);
    }

    let verify = null;
    try { verify = await getGroup(session, newId); } catch {}
    const verifiedParticipants = Array.isArray(verify?.participants) ? verify.participants.length : null;
    job.status = 'done';
    await clearSplitGcJob(session, sourceGroupId);
    return { newId, subject: job.subject, description: job.description, targetMembers: memberIds.length, admins: uniqueAdmins.length, verifiedParticipants };
  } catch (error) {
    job.status = 'failed';
    job.error = String(error?.message || error).slice(0, 300);
    job.updatedAt = Date.now();
    await saveSplitGcJob(session, sourceGroupId, job).catch(() => {});
    throw error;
  } finally {
    SPLIT_GC_RUNNING.delete(key);
  }
}

// Called once at boot (see server.js). Picks any split-gc job that was
// mid-flight when the process last stopped and continues it — posting the
// same progress/completion messages to the source group as a fresh run
// would, so it's not a silent resume.
export async function resumeSplitGcJobs() {
  const groups = getState().groups || {};
  const pending = Object.values(groups).filter((record) => {
    const job = record?.splitGcJob;
    return job && ['creating', 'adding', 'promoting'].includes(job.status);
  });
  for (const record of pending) {
    const job = record.splitGcJob;
    const { session, sourceGroupId } = job;
    if (!session || !sourceGroupId) continue;
    let lastReported = job.added;
    sendText(session, sourceGroupId, `🪞 Resuming an interrupted .split-gc job (${job.added}/${job.memberIds.length} members already added). This can take a while — I'll post progress here.`).catch(() => {});
    runSplitGcJob(session, sourceGroupId, job, {
      onProgress: async ({ added, total }) => {
        if (added - lastReported >= 25 || added >= total) {
          lastReported = added;
          await sendText(session, sourceGroupId, `🪞 Split group progress: ${added}/${total} members added...`).catch(() => {});
        }
      }
    }).then((result) => {
      if (!result) return;
      sendText(session, sourceGroupId, `✅ Split group created.\n👥 Group : ${result.subject}\n🆔 New group ID : ${result.newId}\n👤 Members copied : ${result.targetMembers}\n👑 Admins restored : ${result.admins}${result.verifiedParticipants != null ? `\n✔️ Verified members : ${result.verifiedParticipants}` : ''}`).catch(() => {});
    }).catch((error) => {
      console.error('[split-gc] resume failed:', error?.response?.data || error?.message || error);
      sendText(session, sourceGroupId, `❌ Could not resume the split-gc job: ${String(error?.response?.data?.message || error?.message || error).slice(0, 260)}`).catch(() => {});
    });
  }
}

// -------------------------- Menu poll registry -----------------------
const MENU_POLLS = new Map();
export function registerMenuPoll(pollId, record) {
  if (!pollId) return;
  MENU_POLLS.set(String(pollId), { ...record, createdAt: Date.now() });
  if (MENU_POLLS.size > 150) MENU_POLLS.delete(MENU_POLLS.keys().next().value);
}
export function getMenuPoll(pollId) { return MENU_POLLS.get(String(pollId)) || null; }
export function clearMenuPoll(pollId) { MENU_POLLS.delete(String(pollId)); }

export async function handleMenuPollVote(session, payload) {
  const pollId = payload?.poll?.id || payload?._data?.poll?.id;
  const record = getMenuPoll(pollId);
  if (!record) return false;
  const selected = payload?.vote?.selectedOptions?.[0] || '';
  if (!selected) return true;
  if (selected === '🏠 Home' || selected === '↩️ Back') {
    return record.onAction?.('home', payload);
  }
  const mapped = record.options?.[selected];
  if (mapped) return record.onAction?.(mapped, payload);
  return true;
}
