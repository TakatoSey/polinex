/// <reference path="../polinex.d.ts" />
// Places one support block (cobblestone) against a visible neighbouring face, using the general rotation engine.
// tick(cell) -> { s: "busy" } | { s: "done" } | { s: "fail", reason, needStand? }

const U = require("./util.js");

function Placer(ctx) {
  this.ctx = ctx;
  this.cur = null;
}

Placer.prototype.release = function () {
  if (this.cur && this.cur.sneaking) this.ctx.input.sneak(false);
  try { rotation.generalStopRotation(); } catch (e) { /* idle */ }
  this.cur = null;
};

// Visible faces of solid neighbours of `cell` that the eye can click right now.
Placer.prototype.faceFor = function (cell, eye) {
  const ctx = this.ctx;
  let best = null;
  for (let k = 0; k < U.DIRS6.length; k++) {
    const d = U.DIRS6[k];
    const n = U.add(cell, d);
    const ni = ctx.blocks.info(n);
    if (!ni.loaded || !ni.solid || ni.liquid) continue;
    // point on the face of n that touches `cell`, nudged into n so the ray registers n
    const facePoint = U.add(U.center(cell), U.scale(d, 0.5));
    const aim = U.add(facePoint, U.scale(d, 0.02));
    if (U.dist(eye, aim) > ctx.cfg.reach()) continue;
    // the ray must come through `cell` (approach from the cell side of the face)
    const toFace = U.sub(facePoint, eye);
    if (toFace.x * d.x + toFace.y * d.y + toFace.z * d.z <= 0.05) continue;
    const hit = world.raytraceFrom(eye, aim);
    if (!hit.block || !U.same(U.floor(hit.block), n)) continue;
    const turn = rotation.distanceTo(aim.x, aim.y, aim.z);
    if (!best || turn < best.turn) best = { n: n, aim: aim, turn: turn };
  }
  return best;
};

Placer.prototype.tick = function (cell) {
  const ctx = this.ctx;
  const c0 = U.floor(cell);
  const k = U.key(c0);
  if (!this.cur || this.cur.key !== k) {
    this.release();
    this.cur = { key: k, cell: c0, phase: "prep", tries: 0, clickedAt: 0, sneaking: false, face: null };
  }
  const c = this.cur;
  const info = ctx.blocks.info(c0);
  if (!info.loaded) return this.fail("cell " + U.fmt(c0) + " is not loaded");
  if (ctx.blocks.isCobble(info.id)) {
    ctx.blocks.ourCobble.add(k);
    this.release();
    ctx.progress();
    return { s: "done" };
  }
  if (!info.passable) return this.fail("cell " + U.fmt(c0) + " is occupied by " + info.id);

  const feet = player.blockPos();
  if (U.same(feet, c0) || U.same(U.up(feet, 1), c0)) return this.fail("standing inside " + U.fmt(c0), true);

  if (c.phase === "prep") {
    const r = ctx.items.ensureHotbar(ctx.cfg.placeItem());
    if (r.s === "busy") return r;
    if (r.s === "fail") return this.fail(r.reason);
    if (!player.setHeldItemSlot(r.slot)) return { s: "busy" };
    c.face = this.faceFor(c0, world.eyePos());
    if (!c.face) return this.fail("no visible support face for " + U.fmt(c0) + " from here", true);
    this.ctx.input.sneak(true); // never open a GUI by clicking an interactable block
    c.sneaking = true;
    rotation.generalRotateToVec(c.face.aim.x, c.face.aim.y, c.face.aim.z);
    c.phase = "aim";
    c.aimStart = U.now();
    return { s: "busy" };
  }

  if (c.phase === "aim") {
    if (!rotation.generalIsDone() && U.now() - c.aimStart < 1500) return { s: "busy" };
    const over = player.mouseOverBlock();
    if (!over || !U.same(U.floor(over), c.face.n)) {
      if (++c.tries > 3) return this.fail("could not aim at the support face of " + U.fmt(c0), true);
      c.phase = "prep";
      return { s: "busy" };
    }
    if (player.heldItemSlot() !== player.itemByName(ctx.cfg.placeItem())) { c.phase = "prep"; return { s: "busy" }; }
    player.rightClick();
    c.clickedAt = U.now();
    c.phase = "verify";
    return { s: "busy" };
  }

  if (c.phase === "verify") {
    if (U.now() - c.clickedAt < 400) return { s: "busy" };
    if (++c.tries > 3) return this.fail("placing at " + U.fmt(c0) + " did not work (server rejected or lag)");
    c.phase = "prep";
    return { s: "busy" };
  }
  return { s: "busy" };
};

// Pillar placement: standing with our feet in `cell` (on the block below it), look down, jump and place
// the block under ourselves. Used for columns under floating waypoints; ends standing on the new block.
Placer.prototype.canPillar = function (cell) {
  const B = this.ctx.blocks;
  const below = B.info(U.up(cell, -1));
  const c = B.info(cell), h1 = B.info(U.up(cell, 1)), h2 = B.info(U.up(cell, 2));
  return below.loaded && below.solid && !below.liquid && c.passable && h1.passable && h2.passable;
};

Placer.prototype.pillarTick = function (cell) {
  const ctx = this.ctx;
  const c0 = U.floor(cell);
  const k = "pillar:" + U.key(c0);
  if (!this.cur || this.cur.key !== k) {
    this.release();
    this.cur = { key: k, phase: "prep", tries: 0, at: 0 };
  }
  const c = this.cur;
  const info = ctx.blocks.info(c0);
  if (ctx.blocks.isCobble(info.id)) {
    ctx.blocks.ourCobble.add(U.key(c0));
    this.release();
    ctx.progress();
    return { s: "done" };
  }
  if (!info.passable) return this.fail("cell " + U.fmt(c0) + " is occupied by " + info.id);
  const feet = player.blockPos();
  const airborne = !player.onGround();
  if (!airborne && !U.same(feet, c0)) return this.fail("not standing in " + U.fmt(c0) + " for pillar placement", true);

  if (c.phase === "prep") {
    const r = ctx.items.ensureHotbar(ctx.cfg.placeItem());
    if (r.s === "busy") return r;
    if (r.s === "fail") return this.fail(r.reason);
    if (!player.setHeldItemSlot(r.slot)) return { s: "busy" };
    // top face of the block we stand on, almost straight down: the look angle stays fixed while we rise, so the
    // offset grows with the jump height (jump boost ~2.4 blocks). 0.12 still lands on the block at that apex,
    // and is enough to keep the yaw defined (no spinning).
    const pa = U.steadyAim(U.v(c0.x + 0.5, c0.y - 0.02, c0.z + 0.5), 0.12);
    rotation.generalRotateToVec(pa.x, pa.y, pa.z);
    c.phase = "aim";
    c.at = U.now();
    return { s: "busy" };
  }
  if (c.phase === "aim") {
    if (!rotation.generalIsDone() && U.now() - c.at < 1500) return { s: "busy" };
    // be exactly on the centre before jumping, so we land back on top of the new block (jump boost jumps higher)
    const cc = U.v(c0.x + 0.5, c0.y, c0.z + 0.5);
    if (player.onGround() && !ctx.input.nudge(cc, 0.2)) {
      if (U.now() - c.at > 5000) return this.fail("could not centre on " + U.fmt(c0) + " for pillar placement", true);
      return { s: "busy" };
    }
    if (!player.onGround() || player.speed() > 0.01) { player.resetWASD(); return { s: "busy" }; } // stand still first
    player.resetWASD();
    ctx.input.jump(); // a real jump key press, like the space bar
    c.phase = "rise";
    c.at = U.now();
    c.lastY = player.y();
    c.rising = false;
    return { s: "busy" };
  }
  if (c.phase === "rise") {
    // Click at the TOP of the jump: the server sees us slightly behind the client (ping). Placing while it still
    // thinks we are inside the cell gets the block rejected, we land on a ghost block and get lagged back.
    // So: airborne, feet clearly above the cell, no longer rising (apex), crosshair on the block we stood on.
    const over = player.mouseOverBlock();
    const onBase = !!over && U.same(U.floor(over), U.up(c0, -1));
    const y = player.y();
    if (y > c.lastY + 0.001) c.rising = true;
    const atApex = c.rising && y <= c.lastY + 0.001;
    c.lastY = y;
    if (!player.onGround() && atApex && y >= c0.y + 1.15 && onBase) {
      player.rightClick();
      c.phase = "verify";
      c.at = U.now();
      return { s: "busy" };
    }
    if (U.now() - c.at > 300 && player.onGround()) { c.phase = "prep"; if (++c.tries > 3) return this.fail("pillar jump at " + U.fmt(c0) + " never got high enough"); return { s: "busy" }; }
    if (U.now() - c.at > 1200) {
      if (++c.tries > 3) return this.fail("pillar jump at " + U.fmt(c0) + " never got high enough");
      c.phase = "prep";
    }
    return { s: "busy" };
  }
  if (c.phase === "verify") {
    if (U.now() - c.at < 500) return { s: "busy" };
    if (++c.tries > 3) return this.fail("pillar placement at " + U.fmt(c0) + " did not work");
    c.phase = "prep";
  }
  return { s: "busy" };
};

Placer.prototype.fail = function (reason, needStand) {
  this.release();
  return { s: "fail", reason: reason, needStand: !!needStand };
};

module.exports = { Placer: Placer };
