import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const defaultState = () => ({
  version: 1,
  sessions: {},
  groups: {},
  commands: [],
  channelImages: {}
});

let state = defaultState();
let writeQueue = Promise.resolve();

async function ensure() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = { ...defaultState(), ...parsed };
    state.sessions ||= {};
    state.groups ||= {};
    state.commands ||= [];
    state.channelImages ||= {};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await persist();
  }
}

async function persist() {
  const tmp = `${STATE_FILE}.tmp`;
  const serialized = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(async () => {
    await fs.writeFile(tmp, serialized, 'utf8');
    await fs.rename(tmp, STATE_FILE);
  });
  return writeQueue;
}

export async function initStore() {
  await ensure();
  return state;
}

export function getState() {
  return state;
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
      welcome: false,
      left: false,
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
    welcome: false,
    left: false,
    autoDeleteUsers: []
  };
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

export async function setChannelImage(key, value) {
  state.channelImages[key] = value;
  await persist();
}

export function getChannelImage(key) {
  return state.channelImages[key] || null;
}

export function listChannelImages() {
  return { ...state.channelImages };
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
