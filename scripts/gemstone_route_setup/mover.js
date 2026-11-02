/// <reference path="../polinex.d.ts" />
// Movement controller: walking (native planner), digging, Etherwarp for big climbs, optional Instant Transmission.
//
// goTo(goal) sets/changes the goal; tick() drives it and returns { s: "busy" | "arrived" | "fail", reason }.
// goal = { id, pos, supports?: Vec[], near?: number, arrive?: () => boolean, arriveRange?: number,
//          allowEther?: boolean, allowDig?: boolean, label?: string }
//
// Design rules (from the spec):
//  * a path is planned once and then followed; a slightly better path found later is ignored (no zig-zag)
//  * walking vs digging is decided by cost; switching dig -> walk later needs a clearly better walk (hysteresis)
//  * Etherwarp only for substantial upward movement
//  * the next goal can be prepared (prefetched) while walking the current one
//  * unknown terrain is never assumed empty

const U = require("./util.js");
const { Digger } = require("./digger.js");

const WALK_TICKS_PER_BLOCK = 4.6;

function Mover(ctx) {
  this.ctx = ctx;
  this.digger = new Digger(ctx);
  this.goal = null;
  this.next = null;
  this.prefetch = null;
  this.clearState();
}

Mover.prototype.clearState = function () {
  this.mode = "idle";
  this.query = null;
  this.cands = null;
  this.candIdx = 0;
  this.cand = null;
  this.walkFails = 0;
  this.retries = 0;
  this.lastMovePos = null;
  this.lastMoveAt = 0;
  this.digCheckAt = 0;
  this.digQuery = null;
  this.etherFailed = new Set();
  this.path = null;
  this.aotv = null;
  this.reason = "";
  this.hop = null;
  this.digTarget = null;
  this.digFinal = false;
  this.digExhausted = false;
  this.hopScan = null;
};

Mover.prototype.cancelQueries = function () {
  if (this.query) this.query.cancel();
  if (this.digQuery) this.digQuery.cancel();
  if (this.prefetch && this.prefetch.q) this.prefetch.q.cancel();
  this.query = null;
  this.digQuery = null;
  this.prefetch = null;
};

Mover.prototype.stop = function () {
  this.cancelQueries();
  try { nav.stop(); } catch (e) { /* idle */ }
  try { etherwarp.stop(); } catch (e) { /* idle */ }
  try { rotation.pathFindStopRotation(); } catch (e) { /* idle */ }
  this.digger.reset(null);
  player.resetWASD();
  this.goal = null;
  this.next = null;
  this.clearState();
};

Mover.prototype.setNext = function (goal) { this.next = goal; };

Mover.prototype.goTo = function (goal) {
  if (this.goal && this.goal.id === goal.id) return;
  const wasWalking = this.mode === "walk";
  const prefetch = this.prefetch;
  this.prefetch = null;
  if (this.query) this.query.cancel();
  if (this.digQuery) this.digQuery.cancel();
  this.digger.reset(null);
  this.goal = goal;
  this.clearState();
  this.ctx.detail = "Moving to " + (goal.label || U.fmt(goal.pos));

  // 1) a prefetched path for exactly this goal: continue without stopping
  if (prefetch && prefetch.goalId === goal.id && prefetch.q && prefetch.q.status() === "found") {
    const nodes = U.arr(prefetch.q.result());
    if (nodes.length && U.dist(player.pos(), U.v(nodes[0].x, nodes[0].y, nodes[0].z)) < 3 && nav.followPath(nodes)) {
      this.cand = prefetch.target;
      this.cands = [prefetch.target];
      this.path = nodes;
      this.enterWalk();
      return;
    }
  } else if (prefetch && prefetch.q) prefetch.q.cancel();

  // 2) already walking: retarget the live walk instead of stopping
  if (wasWalking) {
    const cands = this.candidates() || [];
    if (cands.length && !this.wantsEther(cands[0])) {
      try {
        if (nav.retarget(cands[0], { keepMoving: true })) {
          this.cand = cands[0];
          this.enterWalk();
          return;
        }
      } catch (e) { /* fall through to a fresh plan */ }
    }
    try { nav.stop(); } catch (e) { /* idle */ }
  }
  this.mode = "decide";
};

Mover.prototype.standablesNear = function (center, near, limit, dyRange) {
  const B = this.ctx.blocks;
  const p = U.floor(center);
  const out = [];
  const ry = dyRange === undefined ? near : dyRange;
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dx = -near; dx <= near; dx++) {
      for (let dz = -near; dz <= near; dz++) {
        const feet = U.v(p.x + dx, p.y + dy, p.z + dz);
        if (this.goal && this.goal.avoid && this.goal.avoid.has(U.key(U.up(feet, -1)))) continue;
        if (B.standable(feet) && !B.inCore(feet)) out.push({ s: U.up(feet, -1), d: U.dist(feet, p) });
      }
    }
  }
  out.sort((a, b) => a.d - b.d);
  return out.slice(0, limit || 6).map((o) => o.s);
};

// Support blocks we could stand on at the goal, closest to goal.pos first.
// For far or unloaded goals with goal.approach, returns "hop" spots on the way instead
// (always further along the same direction, so the walk never doubles back).
Mover.prototype.candidates = function () {
  const g = this.goal;
  if (this.cands) return this.cands;
  this.hop = null;
  if (g.supports && g.supports.length) { this.cands = g.supports.slice(); return this.cands; }
  if (g.tunnelOnly) { this.cands = []; return this.cands; } // dig straight toward the goal, no stand-spot search
  const near = g.near === undefined ? 3 : g.near;
  const target = U.floor(g.pos);
  const me = player.pos();

  // Flat goals (inspection): only X/Z matter, the full height is always loaded. Hop horizontally at our
  // own height, never climbing or digging down toward the target's Y.
  if (g.flat && U.distFlat(me, target) > 12) {
    // one hop distance per tick (each scan reads a few hundred blocks): no lag spike
    const dxz = U.distFlat(me, target);
    if (!this.hopScan) {
      this.hopScan = { i: 0, steps: [24, 12], dir: U.v((target.x - me.x) / dxz, 0, (target.z - me.z) / dxz), feetY: Math.floor(me.y), me: me };
    }
    const hs = this.hopScan;
    while (hs.i < hs.steps.length) {
      const step = hs.steps[hs.i++];
      if (step >= dxz) continue;
      const hop = U.floor(U.v(hs.me.x + hs.dir.x * step, hs.feetY, hs.me.z + hs.dir.z * step));
      if (!this.ctx.blocks.info(hop).loaded) continue;
      const c = this.standablesNear(hop, 3, 4, g.dyRange || 4);
      if (c.length) { this.hop = hop; this.cands = c; this.hopScan = null; return this.cands; }
      return null; // try the next distance next tick
    }
    this.hopScan = null;
    this.hop = U.floor(U.v(me.x + hs.dir.x * Math.min(dxz, 16), hs.feetY, me.z + hs.dir.z * Math.min(dxz, 16)));
    this.cands = [];
    return this.cands;
  }

  const far = U.dist(me, target) > 48;
  const loaded = this.ctx.blocks.info(target).loaded;
  if (g.approach && (far || !loaded)) {
    const d = U.dist(me, target);
    const dir = U.scale(U.sub(target, me), 1 / Math.max(1, d));
    const steps = [40, 28, 16];
    for (let i = 0; i < steps.length; i++) {
      if (steps[i] >= d) continue;
      const hop = U.floor(U.add(me, U.scale(dir, steps[i])));
      if (!this.ctx.blocks.info(hop).loaded) continue;
      const c = this.standablesNear(hop, 5, 4);
      if (c.length) { this.hop = hop; this.cands = c; return this.cands; }
    }
    if (far && loaded) { this.cands = this.standablesNear(target, near, 6); if (this.cands.length) return this.cands; }
    this.hop = U.floor(U.add(me, U.scale(dir, Math.min(d, 16))));
    this.cands = [];
    return this.cands;
  }
  this.cands = this.standablesNear(target, near, 6);
  if (!this.cands.length && near < 5) this.cands = this.standablesNear(target, 5, 6, 3);
  return this.cands;
};

// Etherwarp is NOT a way of walking around: only for a one-off long trip or a big climb, only on goals that
// opt in (allowEther === true: long travel, never building/inspection moves), one warp (no chains), with a cooldown.
Mover.prototype.wantsEther = function (support) {
  const g = this.goal;
  const cfg = this.ctx.cfg;
  if (g.allowEther !== true || g.flat) return false;
  if (this.etherFailed.has(U.key(support))) return false;
  if (U.now() - (this.ctx.lastEtherAt || 0) < cfg.etherCooldownSec() * 1000) return false;
  const rise = support.y + 1 - player.y();
  const far = U.dist(player.pos(), U.top(support));
  if (rise < cfg.etherMinRise() && far < cfg.etherMinDist()) return false;
  if (!skyblock.hasEtherwarp()) return false;
  try { return etherwarp.canReach(support.x, support.y, support.z); } catch (e) { return false; }
};

Mover.prototype.atCand = function () {
  if (!this.cand) return false;
  const range = (this.goal && this.goal.arriveRange) || 1.2;
  const top = U.top(this.cand);
  return U.distFlat(player.pos(), top) <= range && Math.abs(player.y() - top.y) < 1.1;
};

// Reached an intermediate hop: forget candidates and plan the next hop / the goal.
Mover.prototype.hopDone = function () {
  this.cands = null;
  this.candIdx = 0;
  this.cand = null;
  this.hop = null;
  this.walkFails = 0;
  this.digExhausted = false;
  this.mode = "decide";
  this.ctx.progress();
  return { s: "busy" };
};

Mover.prototype.arrived = function () {
  const g = this.goal;
  if (!g) return false;
  if (g.arrive) return !!g.arrive(); // precise goals: only the predicate counts (atCand -> settle)
  if (this.hop) return false;
  if (this.cand) {
    const range = g.arriveRange || 1.2;
    const top = U.top(this.cand);
    if (U.distFlat(player.pos(), top) <= range && Math.abs(player.y() - top.y) < 1.1) return true;
  }
  return false;
};

Mover.prototype.enterWalk = function () {
  this.mode = "walk";
  this.lastMovePos = player.pos();
  this.lastMoveAt = U.now();
};

// Estimated cost (in "blocks walked") of digging a straight 1x2 passage. Infinity when impossible.
Mover.prototype.digCost = function (fromFeet, toFeet) {
  const ctx = this.ctx;
  if (!ctx.cfg.allowDig() || (this.goal && this.goal.allowDig === false)) return Infinity;
  const len = U.dist(fromFeet, toFeet);
  if (len > ctx.cfg.maxDigLen()) return Infinity;
  let cells;
  try { cells = U.arr(world.blocksBetween(U.center(fromFeet), U.center(toFeet))); } catch (e) { return Infinity; }
  let solid = 0, breakTicks = 0;
  for (let i = 0; i < cells.length; i++) {
    const pair = [cells[i], U.up(cells[i], 1)];
    for (let j = 0; j < 2; j++) {
      const info = ctx.blocks.info(pair[j]);
      if (!info.loaded || info.liquid) return Infinity;
      if (info.passable) continue;
      if (ctx.blocks.mineBlockReason(pair[j])) return Infinity;
      if (ctx.blocks.inCore(pair[j])) return Infinity;
      solid++;
      if (solid <= 3) {
        let t = -1;
        try { t = mining.ticksLeft(U.floor(pair[j]), -1); } catch (e) { t = -1; }
        breakTicks += t > 0 ? t : ctx.cfg.breakTicks();
      }
    }
  }
  this.lastDigSolid = solid;
  const avg = solid ? (solid <= 3 ? breakTicks / solid : breakTicks / 3) : 0;
  return len + (solid * (avg + 6)) / WALK_TICKS_PER_BLOCK; // +6 ticks per block for aiming / swaps
};

Mover.prototype.pathLength = function (nodes) {
  let len = 0;
  let prev = player.pos();
  for (let i = 0; i < nodes.length; i++) {
    const p = U.v(nodes[i].x, nodes[i].y, nodes[i].z);
    len += U.dist(prev, p);
    prev = p;
  }
  return len;
};

// Where the digger should aim for a candidate: flat goals keep our own height.
Mover.prototype.digGoal = function (support) {
  const feet = U.up(support, 1);
  if (this.goal && this.goal.flat) return U.v(feet.x, Math.floor(player.y()), feet.z);
  return feet;
};

// A walking path planned on partly loaded terrain is often a detour: much longer than the straight line,
// or it starts by walking away from the real goal (and later has to come back). Mining straight is faster.
Mover.prototype.isDetour = function (nodes, walkLen) {
  const ctx = this.ctx;
  const me = player.pos();
  const end = nodes.length ? U.v(nodes[nodes.length - 1].x, nodes[nodes.length - 1].y, nodes[nodes.length - 1].z) : me;
  const straight = this.goal && this.goal.flat ? U.distFlat(me, end) : U.dist(me, end);
  // only a real detour counts (both much longer in ratio AND at least 8 blocks extra) and only when the straight
  // line actually needs mining (open cave: the planner walks around a gap for a reason, follow it)
  if ((this.lastDigSolid || 0) < 2) return false;
  if (walkLen > straight * ctx.cfg.directFactor() + 3 && walkLen - straight > 8) return true;
  const goal = this.goal ? this.goal.pos : end;
  const gx = goal.x - me.x, gz = goal.z - me.z;
  const gl = Math.sqrt(gx * gx + gz * gz);
  if (gl < 8) return false;
  // first ~6 blocks of the path
  let probe = null;
  for (let i = 0; i < nodes.length; i++) {
    const n = U.v(nodes[i].x, nodes[i].y, nodes[i].z);
    if (U.distFlat(me, n) >= 6) { probe = n; break; }
  }
  if (!probe) return false;
  const px = probe.x - me.x, pz = probe.z - me.z;
  const pl = Math.sqrt(px * px + pz * pz) || 1;
  return (px / pl) * (gx / gl) + (pz / pl) * (gz / gl) < -0.1; // heading away from the goal
};

Mover.prototype.pathCrossesCore = function (nodes) {
  for (let i = 0; i < nodes.length; i += 2) {
    if (this.ctx.blocks.inCore(U.v(nodes[i].x, nodes[i].y, nodes[i].z))) return true;
  }
  return false;
};

Mover.prototype.nextCandidate = function (reason) {
  this.reason = reason;
  this.ctx.log("Move: " + reason + " -> trying the next spot");
  this.candIdx++;
  this.cand = null;
  this.mode = "decide";
};

Mover.prototype.fail = function (reason) {
  const g = this.goal;
  try { nav.stop(); } catch (e) { /* idle */ }
  try { etherwarp.stop(); } catch (e) { /* idle */ }
  this.digger.reset(null);
  player.resetWASD();
  this.mode = "failed";
  this.reason = reason;
  return { s: "fail", reason: "cannot reach " + (g && (g.label || U.fmt(g.pos))) + ": " + reason };
};

Mover.prototype.tick = function () {
  const ctx = this.ctx;
  const g = this.goal;
  if (!g) return { s: "fail", reason: "no goal" };
  if (this.mode === "failed") return { s: "fail", reason: this.reason };
  if (this.mode === "done") return { s: "arrived" };
  if (this.arrived() && this.mode !== "aotv") {
    try { nav.stop(); } catch (e) { /* idle */ }
    this.digger.release();
    player.resetWASD();
    this.mode = "done";
    return { s: "arrived" };
  }
  if (this.hop && this.atCand() && this.mode !== "aotv") {
    try { nav.stop(); } catch (e) { /* idle */ }
    return this.hopDone();
  }
  // Precise goals (actions with an arrive predicate): walk the last block onto the exact support centre.
  if (g.arrive && this.cand && !this.hop && this.mode !== "settle" && this.mode !== "aotv" && this.atCand()) {
    try { nav.stop(); } catch (e) { /* idle */ }
    this.mode = "settle";
    this.settleAt = U.now();
  }

  switch (this.mode) {
    case "decide": return this.tickDecide();
    case "plan": return this.tickPlan();
    case "walk": return this.tickWalk();
    case "ether": return this.tickEther();
    case "dig": return this.tickDig();
    case "aotv": return this.tickAotv();
    case "settle": return this.tickSettle();
    default: this.mode = "decide"; return { s: "busy" };
  }
};

Mover.prototype.tickSettle = function () {
  const top = U.top(this.cand);
  if (this.ctx.input.nudge(top, 0.3) || U.now() - this.settleAt > 2500) {
    player.resetWASD();
    this.ctx.input.sneak(false);
    this.mode = "done"; // the caller re-checks whether it can act from here and relocates if not
    return { s: "arrived" };
  }
  return { s: "busy" };
};

Mover.prototype.tickDecide = function () {
  const ctx = this.ctx;
  const g = this.goal;
  const cands = this.candidates();
  if (cands === null) return { s: "busy" }; // still scanning (spread over ticks)
  if (this.candIdx >= cands.length) {
    // No (more) standable spot: dig toward the hop / the goal itself if allowed.
    if (ctx.cfg.allowDig() && g.allowDig !== false && !this.digExhausted) {
      const target = this.hop || g.digTarget || g.pos;
      this.cand = null;
      this.digTarget = U.floor(target);
      this.mode = "dig";
      this.digFinal = true;
      this.digExhausted = true; // only one last-resort dig per decision round
      return { s: "busy" };
    }
    return this.fail(this.reason || "no standable spot near the goal");
  }
  const c = cands[this.candIdx];
  this.cand = c;
  if (this.wantsEther(c)) { this.mode = "ether"; ctx.detail = "Etherwarp up to " + U.fmt(c); return { s: "busy" }; }
  this.query = nav.findPathAsync(null, c, { allowEtherwarp: false });
  this.mode = "plan";
  this.retries = 0;
  return { s: "busy" };
};

Mover.prototype.tickPlan = function () {
  const ctx = this.ctx;
  const g = this.goal;
  const c = this.cand;
  if (!this.query) { this.mode = "decide"; return { s: "busy" }; }
  if (!this.query.finished()) return { s: "busy" };
  const q = this.query;
  this.query = null;
  const status = q.status();
  const feetC = this.digGoal(c);
  const rise = U.up(c, 1).y - player.y();

  if (status === "found") {
    const nodes = U.arr(q.result());
    const walkLen = this.pathLength(nodes);
    const digEst = this.digCost(player.blockPos(), feetC);
    const crossesCore = this.pathCrossesCore(nodes);
    const detour = this.isDetour(nodes, walkLen);
    const slower = walkLen > digEst * ctx.cfg.digFactor() + 4;
    if (digEst < Infinity && ((ctx.cfg.preferDirect() && detour) || slower || crossesCore)) {
      this.digTarget = feetC;
      this.digFinal = false;
      this.mode = "dig";
      ctx.log("Mining straight (" + digEst.toFixed(0) + ") instead of walking (" + walkLen.toFixed(0) + ")" +
        (crossesCore ? " to avoid a structure core" : detour ? ": walking path is a detour" : ""));
      return { s: "busy" };
    }
    if (!nodes.length || !nav.followPath(nodes)) return this.nextCandidateBusy("walk rejected");
    this.path = nodes;
    this.enterWalk();
    return { s: "busy" };
  }

  if (status === "unavailable" || status === "error" || status === "stale") {
    if (++this.retries <= 3) {
      this.query = nav.findPathAsync(null, c, { allowEtherwarp: false });
      return { s: "busy" };
    }
  }
  // no walking path: a single Etherwarp if this goal allows it (never a chain of warps), else mine there
  if (this.wantsEther(c)) { this.mode = "ether"; return { s: "busy" }; }
  const digEst = this.digCost(player.blockPos(), feetC);
  if (digEst < Infinity) {
    this.digTarget = feetC;
    this.digFinal = false;
    this.mode = "dig";
    return { s: "busy" };
  }
  return this.nextCandidateBusy("no walking path (" + status + (q.error() ? ": " + q.error() : "") + ")");
};

Mover.prototype.nextCandidateBusy = function (reason) {
  this.nextCandidate(reason);
  return { s: "busy" };
};

Mover.prototype.tickWalk = function () {
  const ctx = this.ctx;
  if (nav.failed()) {
    if (++this.walkFails >= 2) return this.nextCandidateBusy("walker gave up twice");
    this.mode = "decide";
    return { s: "busy" };
  }
  if (nav.finished()) {
    if (++this.walkFails >= 3) return this.nextCandidateBusy("walk ended away from the goal");
    this.mode = "decide";
    return { s: "busy" };
  }
  // stuck detection
  const p = player.pos();
  if (U.dist(p, this.lastMovePos) > 1) { this.lastMovePos = p; this.lastMoveAt = U.now(); ctx.progress(); }
  else if (!nav.awaitingPath() && U.now() - this.lastMoveAt > 5000) {
    try { nav.stop(); } catch (e) { /* idle */ }
    if (++this.walkFails >= 2) {
      const feetC = this.digGoal(this.cand);
      if (this.digCost(player.blockPos(), feetC) < Infinity) { this.digTarget = feetC; this.digFinal = false; this.mode = "dig"; return { s: "busy" }; }
      return this.nextCandidateBusy("stuck while walking");
    }
    this.mode = "decide";
    return { s: "busy" };
  }

  // prepare the next leg while walking
  if (this.next && !this.prefetch && nav.remainingNodes() > 0 && nav.remainingNodes() < 10 && this.cand) {
    const nextTarget = this.next.supports && this.next.supports.length ? this.next.supports[0] : null;
    if (nextTarget) {
      this.prefetch = { goalId: this.next.id, target: nextTarget, q: nav.findPathAsync(this.cand, nextTarget, { allowEtherwarp: false }) };
    }
  }

  if (ctx.cfg.useAotv()) this.maybeAotv();
  return { s: "busy" };
};

// Long straight open walking segment ahead -> Instant Transmission along it.
Mover.prototype.maybeAotv = function () {
  const ctx = this.ctx;
  if (!this.path || this.path.length < 4 || !player.onGround()) return;
  if (this.aotvCooldown && U.now() < this.aotvCooldown) return;
  const slot = player.aoteSlot();
  if (slot < 0) return;
  const p = player.pos();
  let idx = 0, best = Infinity;
  for (let i = 0; i < this.path.length; i++) {
    const d = U.dist(p, U.v(this.path[i].x, this.path[i].y, this.path[i].z));
    if (d < best) { best = d; idx = i; }
  }
  const start = U.v(this.path[idx].x, this.path[idx].y, this.path[idx].z);
  let far = -1;
  for (let j = idx + 1; j < this.path.length; j++) {
    const n = this.path[j];
    if (n.type !== "WALK" || Math.abs(n.y - start.y) > 0.6) break;
    // every node between must stay near the straight line
    const ok = this.straightBetween(idx, j);
    if (!ok) break;
    far = j;
  }
  if (far < 0) return;
  const end = U.v(this.path[far].x, this.path[far].y, this.path[far].z);
  const d = U.dist(start, end);
  if (d < ctx.cfg.aotvMinDist()) return;
  const eye = world.eyePos();
  const aim = U.v(end.x, eye.y, end.z);
  const hit = world.raytraceFrom(eye, aim);
  if (hit.type !== "MISS" && U.dist(U.v(hit.x, hit.y, hit.z), eye) < d - 1) return;
  try { nav.stop(); } catch (e) { /* idle */ }
  this.aotv = { slot: slot, aim: aim, phase: "aim", at: U.now() };
  rotation.pathFindRotateToVec(aim.x, aim.y, aim.z);
  this.mode = "aotv";
};

Mover.prototype.straightBetween = function (a, b) {
  const A = this.path[a], B = this.path[b];
  const dx = B.x - A.x, dz = B.z - A.z;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  for (let i = a + 1; i < b; i++) {
    const n = this.path[i];
    const cross = Math.abs((n.x - A.x) * dz - (n.z - A.z) * dx) / len;
    if (cross > 0.7) return false;
  }
  return true;
};

Mover.prototype.tickAotv = function () {
  const a = this.aotv;
  if (!a) { this.mode = "decide"; return { s: "busy" }; }
  if (a.phase === "aim") {
    if (!rotation.pathFindIsDone() && U.now() - a.at < 1200) return { s: "busy" };
    if (!player.setHeldItemSlot(a.slot)) return { s: "busy" };
    player.rightClick();
    a.phase = "after";
    a.at = U.now();
    return { s: "busy" };
  }
  if (U.now() - a.at < 350) return { s: "busy" };
  this.aotv = null;
  this.aotvCooldown = U.now() + 4000;
  this.ctx.progress();
  this.mode = "decide"; // replan from the new position
  this.candIdx = 0;
  return { s: "busy" };
};

Mover.prototype.tickEther = function () {
  const ctx = this.ctx;
  const c = this.cand;
  let done = false;
  try {
    // directTo = exactly one warp, no route fallback (etherwarpTo/pathfindTo may chain several warps)
    done = etherwarp.directTo(c.x, c.y, c.z);
  } catch (e) {
    ctx.warn("Etherwarp call rejected: " + e);
    done = false;
    this.etherFailed.add(U.key(c));
    etherwarp.stop();
    this.mode = "decide";
    return { s: "busy" };
  }
  if (done) {
    etherwarp.stop();
    ctx.lastEtherAt = U.now();
    ctx.log("Etherwarped to " + U.fmt(c));
    ctx.progress();
    if (this.arrived()) { this.mode = "done"; return { s: "arrived" }; }
    this.mode = "decide";
    return { s: "busy" };
  }
  if (etherwarp.failed()) {
    etherwarp.stop();
    this.etherFailed.add(U.key(c));
    ctx.log("Etherwarp to " + U.fmt(c) + " failed, falling back to walking/digging");
    this.query = nav.findPathAsync(null, c, { allowEtherwarp: false });
    this.mode = "plan";
    return { s: "busy" };
  }
  return { s: "busy" };
};

Mover.prototype.tickDig = function () {
  const ctx = this.ctx;
  const g = this.goal;
  const arriveFn = () => this.arrived();
  const r = this.digger.tick(this.digTarget, arriveFn, !!g.flat); // flat goals never dig up or down
  if (r.s === "arrived") {
    if (this.arrived()) { this.mode = "done"; return { s: "arrived" }; }
    if (this.hop) { this.digExhausted = false; return this.hopDone(); }
    if (this.digFinal) { this.mode = "done"; return { s: "arrived" }; }
    this.mode = "decide";
    return { s: "busy" };
  }
  if (r.s === "fail") {
    if (this.digFinal) return this.fail(r.reason);
    return this.nextCandidateBusy("digging failed: " + r.reason);
  }

  // Once tunnelling, finish the tunnel: switching to the planner halfway made it leave mining mode and walk
  // somewhere else. (The planner is only consulted again when the tunnel fails.)
  return { s: "busy" };
};

module.exports = { Mover: Mover };
