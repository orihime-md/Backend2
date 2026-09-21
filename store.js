import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DATABASE_URL = process.env.DATABASE_URL || '';

// Render's managed Postgres requires SSL but uses a certificate chain that
// Node won't validate by default. PGSSL=false can disable this entirely for
// local/self-hosted Postgres that has no TLS at all.
const sslMode = String(process.env.PGSSL || '').toLowerCase();
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: sslMode === 'false' ? false : { rejectUnauthorized: false }
    })
  : null;

const defaultState = () => ({
  version: 1,
  sessions: {},
  groups: {},
  commands: [],
  channelImages: {},
  links: {},
  // content-hash (sha256 of the actual file bytes) -> first place it was seen.
  // This is what lets the channel scanner recognize "I already have this
  // exact image" even when it shows up again under a new message id (e.g.
  // reposted, forwarded back into the channel, or re-read on a later poll).
  mediaHashes: {}
});

// The rest of this module (bot.js, server.js, channelSync.js, watchdog.js)
// reads this in-memory object SYNCHRONOUSLY on every command. Keeping that
// contract intact — rather than making every call site `await` a DB round
// trip — is why persistence is a write-behind: mutate `state` immediately,
// then flush the whole thing to Postgres (or the local file) in the
// background, serialized through writeQueue so writes can't race each other.
let state = defaultState();
let writeQueue = Promise.resolve();
let usingPostgres = false;

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orihime_state (
      id INT PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

// Old versions stored one flat media object per key (`{ localPath, mime, ... }`).
// New versions store `{ items: [...] }` so a key can hold several images/videos.
// Migrate any leftover flat entries in place so old persisted state keeps working.
function migrateChannelImages() {
  for (const [key, value] of Object.entries(state.channelImages || {})) {
    if (value && !Array.isArray(value.items)) {
      state.channelImages[key] = { key, items: [{ ...value, id: value.id || value.messageId || key }] };
    }
  }
}

async function loadFromPostgres() {
  const { rows } = await pool.query('SELECT data FROM orihime_state WHERE id = 1');
  if (rows.length) {
    state = { ...defaultState(), ...rows[0].data };
  } else {
    state = defaultState();
    await pool.query('INSERT INTO orihime_state (id, data) VALUES (1, $1)', [state]);
  }
  state.sessions ||= {};
  state.groups ||= {};
  state.commands ||= [];
  state.channelImages ||= {};
  state.links ||= {};
  state.mediaHashes ||= {};
  migrateChannelImages();
}

async function loadFromFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = { ...defaultState(), ...parsed };
    state.sessions ||= {};
    state.groups ||= {};
    state.commands ||= [];
    state.channelImages ||= {};
  state.links ||= {};
    state.mediaHashes ||= {};
    migrateChannelImages();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await persistToFile();
  }
}

async function persistToFile() {
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, STATE_FILE);
}

async function persist() {
  writeQueue = writeQueue.then(async () => {
    if (usingPostgres) {
      await pool.query(
        `INSERT INTO orihime_state (id, data, updated_at) VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [state]
      );
    } else {
      await persistToFile();
    }
  }).catch((error) => {
    console.error('[store] persist failed:', error?.message || error);
  });
  return writeQueue;
}

export async function initStore() {
  if (pool) {
    try {
      await ensureSchema();
      await loadFromPostgres();
      usingPostgres = true;
      console.log('[store] Connected to Postgres — session/group/command data will survive restarts and redeploys.');
      return state;
    } catch (error) {
      console.error('[store] Postgres unavailable, falling back to local file storage:', error?.message || error);
    }
  } else {
    console.warn('[store] DATABASE_URL is not set — using local file storage. On Render this data will NOT survive a redeploy. Add a Postgres database and set DATABASE_URL to fix this.');
  }
  await loadFromFile();
  usingPostgres = false;
  return state;
}

export function getState() {
  return state;
}

export function storageBackend() {
  return usingPostgres ? 'postgres' : 'file';
}

export async function upsertSession(name, patch = {}) {
  state.sessions[name] = {
    ...(state.sessions[name] || {
      name,
      createdAt: new Date().toISOString(),
      removed: false,
      recoveryAttempts: 0,
      lastRecoveryAt: 0,
      status: 'UNKNOWN'
    }),
    ...patch,
    name
  };
  await persist();
  return state.sessions[name];
}

export async function patchSession(name, patch) {
  return upsertSession(name, patch);
}

export async function removeSession(name) {
  if (state.sessions[name]) {
    state.sessions[name].removed = true;
    state.sessions[name].removedAt = new Date().toISOString();
    await persist();
  }
}

export function getSession(name) {
  return state.sessions[name] || null;
}

export function listSessions() {
  return Object.values(state.sessions);
}

export async function setGroup(groupId, patch = {}) {
  state.groups[groupId] = {
    ...(state.groups[groupId] || {
      mode: 'PRIVATE',
      antilink: false,
      antibot: false,
      antichannel: false,
      killSale: false,
      welcome: false,
      left: false,
      antidemote: false,
      antipromote: false,
      autoDeleteUsers: [],
      createdAt: new Date().toISOString()
    }),
    ...patch,
    groupId
  };
  await persist();
  return state.groups[groupId];
}

export function getGroup(groupId) {
  return state.groups[groupId] || {
    groupId,
    mode: 'PRIVATE',
    antilink: false,
    antibot: false,
    antichannel: false,
    killSale: false,
    welcome: false,
    left: false,
    antidemote: false,
    antipromote: false,
    autoDeleteUsers: []
  };
}

// ---------- channel / bot links (captured from the followed channel via ".link <url>") ----------
export async function setChannelLink(key, value) {
  state.links ||= {};
  state.links[key] = value;
  await persist();
}

export function getChannelLink(key) {
  return (state.links || {})[key] || null;
}

export async function appendCommandLog(entry) {
  state.commands.unshift({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    timestamp: Date.now(),
    ...entry
  });
  state.commands = state.commands.slice(0, 5000);
  await persist();
}

export function commandHistory(filter = {}) {
  let rows = state.commands;
  if (filter.session) rows = rows.filter((r) => r.session === filter.session);
  if (filter.chatId) rows = rows.filter((r) => r.chatId === filter.chatId);
  return rows.slice(0, filter.limit || 20);
}

// ---------- channel media (images + videos) attached to a command caption ----------
// Each command key (e.g. ".menu") can now hold SEVERAL media items — a mix of
// images and videos posted in the channel with that same caption. Callers that
// only need "the" item for a key (bot.js) get one picked at random on every
// call, which is what gives each command its "random image/video" behaviour.
const MAX_ITEMS_PER_KEY = 25;

function itemId(item) {
  return item?.id || item?.messageId || item?.localPath || '';
}

export async function addChannelMedia(key, item) {
  const bucket = state.channelImages[key] || { key, items: [] };
  const id = itemId(item);
  bucket.items = (bucket.items || []).filter((existing) => itemId(existing) !== id);
  bucket.items.unshift({ ...item, id });
  bucket.items = bucket.items.slice(0, MAX_ITEMS_PER_KEY);
  state.channelImages[key] = bucket;
  await persist();
  return bucket;
}

// Back-compat single-item writer (still used for anything that only ever
// has one value for a key, e.g. internal metadata) — stores it as the sole item.
export async function setChannelImage(key, value) {
  return addChannelMedia(key, value);
}

// Returns ONE media item for `key`, chosen at random when several exist
// (e.g. a command with both an image and a video attached in the channel).
export function getChannelImage(key) {
  const bucket = state.channelImages[key];
  const items = bucket?.items || [];
  if (!items.length) return null;
  const pick = items[Math.floor(Math.random() * items.length)];
  return { ...pick, key };
}

export function getChannelMediaItems(key) {
  return [...(state.channelImages[key]?.items || [])];
}

export function listChannelImages() {
  return { ...state.channelImages };
}

export function countChannelMediaItems() {
  return Object.values(state.channelImages).reduce((sum, bucket) => sum + (bucket?.items?.length || 0), 0);
}

// ---------- content-hash dedup registry ----------
// Keyed by sha256(file bytes), independent of message id/key, so the exact
// same image is recognized as "already downloaded" no matter how many times
// or under how many different messages/commands it turns up.
export function findMediaHash(hash) {
  return state.mediaHashes[hash] || null;
}

export async function registerMediaHash(hash, info) {
  const existing = state.mediaHashes[hash];
  state.mediaHashes[hash] = {
    ...(existing || { firstSeenAt: Date.now() }),
    ...info,
    hash,
    lastSeenAt: Date.now(),
    seenCount: (existing?.seenCount || 0) + 1
  };
  await persist();
  return state.mediaHashes[hash];
}

export function countKnownMediaHashes() {
  return Object.keys(state.mediaHashes).length;
}

export async function clearHistory({ session, chatId } = {}) {
  state.commands = state.commands.filter((r) => {
    if (session && r.session !== session) return true;
    if (chatId && r.chatId !== chatId) return true;
    return false;
  });
  await persist();
}

export { DATA_DIR };
