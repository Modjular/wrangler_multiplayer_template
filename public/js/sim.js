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
export const RAMP_CHANCE = 0.25; // fraction of generated cubes that become ramps
export const MAX_STACK_HEIGHT = 4; // cap how tall a column of cubes can get
export const BASE_SPEED = 3.2; // units/sec
export const ARRIVE_EPSILON = 0.05;

// Purely cosmetic mesh variants for "block" cubes -- see game.js. Doesn't
// affect gameplay at all (walkability, stacking, carrying are all keyed off
// `type`, never `shape`), it's just which geometry a block renders as.
export const BLOCK_SHAPES = ["cube", "octagon", "cylinder"];

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

// Cubes stack: a grid cell is a *column*, and each cube in it sits at an
// integer `level` (0 = resting on the ground, 1 = resting on whatever's at
// level 0, etc.) with no gaps — gather only ever removes the topmost cube in
// a column (see applyCommand), so the stack can never end up with a hole.
// columnHeight() is how many cubes are piled there, i.e. also the level a
// newly-delivered cube would land on and the height a player stands at when
// they're in this column.
export function columnHeight(sim, cx, cz) {
  let count = 0;
  for (const cube of sim.cubes.values()) {
    if (cube.carriedBy === null && cube.cx === cx && cube.cz === cz) count++;
  }
  return count;
}

function topCubeAt(sim, cx, cz) {
  let top = null;
  for (const cube of sim.cubes.values()) {
    if (cube.carriedBy === null && cube.cx === cx && cube.cz === cz) {
      if (!top || cube.level > top.level) top = cube;
    }
  }
  return top;
}

// Can a player standing in column (fromCx,fromCz) step into the adjacent
// column (toCx,toCz)? Flat moves and stepping down are always fine (like
// walking off a ledge); stepping up by exactly one level requires the
// destination's topmost cube to be a ramp -- that's the entire "ramps let
// you climb, bare blocks are walls" mechanic. Climbing more than one level
// in a single step is never allowed, no matter what's there.
function canStep(sim, fromCx, fromCz, toCx, toCz) {
  if (!inBounds(toCx, toCz)) return false;
  const fromHeight = columnHeight(sim, fromCx, fromCz);
  const toHeight = columnHeight(sim, toCx, toCz);
  if (toHeight <= fromHeight) return true;
  if (toHeight === fromHeight + 1) {
    const top = topCubeAt(sim, toCx, toCz);
    return top !== null && top.type === "ramp";
  }
  return false;
}

// Diagonal moves are kept simple: same-height only. Climbing/descending is
// only ever done by stepping orthogonally onto a ramp -- otherwise corner
// cases like "diagonal climb past the corner of a block" get ambiguous fast.
function isFlatStep(sim, fromCx, fromCz, toCx, toCz) {
  return canStep(sim, fromCx, fromCz, toCx, toCz) && columnHeight(sim, fromCx, fromCz) === columnHeight(sim, toCx, toCz);
}

// Every column adjacent to (targetCx, targetCz) whose height is exactly
// `requiredHeight` -- i.e. every cell a player could actually be standing on
// to reach/deliver something at that column (see findApproachAtHeight's
// "forklift" rule: you have to be level with it). Exported so game.js can
// seed a reachability flood fill from the real approach cells instead of
// from the target's own column, which is usually one level too tall to
// reflect where a player actually stands -- see reachableColumnsFromApproach
// and hasReachableApproach below.
export function approachCells(sim, targetCx, targetCz, requiredHeight) {
  const cells = [];
  for (const [dx, dz] of NEIGHBORS_4) {
    const cx = targetCx + dx;
    const cz = targetCz + dz;
    if (!inBounds(cx, cz)) continue;
    if (columnHeight(sim, cx, cz) === requiredHeight) cells.push({ cx, cz });
  }
  return cells;
}

function floodFillColumns(sim, startCells) {
  const key = (cx, cz) => `${cx},${cz}`;
  const visited = new Set(startCells.map(({ cx, cz }) => key(cx, cz)));
  const queue = startCells.map(({ cx, cz }) => [cx, cz]);
  while (queue.length) {
    const [cx, cz] = queue.shift();
    for (const [dx, dz] of NEIGHBORS_4) {
      const ncx = cx + dx;
      const ncz = cz + dz;
      if (!inBounds(ncx, ncz)) continue;
      const nkey = key(ncx, ncz);
      if (visited.has(nkey)) continue;
      if (!canStep(sim, cx, cz, ncx, ncz)) continue;
      visited.add(nkey);
      queue.push([ncx, ncz]);
    }
  }
  return visited;
}

// Every column reachable from (fromX, fromZ) by a sequence of legal steps
// (see canStep) -- a flood fill, not a path to one specific goal. Orthogonal
// neighbors only: a legal diagonal step requires both straddling orthogonal
// cells to already be a legal flat step (see findPath), so it can never
// reach a column that isn't already in this set via one of them -- skipping
// diagonals here doesn't miss anything, it just avoids doing the extra work.
// Exported (read-only, no side effects) purely so game.js can build a "can I
// actually carry this out from here" UI hint (tinting the delivery-ghost
// preview) without re-deriving the stepping rules -- see game.js's
// beginCubeSelection/updateDragGhostAt and hasReachableApproach below.
export function reachableColumns(sim, fromX, fromZ) {
  const start = worldToCell(fromX, fromZ);
  return floodFillColumns(sim, [start]);
}

// Same flood fill, but seeded from every valid approach cell around
// (targetCx, targetCz) at `requiredHeight` (see approachCells) instead of a
// single point -- for "everywhere reachable once I'm standing next to
// <cube>", where the cube's own column is *not* a valid stand-on point (it's
// usually one level taller than the approach height) and there can be more
// than one legal side to approach from.
export function reachableColumnsFromApproach(sim, targetCx, targetCz, requiredHeight) {
  return floodFillColumns(sim, approachCells(sim, targetCx, targetCz, requiredHeight));
}

// Given a set of columns reachable from wherever the player will actually be
// standing (see reachableColumns), is there a column adjacent to
// (targetCx, targetCz) at exactly `requiredHeight` in that set? Mirrors the
// "stand level with the thing you're reaching for" requirement
// findApproachAtHeight enforces for real (the "forklift" rule -- see
// CLAUDE.md-adjacent comments on findApproachAtHeight), just checked against
// a precomputed reachable set instead of running its own pathfind.
export function hasReachableApproach(sim, reachableSet, targetCx, targetCz, requiredHeight) {
  return approachCells(sim, targetCx, targetCz, requiredHeight).some(({ cx, cz }) => reachableSet.has(`${cx},${cz}`));
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
    const type = rng() < RAMP_CHANCE ? "ramp" : "block";
    const shape = type === "block" ? BLOCK_SHAPES[Math.floor(rng() * BLOCK_SHAPES.length)] : null;
    const cubeId = `cube_${id++}`;
    cubes.set(cubeId, { id: cubeId, cx, cz, level: 0, weight, type, shape, carriedBy: null });
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
// point. Returns [] if unreachable -- every column is a valid destination in
// principle (you can always be standing in it, at its own height), so
// "unreachable" now purely means no climbable route gets you there, not that
// the cell itself is off-limits. Unlike before ramps existed, there's no
// "nearest walkable cell" fallback: a click on a spot you can't climb to
// just fails, the same way a boxed-in gather/delivery already does.
//
// Exported (read-only, no side effects) so game.js can compute the same
// path locally for instant-feedback client-side prediction of the local
// player's own "move" commands, without waiting for the lockstep round
// trip. See game.js's motion-prediction comment for the full picture.
export function findPath(sim, fromX, fromZ, toX, toZ) {
  const start = worldToCell(fromX, fromZ);
  const goal = worldToCell(toX, toZ);

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
      const isDiagonal = dx !== 0 && dz !== 0;
      if (isDiagonal) {
        if (!isFlatStep(sim, current.cx, current.cz, ncx, ncz)) continue;
        // prevent cutting across the corner of two blocked/mismatched-height cells
        if (
          !isFlatStep(sim, current.cx, current.cz, current.cx + dx, current.cz) ||
          !isFlatStep(sim, current.cx, current.cz, current.cx, current.cz + dz)
        ) {
          continue;
        }
      } else if (!canStep(sim, current.cx, current.cz, ncx, ncz)) {
        continue;
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

// Finds the shortest path to a cell adjacent to (targetCx, targetCz) whose
// own column height exactly matches `requiredHeight` -- used both to
// approach a cube for gathering (stand level with the cube itself, which is
// always the topmost thing in its column) and to approach a delivery
// destination for dropping (stand level with the column's current top, so
// the new cube lands right on top of it). Reusing findPath means the
// approach cell also has to be climbably *reachable*, not just adjacent and
// the right height -- a ramp-less wall around it still blocks the plan.
function findApproachAtHeight(sim, fromX, fromZ, targetCx, targetCz, requiredHeight) {
  let best = null;
  for (const [dx, dz] of NEIGHBORS_4) {
    const cx = targetCx + dx;
    const cz = targetCz + dz;
    if (!inBounds(cx, cz)) continue;
    if (columnHeight(sim, cx, cz) !== requiredHeight) continue;
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
      // Can only grab the topmost cube in a column -- anything else has a
      // cube resting on it and physically can't be reached.
      if (cube.level !== columnHeight(sim, cube.cx, cube.cz) - 1) return;
      const path = findApproachAtHeight(sim, player.x, player.z, cube.cx, cube.cz, cube.level);
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
      if (cube.level !== columnHeight(sim, cube.cx, cube.cz) - 1) return;
      const { cx: destCx, cz: destCz } = worldToCell(cmd.x, cmd.z);
      if (!inBounds(destCx, destCz)) return;
      if (columnHeight(sim, destCx, destCz) >= MAX_STACK_HEIGHT) {
        console.warn(
          `[sim] move_block: destination (${destCx},${destCz}) for cube ${cmd.cubeId} is already at max stack height, plan rejected`
        );
        return;
      }
      const path = findApproachAtHeight(sim, player.x, player.z, cube.cx, cube.cz, cube.level);
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
      if (!inBounds(targetCx, targetCz)) return;
      const targetHeight = columnHeight(sim, targetCx, targetCz);
      if (targetHeight >= MAX_STACK_HEIGHT) return;
      const cube = sim.cubes.get(player.carrying);
      cube.carriedBy = null;
      cube.cx = targetCx;
      cube.cz = targetCz;
      cube.level = targetHeight;
      player.carrying = null;
      break;
    }
    default:
      break;
  }
}

// Exported so game.js can drive the exact same movement math for local
// prediction (see findPath's export comment above) -- mutates `player.x`,
// `.z`, `.facing`, and `.order.pathIndex` in place, same as it does for the
// real sim; the caller can pass in a throwaway object shaped like a player
// for a purely-local, never-networked prediction.
export function advanceAlongPath(player, speed, dt) {
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
      const stillTopmost = target && target.level === columnHeight(sim, target.cx, target.cz) - 1;
      if (target && target.carriedBy === null && stillTopmost) {
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
        const stillTopmost = target && target.level === columnHeight(sim, target.cx, target.cz) - 1;
        if (!target || target.carriedBy !== null || !stillTopmost) {
          console.warn(`[sim] deliver: cube ${cubeId} is no longer available, plan abandoned`);
          player.order = { type: "idle" };
          continue;
        }
        target.carriedBy = player.id;
        player.carrying = target.id;

        const destHeight = columnHeight(sim, destCx, destCz);
        if (destHeight >= MAX_STACK_HEIGHT) {
          console.warn(
            `[sim] deliver: destination (${destCx},${destCz}) for cube ${cubeId} is already at max stack height, plan abandoned (still carrying)`
          );
          player.order = { type: "idle" };
          continue;
        }
        const path = findApproachAtHeight(sim, player.x, player.z, destCx, destCz, destHeight);
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
      const destHeight = columnHeight(sim, destCx, destCz);
      if (destHeight >= MAX_STACK_HEIGHT) {
        console.warn(
          `[sim] deliver: destination (${destCx},${destCz}) for cube ${cubeId} became full, plan abandoned (still carrying)`
        );
        player.order = { type: "idle" };
        continue;
      }
      const deliveredCube = sim.cubes.get(cubeId);
      deliveredCube.carriedBy = null;
      deliveredCube.cx = destCx;
      deliveredCube.cz = destCz;
      deliveredCube.level = destHeight;
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
    cubes[id] = { cx: c.cx, cz: c.cz, level: c.level, type: c.type, shape: c.shape, weight: c.weight, carriedBy: c.carriedBy };
  }
  return { players, cubes };
}
