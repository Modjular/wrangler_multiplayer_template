export { GameRoom } from "./GameRoom.js";

const ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I

function generateSessionId(length = 6) {
  let id = "";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (let i = 0; i < length; i++) {
    id += ID_CHARS[bytes[i] % ID_CHARS.length];
  }
  return id;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/session/new" && request.method === "POST") {
      const sessionId = generateSessionId();
      const id = env.GAME_ROOM.idFromName(sessionId);
      const stub = env.GAME_ROOM.get(id);
      await stub.fetch("https://game-room/register", { method: "POST" });

      return Response.json({
        sessionId,
        url: `${url.origin}/join.html?session=${sessionId}`,
      });
    }

    const wsMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/ws$/);
    if (wsMatch) {
      const sessionId = wsMatch[1];
      const id = env.GAME_ROOM.idFromName(sessionId);
      const stub = env.GAME_ROOM.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
