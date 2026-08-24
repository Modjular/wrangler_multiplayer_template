# Browser Multiplayer Game — MVP Implementation Spec

## Overview
A browser-based multiplayer game for friends. A host creates a session and gets
a shareable URL. Friends join a waiting room, pick a username, and once the
host starts the game, everyone drops into a shared 3D room (three.js) where
they control their own primitive-shaped character. Sessions auto-close after
5 minutes of inactivity.

## Stack
- **Cloudflare Pages** — static frontend (vanilla JS + three.js, no framework)
- **Cloudflare Workers** — API routes + WebSocket upgrade handling
- **Durable Objects (DO)** — one instance per game session; holds authoritative
  in-memory state and manages WebSocket connections
- **Durable Object Alarms** — used for the 5-minute idle auto-close

No database needed for MVP — session state lives entirely in the DO's memory
and disappears when the DO shuts down.

---

## Project Structure

```
/
├── wrangler.toml
├── package.json
├── src/
│   ├── worker.js          # Main Worker entry: routes requests, forwards to DO
│   └── GameRoom.js         # Durable Object class: session state + WS logic
├── public/
│   ├── index.html          # Landing page: "Start Session" button
│   ├── join.html            # Waiting room / lobby (also handles game canvas swap)
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── lobby.js         # WebSocket connect, username entry, player list UI
│       └── game.js          # three.js scene, input handling, render loop
```

---

## Durable Object: `GameRoom`

One DO instance per session, keyed by `env.GAME_ROOM.idFromName(sessionId)`.

### In-memory state
```js
{
  players: Map<playerId, {
    id: string,
    username: string,
    shape: "cube" | "sphere" | "cone" | "cylinder" | "torus",
    x: number, y: number, z: number,
    rotY: number,
    ws: WebSocket
  }>,
  status: "lobby" | "playing",
  hostId: string | null
}
```

### WebSocket message protocol (JSON over WS)

**Client → Server**
| type | payload | notes |
|---|---|---|
| `join` | `{ username }` | sent right after connecting |
| `start_game` | `{}` | only host's message is honored |
| `input` | `{ x, y, z, rotY }` | position update, client-authoritative for MVP |
| `ping` | `{}` | optional heartbeat, also resets idle timer |

**Server → Client (broadcast)**
| type | payload | notes |
|---|---|---|
| `lobby_update` | `{ players: [{id, username}], hostId }` | sent on any join/leave while in lobby |
| `game_start` | `{ players: [{id, username, shape}] }` | triggers client scene swap |
| `state_update` | `{ players: [{id, x, y, z, rotY}] }` | broadcast ~15-20x/sec while playing |
| `player_left` | `{ id }` | remove mesh client-side |
| `session_closed` | `{ reason: "idle_timeout" }` | sent before server closes all sockets |

### Core DO methods
- `fetch(request)` — handles the WebSocket upgrade (`Upgrade: websocket` header),
  accepts the pair, calls `handleSession(ws)`
- `handleSession(ws)` — attaches message/close listeners, adds player to state
  on `join`
- `broadcast(messageObj)` — iterate `players`, `ws.send(JSON.stringify(...))`
- `resetIdleAlarm()` — call `this.state.storage.setAlarm(Date.now() + 5*60*1000)`
  on **every** received message (join, input, ping, etc.)
- `alarm()` — DO's built-in handler, fired when the alarm expires:
  - broadcast `session_closed`
  - close all WebSockets
  - clear state (DO will be evicted naturally after no activity)

### Shape assignment
Cycle through a fixed array on join:
```js
const SHAPES = ["cube", "sphere", "cone", "cylinder", "torus"];
shape = SHAPES[players.size % SHAPES.length];
```

---

## Worker: `worker.js` (routes)

| Route | Method | Purpose |
|---|---|---|
| `/api/session/new` | POST | Generate 6-char session ID, return `{ sessionId, url }` |
| `/api/session/:id/ws` | GET (Upgrade) | Forward to the DO instance for `:id` via `idFromName` |

Session ID generation: 6 random alphanumeric chars (uppercase + digits,
exclude ambiguous chars like `0/O`, `1/I`), giving friend-shareable short codes.

```js
env.GAME_ROOM.idFromName(sessionId) // deterministic mapping, no storage needed to "look up" a room
```

---

## Frontend Pages

### `index.html`
- "Start New Session" button → `POST /api/session/new` → redirect to
  `/join.html?session=<id>` (as host)
- Show the shareable link (`.../join.html?session=<id>`) with a copy button

### `join.html` (handles both lobby AND game states)
1. **Lobby state**
   - Prompt for username (simple text input, store in `sessionStorage`)
   - Open WebSocket: `wss://<worker-domain>/api/session/<id>/ws`
   - Send `{ type: "join", username }`
   - Render live player list from `lobby_update` broadcasts
   - If this client is `hostId`, show a "Start Game" button → sends `start_game`
2. **Game state** (triggered by receiving `game_start`)
   - Hide lobby DOM, show `<canvas>`
   - Hand off to `game.js` to init three.js scene

### `game.js` (three.js client)
- Basic scene: ground plane, ambient + directional light, camera (third-person
  or top-down, whichever is simpler to start — top-down orbit is easiest for MVP)
- On `game_start`: create a mesh per player using their assigned `shape`,
  keyed by `playerId` in a `Map`
- **Input**: WASD / arrow keys (+ on-screen touch joystick or simple touch
  drag for mobile) → compute local position delta → send `input` message
  (throttle to ~15-20/sec, not every frame)
- **Rendering other players**: on `state_update`, lerp each mesh toward the
  new target position (simple `mesh.position.lerp(target, 0.3)` per frame)
  rather than snapping, to smooth over network tick gaps
- Own player: can render immediately on local input (client-side prediction)
  since there's no server validation in MVP anyway

---

## wrangler.toml (sketch)

```toml
name = "multiplayer-game"
main = "src/worker.js"
compatibility_date = "2025-01-01"

[[durable_objects.bindings]]
name = "GAME_ROOM"
class_name = "GameRoom"

[[migrations]]
tag = "v1"
new_classes = ["GameRoom"]

[assets]
directory = "./public"
```

(Pages + Worker + DO can be deployed together via a single Worker with static
assets, using the newer `[assets]` config — simpler than managing Pages and
Workers as two separate deployments for an MVP.)

---

## Build Order (suggested)

1. Scaffold `wrangler.toml`, empty `GameRoom` DO, confirm `wrangler dev` runs
2. Implement `/api/session/new` + WebSocket upgrade routing to the DO
3. Implement lobby join/broadcast logic in the DO, wire up `join.html` + `lobby.js`
4. Test 2+ browser tabs joining the same session, confirm player list syncs
5. Add `start_game` → `game_start` broadcast, stub three.js scene with static shapes
6. Wire up movement: client input → `input` message → DO updates state →
   `state_update` broadcast → other clients lerp
7. Add idle alarm (`resetIdleAlarm()` on every message, `alarm()` handler)
8. Polish: mobile touch controls, copy-link button, basic styling

---

## Known MVP Tradeoffs (worth knowing, not necessarily fixing now)
- **No anti-cheat**: positions are client-authoritative and trusted as-is.
  Fine for friends; would need server-side validation for anything adversarial.
- **No reconnect grace period**: a dropped connection removes the player
  immediately; they rejoin fresh with the same URL.
- **No persistence**: session state is lost when the DO shuts down (by design
  for MVP — nothing to clean up).
- **No horizontal scaling concerns**: each session's DO is single-threaded by
  Cloudflare's design, so simultaneous state writes are naturally serialized —
  no race conditions to worry about.
