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
import { DATA_DIR, addChannelMedia, getChannelImage, countChannelMediaItems, patchSession, setChannelLink } from './store.js';

const CHANNEL_REF = process.env.ORIHIME_CHANNEL || 'https://whatsapp.com/channel/0029VbDOiYGHVvTTnDNd6I2C';
const MEDIA_DIR = path.join(DATA_DIR, 'channel-media');
const commandLikeCaption = /^(\.[^\s]+)(?:\s+.+)?$/;
const linkCaption = /^\.link\s+(\S+)/i;
// A "thorough" scan: WAHA's message endpoints only take a flat `limit`, no
// cursor/offset, so thoroughness here means asking for a much deeper window
// than the old 100-message default rather than paginating page by page.
const SYNC_MESSAGE_LIMIT = Number(process.env.CHANNEL_SYNC_LIMIT || 500);

function cleanCaption(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
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

// Saves ONE channel media message (image or video) under its command-style
// caption (e.g. ".menu") — a caption can collect several media items over
// time, each kept, so the command can later hand back a random one of them.
async function saveChannelMedia(message, session) {
  const kind = mediaKind(message);
  if (!kind) return null;
  const caption = cleanCaption(message.body);
  if (!caption || !commandLikeCaption.test(caption)) return null;
  const mediaUrl = message.mediaUrl || message.media?.url;
  if (!mediaUrl) return null;

  await fs.mkdir(MEDIA_DIR, { recursive: true });
  const hash = crypto.createHash('sha256').update(`${session}:${message.id}:${mediaUrl}`).digest('hex');
  const mime = message?.media?.mimetype || (kind === 'video' ? 'video/mp4' : 'image/jpeg');
  const ext = extensionFor(kind, mime);
  const outputPath = path.join(MEDIA_DIR, `${hash}.${ext}`);
  try {
    await fs.access(outputPath);
  } catch {
    const downloaded = await downloadMedia(mediaUrl);
    await fs.writeFile(outputPath, downloaded.buffer);
  }

  await addChannelMedia(caption, {
    key: caption,
    session,
    messageId: message.id,
    localPath: outputPath,
    mime,
    kind,
    updatedAt: Date.now()
  });
  return getChannelImage(caption);
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

// Walks every message the channel endpoint hands back and indexes every
// command-tagged image or video it finds — this is the "thorough scan".
export async function syncChannelImages(session) {
  const followed = await ensureChannelFollow(session);
  if (!followed.ok) return followed;
  const channelId = followed.channel.id || followed.channel._id;
  let messages;
  try {
    messages = await getChannelMessages(session, channelId, SYNC_MESSAGE_LIMIT);
  } catch {
    const invite = CHANNEL_REF.split('/channel/')[1] || CHANNEL_REF;
    messages = await getChannelPreview(session, invite, SYNC_MESSAGE_LIMIT);
  }
  const list = Array.isArray(messages) ? messages : (messages?.messages || messages?.data || []);
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
  await patchSession(session, { lastChannelSyncAt: Date.now(), channelImageCount: countChannelMediaItems() });
  return { ok: true, synced, channelId, totalCandidates: list.length };
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
