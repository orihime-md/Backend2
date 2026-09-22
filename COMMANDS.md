# Orihime MD command map

| Category | Commands |
|---|---|
| BOT | `.ping`, `.setprefix`, `.public`, `.private` |
| FUN | `.blague`, `.joke`, `.orihime-wipe`, `.orihime-history` |
| ADMIN | `.antibot on/off`, `.antichannel on/off`, `.antilink on/off`, `.kill-sale on/off`, `.kill-sale set/add/remove/list/reset`, `.antidemote on/off`, `.antipromote on/off` |
| GAMES | `.candy`, `.candycrush`, `.crossword`, `.wordgame`, `.2048 up/down/left/right` |
| GROUP | `.kick @user`, `.add <phone number>`, `.kickall confirm`, `.tagall`, `.hidetag <message>`, `.invite`, `.left on/off`, `.leave`, `.promote @user`, `.demote @user`, `.announcement <text>`, `.close`, `.open`, `.group-id`, `.listadmin`, `.vv`, `.welcome on/off`, `.autod @user on/off` |
| PUBLIC | `.link`, `.pair <number>`, `.ai <question>` |
| INTERNAL | `.menu`, `.repel` |

## Permission rules

- Owner-only: `.setprefix`, `.public`, `.private`.
- Group-admin-only: `.kick`, `.promote`, `.demote`, `.add`, `.kickall`, `.tagall`, `.hidetag`, `.invite`, `.leave`, `.autod`, `.announcement`, `.close`/`.open`, `.group-id`, `.antibot`/`.antichannel`/`.antilink`/`.kill-sale`/`.antidemote`/`.antipromote`.
- Open to any group member: `.welcome on/off`, `.left on/off`.
- Public even in PRIVATE mode: `.link`, `.pair <number>`.
- `.kick` / `.promote` / `.demote` accept @mentions, a bare `@number`, or a reply to the target's message. Multiple targets are supported.
- The bot must itself be a group admin for participant-management commands.

## Media architecture

Command images are **not** loaded from WhatsApp Channels. There is no channel-media database, channel backfill, channel watcher, or channel-sync step in the command-response path.

Every supplied command image is an individual file in the **repository root**. `.close` is shipped as JPEG because WAHA recommends JPEG for image delivery. citeturn641259search0 The mapping is defined in `commandMedia.js`, for example:

```text
15-menu.png             -> .menu
13-ping.png             -> .ping
08-open.png             -> .open
12-close.png            -> .close
14-antipromote-on.png   -> .antipromote on
07-antidemote-on.jpg    -> .antidemote on
```

A command with no dedicated uploaded asset falls back to its normal formatted text response. It never returns a “Channel media … is not synchronized yet” error.

To change a command image, replace the corresponding root-level file in GitHub using the same filename, or update the mapping in `commandMedia.js`.

## Menu animation

`.menu` first sends the local `15-menu.png` image, then edits the **same image caption** through a sequence of short Orihime-themed loading frames before settling on the complete menu text. This keeps the animation inside one media message instead of sending a stream of separate menu images. WAHA supports editing media captions for GOWS in the documented message-edit endpoint.

The menu can still attempt WAHA's interactive list after the animated media menu. When the running WAHA engine/tier does not support that interactive endpoint, the animated local menu remains the reliable fallback.

## Admin-command reliability

`.promote`, `.demote`, `.kick`, and `.autod` now resolve targets against the group's actual participant records instead of trusting one identifier format. This matters on WhatsApp/WAHA deployments where a participant can appear as a phone JID or an `@lid`. The code checks the deeper participants-v2 list when needed, canonicalizes to the participant phone JID when available, submits the documented participant object shape, and verifies promote/demote by reading the resulting group role.

`.antidemote` and `.antipromote` use the same target-resolution path and protect themselves from reacting to their own corrective action.

## Removed files / data

Delete the old `channelSync.js` and `seed-channel-media.mjs` files. The old root `media/` directory is also no longer used; the 20 supplied images belong individually at the repository root.

### AI

`.ai <question or request>` calls Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`). The only secret required in Render is `GEMINI_API_KEY`; the API key is read from the environment and never exposed to WhatsApp users. Google documents `GEMINI_API_KEY` as a supported environment-variable configuration and lists `gemini-3.5-flash-lite` as a stable model.

### Multi-user/session isolation

WAHA supports multiple sessions in one container and supports PostgreSQL session storage. This build stores WAHA authentication/session state in PostgreSQL through `WHATSAPP_SESSIONS_POSTGRESQL_URL`, scopes group settings by session, serializes work per session/chat instead of globally, and makes interactive-menu failure state session-local.

### Welcome/left events

Member welcomes/farewells use `group.v2.participants` with `type: join` or `type: leave`, matching WAHA's documented event payload. `group.v2.join`/`group.v2.leave` describe the linked account itself joining/leaving a group and are not used as member welcome triggers.

## Link command
`.link` sends exactly these two URLs:
- Bot: `https://orihime-md.github.io/-.com/`
- Channel: `https://whatsapp.com/channel/0029VbDOiYGHVvTTnDNd6I2C`
