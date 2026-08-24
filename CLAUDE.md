# CLAUDE.md

## Local dev server

The user often already has `npm run dev` (`wrangler dev`, port 8787) running
in another terminal before starting a session with you. **Check if something
is already listening on :8787 before starting or killing a dev server**.
If you need your own instance for scripted testing, use a different port
(`wrangler dev --port <other>`) instead of touching the user's.

## Local Explorer API

`wrangler dev` exposes a local subset of the Cloudflare API for inspecting
and modifying resource state (KV, R2, D1, Durable Objects, Workflows) at:

```
http://localhost:8787/cdn-cgi/local/explorer/api
```

Fetch that URL directly to get the full OpenAPI schema of available
operations. This project only uses **Durable Objects** (`GAME_ROOM` binding,
`GameRoom` class) — the KV/R2/D1/Workflows parts of the API don't apply here.

Useful calls for this project:

```bash
# List DO namespaces
curl -s http://localhost:8787/cdn-cgi/local/explorer/api/workers/durable_objects/namespaces

# List live GameRoom instances (each = one game session)
curl -s http://localhost:8787/cdn-cgi/local/explorer/api/workers/durable_objects/namespaces/multiplayer-game-GameRoom/objects
```

Notes:
- `GameRoom` uses plain key-value `storage.get/put` (not the SQLite storage
  API), so `use_sqlite` is `false` for its namespace and the `/query` (SQLite)
  endpoint doesn't work against it — there's no way to peek at individual
  storage keys through this API for our DO, only list which instances exist
  and whether they have stored data (`hasStoredData`).
- Handy for confirming session-lifecycle behavior (e.g. that a closed/expired
  session's DO still shows `hasStoredData: true` for its `closed` flag,
  without needing a scripted WebSocket test).
