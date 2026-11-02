/// <reference path="../polinex.d.ts" />
// Gemstone Route Setup
// Select a Gemstone Macro route, start this macro, and it will:
//   1. INSPECT  - travel until Route Status has checked every warp and line of the active runtime route
//   2. DECIDE   - buildable -> build; usable Dynamic Route Fix -> use it; otherwise switch lobby and repeat
//   3. BUILD    - cobble supports (+ bridges), Bob-omb each waypoint, clear every Etherwarp line
//   4. VERIFY   - re-check Route Status until setUp === true
//
// Everything runs from macro state handlers / tick on the client thread.

const U = require("./util.js");
const { SETTINGS, makeCfg } = require("./config.js");
const S = require("./status.js");
const Fix = require("./fix.js");
const { Blocks } = require("./blocks.js");
const { Miner } = require("./miner.js");
const { Placer } = require("./placer.js");
const { Bomber } = require("./bomber.js");
const { Items } = require("./items.js");
const { Mover } = require("./mover.js");
const { Builder } = require("./builder.js");
const { Lobby, currentLobbyId } = require("./lobby.js");

const NAME = "Gemstone Route Setup";

const m = macro.create({
  name: NAME,
  description: "Finds a suitable lobby, loads the selected Gemstone route, builds supports, bombs waypoints, clears lines and verifies Route Status = Set up.",
  subcategory: "Crystal Hollows",
  settings: SETTINGS,
});

// ------------------------------------------------------------------ context
const ctx = {
  cfg: makeCfg(m),
  stage: "GRS_IDLE",
  stageAt: 0,
  detail: "",
  issue: "",
  progressText: "",
  token: 0,
  lastStatus: null,
  statusTick: 0,
  paused: false,
};
// ---- log: script console + .minecraft/logs/latest.log + a persistent copy of the last lines in
// polinex/scripts/data/<script folder name>.properties (key "log"), readable in game with .grs log
const LOG_MAX = 400;
const logLines = (script.getOr("log", "") || "").split("\n").filter((l) => l.length > 0).slice(-LOG_MAX);
let logDirty = false, logSavedAt = 0;
function clock() {
  try { return new Date(U.now()).toTimeString().slice(0, 8); } catch (e) { return String(Math.floor(U.now() / 1000) % 86400); }
}
function logLine(level, msg) {
  let where = "";
  try { const p = player.blockPos(); where = " @" + p.x + "," + p.y + "," + p.z; } catch (e) { /* no player */ }
  logLines.push(clock() + " " + level + " [" + (ctx.stage || "").replace("GRS_", "") + where + "] " + msg);
  if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  logDirty = true;
  if (U.now() - logSavedAt > 5000) flushLog();
}
function flushLog() {
  if (!logDirty) return;
  logDirty = false;
  logSavedAt = U.now();
  try { script.set("log", logLines.join("\n")); } catch (e) { /* store unavailable */ }
}
ctx.log = (msg) => { script.log("[GRS] " + msg); logLine("INFO", msg); if (ctx.cfg.debug()) script.chat("§7[GRS] " + msg); };
ctx.warn = (msg) => { script.warn("[GRS] " + msg); logLine("WARN", msg); };
ctx.progress = () => { ctx.token++; };
ctx.setIssue = (msg) => {
  if (msg === ctx.issue) return;
  ctx.issue = msg || "";
  if (msg) ctx.warn(msg);
};

// offline test harness hook (tools/sim.js); undefined inside Polinex
if (typeof __GRS_DEBUG__ !== "undefined") __GRS_DEBUG__.ctx = ctx;

ctx.blocks = new Blocks(ctx);
ctx.items = new Items(ctx);
ctx.miner = new Miner(ctx);
ctx.placer = new Placer(ctx);
ctx.bomber = new Bomber(ctx);
ctx.mover = new Mover(ctx);
ctx.builder = new Builder(ctx);
ctx.lobby = new Lobby(ctx);

// run-scoped state (reset on enable)
let run = null;
function newRun() {
  return {
    managerId: null,
    lobbyId: null,
    lobbySwitches: 0,
    fixTried: false,
    fix: null,
    routeSig: "",
    runtimeSig: "",
    inspect: { target: null, failed: new Map(), completeSince: 0, costQuery: null, costs: new Map(), lastPos: null, heading: null, notCheckedSince: 0, rounds: 0 },
    verify: { passes: 0, noProblemSince: 0 },
    stuck: {},
    worldSince: 0,
    lobbyNext: "GRS_INSPECT",
  };
}

const LABEL = {
  GRS_IDLE: "Idle", GRS_INIT: "Starting", GRS_INSPECT: "Inspecting route", GRS_DECIDE: "Deciding",
  GRS_FIX: "Dynamic Route Fix", GRS_LOBBY: "Switching lobby", GRS_PREP: "Checking materials",
  GRS_BUILD: "Building", GRS_VERIFY: "Verifying", GRS_DONE: "Done", GRS_WAIT_WORLD: "Waiting for world",
};

function setStage(name, detail) {
  if (ctx.stage !== name) ctx.log("Stage " + (LABEL[ctx.stage] || ctx.stage) + " -> " + (LABEL[name] || name));
  ctx.stage = name;
  ctx.stageAt = U.now();
  ctx.detail = detail || "";
  ctx.progress();
  m.setState(name);
}

// Release every input / engine / pending query this script owns.
function releaseAll() {
  ctx.mover.stop();
  ctx.builder.release();
  ctx.miner.release();
  ctx.placer.release();
  ctx.bomber.release();
  if (run && run.inspect.costQuery) { run.inspect.costQuery.cancel(); run.inspect.costQuery = null; }
  try { rotation.generalStopRotation(); } catch (e) { /* idle */ }
  try { rotation.miningStopRotation(); } catch (e) { /* idle */ }
  try { rotation.etherwarpStopRotation(); } catch (e) { /* idle */ }
  try { rotation.pathFindStopRotation(); } catch (e) { /* idle */ }
  try { mining.clearFakeLook(); } catch (e) { /* idle */ }
  player.releaseKeys();
  player.resetWASD();
  player.setSneaking(false);
}

function fail(reason) {
  logLine("FAIL", reason);
  flushLog();
  releaseAll();
  ctx.lobby.cancel();
  ctx.setIssue(reason);
  notification.error(NAME, reason);
  m.fail(reason);
}

function newLobbyReset() {
  ctx.builder.reset();
  ctx.blocks.resetLobby();
  run.fixTried = false;
  run.fix = null;
  run.routeSig = "";
  run.runtimeSig = "";
  run.inspect = newRun().inspect;
  run.verify = { passes: 0, noProblemSince: 0 };
}

// ------------------------------------------------------------------ status
function status(force) {
  ctx.statusTick++;
  if (force || ctx.statusTick % 4 === 0 || !ctx.lastStatus) {
    ctx.lastStatus = S.read();
    watchRouteChanges();
  }
  return ctx.lastStatus;
}

const ROUTE_WATCH_STAGES = ["GRS_INSPECT", "GRS_DECIDE", "GRS_PREP", "GRS_BUILD", "GRS_VERIFY"];
function watchRouteChanges() {
  const st = ctx.lastStatus;
  if (!st || !run) return;
  const sig = S.signature(st);
  const rtSig = ctx.statusTick % 20 === 0 ? S.runtimeSignature(S.runtimeRoute(run.managerId)) : run.runtimeSig;
  if (!run.routeSig) { run.routeSig = sig; run.runtimeSig = rtSig; return; }
  const changed = sig !== run.routeSig || (rtSig && run.runtimeSig && rtSig !== run.runtimeSig);
  run.routeSig = sig;
  if (rtSig) run.runtimeSig = rtSig;
  if (changed && ROUTE_WATCH_STAGES.indexOf(ctx.stage) >= 0) {
    ctx.warn("The active runtime route changed (route switch or lobby fix). Re-inspecting.");
    releaseAll();
    ctx.builder.reset();
    run.inspect = newRun().inspect;
    setStage("GRS_INSPECT");
  }
}

function warpChecked(number) {
  const st = ctx.lastStatus;
  if (!st) return false;
  const w = st.warps.find((x) => x.number === number);
  return !w || w.checked;
}

// ------------------------------------------------------------------ lifecycle
m.onEnable(() => {
  run = newRun();
  logLine("INFO", "===== start (route manager " + (ctx.cfg.managerId() || "auto") + ", lobby " + (currentLobbyId() || "?") + ") =====");
  ctx.issue = "";
  ctx.paused = false;
  ctx.lastStatus = null;
  ctx.builder.reset();
  ctx.blocks.resetLobby();
  setStage("GRS_INIT");
});

m.onDisable(() => {
  ctx.log("Macro stopped");
  flushLog();
  releaseAll();
  ctx.lobby.cancel();
  ctx.stage = "GRS_IDLE";
});

function resumeStage() {
  releaseAll();
  ctx.paused = false;
  if (!run) return;
  const back = ctx.stage === "GRS_IDLE" ? "GRS_INIT" : ctx.stage;
  setStage(back === "GRS_LOBBY" ? "GRS_WAIT_WORLD" : back);
}
m.onResume(resumeStage);
m.onHelperEnd(resumeStage);
m.onReturn(resumeStage);
m.onDeath(() => { releaseAll(); setStage("GRS_WAIT_WORLD"); });

// Failsafe/break pause: the engine stops ticking states, so make sure nothing stays held.
on("tick", () => {
  if (logDirty && U.now() - logSavedAt > 5000) flushLog();
  const a = macro.active();
  const paused = !!a && a.name() === NAME && a.isPaused();
  if (paused && !ctx.paused) { ctx.paused = true; releaseAll(); ctx.detail = "Paused (failsafe / break)"; }
  else if (!paused && ctx.paused && a && a.isRunning()) { resumeStage(); } // in case the engine resumed without onResume
});

on("worldLoad", () => {
  if (!run) return;
  ctx.mover.stop();
  ctx.builder.release();
  player.releaseKeys();
  ctx.blocks.structCache = null;
  ctx.lastStatus = null;
  if (ctx.stage !== "GRS_LOBBY" && ctx.stage !== "GRS_IDLE" && ctx.stage !== "GRS_DONE") {
    run.worldSince = U.now();
    setStage("GRS_WAIT_WORLD", "World changed");
  }
});

on("serverDisconnect", (reason) => {
  if (!run) return;
  releaseAll();
  ctx.lobby.cancel();
  ctx.setIssue("Disconnected: " + reason);
  run.worldSince = U.now();
  setStage("GRS_WAIT_WORLD", "Disconnected");
});

// ------------------------------------------------------------------ stages
m.onState("GRS_INIT", () => {
  if (!client.isInSkyblock()) { ctx.detail = "Waiting for SkyBlock"; if (U.now() - ctx.stageAt > 20000) fail("Not in SkyBlock."); return; }
  run.managerId = S.findManager(ctx.cfg.managerId());
  if (!run.managerId) { fail("Could not find the Gemstone route manager. Run .grs managers and set 'Route Manager Id'."); return; }
  const rt = S.runtimeRoute(run.managerId);
  if (!rt || !rt.waypoints.length) { fail("No Gemstone Macro route is selected."); return; }
  mining.refreshTools();
  if (mining.drillSlot() < 0 && !skyblock.hasMiningTool()) { fail("No drill/pickaxe in the hotbar."); return; }
  if (skyblock.location() !== "CRYSTAL_HOLLOWS") {
    ctx.lobby.begin(true);
    run.lobbyNext = "GRS_INSPECT";
    setStage("GRS_LOBBY", "Travelling to the Crystal Hollows");
    return;
  }
  run.lobbyId = currentLobbyId();
  ctx.log("Route '" + (rt.name || "?") + "' with " + rt.waypoints.length + " waypoints, lobby " + (run.lobbyId || "?"));
  setStage("GRS_INSPECT");
});

function chooseInspectTarget(st, unchecked) {
  const ins = run.inspect;
  const me = player.pos();
  // movement heading, used to avoid turning around for marginal gains
  if (ins.lastPos && U.dist(me, ins.lastPos) > 3) {
    const d = U.sub(me, ins.lastPos);
    const len = Math.sqrt(d.x * d.x + d.z * d.z) || 1;
    ins.heading = { x: d.x / len, z: d.z / len };
    ins.lastPos = me;
  } else if (!ins.lastPos) ins.lastPos = me;

  let best = null;
  for (let i = 0; i < unchecked.length; i++) {
    const w = unchecked[i];
    const fails = ins.failed.get(w.number) || 0;
    if (fails >= 2) continue;
    const d = U.dist(me, w.pos);
    const known = ins.costs.get(w.number);
    let score = known !== undefined && known >= 0 ? known : d * 1.6;
    if (ins.heading) {
      const dx = w.x - me.x, dz = w.z - me.z;
      const l = Math.sqrt(dx * dx + dz * dz) || 1;
      const dot = (dx / l) * ins.heading.x + (dz / l) * ins.heading.z;
      if (dot < -0.3) score += d * 0.5; // behind us: only worth it when clearly closer
    }
    if (st.nearestUnchecked && st.nearestUnchecked.number === w.number) score *= 0.9;
    if (!best || score < best.score) best = { w: w, score: score };
  }
  // refresh travel costs in the background for the next decision
  if (!ins.costQuery && unchecked.length) {
    const targets = unchecked.slice(0, 256).map((w) => U.v(w.x, w.y, w.z));
    ins.costTargets = unchecked.slice(0, 256).map((w) => w.number);
    try { ins.costQuery = nav.distancesAsync(null, targets, 4000); } catch (e) { ins.costQuery = null; }
  }
  return best ? best.w : null;
}

function pollInspectCosts() {
  const ins = run.inspect;
  if (!ins.costQuery || !ins.costQuery.finished()) return;
  const q = ins.costQuery;
  ins.costQuery = null;
  if (q.status() !== "found") return;
  const costs = U.arr(q.costs());
  for (let i = 0; i < costs.length && i < ins.costTargets.length; i++) ins.costs.set(ins.costTargets[i], costs[i]);
}

function inspectGoal(st, w) {
  const idx = st.warps.indexOf(w);
  const next = st.warps.length > 1 ? st.warps[(idx + 1) % st.warps.length] : null;
  let pos = w.pos;
  if (w.problems.indexOf("notLoaded") < 0 && w.problems.indexOf("lineNotLoaded") >= 0 && next) pos = next.pos;
  const number = w.number;
  return {
    // flat: Y is always fully loaded, only X/Z distance matters -> never climb or dig down while inspecting
    id: "inspect:" + number + ":" + U.key(pos), pos: pos, near: 4, approach: true, flat: true,
    label: "unchecked warp #" + number,
    arrive: () => warpChecked(number) || U.distFlat(player.pos(), pos) < 3,
  };
}

m.onState("GRS_INSPECT", () => {
  if (skyblock.location() !== "CRYSTAL_HOLLOWS") { run.worldSince = U.now(); setStage("GRS_WAIT_WORLD"); return; }
  const st = status();
  const ins = run.inspect;
  pollInspectCosts();

  if (!st) {
    // Route Status is null in the Crystal Nucleus: walk out toward the route.
    const rt = S.runtimeRoute(run.managerId);
    if (!rt || !rt.waypoints.length) { fail("No Gemstone Macro route is selected."); return; }
    let near = rt.waypoints[0], nd = Infinity;
    rt.waypoints.forEach((w) => { const d = U.dist(player.pos(), w); if (d < nd) { nd = d; near = w; } });
    ctx.detail = "Leaving the Crystal Nucleus";
    ctx.mover.goTo({ id: "exit:" + U.key(near), pos: U.v(near.x, near.y, near.z), near: 4, approach: true, flat: true, label: "route (leaving Nucleus)",
      arrive: () => S.read() !== null });
    const r = ctx.mover.tick();
    if (r.s === "fail") { ctx.setIssue(r.reason); ctx.mover.stop(); }
    return;
  }
  if (st.verdict === "No route") { fail("Route Status: no route selected."); return; }
  ctx.progressText = "Checked " + (st.warps.length - st.unchecked) + "/" + st.warps.length + " - " + st.verdict;

  if (S.complete(st)) {
    if (!ins.completeSince) ins.completeSince = U.now();
    if (U.now() - ins.completeSince > 1500) { ctx.mover.stop(); setStage("GRS_DECIDE"); }
    return;
  }
  ins.completeSince = 0;

  const unchecked = st.warps.filter((w) => !w.checked);
  if (!unchecked.length) {
    // all points checked but the verdict is still partial: give the scanner a moment
    ctx.mover.stop();
    if (!ins.notCheckedSince) ins.notCheckedSince = U.now();
    ctx.detail = "Waiting for Route Status (" + st.verdict + ")";
    if (U.now() - ins.notCheckedSince > 15000) {
      ctx.setIssue("Route Status stays '" + st.verdict + "' with all warps checked" + (st.reason ? " (" + st.reason + ")" : "") +
        ". Is the Route Status HUD / gemstone scanner enabled?");
    }
    return;
  }
  ins.notCheckedSince = 0;

  if (ins.target !== null && warpChecked(ins.target)) { ins.target = null; ctx.progress(); }
  if (ins.target === null) {
    const w = chooseInspectTarget(st, unchecked);
    if (!w) {
      if (++ins.rounds > 3) { fail("Cannot reach the unchecked warps (" + unchecked.map((x) => "#" + x.number).join(", ") + "): " + ctx.issue); return; }
      ins.failed.clear();
      ctx.warn("Every unchecked warp failed once; retrying (round " + ins.rounds + ")");
      return;
    }
    ins.target = w.number;
    ctx.log("Inspect target #" + w.number + " " + U.fmt(w.pos) + " (" + U.distFlat(player.pos(), w.pos).toFixed(0) + " blocks X/Z, " + unchecked.length + " unchecked)");
  }
  const tw = st.warps.find((x) => x.number === ins.target);
  if (!tw) { ins.target = null; return; }
  ctx.mover.goTo(inspectGoal(st, tw));
  const r = ctx.mover.tick();
  if (r.s === "fail") {
    ins.failed.set(tw.number, (ins.failed.get(tw.number) || 0) + 1);
    ctx.setIssue("Inspect #" + tw.number + ": " + r.reason);
    ctx.mover.stop();
    ins.target = null;
  } else if (r.s === "arrived" && !warpChecked(tw.number)) {
    // standing right next to it (X/Z) and Route Status still has not checked it: give the scanner a moment
    if (!ins.arrivedAt) ins.arrivedAt = U.now();
    ctx.detail = "At warp #" + tw.number + ", waiting for Route Status to scan it";
    if (U.now() - ins.arrivedAt > 6000) {
      ins.failed.set(tw.number, (ins.failed.get(tw.number) || 0) + 1);
      ctx.setIssue("Warp #" + tw.number + " stays unchecked although we are next to it (" + tw.problems.join(", ") + ")");
      ctx.mover.stop();
      ins.target = null;
      ins.arrivedAt = 0;
    }
  } else ins.arrivedAt = 0;
});

m.onState("GRS_DECIDE", () => {
  const st = status(true);
  if (!st || !S.complete(st)) { setStage("GRS_INSPECT"); return; }
  ctx.log("Route Status: " + st.verdict + (st.reason ? " (" + st.reason + ")" : "") + ", setUp=" + st.setUp);
  if (st.setUp) { setStage("GRS_DONE"); return; }
  if (st.verdict === "Doable") { setStage("GRS_PREP"); return; }
  if (st.verdict === "Not doable") {
    const fatal = S.fatalSummary(st);
    ctx.setIssue("Not doable here: " + (st.reason || fatal.join(", ") || "no reason given"));
    if (ctx.cfg.useFix() && !run.fixTried) { setStage("GRS_FIX"); return; }
    switchLobby();
    return;
  }
  setStage("GRS_INSPECT");
});

function switchLobby() {
  if (run.lobbySwitches >= ctx.cfg.maxLobbySwitches()) {
    fail("Gave up after " + run.lobbySwitches + " lobby switches. Last problem: " + (ctx.issue || "?"));
    return;
  }
  releaseAll();
  run.lobbySwitches++;
  ctx.lobby.begin(false);
  run.lobbyNext = "GRS_INSPECT";
  setStage("GRS_LOBBY");
}

m.onState("GRS_FIX", () => {
  const st = status();
  const f = run.fix;
  if (!f) {
    run.fixTried = true;
    const probe = Fix.probe(ctx.cfg.fixSetting());
    let res = "unsupported";
    try { res = Fix.apply(probe); } catch (e) { res = "unsupported"; ctx.warn("Applying the fix failed: " + e); }
    const manual = !probe || res === "unsupported";
    run.fix = {
      at: U.now(), sig: S.signature(st), rtSig: S.runtimeSignature(S.runtimeRoute(run.managerId)),
      manual: manual, res: res, label: probe ? probe.label : null,
    };
    if (manual) {
      if (ctx.cfg.manualFixWaitMs() <= 0) { run.fix = null; switchLobby(); return; }
      const msg = "No scriptable Dynamic Route Fix found. If Polinex offers a fix for this lobby, accept it now (" +
        Math.round(ctx.cfg.manualFixWaitMs() / 1000) + "s), otherwise the script switches lobby.";
      ctx.setIssue(msg);
      notification.warning(NAME, msg);
    } else {
      ctx.log("Dynamic Route Fix via '" + probe.label + "': " + res);
    }
    return;
  }
  const wait = f.manual ? ctx.cfg.manualFixWaitMs() : (f.res === "already" ? 3000 : 10000);
  ctx.detail = (f.manual ? "Waiting for manual fix" : "Waiting for fix (" + f.label + ")") + " " + Math.max(0, Math.round((wait - (U.now() - f.at)) / 1000)) + "s";
  if (st) {
    const rtSig = S.runtimeSignature(S.runtimeRoute(run.managerId));
    if (S.signature(st) !== f.sig || (rtSig && f.rtSig && rtSig !== f.rtSig)) {
      ctx.log("Runtime route changed by the lobby fix; re-inspecting the corrected route.");
      ctx.setIssue("");
      ctx.builder.reset();
      run.routeSig = S.signature(st);
      run.runtimeSig = rtSig;
      run.inspect = newRun().inspect;
      run.fix = null;
      setStage("GRS_INSPECT");
      return;
    }
    if (st.verdict === "Doable" || st.setUp) { run.fix = null; setStage("GRS_DECIDE"); return; }
  }
  if (U.now() - f.at > wait) {
    ctx.log("No usable lobby fix.");
    run.fix = null;
    switchLobby();
  }
});

m.onState("GRS_LOBBY", () => {
  const r = ctx.lobby.tick();
  if (r.s === "busy") return;
  if (r.s === "fail") { fail("Lobby switch failed: " + r.reason); return; }
  ctx.log("Now in lobby " + (r.id || "?") + " (switches: " + run.lobbySwitches + ")");
  run.lobbyId = r.id;
  newLobbyReset();
  ctx.setIssue("");
  setStage(run.lobbyNext || "GRS_INSPECT");
});

m.onState("GRS_PREP", () => {
  const st = status(true);
  if (!st || !S.complete(st)) { setStage("GRS_INSPECT"); return; }
  mining.refreshTools();
  mining.refreshCache();
  if (mining.drillSlot() < 0) { fail("No drill/pickaxe in the hotbar."); return; }
  const need = ctx.builder.needs(st);
  const item = ctx.cfg.placeItem();
  const have = ctx.items.count(item);
  const want = Math.max(ctx.cfg.minCobble(), need.cobble);
  if (have < want) { fail("Need at least " + want + " " + item + " (have " + have + ")."); return; }
  if (ctx.cfg.useBombs()) {
    const bombs = ctx.items.count(ctx.cfg.bombItem());
    if (bombs < need.bombs) {
      const msg = "Need " + need.bombs + " " + ctx.cfg.bombItem() + " for the bombable waypoints (have " + bombs + ").";
      if (ctx.cfg.requireBombs()) { fail(msg); return; }
      ctx.warn(msg + " Continuing; waypoints without a bomb are only mined.");
    }
    if (st.scannerOn === null) ctx.warn("Route Rendering > Bombs is off, so 'notBombable' is unknown; only structure no-bomb bounds are respected.");
  }
  if (!skyblock.hasEtherwarp()) ctx.warn("No Etherwarp item found: big climbs will be walked or dug.");
  ctx.builder.start(st);
  run.verify.noProblemSince = 0;
  setStage("GRS_BUILD");
});

m.onState("GRS_BUILD", () => {
  if (skyblock.location() !== "CRYSTAL_HOLLOWS") { run.worldSince = U.now(); setStage("GRS_WAIT_WORLD"); return; }
  const st = status();
  if (!st) { setStage("GRS_INSPECT"); return; }
  if (S.complete(st) && st.verdict === "Not doable" && S.fatalSummary(st).length) { releaseAll(); setStage("GRS_DECIDE"); return; }
  const r = ctx.builder.tick(st);
  if (r.s === "done") { releaseAll(); setStage("GRS_VERIFY", "Waiting for Route Status"); }
  else if (r.s === "fail") fail(r.reason);
});

m.onState("GRS_VERIFY", () => {
  if (U.now() - ctx.stageAt < 2500) return;
  const st = status(true);
  if (!st) { setStage("GRS_INSPECT"); return; }
  ctx.progressText = "Route Status: " + st.verdict + (st.setUp ? " (set up)" : "");
  if (st.setUp) { setStage("GRS_DONE"); return; }
  if (!S.complete(st)) { setStage("GRS_INSPECT"); return; }
  if (st.verdict === "Not doable") { setStage("GRS_DECIDE"); return; }

  const B = ctx.blocks;
  const open = st.warps.filter((w) => {
    if (S.has(w, S.BUILDABLE)) return true;
    const info = B.info(ctx.builder.cobPos(w));
    return info.loaded && !B.isCobble(info.id);
  });
  const todo = open.filter((w) => !ctx.builder.isFatal(w)).map((w) => w.number);
  const fatal = open.filter((w) => ctx.builder.isFatal(w));
  const blocked = ctx.builder.blockedSummary();

  if (!todo.length && fatal.length) {
    fail("Needs a manual step: " + fatal.map((w) => "#" + w.number + " " + ctx.builder.prog.get(U.key(w.pos)).blocked).join(" | ") +
      ". Fix it, then start the macro again (progress is re-checked, nothing is redone).");
    return;
  }
  if (todo.length) {
    if (++run.verify.passes > 4) {
      fail("Still not set up after 4 passes. Open: " + todo.map((n) => "#" + n).join(", ") + (blocked.length ? " | " + blocked.join(" | ") : ""));
      return;
    }
    ctx.log("Pass " + run.verify.passes + ": rebuilding " + todo.map((n) => "#" + n).join(", "));
    ctx.builder.start(st, todo);
    setStage("GRS_BUILD");
    return;
  }
  if (!run.verify.noProblemSince) run.verify.noProblemSince = U.now();
  ctx.detail = "Waiting for Route Status to report Set up";
  if (U.now() - run.verify.noProblemSince > 60000) {
    fail("Route Status says '" + st.verdict + "'" + (st.reason ? " (" + st.reason + ")" : "") +
      " without listing problems. Manual check needed in the Route Status HUD.");
  }
});

m.onState("GRS_DONE", () => {
  if (run.doneAt) return;
  run.doneAt = U.now();
  releaseAll();
  const msg = "Route is set up (Route Status: Set up). Lobby " + (run.lobbyId || "?") + ", " + run.lobbySwitches + " lobby switch(es).";
  script.info(msg);
  notification.success(NAME, msg);
  ctx.detail = "Finished";
  if (ctx.cfg.startGemMacro()) {
    const g = macro.get("Gemstone Macro");
    if (g) { g.start(); return; }
    ctx.warn("Gemstone Macro not found, not starting it.");
  }
  const a = macro.active();
  if (a && a.name() === NAME) a.stop();
});

m.onState("GRS_WAIT_WORLD", () => {
  if (!run.worldSince) run.worldSince = U.now();
  const waited = U.now() - run.worldSince;
  if (waited > 180000) { fail("World changed / disconnected and we never got back to the Crystal Hollows."); return; }
  if (!client.isInSkyblock() || waited < 2500) { ctx.detail = "Waiting for SkyBlock"; return; }
  const loc = skyblock.location();
  if (loc !== "CRYSTAL_HOLLOWS") {
    ctx.log("Not in the Crystal Hollows (" + loc + "); returning.");
    ctx.lobby.begin(true);
    run.lobbyNext = "GRS_INSPECT";
    setStage("GRS_LOBBY");
    return;
  }
  const id = currentLobbyId();
  if (!id && waited < 12000) { ctx.detail = "Reading lobby id"; return; }
  if (id && run.lobbyId && id !== run.lobbyId) {
    ctx.warn("Landed in a different lobby (" + run.lobbyId + " -> " + id + "); starting over here.");
    newLobbyReset();
  }
  run.lobbyId = id || run.lobbyId;
  ctx.setIssue("");
  run.inspect = newRun().inspect;
  setStage("GRS_INSPECT"); // re-check everything; build progress (bombed waypoints) is kept for this lobby
});

// ------------------------------------------------------------------ stuck checks
const STUCK = {
  GRS_INSPECT: 120000, GRS_BUILD: 150000, GRS_LOBBY: 120000, GRS_FIX: 400000,
  GRS_VERIFY: 120000, GRS_PREP: 30000, GRS_DECIDE: 30000, GRS_INIT: 60000,
};
Object.keys(STUCK).forEach((stage) => {
  m.addStuckCheck({
    name: "grs-" + stage.toLowerCase(),
    state: stage,
    timeoutMs: STUCK[stage],
    minimumStateMs: 5000,
    progress: () => ctx.token + ":" + Math.round(player.x() / 3) + "," + Math.round(player.y() / 3) + "," + Math.round(player.z() / 3),
    onStuck: () => {
      const n = (run.stuck[stage] = (run.stuck[stage] || 0) + 1);
      const why = ctx.issue || ctx.detail || "no progress";
      if (n >= 3) { fail("Stuck in '" + (LABEL[stage] || stage) + "': " + why); return; }
      ctx.warn("No progress in '" + (LABEL[stage] || stage) + "' (" + why + "); retrying (" + n + "/3)");
      releaseAll();
      if (stage === "GRS_INSPECT" && run.inspect.target !== null) {
        run.inspect.failed.set(run.inspect.target, (run.inspect.failed.get(run.inspect.target) || 0) + 1);
        run.inspect.target = null;
      }
      if (stage === "GRS_BUILD") ctx.builder.noteStuck(ctx.lastStatus, why);
      setStage(stage);
    },
  });
});

// ------------------------------------------------------------------ HUD + overlay
m.hud(() => "Stage: " + (LABEL[ctx.stage] || ctx.stage) + (ctx.paused ? " (paused)" : ""));
m.hud(() => "Doing: " + (ctx.detail || "-"));
m.hud(() => {
  const st = ctx.lastStatus;
  if (!st) return "Route Status: -";
  return "Route: " + (st.route || "?") + " | " + st.verdict + (st.unchecked ? " | unchecked " + st.unchecked : "") + (st.setUp ? " | SET UP" : "");
});
m.hud(() => "Progress: " + (ctx.progressText || "-"));
m.hud(() => "Lobby: " + ((run && run.lobbyId) || "?") + " | switches " + (run ? run.lobbySwitches : 0));
m.hud(() => (ctx.issue ? "Blocked: " + ctx.issue : "Blocked: -"));

on("worldRenderLast", () => {
  if (!ctx.cfg.render() || !ctx.lastStatus || ctx.stage === "GRS_IDLE") return;
  const st = ctx.lastStatus;
  const n = Math.min(st.warps.length, 80);
  for (let i = 0; i < n; i++) {
    const w = st.warps[i];
    const nx = st.warps[(i + 1) % st.warps.length];
    const bad = w.problems.filter((p) => p !== "notLoaded" && p !== "lineNotLoaded");
    const color = !w.checked ? 0xFFFFCC33 : bad.length ? 0xFFFF5555 : 0xFF55FF77;
    const a = U.top(ctx.builder.cobPos(w));
    if (st.warps.length > 1) {
      const b = U.top(ctx.builder.cobPos(nx));
      render.worldLine(a.x, a.y + 0.1, a.z, b.x, b.y + 0.1, b.z, color, 1.5, false);
    }
    render.worldText("#" + w.number + (bad.length ? " " + bad.join(",") : ""), a.x, a.y + 0.6, a.z, color, 12);
  }
  const g = ctx.mover.goal;
  if (g && g.pos) render.worldBeam(Math.floor(g.pos.x), Math.floor(g.pos.y), Math.floor(g.pos.z), 0xFF55AAFF);
});

// ------------------------------------------------------------------ chat commands
try {
  commands.register("grs", (args) => {
    const sub = (args[0] || "status").toLowerCase();
    if (sub === "managers") {
      U.arr(routes.managers()).forEach((mg) => script.chat("§b" + mg.id + "§7: " + mg.name + " (" + mg.routeType + ")"));
    } else if (sub === "fix") {
      const p = Fix.probe(ctx.cfg.fixSetting());
      script.chat(p ? "§aFix control found: " + p.label + " = " + (p.kind === "module" ? p.ref.isEnabled() : p.ref.getValue())
        : "§cNo scriptable Dynamic Route Fix control found (use 'Fix Setting Override').");
    } else if (sub === "lobby") {
      script.chat("§7Lobby id: §f" + (currentLobbyId() || "?"));
    } else if (sub === "log") {
      const n = Math.max(1, Math.min(100, parseInt(args[1] || "15", 10) || 15));
      script.chat("§7Last " + n + " of " + logLines.length + " log lines (full copy: polinex/scripts/data/<script>.properties, key 'log'; also latest.log):");
      logLines.slice(-n).forEach((l) => script.chat((/ (WARN|FAIL) /.test(l) ? "§e" : "§f") + l));
    } else if (sub === "clearlog") {
      logLines.length = 0;
      logDirty = true;
      flushLog();
      script.chat("§7Log cleared.");
    } else if (sub === "reset") {
      ctx.builder.reset();
      ctx.blocks.resetLobby();
      script.chat("§7Build progress and blacklist cleared.");
    } else {
      const st = S.read();
      if (!st) { script.chat("§cRoute Status unavailable (not in the Crystal Hollows, in the Nucleus, or no route selected)."); return; }
      script.chat("§b" + (st.route || "?") + "§7: " + st.verdict + ", setUp=" + st.setUp + ", unchecked=" + st.unchecked + (st.reason ? ", " + st.reason : ""));
      st.warps.filter((w) => w.problems.length).slice(0, 12).forEach((w) => script.chat("§7#" + w.number + " " + U.fmt(w.pos) + ": §e" + w.problems.join(", ")));
    }
  }, {
    description: "Gemstone Route Setup: status | log [n] | clearlog | managers | fix | lobby | reset",
    suggest: ["status", "log", "clearlog", "managers", "fix", "lobby", "reset"],
    dotOnly: true,
  });
} catch (e) {
  script.warn("[GRS] .grs command unavailable: " + e);
}

macro.export(m);
