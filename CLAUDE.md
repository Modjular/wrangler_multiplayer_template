# CLAUDE.md

## Architecture: lockstep relay

This project runs a **lockstep** netcode model, not a server-authoritative
one. Keep this in mind before changing anything in `GameRoom.js` or `sim.js`.

- **The server never simulates the game.** `src/GameRoom.js` is a dumb
  relay: clients send high-level commands (`move` / `gather` / `drop` /
  `move_block`), the server does minimal shape/bounds validation (`sanitizeCommand` +
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

## World model: stacking, ramps, and the "forklift" rule

Cubes stack in integer-`level` columns (`columnHeight()` in `sim.js`), no
gaps — gather only ever removes the topmost cube. Climbing is gated by
`canStep()`: flat moves and stepping *down* are always legal; stepping *up*
by exactly one level requires a ramp on top of the destination column;
anything more is blocked outright. This is also why gathering or
delivering a cube requires standing at a column exactly level with it
(`findApproachAtHeight`) — you reach sideways at the same height, never up
or down. Two ramps stacked on each other form a full-height "block" that's
only reachable to regrab if some *adjacent* column happens to be at the
right height; that's intentional ("forklift" logic), not a bug.

`approachCells` / `reachableColumns` / `reachableColumnsFromApproach` /
`hasReachableApproach` in `sim.js` re-derive this same rule as a
reachability flood fill, purely so `game.js` can show a UI hint (tint the
delivery-ghost preview red when a planned delivery isn't actually
reachable) without duplicating the stepping logic. If you change
`canStep`/`findApproachAtHeight`, check whether these need the same
change, or the hint and the real outcome will silently disagree — this has
already happened once (seeding the flood fill from a cube's own column
instead of its approach cells, which is one level too tall).

## Client-only rendering tricks must never touch `sim`

Several purely-visual features in `game.js` re-run `sim.js`'s own
deterministic functions (`findPath`, `advanceAlongPath`,
`reachableColumns`, etc.) directly, entirely outside the lockstep
command/step loop:
- **Local move prediction** (`myPrediction`): walks the local player's own
  avatar instantly on click, ahead of the ~200ms lockstep round trip.
- **Delivery-reachability hint** (see above): a reachability flood fill
  computed once at pickup and memoized for the whole drag gesture.
- **A*-traced plan line**: draws the dashed delivery path by reading the
  cube's real `order.path` once picked up — frozen for that phase, not
  re-derived every frame (`frozenDeliverOrigin`), so it holds still and
  can never disagree with where the avatar actually walks. Before pickup
  there's no authoritative route yet, so it's a fresh `findPath` preview
  instead.
- **Movement "juice"** (spring-smoothed follow + lean): a `smoothDamp`-based
  visual chase of the authoritative interpolated position.

None of these mutate `sim` or send anything over the wire — that's what
makes them safe despite running ahead of / independent from the
lockstep loop. If you add another one, keep it strictly read-only against
`sim`; anything that *writes* game state has to go through
`applyCommand`/`step()` so every client computes the identical result.

## Delivery job queue

Each player has a `queue` array (`sim.js`) of pending `move_block` jobs.
If a player is busy (`order.type !== "idle"`) when a `move_block` command
arrives, it's queued instead of dropped or interrupting the active order;
`step()` drains the front of the queue (via the shared `tryStartDeliver`
helper, also used for an immediate start when idle) every tick a player
goes idle, skipping — not getting stuck on — any queued job that's no
longer valid by the time its turn comes up (its cube was taken, its
destination filled up). An explicit `move` or `drop` command clears the
queue, since those are the player taking direct manual control. A new
queueable order kind needs the same three pieces: enqueue-when-busy in
`applyCommand`, a `tryStart*`-style validator, and a drain call in
`step()`.

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
