# Speed notes

## After a number is linked (session -> WORKING)
1. Session status saved (in memory; database write is deferred).
2. Owner/self ids are warmed into cache (`warmSession`): one WAHA `/me` call, plus
   `check-exists` + `contacts` only if BOT_OWNER_PHONE is set. Nothing else runs.
3. No group scan. No message history read.
4. On boot the webhook config is only re-pushed to a session if it differs.

## When a message arrives (silent path)
1. Webhook is acknowledged at once; processing is not awaited.
2. Fast path (memory only): drop channel/status traffic, drop messages older than
   MAX_MESSAGE_AGE_S (backlog), drop duplicates.
3. Not a command / menu tap and no feature needs it (antilink, antibot, antispam,
   antidelete, kill-sale, badwords, auto-delete, language mode) -> ignored, zero WAHA calls.
4. Command -> its own lane per (chat, sender, command). A slow .menu/.play/.ai never
   blocks .ping or anyone else. The same command repeated is still ordered.
5. Reply is sent. Logging and decorations never block it.

## Heavy reads
Participant/group lookups go through one scan lane: one at a time, identical
lookups share one request, 12 s timeout (SCAN_CONCURRENCY, SCAN_TIMEOUT_MS).

## .menu
Text menu first, then the (2.6 MB, pre-encoded, cached) video with a short caption,
then the poll. The poll never waits longer than MENU_VIDEO_WAIT_MS for the video.
Hard video timeout (MENU_VIDEO_TIMEOUT_MS); 3 failures in a row -> text-only menu for
5 minutes. Original 9 MB video is not needed at runtime.

## Switches (all env vars)
COMMAND_INTRO, COMMAND_ANIMATIONS, MENU_NATIVE_BUTTONS, MAX_MESSAGE_AGE_S,
WAHA_EVENTS_DOWNLOAD_MEDIA, WAHA_GLOBAL_WEBHOOK, PERSIST_DEBOUNCE_MS.

## .ai on/off (auto-reply)
Session-level flag (`aiAuto`), owner-only to toggle. When on:
- Every private message gets an automatic AI reply (Gemini).
- In groups, only a message that @-tags the linked account or replies to one
  of its messages gets a reply — the fast path never even looks at ordinary
  group chatter, so this adds no cost to a busy group.
`.ai <question>` (asking directly) always works regardless of the toggle.
Requires GEMINI_API_KEY; turning it on without one is refused up front.
