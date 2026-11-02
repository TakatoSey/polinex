/// <reference path="../polinex.d.ts" />
// Hotbar/material helpers: find an item by name, pull it into the hotbar if it only sits in the inventory.

function Items(ctx) {
  this.ctx = ctx;
  this.moving = null; // { name, startedAt, done, ok }
}

Items.prototype.count = function (name) {
  try { return player.itemCount(name); } catch (e) { return 0; }
};

// Returns { s: "ok", slot } | { s: "busy" } | { s: "fail", reason }
Items.prototype.ensureHotbar = function (name) {
  const slot = player.itemByName(name);
  if (slot >= 0) { this.moving = null; return { s: "ok", slot: slot }; }

  if (this.moving && this.moving.name === name) {
    if (!this.moving.done) {
      if (Date.now() - this.moving.startedAt > 8000) { this.moving = null; return { s: "fail", reason: "moving " + name + " to the hotbar timed out" }; }
      return { s: "busy" };
    }
    const ok = this.moving.ok;
    this.moving = null;
    if (!ok) return { s: "fail", reason: "could not move " + name + " to the hotbar (close any open screen)" };
    return { s: "busy" }; // re-read the slot next tick
  }

  if (player.isGuiOpen()) return { s: "fail", reason: "a screen is open; cannot move " + name + " to the hotbar" };
  const items = Array.from(inventory.items());
  const lower = name.toLowerCase();
  let from = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].slot >= 9 && String(items[i].name).toLowerCase().indexOf(lower) >= 0) { from = items[i].slot; break; }
  }
  if (from < 0) return { s: "fail", reason: "no " + name + " in the inventory" };

  const target = this.ctx.cfg.materialSlot();
  if (target === mining.drillSlot() || target === player.etherwarpSlot()) {
    return { s: "fail", reason: "Material Hotbar Slot " + (target + 1) + " holds your drill/etherwarp item; pick another slot" };
  }
  const job = { name: name, startedAt: Date.now(), done: false, ok: false };
  this.moving = job;
  inventory.moveToHotbar(from, target, (ok) => { job.done = true; job.ok = !!ok; });
  return { s: "busy" };
};

module.exports = { Items: Items };
