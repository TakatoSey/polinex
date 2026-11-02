/// <reference path="../polinex.d.ts" />
// Route Status (mining.routeStatus) + runtime route (routes.selected) access, normalized into plain JS.

const U = require("./util.js");

// Problems the builder can fix by placing/clearing.
const BUILDABLE = ["badWarpSpot", "lineBlocked", "lineToMine"];
// Problems that make the route unusable in this lobby unless a Dynamic Route Fix moves the waypoint.
const FATAL = ["veinMissing", "veinUnderStructure", "veinWrongGemType", "veinNotRegrowing", "someonesCobble"];
const LOADING = ["notLoaded", "lineNotLoaded"];

function read() {
  let st = null;
  try { st = mining.routeStatus(); } catch (e) { st = null; }
  if (!st) return null;
  const warps = U.arr(st.warps).map((w) => ({
    number: w.number, x: w.x, y: w.y, z: w.z, pos: U.v(w.x, w.y, w.z),
    checked: !!w.checked, problems: U.arr(w.problems).map(String),
  }));
  return {
    route: st.route == null ? null : String(st.route),
    editing: !!st.editing,
    setUp: !!st.setUp,
    verdict: String(st.verdict),
    reason: st.reason == null ? null : String(st.reason),
    doable: !!st.doable,
    unchecked: Number(st.unchecked),
    nearestUnchecked: st.nearestUnchecked ? { number: st.nearestUnchecked.number, dist: st.nearestUnchecked.dist } : null,
    scannerOn: st.scannerOn,
    warps: warps,
  };
}

// A verdict that may be acted on: everything is loaded and scanned.
function complete(st) {
  return !!st && st.unchecked === 0 && st.verdict !== "Not checked" && st.verdict !== "Doable so far" && st.verdict !== "No route";
}

function signature(st) {
  if (!st) return "";
  return (st.route || "") + "|" + st.warps.map((w) => w.x + "," + w.y + "," + w.z).join(";");
}

function has(w, list) {
  for (let i = 0; i < w.problems.length; i++) if (list.indexOf(w.problems[i]) >= 0) return true;
  return false;
}

function fatalSummary(st) {
  const out = [];
  st.warps.forEach((w) => w.problems.forEach((p) => { if (FATAL.indexOf(p) >= 0) out.push("#" + w.number + " " + p); }));
  return out;
}

// ---- runtime route (routes.selected) ----

function findManager(override) {
  let list = [];
  try { list = U.arr(routes.managers()); } catch (e) { return null; }
  if (override) {
    for (let i = 0; i < list.length; i++) if (String(list[i].id) === override) return String(list[i].id);
    return null;
  }
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const text = (m.id + " " + m.name + " " + m.routeType + " " + m.targetType).toLowerCase();
    if (text.indexOf("gem") >= 0) return String(m.id);
  }
  return null;
}

function runtimeRoute(managerId) {
  if (!managerId) return null;
  try {
    const sel = routes.selected(managerId);
    if (!sel || !sel.route) return null;
    return { name: sel.name == null ? null : String(sel.name), waypoints: U.arr(sel.route.waypoints).map((w) => ({ x: w.x, y: w.y, z: w.z, type: String(w.type) })) };
  } catch (e) { return null; }
}

function runtimeSignature(rt) {
  if (!rt) return "";
  return (rt.name || "") + "|" + rt.waypoints.map((w) => w.x + "," + w.y + "," + w.z + w.type).join(";");
}

module.exports = {
  BUILDABLE: BUILDABLE, FATAL: FATAL, LOADING: LOADING,
  read: read, complete: complete, signature: signature, has: has, fatalSummary: fatalSummary,
  findManager: findManager, runtimeRoute: runtimeRoute, runtimeSignature: runtimeSignature,
};
