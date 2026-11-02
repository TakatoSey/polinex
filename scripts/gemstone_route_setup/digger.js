/// <reference path="../polinex.d.ts" />
// Digs a 1x2 passage toward a target feet position: straight level tunnels, staircases up, or straight down.
// Tunnels go along ONE axis until that axis is done (an L-shape, never a zigzag), the button stays held
// like the powder mining module, and the camera only moves between two fixed points per step
// (head block face, then feet block top), with a fixed yaw along the tunnel.
// Never digs through gemstones, liquids, unknown terrain, structure cores or blacklisted blocks.
// It never places blocks (no bridging while tunnelling): a missing floor is either a safe drop or a blocked direction.
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
  this.lineStop();
  this.ctx.miner.release();
  this.ctx.placer.release();
  player.resetWASD();
  if (this.sneaking) { this.ctx.input.sneak(false); this.sneaking = false; }
  this.lookKey = null;
  this.step = null;
};

// Tunnel like a player does it: look ONE way (tunnel yaw, fixed pitch) once, crouch, hold left click and only
// press W when the space ahead is open (never walk into the wall). No camera movement per block.
// For a shaft: look down-forward once, stand still, hold, fall.
Digger.prototype.driveTick = function (s) {
  const ctx = this.ctx;
  if (mining.drillSlot() < 0) {
    mining.refreshTools();
    if (mining.drillSlot() < 0) return this.fail("no drill/pickaxe in the hotbar");
  }
  if (player.heldItemSlot() !== mining.drillSlot()) { ctx.miner.press(false); mining.holdDrill(); return { s: "busy" }; }

  const lookKey = s.vertical ? "down" : s.h.x + "," + s.h.z;
  if (this.lookKey !== lookKey) {
    ctx.miner.press(false);
    let p;
    if (s.vertical) p = s.aims[0];
    else {
      const e = world.eyePos(), pitch = ctx.cfg.tunnelPitch() * Math.PI / 180;
      p = U.v(e.x + s.h.x * Math.cos(pitch) * 3, e.y - Math.sin(pitch) * 3, e.z + s.h.z * Math.cos(pitch) * 3);
    }
    rotation.miningRotateToVec(p.x, p.y, p.z);
    this.lookKey = lookKey;
    this.lookAt = U.now();
    return { s: "busy" };
  }
  if (!rotation.miningIsDone() && rotation.miningIsRotating() && U.now() - this.lookAt < 1500) return { s: "busy" };

  this.ctx.input.sneak(true); this.sneaking = true;
  const solid = s.clear.filter((c) => !ctx.blocks.info(c).passable);
  if (!solid.length) {
    if (s.vertical) ctx.miner.release(); else ctx.miner.guard(s.holdNext);
    s.phase = s.vertical ? "fall" : "walk";
    s.walkStart = U.now();
    return { s: "busy" };
  }
  for (let i = 0; i < solid.length; i++) {
    const why = ctx.blocks.mineBlockReason(solid[i]);
    if (why) return this.badStep(why + " at " + U.fmt(solid[i]));
  }
  if (ctx.cfg.useAbility() && mining.abilityReady() && !mining.abilityActive() && !mining.activatingAbility()) mining.ability();

  // hold LMB only while the crosshair is on one of this step's (or the next) tunnel blocks
  const holding = ctx.miner.guard(s.hold);
  if (s.solidLeft !== solid.length) { s.solidLeft = solid.length; s.progressAt = U.now(); }
  const stalled = U.now() - (s.progressAt || s.started);
  if (!holding && stalled > 700) {
    // crosshair is not on the block: we are off-centre (e.g. pushed). Shuffle back to the cell centre, crouched.
    // a bit closer to the face makes the crosshair land on the feet block; only W/S, no sideways A/D
    const c = U.v(s.from.x + 0.5 + s.h.x * 0.2, s.from.y, s.from.z + 0.5 + s.h.z * 0.2);
    if (!ctx.input.nudge(c, 0.3)) return { s: "busy" };
  }
  player.resetWASD(); // standing still while the block breaks (no wall kissing)
  if (stalled > 3000 && !s.relooked) { s.relooked = true; this.lookKey = null; } // one fresh look, never a sweep
  if (stalled > 9000) {
    solid.forEach((c) => ctx.blocks.blacklist.set(U.key(c), "did not break while tunnelling"));
    return this.badStep("could not mine " + U.fmt(solid[0]) + " (unbreakable or not under the crosshair)");
  }
  return { s: "busy" };
};

Digger.prototype.reset = function (target) {
  this.release();
  if (!target) { this.axis = null; this.lastDir = null; this.sidesteps = 0; this.sideDir = null; } // forget when movement stops
  this.stepFallback = 0;
  this.stuckSince = 0;
  this.lastFeetKey = null;
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
  // straight line blocked (gem, liquid, structure...)? a one-block sidestep goes around it, but never a U-turn
  // (stepping back the way we came made the camera flip 180 degrees back and forth) and at most 3 in a row
  if (dirs.length === 1 && (this.sidesteps || 0) < 3) {
    const d0 = dirs[0];
    const side = [U.v(d0.z, 0, d0.x), U.v(-d0.z, 0, -d0.x)];
    if (this.sideDir) side.sort((a, b) => (U.same(a, this.sideDir) ? -1 : 0) - (U.same(b, this.sideDir) ? -1 : 0)); // keep the same side
    side.forEach((d) => dirs.push(d));
  }
  const last = this.lastDir;
  for (let i = dirs.length - 1; i >= 0; i--) if (last && dirs[i].x === -last.x && dirs[i].z === -last.z) dirs.splice(i, 1);
  const reasons = [];

  if (dirs.length === 0) {
    if (dy < 0) {
      const below = U.up(feet, -1), support = U.up(feet, -2);
      const why = this.checkCells([below]);
      const sup = B.info(support);
      const safeFall = sup.loaded && (sup.solid || this.landingDepth(support, this.ctx.cfg.maxDrop()) > 0);
      // straight down: centre on the block, stand completely still while mining, then just fall
      if (!why && safeFall) {
        // aim at the floor slightly IN FRONT of us along the current facing (~80 degrees down): looking exactly
        // straight down makes the yaw undefined and the camera spins around
        const yaw = player.yaw() * Math.PI / 180;
        const fx = -Math.sin(yaw) * 0.3, fz = Math.cos(yaw) * 0.3;
        return { clear: [below], place: [], feet: below, up: false, vertical: true, badKey: "v" + U.key(feet),
          aims: [U.v(below.x + 0.5 + fx, below.y + 0.99, below.z + 0.5 + fz)], hold: new Set([U.key(below)]), holdNext: null };
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
    // climb only when it is really needed: >= 2 higher, or 1 higher and we are already there horizontally
    // (a 1 block difference is within reach anyway; climbing early meant looking up + jumping for nothing)
    const horizLeft = Math.abs(dx) + Math.abs(dz);
    if (dy >= 2 || (dy >= 1 && horizLeft <= 1)) {
      const above = U.up(feet, 2);
      step = { clear: [above, U.up(n, 2), U.up(n, 1)], feet: U.up(n, 1), supportCell: n, up: true,
        aims: [U.v(above.x + 0.5 + h.x * 0.3, above.y + 0.01, above.z + 0.5 + h.z * 0.3), face(U.up(n, 2)), face(U.up(n, 1))] };
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
    let sup = B.info(step.supportCell);
    if (step.up && sup.passable && !sup.liquid) {
      // target is higher but the way ahead is open floor: walk on level, climb later where there is a step
      const lvl = { clear: [U.up(n, 1), n], feet: n, supportCell: U.up(n, -1), up: false,
        aims: [face(U.up(n, 1), 0.25), U.v(n.x + 0.5, n.y + 0.99, n.z + 0.5)] };
      const lvlSup = B.info(lvl.supportCell);
      if (lvlSup.loaded && lvlSup.solid && !this.checkCells(lvl.clear)) {
        Object.assign(step, lvl);
        step.hold = new Set(step.clear.map(U.key));
        step.holdNext.forEach((kk) => step.hold.add(kk));
        sup = lvlSup;
      }
    }
    if (!sup.loaded) { reasons.push("unknown floor at " + U.fmt(step.supportCell)); this.badSteps.add(bad); continue; }
    if (sup.liquid) { reasons.push("liquid floor at " + U.fmt(step.supportCell)); this.badSteps.add(bad); continue; }
    if (!sup.solid) {
      // a drop onto known solid ground is fine; otherwise this direction is blocked (no bridging with blocks)
      if (sup.passable && !step.up && this.landingDepth(step.supportCell, this.ctx.cfg.maxDrop()) > 0) step.drop = true;
      else { reasons.push("no floor at " + U.fmt(step.supportCell)); this.badSteps.add(bad); continue; }
    }
    return step;
  }
  return { fail: reasons.length ? reasons[0] : "no diggable direction" };
};

// Dead-man switch: walk keys / held button are released if the digger stops being ticked.
Digger.prototype.watchdog = function () {
  if ((this.step || this.lineOn) && U.now() - (this.tickAt || 0) > 150) this.release();
};

function angleDiff(a, b) { return Math.abs(((a - b) % 360 + 540) % 360 - 180); }

// Pitch for tunnelling: the steepest look at which the floor stays out of mining reach (so a held LMB can never
// reach it) for the current eye height (crouching lowers it). Head blocks break in front, feet blocks ahead.
Digger.prototype.tunnelPitch = function () {
  const fixed = this.ctx.cfg.tunnelPitch();
  if (fixed > 0) return fixed;
  const eyeH = Math.max(1.1, Math.min(1.7, world.eyePos().y - player.y()));
  const deg = Math.asin(Math.min(0.9, eyeH / (this.ctx.cfg.reach() + 0.4))) * 180 / Math.PI - 1;
  return Math.max(10, Math.min(22, deg));
};

Digger.prototype.lineStop = function () {
  if (this.lineOn) { player.setKey("forward", false); this.lineOn = false; }
  this.fixCell = null;
};

// One tick of straight-line tunnelling toward t: look along the line (yaw to the target, fixed pitch), crouch,
// hold W, hold LMB while the crosshair is on a block of our tunnel. Turning happens while walking.
// The camera only moves off the line when the body is stuck on a block the crosshair does not reach
// (a corner when going diagonally): look at it, break it, look back along the line.
Digger.prototype.lineTick = function (t) {
  const ctx = this.ctx, B = ctx.blocks, cfg = ctx.cfg;
  const p = player.pos(), feet = player.blockPos();
  const dx = t.x + 0.5 - p.x, dz = t.z + 0.5 - p.z;
  const d = Math.sqrt(dx * dx + dz * dz) || 1;
  const fx = dx / d, fz = dz / d;
  if (!player.onGround() && !this.lineOn) return { s: "busy" };
  if (mining.drillSlot() < 0) { mining.refreshTools(); if (mining.drillSlot() < 0) return this.fail("no drill/pickaxe in the hotbar"); }
  if (player.heldItemSlot() !== mining.drillSlot()) { ctx.miner.press(false); mining.holdDrill(); return { s: "busy" }; }

  // cells the body sweeps through in the next ~1.3 blocks (feet + head, hitbox edges included)
  const front = [], seen = new Set();
  const sx = -fz, sz = fx;
  [0.45, 0.9, 1.3].forEach((a) => [-0.3, 0, 0.3].forEach((o) => {
    const x = Math.floor(p.x + fx * a + sx * o), z = Math.floor(p.z + fz * a + sz * o);
    if (x === feet.x && z === feet.z) return;
    for (let h = 0; h <= 1; h++) {
      const c = U.v(x, feet.y + h, z), k = U.key(c);
      if (!seen.has(k)) { seen.add(k); front.push(c); }
    }
  }));
  for (let i = 0; i < front.length; i++) {
    const fi = B.info(front[i]);
    if (!fi.loaded) return { s: "blocked", reason: "unknown terrain at " + U.fmt(front[i]) };
    if (fi.liquid) return { s: "blocked", reason: "liquid at " + U.fmt(front[i]) };
    if (!fi.passable) {
      const why = B.mineBlockReason(front[i]);
      if (why) return { s: "blocked", reason: why + " at " + U.fmt(front[i]) };
      if (B.hasLiquidNeighbour(front[i])) return { s: "blocked", reason: "would open liquid at " + U.fmt(front[i]) };
    }
  }
  // the floor ahead: a hole is fine only as a short drop onto known ground
  const under = U.v(Math.floor(p.x + fx * 0.9), feet.y - 1, Math.floor(p.z + fz * 0.9));
  const ui = B.info(under);
  if (!ui.loaded || ui.liquid) return { s: "blocked", reason: "unknown / liquid floor at " + U.fmt(under) };
  const drop = ui.passable;
  if (drop && this.landingDepth(under, cfg.maxDrop()) === 0) return { s: "blocked", reason: "no floor at " + U.fmt(under) };

  // blocks the held button may break: our tunnel (feet + head level) along the line up to mining reach,
  // never the floor. At the flat tunnel pitch the crosshair breaks head blocks close in front and feet blocks
  // 2-5 blocks ahead, before we get there, so the button simply stays down.
  const allowed = new Set(seen);
  for (let a = 1.5; a <= cfg.reach() + 1; a += 0.4) {
    [-0.3, 0, 0.3].forEach((o) => {
      const x = Math.floor(p.x + fx * a + sx * o), z = Math.floor(p.z + fz * a + sz * o);
      allowed.add(x + "," + feet.y + "," + z);
      allowed.add(x + "," + (feet.y + 1) + "," + z);
    });
  }

  // a block in the way that the crosshair does not reach: look at it, break it, then look along the line again
  if (this.fixCell) {
    if (B.info(this.fixCell).passable) { this.fixCell = null; this.lookAt = 0; return { s: "busy" }; }
    const r = ctx.miner.tick(this.fixCell, { hold: allowed });
    if (r.s === "fail") { const c = this.fixCell; this.fixCell = null; return { s: "blocked", reason: r.reason + " at " + U.fmt(c) }; }
    if (r.s === "done") { this.fixCell = null; this.lookAt = 0; }
    return { s: "busy" };
  }

  // look along the line: yaw toward the target, fixed pitch; only re-aimed when we drift more than ~6 degrees
  const wantYaw = Math.atan2(-fx, fz) * 180 / Math.PI;
  const pitchDeg = this.tunnelPitch();
  if ((angleDiff(wantYaw, player.yaw()) > 6 || Math.abs(player.pitch() - pitchDeg) > 6) && U.now() - (this.lookAt || 0) > 250) {
    const e = world.eyePos(), pr = pitchDeg * Math.PI / 180;
    rotation.miningRotateToVec(e.x + fx * Math.cos(pr) * 3, e.y - Math.sin(pr) * 3, e.z + fz * Math.cos(pr) * 3);
    this.lookAt = U.now();
  }

  ctx.input.sneak(!drop); // crouched (cannot slide off an edge), except for a deliberate drop
  this.sneaking = !drop;
  const holding = ctx.miner.guard(allowed, true);
  if (ctx.cfg.useAbility() && holding && mining.abilityReady() && !mining.abilityActive() && !mining.activatingAbility()) mining.ability();
  player.setKey("forward", true);
  this.lineOn = true;

  // progress: every new block we stand in counts as one dug block
  const fk = U.key(feet);
  if (this.lastFeetKey !== fk) { this.lastFeetKey = fk; this.dug++; this.stuckSince = 0; ctx.progress(); }
  const moving = player.speed() > 0.03;
  const breaking = holding && !!player.mouseOverBlock(); // holding LMB at air is not progress
  if (moving || breaking) this.stuckSince = 0;
  else if (!this.stuckSince) this.stuckSince = U.now();
  if (this.stuckSince && U.now() - this.stuckSince > 350) {
    const block = front.find((c) => !B.info(c).passable);
    if (block) { this.fixCell = block; this.stuckSince = 0; player.setKey("forward", false); return { s: "busy" }; }
    if (U.now() - this.stuckSince > 3000) return { s: "blocked", reason: "stuck at " + U.fmt(feet) };
  }
  ctx.detail = "Tunnelling toward " + U.fmt(t);
  return { s: "busy" };
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

  // Straight-line tunnelling (the normal case): toward the target at any angle, W + LMB held, one look.
  // The step planner below is only used for shafts down, real climbs, and going around something unminable.
  const dyT = flat ? 0 : t.y - feet.y;
  const hd = U.distFlat(player.pos(), U.v(t.x + 0.5, 0, t.z + 0.5));
  if (!this.step && hd >= 0.7 && dyT <= 1 && !(this.stepFallback > 0)) {
    const lr = this.lineTick(t);
    if (lr.s !== "blocked") return lr;
    this.lineStop();
    this.stepFallback = 3; // a few planned steps (they sidestep around it), then back to the straight line
    ctx.log("Tunnel: " + lr.reason + " -> going around it");
  }
  if (this.step === null) this.lineStop();

  if (!this.step) {
    // only plan from the ground: mid-jump (jump boost / god potion) the feet position is in the air and every
    // step would look like it has no floor
    if (!player.onGround()) { player.resetWASD(); return { s: "busy" }; }
    const st = this.planStep(feet, t, flat);
    if (st.arrived) { this.release(); return { s: "arrived" }; }
    if (st.fail) return this.fail(st.fail);
    this.step = st;
    if (st.h) {
      // a sidestep is a step across the main direction toward the target
      const tdx = Math.sign(t.x - feet.x), tdz = Math.sign(t.z - feet.z);
      const along = (st.h.x && st.h.x === tdx) || (st.h.z && st.h.z === tdz);
      if (along) { this.sidesteps = 0; this.sideDir = null; } else { this.sidesteps = (this.sidesteps || 0) + 1; this.sideDir = st.h; }
      this.lastDir = st.h;
    }
    if (st.axis && (!st.h || this.sidesteps === 0)) this.axis = st.axis;
    this.step.phase = st.vertical ? "center" : "clear";
    this.step.started = U.now();
    this.step.from = feet;
    ctx.detail = "Digging toward " + U.fmt(t);
  }
  const s = this.step;

  // Vertical shaft: moving while mining down breaks it (you slide off / mine the wrong block),
  // so first centre on the block, wait until we are standing still, and never press a key while mining.
  if (s.phase === "center") {
    // Inside a 1x1 shaft we already fit: no centring at all (the old tight centring did D A D A forever).
    const B = this.ctx.blocks, f = s.from;
    const boxed = [[1, 0], [-1, 0], [0, 1], [0, -1]].every((d) => !B.info(U.v(f.x + d[0], f.y, f.z + d[1])).passable);
    const c = U.v(f.x + 0.5, f.y, f.z + 0.5);
    if (!boxed && U.now() - s.started < 2500 && !this.ctx.input.nudge(c, 0.25)) return { s: "busy" }; // loose, then just dig
    player.resetWASD();
    if ((player.speed() > 0.01 || !player.onGround()) && U.now() - s.started < 3500) return { s: "busy" }; // let the momentum die
    s.phase = "clear";
    return { s: "busy" };
  }

  if (s.phase === "fall") {
    const here = player.blockPos();
    // Still standing on the edge of the new hole (not centred enough to drop): step in WITHOUT crouching, crouching
    // is exactly what stops you from walking over an edge
    if (player.onGround() && here.y > s.feet.y && U.now() - s.walkStart > 300) {
      ctx.input.sneak(false);
      this.sneaking = false;
      ctx.input.nudge(U.v(s.feet.x + 0.5, s.feet.y, s.feet.z + 0.5), 0.05, { sneak: false });
    } else player.resetWASD();
    if (player.onGround() && here.y <= s.feet.y) {
      player.resetWASD();
      this.dug++;
      this.step = null;
      if (this.stepFallback > 0) this.stepFallback--;
      ctx.progress();
      return { s: "busy" };
    }
    if (U.now() - s.walkStart > 4000) return this.badStep("did not fall into the shaft at " + U.fmt(s.feet));
    return { s: "busy" };
  }

  if (s.phase === "clear" && !s.up && !(s.extra && s.extra.length)) return this.driveTick(s);

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
    // something appeared in the cells we step into (a treasure chest spawned there): never walk into it,
    // drop this step and go around (the chest is protected, so this direction is now blocked)
    for (let i = 0; i < s.clear.length; i++) {
      const ci = ctx.blocks.info(s.clear[i]);
      if (ci.loaded && !ci.passable) {
        player.resetWASD();
        return this.badStep((/chest/.test(ci.id) ? "treasure chest" : ci.id) + " appeared at " + U.fmt(s.clear[i]) + ", going around");
      }
    }
    const goal = U.v(s.feet.x + 0.5, s.feet.y, s.feet.z + 0.5);
    const here = player.blockPos();
    const landed = s.drop && here.x === s.feet.x && here.z === s.feet.z && here.y <= s.feet.y && player.onGround();
    if ((U.same(here, s.feet) || landed) && U.distFlat(player.pos(), goal) < 0.4) {
      player.resetWASD();
      this.dug++;
      this.step = null;
      if (this.stepFallback > 0) this.stepFallback--;
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
    // crouch-walk (cannot slide off an edge), except when this step is a deliberate drop
    if (s.drop && this.sneaking) { this.ctx.input.sneak(false); this.sneaking = false; }
    else if (!s.drop && !s.up && !this.sneaking) { this.ctx.input.sneak(true); this.sneaking = true; }
    // walk in normally, but the last bit is tapped so we never overshoot and walk back (W S W S)
    if (s.drop || s.up || U.distFlat(player.pos(), goal) > 0.6) player.setOptimalKeysTo(goal.x, goal.y, goal.z, true);
    else ctx.input.nudge(goal, 0.35);
    // step up: one real jump-key press from the ground when we touch the step (never a scripted jump)
    if (s.up && player.onGround() && U.distFlat(player.pos(), goal) < 1.3 && (!s.lastJump || U.now() - s.lastJump > 700)) {
      if ((s.jumps || 0) >= 2) return this.badStep("could not step up onto " + U.fmt(s.feet) + " (2 jumps)"); // no jump spam
      ctx.input.jump();
      s.jumps = (s.jumps || 0) + 1;
      s.lastJump = U.now();
    }
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
