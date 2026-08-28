const params = new URLSearchParams(location.search);
const sessionId = params.get("session");

const statusMsg = document.getElementById("status-msg");
const joinForm = document.getElementById("join-form");
const usernameInput = document.getElementById("username-input");
const joinBtn = document.getElementById("join-btn");
const lobbyView = document.getElementById("lobby-view");
const playerList = document.getElementById("player-list");
const startBtn = document.getElementById("start-btn");
const lobbyEl = document.getElementById("lobby");
const canvas = document.getElementById("game-canvas");
const leaveBtn = document.getElementById("leave-btn");
const leaveBtnGame = document.getElementById("leave-btn-game");

if (!sessionId) {
  statusMsg.textContent = "Missing session id. Go back and start a new session.";
  joinForm.style.display = "none";
} else {
  const storedName = sessionStorage.getItem(`username:${sessionId}`);
  if (storedName) usernameInput.value = storedName;
}

let ws = null;
let myId = null;
let currentHostId = null;
let playerCount = 0;
let hasJoined = false;
let leaving = false;
let errorShown = false;

function connect(username) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/api/session/${sessionId}/ws`);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "join", username }));
    joinForm.style.display = "none";
    lobbyView.style.display = "block";
    statusMsg.textContent = "";
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  });

  ws.addEventListener("close", () => {
    if (leaving || errorShown) return;
    if (!hasJoined) {
      statusMsg.textContent = "This session doesn't exist or has ended. Ask your friend for a new link.";
      joinForm.style.display = "block";
      lobbyView.style.display = "none";
    } else {
      statusMsg.textContent = "Disconnected from session.";
    }
  });

  ws.addEventListener("error", () => {
    if (!hasJoined) {
      statusMsg.textContent = "This session doesn't exist or has ended. Ask your friend for a new link.";
    } else {
      statusMsg.textContent = "Connection error.";
    }
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case "joined": {
      hasJoined = true;
      myId = msg.id;
      startBtn.style.display = myId === currentHostId ? "inline-block" : "none";
      break;
    }
    case "lobby_update": {
      currentHostId = msg.hostId;
      playerCount = msg.players.length;
      renderPlayerList(msg.players, msg.hostId);
      break;
    }
    case "game_start": {
      lobbyEl.style.display = "none";
      canvas.style.display = "block";
      leaveBtnGame.style.display = "inline-block";
      import("/js/game.js").then((mod) => {
        mod.startGame({
          ws,
          players: msg.players,
          myId,
          spawns: msg.spawns,
          seed: msg.seed,
        });
      });
      break;
    }
    case "player_left": {
      currentHostId = msg.hostId;
      playerCount -= 1;
      break;
    }
    case "error": {
      errorShown = true;
      statusMsg.textContent = msg.message || "This session can't be joined.";
      joinForm.style.display = "none";
      lobbyView.style.display = "none";
      break;
    }
    case "session_closed": {
      alert("Session closed due to inactivity.");
      location.href = "/index.html";
      break;
    }
  }
}

function leaveConfirmMessage() {
  const amHost = myId && myId === currentHostId;
  if (playerCount <= 1) {
    return "You're the only one here — leaving will close this session. Continue?";
  }
  if (amHost) {
    return "You're the host. Leaving will make someone else the host. Continue?";
  }
  return "Leave this session?";
}

function doLeave() {
  if (!confirm(leaveConfirmMessage())) return;
  leaving = true;
  if (ws) ws.close();
  location.href = "/index.html";
}

leaveBtn.addEventListener("click", doLeave);
leaveBtnGame.addEventListener("click", doLeave);

window.addEventListener("beforeunload", (e) => {
  if (leaving || !hasJoined) return;
  if (myId && myId === currentHostId) {
    e.preventDefault();
    e.returnValue = "";
  }
});

function renderPlayerList(players, hostId) {
  playerList.innerHTML = "";
  for (const p of players) {
    const li = document.createElement("li");
    li.textContent = p.username;
    if (p.id === hostId) li.classList.add("host");
    playerList.appendChild(li);
  }

  startBtn.style.display = myId && myId === hostId ? "inline-block" : "none";
}

joinBtn.addEventListener("click", () => {
  const username = usernameInput.value.trim();
  if (!username) {
    statusMsg.textContent = "Enter a username first.";
    return;
  }
  sessionStorage.setItem(`username:${sessionId}`, username);
  connect(username);
});

startBtn.addEventListener("click", () => {
  ws.send(JSON.stringify({ type: "start_game" }));
});
