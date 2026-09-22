// Builds Orihime MD's interactive WhatsApp menu (WAHA list messages) and
// parses the taps that come back through the webhook.
//
// IMPORTANT REALITY CHECK — read before relying on this in production:
// Native WhatsApp "list"/"button" interactive messages are a NOWEB
// (Baileys) engine feature in WAHA, are explicitly flagged by WAHA itself as
// not an officially-documented WhatsApp feature, and WhatsApp's own apps
// have become increasingly inconsistent about rendering them (some clients
// show a real tappable list, others show "this message type isn't
// supported, open on your phone", others silently drop it). There is no
// engine/client combination that is guaranteed to work. That's why every
// send in bot.js falls back to the existing plain-text menu (buildMenuText)
// if the interactive send throws — so `.menu` always produces SOMETHING
// usable either way. Test this against your own WAHA version's session
// before trusting it in front of real users, and check that version's
// `/api/docs` (Swagger UI) in case the request shape below needs tweaking.

const CATEGORIES = [
  { key: 'PUBLIC', emoji: '💕', label: 'PUBLIC', blurb: 'Pairing & links' },
  { key: 'FUN', emoji: '🎀', label: 'FUN', blurb: 'Jokes & little extras' },
  { key: 'AI', emoji: '🤖', label: 'AI', blurb: 'Ask Gemini anything' },
  { key: 'GAMES', emoji: '🎮', label: 'GAMES', blurb: 'Mini-games to play in chat' },
  { key: 'GROUP', emoji: '👥', label: 'GROUP', blurb: 'Group management tools' },
  { key: 'BOT', emoji: '🤖', label: 'BOT', blurb: 'Bot status & settings' },
  { key: 'ADMIN', emoji: '⚙️', label: 'ADMIN', blurb: 'Protection toggles' }
];

// requiresArg + usage -> tapping the row can't run the command (WhatsApp
// list/button replies carry no free-text field), so it sends back a
// copyable usage hint instead of executing anything.
// toggle: true -> tapping opens a tiny ON/OFF picker instead of a hint,
// since that sub-choice IS fully expressible as two more list rows.
const COMMANDS_BY_CATEGORY = {
  PUBLIC: [
    { name: 'pair', label: '.pair <number>', desc: 'Link your own session', requiresArg: true, usage: '.pair 15551234567' },
    { name: 'link', label: '.link', desc: 'Get the official bot and channel links' }
  ],
  FUN: [
    { name: 'blague', label: '.blague', desc: 'Un joke, en français' },
    { name: 'joke', label: '.joke', desc: 'Random joke' },
    { name: 'orihime-wipe', label: '.orihime-wipe', desc: 'Wipe stored history' },
    { name: 'orihime-history', label: '.orihime-history', desc: 'View command history' }
  ],
  AI: [
    { name: 'ai', label: '.ai <question>', desc: 'Ask Gemini a question', requiresArg: true, usage: '.ai <question or request>' }
  ],
  GAMES: [
    { name: 'candy', label: '.candy', desc: 'Start Candy game' },
    { name: 'candycrush', label: '.candycrush', desc: 'Start Candy Crush' },
    { name: 'crossword', label: '.crossword', desc: 'Start a crossword' },
    { name: 'wordgame', label: '.wordgame', desc: 'Start the word game' },
    { name: '2048', label: '.2048', desc: 'Play 2048' }
  ],
  GROUP: [
    { name: 'kick', label: '.kick', desc: 'Mention/reply to remove a member', requiresArg: true, usage: '.kick @user  (or reply to their message)' },
    { name: 'add', label: '.add <number>', desc: 'Add a member', requiresArg: true, usage: '.add 15551234567' },
    { name: 'kickall', label: '.kickall', desc: 'Remove every non-admin member' },
    { name: 'tagall', label: '.tagall', desc: 'Mention everyone' },
    { name: 'hidetag', label: '.hidetag', desc: 'Silent mention-all' },
    { name: 'invite', label: '.invite', desc: 'Get this group\u2019s invite link' },
    { name: 'left', label: '.left on/off', desc: 'Notify when someone leaves', toggle: true },
    { name: 'leave', label: '.leave', desc: 'Bot leaves this group' },
    { name: 'welcome', label: '.welcome on/off', desc: 'Greet new members', toggle: true },
    { name: 'autod', label: '.autod @user', desc: 'Auto-delete a member\u2019s messages', requiresArg: true, usage: '.autod @user  (or reply to their message)' },
    { name: 'announcement', label: '.announcement', desc: 'Broadcast a message to everyone', requiresArg: true, usage: '.announcement <your text>' },
    { name: 'close', label: '.close', desc: 'Admins-only messaging' },
    { name: 'open', label: '.open', desc: 'Everyone can message' },
    { name: 'group-id', label: '.group-id', desc: 'Show this group\u2019s id' },
    { name: 'listadmin', label: '.listadmin', desc: 'List group admins' },
    { name: 'vv', label: '.vv', desc: 'Reveal a view-once reply' },
    { name: 'promote', label: '.promote @user', desc: 'Make a member admin', requiresArg: true, usage: '.promote @user  (or reply to their message)' },
    { name: 'demote', label: '.demote @user', desc: 'Remove admin from a member', requiresArg: true, usage: '.demote @user  (or reply to their message)' }
  ],
  BOT: [
    { name: 'ping', label: '.ping', desc: 'Check bot speed & status' },
    { name: 'whoami', label: '.whoami', desc: 'Show your id & role' },
    { name: 'setprefix', label: '.setprefix', desc: 'Change the command prefix', requiresArg: true, usage: '.setprefix !' },
    { name: 'public', label: '.public', desc: 'Anyone can use the bot' },
    { name: 'private', label: '.private', desc: 'Owner-only mode' }
  ],
  ADMIN: [
    { name: 'antibot', label: '.antibot on/off', desc: 'Block other bots', toggle: true },
    { name: 'antichannel', label: '.antichannel on/off', desc: 'Block channel forwards', toggle: true },
    { name: 'antilink', label: '.antilink on/off', desc: 'Delete invite links', toggle: true },
    { name: 'kill-sale', label: '.kill-sale on/off', desc: 'Delete selected sale/price words', toggle: true },
    { name: 'antidemote', label: '.antidemote on/off', desc: 'Auto-revert demotions', toggle: true },
    { name: 'antipromote', label: '.antipromote on/off', desc: 'Auto-revert promotions', toggle: true }
  ]
};

function findCategoryForCommand(name) {
  for (const cat of Object.keys(COMMANDS_BY_CATEGORY)) {
    if (COMMANDS_BY_CATEGORY[cat].some((c) => c.name === name)) return cat;
  }
  return null;
}

function findCommand(name) {
  for (const list of Object.values(COMMANDS_BY_CATEGORY)) {
    const hit = list.find((c) => c.name === name);
    if (hit) return hit;
  }
  return null;
}

// ---------- WAHA payload builders ----------
// Shapes follow WAHA's documented `/api/sendList` interactive-message
// request. If your WAHA version expects a different envelope, adjust these
// three builders only — everything else (parsing, dispatch) is unaffected.

export function buildMainMenuPayload(prefix = '.') {
  return {
    header: '🌸 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 𝐌𝐃',
    body: '«💗 Cute • Simple • Fast\n✨ Your Cute WhatsApp Assistant»\n\nTap a category below to see its commands.',
    footer: `Prefix: "${prefix}"  •  ✨ orihime-md`,
    buttonText: '🌸 Open Menu',
    sections: [
      {
        title: '🎀 Categories',
        rows: CATEGORIES.map((c) => ({
          rowId: `menu:cat:${c.key}`,
          title: `${c.emoji} ${c.label}`,
          description: c.blurb
        }))
      }
    ]
  };
}

export function buildCategoryPayload(categoryKey, prefix = '.') {
  const category = CATEGORIES.find((c) => c.key === categoryKey);
  const commands = COMMANDS_BY_CATEGORY[categoryKey];
  if (!category || !commands) return null;
  const rows = commands.map((c) => ({
    rowId: c.toggle ? `menu:toggle:${c.name}` : c.requiresArg ? `menu:hint:${c.name}` : `menu:run:${c.name}`,
    title: c.label.replace(/^\./, prefix),
    description: c.desc
  }));
  rows.push({ rowId: 'menu:home', title: '↩️ Back', description: 'Return to the main menu' });
  return {
    header: `${category.emoji} 𝐎𝐑𝐈𝐇𝐈𝐌𝐄 · ${category.label}`,
    body: `✨ ${category.blurb}\n\nTap a command to run it, or view usage.`,
    footer: '🌸 Orihime MD',
    buttonText: `${category.emoji} ${category.label}`,
    sections: [{ title: `${category.emoji} ${category.label} commands`, rows }]
  };
}

export function buildTogglePayload(commandName, prefix = '.') {
  const command = findCommand(commandName);
  const categoryKey = findCategoryForCommand(commandName);
  if (!command) return null;
  return {
    header: `⚙️ ${prefix}${commandName}`,
    body: `✨ ${command.desc}\n\nChoose ON or OFF.`,
    footer: '🌸 Orihime MD',
    buttonText: 'Choose',
    sections: [
      {
        title: 'Toggle',
        rows: [
          { rowId: `menu:run:${commandName}:on`, title: '✅ Turn ON', description: `${prefix}${commandName} on` },
          { rowId: `menu:run:${commandName}:off`, title: '🚫 Turn OFF', description: `${prefix}${commandName} off` },
          { rowId: `menu:cat:${categoryKey || ''}`, title: '↩️ Back', description: 'Return to this category' }
        ]
      }
    ]
  };
}

// ---------- parsing a tap that came back through the webhook ----------
// Different WAHA/Baileys versions surface the selected row id in different
// places, so this checks every known spot before giving up.
export function extractSelectedRowId(payload) {
  const raw = payload?._data?.message || payload?._data || {};
  const candidates = [
    raw?.listResponseMessage?.singleSelectReply?.selectedRowId,
    raw?.buttonsResponseMessage?.selectedButtonId,
    payload?.listResponse?.selectedRowId,
    payload?.selectedRowId,
    payload?.selectedButtonId
  ];
  const id = candidates.find(Boolean);
  if (id) return String(id);
  // Last resort: a few builds put the raw id straight into the message body
  // instead of a dedicated field.
  const text = String(payload?.body || payload?.text || '').trim();
  return /^menu:/.test(text) ? text : null;
}

// Turns a row id like "menu:cat:GROUP" / "menu:run:ping" /
// "menu:run:left:on" / "menu:hint:pair" / "menu:toggle:antilink" /
// "menu:home" into a structured action for bot.js to act on.
export function parseSelection(rowId) {
  if (!rowId || !rowId.startsWith('menu:')) return null;
  const parts = rowId.split(':');
  const type = parts[1];
  if (type === 'home') return { type: 'home' };
  if (type === 'cat') return { type: 'category', category: parts[2] };
  if (type === 'toggle') return { type: 'toggle', command: parts[2] };
  if (type === 'hint') return { type: 'hint', command: parts[2] };
  if (type === 'run') return { type: 'run', command: parts[2], arg: parts[3] };
  return null;
}

export function usageFor(commandName, prefix = '.') {
  const command = findCommand(commandName);
  if (!command) return null;
  const usage = (command.usage || command.label).replace(/^\./, prefix);
  return `📎 Usage\n${usage}\n\nList/button taps can't carry free text (numbers, @mentions, custom messages) — type this one in directly.`;
}

export { CATEGORIES, COMMANDS_BY_CATEGORY };
