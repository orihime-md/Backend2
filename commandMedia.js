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

// In-memory cache: command images are static repo files, so read+encode them
// from disk once and reuse the buffer on every later send instead of paying
// disk I/O on every single command.
const MEDIA_CACHE = new Map();

export async function readCommandMedia(key) {
  const filename = commandMediaFilename(key);
  if (!filename) return null;
  if (MEDIA_CACHE.has(filename)) return MEDIA_CACHE.get(filename);
  const filePath = path.join(ROOT, filename);
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.webp' ? 'image/webp'
      : ext === '.gif' ? 'image/gif'
      : ext === '.mp4' ? 'video/mp4'
      : ext === '.webm' ? 'video/webm'
      : ext === '.mov' ? 'video/quicktime'
      : 'image/png';
    const result = { filename, filePath, mime, data };
    MEDIA_CACHE.set(filename, result);
    return result;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
