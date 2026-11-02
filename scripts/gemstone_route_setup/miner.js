/// <reference path="../polinex.d.ts" />
// Breaks blocks with the native mining rotation engine, holding left click like the powder mining module.
// tick(block, opts) -> { s: "busy" } | { s: "done" } | { s: "fail", reason, occluder? }
//
// opts.aim    fixed point to look at (the digger passes tunnel-friendly points: head face, then feet top)
// opts.hold   Set of block keys that may sit under the crosshair while the button stays held
//             (the next tunnel blocks). With it, the button is NOT released between blocks.
//             Anything else under the crosshair (floor, walls, gems) releases it at once.
// opts.allowGem / opts.allowNearLiquid  see blocks.mineBlockReason
//
// Aiming is deterministic: one point per block (the visible face centre needing the least rotation),
// never a fresh random point, so the camera does not jump around.
// A block that does not break within a generous timeout is blacklisted for this lobby and never retried.

const U = require("./util.js");

function Miner(ctx) {
  this.ctx = ctx;
  this.cur = null;
  this.holding = false;
}

// Dead-man switch: if nobody drove the miner for a couple of ticks, never leave the button held.
Miner.prototype.watchdog = function () {
  if (this.holding && U.now() - (this.activeAt || 0) > 120) this.release();
};

Miner.prototype.press = function (on) {
  this.activeAt = U.now();
  if (on && !this.holding) { player.setKey("attack", true); this.holding = true; }
  else if (!on && this.holding) { player.setKey("attack", false); this.holding = false; }
};

Miner.prototype.release = function () {
  this.press(false);
  try { rotation.miningStopRotation(); } catch (e) { /* engine idle */ }
  this.cur = null;
};

// Keep / drop the held button depending on what is under the crosshair (used while walking a tunnel).
// It also looks ~3 ticks ahead: while we move the crosshair slides forward, so the button is released
// as soon as the look ray from where the eye WILL be would hit something that is not allowed (the floor).
Miner.prototype.guard = function (allowed) {
  const B = this.ctx.blocks;
  const okBlock = (p) => !!p && !!allowed && allowed.has(U.key(U.floor(p))) && !B.mineBlockReason(U.floor(p));
  let ok = okBlock(player.mouseOverBlock());
  if (ok) {
    try {
      const yaw = player.yaw() * Math.PI / 180, pitch = player.pitch() * Math.PI / 180;
      const dir = U.v(-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      const e = world.eyePos();
      const ahead = U.v(e.x + player.motionX() * 3, e.y, e.z + player.motionZ() * 3);
      const hit = world.raytraceFrom(ahead, U.add(ahead, U.scale(dir, this.ctx.cfg.reach())));
      if (hit.block && !okBlock(hit.block)) ok = false;

    } catch (e) { /* no prediction available: current check only */ }
  }
  this.press(ok);
  return ok;
};

// One stable aim point: the requested one if it really hits the block, else the visible face centre
// that needs the smallest rotation from where we look now.
Miner.prototype.aimPoint = function (b, opts, eye) {
  const reach = this.ctx.cfg.reach() + 0.5;
  const hits = (p) => {
    if (U.dist(eye, p) > reach) return false;
    const h = world.raytraceFrom(eye, p);
    return !!h.block && U.same(U.floor(h.block), b);
  };
  if (opts && opts.aim && hits(opts.aim)) return opts.aim;
  const c = U.center(b);
  let best = null;
  for (let k = 0; k < U.DIRS6.length; k++) {
    const d = U.DIRS6[k];
    const rel = (eye.x - c.x) * d.x + (eye.y - c.y) * d.y + (eye.z - c.z) * d.z;
    if (rel <= 0.5) continue; // we are not on the outside of this face
    const p = U.add(c, U.scale(d, 0.49));
    if (!hits(p)) continue;
    const turn = rotation.distanceTo(p.x, p.y, p.z);
    if (!best || turn < best.turn) best = { p: p, turn: turn };
  }
  if (best) return best.p;
  const vp = mining.visiblePoint(b);
  return vp ? U.v(vp.x, vp.y, vp.z) : null;
};

Miner.prototype.tick = function (block, opts) {
  const ctx = this.ctx;
  const o = opts || {};
  const b = U.floor(block);
  const k = U.key(b);
  if (!this.cur || this.cur.key !== k) {
    if (!o.hold) this.press(false); // tunnel mode keeps holding through to the next block
    this.cur = { key: k, block: b, ticks: 0, onTicks: 0, prev: -1, expected: -1, aim: null, aimTries: 0, swapTries: 0, rotStart: 0 };
  }
  const c = this.cur;
  c.ticks++;

  const info = ctx.blocks.info(b);
  if (!info.loaded) return this.fail("block " + U.fmt(b) + " is not loaded");
  if (info.air || info.passable || mining.isMined(b)) {
    this.cur = null;
    if (o.hold) this.guard(o.hold); else this.press(false);
    ctx.progress();
    return { s: "done" };
  }

  const why = ctx.blocks.mineBlockReason(b, o);
  if (why) return this.fail(why + " at " + U.fmt(b));
  if (ctx.blocks.hasLiquidNeighbour(b) && !o.allowNearLiquid) return this.fail("liquid next to " + U.fmt(b));

  const eye = world.eyePos();
  if (U.dist(eye, U.center(b)) > ctx.cfg.reach() + 0.8) return this.fail("out of reach " + U.fmt(b));

  if (mining.drillSlot() < 0) {
    mining.refreshTools();
    if (mining.drillSlot() < 0) return this.fail("no drill/pickaxe in the hotbar");
  }
  if (player.heldItemSlot() !== mining.drillSlot()) {
    this.press(false);
    mining.holdDrill();
    if (++c.swapTries > 40) return this.fail("could not hold the drill");
    return { s: "busy" };
  }

  if (!c.aim) {
    c.aim = this.aimPoint(b, o, eye);
    if (!c.aim) {
      const hit = world.raytrace(U.center(b));
      const occ = hit && hit.block ? U.floor(hit.block) : null;
      if (occ && !U.same(occ, b)) return this.fail("occluded", occ);
      return this.fail("no visible face on " + U.fmt(b));
    }
    rotation.miningRotateToVec(c.aim.x, c.aim.y, c.aim.z);
    c.rotStart = U.now();
  }

  player.resetWASD(); // never walk while mining (a moving player mines the wrong block, worst when digging down)

  const over = player.mouseOverBlock();
  const overKey = over ? U.key(U.floor(over)) : null;
  const onTarget = overKey === k;
  const onAllowed = !!overKey && !!o.hold && o.hold.has(overKey) && !ctx.blocks.mineBlockReason(U.floor(over));
  this.press(onTarget || onAllowed);

  if (!onTarget) {
    const settled = rotation.miningIsDone() || !rotation.miningIsRotating() || U.now() - c.rotStart > 1500;
    if (settled) {
      if (++c.aimTries > 6) return this.fail("cannot aim at " + U.fmt(b));
      rotation.miningRotateToVec(c.aim.x, c.aim.y, c.aim.z); // same point again, no random re-aim
      c.rotStart = U.now();
    }
    return { s: "busy" };
  }

  if (ctx.cfg.useAbility() && mining.abilityReady() && !mining.abilityActive() && !mining.activatingAbility()) {
    mining.ability();
  }
  c.onTicks++;
  c.prev = mining.ticksLeft(b, c.prev);
  if (c.expected < 0 && c.prev > 0) c.expected = c.prev;
  const expected = c.expected > 0 ? c.expected : ctx.cfg.breakTicks();
  const limit = Math.max(60, Math.min(900, expected * 3 + 50));
  if (c.onTicks > limit) {
    ctx.blocks.blacklist.set(k, "did not break in " + c.onTicks + " ticks (" + info.id + ")");
    return this.fail("unbreakable here: " + info.id + " at " + U.fmt(b));
  }
  return { s: "busy" };
};

Miner.prototype.fail = function (reason, occluder) {
  this.release();
  return { s: "fail", reason: reason, occluder: occluder || null };
};

module.exports = { Miner: Miner };
