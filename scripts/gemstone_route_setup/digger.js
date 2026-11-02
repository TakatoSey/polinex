/// <reference path="../polinex.d.ts" />
// Digs a 1x2 passage toward a target feet position: level steps, staircases up/down, or straight down.
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
}

Digger.prototype.release = function () {
  this.ctx.miner.release();
  this.ctx.placer.release();
  player.resetWASD();
  this.step = null;
};

Digger.prototype.reset = function (target) {
  this.release();
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
  if (Math.abs(dx) >= Math.abs(dz)) { if (dx) dirs.push(ax); if (dz) dirs.push(az); }
  else { if (dz) dirs.push(az); if (dx) dirs.push(ax); }
  const reasons = [];

  if (dirs.length === 0) {
    if (dy < 0) {
      const below = U.up(feet, -1), support = U.up(feet, -2);
      const why = this.checkCells([below]);
      const sup = B.info(support);
      const safeFall = sup.loaded && (sup.solid || this.landingDepth(support, this.ctx.cfg.maxDrop()) > 0);
      // straight down: centre on the block, stand completely still while mining, then just fall
      if (!why && safeFall) return { clear: [below], place: [], feet: below, up: false, vertical: true, badKey: "v" + U.key(feet) };
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
    if (dy >= 1) {
      step = { clear: [U.up(feet, 2), U.up(n, 2), U.up(n, 1)], feet: U.up(n, 1), supportCell: n, up: true };
    } else { // level (also while the target is lower: descend later with a vertical shaft)
      step = { clear: [U.up(n, 1), n], feet: n, supportCell: U.up(n, -1), up: false };
    }
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

Digger.prototype.tick = function (targetFeet, arrive, flat) {
  const ctx = this.ctx;
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
    let cell = null;
    const usingExtra = !!(s.extra && s.extra.length);
    if (usingExtra) {
      if (ctx.blocks.info(s.extra[0]).passable) { s.extra.shift(); return { s: "busy" }; }
      cell = s.extra[0];
    } else {
      for (let i = 0; i < s.clear.length; i++) {
        if (!ctx.blocks.info(s.clear[i]).passable) { cell = s.clear[i]; break; }
      }
    }
    if (!cell) {
      // release left click NOW: a held attack keeps mining whatever is under the crosshair next
      // (usually the floor ahead), which turns a level tunnel into a 45 degree staircase down
      ctx.miner.release();
      s.phase = s.vertical ? "fall" : s.place.length ? "place" : "walk";
      s.walkStart = U.now();
      return { s: "busy" };
    }
    const r = ctx.miner.tick(cell);
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
