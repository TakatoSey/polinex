/// <reference path="../polinex.d.ts" />
// Digs a 1x2 passage toward a target feet position: straight level tunnels, staircases up, or straight down.
// Tunnels go along ONE axis until that axis is done (an L-shape, never a zigzag), the button stays held
// like the powder mining module, and the camera only moves between two fixed points per step
// (head block face, then feet block top), with a fixed yaw along the tunnel.
// Never digs through gemstones, liquids, unknown terrain, structure cores or blacklisted blocks.
// Bridges a missing floor block with cobblestone when it can.
// tick(targetFeet, arrive) -> { s: "busy" } | { s: "arrived" } | { s: "fail", reason }

const U = require("./util.js");

function Digger(ctx) {
  this.ctx = ctx;
  this.target = null;
  this.step = null;
  this.dug = 0;
  this.badSteps = new Set();
  this.failures = 0;
  this.lastReason = "";
  this.axis = null; // "x" | "z": tunnel axis we stay on until it is done
}

Digger.prototype.release = function () {
  this.ctx.miner.release();
  this.ctx.placer.release();
  player.resetWASD();
  this.step = null;
};

Digger.prototype.reset = function (target) {
  this.release();
  if (!target) this.axis = null; // keep the axis across hop targets, forget it when movement stops
  this.target = target ? U.floor(target) : null;
  this.dug = 0;
  this.badSteps.clear();
  this.failures = 0;
  this.lastReason = "";
};

// Validates every cell of a candidate step. Returns null when ok, otherwise the reason.
Digger.prototype.checkCells = function (cells) {
  const B = this.ctx.blocks;
  for (let i = 0; i < cells.length; i++) {
    const info = B.info(cells[i]);
    if (!info.loaded) return "unknown terrain at " + U.fmt(cells[i]);
    if (info.liquid) return "liquid at " + U.fmt(cells[i]);
    if (!info.passable) {
      const why = B.mineBlockReason(cells[i]);
      if (why) return why + " at " + U.fmt(cells[i]);
    }
    if (B.inCore(cells[i])) return "structure core at " + U.fmt(cells[i]);
    if (!info.passable && B.hasLiquidNeighbour(cells[i])) return "would open liquid at " + U.fmt(cells[i]);
  }
  return null;
};

// How many passable cells below `cell` (inclusive) until loaded solid ground; 0 = no safe landing within max.
Digger.prototype.landingDepth = function (cell, max) {
  const B = this.ctx.blocks;
  for (let d = 0; d <= max; d++) {
    const i = B.info(U.up(cell, -d));
    if (!i.loaded || i.liquid) return 0;
    if (i.solid) return d;
    if (!i.passable) return 0;
  }
  return 0;
};

// Never mines a 45 degree staircase downwards (that pattern trips failsafes): going down means tunnelling
// level until we are above the target, then a straight vertical shaft (or a safe drop off a ledge).
// flat: ignore height completely (inspection only needs X/Z, the whole Y range is always loaded).
Digger.prototype.planStep = function (feet, t, flat) {
  const B = this.ctx.blocks;
  const dx = t.x - feet.x, dy = flat ? 0 : t.y - feet.y, dz = t.z - feet.z;
  const dirs = [];
  const ax = { x: Math.sign(dx), y: 0, z: 0 }, az = { x: 0, y: 0, z: Math.sign(dz) };
  // stay on the current axis while it still has distance left; otherwise take the longer one
  let first = this.axis;
  if (first === "x" && !dx) first = null;
  if (first === "z" && !dz) first = null;
  if (!first) first = Math.abs(dx) >= Math.abs(dz) ? "x" : "z";
  if (first === "x") { if (dx) dirs.push(ax); if (dz) dirs.push(az); }
  else { if (dz) dirs.push(az); if (dx) dirs.push(ax); }
  const reasons = [];

  if (dirs.length === 0) {
    if (dy < 0) {
      const below = U.up(feet, -1), support = U.up(feet, -2);
      const why = this.checkCells([below]);
      const sup = B.info(support);
      const safeFall = sup.loaded && (sup.solid || this.landingDepth(support, this.ctx.cfg.maxDrop()) > 0);
      // straight down: centre on the block, stand completely still while mining, then just fall
      if (!why && safeFall) {
        return { clear: [below], place: [], feet: below, up: false, vertical: true, badKey: "v" + U.key(feet),
          aims: [U.v(below.x + 0.5, below.y + 0.99, below.z + 0.5)], hold: new Set([U.key(below)]), holdNext: null };
      }
      return { fail: why || "no known ground within " + this.ctx.cfg.maxDrop() + " blocks below " + U.fmt(below) };
    }
    if (dy > 0) {
      // need a staircase: try any horizontal direction
      for (let k = 0; k < U.HORIZ4.length; k++) dirs.push(U.HORIZ4[k]);
    } else {
      return { arrived: true };
    }
  }

  for (let k = 0; k < dirs.length; k++) {
    const h = dirs[k];
    const n = U.add(feet, h);
    const bad = U.key(feet) + ">" + h.x + "," + h.z + ">" + Math.sign(dy);
    if (this.badSteps.has(bad)) continue;
    let step;
    // face of a cell that looks back at us (fixed aim point, same yaw for the whole tunnel)
    const face = (cell, yOff) => U.v(cell.x + 0.5 - h.x * 0.49, cell.y + (yOff === undefined ? 0.5 : yOff), cell.z + 0.5 - h.z * 0.49);
    if (dy >= 1) {
      const above = U.up(feet, 2);
      step = { clear: [above, U.up(n, 2), U.up(n, 1)], feet: U.up(n, 1), supportCell: n, up: true,
        aims: [U.v(above.x + 0.5, above.y + 0.01, above.z + 0.5), face(U.up(n, 2)), face(U.up(n, 1))] };
    } else { // level (also while the target is lower: descend later with a vertical shaft)
      // head block at its LOWER part, then the feet block at its top: both ~32-36 degrees down, so the camera
      // hardly moves, and once the head breaks the same crosshair runs straight into the feet block
      step = { clear: [U.up(n, 1), n], feet: n, supportCell: U.up(n, -1), up: false,
        aims: [face(U.up(n, 1), 0.25), U.v(n.x + 0.5, n.y + 0.99, n.z + 0.5)] };
    }
    // blocks the held button may run into: this step and up to 3 more along the same straight tunnel
    // (only within the distance left on this axis, only blocks we may mine, never the floor)
    // Head blocks are always safe to run into (the ray goes on forward). A feet block only when the feet block
    // behind it is still solid, because once it breaks the crosshair continues downward toward the floor.
    step.holdNext = new Set();
    const left = Math.abs(h.x ? t.x - step.feet.x : t.z - step.feet.z);
    for (let i = 1; i <= Math.min(step.up ? 1 : 3, left); i++) {
      const c = U.add(step.feet, U.scale(h, i));
      const cells = step.up ? [c, U.up(c, 1), U.up(c, 2)] : [c, U.up(c, 1)];
      if (this.checkCells(cells)) break; // stop at the first unsafe column
      cells.slice(1).forEach((cc) => step.holdNext.add(U.key(cc)));
      const behind = B.info(U.add(c, h));
      if (i === 1 && left >= 2 && behind.loaded && behind.solid && !behind.gem) step.holdNext.add(U.key(c));
    }
    step.hold = new Set(step.clear.map(U.key));
    step.holdNext.forEach((kk) => step.hold.add(kk));
    step.axis = h.x ? "x" : "z";
    step.h = h;
    step.badKey = bad;
    step.place = [];
    const why = this.checkCells(step.clear);
    if (why) { reasons.push(why); this.badSteps.add(bad); continue; }
    const sup = B.info(step.supportCell);
    if (!sup.loaded) { reasons.push("unknown floor at " + U.fmt(step.supportCell)); this.badSteps.add(bad); continue; }
    if (sup.liquid) { reasons.push("liquid floor at " + U.fmt(step.supportCell)); this.badSteps.add(bad); continue; }
    if (!sup.solid) {
      if (!sup.passable) { reasons.push("odd floor at " + U.fmt(step.supportCell)); this.badSteps.add(bad); continue; }
      // a short drop onto known solid ground is fine; otherwise bridge the gap with cobble
      if (!step.up && this.landingDepth(step.supportCell, this.ctx.cfg.maxDrop()) > 0) step.drop = true;
      else step.place.push(step.supportCell);
    }
    return step;
  }
  return { fail: reasons.length ? reasons[0] : "no diggable direction" };
};

// Dead-man switch: walk keys / held button are released if the digger stops being ticked.
Digger.prototype.watchdog = function () {
  if (this.step && U.now() - (this.tickAt || 0) > 150) this.release();
};

Digger.prototype.tick = function (targetFeet, arrive, flat) {
  const ctx = this.ctx;
  this.tickAt = U.now();
  const t = U.floor(targetFeet);
  if (!this.target || !U.same(this.target, t)) this.reset(t);
  if (arrive && arrive()) { this.release(); return { s: "arrived" }; }
  const feet = player.blockPos();
  if (U.distFlat(feet, t) < 1 && (flat || Math.abs(feet.y - t.y) < 1)) { this.release(); return { s: "arrived" }; }
  if (this.dug > ctx.cfg.maxDigLen()) return this.fail("dug " + this.dug + " blocks without arriving (Max Dig Length)");

  if (!this.step) {
    const st = this.planStep(feet, t, flat);
    if (st.arrived) { this.release(); return { s: "arrived" }; }
    if (st.fail) return this.fail(st.fail);
    this.step = st;
    if (st.axis) this.axis = st.axis;
    this.step.phase = st.vertical ? "center" : "clear";
    this.step.started = U.now();
    this.step.from = feet;
    ctx.detail = "Digging toward " + U.fmt(t);
  }
  const s = this.step;

  // Vertical shaft: moving while mining down breaks it (you slide off / mine the wrong block),
  // so first centre on the block, wait until we are standing still, and never press a key while mining.
  if (s.phase === "center") {
    const c = U.v(s.from.x + 0.5, s.from.y, s.from.z + 0.5);
    const off = U.distFlat(player.pos(), c);
    if (off > 0.15) {
      player.setSneaking(true); // slow, precise steps; also stops us from walking off an edge
      player.setOptimalKeysTo(c.x, c.y, c.z, true);
      if (U.now() - s.started > 4000) return this.badStep("could not centre for digging down");
      return { s: "busy" };
    }
    player.resetWASD();
    player.setSneaking(false);
    if (player.speed() > 0.01 || !player.onGround()) return { s: "busy" }; // let the momentum die
    s.phase = "clear";
    return { s: "busy" };
  }

  if (s.phase === "fall") {
    player.resetWASD();
    const here = player.blockPos();
    if (player.onGround() && here.y <= s.feet.y) {
      this.dug++;
      this.step = null;
      ctx.progress();
      return { s: "busy" };
    }
    if (U.now() - s.walkStart > 4000) return this.badStep("did not fall into the shaft at " + U.fmt(s.feet));
    return { s: "busy" };
  }

  if (s.phase === "clear") {
    player.resetWASD();
    let cell = null, aim = null;
    const usingExtra = !!(s.extra && s.extra.length);
    if (usingExtra) {
      if (ctx.blocks.info(s.extra[0]).passable) { s.extra.shift(); return { s: "busy" }; }
      cell = s.extra[0];
    } else {
      for (let i = 0; i < s.clear.length; i++) {
        if (!ctx.blocks.info(s.clear[i]).passable) { cell = s.clear[i]; aim = s.aims ? s.aims[i] : null; break; }
      }
    }
    if (!cell) {
      if (s.vertical || s.place.length) ctx.miner.release(); // nothing held while falling or placing a bridge block
      else ctx.miner.guard(s.holdNext);   // keep holding only if the crosshair is on the next tunnel block
      s.phase = s.vertical ? "fall" : s.place.length ? "place" : "walk";
      s.walkStart = U.now();
      return { s: "busy" };
    }
    if (usingExtra) s.hold.add(U.key(cell));
    const r = ctx.miner.tick(cell, { aim: aim, hold: s.hold });
    if (r.s === "fail") {
      // something sits between us and the cell: clear it first if allowed
      if (r.occluder && !usingExtra && !ctx.blocks.mineBlockReason(r.occluder)) { s.extra = [r.occluder]; return { s: "busy" }; }
      return this.badStep(r.reason);
    }
    if (U.now() - s.started > 30000) return this.badStep("step at " + U.fmt(s.feet) + " took over 30s");
    return { s: "busy" };
  }

  if (s.phase === "place") {
    const r = ctx.placer.tick(s.place[0]);
    if (r.s === "busy") return r;
    if (r.s === "fail") {
      const below = ctx.blocks.info(U.up(s.place[0], -1));
      if (below.loaded && below.solid && !s.up) { s.place.shift(); } // one-block drop is fine
      else return this.badStep("cannot bridge: " + r.reason);
    } else s.place.shift();
    if (!s.place.length) { s.phase = "walk"; s.walkStart = U.now(); }
    return { s: "busy" };
  }

  if (s.phase === "walk") {
    const goal = U.v(s.feet.x + 0.5, s.feet.y, s.feet.z + 0.5);
    const here = player.blockPos();
    const landed = s.drop && here.x === s.feet.x && here.z === s.feet.z && here.y <= s.feet.y && player.onGround();
    if ((U.same(here, s.feet) || landed) && U.distFlat(player.pos(), goal) < 0.4) {
      player.resetWASD();
      this.dug++;
      this.step = null;
      ctx.progress();
      return { s: "busy" };
    }
    // The camera does not move while stepping forward: the ~33 degree tunnel angle lands on the lower part of
    // the next head block as we walk in, so the held button simply continues there (powder-mining style).
    if (s.aheadLeft === undefined || U.now() - (s.aheadAt || 0) > 250) {
      // anything left to mine ahead? if the tunnel ahead is already open there is no reason to hold at all
      s.aheadAt = U.now();
      s.aheadLeft = false;
      s.holdNext.forEach((kk) => { if (!s.aheadLeft) { const q = kk.split(",").map(Number); if (!ctx.blocks.info(U.v(q[0], q[1], q[2])).passable) s.aheadLeft = true; } });
    }
    if (!s.aheadLeft) ctx.miner.press(false);
    else ctx.miner.guard(s.holdNext); // keep mining the next tunnel block while stepping forward, never anything else
    player.setOptimalKeysTo(goal.x, goal.y, goal.z, true);
    if (s.up && player.onGround() && U.distFlat(player.pos(), goal) < 1.3) player.jump();
    if (U.now() - s.walkStart > 6000) return this.badStep("could not step into " + U.fmt(s.feet));
    return { s: "busy" };
  }
  return { s: "busy" };
};

Digger.prototype.badStep = function (reason) {
  if (this.step) this.badSteps.add(this.step.badKey);
  this.release();
  this.lastReason = reason;
  if (++this.failures > 8) return this.fail("digging keeps failing: " + reason);
  return { s: "busy" };
};

Digger.prototype.fail = function (reason) {
  this.release();
  this.lastReason = reason;
  return { s: "fail", reason: reason };
};

module.exports = { Digger: Digger };
