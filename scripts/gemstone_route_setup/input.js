/// <reference path="../polinex.d.ts" />
// Player-like inputs that are easy to get wrong:
//  * jump = press the real jump key for ~2 ticks (exactly what the space bar does), only from the ground,
//    with a cooldown. No scripted jump() (a velocity jump can get you lagged back / "tp'd around").
//  * sneak = only changed while standing on the ground (toggling sneak mid-air changes your speed in a way the
//    server can flag and correct with a setback).

const U = require("./util.js");

function Input(ctx) {
  this.ctx = ctx;
  this.jumpDown = false;
  this.jumpAt = 0;
  this.sneakWanted = null;
  this.sneakIs = false;
}

// Call every tick you want to jump; it only presses once per real jump.
Input.prototype.jump = function () {
  if (this.jumpDown) return;
  if (!player.onGround() || U.now() - this.jumpAt < 450) return;
  player.setKey("jump", true);
  this.jumpDown = true;
  this.jumpAt = U.now();
};

Input.prototype.sneak = function (on) {
  this.sneakWanted = !!on;
  this.applySneak();
};

Input.prototype.applySneak = function () {
  if (this.sneakWanted === null || this.sneakWanted === this.sneakIs) return;
  if (!player.onGround()) return; // never in the air
  player.setSneaking(this.sneakWanted);
  this.sneakIs = this.sneakWanted;
};

// Called once per client tick from main.js.
Input.prototype.tick = function () {
  if (this.jumpDown && (U.now() - this.jumpAt > 100 || !player.onGround())) {
    player.setKey("jump", false);
    this.jumpDown = false;
  }
  this.applySneak();
};

// Get onto a spot WITHOUT wobbling (the W S W S / A D A D problem): crouch-walk, tap the keys once close
// (like tapping W), and after an overshoot wait until standing still instead of reversing at once.
// Returns true when within `tol` (and releases the keys).
// Turn (yaw only, level look) toward where we walk, like a player does. True once roughly facing it.
Input.prototype.face = function (target) {
  const p = player.pos();
  const dx = target.x - p.x, dz = target.z - p.z;
  if (dx * dx + dz * dz < 0.25) return true;
  const want = Math.atan2(-dx, dz) * 180 / Math.PI;
  let diff = Math.abs(((want - player.yaw()) % 360 + 540) % 360 - 180);
  if (diff < 35) return true;
  if (!this.faceAt || U.now() - this.faceAt > 400) {
    const e = world.eyePos();
    rotation.pathFindRotateToVec(target.x, e.y - 0.4, target.z);
    this.faceAt = U.now();
  }
  return false;
};

// opts.sneak === false: do not crouch (needed to step over an edge into a hole)
Input.prototype.nudge = function (target, tol, opts) {
  const p = player.pos();
  const d = U.distFlat(p, target);
  if (d <= tol) { player.resetWASD(); this.nudgeT = 0; return true; }
  // more than a step away: face it and walk forward instead of walking backwards / sideways
  if (d > 1.0 && !this.face(target)) { player.resetWASD(); return false; }
  if (!(opts && opts.sneak === false)) this.sneak(true);
  const dirX = target.x - p.x, dirZ = target.z - p.z;
  const vx = player.motionX ? player.motionX() : 0, vz = player.motionZ ? player.motionZ() : 0;
  const movingAway = vx * dirX + vz * dirZ < -0.0005; // overshot: let it settle, do not reverse immediately
  if (movingAway && Math.sqrt(vx * vx + vz * vz) > 0.01) { player.resetWASD(); return false; }
  this.nudgeT = (this.nudgeT || 0) + 1;
  if (d < 0.6 && this.nudgeT % 3 !== 1) { player.resetWASD(); return false; } // close: tap, 1 tick on / 2 off
  player.setOptimalKeysTo(target.x, target.y, target.z, true);
  return false;
};

Input.prototype.release = function () {
  if (this.jumpDown) player.setKey("jump", false);
  this.jumpDown = false;
  if (this.sneakIs) player.setSneaking(false);
  this.sneakIs = false;
  this.sneakWanted = null;
};

module.exports = { Input: Input };
