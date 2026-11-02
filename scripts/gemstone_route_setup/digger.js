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

Digger.prototype.planStep = function (feet, t) {
  const B = this.ctx.blocks;
  const dx = t.x - feet.x, dy = t.y - feet.y, dz = t.z - feet.z;
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
      if (!why && sup.loaded && sup.solid) return { clear: [below], place: [], feet: below, up: false };
      return { fail: why || "nothing solid to land on below " + U.fmt(below) };
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
    } else if (dy <= -1) {
      step = { clear: [U.up(n, 1), n, U.up(n, -1)], feet: U.up(n, -1), supportCell: U.up(n, -2), up: false };
    } else {
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
      if (!step.up && this.landingDepth(step.supportCell, 4) > 0) step.drop = true;
      else step.place.push(step.supportCell);
    }
    return step;
  }
  return { fail: reasons.length ? reasons[0] : "no diggable direction" };
};

Digger.prototype.tick = function (targetFeet, arrive) {
  const ctx = this.ctx;
  const t = U.floor(targetFeet);
  if (!this.target || !U.same(this.target, t)) this.reset(t);
  if (arrive && arrive()) { this.release(); return { s: "arrived" }; }
  const feet = player.blockPos();
  if (U.distFlat(feet, t) < 1 && Math.abs(feet.y - t.y) < 1) { this.release(); return { s: "arrived" }; }
  if (this.dug > ctx.cfg.maxDigLen()) return this.fail("dug " + this.dug + " blocks without arriving (Max Dig Length)");

  if (!this.step) {
    const st = this.planStep(feet, t);
    if (st.arrived) { this.release(); return { s: "arrived" }; }
    if (st.fail) return this.fail(st.fail);
    this.step = st;
    this.step.phase = "clear";
    this.step.started = U.now();
    this.step.from = feet;
    ctx.detail = "Digging toward " + U.fmt(t);
  }
  const s = this.step;

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
      s.phase = s.place.length ? "place" : "walk";
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
