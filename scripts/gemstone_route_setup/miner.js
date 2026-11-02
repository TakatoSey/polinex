/// <reference path="../polinex.d.ts" />
// Breaks one block at a time with the native mining rotation engine.
// tick(block, opts) -> { s: "busy" } | { s: "done" } | { s: "fail", reason, occluder? }
// A block that does not break within a generous timeout is blacklisted for this lobby and never retried.

const U = require("./util.js");

function Miner(ctx) {
  this.ctx = ctx;
  this.cur = null;
  this.holding = false;
}

Miner.prototype.release = function () {
  if (this.holding) player.setKey("attack", false);
  this.holding = false;
  try { rotation.miningStopRotation(); } catch (e) { /* engine idle */ }
  this.cur = null;
};

Miner.prototype.tick = function (block, opts) {
  const ctx = this.ctx;
  const b = U.floor(block);
  const k = U.key(b);
  if (!this.cur || this.cur.key !== k) {
    if (this.holding) player.setKey("attack", false);
    this.holding = false;
    this.cur = { key: k, block: b, start: U.now(), ticks: 0, prev: -1, expected: -1, rotated: false, aimTries: 0, swapTries: 0 };
  }
  const c = this.cur;
  c.ticks++;

  const info = ctx.blocks.info(b);
  if (!info.loaded) return this.fail("block " + U.fmt(b) + " is not loaded");
  if (info.air || info.passable || mining.isMined(b)) { this.release(); ctx.progress(); return { s: "done" }; }

  const why = ctx.blocks.mineBlockReason(b, opts);
  if (why) return this.fail(why + " at " + U.fmt(b));
  if (ctx.blocks.hasLiquidNeighbour(b) && !(opts && opts.allowNearLiquid)) return this.fail("liquid next to " + U.fmt(b));

  const eye = world.eyePos();
  if (U.dist(eye, U.center(b)) > ctx.cfg.reach() + 0.8) return this.fail("out of reach " + U.fmt(b));

  const vp = mining.visiblePoint(b);
  if (!vp) {
    const hit = world.raytrace(U.center(b));
    const occ = hit && hit.block ? U.floor(hit.block) : null;
    if (occ && !U.same(occ, b)) return this.fail("occluded", occ);
    return this.fail("no visible face on " + U.fmt(b));
  }

  if (mining.drillSlot() < 0) {
    mining.refreshTools();
    if (mining.drillSlot() < 0) return this.fail("no drill/pickaxe in the hotbar");
  }
  if (player.heldItemSlot() !== mining.drillSlot()) {
    mining.holdDrill();
    if (++c.swapTries > 40) return this.fail("could not hold the drill");
    return { s: "busy" };
  }

  if (!c.rotated) {
    rotation.miningRotateToVec(vp.x, vp.y, vp.z);
    c.rotated = true;
    return { s: "busy" };
  }

  const over = player.mouseOverBlock();
  const onTarget = over && U.same(U.floor(over), b);
  if (!onTarget) {
    if (this.holding) { player.setKey("attack", false); this.holding = false; }
    if (rotation.miningIsDone() || !rotation.miningIsRotating()) {
      if (++c.aimTries > 6) return this.fail("cannot aim at " + U.fmt(b));
      c.rotated = false; // re-aim at a fresh visible point next tick
    }
    return { s: "busy" };
  }

  if (ctx.cfg.useAbility() && mining.abilityReady() && !mining.abilityActive() && !mining.activatingAbility()) {
    mining.ability();
  }
  // Instamined blocks get one click per tick instead of a held button: a hold would keep breaking
  // whatever is behind the block (often the floor) before the next tick can release it.
  const instant = c.prev >= 0 && c.prev <= 1;
  if (instant) {
    if (this.holding) { player.setKey("attack", false); this.holding = false; }
    player.leftClick();
  } else if (!this.holding) { player.setKey("attack", true); this.holding = true; }

  c.prev = mining.ticksLeft(b, c.prev);
  if (c.expected < 0 && c.prev > 0) c.expected = c.prev;
  const expected = c.expected > 0 ? c.expected : ctx.cfg.breakTicks();
  const limit = Math.max(60, Math.min(900, expected * 3 + 50));
  if (c.ticks > limit) {
    ctx.blocks.blacklist.set(k, "did not break in " + c.ticks + " ticks (" + info.id + ")");
    return this.fail("unbreakable here: " + info.id + " at " + U.fmt(b));
  }
  return { s: "busy" };
};

Miner.prototype.fail = function (reason, occluder) {
  this.release();
  return { s: "fail", reason: reason, occluder: occluder || null };
};

module.exports = { Miner: Miner };
