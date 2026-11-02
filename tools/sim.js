// Offline smoke-test for scripts/gemstone_route_setup.
// Mocks the Polinex scripting API on a tiny voxel world and runs the macro state machine tick by tick.
// It is NOT a Minecraft simulator: physics, Route Status and the planners are simplified on purpose.
// Usage: node tools/sim.js [scenario]
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPT_DIR = path.join(__dirname, "..", "scripts", "gemstone_route_setup");
const scenarioName = process.argv[2] || "basic";

// ---------------------------------------------------------------- world
let simTime = 1_700_000_000_000;
const blocks = new Map();
const K = (x, y, z) => Math.floor(x) + "," + Math.floor(y) + "," + Math.floor(z);
const BOUNDS = { x0: 0, x1: scenarioName === "far" ? 140 : 70, y0: 40, y1: 100, z0: 0, z1: 70 };
// "far": only X/Z within the render distance is loaded (full height), like the real client
const RD = scenarioName === "far" ? 32 : Infinity;
function loaded(x, y, z) { return Math.abs(x - P.x) <= RD && Math.abs(z - P.z) <= RD && x >= BOUNDS.x0 && x <= BOUNDS.x1 && y >= BOUNDS.y0 && y <= BOUNDS.y1 && z >= BOUNDS.z0 && z <= BOUNDS.z1; }
function get(x, y, z) {
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
  if (!loaded(x, y, z)) return null;
  return blocks.get(K(x, y, z)) || "minecraft:stone";
}
function set(x, y, z, id) { blocks.set(K(x, y, z), id); }
function isAir(id) { return id === "minecraft:air"; }
function passable(x, y, z) { const id = get(x, y, z); return id !== null && isAir(id); }
function solid(x, y, z) { const id = get(x, y, z); return id !== null && !isAir(id) && !/water|lava/.test(id); }
function fillBox(x0, y0, z0, x1, y1, z1, id) {
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) set(x, y, z, id);
}

// cavern: floor at y<=59, air 60..75
if (scenarioName !== "far" && scenarioName !== "shaft") fillBox(10, 60, 10, 50, 75, 50, "minecraft:air");
let warps;
let startPos = { x: 12.5, y: 60, z: 12.5 };
const lobbyState = { location: "CRYSTAL_HOLLOWS", id: "m12AB", lobbies: 0, fixOn: false };
if (scenarioName === "basic" || scenarioName === "gem") {
  fillBox(24, 60, 30, 26, 70, 32, "minecraft:stone"); // pillar between warps
  warps = [
    { number: 1, x: 20, y: 60, z: 20 }, // on the floor: needs a cobble
    { number: 2, x: 40, y: 63, z: 22 }, // floating 3 above floor: needs a bridge
    { number: 3, x: 30, y: 62, z: 45 }, // floating, line 1->3? (2->3 crosses nothing, 3->1 crosses pillar)
  ];
  if (scenarioName === "gem") {
    const a = { x: 30.5, y: 62 + 1 + 1.54, z: 45.5 }, b = { x: 20.5, y: 60.98, z: 20.5 };
    const c = ray(a, b).map((r) => r.cell).find((q) => q.z === 31);
    set(c.x, c.y, c.z, "minecraft:purple_stained_glass");
  }
} else if (scenarioName === "lobby" || scenarioName === "fix") {
  warps = [{ number: 1, x: 20, y: 60, z: 20 }, { number: 2, x: 30, y: 60, z: 30 }];
} else if (scenarioName === "far") {
  // start cavern A, a pocket 32 blocks east that the planner can only reach through a winding corridor
  // (north, east, south: starts by walking away), and the route in a lower cavern B far to the east.
  fillBox(10, 60, 10, 30, 66, 30, "minecraft:air");
  fillBox(19, 60, 3, 21, 61, 9, "minecraft:air");     // corridor north out of A
  fillBox(19, 60, 3, 48, 61, 4, "minecraft:air");     // east
  fillBox(46, 60, 3, 48, 61, 14, "minecraft:air");    // south
  fillBox(44, 60, 14, 50, 61, 18, "minecraft:air");   // pocket
  fillBox(95, 56, 10, 125, 64, 40, "minecraft:air");  // cavern B, floor at 55
  startPos = { x: 25.5, y: 60, z: 16.5 };
  warps = [{ number: 1, x: 100, y: 56, z: 16 }, { number: 2, x: 112, y: 56, z: 30 }];
} else if (scenarioName === "shaft") {
  // standing in a small pocket, the route is in a cavern straight below: must dig a vertical shaft
  fillBox(20, 70, 20, 24, 72, 24, "minecraft:air");
  fillBox(15, 56, 15, 35, 62, 35, "minecraft:air");   // lower cavern, floor 55
  startPos = { x: 22.3, y: 70, z: 22.8 };              // deliberately off-centre
  warps = [{ number: 1, x: 22, y: 56, z: 22 }, { number: 2, x: 30, y: 56, z: 30 }];
} else if (scenarioName === "diag") {
  // pocket in the far corner: the cavern is exactly diagonal (dx == dz), the old digger zigzagged here
  fillBox(60, 60, 60, 63, 61, 63, "minecraft:air");
  startPos = { x: 61.5, y: 60, z: 61.5 };
  warps = [{ number: 1, x: 40, y: 60, z: 40 }, { number: 2, x: 30, y: 60, z: 30 }];
} else if (scenarioName === "gemspot") {
  // waypoints sit inside gemstones (waypoint block + both landing blocks), with a vein next to them
  warps = [{ number: 1, x: 20, y: 60, z: 20 }, { number: 2, x: 30, y: 60, z: 34 }];
  warps.forEach((w) => {
    for (let dy = 0; dy <= 2; dy++) set(w.x, w.y + dy, w.z, "minecraft:purple_stained_glass");
    set(w.x + 1, w.y, w.z, "minecraft:purple_stained_glass_pane"); // vein beside the waypoint: must stay
  });
} else if (scenarioName === "bridge") {
  // waypoint floating 3 above the floor but right next to a wall: support goes sideways and must be removed
  fillBox(42, 60, 18, 50, 75, 26, "minecraft:stone");  // wall block of stone
  warps = [{ number: 1, x: 39, y: 64, z: 22 }, { number: 2, x: 20, y: 60, z: 20 }];
} else if (scenarioName === "tunnel") {
  // start in a separate pocket: must dig to reach the cavern
  fillBox(56, 60, 20, 60, 62, 24, "minecraft:air");
  startPos = { x: 58.5, y: 60, z: 22.5 };
  warps = [{ number: 1, x: 20, y: 60, z: 20 }, { number: 2, x: 30, y: 60, z: 30 }];
}

// ---------------------------------------------------------------- DDA voxel ray
function ray(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const steps = Math.max(1, Math.ceil(len * 20));
  const cells = [];
  let last = null;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = { x: a.x + dx * t, y: a.y + dy * t, z: a.z + dz * t };
    const k = K(p.x, p.y, p.z);
    if (k !== last) { cells.push({ cell: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }, at: p }); last = k; }
  }
  return cells;
}
function raytraceFrom(a, b) {
  const cells = ray(a, b);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i].cell;
    if (i === 0) continue;
    const id = get(c.x, c.y, c.z);
    if (id === null || !isAir(id)) {
      return { type: "BLOCK", x: cells[i].at.x, y: cells[i].at.y, z: cells[i].at.z, block: { x: c.x, y: c.y, z: c.z }, prev: cells[i - 1].cell };
    }
  }
  return { type: "MISS", x: b.x, y: b.y, z: b.z, block: null };
}

// ---------------------------------------------------------------- player
const P = { x: startPos.x, y: startPos.y, z: startPos.z, held: 0, keys: {}, aim: null, sneak: false };
const inv = { Cobblestone: 128, "Bob-omb": 8 };
const hotbar = ["Titanium Drill", "Cobblestone", "Bob-omb", "", "", "", "", "", ""];
const eye = () => ({ x: P.x, y: P.y + 1.54, z: P.z });
let walk = null; // { nodes, i }
let navFailed = false;
let breaking = { key: null, ticks: 0 };
const pendingBombs = [];
const log = [];
let stats = { mined: 0, placed: 0, bombs: 0, cmds: [], diagDownSteps: 0, inspectVerticalSteps: 0, inspectMinZ: 999, shaftSteps: 0, movedWhileMiningDown: 0, axisChanges: 0, attackPresses: 0, clicks: 0, floorMined: 0, turnDeg: 0, etherwarps: 0, placedDuringInspect: 0, gemsLeftNearRoute: 0 };
let lastAxis = null, lastAttack = false;
const hist = [];
const seenSteps = new Set();

function standableFeet(x, y, z) { return solid(x, y - 1, z) && passable(x, y, z) && passable(x, y + 1, z); }
function bfsPath(fromFeet, toFeet) {
  const start = K(fromFeet.x, fromFeet.y, fromFeet.z), goal = K(toFeet.x, toFeet.y, toFeet.z);
  const prev = new Map([[start, null]]);
  const q = [fromFeet];
  while (q.length && prev.size < 40000) {
    const c = q.shift();
    if (K(c.x, c.y, c.z) === goal) {
      const out = [];
      for (let k = goal; k; k = prev.get(k)) { const [x, y, z] = k.split(",").map(Number); out.unshift({ x: x + 0.5, y: y, z: z + 0.5, block: { x: x, y: y - 1, z: z }, type: "WALK" }); }
      return out;
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, 1, -1, -2, -3, -4]) {
        const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        const k = K(n.x, n.y, n.z);
        if (prev.has(k) || !standableFeet(n.x, n.y, n.z)) continue;
        if (dy === 1 && !passable(c.x, c.y + 2, c.z)) continue;
        if (dy < 0 && !(passable(n.x, c.y, n.z) && passable(n.x, c.y + 1, n.z))) continue; // drop: column must be open
        prev.set(k, K(c.x, c.y, c.z));
        q.push(n);
        break;
      }
    }
  }
  return null;
}
function feetBlock() { return { x: Math.floor(P.x), y: Math.floor(P.y), z: Math.floor(P.z) }; }
function lookAt(x, y, z) {
  const e = eye();
  const d = { x: x - e.x, y: y - e.y, z: z - e.z };
  const l = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z) || 1;
  const nd = { x: d.x / l, y: d.y / l, z: d.z / l };
  if (P.look) stats.turnDeg += Math.acos(Math.max(-1, Math.min(1, nd.x * P.look.x + nd.y * P.look.y + nd.z * P.look.z))) * 180 / Math.PI;
  if (process.env.PITCH && state === "GRS_INSPECT") {
    const pitch = -Math.asin(nd.y) * 180 / Math.PI, yaw = Math.atan2(-nd.x, nd.z) * 180 / Math.PI;
    const stp = DEBUG.ctx && DEBUG.ctx.mover.digger.step; console.log("LOOK yaw " + yaw.toFixed(0) + " pitch " + pitch.toFixed(0) + " P " + P.x.toFixed(2) + " aimpt " + [x, y, z].map((q) => q.toFixed(2)).join(",") + " stepAims " + (stp && stp.aims ? JSON.stringify(stp.aims) : "-") + " clear " + (stp ? JSON.stringify(stp.clear) : "-"));
  }
  P.look = nd;
  P.aim = { x, y, z };
}
function mouseOver() {
  if (!P.look) return null;
  const e = eye();
  const far = { x: e.x + P.look.x * 5, y: e.y + P.look.y * 5, z: e.z + P.look.z * 5 };
  const h = raytraceFrom(e, far);
  return h.type === "BLOCK" ? h : null;
}

// ---------------------------------------------------------------- route status mock
function eyeOn(w) { return { x: w.x + 0.5, y: w.y + 1 + 1.54, z: w.z + 0.5 }; }
function routeStatus() {
  const ws = warps.map((w, i) => {
    const nx = warps[(i + 1) % warps.length];
    const checked = Math.hypot(P.x - w.x, P.z - w.z) < Math.min(80, RD);
    const problems = [];
    if (!checked) problems.push("notLoaded");
    else {
      if (get(w.x, w.y, w.z) !== "minecraft:cobblestone" || !passable(w.x, w.y + 1, w.z) || !passable(w.x, w.y + 2, w.z)) problems.push("badWarpSpot");
      const h = raytraceFrom(eyeOn(w), { x: nx.x + 0.5, y: nx.y + 0.98, z: nx.z + 0.5 });
      if (h.type === "BLOCK" && !(h.block.x === nx.x && h.block.y === nx.y && h.block.z === nx.z)) problems.push(/glass/.test(get(h.block.x, h.block.y, h.block.z)) ? "lineToMine" : "lineBlocked");
    }
    return { number: w.number, x: w.x, y: w.y, z: w.z, checked: checked, problems: problems };
  });
  if ((scenarioName === "lobby" && lobbyState.id === "m12AB") || (scenarioName === "fix" && !lobbyState.fixOn)) ws[1].problems.push("veinMissing");
  if (lobbyState.location !== "CRYSTAL_HOLLOWS") return null;
  const unchecked = ws.filter((w) => !w.checked).length;
  const anyProblem = ws.some((w) => w.problems.length);
  const fatal = ws.some((w) => w.problems.indexOf("veinMissing") >= 0);
  const verdict = unchecked ? "Doable so far" : fatal ? "Not doable" : anyProblem ? "Doable" : "Set up";
  return { route: "test_route", editing: false, setUp: verdict === "Set up", verdict: verdict, reason: fatal ? "vein missing" : null, doable: verdict === "Doable" || verdict === "Set up",
    unchecked: unchecked, nearestUnchecked: null, scannerOn: true, warps: ws };
}

// ---------------------------------------------------------------- API mocks
const hooks = {};
let handle = null;
let running = false;
let failReason = null;
let state = "NONE";

const DEBUG = {};
const api = {
  console: console,
  __GRS_DEBUG__: DEBUG,
  Date: { now: () => simTime },
  Math: Math, JSON: JSON, Array: Array, Map: Map, Set: Set, Number: Number, String: String, Object: Object, RegExp: RegExp, Error: Error,
  on: (ev, fn) => { (hooks[ev] = hooks[ev] || []).push(fn); },
  script: {
    getOr: (k, d) => d, set() {}, get: () => null,
    log: (m) => log.push("[log] " + m), info: (m) => log.push("[info] " + m), warn: (m) => { log.push("[warn] " + m); if (process.env.DBG) console.log("WARN@", JSON.stringify({ x: P.x, y: P.y, z: P.z }), m); },
    error: (m) => log.push("[error] " + m), chat: (m) => log.push("[chat] " + m),
  },
  notification: { success: (t, d) => log.push("[toast+] " + d), error: (t, d) => log.push("[toast!] " + d), warning: (t, d) => log.push("[toast?] " + d), info: () => {} },
  commands: { register: () => () => {} },
  math: { randomInt: (a, b) => Math.floor((a + b) / 2) },
  client: { isInSkyblock: () => true },
  render: { worldLine() {}, worldText() {}, worldBeam() {} },
  inventory: { items: () => [], moveToHotbar: (a, b, cb) => cb && cb(false) },
  routes: {
    managers: () => [{ id: "gemstone", name: "Gemstone Routes", routeType: "GEMSTONE", targetType: "", waypointTypes: [] }],
    selected: () => ({ name: "test_route", route: { waypoints: warps.map((w) => ({ x: w.x, y: w.y, z: w.z, type: "WARP" })) } }),
  },
  skyblock: {
    location: () => lobbyState.location, scoreboard: () => ["11/02/26 " + lobbyState.id, "Crystal Hollows"], chStructures: () => [],
    hasMiningTool: () => true, hasEtherwarp: () => false,
  },
  scan: { codeName: (c) => (c === 0 ? "UNKNOWN" : c === 1 ? "AIR" : "SOLID"), isPassable: (c) => c === 1, isSolid: (c) => c === 2 },
  world: {
    blockState: (p) => { const id = get(p.x, p.y, p.z); return id === null ? null : { id: id, properties: {} }; },
    code: (p) => { const id = get(p.x, p.y, p.z); return id === null ? 0 : isAir(id) ? 1 : 2; },
    eyePos: () => eye(),
    raytraceFrom: raytraceFrom,
    raytrace: (to) => raytraceFrom(eye(), to),
    blocksBetween: (a, b) => ray(a, b).map((c) => c.cell),
  },
  mining: {
    routeStatus: routeStatus,
    visiblePoint: (b) => {
      const e = eye();
      const faces = [[0.5, 0.5, 0.5], [0.5, 1.0, 0.5], [0.5, 0, 0.5], [0, 0.5, 0.5], [1, 0.5, 0.5], [0.5, 0.5, 0], [0.5, 0.5, 1]];
      for (const f of faces) {
        const pt = { x: b.x + f[0] * 0.98 + 0.01, y: b.y + f[1] * 0.98 + 0.01, z: b.z + f[2] * 0.98 + 0.01 };
        const h = raytraceFrom(e, pt);
        if (h.type === "BLOCK" && h.block.x === b.x && h.block.y === b.y && h.block.z === b.z) return { x: h.x, y: h.y, z: h.z };
      }
      return null;
    },
    isMined: (b) => isAir(get(b.x, b.y, b.z) || "x"),
    ticksLeft: () => 3, drillSlot: () => 0, holdDrill: () => { P.held = 0; return true; }, refreshTools() {}, refreshCache() {},
    abilityReady: () => false, abilityActive: () => false, activatingAbility: () => false, ability: () => false,
    bestStandSpot: () => null, clearFakeLook() {},
  },
  rotation: {
    miningRotateToVec: (x, y, z) => lookAt(x, y, z), miningIsDone: () => true, miningIsRotating: () => false, miningStopRotation() {},
    generalRotateToVec: (x, y, z) => lookAt(x, y, z), generalIsDone: () => true, generalStopRotation() {},
    pathFindRotateToVec: (x, y, z) => lookAt(x, y, z), pathFindIsDone: () => true, pathFindStopRotation() {},
    etherwarpStopRotation() {}, distanceTo: () => 10,
  },
  etherwarp: { canReach: () => false, stop() {}, failed: () => false, directTo: () => { stats.etherwarps++; return false; },
    etherwarpTo: () => { stats.etherwarps++; return false; }, pathfindTo: () => { stats.etherwarps++; return false; } },
  nav: {
    findPathAsync: (from, target) => {
      const f = from ? { x: from.x, y: from.y + 1, z: from.z } : feetBlock();
      const nodes = bfsPath(f, { x: target.x, y: target.y + 1, z: target.z });
      return mkQuery(nodes ? "found" : "no_path", nodes);
    },
    distancesAsync: (from, targets) => { const q = mkQuery("found", null); q.costs = () => targets.map((t) => Math.hypot(P.x - t.x, P.z - t.z)); return q; },
    followPath: (nodes) => { walk = { nodes: Array.from(nodes), i: 0 }; navFailed = false; return true; },
    retarget: (t) => { const n = bfsPath(feetBlock(), { x: t.x, y: t.y + 1, z: t.z }); if (!n) return false; walk = { nodes: n, i: 0 }; return true; },
    stop: () => { walk = null; }, finished: () => !walk, failed: () => navFailed, awaitingPath: () => false, remainingNodes: () => (walk ? walk.nodes.length - walk.i : 0),
  },
  macro: {
    create: (cfg) => {
      const settings = {};
      cfg.settings.forEach((s) => { settings[s.id || s.name] = s.default; });
      const h = {
        cfg: cfg, states: {}, en: [], dis: [], huds: [], checks: [],
        name: () => cfg.name, setting: (id) => settings[id], setSetting: (id, v) => { settings[id] = v; return true; },
        onState: (n, fn) => { h.states[n.toUpperCase()] = fn; }, setState: (n) => { state = n.toUpperCase(); }, currentState: () => state,
        onEnable: (fn) => h.en.push(fn), onDisable: (fn) => h.dis.push(fn), onResume() {}, onHelperEnd() {}, onReturn() {}, onDeath() {},
        hud: (fn) => h.huds.push(fn), addStuckCheck: (c) => h.checks.push(c), fail: (r) => { failReason = r; running = false; },
      };
      handle = h;
      return h;
    },
    export() {},
    get: (n) => (scenarioName === "fix" && n === "Gemstone Macro" ? {
      name: () => "Gemstone Macro", settings: () => ["Route", "Dynamic Route Fix"],
      getSetting: (sn) => (sn === "Dynamic Route Fix" ? { name: () => sn, getValue: () => lobbyState.fixOn,
        setValue: (v) => { lobbyState.fixOn = !!v; if (v) { warps[1] = { number: 2, x: 31, y: 60, z: 31 }; } }, options: () => [] } : null),
      start() {}, stop() {}, isBeta: () => false,
    } : null),
    active: () => (running ? { name: () => handle.cfg.name, isPaused: () => false, isRunning: () => true, stop: () => { running = false; } } : null),
  },
  module: { get: () => null },
  player: {
    pos: () => ({ x: P.x, y: P.y, z: P.z }), speed: () => P.speed || 0,
    yaw: () => (P.look ? Math.atan2(-P.look.x, P.look.z) * 180 / Math.PI : 0),
    pitch: () => (P.look ? -Math.asin(P.look.y) * 180 / Math.PI : 0),
    motionX: () => P.mx || 0, motionZ: () => P.mz || 0, blockPos: feetBlock, x: () => P.x, y: () => P.y, z: () => P.z,
    onGround: () => !(P.jumpT > 0), jump: () => { if (!(P.jumpT > 0)) P.jumpT = 8; }, setKey: (k, v) => { P.keys[k] = v; }, releaseKeys: () => { P.keys = {}; }, resetWASD: () => { P.walkTo = null; },
    setSneaking: (v) => { P.sneak = v; }, stopAllMovement: () => { P.keys = {}; walk = null; },
    heldItemSlot: () => P.held, setHeldItemSlot: (s) => { P.held = s; return true; },
    itemByName: (n) => hotbar.findIndex((h) => h && h.toLowerCase().includes(n.toLowerCase()) && (inv[h] === undefined || inv[h] > 0)),
    itemCount: (n) => inv[n] || 0, etherwarpSlot: () => -1, aoteSlot: () => -1, isGuiOpen: () => false,
    mouseOverBlock: () => { const h = mouseOver(); return h ? h.block : null; },
    leftClick: () => { P.keys.click = true; stats.clicks++; return true; },
    rightClick: () => {
      const h = mouseOver();
      if (hotbar[P.held] === "Cobblestone" && h && inv.Cobblestone > 0) {
        const c = h.prev;
        const f = feetBlock();
        if (isAir(get(c.x, c.y, c.z) || "x") && !(c.x === f.x && c.z === f.z && (c.y === f.y || c.y === f.y + 1))) {
          set(c.x, c.y, c.z, "minecraft:cobblestone"); inv.Cobblestone--; stats.placed++;
          if (state === "GRS_INSPECT") stats.placedDuringInspect++;
        }
      } else if (hotbar[P.held] === "Bob-omb" && inv["Bob-omb"] > 0) {
        inv["Bob-omb"]--; stats.bombs++;
        pendingBombs.push({ at: simTime + 2500, p: h ? { x: h.x, y: h.y, z: h.z } : P.aim });
      }
      return true;
    },
    setOptimalKeysTo: (x, y, z) => { P.walkTo = { x, y, z }; },
    sendCommand: (c) => {
      stats.cmds.push(c);
      if (c === "warp hub") { lobbyState.location = "HUB"; (hooks.worldLoad || []).forEach((fn) => fn()); }
      if (c === "warp cn") {
        lobbyState.location = "CRYSTAL_HOLLOWS"; lobbyState.lobbies++;
        lobbyState.id = lobbyState.lobbies === 1 && scenarioName === "lobby" ? "m12AB" : "m9" + lobbyState.lobbies + "ZZ"; // first retry lands in the same lobby
        P.x = startPos.x; P.y = startPos.y; P.z = startPos.z; walk = null;
        (hooks.worldLoad || []).forEach((fn) => fn());
      }
    },
  },
};
function mkQuery(status, nodes) {
  return { status: () => status, finished: () => true, failed: () => status !== "found", error: () => null,
    result: () => (status === "found" ? nodes : null), costs: () => null, cancel() {} };
}

// ---------------------------------------------------------------- physics per tick
function physics() {
  if (P.keys.attack && !lastAttack) stats.attackPresses++;
  if (process.env.ATK && lastAttack && !P.keys.attack && DEBUG.ctx) {
    const st0 = DEBUG.ctx.mover.digger.step; const mo = mouseOver();
    console.log("RELEASE t=" + simTime, "phase", st0 && st0.phase, "feet", JSON.stringify(feetBlock()), "over", mo && JSON.stringify(mo.block), "id", mo && get(mo.block.x, mo.block.y, mo.block.z), "stepFeet", st0 && JSON.stringify(st0.feet));
  }
  lastAttack = !!P.keys.attack;
  const before = { x: P.x, z: P.z };
  // nav walking
  if (walk) {
    const n = walk.nodes[walk.i];
    if (!n) walk = null;
    else {
      const dx = n.x - P.x, dz = n.z - P.z, d = Math.hypot(dx, dz);
      if (d < 0.3) { P.x = n.x; P.z = n.z; P.y = n.y; walk.i++; if (walk.i >= walk.nodes.length) walk = null; }
      else { P.x += dx / d * 0.25; P.z += dz / d * 0.25; }
    }
  }
  // digger walking via setOptimalKeysTo
  if (P.walkTo) {
    const t = P.walkTo;
    const dx = t.x - P.x, dz = t.z - P.z, d = Math.hypot(dx, dz);
    const nx = d < 0.25 ? t.x : P.x + dx / d * 0.25, nz = d < 0.25 ? t.z : P.z + dz / d * 0.25;
    const ty = Math.floor(t.y), cy = Math.floor(P.y);
    if (passable(nx, cy, nz) && passable(nx, cy + 1, nz)) { P.x = nx; P.z = nz; }          // walk at current height (drops fall)
    else if (ty === cy + 1 && passable(nx, ty, nz) && passable(nx, ty + 1, nz) && passable(P.x, cy + 2, P.z)) { P.x = nx; P.z = nz; P.y = ty; } // step up
  }
  P.speed = Math.hypot(P.x - before.x, P.z - before.z);
  P.mx = P.x - before.x; P.mz = P.z - before.z;
  // jump + gravity
  if (P.jumpT > 0) {
    if (P.jumpT > 3 && passable(P.x, P.y + 2.1, P.z)) P.y += process.env.JUMPBOOST ? 0.6 : 0.3;
    P.jumpT--;
  } else {
    const fy = Math.floor(P.y);
    if (P.y !== fy) P.y = passable(P.x, fy, P.z) ? fy : fy + 1;
    while (P.y > BOUNDS.y0 && passable(P.x, P.y - 1, P.z)) P.y -= 1;
  }
  // mining
  if ((P.keys.attack || P.keys.click) && P.held === 0) {
    P.keys.click = false;
    const h = mouseOver();
    if (h) {
      const k = K(h.block.x, h.block.y, h.block.z);
      if (breaking.key !== k) breaking = { key: k, ticks: 0 };
      const id = get(h.block.x, h.block.y, h.block.z);
      if (process.env.ATK) { hist.push("t" + (simTime % 100000) + " P" + P.x.toFixed(2) + " phys-over " + JSON.stringify(h.block) + " bt " + (breaking.ticks + 1) + " phase " + (DEBUG.ctx && DEBUG.ctx.mover.digger.step && DEBUG.ctx.mover.digger.step.phase)); if (hist.length > 8) hist.shift(); }
      if (++breaking.ticks >= 3 && id !== "minecraft:bedrock") {
        if (h.block.y < Math.floor(P.y) && !(DEBUG.ctx && DEBUG.ctx.mover.digger.step && DEBUG.ctx.mover.digger.step.vertical)) {
          stats.floorMined++;
          if (process.env.ATK) console.log(hist.join("\n"));
          if (process.env.ATK) { const d = DEBUG.ctx, st1 = d.mover.digger.step; console.log("FLOOR", JSON.stringify(h.block), "P", P.x.toFixed(2), P.y, P.z.toFixed(2), "state", state, "step", st1 && st1.phase, "feet", st1 && JSON.stringify(st1.feet), "aheadLeft", st1 && st1.aheadLeft, "holdNext", st1 && st1.holdNext && JSON.stringify([...st1.holdNext]), "holding", d.miner.holding, "breakTicks", breaking.ticks); }
        }
        set(h.block.x, h.block.y, h.block.z, "minecraft:air"); stats.mined++; breaking = { key: null, ticks: 0 };
      }
    }
  }
  // bombs
  for (let i = pendingBombs.length - 1; i >= 0; i--) {
    const b = pendingBombs[i];
    if (simTime < b.at) continue;
    pendingBombs.splice(i, 1);
    for (let x = -3; x <= 3; x++) for (let y = -3; y <= 3; y++) for (let z = -3; z <= 3; z++) {
      if (x * x + y * y + z * z > 7) continue;
      const p = { x: Math.floor(b.p.x) + x, y: Math.floor(b.p.y) + y, z: Math.floor(b.p.z) + z };
      if (p.y <= 59) continue; // keep the cavern floor
      if (!/glass/.test(get(p.x, p.y, p.z) || "")) set(p.x, p.y, p.z, "minecraft:air");
    }
  }
}

// ---------------------------------------------------------------- load the script
function loadModule(file, cache) {
  const full = path.join(SCRIPT_DIR, file.replace(/^\.\//, "").replace(/(\.js)?$/, ".js"));
  if (cache[full]) return cache[full].exports;
  const mod = { exports: {} };
  cache[full] = mod;
  const moduleApi = Object.assign({}, api.module, { exports: mod.exports });
  const sandbox = Object.assign({}, api, { require: (f) => loadModule(f, cache) });
  sandbox.module = new Proxy(moduleApi, {
    get: (t, k) => (k === "exports" ? mod.exports : t[k]),
    set: (t, k, v) => { if (k === "exports") mod.exports = v; else t[k] = v; return true; },
  });
  sandbox.exports = mod.exports;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(full, "utf8"), sandbox, { filename: full });
  return mod.exports;
}
loadModule("main.js", {});

// ---------------------------------------------------------------- run
running = true;
handle.en.forEach((fn) => fn());
const MAX = Number(process.env.TICKS || 12000);
let t = 0;
let lastState = "";
for (; t < MAX && running; t++) {
  simTime += 50;
  (hooks.tick || []).forEach((fn) => fn());
  const fn = handle.states[state];
  if (fn) fn();
  physics();
  if (DEBUG.ctx) {
    const st0 = DEBUG.ctx.mover.digger.step;
    if (st0 && st0.from && !seenSteps.has(st0)) {
      seenSteps.add(st0);
      const horiz = st0.feet.x !== st0.from.x || st0.feet.z !== st0.from.z;
      if (st0.feet.y < st0.from.y && horiz && !st0.drop) stats.diagDownSteps++;
      if (state === "GRS_INSPECT" && st0.feet.y !== st0.from.y) stats.inspectVerticalSteps++;
      if (st0.vertical) stats.shaftSteps++;
      if (st0.axis && lastAxis && st0.axis !== lastAxis) stats.axisChanges++;
      if (st0.axis) lastAxis = st0.axis;
    }
    if (st0 && st0.vertical && st0.phase === "clear" && (P.walkTo || walk || P.speed > 0.001)) stats.movedWhileMiningDown++;
    if (state === "GRS_INSPECT") stats.inspectMinZ = Math.min(stats.inspectMinZ, Math.floor(P.z));
  }
  if (process.env.TRACE && t % Number(process.env.TRACE) === 0 && DEBUG.ctx) {
    const mv = DEBUG.ctx.mover, b = DEBUG.ctx.builder;
    console.log("T" + t, state, "P", P.x.toFixed(2), P.y.toFixed(2), P.z.toFixed(2), "mode", mv.mode, "cand", mv.cand && JSON.stringify(mv.cand),
      "goal", mv.goal && mv.goal.id, "act", b.act && b.act.key + "/" + b.act.phase + "/" + b.act.moves, "dig", mv.digger.step ? mv.digger.step.phase + JSON.stringify(mv.digger.step.feet) + (mv.digger.step.drop ? "drop" : "") + "place" + mv.digger.step.place.length : "-", mv.digger.failures, mv.digger.lastReason, "|", DEBUG.ctx.detail);
  }
  if (state !== lastState) { log.push("@" + t + " state " + state); lastState = state; }
}
if (scenarioName === "gemspot") warps.forEach((w) => { if (/glass/.test(get(w.x + 1, w.y, w.z) || "")) stats.gemsLeftNearRoute++; });
let leftoverSupport = 0;
if (scenarioName === "bridge") {
  for (let x = 35; x <= 42; x++) for (let y = 60; y <= 66; y++) for (let z = 18; z <= 26; z++) {
    if (get(x, y, z) !== "minecraft:cobblestone") continue;
    const isWarp = warps.some((w) => w.x === x && w.z === z && y <= w.y);
    if (!isWarp) { leftoverSupport++; if (process.env.ATK) console.log("LEFTOVER", x, y, z); }
  }
  stats.leftoverSupport = leftoverSupport;
}
const st = routeStatus();
console.log(log.filter((l) => !/^\[log\] (Digging|Sent)/.test(l)).slice(-60).join("\n"));
console.log("----");
console.log("scenario:", scenarioName, "ticks:", t, "final state:", state, "fail:", failReason);
console.log("route status:", st.verdict, "setUp:", st.setUp, JSON.stringify(st.warps.map((w) => [w.number, w.problems])));
console.log("stats:", JSON.stringify(stats), "inv:", JSON.stringify(inv));
console.log("HUD:\n  " + handle.huds.map((h) => h()).join("\n  "));
process.exit(st.setUp || process.env.EXPECT_FAIL ? 0 : 1);
