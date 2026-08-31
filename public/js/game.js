import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.js";
import {
  GRID_SIZE,
  CELL_SIZE,
  createSimulation,
  applyCommand,
  step,
  snapshot,
  worldToCell,
  cellCenter,
} from "./sim.js";

const COLORS = [0xff6b6b, 0x4ecdc4, 0xffe66d, 0x95e1d3, 0xa78bfa];

const TICK_MS = 50; // 20Hz fixed simulation step, decoupled from render rate
const MAX_CATCHUP_MS = 100; // real time budget per frame for replaying missed ticks

const PLAYER_RADIUS = 0.35;
const PLAYER_LENGTH = 0.6;
const PLAYER_REST_Y = PLAYER_LENGTH / 2 + PLAYER_RADIUS;
const CUBE_SIZE = CELL_SIZE; // full cell footprint -- blocks tile edge to edge, no gaps
const RAMP_HEIGHT = CUBE_SIZE / 2; // half-height "slab", same color as a block
// Carried cubes ride above whatever height the carrier is currently rendered
// at (ground level, or elevated if they're standing on a stack) -- this is
// an offset added to the carrier's own render Y, not an absolute height.
const CARRY_HEIGHT_OFFSET = PLAYER_LENGTH / 2 + CUBE_SIZE / 2 + 0.1;

function realHeightOf(cubeType) {
  return cubeType === "ramp" ? RAMP_HEIGHT : CUBE_SIZE;
}

function shortestAngleDelta(from, to) {
  const twoPi = Math.PI * 2;
  const delta = (to - from) % twoPi;
  return ((2 * delta) % twoPi) - delta;
}

function lerpAngle(from, to, t) {
  return from + shortestAngleDelta(from, to) * t;
}

export function startGame({ ws, players, myId, spawns, seed }) {
  const canvas = document.getElementById("game-canvas");

  // ---- deterministic simulation --------------------------------------
  const simPlayers = players.map((p) => ({
    id: p.id,
    x: spawns[p.id].x,
    z: spawns[p.id].z,
  }));
  const sim = createSimulation({ seed, players: simPlayers });
  window.__sim = sim; // debug/test hook: inspect live sim state from devtools
  window.__ws = ws; // debug/test hook: send raw commands from devtools

  // ---- scene ------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1c26);

  const mapExtent = (GRID_SIZE * CELL_SIZE) / 2;
  const camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(0, mapExtent * 1.1, mapExtent * 0.95);
  camera.lookAt(0, 0, 0);
  window.__camera = camera; // debug/test hook: reproject world -> screen coords

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 10, 5);
  scene.add(dirLight);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GRID_SIZE * CELL_SIZE, GRID_SIZE * CELL_SIZE),
    new THREE.MeshStandardMaterial({ color: 0x2a2d3a })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const gridHelper = new THREE.GridHelper(GRID_SIZE * CELL_SIZE, GRID_SIZE, 0x44485a, 0x333644);
  gridHelper.position.y = 0.01;
  scene.add(gridHelper);

  // ---- player meshes ------------------------------------------------------
  const colorIndexById = new Map(players.map((p) => [p.id, p.colorIndex]));
  const playerMeshes = new Map(); // playerId -> mesh

  for (const p of players) {
    const geometry = new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_LENGTH, 4, 8);
    const material = new THREE.MeshStandardMaterial({
      color: COLORS[colorIndexById.get(p.id) % COLORS.length],
    });
    const mesh = new THREE.Mesh(geometry, material);
    const s = sim.players.get(p.id);
    mesh.position.set(s.x, PLAYER_REST_Y, s.z);
    scene.add(mesh);
    playerMeshes.set(p.id, mesh);
  }

  const myMarker = new THREE.Mesh(
    new THREE.RingGeometry(PLAYER_RADIUS + 0.15, PLAYER_RADIUS + 0.25, 24),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })
  );
  myMarker.rotation.x = -Math.PI / 2;
  myMarker.position.y = 0.02;
  scene.add(myMarker);

  // ---- cube meshes ----------------------------------------------------
  // Ramps are just half-height "slabs" of the same material as a block --
  // no color distinction, the shorter geometry is the only visual cue.
  // Cubes can be gathered/restacked at any time (ramps included), so unlike
  // static terrain, every cube's position is recomputed each frame in
  // render() based on the live stack it's currently part of.
  const CUBE_COLOR = 0xc48a5a;
  const cubeMeshes = new Map(); // cubeId -> mesh
  for (const cube of sim.cubes.values()) {
    const height = realHeightOf(cube.type);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(CUBE_SIZE, height, CUBE_SIZE),
      new THREE.MeshStandardMaterial({ color: CUBE_COLOR })
    );
    scene.add(mesh);
    cubeMeshes.set(cube.id, mesh);
  }

  const clickMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.15, 0.25, 24),
    new THREE.MeshBasicMaterial({ color: 0x8a8fbf, transparent: true, opacity: 0 })
  );
  clickMarker.rotation.x = -Math.PI / 2;
  clickMarker.position.y = 0.03;
  scene.add(clickMarker);
  let clickMarkerFadeStart = 0;

  // ---- block delivery plans: hover / drag-to-place UI ------------------
  // Clicking a grounded cube no longer sends a raw "gather" — it starts a
  // two-click "plan a delivery" flow: this preview ghost follows the cursor
  // (snapped to the grid) until the player clicks a destination, at which
  // point a single `move_block` command is sent and the avatar figures out
  // on its own whether it can actually walk the cube there (see sim.js).
  let hoveredCubeId = null;
  let selectedCubeId = null;
  let selectedCubeHeight = CUBE_SIZE; // matches selectedCubeId's type (block/ramp); geometry swapped on select
  const myColorIndex = colorIndexById.get(myId) ?? 0;

  const dragGhost = new THREE.Mesh(
    new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE),
    new THREE.MeshBasicMaterial({
      color: COLORS[myColorIndex % COLORS.length],
      transparent: true,
      opacity: 0.45,
    })
  );
  dragGhost.visible = false;
  scene.add(dragGhost);

  // One ghost + dashed line per player currently carrying out a "deliver"
  // plan (their own or anyone else's — this is read straight off the
  // deterministic sim, so it's already in sync across every client without
  // any extra network messages). Keyed by playerId, tinted with that
  // player's color.
  const planVisuals = new Map();

  // Brute-force scans are fine here -- there are only ever ~18 cubes, and
  // these run at most once per player/cube per rendered frame.

  // Sum of real (visual) heights of every grounded cube in this column --
  // i.e. the Y of the walkable surface a player standing here rests on.
  function columnTopY(x, z) {
    const { cx, cz } = worldToCell(x, z);
    let y = 0;
    for (const cube of sim.cubes.values()) {
      if (cube.carriedBy === null && cube.cx === cx && cube.cz === cz) y += realHeightOf(cube.type);
    }
    return y;
  }

  // Sum of real heights of everything *below* a given cube in its column --
  // i.e. the Y its own base rests on.
  function cubeBaseY(cube) {
    let y = 0;
    for (const other of sim.cubes.values()) {
      if (other.carriedBy === null && other.cx === cube.cx && other.cz === cube.cz && other.level < cube.level) {
        y += realHeightOf(other.type);
      }
    }
    return y;
  }

  // Can only gather/deliver-target the topmost cube in a column -- a buried
  // cube's side faces can still be raycast-hit even though sim.js will
  // reject picking it, so check explicitly rather than relying on occlusion.
  function isGatherable(cubeId) {
    const cube = sim.cubes.get(cubeId);
    if (!cube || currSnap.cubes[cubeId]?.carriedBy !== null) return false;
    for (const other of sim.cubes.values()) {
      if (other.carriedBy === null && other.cx === cube.cx && other.cz === cube.cz && other.level > cube.level) {
        return false;
      }
    }
    return true;
  }

  function setHoveredCube(cubeId) {
    if (cubeId === hoveredCubeId) return;
    if (hoveredCubeId !== null) {
      const prevMesh = cubeMeshes.get(hoveredCubeId);
      if (prevMesh) prevMesh.material.emissive.setHex(0x000000);
    }
    hoveredCubeId = cubeId;
    if (hoveredCubeId !== null) {
      const mesh = cubeMeshes.get(hoveredCubeId);
      if (mesh) mesh.material.emissive.setHex(0x555555);
    }
  }

  function updatePlanVisuals() {
    const activeIds = new Set();
    for (const [id, player] of sim.players) {
      if (player.order.type !== "deliver") continue;
      const { cubeId, destCx, destCz } = player.order;
      const cubeSnap = currSnap.cubes[cubeId];
      if (!cubeSnap) continue;
      activeIds.add(id);

      const dest = cellCenter(destCx, destCz);
      const ownHeight = realHeightOf(cubeSnap.type);
      let originX, originZ, originY;
      if (cubeSnap.carriedBy) {
        const carrierMesh = playerMeshes.get(cubeSnap.carriedBy);
        originX = carrierMesh ? carrierMesh.position.x : dest.x;
        originZ = carrierMesh ? carrierMesh.position.z : dest.z;
        originY = carrierMesh ? carrierMesh.position.y + CARRY_HEIGHT_OFFSET : ownHeight / 2;
      } else {
        const origin = cellCenter(cubeSnap.cx, cubeSnap.cz);
        originX = origin.x;
        originZ = origin.z;
        originY = cubeBaseY(cubeSnap) + ownHeight / 2;
      }
      const destY = columnTopY(dest.x, dest.z) + ownHeight / 2;

      let visuals = planVisuals.get(id);
      if (!visuals) {
        const color = COLORS[colorIndexById.get(id) % COLORS.length];
        const ghost = new THREE.Mesh(
          new THREE.BoxGeometry(CUBE_SIZE, ownHeight, CUBE_SIZE),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 })
        );
        const line = new THREE.Line(
          new THREE.BufferGeometry(),
          new THREE.LineDashedMaterial({ color, dashSize: 0.25, gapSize: 0.15 })
        );
        scene.add(ghost);
        scene.add(line);
        visuals = { ghost, line };
        planVisuals.set(id, visuals);
      }

      visuals.ghost.position.set(dest.x, destY, dest.z);
      visuals.line.geometry.setFromPoints([
        new THREE.Vector3(originX, originY, originZ),
        new THREE.Vector3(dest.x, destY, dest.z),
      ]);
      visuals.line.computeLineDistances();
    }

    for (const [id, visuals] of planVisuals) {
      if (activeIds.has(id)) continue;
      scene.remove(visuals.ghost);
      scene.remove(visuals.line);
      visuals.ghost.geometry.dispose();
      visuals.ghost.material.dispose();
      visuals.line.geometry.dispose();
      visuals.line.material.dispose();
      planVisuals.delete(id);
    }
  }

  function cancelSelection() {
    selectedCubeId = null;
    dragGhost.visible = false;
  }

  // ---- clock sync ---------------------------------------------------------
  // Server timestamps every command with its own wall clock (execAt). We
  // estimate the offset between our clock and the server's once, using a
  // classic NTP-style midpoint, so we can convert execAt into our own local
  // timeline without the server having to track anything per-connection.
  let clockOffset = 0;
  function sendTimeSync() {
    ws.send(JSON.stringify({ type: "time_sync", t0: Date.now() }));
  }
  sendTimeSync();

  // ---- inbound command queue --------------------------------------------
  // FIFO is intentional: the server broadcasts commands from a single
  // ordered log, so arrival order already equals the authoritative order —
  // no re-sorting needed as long as we always drain strictly from the front.
  const pendingCommands = [];

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case "time_sync_reply": {
        const t2 = Date.now();
        clockOffset = msg.serverNow - (msg.t0 + t2) / 2;
        break;
      }
      case "cmd": {
        pendingCommands.push(msg);
        break;
      }
      case "player_left": {
        const mesh = playerMeshes.get(msg.id);
        if (mesh) {
          scene.remove(mesh);
          playerMeshes.delete(msg.id);
        }
        sim.players.delete(msg.id);
        break;
      }
      case "session_closed": {
        alert("Session closed due to inactivity.");
        location.href = "/index.html";
        break;
      }
      default:
        break;
    }
  });

  // ---- input: click to move/gather, spacebar to drop ---------------------
  const raycaster = new THREE.Raycaster();
  const pointerNDC = new THREE.Vector2();

  function pointerToNDC(e) {
    const rect = canvas.getBoundingClientRect();
    pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  canvas.addEventListener("pointermove", (e) => {
    pointerToNDC(e);
    raycaster.setFromCamera(pointerNDC, camera);

    if (selectedCubeId !== null) {
      setHoveredCube(null);
      const groundHit = raycaster.intersectObject(ground)[0];
      if (groundHit) {
        const { cx, cz } = worldToCell(groundHit.point.x, groundHit.point.z);
        const c = cellCenter(cx, cz);
        // Preview where it'll actually land: on top of whatever's already
        // stacked in that column, not always at ground level.
        const topY = columnTopY(c.x, c.z);
        dragGhost.position.set(c.x, topY + selectedCubeHeight / 2, c.z);
        dragGhost.visible = true;
      }
      return;
    }

    const hit = raycaster.intersectObjects([...cubeMeshes.values()])[0];
    if (hit) {
      const cubeId = [...cubeMeshes.entries()].find(([, m]) => m === hit.object)?.[0];
      setHoveredCube(cubeId && isGatherable(cubeId) ? cubeId : null);
    } else {
      setHoveredCube(null);
    }
  });

  canvas.addEventListener("pointerdown", (e) => {
    pointerToNDC(e);
    raycaster.setFromCamera(pointerNDC, camera);

    // Second click of a delivery plan: commit the destination and send the
    // plan as a single command. What happens next (can the avatar actually
    // get there and back) is entirely up to the sim — see sim.js.
    if (selectedCubeId !== null) {
      const groundHit = raycaster.intersectObject(ground)[0];
      if (groundHit) {
        ws.send(
          JSON.stringify({
            type: "cmd",
            cmd: { kind: "move_block", cubeId: selectedCubeId, x: groundHit.point.x, z: groundHit.point.z },
          })
        );
        showClickMarker(groundHit.point.x, groundHit.point.z);
      }
      cancelSelection();
      return;
    }

    // First click: pick up a grounded cube as a pending plan (nothing sent
    // to the server yet — that only happens once a destination is chosen).
    const cubeHit = raycaster.intersectObjects([...cubeMeshes.values()])[0];
    if (cubeHit) {
      const cubeId = [...cubeMeshes.entries()].find(([, m]) => m === cubeHit.object)?.[0];
      if (cubeId && isGatherable(cubeId)) {
        selectedCubeId = cubeId;
        selectedCubeHeight = realHeightOf(sim.cubes.get(cubeId)?.type);
        dragGhost.geometry.dispose();
        dragGhost.geometry = new THREE.BoxGeometry(CUBE_SIZE, selectedCubeHeight, CUBE_SIZE);
        setHoveredCube(null);
        return;
      }
    }

    const groundHit = raycaster.intersectObject(ground)[0];
    if (groundHit) {
      ws.send(
        JSON.stringify({
          type: "cmd",
          cmd: { kind: "move", x: groundHit.point.x, z: groundHit.point.z },
        })
      );
      showClickMarker(groundHit.point.x, groundHit.point.z);
    }
  });

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (selectedCubeId !== null) cancelSelection();
  });

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      ws.send(JSON.stringify({ type: "cmd", cmd: { kind: "drop" } }));
    } else if (e.code === "Escape" && selectedCubeId !== null) {
      cancelSelection();
    }
  });

  function showClickMarker(x, z) {
    clickMarker.position.x = x;
    clickMarker.position.z = z;
    clickMarker.material.opacity = 0.9;
    clickMarkerFadeStart = performance.now();
  }

  // ---- fixed-step simulation loop with render-time interpolation --------
  // "Fix your timestep": the sim only ever advances in TICK_MS increments so
  // every client's floating-point math takes the identical path regardless
  // of that client's render framerate. We render by interpolating between
  // the last two fixed-step snapshots using the leftover accumulator time,
  // purely for visual smoothness — it never feeds back into the sim.
  let prevSnap = snapshot(sim);
  let currSnap = snapshot(sim);
  let accumulatorMs = 0;
  let lastFrameTime = Date.now();
  let simClock = Date.now();

  function applyDueCommands() {
    while (pendingCommands.length) {
      const next = pendingCommands[0];
      const localExecAt = next.execAt - clockOffset;
      if (localExecAt > simClock) break;
      pendingCommands.shift();
      applyCommand(sim, next.playerId, next.cmd);
    }
  }

  function tick() {
    const now = Date.now();
    const frameDelta = now - lastFrameTime;
    lastFrameTime = now;
    accumulatorMs += frameDelta;

    // A long stall (backgrounded/throttled tab, laptop sleep, etc.) can leave
    // a huge backlog of ticks to replay. Every one of them still has to run
    // in order, with step() properly interleaved between whichever commands
    // land on which tick — skipping ahead and draining several due commands
    // in one shot (no step() between them) would replay this player's world
    // differently than every other client replayed theirs, a silent desync
    // (see CLAUDE.md). But step() itself is cheap (no pathfinding happens
    // here — that's in applyCommand), so replaying even a large backlog is
    // fine as long as we bound it by real processing time, not sim ticks:
    // spend at most MAX_CATCHUP_MS of *wall-clock* time replaying ticks per
    // frame, and let anything left over carry into the next rAF call, which
    // fires again almost immediately since we're back in the foreground by
    // then. This never drops or reorders a tick, just spreads a very large
    // backlog across a few frames instead of one.
    const catchUpStart = performance.now();
    while (accumulatorMs >= TICK_MS && performance.now() - catchUpStart < MAX_CATCHUP_MS) {
      simClock += TICK_MS;
      applyDueCommands();
      prevSnap = currSnap;
      step(sim, TICK_MS / 1000);
      currSnap = snapshot(sim);
      accumulatorMs -= TICK_MS;
    }

    // Normally < 1 (mid-tick leftover), but the catch-up loop above can exit
    // early with a large backlog still queued (real-time budget hit, not yet
    // caught up) -- clamp so we render at currSnap instead of extrapolating
    // wildly past it; the rest of the backlog plays out over the next
    // frame(s).
    const alpha = Math.min(accumulatorMs / TICK_MS, 1);
    render(alpha);

    if (clickMarker.material.opacity > 0) {
      const age = performance.now() - clickMarkerFadeStart;
      clickMarker.material.opacity = Math.max(0, 0.9 - age / 400);
    }

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  function render(alpha) {
    for (const [id, mesh] of playerMeshes) {
      const a = prevSnap.players[id];
      const b = currSnap.players[id];
      if (!a || !b) continue;
      const x = a.x + (b.x - a.x) * alpha;
      const z = a.z + (b.z - a.z) * alpha;
      const facing = lerpAngle(a.facing, b.facing, alpha);
      mesh.position.set(x, PLAYER_REST_Y + columnTopY(x, z), z);
      mesh.rotation.y = facing;

      if (id === myId) {
        myMarker.position.x = x;
        myMarker.position.z = z;
      }
    }

    for (const [id, mesh] of cubeMeshes) {
      const c = currSnap.cubes[id];
      if (!c) continue;
      if (c.carriedBy) {
        const carrierMesh = playerMeshes.get(c.carriedBy);
        if (carrierMesh) {
          mesh.position.set(carrierMesh.position.x, carrierMesh.position.y + CARRY_HEIGHT_OFFSET, carrierMesh.position.z);
        }
      } else {
        const worldX = (c.cx - GRID_SIZE / 2 + 0.5) * CELL_SIZE;
        const worldZ = (c.cz - GRID_SIZE / 2 + 0.5) * CELL_SIZE;
        const baseY = cubeBaseY(c);
        mesh.position.set(worldX, baseY + realHeightOf(c.type) / 2, worldZ);
      }
    }

    updatePlanVisuals();
  }

  requestAnimationFrame(tick);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
