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
  '.menu': '15-menu.png',
  '.link': '16-link.png',
  '.welcome on': '17-welcome-on.jpg',
  '.public': '18-public.png',
  '.private': '19-private.png',
  '.tagall': '20-tagall.png'
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

export async function readCommandMedia(key) {
  const filename = commandMediaFilename(key);
  if (!filename) return null;
  const filePath = path.join(ROOT, filename);
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.webp' ? 'image/webp'
      : ext === '.gif' ? 'image/gif'
      : 'image/png';
    return { filename, filePath, mime, data };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
