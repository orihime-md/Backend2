Runtime data is written here when DATA_DIR points here.
For Render/production, mount a persistent disk or use an external database.

The WAHA session authentication state is stored by WAHA itself; do not rely on this folder for WAHA auth data.


Command images live individually at repository root and are mapped in commandMedia.js.


AI: add GEMINI_API_KEY in Render. The default model is gemini-3.5-flash-lite.
WAHA session persistence: Render Postgres is wired to WAHA via WHATSAPP_SESSIONS_POSTGRESQL_URL.
Group moderation settings are session-scoped, so multiple linked WhatsApp accounts can operate concurrently without sharing welcome/left/autod/kill-sale state.


Multi-user safety: the Render Free all-in-one configuration limits new pairings to one GOWS session with MAX_ACTIVE_SESSIONS=1. For multiple simultaneous WhatsApp accounts, use RUN_LOCAL_WAHA=false with an appropriately sized external WAHA host.
Web-style responses: WEB_PREVIEW_ENABLED=true uses WAHA custom link previews plus the /preview page; WhatsApp still controls the native message bubble.


New feature bundle: scheduled .close/.open, .split-gc, stronger heuristic .antibot, rapid .prefix-d sign animations with Gemini add/list support, Candy Crush poll controller, .silent-m/.silentF, A-Z language substitution modes, and self-healing group/poll webhooks.

Owner-admin: there is no startup group scan any more. Admin checks read a short-lived per-group participant cache, and every participant/group lookup runs one at a time through a single scan lane (see docs/SPEED.md).

Performance hardening: message.any is not subscribed by default; command messages use a cheap moderation path; intro cleanup is non-blocking; promote/demote verification no longer re-fetches full participant lists.

RapidAPI .play diagnostics: Render logs now include the RapidAPI stage, HTTP status/code, endpoint path, duration, and truncated error detail without logging the API key.

.ai on/off — owner-only. When on, Orihime auto-replies (Gemini) to every
private message, and in groups whenever the linked account is tagged or
replied to. ".ai <question>" keeps working as a direct ask either way.
Needs GEMINI_API_KEY configured.
