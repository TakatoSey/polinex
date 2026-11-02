/// <reference path="../polinex.d.ts" />
// Builds every warp of the active runtime route:
//   spot   - cobblestone at the waypoint (+ bridge from the nearest wall/floor if it floats), 2 free blocks above
//   bomb   - Bob-omb on the waypoint (cobble first, then bomb), skipped in no-bomb zones / notBombable
//   respot - re-check the cobble after the blast
//   line   - clear the Etherwarp line to the next warp (rays + Route Status re-checks)
// tick(st) -> { s: "busy" } | { s: "done" } | { s: "fail", reason }

const U = require("./util.js");
const S = require("./status.js");

const STEPS = ["spot", "bomb", "respot", "line"];

function Builder(ctx) {
  this.ctx = ctx;
  this.prog = new Map(); // warp key -> { bombed, fails, blocked, issues }
  this.queue = [];
  this.cur = null;
  this.act = null;
  this.lastChangeAt = 0;
}

Builder.prototype.reset = function () {
  this.release();
  this.prog.clear();
  this.queue = [];
  this.cur = null;
};

Builder.prototype.release = function () {
  this.act = null;
  this.ctx.miner.release();
  this.ctx.placer.release();
  this.ctx.bomber.release();
};

Builder.prototype.cobPos = function (w) { return U.v(w.x, w.y + this.ctx.cfg.yOffset(), w.z); };

Builder.prototype.progFor = function (w) {
  const k = U.key(w.pos);
  let p = this.prog.get(k);
  if (!p) { p = { bombed: false, fails: 0, blocked: null, issues: [], done: false }; this.prog.set(k, p); }
  return p;
};

// Queue warps in route order, starting at the one closest to the player (or only `numbers`).
Builder.prototype.start = function (st, numbers) {
  const warps = st.warps;
  let order = warps.map((w) => w.number);
  if (warps.length) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < warps.length; i++) {
      const d = U.dist(player.pos(), warps[i].pos);
      if (d < bestD) { bestD = d; best = i; }
    }
    order = order.slice(best).concat(order.slice(0, best));
  }
  if (numbers) order = order.filter((n) => numbers.indexOf(n) >= 0);
  order.forEach((n) => {
    const w = warps.find((x) => x.number === n);
    if (w) { const p = this.progFor(w); p.done = false; p.fails = 0; p.blocked = null; }
  });
  this.queue = order;
  this.cur = null;
};

// Called by the stage stuck-check: count it as a failure of the current warp, skip it after 3.
Builder.prototype.noteStuck = function (st, why) {
  this.release();
  if (!this.cur || !st) return;
  const w = st.warps.find((x) => x.number === this.cur.number);
  if (!w) return;
  const p = this.progFor(w);
  p.fails++;
  p.issues.push("stuck: " + why);
  if (p.fails >= 3) {
    p.blocked = "stuck: " + why;
    this.queue.shift();
    this.cur = null;
  }
};

Builder.prototype.blockedSummary = function () {
  const out = [];
  this.prog.forEach((p, k) => { if (p.blocked) out.push(k + ": " + p.blocked); });
  return out;
};

// Warps that cannot be fixed by retrying (protected gem, foreign cobble, nothing to stand on...).
Builder.prototype.isFatal = function (w) {
  const p = this.prog.get(U.key(w.pos));
  return !!(p && p.blocked && p.fatal);
};

// ---------- material estimate ----------
Builder.prototype.needs = function (st) {
  const B = this.ctx.blocks;
  let cobble = 0, bombs = 0;
  st.warps.forEach((w) => {
    const cob = this.cobPos(w);
    const info = B.info(cob);
    if (!info.loaded || !B.isCobble(info.id)) cobble += 1;
    if (info.loaded && info.passable && !this.hasSolidNeighbour(cob)) cobble += this.ctx.cfg.maxBridge();
    const p = this.progFor(w);
    if (!p.bombed && w.problems.indexOf("notBombable") < 0 && !B.noBombZone(cob)) bombs += 1;
  });
  return { cobble: cobble, bombs: bombs };
};

// ---------- main tick ----------
Builder.prototype.tick = function (st) {
  const ctx = this.ctx;
  if (!this.cur) {
    if (!this.queue.length) return { s: "done" };
    this.cur = { number: this.queue[0], step: 0 };
    this.release();
  }
  const w = st.warps.find((x) => x.number === this.cur.number);
  if (!w) { this.queue.shift(); this.cur = null; return { s: "busy" }; }
  const idx = st.warps.indexOf(w);
  const next = st.warps.length > 1 ? st.warps[(idx + 1) % st.warps.length] : null;
  const p = this.progFor(w);
  const stepName = STEPS[this.cur.step];
  ctx.progressText = "Warp #" + w.number + " (" + (st.warps.length - this.queue.length + 1) + "/" + st.warps.length + ") - " + stepName;

  let r;
  if (stepName === "spot" || stepName === "respot") r = this.ensureSpot(w);
  else if (stepName === "bomb") r = this.bombStep(w, p);
  else r = this.clearLine(w, next);

  if (r.s === "busy") return r;
  if (r.s === "done") {
    this.release();
    this.cur.step++;
    if (this.cur.step >= STEPS.length) {
      p.done = true;
      this.queue.shift();
      this.cur = null;
      ctx.progress();
    }
    return { s: "busy" };
  }
  // failure of this step
  this.release();
  ctx.mover.stop();
  p.fails++;
  p.issues.push(r.reason);
  ctx.setIssue("Warp #" + w.number + ": " + r.reason);
  if (r.fatal || p.fails >= 3) {
    p.blocked = r.reason;
    p.fatal = !!r.fatal;
    ctx.warn("Skipping warp #" + w.number + " for now: " + r.reason);
    this.queue.shift();
    this.cur = null;
  }
  return { s: "busy" };
};

// ---------- spot ----------
Builder.prototype.hasSolidNeighbour = function (cell) {
  for (let k = 0; k < U.DIRS6.length; k++) {
    const n = this.ctx.blocks.info(U.add(cell, U.DIRS6[k]));
    if (n.loaded && n.solid && !n.liquid) return true;
  }
  return false;
};

Builder.prototype.ensureSpot = function (w) {
  const ctx = this.ctx;
  const B = ctx.blocks;
  const cob = this.cobPos(w);
  const info = B.info(cob);
  if (!info.loaded) return this.travel(cob, "warp #" + w.number);

  if (B.isCobble(info.id)) {
    for (let h = 1; h <= 2; h++) {
      const cell = U.up(cob, h);
      const hi = B.info(cell);
      if (hi.passable) continue;
      if (hi.gem) return { s: "fail", reason: "gemstone in the landing space above warp #" + w.number, fatal: true };
      ctx.detail = "Clearing landing space above #" + w.number;
      return this.action("mine", cell);
    }
    return { s: "done" };
  }
  if (!info.passable) {
    if (info.gem) return { s: "fail", reason: "gemstone occupies the waypoint block of #" + w.number, fatal: true };
    ctx.detail = "Mining " + info.id + " at waypoint #" + w.number;
    return this.action("mine", cob);
  }
  if (this.hasSolidNeighbour(cob)) {
    ctx.detail = "Placing support at #" + w.number;
    return this.action("place", cob);
  }
  const chain = this.bridgeChain(w, cob);
  if (!chain) {
    return { s: "fail", fatal: true, reason: "waypoint #" + w.number + " " + U.fmt(cob) + " floats with no wall/floor within " +
      ctx.cfg.maxBridge() + " blocks. Manual step: place one block next to it, then restart." };
  }
  for (let i = 0; i < chain.length; i++) {
    if (!B.isCobble(B.info(chain[i]).id)) {
      ctx.detail = "Building support bridge to #" + w.number + " (" + (i + 1) + "/" + chain.length + ")";
      return this.action("place", chain[i]);
    }
  }
  return { s: "busy" }; // chain complete, the waypoint itself is placed next tick
};

// Shortest chain of air cells from a wall/floor to the waypoint that avoids landing space and route lines.
Builder.prototype.bridgeChain = function (w, cob) {
  const ctx = this.ctx;
  const B = ctx.blocks;
  const st = ctx.lastStatus;
  const avoid = new Set([U.key(U.up(cob, 1)), U.key(U.up(cob, 2))]);
  if (st) {
    const i = st.warps.indexOf(st.warps.find((x) => x.number === w.number));
    const n = st.warps.length;
    const prev = n > 1 ? st.warps[(i - 1 + n) % n] : null;
    const next = n > 1 ? st.warps[(i + 1) % n] : null;
    [[prev, w], [w, next]].forEach((pair) => {
      if (!pair[0] || !pair[1]) return;
      const a = U.eyesOn(this.cobPos(pair[0]))[0], b = U.top(this.cobPos(pair[1]));
      try { U.arr(world.blocksBetween(a, b)).forEach((c) => avoid.add(U.key(c))); } catch (e) { /* ignore */ }
    });
  }
  const maxDepth = ctx.cfg.maxBridge();
  const start = { cell: cob, parent: null, depth: 0 };
  const seen = new Set([U.key(cob)]);
  let frontier = [start];
  while (frontier.length) {
    const nextF = [];
    for (let f = 0; f < frontier.length; f++) {
      const node = frontier[f];
      for (let k = 0; k < U.DIRS6.length; k++) {
        const c = U.add(node.cell, U.DIRS6[k]);
        const kk = U.key(c);
        if (seen.has(kk) || avoid.has(kk)) continue;
        seen.add(kk);
        const ci = B.info(c);
        if (!ci.loaded || !ci.passable || ci.liquid) continue;
        const nn = { cell: c, parent: node, depth: node.depth + 1 };
        if (this.hasSolidNeighbour(c)) {
          const chain = [];
          for (let q = nn; q && q.parent; q = q.parent) chain.push(q.cell); // wall end first ... next to waypoint last
          return chain;
        }
        if (nn.depth < maxDepth) nextF.push(nn);
      }
    }
    frontier = nextF;
  }
  return null;
};

// ---------- bomb ----------
Builder.prototype.bombStep = function (w, p) {
  const ctx = this.ctx;
  if (!ctx.cfg.useBombs() || p.bombed) return { s: "done" };
  if (w.problems.indexOf("notBombable") >= 0) return { s: "done" };
  const cob = this.cobPos(w);
  if (ctx.blocks.noBombZone(cob)) return { s: "done" };
  if (ctx.items.count(ctx.cfg.bombItem()) <= 0) {
    if (ctx.cfg.requireBombs()) return { s: "fail", fatal: true, reason: "out of " + ctx.cfg.bombItem() };
    return { s: "done" };
  }
  ctx.detail = "Bob-omb on warp #" + w.number;
  const r = this.action("bomb", cob, U.top(cob));
  if (r.s === "done") { p.bombed = true; this.lastChangeAt = U.now(); }
  return r;
};

// ---------- line ----------
Builder.prototype.lineObstruction = function (from, to, wide) {
  const eyes = U.eyesOn(from);
  const t = U.top(to);
  const aims = [U.v(t.x, t.y - 0.02, t.z), U.center(to)];
  if (wide) {
    [[0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]].forEach((o) => aims.push(U.v(t.x + o[0], t.y - 0.02, t.z + o[1])));
  }
  let best = null;
  for (let e = 0; e < eyes.length; e++) {
    for (let a = 0; a < aims.length; a++) {
      const hit = world.raytraceFrom(eyes[e], aims[a]);
      if (hit.type !== "BLOCK" || !hit.block) continue;
      const b = U.floor(hit.block);
      if (U.same(b, to) || U.same(b, from)) continue;
      const d = U.dist(eyes[e], U.center(b));
      if (!best || d < best.d) best = { block: b, d: d };
    }
    if (best && !wide) return best;
  }
  return best;
};

Builder.prototype.clearLine = function (w, next) {
  const ctx = this.ctx;
  if (!next) return { s: "done" };
  const from = this.cobPos(w), to = this.cobPos(next);
  const B = ctx.blocks;
  if (!B.info(from).loaded) return this.travel(from, "warp #" + w.number);
  if (!B.info(to).loaded) return this.travel(to, "warp #" + next.number);

  const statusSays = S.has(w, ["lineBlocked", "lineToMine"]);
  let obs = this.lineObstruction(from, to, false);
  if (!obs) {
    if (!statusSays) { this.lineWaitStart = 0; return { s: "done" }; }
    if (U.now() - this.lastChangeAt < 3000) return { s: "busy" }; // let Route Status catch up
    obs = this.lineObstruction(from, to, true);
    if (!obs) {
      if (!this.lineWaitStart) this.lineWaitStart = U.now();
      if (U.now() - this.lineWaitStart < 10000) return { s: "busy" };
      this.lineWaitStart = 0;
      return { s: "fail", fatal: true, reason: "Route Status reports line #" + w.number + " -> #" + next.number +
        " blocked, but no obstruction is visible to the rays. Manual step: look along the line and clear what Polinex highlights." };
    }
  }
  this.lineWaitStart = 0;
  const allowGem = ctx.cfg.mineGemsOnLine();
  const why = B.mineBlockReason(obs.block, { allowGem: allowGem });
  if (why) return { s: "fail", fatal: true, reason: "line #" + w.number + " -> #" + next.number + " blocked by " + why };
  ctx.detail = "Clearing line #" + w.number + " -> #" + next.number + " at " + U.fmt(obs.block);
  return this.action("mine", obs.block, null, {
    allowGem: allowGem,
    prefer: [from],
    fallbackBomb: ctx.cfg.useBombs() && ctx.cfg.bombLines(),
    bombFrom: from,
  });
};

// ---------- generic travel ----------
Builder.prototype.travel = function (pos, label) {
  const ctx = this.ctx;
  const goal = {
    id: "travel:" + U.key(pos), pos: pos, near: 4, approach: true, label: label,
    arrive: () => ctx.blocks.info(pos).loaded && U.dist(player.pos(), pos) < 24,
  };
  ctx.mover.goTo(goal);
  const r = ctx.mover.tick();
  if (r.s === "fail") return { s: "fail", reason: r.reason };
  return { s: "busy" };
};

// ---------- generic action (mine / place / bomb), with relocation ----------
Builder.prototype.canActFromHere = function (kind, cell, aim) {
  const ctx = this.ctx;
  const eye = world.eyePos();
  if (kind === "mine") return U.dist(eye, U.center(cell)) <= ctx.cfg.reach() && !!mining.visiblePoint(cell);
  if (kind === "place") {
    const feet = player.blockPos();
    if (U.same(feet, cell) || U.same(U.up(feet, 1), cell)) return false;
    return !!ctx.placer.faceFor(cell, eye);
  }
  const d = U.dist(eye, aim);
  if (d > 9 || d < 2.5) return false;
  const hit = world.raytraceFrom(eye, aim);
  return hit.type === "MISS" || U.dist(U.v(hit.x, hit.y, hit.z), aim) < 1.5;
};

Builder.prototype.standSupports = function (kind, cell, aim, opts) {
  const ctx = this.ctx;
  const out = [];
  if (opts && opts.prefer) opts.prefer.forEach((s) => out.push(s));
  if (kind === "mine") {
    let best = null;
    try { best = mining.bestStandSpot(cell); } catch (e) { best = null; }
    if (best) out.push(U.up(U.floor(best), -1));
  }
  const reach = kind === "bomb" ? 6 : ctx.cfg.reach() - 0.7; // margin for imprecise arrival
  ctx.blocks.standSpotsFor(cell, aim || U.center(cell), reach, 4).forEach((f) => {
    if (kind === "bomb" && U.dist(U.center(f), aim) < 2.5) return;
    out.push(U.up(f, -1));
  });
  const seen = new Set();
  return out.filter((s) => { const k = U.key(s); if (seen.has(k)) return false; seen.add(k); return true; });
};

Builder.prototype.action = function (kind, cell, aim, opts) {
  const ctx = this.ctx;
  const c = U.floor(cell);
  const k = kind + ":" + U.key(c);
  if (!this.act || this.act.key !== k) {
    this.release();
    this.act = { key: k, kind: kind, cell: c, aim: aim || U.center(c), opts: opts || {}, phase: "try", moves: 0, pre: null,
      pillar: kind === "place" && ctx.placer.canPillar(c), pmoves: 0, pillarMove: false };
  }
  const a = this.act;

  if (a.phase === "move") {
    const r = ctx.mover.tick();
    if (r.s === "busy") return r;
    if (r.s === "arrived") { ctx.mover.stop(); a.phase = "try"; a.pillarMove = false; return { s: "busy" }; }
    if (a.pillarMove) { // cannot get onto the pillar spot: try a normal placement instead
      ctx.mover.stop();
      a.pillar = false;
      a.pillarMove = false;
      a.phase = "try";
      return { s: "busy" };
    }
    // could not get anywhere useful
    return this.bombFallback(a) || { s: "fail", reason: r.reason };
  }

  // an occluding block must go first
  if (a.pre) {
    const r = ctx.miner.tick(a.pre);
    if (r.s === "busy") return r;
    if (r.s === "done") { a.pre = null; this.lastChangeAt = U.now(); return { s: "busy" }; }
    a.pre = null;
    return this.relocate(a, r.reason);
  }

  // Pillar placement (columns / blocks on a floor): stand in the cell, jump, place under ourselves.
  if (kind === "place" && a.pillar) {
    if (player.onGround() && !U.same(player.blockPos(), c)) {
      if (++a.pmoves > 3) { a.pillar = false; return { s: "busy" }; }
      ctx.mover.stop();
      ctx.mover.goTo({
        id: "pillar:" + U.key(c) + ":" + a.pmoves, pos: c, supports: [U.up(c, -1)], near: 2, allowEther: false,
        label: "pillar spot " + U.fmt(c),
        arrive: () => U.same(player.blockPos(), c) && U.distFlat(player.pos(), U.center(c)) < 0.35,
      });
      a.pillarMove = true;
      a.phase = "move";
      return { s: "busy" };
    }
    const pr = ctx.placer.pillarTick(c);
    if (pr.s === "done") { this.act = null; this.lastChangeAt = U.now(); return { s: "done" }; }
    if (pr.s === "fail") { ctx.log("Pillar placement failed (" + pr.reason + "), trying a normal placement"); a.pillar = false; }
    return { s: "busy" };
  }

  let r;
  if (kind === "mine") r = ctx.miner.tick(c, a.opts);
  else if (kind === "place") r = ctx.placer.tick(c);
  else r = ctx.bomber.tick(a.aim);
  if (r.s === "busy") return r;
  if (r.s === "done") { this.act = null; this.lastChangeAt = U.now(); return { s: "done" }; }

  if (r.occluder && kind === "mine" && !ctx.blocks.mineBlockReason(r.occluder)) { a.pre = r.occluder; return { s: "busy" }; }
  const relocatable = r.needStand || /out of reach|occluded|no visible|cannot aim|too far|line of sight|standing inside/.test(r.reason);
  if (!relocatable) return { s: "fail", reason: r.reason };
  return this.relocate(a, r.reason);
};

// Far line obstruction nobody can reach: throw a Bob-omb at it from the warp spot (outside no-bomb zones).
Builder.prototype.bombFallback = function (a) {
  const ctx = this.ctx;
  if (a.kind !== "mine" || !a.opts.fallbackBomb) return null;
  if (ctx.blocks.noBombZone(a.cell) || ctx.items.count(ctx.cfg.bombItem()) <= 0) return null;
  ctx.log("No spot to mine " + U.fmt(a.cell) + " from; using a Bob-omb");
  this.release();
  this.act = { key: "bomb:" + U.key(a.cell), kind: "bomb", cell: a.cell, aim: U.center(a.cell),
    opts: { prefer: a.opts.bombFrom ? [a.opts.bombFrom] : [] }, phase: "try", moves: 0, pre: null };
  return { s: "busy" };
};

Builder.prototype.relocate = function (a, reason) {
  const ctx = this.ctx;
  if (++a.moves > 3) return this.bombFallback(a) || { s: "fail", reason: reason + " (after 3 repositioning attempts)" };
  const here = U.up(player.blockPos(), -1);
  // never stand inside / on top of the cell we are about to fill
  const avoid = new Set(a.kind === "place" ? [U.key(U.up(a.cell, -1)), U.key(U.up(a.cell, -2))] : []);
  const supports = this.standSupports(a.kind, a.cell, a.aim, a.moves > 1 ? null : a.opts)
    .filter((s) => !U.same(s, here) && !avoid.has(U.key(s)));
  const self = this;
  ctx.mover.stop();
  ctx.mover.goTo({
    id: "act:" + a.key + ":" + a.moves, pos: a.cell, supports: supports.length ? supports : null, near: 4, avoid: avoid,
    digTarget: a.cell, allowEther: true, label: a.kind + " " + U.fmt(a.cell),
    arrive: () => self.canActFromHere(a.kind, a.cell, a.aim),
  });
  a.phase = "move";
  return { s: "busy" };
};

module.exports = { Builder: Builder };
