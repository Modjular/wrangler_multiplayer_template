# CLAUDE.md

## Architecture: lockstep relay

This project runs a **lockstep** netcode model, not a server-authoritative
one. Keep this in mind before changing anything in `GameRoom.js` or `sim.js`.

- **The server never simulates the game.** `src/GameRoom.js` is a dumb
  relay: clients send high-level commands (`move` / `gather` / `drop`), the
  server does minimal shape/bounds validation (`sanitizeCommand` +
  `VALID_CMD_KINDS`) so a malformed or hostile client can't crash *other*
  clients' sims, stamps each command with a sequence number and an `execAt`
  timestamp (`Date.now() + INPUT_DELAY_MS`, currently 200ms), and broadcasts
  it to every connected client — including the sender. There is no
  server-side world state: no player positions, no cube positions, nothing.
- **Every client runs an identical simulation** in `public/js/sim.js`: a
  pure, deterministic module (must stay free of `Date.now()`,
  `Math.random()`, DOM/THREE imports — anything non-deterministic causes
  clients to silently diverge) driven by `applyCommand()` and a fixed-step
  `step()`. Cube layout is derived from a server-issued match `seed` via a
  seeded PRNG (`mulberry32`), so it never needs to go over the wire.
- **`INPUT_DELAY_MS`** (200ms, in `GameRoom.js`) is the lockstep buffer: it
  has to comfortably exceed round-trip latency plus clock-offset error so
  every client has a command queued *before* its local sim clock reaches
  `execAt`. This — not a server-authoritative state — is what keeps sims in
  sync. If you see desync bug reports, this constant and clock-sync accuracy
  are the first places to look.
- **Clock sync** is a one-shot NTP-style exchange (`time_sync` /
  `time_sync_reply`) each client does on load, used only to translate a
  command's `execAt` into that client's local timeline.
- **Render loop** (`public/js/game.js`) steps the sim at a fixed 20Hz
  (`TICK_MS`) independent of display frame rate, then interpolates between
  the last two snapshots for smooth rendering. Interpolation is
  render-only and never feeds back into the sim.

**Implication for new features:** the server intentionally has zero game
semantics beyond validating command *shape* — no HP/gold/inventory
authority, no cheat detection beyond bounds-checking `move` targets. Adding
a new command kind means updating *both* `sanitizeCommand`/`VALID_CMD_KINDS`
in `GameRoom.js` *and* `applyCommand` in `sim.js`; if those two drift, the
result is a silent per-client desync, not a crash, so it's easy to miss in
testing. If a future feature needs real anti-cheat or authoritative state,
that's a deliberate architecture change, not an incremental tweak — flag it
rather than bolting server-side validation onto one command at a time.

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
