# CLAUDE.md

## Local dev server

The user often already has `npm run dev` (`wrangler dev`, port 8787) running
in another terminal before starting a session with you. **Check if something
is already listening on :8787 before starting or killing a dev server**.
If you need your own instance for scripted testing, use a different port
(`wrangler dev --port <other>`) instead of touching the user's. A different
port alone is NOT enough isolation, though: by default all `wrangler dev`
instances in this project share the same `.wrangler/state` directory
regardless of port. Never run `rm -rf .wrangler/state` (or otherwise touch
that directory) while the user's dev server might be running — pass
`--persist-to <tmp-dir>` to your own test instance instead to keep it fully
separate.

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
- `GameRoom` is declared with `new_sqlite_classes` in `wrangler.toml` (required
  for Durable Objects on the Workers free plan / any new DO namespace as of
  2026), so `use_sqlite` is `true` for its namespace.
- Despite that, the `/query` (SQLite) endpoint still returns an error against
  it: it requires the DO class to `extends DurableObject` from
  `cloudflare:workers` (the newer RPC-style base class), and `GameRoom` is a
  plain class using the legacy `fetch()`-handler style. So there's no way to
  peek at individual storage keys (`exists`/`closed` flags, etc.) through
  this API for our DO — only list which instances exist and whether they
  have stored data (`hasStoredData`).
- Handy for confirming session-lifecycle behavior (e.g. that a closed/expired
  session's DO still shows `hasStoredData: true` for its `closed` flag,
  without needing a scripted WebSocket test).
