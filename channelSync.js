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
import { DATA_DIR, setChannelImage, getChannelImage, listChannelImages, patchSession, setChannelLink } from './store.js';

const CHANNEL_REF = process.env.ORIHIME_CHANNEL || 'https://whatsapp.com/channel/0029VbDOiYGHVvTTnDNd6I2C';
const MEDIA_DIR = path.join(DATA_DIR, 'channel-media');
const commandLikeCaption = /^(\.[^\s]+)(?:\s+.+)?$/;
const linkCaption = /^\.link\s+(\S+)/i;

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

function isImageMessage(message) {
  const mime = message?.media?.mimetype || '';
  return Boolean(message?.hasMedia && ((mime && mime.startsWith('image/')) || message?.mediaUrl || message?.media?.url));
}

async function saveImage(message, session) {
  if (!isImageMessage(message)) return null;
  const caption = cleanCaption(message.body);
  if (!caption || !commandLikeCaption.test(caption)) return null;
  const mediaUrl = message.mediaUrl || message.media?.url;
  if (!mediaUrl) return null;

  await fs.mkdir(MEDIA_DIR, { recursive: true });
  const hash = crypto.createHash('sha256').update(`${session}:${message.id}:${mediaUrl}`).digest('hex');
  const ext = (message?.media?.mimetype || '').includes('png') ? 'png' : ((message?.media?.mimetype || '').includes('webp') ? 'webp' : 'jpg');
  const outputPath = path.join(MEDIA_DIR, `${hash}.${ext}`);
  try {
    await fs.access(outputPath);
  } catch {
    const downloaded = await downloadMedia(mediaUrl);
    await fs.writeFile(outputPath, downloaded.buffer);
  }

  await setChannelImage(caption, {
    key: caption,
    session,
    messageId: message.id,
    localPath: outputPath,
    mime: message?.media?.mimetype || 'image/jpeg',
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

export async function syncChannelImages(session) {
  const followed = await ensureChannelFollow(session);
  if (!followed.ok) return followed;
  const channelId = followed.channel.id || followed.channel._id;
  let messages;
  try {
    messages = await getChannelMessages(session, channelId, 100);
  } catch {
    const invite = CHANNEL_REF.split('/channel/')[1] || CHANNEL_REF;
    messages = await getChannelPreview(session, invite, 100);
  }
  const list = Array.isArray(messages) ? messages : (messages?.messages || messages?.data || []);
  let synced = 0;
  for (const message of list) {
    try {
      const saved = await saveImage(message, session);
      if (saved) synced += 1;
      const link = await saveLink(message, session);
      if (link) synced += 1;
    } catch (error) {
      console.error('[channel-sync] media error', error?.message || error);
    }
  }
  await patchSession(session, { lastChannelSyncAt: Date.now(), channelImageCount: Object.keys(listChannelImages()).length });
  return { ok: true, synced, channelId, totalCandidates: list.length };
}

export async function ingestChannelEvent(session, payload) {
  if (!payload) return;
  const from = payload.from || '';
  const channelId = payload._data?.Info?.Chat || payload._data?.key?.remoteJid || from;
  const expected = getChannelImage('_meta')?.channelId;
  if (from && !String(from).endsWith('@newsletter') && !String(channelId).endsWith('@newsletter')) return;
  try {
    await saveImage(payload, session);
    await saveLink(payload, session);
  } catch (error) {
    console.error('[channel-sync] event error', error?.message || error);
  }
  if (expected && channelId !== expected) return;
}
