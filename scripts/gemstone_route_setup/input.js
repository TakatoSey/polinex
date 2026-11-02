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

Input.prototype.release = function () {
  if (this.jumpDown) player.setKey("jump", false);
  this.jumpDown = false;
  if (this.sneakIs) player.setSneaking(false);
  this.sneakIs = false;
  this.sneakWanted = null;
};

module.exports = { Input: Input };
