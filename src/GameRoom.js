const SHAPES = ["cube", "sphere", "cone", "cylinder", "torus"];
const IDLE_MS = 5 * 60 * 1000;

// Half-height of each shape's geometry, i.e. the y a mesh needs to rest on
// the ground plane. Must match public/js/game.js's SHAPE_REST_Y.
const SHAPE_REST_Y = {
  cube: 0.5,
  sphere: 0.6,
  cone: 0.6,
  cylinder: 0.6,
  torus: 0.7,
};

function randomId() {
  return crypto.randomUUID();
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.players = new Map(); // playerId -> { id, username, shape, x, y, z, rotY, ws }
    this.status = "lobby";
    this.hostId = null;
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
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
      this.onDisconnect(playerId);
    });

    ws.addEventListener("error", () => {
      this.onDisconnect(playerId);
    });
  }

  onMessage(playerId, ws, msg) {
    this.resetIdleAlarm();

    switch (msg.type) {
      case "join": {
        const shape = SHAPES[this.players.size % SHAPES.length];
        const player = {
          id: playerId,
          username: String(msg.username || "player").slice(0, 20),
          shape,
          x: 0,
          y: SHAPE_REST_Y[shape],
          z: 0,
          rotY: 0,
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
        this.broadcast({
          type: "game_start",
          players: [...this.players.values()].map((p) => ({
            id: p.id,
            username: p.username,
            shape: p.shape,
          })),
        });
        break;
      }

      case "input": {
        const player = this.players.get(playerId);
        if (!player || this.status !== "playing") return;
        player.x = Number(msg.x) || 0;
        player.y = Number(msg.y) || 0;
        player.z = Number(msg.z) || 0;
        player.rotY = Number(msg.rotY) || 0;
        this.broadcastState();
        break;
      }

      case "ping":
        break;

      default:
        break;
    }
  }

  onDisconnect(playerId) {
    const wasHost = playerId === this.hostId;
    this.players.delete(playerId);

    if (wasHost) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }

    if (this.status === "lobby") {
      this.broadcastLobby();
    } else {
      this.broadcast({ type: "player_left", id: playerId });
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

  broadcastState() {
    this.broadcast({
      type: "state_update",
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        z: p.z,
        rotY: p.rotY,
      })),
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
  }
}
