// Deterministic simulation core, shared conceptually by every client (there is
// no server-side copy of this — see CLAUDE.md/README for the architecture:
// the server only relays ordered commands, each client simulates the world
// itself). This module must stay pure (no THREE, no DOM, no Date.now(),
// no Math.random()) — anything that reads real time or ambient randomness
// would make one client's world diverge from another's.
//
// Callers drive it with two operations:
//   applyCommand(sim, playerId, cmd)  — mutates a player's order in response
//                                        to a relayed move/gather/drop command
//   step(sim, dt)                     — advances the world by a fixed dt
// Both must be called in the same order, with the same dt, on every client
// for the simulations to stay in sync.

export const GRID_SIZE = 20;
export const CELL_SIZE = 1;
export const CUBE_COUNT = 18;
export const BASE_SPEED = 3.2; // units/sec
export const ARRIVE_EPSILON = 0.05;

const SQRT2 = Math.SQRT2;

// 8 octants in the same winding as DIR_INDEX below, index i is the grid
// offset for facing angle i * 45deg (facing 0 = +z, matching Math.atan2(dx,dz)
// as used for the mesh's rotation.y in game.js).
const OCTANTS = [
  [0, 1],
  [1, 1],
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
];

const NEIGHBORS_8 = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
];

const NEIGHBORS_4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// Small deterministic PRNG (mulberry32) — same seed always produces the same
// sequence, on any client, unlike Math.random().
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function worldToCell(x, z) {
  return {
    cx: Math.floor(x / CELL_SIZE + GRID_SIZE / 2),
    cz: Math.floor(z / CELL_SIZE + GRID_SIZE / 2),
  };
}

export function cellCenter(cx, cz) {
  return {
    x: (cx - GRID_SIZE / 2 + 0.5) * CELL_SIZE,
    z: (cz - GRID_SIZE / 2 + 0.5) * CELL_SIZE,
  };
}

function inBounds(cx, cz) {
  return cx >= 0 && cx < GRID_SIZE && cz >= 0 && cz < GRID_SIZE;
}

// TODO(ramps): cubes are currently pure walls — isWalkable() always treats an
// occupied cell as impassable. A future "ramp" cube type should be walkable
// *on top of* (an elevated platform, not just an obstacle), which will need
// its own case here and in the renderer. Deliberately out of scope for the
// delivery-plan feature below.
function cubeAtCell(sim, cx, cz) {
  for (const cube of sim.cubes.values()) {
    if (cube.carriedBy === null && cube.cx === cx && cube.cz === cz) return cube;
  }
  return null;
}

function isWalkable(sim, cx, cz) {
  return inBounds(cx, cz) && !cubeAtCell(sim, cx, cz);
}

// Generates the scattered cube layout from the match seed. Every client calls
// this with the same seed and gets the identical layout back — the server
// never needs to send cube positions at all.
function generateCubes(seed, excludeCells) {
  const rng = mulberry32(seed);
  const excluded = new Set(excludeCells.map(([x, z]) => `${x},${z}`));
  const cubes = new Map();
  let id = 0;
  let attempts = 0;
  while (cubes.size < CUBE_COUNT && attempts < CUBE_COUNT * 50) {
    attempts++;
    const cx = Math.floor(rng() * GRID_SIZE);
    const cz = Math.floor(rng() * GRID_SIZE);
    const key = `${cx},${cz}`;
    if (excluded.has(key)) continue;
    if ([...cubes.values()].some((c) => c.cx === cx && c.cz === cz)) continue;
    const weight = 1 + Math.floor(rng() * 3); // 1..3
    const cubeId = `cube_${id++}`;
    cubes.set(cubeId, { id: cubeId, cx, cz, weight, carriedBy: null });
  }
  return cubes;
}

export function createSimulation({ seed, players }) {
  const spawnCells = players.map((p) => {
    const { cx, cz } = worldToCell(p.x, p.z);
    return [cx, cz];
  });
  const cubes = generateCubes(seed, spawnCells);

  const playerMap = new Map();
  for (const p of players) {
    playerMap.set(p.id, {
      id: p.id,
      x: p.x,
      z: p.z,
      facing: 0,
      carrying: null,
      order: { type: "idle" },
    });
  }

  return { gridSize: GRID_SIZE, cellSize: CELL_SIZE, cubes, players: playerMap, tick: 0 };
}

// 8-directional A* over the grid. Returns a list of world-space waypoints
// (cell centers), with the final waypoint replaced by the exact requested
// point if its cell is walkable. Returns [] if unreachable.
function findPath(sim, fromX, fromZ, toX, toZ) {
  const start = worldToCell(fromX, fromZ);
  let goal = worldToCell(toX, toZ);

  if (!isWalkable(sim, goal.cx, goal.cz)) {
    // fall back to the nearest walkable cell to the click
    let best = null;
    let bestDist = Infinity;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const cx = goal.cx + dx;
        const cz = goal.cz + dz;
        if (!isWalkable(sim, cx, cz)) continue;
        const d = dx * dx + dz * dz;
        if (d < bestDist) {
          bestDist = d;
          best = { cx, cz };
        }
      }
    }
    if (!best) return [];
    goal = best;
  }

  if (start.cx === goal.cx && start.cz === goal.cz) {
    return [{ x: toX, z: toZ }];
  }

  const key = (cx, cz) => `${cx},${cz}`;
  const gScore = new Map([[key(start.cx, start.cz), 0]]);
  const cameFrom = new Map();
  const open = [{ cx: start.cx, cz: start.cz, f: heuristic(start, goal) }];
  const closed = new Set();

  function heuristic(a, b) {
    const dx = Math.abs(a.cx - b.cx);
    const dz = Math.abs(a.cz - b.cz);
    return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz);
  }

  while (open.length) {
    open.sort((a, b) => a.f - b.f || a.cx - b.cx || a.cz - b.cz);
    const current = open.shift();
    const ckey = key(current.cx, current.cz);
    if (closed.has(ckey)) continue;
    closed.add(ckey);

    if (current.cx === goal.cx && current.cz === goal.cz) {
      const path = [];
      let k = ckey;
      while (cameFrom.has(k)) {
        const [cx, cz] = k.split(",").map(Number);
        path.unshift({ cx, cz });
        k = cameFrom.get(k);
      }
      const waypoints = path.map(({ cx, cz }) => cellCenter(cx, cz));
      if (waypoints.length) waypoints[waypoints.length - 1] = { x: toX, z: toZ };
      return waypoints;
    }

    for (const [dx, dz, cost] of NEIGHBORS_8) {
      const ncx = current.cx + dx;
      const ncz = current.cz + dz;
      if (!isWalkable(sim, ncx, ncz)) continue;
      if (dx !== 0 && dz !== 0) {
        // prevent cutting across the corner of two blocked cells
        if (!isWalkable(sim, current.cx + dx, current.cz) || !isWalkable(sim, current.cx, current.cz + dz)) {
          continue;
        }
      }
      const nkey = key(ncx, ncz);
      if (closed.has(nkey)) continue;
      const tentativeG = gScore.get(ckey) + cost;
      if (tentativeG < (gScore.get(nkey) ?? Infinity)) {
        gScore.set(nkey, tentativeG);
        cameFrom.set(nkey, ckey);
        open.push({ cx: ncx, cz: ncz, f: tentativeG + heuristic({ cx: ncx, cz: ncz }, goal) });
      }
    }
  }

  return [];
}

// Finds the shortest path to a walkable cell adjacent to (targetCx, targetCz)
// — used both to approach a cube for gathering and to approach a delivery
// destination for dropping, since neither the cube itself nor (once dropped)
// the destination cell is something a player can stand on.
function findAdjacentApproach(sim, fromX, fromZ, targetCx, targetCz) {
  let best = null;
  for (const [dx, dz] of NEIGHBORS_4) {
    const cx = targetCx + dx;
    const cz = targetCz + dz;
    if (!isWalkable(sim, cx, cz)) continue;
    const center = cellCenter(cx, cz);
    const path = findPath(sim, fromX, fromZ, center.x, center.z);
    if (!path.length && !(fromX === center.x && fromZ === center.z)) continue;
    const len = pathLength(fromX, fromZ, path);
    if (!best || len < best.len) best = { path, len };
  }
  return best ? best.path : [];
}

function pathLength(fromX, fromZ, path) {
  let total = 0;
  let x = fromX;
  let z = fromZ;
  for (const wp of path) {
    total += Math.hypot(wp.x - x, wp.z - z);
    x = wp.x;
    z = wp.z;
  }
  return total;
}

export function applyCommand(sim, playerId, cmd) {
  const player = sim.players.get(playerId);
  if (!player) return;

  switch (cmd.kind) {
    case "move": {
      const path = findPath(sim, player.x, player.z, cmd.x, cmd.z);
      player.order = path.length ? { type: "move", path, pathIndex: 0 } : { type: "idle" };
      break;
    }
    case "gather": {
      const cube = sim.cubes.get(cmd.cubeId);
      if (!cube || cube.carriedBy !== null || player.carrying !== null) return;
      const path = findAdjacentApproach(sim, player.x, player.z, cube.cx, cube.cz);
      player.order = path.length
        ? { type: "gather", cubeId: cmd.cubeId, path, pathIndex: 0 }
        : { type: "idle" };
      break;
    }
    // A "plan" the player's avatar carries out on its own over two phases
    // (see `step()`): walk to the cube and pick it up, then walk to the
    // destination and drop it there. Either phase can fail if the avatar
    // can't find a path — e.g. it's boxed in by other cubes that need to be
    // moved first — in which case the plan is abandoned and a warning is
    // logged (see step() for details). This runs identically on every
    // client since it's part of the deterministic sim, so console.warn here
    // is safe: it has no bearing on simulation state, just visibility.
    case "move_block": {
      const cube = sim.cubes.get(cmd.cubeId);
      if (!cube || cube.carriedBy !== null || player.carrying !== null) return;
      const { cx: destCx, cz: destCz } = worldToCell(cmd.x, cmd.z);
      if (!isWalkable(sim, destCx, destCz)) {
        console.warn(
          `[sim] move_block: destination (${destCx},${destCz}) for cube ${cmd.cubeId} isn't walkable, plan rejected`
        );
        return;
      }
      const path = findAdjacentApproach(sim, player.x, player.z, cube.cx, cube.cz);
      if (!path.length) {
        console.warn(
          `[sim] move_block: player ${playerId} has no path to cube ${cmd.cubeId}, plan rejected`
        );
        return;
      }
      player.order = {
        type: "deliver",
        cubeId: cmd.cubeId,
        destCx,
        destCz,
        phase: "to_cube",
        path,
        pathIndex: 0,
      };
      break;
    }
    case "drop": {
      if (player.carrying === null) return;
      const { cx, cz } = worldToCell(player.x, player.z);
      const octant = (((Math.round(player.facing / (Math.PI / 4)) % 8) + 8) % 8);
      const [dx, dz] = OCTANTS[octant];
      const targetCx = cx + dx;
      const targetCz = cz + dz;
      if (!isWalkable(sim, targetCx, targetCz)) return;
      const cube = sim.cubes.get(player.carrying);
      cube.carriedBy = null;
      cube.cx = targetCx;
      cube.cz = targetCz;
      player.carrying = null;
      break;
    }
    default:
      break;
  }
}

function advanceAlongPath(player, speed, dt) {
  let remaining = speed * dt;
  while (remaining > 0 && player.order.pathIndex < player.order.path.length) {
    const wp = player.order.path[player.order.pathIndex];
    const dx = wp.x - player.x;
    const dz = wp.z - player.z;
    const dist = Math.hypot(dx, dz);
    if (dist < ARRIVE_EPSILON) {
      player.order.pathIndex++;
      continue;
    }
    if (dist <= remaining) {
      player.x = wp.x;
      player.z = wp.z;
      player.facing = Math.atan2(dx, dz);
      remaining -= dist;
      player.order.pathIndex++;
    } else {
      const t = remaining / dist;
      player.x += dx * t;
      player.z += dz * t;
      player.facing = Math.atan2(dx, dz);
      remaining = 0;
    }
  }
  return player.order.pathIndex >= player.order.path.length;
}

export function step(sim, dt) {
  for (const player of sim.players.values()) {
    const orderType = player.order.type;
    if (orderType !== "move" && orderType !== "gather" && orderType !== "deliver") continue;

    const carriedCube = player.carrying ? sim.cubes.get(player.carrying) : null;
    const speed = carriedCube ? BASE_SPEED / (1 + 0.35 * carriedCube.weight) : BASE_SPEED;
    const arrived = advanceAlongPath(player, speed, dt);

    if (!arrived) continue;

    if (orderType === "gather") {
      const target = sim.cubes.get(player.order.cubeId);
      if (target && target.carriedBy === null) {
        target.carriedBy = player.id;
        player.carrying = target.id;
      }
      player.order = { type: "idle" };
      continue;
    }

    if (orderType === "deliver") {
      const { cubeId, destCx, destCz } = player.order;

      if (player.order.phase === "to_cube") {
        const target = sim.cubes.get(cubeId);
        if (!target || target.carriedBy !== null) {
          console.warn(`[sim] deliver: cube ${cubeId} is no longer available, plan abandoned`);
          player.order = { type: "idle" };
          continue;
        }
        target.carriedBy = player.id;
        player.carrying = target.id;

        const path = findAdjacentApproach(sim, player.x, player.z, destCx, destCz);
        if (!path.length) {
          console.warn(
            `[sim] deliver: player ${player.id} has no path to destination (${destCx},${destCz}) for cube ${cubeId}, plan abandoned (still carrying)`
          );
          player.order = { type: "idle" };
          continue;
        }
        player.order = { type: "deliver", cubeId, destCx, destCz, phase: "to_dest", path, pathIndex: 0 };
        continue;
      }

      // phase === "to_dest"
      if (!isWalkable(sim, destCx, destCz)) {
        console.warn(
          `[sim] deliver: destination (${destCx},${destCz}) for cube ${cubeId} became blocked, plan abandoned (still carrying)`
        );
        player.order = { type: "idle" };
        continue;
      }
      const deliveredCube = sim.cubes.get(cubeId);
      deliveredCube.carriedBy = null;
      deliveredCube.cx = destCx;
      deliveredCube.cz = destCz;
      player.carrying = null;
      player.order = { type: "idle" };
      continue;
    }

    player.order = { type: "idle" };
  }

  sim.tick++;
}

// Cheap structural snapshot for render-time interpolation between fixed
// steps — plain data, safe to lerp field-by-field in the renderer.
export function snapshot(sim) {
  const players = {};
  for (const [id, p] of sim.players) {
    players[id] = { x: p.x, z: p.z, facing: p.facing, carrying: p.carrying };
  }
  const cubes = {};
  for (const [id, c] of sim.cubes) {
    cubes[id] = { cx: c.cx, cz: c.cz, weight: c.weight, carriedBy: c.carriedBy };
  }
  return { players, cubes };
}
