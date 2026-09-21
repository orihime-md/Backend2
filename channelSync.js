import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getChannel,
  listChannels,
  followChannel,
  getChannelMessages,
  getChannelPreview,
  downloadMedia
} from './waha.js';
import {
  DATA_DIR,
  addChannelMedia,
  getChannelImage,
  countChannelMediaItems,
  patchSession,
  getSession,
  listSessions,
  setChannelLink,
  findMediaHash,
  registerMediaHash
} from './store.js';

const CHANNEL_REF = process.env.ORIHIME_CHANNEL || 'https://whatsapp.com/channel/0029VbDOiYGHVvTTnDNd6I2C';
const MEDIA_DIR = path.join(DATA_DIR, 'channel-media');
const commandLikeCaption = /^\.\S+/;
const linkCaption = /^\.link\s+(\S+)/i;

// Page size used while walking the channel's message history. WAHA's
// message endpoints take a flat limit+offset (no real cursor), so "read
// everything since the channel was created" means paging backward with
// offset in chunks of this size until a page comes back short/empty.
const SYNC_PAGE_SIZE = Number(process.env.CHANNEL_SYNC_PAGE_SIZE || 100);
// Hard ceiling on how many pages a single deep backfill will walk, so a
// misbehaving WAHA version that never returns an empty page can't loop
// forever. 300 pages * 100 = up to 30,000 messages of history by default.
const SYNC_MAX_PAGES = Number(process.env.CHANNEL_SYNC_MAX_PAGES || 300);
// The old flat limit is kept as the size of a "light" tick (see
// syncChannelImages below) — just enough to catch anything newly posted.
const SYNC_MESSAGE_LIMIT = Number(process.env.CHANNEL_SYNC_LIMIT || 100);
// How often the silent background watcher re-checks a connected session.
const SCAN_INTERVAL_MS = Number(process.env.CHANNEL_SCAN_INTERVAL_MS || 2000);

function cleanCaption(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

// Turns a channel post's caption into the SAME lookup key bot.js will ask
// for — this is what makes "old" media (and media captioned with a
// description, or typed in a different case) actually match its command.
// Previously the raw caption text WAS the key, so ".Ping" (wrong case) or
// ".ping — daily heartbeat check" (a caption with a description attached)
// silently never matched ".ping" and the command fell back to "not synced".
// Now: the command name is lowercased, and only a genuine "on"/"off" toggle
// word right after it is folded into the key — anything else after the
// command is just decorative caption text and is ignored for matching.
function commandKeyFromCaption(caption) {
  const match = String(caption || '').trim().match(/^\.(\S+)(?:\s+(\S+))?/);
  if (!match) return null;
  const command = match[1].toLowerCase();
  const nextWord = (match[2] || '').toLowerCase();
  if (nextWord === 'on' || nextWord === 'off') return `.${command} ${nextWord}`;
  return `.${command}`;
}

// Captures a plain-text ".link <url>" message posted in the followed
// channel — this is how the operator sets the channel link that the
// in-chat ".link" command (public, usable by anyone in a group) sends back.
async function saveLink(message, session) {
  const text = cleanCaption(message.body || message.text || message.caption);
  const match = text.match(linkCaption);
  if (!match) return null;
  const url = match[1];
  await setChannelLink('channel', { url, session, messageId: message.id, updatedAt: Date.now() });
  return url;
}

export { CHANNEL_REF };

// Recognizes both images AND videos posted in the channel — a command key
// can end up holding either kind (or several of each), so replies can be
// randomly an image or a video the same way.
function mediaKind(message) {
  const mime = message?.media?.mimetype || '';
  if (!message?.hasMedia && !message?.mediaUrl && !message?.media?.url) return null;
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  // Some engines omit mimetype on the list/preview endpoints; fall back to
  // whatever URL extension is available so nothing gets silently dropped.
  const url = message.mediaUrl || message?.media?.url || '';
  if (/\.(mp4|mov|mkv|webm|3gp)(\?|$)/i.test(url)) return 'video';
  if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)) return 'image';
  return null;
}

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov'
};

function extensionFor(kind, mime) {
  return EXT_BY_MIME[mime] || (kind === 'video' ? 'mp4' : 'jpg');
}

// Saves ONE channel media message (image or video) under its command key
// (e.g. ".menu", ".antilink on") — a key can collect several media items
// over time, each kept, so the command can later hand back a random one.
//
// This is intentionally re-run on the SAME messages over and over (every
// light tick re-reads the most recent window, and a deep backfill re-walks
// pages it has already seen before) — that repetition is fine and expected.
// What must never happen is the same image ending up stored twice, so every
// download is fingerprinted by the actual file bytes (sha256) and checked
// against store.js's content-hash registry before anything new is written
// or logged to the command database.
async function saveChannelMedia(message, session) {
  const kind = mediaKind(message);
  if (!kind) return null;
  const caption = cleanCaption(message.body);
  if (!caption || !commandLikeCaption.test(caption)) return null;
  const key = commandKeyFromCaption(caption);
  if (!key) return null;
  const mediaUrl = message.mediaUrl || message.media?.url;
  if (!mediaUrl) return null;

  await fs.mkdir(MEDIA_DIR, { recursive: true });
  const mime = message?.media?.mimetype || (kind === 'video' ? 'video/mp4' : 'image/jpeg');
  const ext = extensionFor(kind, mime);

  // The message-id-scoped path is just a cheap "have I already fetched THIS
  // exact message's bytes" check, so a message that keeps reappearing in
  // every 2s poll window doesn't re-download over the network each time.
  const perMessageHash = crypto.createHash('sha256').update(`${session}:${message.id}:${mediaUrl}`).digest('hex');
  const cachedPath = path.join(MEDIA_DIR, `${perMessageHash}.${ext}`);
  let buffer;
  try {
    buffer = await fs.readFile(cachedPath);
  } catch {
    const downloaded = await downloadMedia(mediaUrl);
    buffer = downloaded.buffer;
    await fs.writeFile(cachedPath, buffer);
  }

  // The REAL dedup check: identify this image by its own content, not the
  // message it arrived on. The same picture can legitimately show up under
  // several message ids (reposts, the deep backfill re-reading old pages,
  // etc.) — content hash is what recognizes "I've already downloaded this
  // one" regardless of how many times it gets fetched.
  const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const known = findMediaHash(contentHash);
  const localPath = known?.localPath || cachedPath;
  await registerMediaHash(contentHash, { localPath, kind, mime, firstKey: known?.firstKey || key });

  await addChannelMedia(key, {
    key,
    caption,
    session,
    messageId: message.id,
    localPath,
    contentHash,
    mime,
    kind,
    updatedAt: Date.now()
  });
  return getChannelImage(key);
}

export async function resolveChannel(session) {
  try {
    const exact = await getChannel(session, CHANNEL_REF);
    if (exact?.id || exact?._id) return exact;
  } catch {}

  let channels = [];
  try {
    channels = await listChannels(session);
  } catch {}
  const list = Array.isArray(channels) ? channels : (channels?.channels || []);
  const match = list.find((c) =>
    c?.id === CHANNEL_REF ||
    c?.invite === CHANNEL_REF ||
    c?.inviteCode === CHANNEL_REF ||
    c?.link === CHANNEL_REF ||
    (CHANNEL_REF.includes('channel/') && c?.inviteCode === CHANNEL_REF.split('channel/')[1])
  );
  if (match) return match;

  const invite = CHANNEL_REF.split('/channel/')[1] || CHANNEL_REF;
  try {
    const byInvite = await getChannel(session, invite);
    if (byInvite?.id || byInvite?._id) return byInvite;
  } catch {}

  return null;
}

export async function ensureChannelFollow(session) {
  const channel = await resolveChannel(session);
  if (!channel) return { ok: false, reason: 'CHANNEL_NOT_FOUND' };
  const id = channel.id || channel._id;
  try {
    await followChannel(session, id);
  } catch (error) {
    const status = error?.response?.status;
    if (status !== 409 && status !== 400) throw error;
  }
  await patchSession(session, { channelId: id, channelName: channel.name || channel.title || 'Orihime Channel' });
  return { ok: true, channel };
}

// Fetches one page of channel history at the given offset, trying the
// direct chat-messages endpoint first and falling back to the channel
// preview endpoint (which is what still works for a channel this session
// has not — or not yet — followed, letting the backfill read posts made
// before the bot ever joined).
async function fetchChannelPage(session, channelId, paging) {
  let messages;
  try {
    messages = await getChannelMessages(session, channelId, paging);
  } catch {
    const invite = CHANNEL_REF.split('/channel/')[1] || CHANNEL_REF;
    messages = await getChannelPreview(session, invite, paging);
  }
  return Array.isArray(messages) ? messages : (messages?.messages || messages?.data || []);
}

async function processMessages(list, session) {
  let synced = 0;
  for (const message of list) {
    try {
      const saved = await saveChannelMedia(message, session);
      if (saved) synced += 1;
      const link = await saveLink(message, session);
      if (link) synced += 1;
    } catch (error) {
      console.error('[channel-sync] media error', error?.message || error);
    }
  }
  return synced;
}

// Walks every message the channel endpoint hands back and indexes every
// command-tagged image or video it finds.
//
// - deep: true  -> pages backward with offset (SYNC_PAGE_SIZE at a time)
//   until a short/empty page or SYNC_MAX_PAGES is hit. This is what reaches
//   media posted before the channel was ever followed, all the way back to
//   the channel's creation. Meant to run once per session (see
//   startChannelWatcher) and be safe to re-run any time — every page it
//   revisits just re-confirms already-known content-hashes.
// - deep: false -> a single light page of the most recent messages. This is
//   what the 2-second background loop uses, and what bot.js's lazy
//   "fetch on demand" fallback uses, since neither needs to re-walk the
//   whole channel every time.
export async function syncChannelImages(session, { deep = false } = {}) {
  const followed = await ensureChannelFollow(session);
  if (!followed.ok) return followed;
  const channelId = followed.channel.id || followed.channel._id;

  let synced = 0;
  let totalCandidates = 0;

  if (!deep) {
    const list = await fetchChannelPage(session, channelId, SYNC_MESSAGE_LIMIT);
    totalCandidates = list.length;
    synced = await processMessages(list, session);
  } else {
    for (let page = 0; page < SYNC_MAX_PAGES; page += 1) {
      const offset = page * SYNC_PAGE_SIZE;
      const list = await fetchChannelPage(session, channelId, { limit: SYNC_PAGE_SIZE, offset });
      if (!list.length) break;
      totalCandidates += list.length;
      synced += await processMessages(list, session);
      if (list.length < SYNC_PAGE_SIZE) break; // short page = reached the oldest post
    }
    await patchSession(session, { channelDeepSyncCompletedAt: Date.now() });
  }

  await patchSession(session, { lastChannelSyncAt: Date.now(), channelImageCount: countChannelMediaItems() });
  return { ok: true, synced, channelId, totalCandidates, deep };
}

// Silent background watcher: every SCAN_INTERVAL_MS (default 2s), re-checks
// every connected session's channel for newly posted command media. It
// never sends anything to any chat — it only downloads media and writes to
// the store, so nothing about it is visible in WhatsApp itself.
//
// The very first time a given session is seen, a one-off deep backfill runs
// first so the command database ends up covering the channel's ENTIRE
// history (back to its creation), not just whatever the light tick's small
// recent window can see. After that, only light ticks run for that session
// — the deep pass has already indexed everything older, and light ticks are
// what actually deliver the "every 2 seconds" freshness for new posts.
const deepSyncStarted = new Set();
let watcherTimer = null;

export function startChannelWatcher() {
  if (watcherTimer) return () => clearInterval(watcherTimer);

  const tick = async () => {
    const sessions = listSessions().filter((s) => !s.removed && s.status === 'WORKING');
    for (const s of sessions) {
      const name = s.name;
      try {
        if (!deepSyncStarted.has(name) && !getSession(name)?.channelDeepSyncCompletedAt) {
          deepSyncStarted.add(name);
          // Fire-and-forget: don't block the 2s light-tick loop on a full
          // history walk, which can take a while on a large channel.
          syncChannelImages(name, { deep: true }).catch((e) =>
            console.error('[channel-watcher] deep backfill failed:', name, e?.message || e)
          );
        }
        await syncChannelImages(name, { deep: false });
      } catch (error) {
        console.error('[channel-watcher] tick failed:', name, error?.message || error);
      }
    }
  };

  tick().catch((e) => console.error('[channel-watcher] initial tick:', e?.message || e));
  watcherTimer = setInterval(() => tick().catch((e) => console.error('[channel-watcher] tick:', e?.message || e)), SCAN_INTERVAL_MS);
  watcherTimer.unref?.();
  return () => clearInterval(watcherTimer);
}

// Live top-up: as soon as a new image/video lands in the channel, index it
// immediately rather than waiting for the next full sync.
export async function ingestChannelEvent(session, payload) {
  if (!payload) return;
  const from = payload.from || '';
  const channelId = payload._data?.Info?.Chat || payload._data?.key?.remoteJid || from;
  if (from && !String(from).endsWith('@newsletter') && !String(channelId).endsWith('@newsletter')) return;
  try {
    await saveChannelMedia(payload, session);
    await saveLink(payload, session);
  } catch (error) {
    console.error('[channel-sync] event error', error?.message || error);
  }
}
