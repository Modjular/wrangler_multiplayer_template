import { GRID_SIZE, CELL_SIZE, worldToCell, cellCenter } from "../public/js/sim.js";

const IDLE_MS = 5 * 60 * 1000;

// How far in the future (server wall-clock) a relayed command is scheduled to
// execute on every client. This is the lockstep buffer: it has to comfortably
// cover round-trip latency plus each client's clock-offset estimation error,
// so every client has the command queued before its local simulation clock
// reaches execAt. See public/js/game.js for the client side of this.
const INPUT_DELAY_MS = 200;

const VALID_CMD_KINDS = new Set(["move", "gather", "drop"]);
const MAP_BOUND = (GRID_SIZE * CELL_SIZE) / 2;

function randomId() {
  return crypto.randomUUID();
}

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

// Places `count` spawns evenly around a circle inscribed in the grid, then
// snaps each to the center of its grid cell so every client's cube-generation
// (which excludes spawn cells) agrees on exactly which cells are occupied.
function computeSpawns(count) {
  const radius = MAP_BOUND * 0.7;
  const spawns = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const { cx, cz } = worldToCell(x, z);
    spawns.push(cellCenter(cx, cz));
  }
  return spawns;
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.players = new Map(); // playerId -> { id, username, colorIndex, ws }
    this.status = "lobby";
    this.hostId = null;
    this.nextSeq = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/register" && request.method === "POST") {
      await this.state.storage.put("exists", true);
      await this.state.storage.delete("closed");
      return new Response("ok");
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const exists = await this.state.storage.get("exists");
    const closed = await this.state.storage.get("closed");
    if (!exists || closed) {
      return new Response("Session not found or has ended", { status: 404 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    this.handleSession(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  handleSession(ws) {
    const playerId = randomId();

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.onMessage(playerId, ws, msg);
    });

    ws.addEventListener("close", () => {
      this.onDisconnect(playerId).catch(() => {});
    });

    ws.addEventListener("error", () => {
      this.onDisconnect(playerId).catch(() => {});
    });
  }

  onMessage(playerId, ws, msg) {
    this.resetIdleAlarm();

    switch (msg.type) {
      case "join": {
        if (this.status === "playing") {
          ws.send(
            JSON.stringify({ type: "error", message: "Game already in progress." })
          );
          ws.close(4000, "game already started");
          return;
        }

        const player = {
          id: playerId,
          username: String(msg.username || "player").slice(0, 20),
          colorIndex: this.players.size,
          ws,
        };
        this.players.set(playerId, player);

        if (this.hostId === null) {
          this.hostId = playerId;
        }

        ws.send(JSON.stringify({ type: "joined", id: playerId }));
        this.broadcastLobby();
        break;
      }

      case "start_game": {
        if (playerId !== this.hostId) return;
        if (this.status !== "lobby") return;
        this.status = "playing";
        this.nextSeq = 0;

        const ids = [...this.players.keys()];
        const spawns = computeSpawns(ids.length);
        const spawnById = {};
        ids.forEach((id, i) => (spawnById[id] = spawns[i]));

        this.broadcast({
          type: "game_start",
          players: ids.map((id) => ({
            id,
            username: this.players.get(id).username,
            colorIndex: this.players.get(id).colorIndex,
          })),
          spawns: spawnById,
          seed: crypto.getRandomValues(new Uint32Array(1))[0],
        });
        break;
      }

      // One-shot NTP-style clock sample: the client sends its own send time
      // (t0) and we echo it back with our wall clock so the client can
      // estimate the offset between our clocks without us keeping any
      // per-connection timing state.
      case "time_sync": {
        ws.send(
          JSON.stringify({ type: "time_sync_reply", t0: msg.t0, serverNow: Date.now() })
        );
        break;
      }

      case "cmd": {
        const player = this.players.get(playerId);
        if (!player || this.status !== "playing") return;
        const cmd = this.sanitizeCommand(msg.cmd);
        if (!cmd) return;

        this.broadcast({
          type: "cmd",
          playerId,
          seq: this.nextSeq++,
          execAt: Date.now() + INPUT_DELAY_MS,
          cmd,
        });
        break;
      }

      case "ping":
        break;

      default:
        break;
    }
  }

  // We're a dumb relay by design (see CLAUDE.md discussion) — no gold/HP/etc
  // to validate, just enough sanity-checking that a malformed or hostile
  // client can't crash every other client's deterministic sim.
  sanitizeCommand(cmd) {
    if (!cmd || !VALID_CMD_KINDS.has(cmd.kind)) return null;
    if (cmd.kind === "move") {
      if (!isFiniteNumber(cmd.x) || !isFiniteNumber(cmd.z)) return null;
      if (Math.abs(cmd.x) > MAP_BOUND || Math.abs(cmd.z) > MAP_BOUND) return null;
      return { kind: "move", x: cmd.x, z: cmd.z };
    }
    if (cmd.kind === "gather") {
      if (typeof cmd.cubeId !== "string" || cmd.cubeId.length > 32) return null;
      return { kind: "gather", cubeId: cmd.cubeId };
    }
    return { kind: "drop" };
  }

  async onDisconnect(playerId) {
    const wasHost = playerId === this.hostId;
    this.players.delete(playerId);

    if (wasHost) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }

    if (this.players.size === 0) {
      this.status = "lobby";
      this.hostId = null;
      await this.state.storage.put("closed", true);
      await this.state.storage.deleteAlarm();
      return;
    }

    if (this.status === "lobby") {
      this.broadcastLobby();
    } else {
      this.broadcast({ type: "player_left", id: playerId, hostId: this.hostId });
    }
  }

  broadcastLobby() {
    this.broadcast({
      type: "lobby_update",
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        username: p.username,
      })),
      hostId: this.hostId,
    });
  }

  broadcast(messageObj) {
    const data = JSON.stringify(messageObj);
    for (const player of this.players.values()) {
      try {
        player.ws.send(data);
      } catch {
        // ignore send errors from dead sockets; close listener will clean up
      }
    }
  }

  resetIdleAlarm() {
    this.state.storage.setAlarm(Date.now() + IDLE_MS);
  }

  async alarm() {
    this.broadcast({ type: "session_closed", reason: "idle_timeout" });
    for (const player of this.players.values()) {
      try {
        player.ws.close(1000, "idle_timeout");
      } catch {
        // ignore
      }
    }
    this.players.clear();
    this.status = "lobby";
    this.hostId = null;
    await this.state.storage.put("closed", true);
  }
}
