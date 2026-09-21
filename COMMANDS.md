# Orihime MD command map

| Category | Commands |
|---|---|
| BOT | `.ping`, `.setprefix`, `.public`, `.private` |
| FUN | `.blague`, `.joke`, `.orihime-wipe`, `.orihime-history` |
| ADMIN | `.antibot on/off`, `.antichannel on/off`, `.antilink on/off`, `.kill-sale on/off` |
| GAMES | `.candy`, `.candycrush`, `.crossword`, `.wordgame`, `.2048 up/down/left/right` |
| GROUP | `.kick @user`, `.add <phone number>`, `.kickall confirm`, `.tagall`, `.hidetag <message>`, `.invite`, `.left on/off`, `.leave`, `.promote @user`, `.demote @user`, `.announcement <text>`, `.close`, `.open`, `.group-id`, `.welcome on/off`, `.autod @user` |
| INTERNAL | `.menu`, `.repel` |

## Permission rules

- Owner-only: `.setprefix`, `.public`, `.private`.
- Group-admin-only: moderation/group commands.
- `.kill-sale on`: any group message containing sale/price/availability keywords is deleted, unless the sender is a group admin.
- `.add <phone number>`: the bot must be a group admin; pass digits only (with or without a leading `+`).
- Private mode: only the linked WhatsApp account owner can invoke normal commands.
- The bot must itself be a group admin for participant removal/promotion/demotion/invite operations.
