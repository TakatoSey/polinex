/// <reference path="../polinex.d.ts" />
// World classification: what a block is, whether we may mine it, and which areas are off-limits.
// Unknown (unloaded) terrain is never treated as air.

const U = require("./util.js");

const ALWAYS_PROTECTED = /(^|:)(bedrock|barrier|command_block|structure_block|light|end_portal_frame|chest|trapped_chest|ender_chest|spawner|player_head|player_wall_head)$/;
const GEM = /stained_glass/; // gemstone blocks and gemstone panes
const LIQUID = /(^|:)(water|lava|bubble_column)$/;
const AIR = /(^|:)(air|cave_air|void_air)$/;
const CORE_STRUCTURES = /goblin.?queen|queen'?s.?den|jungle.?temple/i;

function Blocks(ctx) {
  this.ctx = ctx;
  this.blacklist = new Map();   // key -> reason (blocks that refused to break this lobby)
  this.ourCobble = new Set();   // keys of support blocks this script placed
  this.patternSrc = null;
  this.patterns = [];
  this.structCache = null;
  this.structCacheAt = 0;
}

Blocks.prototype.resetLobby = function () {
  this.blacklist.clear();
  this.ourCobble.clear();
  this.structCache = null;
};

Blocks.prototype.compilePatterns = function () {
  const src = this.ctx.cfg.breakable();
  if (src === this.patternSrc) return;
  this.patternSrc = src;
  this.patterns = src.split(",").map((t) => t.trim().toLowerCase().replace(/^minecraft:/, "")).filter((t) => t.length > 0)
    .map((t) => new RegExp("^" + t.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
};

// Returns { loaded, id, air, liquid, gem, passable, solid }.
// Blocks you walk through (no collision). Everything else that is not air/liquid counts as solid.
const PASSABLE = /(^|:)(air|cave_air|void_air|short_grass|tall_grass|grass|fern|large_fern|dead_bush|vine|glow_lichen|hanging_roots|torch|wall_torch|redstone_torch|redstone_wall_torch|soul_torch|soul_wall_torch|snow|rail|powered_rail|detector_rail|activator_rail|lever|tripwire|tripwire_hook|light|structure_void|.*_sapling|.*_button|.*_pressure_plate|.*_sign|.*_wall_sign|.*_banner|.*_wall_banner|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|brown_mushroom|red_mushroom|sweet_berry_bush|seagrass|tall_seagrass|kelp|kelp_plant|nether_sprouts|crimson_roots|warped_roots)$/;

// One host call per block (blockState), classified by id, cached for the current tick: the same block is
// read many times per tick by the different planners, and each host call is expensive (this was the lag).
Blocks.prototype.info = function (p) {
  const k = Math.floor(p.x) + "," + Math.floor(p.y) + "," + Math.floor(p.z);
  const tick = this.ctx.tickNo || 0;
  if (this.cacheTick !== tick) { this.cache = new Map(); this.cacheTick = tick; }
  const hit = this.cache.get(k);
  if (hit) return hit;
  let st = null;
  try { st = world.blockState(U.floor(p)); } catch (e) { st = null; }
  let r;
  if (!st) r = { loaded: false, id: "", air: false, liquid: false, gem: false, passable: false, solid: false };
  else {
    const id = String(st.id);
    const air = AIR.test(id);
    const liquid = LIQUID.test(id);
    const passable = air || (!liquid && PASSABLE.test(id));
    r = { loaded: true, id: id, air: air, liquid: liquid, gem: GEM.test(id), passable: passable, solid: !passable && !liquid };
  }
  this.cache.set(k, r);
  return r;
};

// Forget cached reads (after we changed a block ourselves this tick).
Blocks.prototype.invalidate = function () { this.cacheTick = -1; };

Blocks.prototype.isCobble = function (id) { return /(^|:)cobblestone$/.test(id); };

// Can we stand with feet at `feet`? (solid support, two passable cells, no liquid)
Blocks.prototype.standable = function (feet) {
  const below = this.info(U.up(feet, -1));
  if (!below.loaded || !below.solid) return false;
  const a = this.info(feet), b = this.info(U.up(feet, 1));
  return a.loaded && b.loaded && a.passable && b.passable;
};

// Why may this block NOT be mined? null = it may be mined.
Blocks.prototype.mineBlockReason = function (p, opts) {
  const i = this.info(p);
  if (!i.loaded) return "unknown terrain (not loaded)";
  if (i.air) return null;
  if (i.liquid) return "liquid";
  if (this.ctx.inNucleus) return "Crystal Nucleus (nothing can be mined there)";
  const id = i.id.toLowerCase();
  if (ALWAYS_PROTECTED.test(id)) return "unbreakable " + id;
  const bl = this.blacklist.get(U.key(p));
  if (bl) return "blacklisted: " + bl;
  // gems are just blocks when building a route (they regrow); only protected if the user turns that on
  if (i.gem && this.ctx.cfg.protectGems() && !(opts && opts.allowGem)) return "protected gemstone " + id;
  if (this.isCobble(id) && !this.ourCobble.has(U.key(p))) return "foreign cobblestone (someone's route)";
  // our own placed blocks (waypoints, blocks under them, support) are never mined by movement/tunnelling;
  // only the support cleanup and line clearing remove them, explicitly
  if (this.isCobble(id) && !(opts && opts.allowOurCobble)) return "our placed cobblestone";
  if (this.inCore(p)) return "inside a structure core";
  if (this.isCobble(id)) return null;
  this.compilePatterns();
  const bare = id.replace(/^minecraft:/, "");
  for (let k = 0; k < this.patterns.length; k++) if (this.patterns[k].test(bare)) return null;
  if (i.gem && opts && opts.allowGem) return null;
  return this.ctx.cfg.mineUnknown() ? null : "not in breakable list: " + bare;
};

Blocks.prototype.hasLiquidNeighbour = function (p) {
  for (let k = 0; k < U.DIRS6.length; k++) {
    const n = this.info(U.add(p, U.DIRS6[k]));
    if (n.liquid) return true;
  }
  return false;
};

Blocks.prototype.structures = function () {
  if (this.structCache && U.now() - this.structCacheAt < 2000) return this.structCache;
  let list = [];
  try { list = U.arr(skyblock.chStructures()); } catch (e) { list = []; }
  this.structCache = list.map((s) => ({
    name: String(s.name), pos: { x: s.x, y: s.y, z: s.z },
    bounds: s.bounds ? Array.from(s.bounds) : null,
    core: CORE_STRUCTURES.test(String(s.name)),
  }));
  this.structCacheAt = U.now();
  return this.structCache;
};

Blocks.prototype.inCore = function (p) {
  const r = this.ctx.cfg.avoidRadius();
  if (r <= 0) return false;
  const list = this.structures();
  for (let k = 0; k < list.length; k++) {
    if (list[k].core && U.dist(U.center(p), list[k].pos) <= r) return true;
  }
  return false;
};

// Is the point inside a native no-bomb zone? Returns the structure name or null.
Blocks.prototype.noBombZone = function (p) {
  const list = this.structures();
  for (let k = 0; k < list.length; k++) {
    if (list[k].bounds && U.inBox(p, list[k].bounds)) return list[k].name;
    if (list[k].core && this.inCore(p)) return list[k].name;
  }
  return null;
};

// Feet positions near `target` from which a ray from the eye reaches `aimPoint` (or the block itself).
// Small, bounded search; results sorted by distance from the player.
// pred(eye, feet) optionally replaces the line-of-sight test (e.g. "a support face is clickable from here").
Blocks.prototype.standSpotsFor = function (target, aimPoint, reach, maxResults, pred) {
  const out = [];
  const t = U.floor(target);
  const me = player.pos();
  const R = Math.ceil(reach);
  for (let dy = -R; dy <= 2; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const feet = U.v(t.x + dx, t.y + dy, t.z + dz);
        const eye = U.v(feet.x + 0.5, feet.y + 1.54, feet.z + 0.5);
        if (U.dist(eye, aimPoint) > reach) continue;
        if (U.same(feet, t) || U.same(U.up(feet, 1), t)) continue;
        if (!this.standable(feet)) continue;
        out.push({ feet: feet, eye: eye, d: U.dist(me, U.center(feet)) });
      }
    }
  }
  out.sort((a, b) => a.d - b.d);
  const res = [];
  for (let k = 0; k < out.length && k < 60 && res.length < (maxResults || 4); k++) {
    let ok;
    if (pred) ok = pred(out[k].eye, out[k].feet);
    else {
      const hit = world.raytraceFrom(out[k].eye, aimPoint);
      ok = hit.type === "MISS" || (hit.block && U.same(U.floor(hit.block), t)) || U.dist(U.v(hit.x, hit.y, hit.z), aimPoint) < 0.15;
    }
    if (ok) res.push(out[k].feet);
  }
  return res;
};

module.exports = { Blocks: Blocks, GEM: GEM };
