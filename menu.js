// Interactive menu payloads for Orihime MD.
//
// Native WhatsApp buttons are attempted first. WAHA currently marks its
// sendButtons feature as fragile/deprecated, so the bot also sends a Poll
// controller as the reliable interactive fallback. This is especially useful
// in groups, where WAHA list messages are not a reliable option.

const CATEGORIES = [
  { key: 'PUBLIC', emoji: '💕', label: 'PUBLIC', blurb: 'Pairing & links' },
  { key: 'FUN', emoji: '🎀', label: 'FUN', blurb: 'Jokes & extras' },
  { key: 'AI', emoji: '🤖', label: 'AI', blurb: 'Gemini tools' },
  { key: 'MEDIA', emoji: '🎬', label: 'MEDIA', blurb: 'Sticker, music & media' },
  { key: 'GAMES', emoji: '🎮', label: 'GAMES', blurb: 'Interactive games' },
  { key: 'GROUP', emoji: '👥', label: 'GROUP', blurb: 'Group tools' },
  { key: 'BOT', emoji: '🛠️', label: 'BOT', blurb: 'Bot controls' },
  { key: 'ADMIN', emoji: '⚙️', label: 'ADMIN', blurb: 'Protection & moderation' }
];

const COMMANDS_BY_CATEGORY = {
  PUBLIC: [
    { name: 'pair', label: '.pair <number>', desc: 'Link your own session', requiresArg: true, usage: '.pair 2348012345678' },
    { name: 'link', label: '.link', desc: 'Get the bot links' }
  ],
  FUN: [
    { name: 'joke', label: '.joke', desc: 'Random joke' },
    { name: 'blague', label: '.blague', desc: 'French-style joke' },
    { name: 'orihime-history', label: '.orihime-history', desc: 'Recent command history' },
    { name: 'orihime-wipe', label: '.orihime-wipe', desc: 'Clear recent history' }
  ],
  AI: [
    { name: 'ai', label: '.ai <question>', desc: 'Ask Gemini', requiresArg: true, usage: '.ai <question>' },
    { name: 'summarize', label: '.summarize', desc: 'Summarize a message', requiresArg: true, usage: '.summarize (reply to text)' },
    { name: 'translate', label: '.translate <lang>', desc: 'Translate with Gemini', requiresArg: true, usage: '.translate japanese <text>' },
    { name: 'prefix-d', label: '.prefix-d <animation>', desc: 'Start sign-character animation', requiresArg: true, usage: '.prefix-d woman dancing' }
  ],
  MEDIA: [
    { name: 'sticker', label: '.sticker', desc: 'Image/video → sticker' },
    { name: 'toimg', label: '.toimg', desc: 'Sticker → image' },
    { name: 'play', label: '.play <song>', desc: 'Search/download audio', requiresArg: true, usage: '.play <song>' },
    { name: 'vv', label: '.vv', desc: 'Reveal a view-once reply' },
    { name: 'silentf', label: '.silentF', desc: 'Reveal view-once privately' }
  ],
  GAMES: [
    { name: 'candycrush', label: '.candycrush', desc: 'Candy Crush controller' },
    { name: 'candy', label: '.candy', desc: 'Start Candy game' },
    { name: 'crossword', label: '.crossword', desc: 'Crossword game' },
    { name: 'wordgame', label: '.wordgame', desc: 'Unscramble game' },
    { name: '2048', label: '.2048', desc: '2048 game' }
  ],
  GROUP: [
    { name: 'close', label: '.close <time>', desc: 'Close now or schedule a close', requiresArg: false, usage: '.close 30m  •  .close 22:00  •  .close' },
    { name: 'open', label: '.open <time>', desc: 'Open now or schedule an open', requiresArg: false, usage: '.open 10m  •  .open 07:00  •  .open' },
    { name: 'split-gc', label: '.split-gc', desc: 'Clone this group', requiresArg: false },
    { name: 'announcement', label: '.announcement <text>', desc: 'Group announcement', requiresArg: true, usage: '.announcement <text>' },
    { name: 'welcome', label: '.welcome on/off', desc: 'Welcome new members', toggle: true },
    { name: 'left', label: '.left on/off', desc: 'Farewell messages', toggle: true },
    { name: 'antilink', label: '.antilink on/off', desc: 'Delete links', toggle: true },
    { name: 'antibot', label: '.antibot on/off', desc: 'Detect/remove other bot messages', toggle: true },
    { name: 'tagall', label: '.tagall', desc: 'Mention members' },
    { name: 'hidetag', label: '.hidetag', desc: 'Silent mention-all' },
    { name: 'group-id', label: '.group-id', desc: 'Show group id' },
    { name: 'listadmin', label: '.listadmin', desc: 'List group admins' },
    { name: 'kick', label: '.kick @user', desc: 'Remove a member', requiresArg: true, usage: '.kick @user' },
    { name: 'promote', label: '.promote @user', desc: 'Make a member admin', requiresArg: true, usage: '.promote @user' },
    { name: 'demote', label: '.demote @user', desc: 'Remove admin role', requiresArg: true, usage: '.demote @user' },
    { name: 'warn', label: '.warn @user', desc: 'Warn a member', requiresArg: true, usage: '.warn @user' },
    { name: 'autod', label: '.autod @user on/off', desc: 'Auto-delete a member', requiresArg: true, usage: '.autod @user on' },
    { name: 'invite', label: '.invite', desc: 'Get invite link' },
    { name: 'leave', label: '.leave', desc: 'Leave group' }
  ],
  BOT: [
    { name: 'ping', label: '.ping', desc: 'Check bot status' },
    { name: 'whoami', label: '.whoami', desc: 'Show your role and ids' },
    { name: 'setprefix', label: '.setprefix', desc: 'Change command prefix', requiresArg: true, usage: '.setprefix !' },
    { name: 'silent-m', label: '.silent-m <text>', desc: 'Send text only', requiresArg: true, usage: '.silent-m <text>' },
    { name: 'lang-china', label: '.lang-china on/off', desc: 'Chinese-style letter mapping', toggle: true },
    { name: 'lang-japanese', label: '.lang-japanese on/off', desc: 'Japanese-style mapping', toggle: true },
    { name: 'lang-korea', label: '.lang-korea on/off', desc: 'Korean-style mapping', toggle: true },
    { name: 'lang-add', label: '.lang-add', desc: 'Add a custom A-Z mapping', requiresArg: true, usage: '.lang-add name|25-or-26-chars' },
    { name: 'lang-use', label: '.lang-use <key> on/off', desc: 'Activate a custom mapping', requiresArg: true, usage: '.lang-use <key> on/off' },
    { name: 'public', label: '.public', desc: 'Enable public mode' },
    { name: 'private', label: '.private', desc: 'Enable owner-only mode' }
  ],
  ADMIN: [
    { name: 'antibot', label: '.antibot on/off', desc: 'Other bot detection', toggle: true },
    { name: 'antichannel', label: '.antichannel on/off', desc: 'Block channel forwards', toggle: true },
    { name: 'antilink', label: '.antilink on/off', desc: 'Block links', toggle: true },
    { name: 'antispam', label: '.antispam on/off', desc: 'Flood protection', toggle: true },
    { name: 'antidelete', label: '.antidelete on/off', desc: 'Recover deleted messages', toggle: true },
    { name: 'kill-sale', label: '.kill-sale on/off', desc: 'Remove sale/price posts', toggle: true },
    { name: 'antidemote', label: '.antidemote on/off', desc: 'Restore demoted admins', toggle: true },
    { name: 'antipromote', label: '.antipromote on/off', desc: 'Undo promotions', toggle: true },
    { name: 'badword', label: '.badword add <word>', desc: 'Block configured words', requiresArg: true, usage: '.badword add word1,word2' },
    { name: 'warnlimit', label: '.warnlimit <n>', desc: 'Warnings before kick', requiresArg: true, usage: '.warnlimit 3' }
  ]
};

function findCategoryForCommand(name) {
  for (const [cat, commands] of Object.entries(COMMANDS_BY_CATEGORY)) {
    if (commands.some((c) => c.name === name)) return cat;
  }
  return null;
}

function findCommand(name) {
  for (const commands of Object.values(COMMANDS_BY_CATEGORY)) {
    const found = commands.find((c) => c.name === name);
    if (found) return found;
  }
  return null;
}

export function buildMainButtonsPayload(prefix = '.') {
  return {
    header: '🌸 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 𝐌𝐃',
    body: `💗 Welcome to Orihime MD\n\nPrefix: ${prefix}\nTap a button to open a category.`,
    footer: '✨ More categories are available in the controller below.',
    buttons: [
      { type: 'reply', text: '🎀 FUN' },
      { type: 'reply', text: '🎬 MEDIA' },
      { type: 'reply', text: '🎮 GAMES' }
    ]
  };
}

export function buildMoreButtonsPayload(prefix = '.') {
  return {
    header: '🌸 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 · MORE',
    body: `Pick another category. Prefix: ${prefix}`,
    footer: '🌸 Orihime MD',
    buttons: [
      { type: 'reply', text: '👥 GROUP' },
      { type: 'reply', text: '🤖 AI' },
      { type: 'reply', text: '🛠️ BOT' }
    ]
  };
}

export function buildCategoryButtonsPayload(categoryKey, prefix = '.') {
  const category = CATEGORIES.find((x) => x.key === categoryKey);
  const commands = COMMANDS_BY_CATEGORY[categoryKey] || [];
  if (!category) return null;
  const runnable = commands.filter((c) => !c.requiresArg).slice(0, 2);
  const first = runnable[0] || commands[0];
  const second = runnable[1] || commands[1] || commands[0];
  const buttons = [];
  if (first) buttons.push({ type: 'reply', text: `${prefix}${first.name}`.slice(0, 20) });
  if (second && second !== first) buttons.push({ type: 'reply', text: `${prefix}${second.name}`.slice(0, 20) });
  buttons.push({ type: 'reply', text: '↩️ HOME' });
  return {
    header: `${category.emoji} 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 · ${category.label}`,
    body: `${category.blurb}\n\nUse the buttons below or choose any command from the poll controller.`,
    footer: '🌸 Orihime MD',
    buttons: buttons.slice(0, 3)
  };
}

export function buildToggleButtonsPayload(commandName, prefix = '.') {
  const command = findCommand(commandName);
  if (!command) return null;
  return {
    header: `⚙️ ${prefix}${commandName}`,
    body: `${command.desc}\n\nChoose a state.`,
    footer: '🌸 Orihime MD',
    buttons: [
      { type: 'reply', text: '✅ ON' },
      { type: 'reply', text: '🚫 OFF' },
      { type: 'reply', text: '↩️ BACK' }
    ]
  };
}

// Poll options are the authoritative interactive controller because WAHA
// documents polls as the alternative to fragile buttons/lists.
export function buildCategoryPollOptions(categoryKey, prefix = '.') {
  const commands = COMMANDS_BY_CATEGORY[categoryKey] || [];
  return commands.slice(0, 9).map((c) => `${prefix}${c.name}`);
}

export function buildMainPollOptions() {
  return CATEGORIES.map((c) => `${c.emoji} ${c.label}`);
}

export function buildTogglePollOptions() { return ['✅ ON', '🚫 OFF', '↩️ BACK']; }

export function extractSelectedRowId(payload) {
  const raw = payload?._data?.message || payload?._data || {};
  const candidates = [
    raw?.listResponseMessage?.singleSelectReply?.selectedRowId,
    raw?.buttonsResponseMessage?.selectedButtonId,
    raw?.dynamicReplyButtons?.[1]?.buttonId,
    raw?.dynamicReplyButtons?.[0]?.buttonId,
    payload?.listResponse?.selectedRowId,
    payload?.selectedRowId,
    payload?.selectedButtonId,
    payload?.buttonId
  ];
  const id = candidates.find((value) => value && String(value).startsWith('menu:'));
  if (id) return String(id);
  const displayText = raw?.dynamicReplyButtons?.[1]?.buttonText?.displayText
    || raw?.buttonsResponseMessage?.selectedDisplayText
    || payload?.selectedDisplayText;
  if (displayText) return `buttontext:${String(displayText)}`;
  const fallbackId = candidates.find(Boolean);
  if (fallbackId) return String(fallbackId);
  const text = String(payload?.body || payload?.text || '').trim();
  return /^menu:/.test(text) ? text : null;
}

export function parseSelection(rowId) {
  if (String(rowId || '').startsWith('buttontext:')) return { type: 'buttontext', text: String(rowId).slice('buttontext:'.length) };
  if (!rowId || !String(rowId).startsWith('menu:')) return null;
  const parts = String(rowId).split(':');
  if (parts[1] === 'home') return { type: 'home' };
  if (parts[1] === 'cat') return { type: 'category', category: parts[2] };
  if (parts[1] === 'toggle') return { type: 'toggle', command: parts[2] };
  if (parts[1] === 'hint') return { type: 'hint', command: parts[2] };
  if (parts[1] === 'run') return { type: 'run', command: parts[2], arg: parts[3] };
  if (parts[1] === 'poll') return { type: 'poll', category: parts[2] };
  return null;
}

export function commandFromButtonText(text, prefix = '.') {
  const raw = String(text || '').trim();
  if (/^↩️\s*(HOME|BACK)$/i.test(raw)) return 'menu:home';
  const upperMap = {
    '🎀 FUN': 'menu:cat:FUN', '🎬 MEDIA': 'menu:cat:MEDIA', '🎮 GAMES': 'menu:cat:GAMES',
    '👥 GROUP': 'menu:cat:GROUP', '🤖 AI': 'menu:cat:AI', '⚙️ ADMIN': 'menu:cat:ADMIN', '🛠️ BOT': 'menu:cat:BOT'
  };
  if (upperMap[raw]) return upperMap[raw];
  if (raw.startsWith(prefix)) return `menu:run:${raw.slice(prefix.length).trim().split(/\s+/)[0].toLowerCase()}`;
  return null;
}

export function usageFor(commandName, prefix = '.') {
  const command = findCommand(commandName);
  if (!command) return null;
  const usage = (command.usage || command.label).replace(/^\./, prefix);
  return `📎 Usage\n${usage}\n\nA button/poll selection cannot supply free text, so type the command directly when an argument is required.`;
}

export { CATEGORIES, COMMANDS_BY_CATEGORY };
