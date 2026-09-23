# Orihime MD multi-user deployment

## Safe Render Free mode

Use the bundled all-in-one configuration:

```text
RUN_LOCAL_WAHA=true
MAX_ACTIVE_SESSIONS=1
```

This keeps the application from creating a second GOWS account on the same small Render container. When the limit is reached, `/api/link` returns HTTP 409 with a capacity message instead of starting another WAHA session.

## True multi-user mode

Run WAHA on a separate, properly sized server and keep Render for the Orihime application/API:

```text
RUN_LOCAL_WAHA=false
WAHA_URL=https://your-waha-host.example.com
WAHA_API_KEY=<the API key configured on that WAHA host>
MAX_ACTIVE_SESSIONS=0
```

The Render service will not start `/app/dist/main` in this mode. Orihime talks to the external WAHA instance through `WAHA_URL`.

The session names are generated independently (`orihime_<random-id>`), and group settings are stored with the session name plus group id, so multiple linked WhatsApp accounts can keep separate settings.

## Web response cards

Set:

```text
WEB_PREVIEW_ENABLED=true
```

Bot status responses are sent through WAHA's custom link preview endpoint when available. The link opens the branded `/preview` page. This creates a web-like WhatsApp preview card, but it does not replace WhatsApp's native message container with arbitrary HTML/CSS.

## View-once

`.vv` prefers media already present in the incoming `replyTo` event and also keeps a short in-memory cache. The cache is deliberately small to avoid large media buffers accumulating when several users are active.
