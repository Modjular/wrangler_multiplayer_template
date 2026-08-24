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
    statusMsg.textContent = "Disconnected from session.";
  });

  ws.addEventListener("error", () => {
    statusMsg.textContent = "Connection error.";
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case "joined": {
      myId = msg.id;
      startBtn.style.display = myId === currentHostId ? "inline-block" : "none";
      break;
    }
    case "lobby_update": {
      currentHostId = msg.hostId;
      renderPlayerList(msg.players, msg.hostId);
      break;
    }
    case "game_start": {
      lobbyEl.style.display = "none";
      canvas.style.display = "block";
      import("/js/game.js").then((mod) => {
        mod.startGame({ ws, players: msg.players, myId });
      });
      break;
    }
    case "session_closed": {
      alert("Session closed due to inactivity.");
      location.href = "/index.html";
      break;
    }
  }
}

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
