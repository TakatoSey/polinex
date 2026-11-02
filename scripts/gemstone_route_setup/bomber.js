/// <reference path="../polinex.d.ts" />
// Throws a Bob-omb at a target point. Using it launches a TNT ahead of you that explodes after landing
// (about 8 block radius, ignores breaking power). It does nothing inside structure no-bomb zones.
// tick(target) -> { s: "busy" } | { s: "done" } | { s: "fail", reason, needStand? }

const U = require("./util.js");

function Bomber(ctx) {
  this.ctx = ctx;
  this.cur = null;
}

Bomber.prototype.release = function () {
  try { rotation.generalStopRotation(); } catch (e) { /* idle */ }
  this.cur = null;
};

Bomber.prototype.tick = function (target) {
  const ctx = this.ctx;
  const t = U.v(target.x, target.y, target.z);
  const k = U.key(t);
  if (!this.cur || this.cur.key !== k) {
    this.release();
    this.cur = { key: k, phase: "prep", tries: 0, before: 0, thrownAt: 0, aimStart: 0 };
  }
  const c = this.cur;
  const name = ctx.cfg.bombItem();

  if (c.phase === "prep") {
    const zone = ctx.blocks.noBombZone(t) || ctx.blocks.noBombZone(player.pos());
    if (zone) return this.fail("no-bomb zone (" + zone + ")");
    const r = ctx.items.ensureHotbar(name);
    if (r.s === "busy") return r;
    if (r.s === "fail") return this.fail(r.reason);
    const eye = world.eyePos();
    const d = U.dist(eye, t);
    if (d > 10) return this.fail("too far to throw accurately (" + d.toFixed(1) + " blocks)", true);
    c.solidBefore = this.solidAround(t);
    const hit = world.raytraceFrom(eye, t);
    if (hit.type !== "MISS" && U.dist(U.v(hit.x, hit.y, hit.z), t) > 1.5) return this.fail("no line of sight to the bomb target", true);
    if (!player.setHeldItemSlot(r.slot)) return { s: "busy" };
    c.before = ctx.items.count(name);
    const ta = U.steadyAim(t);
    rotation.generalRotateToVec(ta.x, ta.y, ta.z);
    c.aimStart = U.now();
    c.phase = "aim";
    return { s: "busy" };
  }

  if (c.phase === "aim") {
    if (!rotation.generalIsDone() && U.now() - c.aimStart < 1500) return { s: "busy" };
    if (player.heldItemSlot() !== player.itemByName(name)) { c.phase = "prep"; return { s: "busy" }; }
    player.rightClick();
    c.thrownAt = U.now();
    c.phase = "fuse";
    return { s: "busy" };
  }

  if (c.phase === "fuse") {
    const used = ctx.items.count(name) < c.before;
    if (!used && U.now() - c.thrownAt > 1500) {
      if (++c.tries > 2) return this.fail("Bob-omb was not used (cooldown, menu, or blocked area)");
      c.phase = "prep";
      return { s: "busy" };
    }
    if (U.now() - c.thrownAt < ctx.cfg.bombFuseMs()) return { s: "busy" };
    // check it really went off: some blocks around the waypoint must be gone
    if (this.solidAround(t) >= c.solidBefore && c.solidBefore > 0) {
      if (!c.waitedExtra) { c.waitedExtra = true; c.thrownAt = U.now() - ctx.cfg.bombFuseMs() + 1500; return { s: "busy" }; }
      return this.fail("Bob-omb did not explode here (no-bomb area or it flew past the waypoint)");
    }
    this.release();
    ctx.progress();
    return { s: "done" };
  }
  return { s: "busy" };
};

Bomber.prototype.solidAround = function (t) {
  const B = this.ctx.blocks;
  const c = U.floor(t);
  let n = 0;
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
    const i = B.info(U.v(c.x + dx, c.y + dy, c.z + dz));
    if (i.loaded && i.solid) n++;
  }
  return n;
};

Bomber.prototype.fail = function (reason, needStand) {
  this.release();
  return { s: "fail", reason: reason, needStand: !!needStand };
};

module.exports = { Bomber: Bomber };
