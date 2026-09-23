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

Owner-admin fast path: when a linked session becomes WORKING, Orihime silently scans each group, locates only the linked owner IDs, saves each group's isAdmin result in the session store, and uses that snapshot for admin permission checks. Normal command permission checks do not enumerate group members.

Performance hardening: message.any is not subscribed by default; command messages use a cheap moderation path; intro cleanup is non-blocking; promote/demote verification no longer re-fetches full participant lists.

RapidAPI .play diagnostics: Render logs now include the RapidAPI stage, HTTP status/code, endpoint path, duration, and truncated error detail without logging the API key.
