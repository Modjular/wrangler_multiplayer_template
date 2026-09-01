// Offline diagnosis for a state file exported from the live game (press F9
// in-game, or `copy(__exportState())` in devtools -- see serializeState in
// public/js/sim.js and the F9 handler in public/js/game.js). Loads it back
// into a real `sim` object and runs sim.js's own pathing/reachability
// functions against it, so "why can't I place this here" questions get a
// concrete, step-by-step answer against the *exact* map that triggered the
// bug -- instead of hand-building a synthetic repro from scratch.
//
// Usage:
//   node scripts/debug-state.mjs <state.json>                          summary of players/cubes/columns
//   node scripts/debug-state.mjs <state.json> deliver <player> <cube> <destCx> <destCz>
//                                                                       diagnose a move_block: exactly which
//                                                                       check (if any) would reject it
//   node scripts/debug-state.mjs <state.json> reach <player>           every column reachable from a player's
//                                                                       current position right now

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deserializeState,
  columnHeight,
  approachCells,
  reachableColumns,
  reachableColumnsFromApproach,
  hasReachableApproach,
  withCubeVirtuallyRemoved,
  worldToCell,
  MAX_STACK_HEIGHT,
} from "../public/js/sim.js";

function usage() {
  return `Usage:
  node ${join("scripts", "debug-state.mjs")} <state.json>
  node ${join("scripts", "debug-state.mjs")} <state.json> deliver <playerId> <cubeId> <destCx> <destCz>
  node ${join("scripts", "debug-state.mjs")} <state.json> reach <playerId>`;
}

const [, , stateArg, command, ...args] = process.argv;
if (!stateArg) {
  console.error(usage());
  process.exit(1);
}

const statePath = stateArg.startsWith("/") ? stateArg : join(process.cwd(), stateArg);
let raw;
try {
  raw = JSON.parse(readFileSync(statePath, "utf8"));
} catch (err) {
  console.error(`Couldn't read/parse ${statePath}: ${err.message}`);
  process.exit(1);
}
const sim = deserializeState(raw);

function fmtCell(cx, cz) {
  return `(${cx},${cz})`;
}

function columnsSummary() {
  const columns = new Map(); // "cx,cz" -> cubes[]
  for (const cube of sim.cubes.values()) {
    if (cube.carriedBy !== null) continue;
    const key = `${cube.cx},${cube.cz}`;
    if (!columns.has(key)) columns.set(key, []);
    columns.get(key).push(cube);
  }
  const lines = [];
  for (const [key, cubes] of [...columns.entries()].sort()) {
    cubes.sort((a, b) => a.level - b.level);
    const stack = cubes.map((c) => `${c.type}${c.shape ? `/${c.shape}` : ""}(${c.id})`).join(" -> ");
    lines.push(`  ${key.padEnd(8)} height=${cubes.length}  ${stack}`);
  }
  return lines;
}

function summary() {
  console.log(`state: seed=${sim.seed} tick=${sim.tick} grid=${sim.gridSize}x${sim.gridSize}`);
  console.log(`\nplayers (${sim.players.size}):`);
  for (const p of sim.players.values()) {
    const cell = worldToCell(p.x, p.z);
    console.log(
      `  ${p.id}  at (${p.x.toFixed(2)},${p.z.toFixed(2)}) cell=${fmtCell(cell.cx, cell.cz)}  order=${p.order.type}` +
        (p.order.type === "deliver" ? ` (cube=${p.order.cubeId} phase=${p.order.phase} dest=${fmtCell(p.order.destCx, p.order.destCz)})` : "") +
        `  carrying=${p.carrying ?? "-"}  queue=[${p.queue.map((j) => j.cubeId).join(", ")}]`
    );
  }
  console.log(`\ncubes (${sim.cubes.size}), grouped by column:`);
  for (const line of columnsSummary()) console.log(line);
  console.log(`\nRun with "deliver <player> <cube> <destCx> <destCz>" to diagnose a specific placement,`);
  console.log(`or "reach <player>" to list every column that player can currently walk to.`);
}

// Mirrors tryStartDeliver's checks in sim.js step by step, plus the
// *second*-phase reachability check (cube's approach -> destination
// approach) that only gets validated live once the cube is actually picked
// up -- a delivery can pass every up-front check and still get silently
// abandoned later (see step()'s "phase === 'to_cube'" handling and its
// console.warn), which is the easiest failure mode to miss just by playing.
// Caller (the "deliver" case below) is responsible for checking that
// playerId/cubeId actually exist first, same as the "reach" case does for
// its own playerId -- keeps both subcommands' error handling consistent
// (console.error + exit 1) instead of this one printing its own error via
// console.log and exiting 0 as if the diagnosis had succeeded.
function diagnoseDeliver(playerId, cubeId, destCx, destCz) {
  const lines = [];
  const player = sim.players.get(playerId);
  const cube = sim.cubes.get(cubeId);

  lines.push(
    `cube ${cubeId}: type=${cube.type} shape=${cube.shape ?? "n/a"} at ${fmtCell(cube.cx, cube.cz)} level=${cube.level} weight=${cube.weight} carriedBy=${cube.carriedBy ?? "-"}`
  );
  lines.push(
    `player ${playerId}: at (${player.x.toFixed(2)},${player.z.toFixed(2)}) cell=${fmtCell(worldToCell(player.x, player.z).cx, worldToCell(player.x, player.z).cz)} order=${player.order.type} carrying=${player.carrying ?? "-"}`
  );

  if (cube.carriedBy !== null) {
    lines.push(`FAIL: cube is already being carried by ${cube.carriedBy}`);
    return lines;
  }
  if (player.carrying !== null) {
    lines.push(`FAIL: player is already carrying ${player.carrying} -- can't pick up a second cube at once`);
    return lines;
  }

  const colHeight = columnHeight(sim, cube.cx, cube.cz);
  const isTopmost = cube.level === colHeight - 1;
  lines.push(`column ${fmtCell(cube.cx, cube.cz)} height=${colHeight} -- cube is ${isTopmost ? "" : "NOT "}topmost`);
  if (!isTopmost) {
    lines.push(`FAIL: buried under ${colHeight - 1 - cube.level} other cube(s) -- gather/move those first`);
    return lines;
  }

  if (destCx < 0 || destCx >= sim.gridSize || destCz < 0 || destCz >= sim.gridSize) {
    lines.push(`FAIL: destination ${fmtCell(destCx, destCz)} is out of bounds (grid is ${sim.gridSize}x${sim.gridSize})`);
    return lines;
  }
  const destHeight = columnHeight(sim, destCx, destCz);
  lines.push(`destination ${fmtCell(destCx, destCz)} height=${destHeight} (cap is ${MAX_STACK_HEIGHT})`);
  if (destHeight >= MAX_STACK_HEIGHT) {
    lines.push(`FAIL: destination column is already at max stack height`);
    return lines;
  }

  // Phase 1: can the player reach an approach cell for the cube right now?
  const reachFromPlayer = reachableColumns(sim, player.x, player.z);
  const cubeApproaches = approachCells(sim, cube.cx, cube.cz, cube.level);
  lines.push(
    `cube's approach cells (height ${cube.level}): ${cubeApproaches.length ? cubeApproaches.map((c) => fmtCell(c.cx, c.cz)).join(", ") : "NONE"}`
  );
  const canFetch = hasReachableApproach(sim, reachFromPlayer, cube.cx, cube.cz, cube.level);
  lines.push(`player can reach the cube: ${canFetch ? "yes" : "NO"}`);
  if (!canFetch) {
    lines.push(
      cubeApproaches.length === 0
        ? `FAIL: no adjacent column is at the cube's own height (${cube.level}) -- nothing to stand on to grab it (the "forklift" rule, see CLAUDE.md)`
        : `FAIL: a matching-height approach cell exists but isn't reachable from the player's current position -- something blocks the route in between`
    );
    return lines;
  }

  // Phase 2: once picked up, can the player reach an approach cell for the
  // destination? Seeded from the cube's own approach cells, not its column
  // (see reachableColumnsFromApproach's doc comment). Both the destination's
  // own approach-cell lookup and the reachability check have to run with
  // the cube virtually removed from its own column too (see
  // withCubeVirtuallyRemoved's doc comment) -- otherwise a destination
  // whose only approach is exactly this cube's own column would misreport
  // as unreachable even though the real delivery would succeed.
  const reachFromCube = reachableColumnsFromApproach(sim, cube.cx, cube.cz, cube.level);
  const { destApproaches, canDeliver } = withCubeVirtuallyRemoved(sim, cube.cx, cube.cz, () => ({
    destApproaches: approachCells(sim, destCx, destCz, destHeight),
    canDeliver: hasReachableApproach(sim, reachFromCube, destCx, destCz, destHeight),
  }));
  lines.push(
    `destination's approach cells (height ${destHeight}): ${destApproaches.length ? destApproaches.map((c) => fmtCell(c.cx, c.cz)).join(", ") : "NONE"}`
  );
  lines.push(`reachable from the cube's location once picked up: ${canDeliver ? "yes" : "NO"}`);
  if (!canDeliver) {
    lines.push(
      destApproaches.length === 0
        ? `FAIL: no adjacent column at the destination is at the required height (${destHeight}) -- nowhere to stand to place it there`
        : `FAIL: a matching-height approach cell exists at the destination but isn't reachable from the cube's location -- this is the "silently abandoned mid-carry" failure mode (see step()'s console.warn), easy to miss just by playing`
    );
    return lines;
  }

  lines.push(
    `PASS: both phases have a valid, reachable approach -- this delivery should succeed. If it's still failing live, either the exported state is stale (the world moved on after export) or this is worth reporting as a real bug with this file attached.`
  );
  return lines;
}

switch (command ?? "summary") {
  case "summary":
    summary();
    break;
  case "deliver": {
    const [playerId, cubeId, cxStr, czStr] = args;
    if (!playerId || !cubeId || cxStr === undefined || czStr === undefined) {
      console.error(`usage: deliver <playerId> <cubeId> <destCx> <destCz>\n\n${usage()}`);
      process.exit(1);
    }
    if (!sim.players.has(playerId)) {
      console.error(`no such player "${playerId}" -- known players: ${[...sim.players.keys()].join(", ")}`);
      process.exit(1);
    }
    if (!sim.cubes.has(cubeId)) {
      console.error(`no such cube "${cubeId}"`);
      process.exit(1);
    }
    for (const line of diagnoseDeliver(playerId, cubeId, Number(cxStr), Number(czStr))) console.log(line);
    break;
  }
  case "reach": {
    const [playerId] = args;
    const player = sim.players.get(playerId);
    if (!player) {
      console.error(`no such player "${playerId}" -- known players: ${[...sim.players.keys()].join(", ")}`);
      process.exit(1);
    }
    const reach = reachableColumns(sim, player.x, player.z);
    console.log(`${reach.size} columns reachable from ${playerId} at (${player.x.toFixed(2)},${player.z.toFixed(2)}):`);
    console.log([...reach].sort().join(" "));
    break;
  }
  default:
    console.error(`unknown command "${command}"\n\n${usage()}`);
    process.exit(1);
}
