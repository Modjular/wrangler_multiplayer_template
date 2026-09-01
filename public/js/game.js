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
  findPath,
  advanceAlongPath,
  BASE_SPEED,
  columnHeight,
  reachableColumns,
  reachableColumnsFromApproach,
  hasReachableApproach,
  MAX_STACK_HEIGHT,
  serializeState,
} from "./sim.js";

const COLORS = [0xff6b6b, 0x4ecdc4, 0xffe66d, 0x95e1d3, 0xa78bfa];
const INVALID_GHOST_COLOR = 0xff4444; // drag-ghost tint when the hovered destination isn't actually reachable

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

// `shape` is purely cosmetic (see sim.js's BLOCK_SHAPES) -- every shape
// still fills roughly the same footprint/height so stacking and carrying
// look consistent regardless of which one a given block happens to be.
// Ramps ignore shape entirely and are always a plain slab.
function cubeGeometry(cubeType, shape, height) {
  if (cubeType === "block") {
    const radius = CUBE_SIZE / 2;
    if (shape === "octagon") return new THREE.CylinderGeometry(radius, radius, height, 8);
    if (shape === "cylinder") return new THREE.CylinderGeometry(radius, radius, height, 24);
  }
  return new THREE.BoxGeometry(CUBE_SIZE, height, CUBE_SIZE);
}

// ---- movement "juice": spring-smoothed follow + lean into accel/decel ----
// The sim itself moves at constant speed with no easing (it has to stay
// simple and deterministic for lockstep -- see CLAUDE.md). This is a purely
// visual layer on top: instead of snapping the mesh straight to the
// authoritative (tick-interpolated) position, let it chase that position
// with a critically-damped spring. Because the target starts and stops
// abruptly (an order kicks in, then goes idle), a spring trailing behind it
// naturally accelerates smoothly out of a stop and decelerates smoothly
// into one -- no path-progress bookkeeping needed. The spring's own
// acceleration doubles as a lean angle: forward while catching up to speed,
// backward while braking into a stop.
const SPRING_SMOOTH_TIME = 0.12; // seconds; lower = snappier catch-up to target
const MAX_LEAN = 0.3; // radians
const LEAN_ACCEL_SCALE = 0.045;
const LEAN_SMOOTH_TIME = 0.1; // seconds; smooths the lean angle itself so it doesn't jitter

// Standard critically-damped spring ("smooth damp"), ported from the
// well-known Unity/Game Programming Gems formulation. `velocity` is a
// mutable { value } ref so the caller can keep it around across frames.
function smoothDamp(current, target, velocity, smoothTime, dt) {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity.value + omega * change) * dt;
  velocity.value = (velocity.value - omega * temp) * exp;
  let output = target + (change + temp) * exp;
  // Clamp so the spring can't overshoot and oscillate past a now-stationary
  // target: trip only if we've actually crossed past it in the direction we
  // were heading (target - current), not just landed on the same side we
  // started from -- using `change` (current - target) here would fire on
  // basically every frame and force a hard snap-to-target every time,
  // killing all lag (and with it, the whole point of the spring).
  if (target - current > 0 === output > target) {
    output = target;
    velocity.value = (output - target) / dt;
  }
  return output;
}

function shortestAngleDelta(from, to) {
  const twoPi = Math.PI * 2;
  const delta = (to - from) % twoPi;
  return ((2 * delta) % twoPi) - delta;
}

function lerpAngle(from, to, t) {
  return from + shortestAngleDelta(from, to) * t;
}

// Triggers a browser file download for arbitrary JSON data -- used by the
// F9 debug-state export below. Plain Blob + throwaway <a download>, no
// library needed.
function downloadJSON(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
  // debug hook: full JSON-safe state dump (see serializeState in sim.js) --
  // e.g. `copy(__exportState())` in devtools to grab it without needing the
  // F9 file-download shortcut below. Also feeds scripts/debug-state.mjs.
  window.__exportState = () => serializeState(sim);

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
  // The camera rig keeps this fixed offset from cameraLookTarget forever --
  // panning moves the target (and camera) together, never rotates. Because
  // it's a pure translation, the ground-plane point under any given screen
  // position also translates by exactly the same amount the rig does,
  // which is what makes intersectGroundPlaneY0-based dragging exact (see
  // panTo).
  const CAMERA_OFFSET = { x: 0, y: mapExtent * 1.1, z: mapExtent * 0.95 };
  const cameraLookTarget = { x: 0, z: 0 };
  const PAN_LIMIT = mapExtent * 0.85;
  function updateCameraTransform() {
    camera.position.set(
      cameraLookTarget.x + CAMERA_OFFSET.x,
      CAMERA_OFFSET.y,
      cameraLookTarget.z + CAMERA_OFFSET.z
    );
    camera.lookAt(cameraLookTarget.x, 0, cameraLookTarget.z);
  }
  updateCameraTransform();
  window.__camera = camera; // debug/test hook: reproject world -> screen coords

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  // We handle all touch gestures ourselves (drag-to-place, drag-to-pan) --
  // tell the browser not to also try to scroll/zoom/select on the canvas.
  canvas.style.touchAction = "none";

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
  window.__playerMeshes = playerMeshes; // debug/test hook: inspect rendered player transforms

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
      cubeGeometry(cube.type, cube.shape, height),
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
  // Memoized "forklift rule" reachability for the current selection (see
  // beginCubeSelection) -- computed once per pickup, not once per hover
  // frame/candidate, since it only depends on the player's position and the
  // cube's position, neither of which changes just from moving the ghost
  // around. selectedCubeFetchable: can I even reach *this cube* from where
  // I'm standing right now (both gather and the "to_cube" phase of a
  // delivery require standing level with it -- see findApproachAtHeight).
  // selectedCubeReachableFromPickup: everywhere reachable from the cube's
  // *approach* cells -- i.e. from wherever I'll actually be standing once
  // I've picked it up -- used to validate each candidate delivery
  // destination as the ghost moves. Null while nothing is selected or the
  // cube can't be fetched at all (no destination could ever work then
  // either).
  let selectedCubeFetchable = false;
  let selectedCubeReachableFromPickup = null;
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
  window.__dragGhost = dragGhost; // debug/test hook: inspect the placement-preview ghost

  // One ghost + dashed line per player currently carrying out a "deliver"
  // plan (their own or anyone else's — this is read straight off the
  // deterministic sim, so it's already in sync across every client without
  // any extra network messages). Keyed by playerId, tinted with that
  // player's color.
  const planVisuals = new Map();
  window.__planVisuals = planVisuals; // debug/test hook: inspect the plan-line ghost/line meshes
  // playerId -> { key, waypoints } cache for the A*-traced plan line below.
  // findPath is a full grid-wide search -- too expensive to rerun every
  // render()'d frame (up to display refresh rate) when origin/dest have
  // barely moved; only rerun it when the *cell* either one is in changes
  // (waypoints are cell-centered anyway, so sub-cell motion can't change the
  // route), which in practice is at most a few times over a whole delivery.
  const planPathCache = new Map();
  // playerId -> { cubeId, destCx, destCz, x, y, z } -- the frozen starting
  // point of the current "to_dest" phase, captured once the instant a
  // delivery flips from "to_cube" to "to_dest" (i.e. right when the avatar
  // picks the cube up). Freezing both this and the route itself (order.path
  // is read directly in updatePlanVisuals, not re-derived) is what makes the
  // dashed line hold still -- "painted on the ground" -- instead of
  // continuously creeping forward as the carrier walks, and keeps it
  // exactly matching the real route instead of a fresh, possibly-different
  // approximation re-derived from a moving position every frame.
  const frozenDeliverOrigin = new Map();
  // Extra, dimmer ghost boxes (no line) for each player's *queued* jobs --
  // just enough feedback that a click while busy visibly registered as
  // "queued" instead of silently vanishing. Keyed by playerId+index in the
  // queue array; jobs only ever leave from the front, so a shift reuses the
  // same key for a different job now and then -- a fine trade against a
  // stable per-job id for how rarely a queue actually reshuffles.
  const queueGhosts = new Map();
  window.__queueGhosts = queueGhosts; // debug/test hook: inspect the queued-job ghost meshes

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
      const { cubeId, destCx, destCz, phase } = player.order;
      const cubeSnap = currSnap.cubes[cubeId];
      if (!cubeSnap) continue;
      activeIds.add(id);

      const dest = cellCenter(destCx, destCz);
      const ownHeight = realHeightOf(cubeSnap.type);
      const destY = columnTopY(dest.x, dest.z) + ownHeight / 2;

      let originX, originZ, originY, waypoints;

      if (phase === "to_dest") {
        // Freeze the starting point the instant we first see this phase --
        // together with order.path (read directly below, never re-derived)
        // this stays fixed for the rest of the phase, so the line holds
        // still instead of continuously creeping forward as the carrier
        // walks, and always matches the real route (it *is* the real
        // route -- see step()'s deliver handling).
        let frozen = frozenDeliverOrigin.get(id);
        if (!frozen || frozen.cubeId !== cubeId || frozen.destCx !== destCx || frozen.destCz !== destCz) {
          const carrierMesh = playerMeshes.get(id);
          frozen = {
            cubeId,
            destCx,
            destCz,
            x: carrierMesh ? carrierMesh.position.x : dest.x,
            z: carrierMesh ? carrierMesh.position.z : dest.z,
            y: carrierMesh ? carrierMesh.position.y + CARRY_HEIGHT_OFFSET : ownHeight / 2,
          };
          frozenDeliverOrigin.set(id, frozen);
        }
        originX = frozen.x;
        originZ = frozen.z;
        originY = frozen.y;
        waypoints = player.order.path;
      } else {
        // "to_cube": no authoritative destination route exists yet (that's
        // only computed once the avatar actually picks the cube up -- see
        // step()), so this is just a preview from the cube's own
        // (currently stationary) resting spot -- already stable frame to
        // frame on its own since the cube doesn't move until picked up.
        frozenDeliverOrigin.delete(id); // clear a stale freeze from a past delivery
        const origin = cellCenter(cubeSnap.cx, cubeSnap.cz);
        originX = origin.x;
        originZ = origin.z;
        originY = cubeBaseY(cubeSnap) + ownHeight / 2;

        // Still worth caching (see planPathCache above): re-selecting the
        // same cube without moving would otherwise rerun this A* search
        // every frame for no new information.
        const originCell = worldToCell(originX, originZ);
        const cacheKey = `${originCell.cx},${originCell.cz}->${destCx},${destCz}`;
        const cached = planPathCache.get(id);
        if (cached && cached.key === cacheKey) {
          waypoints = cached.waypoints;
        } else {
          waypoints = findPath(sim, originX, originZ, dest.x, dest.z);
          planPathCache.set(id, { key: cacheKey, waypoints });
        }
      }

      let visuals = planVisuals.get(id);
      if (!visuals) {
        const color = COLORS[colorIndexById.get(id) % COLORS.length];
        const ghost = new THREE.Mesh(
          cubeGeometry(cubeSnap.type, cubeSnap.shape, ownHeight),
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

      // Trace the actual route: the "to_cube" preview via findPath already
      // ends exactly at dest, but order.path for "to_dest" stops at the
      // approach cell *next to* the destination (see findApproachAtHeight --
      // the final "hop" onto/into the destination stack isn't a walked
      // step), so append dest only when the route doesn't already end there.
      const points = [new THREE.Vector3(originX, originY, originZ)];
      for (const wp of waypoints) {
        points.push(new THREE.Vector3(wp.x, columnTopY(wp.x, wp.z) + ownHeight / 2, wp.z));
      }
      const last = points[points.length - 1];
      if (Math.hypot(last.x - dest.x, last.z - dest.z) > 1e-6) {
        points.push(new THREE.Vector3(dest.x, destY, dest.z));
      }
      visuals.line.geometry.setFromPoints(points);
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
      planPathCache.delete(id);
      frozenDeliverOrigin.delete(id);
    }

    updateQueueGhosts();
  }

  // Renders one dim, line-less ghost box per *queued* job (see sim.js's
  // player.queue) at its eventual destination -- purely a "yes, that click
  // registered" acknowledgment, distinct from the brighter active-order
  // ghost+line pair above.
  function updateQueueGhosts() {
    const activeKeys = new Set();
    for (const [playerId, player] of sim.players) {
      player.queue.forEach((job, index) => {
        const cube = sim.cubes.get(job.cubeId);
        if (!cube) return;
        const key = `${playerId}:${index}`;
        activeKeys.add(key);
        const dest = cellCenter(job.destCx, job.destCz);
        const ownHeight = realHeightOf(cube.type);
        const destY = columnTopY(dest.x, dest.z) + ownHeight / 2;

        let ghost = queueGhosts.get(key);
        if (!ghost) {
          const color = COLORS[colorIndexById.get(playerId) % COLORS.length];
          ghost = new THREE.Mesh(
            cubeGeometry(cube.type, cube.shape, ownHeight),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16 })
          );
          ghost.userData.cubeId = job.cubeId;
          scene.add(ghost);
          queueGhosts.set(key, ghost);
        } else if (ghost.userData.cubeId !== job.cubeId) {
          // The front job left the queue and everything shifted down,
          // reusing this playerId+index key for a *different* job -- rebuild
          // the geometry instead of leaving it showing whatever shape the
          // previous occupant of this slot was.
          ghost.geometry.dispose();
          ghost.geometry = cubeGeometry(cube.type, cube.shape, ownHeight);
          ghost.userData.cubeId = job.cubeId;
        }
        ghost.position.set(dest.x, destY, dest.z);
      });
    }

    for (const [key, ghost] of queueGhosts) {
      if (activeKeys.has(key)) continue;
      scene.remove(ghost);
      ghost.geometry.dispose();
      ghost.material.dispose();
      queueGhosts.delete(key);
    }
  }

  function cancelSelection() {
    selectedCubeId = null;
    selectedCubeFetchable = false;
    selectedCubeReachableFromPickup = null;
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
        motionState.delete(msg.id);
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

  // ---- mobile: drag a block to place it, or drag empty space to pan ------
  // On touch there's no hover state to arm a two-tap plan with (a finger
  // only "moves" while it's down), so touch gets its own gesture: press on
  // a block to pick it up immediately and release to place it (reusing the
  // exact same selectedCubeId/dragGhost the desktop two-click flow uses --
  // see pointerdown/pointerup), or press on empty ground and either tap
  // (release without much movement -- walk there, like a desktop click) or
  // drag (pan the camera). Desktop's mouse/pen flow below is untouched.
  const PAN_DRAG_THRESHOLD_PX = 10;
  let touchGesture = null; // { type: "block" } | { type: "pending", panAnchor } | { type: "pan", panAnchor }
  // Only one finger drives a gesture at a time -- an incidental second touch
  // (e.g. a resting thumb) while dragging must not hijack touchGesture out
  // from under the finger that's actually mid-drag.
  let activeTouchPointerId = null;

  // Ray-vs-infinite-Y=0-plane intersection (not limited to the finite
  // `ground` mesh) -- panning needs a world point even when the finger is
  // over background beyond the playable grid.
  function intersectGroundPlaneY0(clientX, clientY) {
    pointerToNDC({ clientX, clientY });
    raycaster.setFromCamera(pointerNDC, camera);
    const origin = raycaster.ray.origin;
    const dir = raycaster.ray.direction;
    if (Math.abs(dir.y) < 1e-6) return null;
    const t = -origin.y / dir.y;
    if (t < 0) return null;
    return { x: origin.x + dir.x * t, z: origin.z + dir.z * t };
  }

  // Shifts the camera rig so the world point `anchor` ends up back under
  // (clientX, clientY) -- i.e. "drag the world" panning. Since the rig only
  // ever translates (see CAMERA_OFFSET above), this can be solved exactly
  // in one step every frame instead of accumulating per-frame deltas.
  function panTo(anchor, clientX, clientY) {
    const under = intersectGroundPlaneY0(clientX, clientY);
    if (!under) return;
    cameraLookTarget.x = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, cameraLookTarget.x + (anchor.x - under.x)));
    cameraLookTarget.z = Math.max(-PAN_LIMIT, Math.min(PAN_LIMIT, cameraLookTarget.z + (anchor.z - under.z)));
    updateCameraTransform();
  }

  function beginCubeSelection(cubeId) {
    const selectedCube = sim.cubes.get(cubeId);
    selectedCubeId = cubeId;
    selectedCubeHeight = realHeightOf(selectedCube?.type);
    dragGhost.geometry.dispose();
    dragGhost.geometry = cubeGeometry(selectedCube?.type, selectedCube?.shape, selectedCubeHeight);
    setHoveredCube(null);

    // Memoize reachability for this pickup (see the declaration up top):
    // can I fetch it at all from here, and if so, what can I reach once I'm
    // standing next to it (for validating delivery destinations below).
    const myPlayer = sim.players.get(myId);
    selectedCubeFetchable =
      !!myPlayer &&
      !!selectedCube &&
      hasReachableApproach(
        sim,
        reachableColumns(sim, myPlayer.x, myPlayer.z),
        selectedCube.cx,
        selectedCube.cz,
        selectedCube.level
      );
    // Seeded from the cube's *approach* cells (adjacent, at cube.level), not
    // its own column -- the cube's own column is one level taller than
    // where a player actually stands to reach it, which would make canStep
    // over-permissive climbing out of it (see reachableColumnsFromApproach).
    selectedCubeReachableFromPickup = selectedCubeFetchable
      ? reachableColumnsFromApproach(sim, selectedCube.cx, selectedCube.cz, selectedCube.level)
      : null;
  }

  function commitSelectedCubePlacement(groundHit) {
    if (groundHit) {
      ws.send(
        JSON.stringify({
          type: "cmd",
          cmd: { kind: "move_block", cubeId: selectedCubeId, x: groundHit.point.x, z: groundHit.point.z },
        })
      );
      showClickMarker(groundHit.point.x, groundHit.point.z);
      myPrediction = null; // a deliver plan isn't predicted; don't leave a stale move running
    }
    cancelSelection();
  }

  // Snaps the drag ghost to whatever grid cell (clientX, clientY) is over,
  // stacked on top of that column's current contents. Shared by the desktop
  // hover-preview and the touch drag-preview so the two input modes can't
  // silently disagree on where a cube will land.
  function updateDragGhostAt(clientX, clientY) {
    pointerToNDC({ clientX, clientY });
    raycaster.setFromCamera(pointerNDC, camera);
    const groundHit = raycaster.intersectObject(ground)[0];
    if (groundHit) {
      const { cx, cz } = worldToCell(groundHit.point.x, groundHit.point.z);
      const c = cellCenter(cx, cz);
      const topY = columnTopY(c.x, c.z);
      dragGhost.position.set(c.x, topY + selectedCubeHeight / 2, c.z);
      dragGhost.visible = true;

      // Tint red when this specific destination isn't actually deliverable
      // right now -- either the cube itself can't be fetched from where I'm
      // standing, this column's already full, or (using the memoized
      // reachable-from-pickup set) there's nowhere level with it I could
      // stand next to. Just a hint -- commit is still allowed either way,
      // in case the world changes (or I move) between now and clicking.
      const destHeight = columnHeight(sim, cx, cz);
      const deliverable =
        selectedCubeFetchable &&
        destHeight < MAX_STACK_HEIGHT &&
        hasReachableApproach(sim, selectedCubeReachableFromPickup, cx, cz, destHeight);
      dragGhost.material.color.setHex(deliverable ? COLORS[myColorIndex % COLORS.length] : INVALID_GHOST_COLOR);
    }
  }

  function handleTouchMove(e) {
    if (e.pointerId !== activeTouchPointerId) return;
    if (!touchGesture) return;

    if (touchGesture.type === "block") {
      updateDragGhostAt(e.clientX, e.clientY);
      return;
    }

    if (touchGesture.type === "pending") {
      const dx = e.clientX - touchGesture.startClientX;
      const dy = e.clientY - touchGesture.startClientY;
      if (Math.hypot(dx, dy) < PAN_DRAG_THRESHOLD_PX) return;
      touchGesture = { type: "pan", panAnchor: touchGesture.panAnchor };
    }

    if (touchGesture.type === "pan" && touchGesture.panAnchor) {
      panTo(touchGesture.panAnchor, e.clientX, e.clientY);
    }
  }

  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") {
      handleTouchMove(e);
      return;
    }

    pointerToNDC(e);
    raycaster.setFromCamera(pointerNDC, camera);

    if (selectedCubeId !== null) {
      setHoveredCube(null);
      updateDragGhostAt(e.clientX, e.clientY);
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

    if (e.pointerType === "touch") {
      // A gesture is already in progress under a different finger (e.g. a
      // resting thumb) -- ignore this touch entirely rather than letting it
      // hijack touchGesture out from under the finger actually driving it.
      if (activeTouchPointerId !== null && e.pointerId !== activeTouchPointerId) return;

      if (selectedCubeId !== null) {
        // Rare: an earlier tap already armed a plan (e.g. tap-select then a
        // separate tap-place instead of one continuous drag) -- commit it
        // the same way a drag-release does.
        commitSelectedCubePlacement(raycaster.intersectObject(ground)[0]);
        touchGesture = null;
        return;
      }

      const cubeHit = raycaster.intersectObjects([...cubeMeshes.values()])[0];
      if (cubeHit) {
        const cubeId = [...cubeMeshes.entries()].find(([, m]) => m === cubeHit.object)?.[0];
        if (cubeId && isGatherable(cubeId)) {
          beginCubeSelection(cubeId);
          touchGesture = { type: "block", startClientX: e.clientX, startClientY: e.clientY };
          activeTouchPointerId = e.pointerId;
          return;
        }
      }

      // Not on a cube -- could still turn into either a tap-to-move or a
      // pan drag; decide once we see how far it moves (see handleTouchMove).
      touchGesture = {
        type: "pending",
        startClientX: e.clientX,
        startClientY: e.clientY,
        panAnchor: intersectGroundPlaneY0(e.clientX, e.clientY),
      };
      activeTouchPointerId = e.pointerId;
      return;
    }

    // Second click of a delivery plan: commit the destination and send the
    // plan as a single command. What happens next (can the avatar actually
    // get there and back) is entirely up to the sim — see sim.js.
    if (selectedCubeId !== null) {
      commitSelectedCubePlacement(raycaster.intersectObject(ground)[0]);
      return;
    }

    // First click: pick up a grounded cube as a pending plan (nothing sent
    // to the server yet — that only happens once a destination is chosen).
    const cubeHit = raycaster.intersectObjects([...cubeMeshes.values()])[0];
    if (cubeHit) {
      const cubeId = [...cubeMeshes.entries()].find(([, m]) => m === cubeHit.object)?.[0];
      if (cubeId && isGatherable(cubeId)) {
        beginCubeSelection(cubeId);
        return;
      }
    }

    const groundHit = raycaster.intersectObject(ground)[0];
    if (groundHit) {
      sendMyMove(groundHit.point.x, groundHit.point.z);
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "touch" || !touchGesture || e.pointerId !== activeTouchPointerId) return;

    if (touchGesture.type === "block") {
      const dx = e.clientX - touchGesture.startClientX;
      const dy = e.clientY - touchGesture.startClientY;
      if (Math.hypot(dx, dy) < PAN_DRAG_THRESHOLD_PX) {
        // Released right where it was picked up, without actually dragging
        // it anywhere -- committing here would raycast to roughly the
        // cube's own spot and send a pointless "move it to where it already
        // is" plan. Just cancel instead; a real placement needs a real drag.
        cancelSelection();
      } else {
        pointerToNDC(e);
        raycaster.setFromCamera(pointerNDC, camera);
        commitSelectedCubePlacement(raycaster.intersectObject(ground)[0]);
      }
    } else if (touchGesture.type === "pending") {
      // Released without dragging past the threshold: a tap, same as a
      // desktop click on empty ground.
      pointerToNDC(e);
      raycaster.setFromCamera(pointerNDC, camera);
      const groundHit = raycaster.intersectObject(ground)[0];
      if (groundHit) {
        sendMyMove(groundHit.point.x, groundHit.point.z);
      }
    }
    // type "pan": nothing to commit, just stop panning.

    touchGesture = null;
    activeTouchPointerId = null;
  });

  canvas.addEventListener("pointercancel", (e) => {
    if (e.pointerId !== activeTouchPointerId) return;
    if (selectedCubeId !== null) cancelSelection();
    touchGesture = null;
    activeTouchPointerId = null;
  });

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (selectedCubeId !== null) cancelSelection();
  });

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      ws.send(JSON.stringify({ type: "cmd", cmd: { kind: "drop" } }));
      myPrediction = null; // dropping isn't predicted; don't leave a stale move running
    } else if (e.code === "Escape" && selectedCubeId !== null) {
      cancelSelection();
    } else if (e.code === "F9") {
      // Debug tooling: dump the full sim state as a downloadable JSON file
      // any time something looks wrong (a block that "should" be
      // placeable, a stuck delivery, etc.) -- see serializeState in sim.js
      // and scripts/debug-state.mjs for offline diagnosis against the
      // exact map that triggered it.
      e.preventDefault();
      const state = serializeState(sim);
      downloadJSON(`multiplayer-state-${Date.now()}.json`, state);
      console.log("[debug] exported sim state (see downloaded file):", state);
    }
  });

  // Sends a "move" command and kicks off local prediction for it -- shared
  // by the desktop ground-click and the touch tap-to-move handler so the
  // two input modes can't silently diverge.
  function sendMyMove(x, z) {
    ws.send(JSON.stringify({ type: "cmd", cmd: { kind: "move", x, z } }));
    showClickMarker(x, z);
    startMyPrediction(x, z);
  }

  function showClickMarker(x, z) {
    clickMarker.position.x = x;
    clickMarker.position.z = z;
    clickMarker.material.opacity = 0.9;
    clickMarkerFadeStart = performance.now();
  }

  // ---- instant local feedback: predict my own "move" commands -------------
  // The lockstep buffer (INPUT_DELAY_MS, in GameRoom.js) means even the
  // player who issued a command doesn't see it take effect in the
  // authoritative sim for ~200ms -- that's what keeps every client in sync,
  // and this doesn't touch it. But there's no reason *my own* avatar can't
  // start visually walking the instant I click: run the exact same
  // findPath/advanceAlongPath the real sim will eventually use, right now,
  // purely for rendering. It never touches `sim` and is never sent
  // anywhere, so however wrong it turns out to be, it cannot desync anyone
  // -- worst case, my own avatar's visual position corrects itself once the
  // authoritative order settles (rare: only when something else, like
  // another player moving a cube, made my predicted path stale in the
  // 200ms window). A rare correction beats guaranteed lag on every click.
  // Scoped to "move" only -- gather/deliver/drop interact with contested
  // cube state in ways that are much riskier to predict well.
  let myPrediction = null; // { x, z, facing, prevX, prevZ, prevFacing, order: {path, pathIndex}, targetMoveSeq }
  // Counts my own "move" commands: `sentMoveCount` increments on every one I
  // send, `appliedMoveCount` increments in applyDueCommands() when the
  // authoritative sim actually applies one of mine. myPrediction stamps the
  // sent-count value that corresponds to *its own* command (targetMoveSeq),
  // so advanceMyPrediction can tell "the order is idle because my command
  // hasn't been applied yet" apart from "the order is idle because it was
  // just applied and immediately rejected" apart from "idle because an
  // *older* command of mine finished" -- using the order's idle/non-idle
  // state alone can't distinguish any of these, and confusing them either
  // clears a still-in-flight prediction early (visible rubber-banding when
  // clicking a new destination before the previous one's authoritative move
  // has finished) or leaves a rejected one stuck forever (a locally
  // "successful" prediction whose authoritative order never left "idle" at
  // all, so it never looked non-idle in the first place).
  let sentMoveCount = 0;
  let appliedMoveCount = 0;

  function startMyPrediction(targetX, targetZ) {
    const myPlayer = sim.players.get(myId);
    const targetMoveSeq = ++sentMoveCount;
    if (!myPlayer) return;
    const fromX = myPrediction ? myPrediction.x : myPlayer.x;
    const fromZ = myPrediction ? myPrediction.z : myPlayer.z;
    const fromFacing = myPrediction ? myPrediction.facing : myPlayer.facing;
    const path = findPath(sim, fromX, fromZ, targetX, targetZ);
    if (!path.length) {
      myPrediction = null;
      return;
    }
    myPrediction = {
      x: fromX,
      z: fromZ,
      facing: fromFacing,
      prevX: fromX,
      prevZ: fromZ,
      prevFacing: fromFacing,
      order: { path, pathIndex: 0 },
      targetMoveSeq,
    };
  }

  function advanceMyPrediction() {
    if (!myPrediction) return;
    myPrediction.prevX = myPrediction.x;
    myPrediction.prevZ = myPrediction.z;
    myPrediction.prevFacing = myPrediction.facing;

    if (myPrediction.order.pathIndex < myPrediction.order.path.length) {
      const myPlayer = sim.players.get(myId);
      const carriedCube = myPlayer?.carrying ? sim.cubes.get(myPlayer.carrying) : null;
      const speed = carriedCube ? BASE_SPEED / (1 + 0.35 * carriedCube.weight) : BASE_SPEED;
      advanceAlongPath(myPrediction, speed, TICK_MS / 1000);
    }

    // Only clear once the authoritative sim has actually applied *this*
    // prediction's own command (not a stale earlier or not-yet-arrived later
    // one) and its resulting order has resolved back to idle -- immediately,
    // if the authoritative path turned out to be unreachable, or once the
    // walk finishes, otherwise.
    if (appliedMoveCount >= myPrediction.targetMoveSeq) {
      const authOrder = sim.players.get(myId)?.order;
      if (authOrder && authOrder.type === "idle") {
        myPrediction = null;
      }
    }
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

  // Reusable scratch objects for the yaw+lean composition in render() below
  // -- avoids allocating fresh Quaternions/Vectors every player, every frame.
  const _yawQuat = new THREE.Quaternion();
  const _leanQuat = new THREE.Quaternion();
  const _yAxis = new THREE.Vector3(0, 1, 0);
  const _xAxis = new THREE.Vector3(1, 0, 0);

  // playerId -> spring-follow state for the movement "juice" (see smoothDamp above).
  const motionState = new Map();
  window.__motionState = motionState; // debug/test hook: inspect the spring-follow state
  function getMotionState(id, initialX, initialZ) {
    let m = motionState.get(id);
    if (!m) {
      m = { x: initialX, z: initialZ, velX: { value: 0 }, velZ: { value: 0 }, prevSpeed: 0, lean: 0 };
      motionState.set(id, m);
    }
    return m;
  }

  function applyDueCommands() {
    while (pendingCommands.length) {
      const next = pendingCommands[0];
      const localExecAt = next.execAt - clockOffset;
      if (localExecAt > simClock) break;
      pendingCommands.shift();
      applyCommand(sim, next.playerId, next.cmd);
      if (next.playerId === myId && next.cmd.kind === "move") appliedMoveCount++;
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
      advanceMyPrediction();
      accumulatorMs -= TICK_MS;
    }

    // Normally < 1 (mid-tick leftover), but the catch-up loop above can exit
    // early with a large backlog still queued (real-time budget hit, not yet
    // caught up) -- clamp so we render at currSnap instead of extrapolating
    // wildly past it; the rest of the backlog plays out over the next
    // frame(s).
    const alpha = Math.min(accumulatorMs / TICK_MS, 1);
    render(alpha, Math.max(frameDelta, 1) / 1000);

    if (clickMarker.material.opacity > 0) {
      const age = performance.now() - clickMarkerFadeStart;
      clickMarker.material.opacity = Math.max(0, 0.9 - age / 400);
    }

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  function render(alpha, dt) {
    for (const [id, mesh] of playerMeshes) {
      let targetX, targetZ, facing;
      if (id === myId && myPrediction) {
        // Instant local feedback takes over my own avatar's target position
        // entirely while a prediction is in flight -- see the comment by
        // myPrediction's declaration.
        targetX = myPrediction.prevX + (myPrediction.x - myPrediction.prevX) * alpha;
        targetZ = myPrediction.prevZ + (myPrediction.z - myPrediction.prevZ) * alpha;
        facing = lerpAngle(myPrediction.prevFacing, myPrediction.facing, alpha);
      } else {
        const a = prevSnap.players[id];
        const b = currSnap.players[id];
        if (!a || !b) continue;
        targetX = a.x + (b.x - a.x) * alpha;
        targetZ = a.z + (b.z - a.z) * alpha;
        facing = lerpAngle(a.facing, b.facing, alpha);
      }

      // Spring-follow the authoritative target instead of snapping to it --
      // see the smoothDamp comment up top for why this alone produces
      // smooth accel/decel. Lean is derived from the spring's own
      // acceleration (speeding up = lean in, braking = lean back).
      const m = getMotionState(id, targetX, targetZ);
      m.x = smoothDamp(m.x, targetX, m.velX, SPRING_SMOOTH_TIME, dt);
      m.z = smoothDamp(m.z, targetZ, m.velZ, SPRING_SMOOTH_TIME, dt);

      const speed = Math.hypot(m.velX.value, m.velZ.value);
      const accel = (speed - m.prevSpeed) / dt;
      m.prevSpeed = speed;
      const targetLean = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, accel * LEAN_ACCEL_SCALE));
      m.lean += (targetLean - m.lean) * Math.min(1, dt / LEAN_SMOOTH_TIME);

      mesh.position.set(m.x, PLAYER_REST_Y + columnTopY(m.x, m.z), m.z);
      // Lean has to tip the avatar's *own* forward axis, not a fixed world
      // axis -- setting rotation.x directly (as before) always tips toward
      // world +Z (i.e. toward the camera) no matter which way the avatar is
      // actually facing. Composing yaw (world Y) with lean (the yawed
      // mesh's own local X) gets the tip pointed the right way regardless
      // of travel direction: qYaw * qLean applies qLean in the frame yaw
      // already rotated into, which is exactly "lean forward relative to
      // where I'm facing."
      _yawQuat.setFromAxisAngle(_yAxis, facing);
      _leanQuat.setFromAxisAngle(_xAxis, m.lean);
      mesh.quaternion.copy(_yawQuat).multiply(_leanQuat);

      if (id === myId) {
        myMarker.position.x = m.x;
        myMarker.position.z = m.z;
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
