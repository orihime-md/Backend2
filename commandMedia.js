import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Uploaded command images live individually at the repository root.
// Replace one of these files in GitHub to change the image a command sends.
const COMMAND_MEDIA = Object.freeze({
  '.joke': '01-joke.png',
  '.blague': '01-joke.png',
  '.antilink on': '02-antilink-on.png',
  '.antichannel on': '03-antichannel-on.jpg',
  '.antibot on': '04-antibot-on.png',
  '.candy': '05-candycrush.png',
  '.candycrush': '05-candycrush.png',
  '.setprefix': '06-setprefix.png',
  '.antidemote on': '07-antidemote-on.jpg',
  '.open': '08-open.png',
  '.left on': '09-left-on.png',
  '.kill-sale on': '10-kill-sale-on.jpg',
  '.repel': '11-repel.jpg',
  '.close': '12-close.jpg',
  '.ping': '13-ping.png',
  '.antipromote on': '14-antipromote-on.png',
  '.link': '16-link.png',
  '.welcome on': '17-welcome-on.jpg',
  '.public': '18-public.png',
  '.private': '19-private.png',
  '.tagall': '20-tagall.png',

  // `.menu` now sends the uploaded video instead of a still image (the old
  // `15-menu.png` was reassigned below to `.group-id`).
  '.menu': '21-menu.mp4',

  // Admin commands that previously had no dedicated asset.
  '.antibot off': '22-antibot-off.png',
  '.antichannel off': '23-antichannel-off.png',
  '.antilink off': '24-antilink-off.png',
  '.antidemote off': '25-antidemote-off.png',
  '.antipromote off': '26-antipromote-off.png',
  '.kill-sale off': '27-kill-sale-off.png',
  // Bare `.kill-sale` covers the list/set/add/remove/reset subcommands,
  // which all fall back to this key when no on/off action is given.
  '.kill-sale': '28-kill-sale.png',

  // Group commands that previously had no dedicated asset.
  '.kick': '29-kick.png',
  '.promote': '30-promote.png',
  '.demote': '31-demote.png',
  '.add': '32-add.png',
  '.kickall': '33-kickall.png',
  '.hidetag': '34-hidetag.png',
  '.invite': '35-invite.png',
  '.leave': '36-leave.png',
  '.autod': '37-autod.png',
  '.announcement': '38-announcement.png',
  '.listadmin': '39-listadmin.png',
  '.split-gc': '40-split-gc.png',
  '.welcome off': '41-welcome-off.png',

  // The old `.menu` image lives on, reassigned to `.group-id`.
  '.group-id': '15-menu.png'
});

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function normalizeKey(key) {
  return String(key || '').trim().toLowerCase();
}

export function listCommandMedia() {
  return { ...COMMAND_MEDIA };
}

export function commandMediaFilename(key) {
  return COMMAND_MEDIA[normalizeKey(key)] || null;
}

// In-memory cache: command media are static repo files, so read AND base64-
// encode them once and reuse the ready-to-send string. (Previously every send
// re-encoded the whole file — for a video that is a multi-megabyte string
// allocation on each .menu.) Bounded LRU so a 512 MB Render instance is safe.
const MEDIA_CACHE = new Map();
const MEDIA_CACHE_MAX_BYTES = Number(process.env.MEDIA_CACHE_MAX_BYTES || 24 * 1024 * 1024);
let mediaCacheBytes = 0;

function mimeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : ext === '.mp4' ? 'video/mp4'
    : ext === '.webm' ? 'video/webm'
    : ext === '.mov' ? 'video/quicktime'
    : 'image/png';
}

function remember(filename, result) {
  const size = result.b64.length + result.data.length;
  MEDIA_CACHE.set(filename, result);
  mediaCacheBytes += size;
  // Evict least-recently-used entries (Map keeps insertion order; hits re-insert).
  while (mediaCacheBytes > MEDIA_CACHE_MAX_BYTES && MEDIA_CACHE.size > 1) {
    const oldest = MEDIA_CACHE.keys().next().value;
    if (oldest === filename) break;
    const old = MEDIA_CACHE.get(oldest);
    mediaCacheBytes -= old.b64.length + old.data.length;
    MEDIA_CACHE.delete(oldest);
  }
}

const MEDIA_LOADING = new Map();

export async function readCommandMedia(key) {
  const filename = commandMediaFilename(key);
  if (!filename) return null;
  const hit = MEDIA_CACHE.get(filename);
  if (hit) {
    MEDIA_CACHE.delete(filename); // refresh LRU position
    MEDIA_CACHE.set(filename, hit);
    return hit;
  }
  // Single-flight: concurrent first requests share one disk read.
  if (MEDIA_LOADING.has(filename)) return MEDIA_LOADING.get(filename);
  const task = (async () => {
    const filePath = path.join(ROOT, filename);
    try {
      const data = await fs.readFile(filePath);
      const result = { filename, filePath, mime: mimeFor(filename), data, b64: data.toString('base64') };
      remember(filename, result);
      return result;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    } finally {
      MEDIA_LOADING.delete(filename);
    }
  })();
  MEDIA_LOADING.set(filename, task);
  return task;
}

// Ready-to-send WAHA file object (base64 already prepared).
export async function commandMediaFile(key) {
  const media = await readCommandMedia(key);
  if (!media) return null;
  return { media, file: { mimetype: media.mime, filename: media.filename, data: media.b64 } };
}

// Loads the hot assets at boot so the first .menu / .ping is as fast as the
// hundredth one.
export async function prewarmCommandMedia(keys = ['.menu', '.ping']) {
  for (const key of keys) {
    try { await readCommandMedia(key); } catch (error) {
      console.error(`[media] prewarm ${key} failed:`, error?.message || error);
    }
  }
}
