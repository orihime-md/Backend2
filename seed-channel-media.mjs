// seed-channel-media.mjs
//
// One-off importer that wires a folder of local images into the SAME
// command -> media mapping that channelSync.js builds when someone posts
// to the followed WhatsApp channel. Run this once and .joke, .antilink on,
// etc. will immediately have media without ever posting to the channel.
//
// WHERE THIS GOES
//   Drop this file in the project root, next to store.js / bot.js.
//   Put the /media folder (the 20 renamed images) next to it too, or point
//   MEDIA_SEED_DIR at wherever you kept them.
//
// HOW TO RUN
//   node seed-channel-media.mjs
//   (uses the same DATABASE_URL / DATA_DIR env vars your bot already uses,
//   so it seeds whichever backend — Postgres or local data/state.json —
//   the running bot actually reads from)
//
// WHY THIS DOESN'T BLOAT THE DATABASE
//   Exactly like a real channel post: the image bytes are written ONCE to
//   disk under DATA_DIR/channel-media/<sha256>.<ext>. Only a small metadata
//   row (key, localPath, mime, hash, timestamps) goes into the database via
//   addChannelMedia/registerMediaHash — the same functions channelSync.js
//   itself calls. No base64, no blobs, no duplicate files: re-running this
//   script is safe and will not write the same image twice (content-hash
//   dedup, same as the live sync).
//
// SAFE TO RE-RUN: already-seeded images are skipped by content hash.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  initStore,
  DATA_DIR,
  addChannelMedia,
  registerMediaHash,
  findMediaHash
} from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = path.join(DATA_DIR, 'channel-media');
const SEED_DIR = process.env.MEDIA_SEED_DIR || path.join(__dirname, 'media');

// filename in ./media  ->  command key (must match commandKeyFromCaption()
// in channelSync.js exactly: lowercase command, plus a literal " on"/" off"
// only for genuine toggle commands).
const MAPPING = [
  ['01-joke.png', '.joke'],
  ['02-antilink-on.png', '.antilink on'],
  ['03-antichannel-on.jpg', '.antichannel on'],
  ['04-antibot-on.png', '.antibot on'],
  ['05-candycrush.png', '.candycrush'],
  ['06-setprefix.png', '.setprefix'],
  ['07-antidemote-on.jpg', '.antidemote on'],
  ['08-open.png', '.open'],
  ['09-left-on.png', '.left on'],
  ['10-kill-sale-on.jpg', '.kill-sale on'],
  ['11-repel.jpg', '.repel'],
  ['12-close.png', '.close'],
  ['13-ping.png', '.ping'],
  // .antipromote is a toggle command (like .antidemote) — the code always
  // looks up ".antipromote on" / ".antipromote off", never a bare key, so
  // this is seeded as the "on" state. Re-run with a different image under
  // '.antipromote off' any time to add that state too.
  ['14-antipromote-on.png', '.antipromote on'],
  ['15-menu.png', '.menu'],
  ['16-link.png', '.link'],
  ['17-welcome-on.jpg', '.welcome on'],
  ['18-public.png', '.public'],
  ['19-private.png', '.private'],
  ['20-tagall.png', '.tagall']
];

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

async function seedOne(filename, key) {
  const srcPath = path.join(SEED_DIR, filename);
  const ext = path.extname(filename).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'image/jpeg';

  const buffer = await fs.readFile(srcPath);
  const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');

  // Same dedup rule as the live channel sync: if this exact image's bytes
  // are already known, reuse the stored file instead of writing a copy.
  const known = findMediaHash(contentHash);
  const localPath = known?.localPath || path.join(MEDIA_DIR, `${contentHash}${ext}`);

  if (!known) {
    await fs.mkdir(MEDIA_DIR, { recursive: true });
    await fs.writeFile(localPath, buffer);
  }

  await registerMediaHash(contentHash, { localPath, kind: 'image', mime, firstKey: known?.firstKey || key });

  await addChannelMedia(key, {
    key,
    caption: key,
    session: 'manual-seed',
    messageId: `seed:${key}:${contentHash.slice(0, 12)}`,
    localPath,
    contentHash,
    mime,
    kind: 'image',
    updatedAt: Date.now()
  });

  console.log(`✔ ${key}  <-  ${filename}${known ? '  (reused existing file, same content)' : ''}`);
}

async function main() {
  await initStore();
  for (const [filename, key] of MAPPING) {
    try {
      await seedOne(filename, key);
    } catch (error) {
      console.error(`✘ ${key}  <-  ${filename}:`, error?.message || error);
    }
  }
  console.log('\nDone. Media dir:', MEDIA_DIR);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
