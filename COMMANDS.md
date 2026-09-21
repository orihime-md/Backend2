# Orihime MD command map

| Category | Commands |
|---|---|
| BOT | `.ping`, `.setprefix`, `.public`, `.private` |
| FUN | `.blague`, `.joke`, `.orihime-wipe`, `.orihime-history` |
| ADMIN | `.antibot on/off`, `.antichannel on/off`, `.antilink on/off`, `.kill-sale on/off`, `.antidemote on/off`, `.antipromote on/off` |
| GAMES | `.candy`, `.candycrush`, `.crossword`, `.wordgame`, `.2048 up/down/left/right` |
| GROUP | `.kick @user`, `.add <phone number>`, `.kickall confirm`, `.tagall`, `.hidetag <message>`, `.invite`, `.left on/off`, `.leave`, `.promote @user`, `.demote @user`, `.announcement <text>`, `.close`, `.open`, `.group-id`, `.listadmin`, `.vv` (reply to a view-once message to reveal it; never stored), `.welcome on/off`, `.autod @user` |
| PUBLIC | `.link`, `.pair <number>` — usable by anyone, in any group, admin or not, and even while the session is in PRIVATE mode |
| INTERNAL | `.menu`, `.repel` |

## Permission rules

- Owner-only: `.setprefix`, `.public`, `.private`.
- Group-admin-only: `.kick`, `.promote`, `.demote`, `.add`, `.kickall`, `.tagall`, `.hidetag`, `.invite`, `.leave`, `.autod`, `.announcement`, `.close`/`.open`, `.group-id`, `.antibot`/`.antichannel`/`.antilink`/`.kill-sale`/`.antidemote`/`.antipromote`.
- Open to any group member (no admin required): `.welcome on/off`, `.left on/off`.
- Always public, regardless of the session's PRIVATE/PUBLIC mode: `.link`, `.pair <number>`.
- `.kick` / `.promote` / `.demote` accept one or more @mentions, a bare `@number` typed as an arg, or (with no mention at all) fall back to whoever sent the message you replied to.
- `.kill-sale on`: any group message containing sale/price/availability keywords is deleted, unless the sender is a group admin.
- `.add <phone number>`: the bot must be a group admin; pass digits only (with or without a leading `+`).
- Private mode: only the linked WhatsApp account owner can invoke normal commands (except `.link` and `.pair`, see above).
- The bot must itself be a group admin for participant removal/promotion/demotion/invite operations.

## New / changed in this pass

- **`.autod @user`** — fixed: it now records every identifier WhatsApp has for
  the target (phone JID and @lid, when the engine exposes one), and matching
  on incoming messages checks every identifier a message could be tagged
  with. Previously it only stored/matched one form, so messages from a
  target whose messages arrived under the other identifier were never
  deleted.
- **`.kick` / `.promote` / `.demote`** — fixed the mention detection that was
  silently failing on some WAHA engines (it only checked one payload field).
  It now deep-scans the payload for a mention list under any casing, accepts
  a bare `@number`, or falls back to the participant of a replied-to message,
  and supports mentioning more than one person at once.
- **`.antidemote on/off`** — if another admin demotes an admin, that admin is
  re-promoted within seconds. Never applies to the bot's own role.
- **`.antipromote on/off`** — if an admin promotes someone, they're demoted
  back within seconds. The two features won't fight each other or loop.
- **`.link`** — public, sends a structured card with the official channel
  link and a `wa.me` link to chat with the bot directly (plus the current
  group's invite link when the bot is a group admin there). The channel link
  is captured automatically: post a plain text message in the followed
  channel that starts with `.link ` followed by the URL, e.g.
  `.link https://whatsapp.com/channel/xxxxx`.
- **`.pair <number>`** — public, in-chat equivalent of the web dashboard's
  "Connect a new account": generates a brand-new Orihime session and pairing
  code for that phone number, with a step-by-step guide, right in the chat.
- Every message the bot auto-deletes (antilink/antichannel/antibot/kill-sale/
  autod) is now followed by a warning message that tags the sender, so
  removals are never silent.
- The web dashboard no longer has any admin/dashboard token — every route,
  including pairing, is open. Lock the backend down with your own
  reverse-proxy auth if you need that.
