/// <reference path="../polinex.d.ts" />
// Builds every warp of the active runtime route:
//   spot    - cobblestone at the waypoint (+ support chain from the nearest wall/floor if it floats) and a block
//             under it when there is none (so the Bob-omb lands on it instead of flying through).
//             Gemstones sitting in the waypoint block are mined (there nearly always are some).
//   bomb    - Bob-omb on the waypoint right after the cobble, from where we stand; checks it was used
//   respot  - re-check the cobble after the blast, clear the 2 landing blocks above it (gems included)
//   cleanup - break our support chain blocks again (blocks directly under a waypoint stay)
//   line    - clear the Etherwarp line to the next warp (rays + Route Status re-checks)
// tick(st) -> { s: "busy" } | { s: "done" } | { s: "fail", reason }

const U = require("./util.js");
const S = require("./status.js");

// Two phases: first every waypoint is built, then every line is cleared, so each line has a cobble at BOTH
// ends to stand on (obstructions near the far end are mined from that end).
const PHASES = { spot: ["spot", "bomb", "respot", "cleanup"], line: ["line"] };

function Builder(ctx) {
  this.ctx = ctx;
  this.prog = new Map(); // warp key -> { bombed, fails, blocked, issues }
  this.queue = [];
  this.cur = null;
  this.act = null;
  this.lastChangeAt = 0;
  this.unreachable = new Map(); // obstruction key -> reason (never retried in a loop)
  this.bombTried = new Set();
}

Builder.prototype.reset = function () {
  this.release();
  this.prog.clear();
  this.queue = [];
  this.cur = null;
  this.unreachable.clear();
  this.bombTried.clear();
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
  this.queue = order.map((n) => ({ number: n, phase: "spot" })).concat(order.map((n) => ({ number: n, phase: "line" })));
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
    this.cur = { number: this.queue[0].number, phase: this.queue[0].phase, step: 0 };
    this.release();
  }
  const w = st.warps.find((x) => x.number === this.cur.number);
  if (!w) { this.queue.shift(); this.cur = null; return { s: "busy" }; }
  const idx = st.warps.indexOf(w);
  const next = st.warps.length > 1 ? st.warps[(idx + 1) % st.warps.length] : null;
  const p = this.progFor(w);
  const steps = PHASES[this.cur.phase];
  const stepName = steps[this.cur.step];
  const left = this.queue.filter((q) => q.phase === this.cur.phase).length;
  ctx.progressText = (this.cur.phase === "spot" ? "Building warp #" + w.number : "Line #" + w.number + (next ? " -> #" + next.number : "")) +
    " (" + (st.warps.length - left + 1) + "/" + st.warps.length + ") - " + stepName;

  let r;
  if (stepName === "spot") r = this.ensureSpot(w, false);
  else if (stepName === "respot") r = this.ensureSpot(w, true);
  else if (stepName === "bomb") r = this.bombStep(w, p);
  else if (stepName === "cleanup") r = this.cleanupSupport(w, p, st);
  else r = this.clearLine(w, next);

  if (r.s === "busy") return r;
  if (r.s === "done") {
    this.release();
    this.cur.step++;
    if (this.cur.step >= steps.length) {
      if (this.cur.phase === "line") { p.done = true; ctx.log("Line #" + w.number + (next ? " -> #" + next.number : "") + " clear"); }
      else ctx.log("Warp #" + w.number + " built" + (p.bombed ? " (bombed)" : ""));
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
  // a dig that already ran its full length without arriving will not do better on a retry
  if (/Max Dig Length|digging keeps failing/.test(r.reason)) r.fatal = true;
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

Builder.prototype.ensureSpot = function (w, landing) {
  const ctx = this.ctx;
  const B = ctx.blocks;
  const cob = this.cobPos(w);
  const info = B.info(cob);
  if (!info.loaded) return this.travel(cob, "warp #" + w.number);
  const gemOk = { allowGem: ctx.cfg.mineGemsAtWaypoint() };

  if (B.isCobble(info.id)) {
    // a block under the waypoint so a Bob-omb lands on it (only if there is none yet)
    const under = U.up(cob, -1);
    const ui = B.info(under);
    if (!landing && ui.loaded && ui.passable && !ui.liquid && !this.underFailed) {
      ctx.detail = "Placing the block under waypoint #" + w.number;
      const r = this.action("place", under);
      if (r.s === "fail") { this.underFailed = true; ctx.warn("Could not place a block under #" + w.number + ": " + r.reason); return { s: "busy" }; }
      return r.s === "done" ? { s: "busy" } : r;
    }
    if (landing) {
      for (let h = 1; h <= 2; h++) {
        const cell = U.up(cob, h);
        const hi = B.info(cell);
        if (hi.passable) continue;
        if (hi.gem && !gemOk.allowGem) return { s: "fail", reason: "gemstone in the landing space above warp #" + w.number + " (Mine Gems At Waypoints is off)", fatal: true };
        ctx.detail = "Clearing landing space above #" + w.number;
        return this.action("mine", cell, null, gemOk);
      }
    }
    this.underFailed = false;
    return { s: "done" };
  }
  if (!info.passable) {
    if (info.gem && !gemOk.allowGem) return { s: "fail", reason: "gemstone occupies the waypoint block of #" + w.number + " (Mine Gems At Waypoints is off)", fatal: true };
    ctx.detail = "Mining " + info.id.replace("minecraft:", "") + " at waypoint #" + w.number;
    return this.action("mine", cob, null, gemOk);
  }
  const p = this.progFor(w);
  if (this.hasSolidNeighbour(cob)) {
    ctx.detail = "Placing cobble at #" + w.number;
    return this.action("place", cob, null, { pillar: !!p.column });
  }
  if (!p.chain) {
    p.chain = this.bridgeChain(w, cob);
    // a straight column under the waypoint is built by towering up (jump + place under, timed right);
    // those blocks are "under the waypoint" and stay. Any other support chain uses normal placement.
    p.column = !!p.chain && p.chain.every((c) => c.x === cob.x && c.z === cob.z && c.y < cob.y);
  }
  const chain = p.chain;
  if (!chain) {
    return { s: "fail", fatal: true, reason: "waypoint #" + w.number + " " + U.fmt(cob) + " floats with no wall/floor within " +
      ctx.cfg.maxBridge() + " blocks. Manual step: place one block next to it, then restart." };
  }
  for (let i = 0; i < chain.length; i++) {
    // chain cells were planned on air, so any cobble there now is ours (even if it landed from a neighbour click)
    if (B.isCobble(B.info(chain[i]).id)) { B.ourCobble.add(U.key(chain[i])); continue; }
    ctx.detail = (p.column ? "Towering up under #" : "Placing support block for #") + w.number + " (" + (i + 1) + "/" + chain.length + ")";
    return this.action("place", chain[i], null, { pillar: p.column });
  }
  return { s: "busy" }; // chain complete, the waypoint itself is placed next tick
};

// Break the support chain again: only blocks directly under a waypoint stay (they cannot hurt the route).
Builder.prototype.cleanupSupport = function (w, p, st) {
  const ctx = this.ctx;
  const B = ctx.blocks;
  if (!p.chain || !p.chain.length) return { s: "done" };
  const keep = (cell) => st.warps.some((x) => {
    const c = this.cobPos(x);
    return c.x === cell.x && c.z === cell.z && cell.y <= c.y;
  });
  for (let i = p.chain.length - 1; i >= 0; i--) {
    const cell = p.chain[i];
    const ci = B.info(cell);
    if (!ci.loaded || !B.isCobble(ci.id) || keep(cell)) continue;
    B.ourCobble.add(U.key(cell)); // chain cells were air when planned: cobble there is ours
    ctx.detail = "Removing support block " + U.fmt(cell) + " of #" + w.number;
    const r = this.action("mine", cell, null, { allowOurCobble: true });
    if (r.s === "fail") { ctx.warn("Could not remove support block " + U.fmt(cell) + ": " + r.reason); p.chain.splice(i, 1); return { s: "busy" }; }
    if (r.s === "done") { B.ourCobble.delete(U.key(cell)); ctx.log("Removed support block " + U.fmt(cell) + " of #" + w.number); }
    return { s: "busy" };
  }
  p.chain = null;
  return { s: "done" };
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
  if (r.s === "done") { p.bombed = true; this.lastChangeAt = U.now(); ctx.log("Bob-omb on #" + w.number + " exploded"); }
  if (r.s === "fail" && /did not explode|not used/.test(r.reason)) {
    // do not loop on a spot where bombs do not work; the route can still be built, Route Status decides
    p.bombed = true;
    ctx.warn("Bob-omb on #" + w.number + ": " + r.reason + " - continuing without it");
    return { s: "done" };
  }
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

// Solid blocks along the Etherwarp line from `from` to `to`, nearest to `from` first.
Builder.prototype.lineCells = function (from, to) {
  const B = this.ctx.blocks;
  let cells = [];
  try { cells = U.arr(world.blocksBetween(U.eyesOn(from)[0], U.v(to.x + 0.5, to.y + 0.98, to.z + 0.5))).map(U.floor); } catch (e) { cells = []; }
  return cells.filter((c) => !U.same(c, from) && !U.same(c, to) && !U.same(c, U.up(from, 1)) && !U.same(c, U.up(from, 2)) &&
    !B.info(c).passable);
};

// Closest point of the A->B line to a block, kept inside that block: aiming there keeps the camera on the line.
Builder.prototype.linePoint = function (a, b, cell) {
  const c = U.center(cell);
  const ab = U.sub(b, a), ac = U.sub(c, a);
  const len2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z || 1;
  const t = Math.max(0, Math.min(1, (ac.x * ab.x + ac.y * ab.y + ac.z * ab.z) / len2));
  const p = U.add(a, U.scale(ab, t));
  const clamp = (v, lo) => Math.max(lo + 0.2, Math.min(lo + 0.8, v)); // away from edges: crosshair would slip off
  return U.v(clamp(p.x, cell.x), clamp(p.y, cell.y), clamp(p.z, cell.z));
};

// Lines are cleared in route order like a player walks the route (24 -> 25 -> 26 ...): stand on warp A, look
// along the line toward B and mine the obstructions in order from A. One that is out of reach: tunnel toward it
// (where the blocks to break are), mine it, carry on toward B. The next line then starts from B.
Builder.prototype.clearLine = function (w, next) {
  const ctx = this.ctx;
  if (!next) return { s: "done" };
  const from = this.cobPos(w), to = this.cobPos(next);
  const B = ctx.blocks;
  if (!B.info(from).loaded) return this.travel(from, "warp #" + w.number);
  if (!B.info(to).loaded) return this.travel(to, "warp #" + next.number);
  const label = "line #" + w.number + " -> #" + next.number;
  const lkey = U.key(from) + ">" + U.key(to);
  if (!this.ls || this.ls.key !== lkey) this.ls = { key: lkey, phase: "toA", tries: 0 };
  const ls = this.ls;
  const allowGem = ctx.cfg.mineGemsOnLine();

  // remaining obstructions, nearest to A first
  let obs = this.lineCells(from, to);
  const statusSays = S.has(w, ["lineBlocked", "lineToMine"]);
  if (!obs.length) {
    const ray = this.lineObstruction(from, to, false) || (statusSays && U.now() - this.lastChangeAt >= 3000 ? this.lineObstruction(from, to, true) : null);
    if (ray) obs = [ray.block];
  }
  if (!obs.length) {
    if (!statusSays) { this.lineWaitStart = 0; this.ls = null; return { s: "done" }; }
    if (U.now() - this.lastChangeAt < 3000) return { s: "busy" }; // let Route Status catch up
    if (!this.lineWaitStart) this.lineWaitStart = U.now();
    if (U.now() - this.lineWaitStart < 10000) return { s: "busy" };
    this.lineWaitStart = 0;
    return { s: "fail", fatal: true, reason: "Route Status reports " + label +
      " blocked, but no obstruction is visible to the rays. Manual step: look along the line and clear what Polinex highlights." };
  }
  this.lineWaitStart = 0;
  const target = obs[0];
  const tk = U.key(target);
  // our own support block in the line may go, a waypoint block (or the block under one) never
  const isWaypointBlock = (ctx.lastStatus ? ctx.lastStatus.warps : []).some((x) => {
    const c = this.cobPos(x);
    return c.x === target.x && c.z === target.z && (target.y === c.y || target.y === c.y - 1);
  });
  const lineOpts = { allowGem: allowGem, allowOurCobble: !isWaypointBlock };
  const why = B.mineBlockReason(target, lineOpts);
  if (why) return { s: "fail", fatal: true, reason: label + " blocked by " + why };
  if (this.unreachable.has(tk)) {
    return { s: "fail", fatal: true, reason: label + ": cannot reach the obstruction " + U.fmt(target) + " (" + this.unreachable.get(tk) +
      "). Manual step: mine that block (or the blocks around it), then start again." };
  }

  // 1) start the line standing on warp A (skip if we cannot get onto it: work from where we are)
  if (ls.phase === "toA") {
    const onA = U.same(player.blockPos(), U.up(from, 1));
    if (onA || !B.isCobble(B.info(from).id) || ls.tries > 0) { ls.phase = "sweep"; ctx.mover.stop(); return { s: "busy" }; }
    ctx.detail = "Walking to warp #" + w.number + " to start " + label;
    // walk only: if we cannot simply walk onto the cobble we clear from where we are (no digging up to it)
    ctx.mover.goTo({ id: "lineA:" + lkey, pos: from, supports: [from], near: 1, allowEther: false, allowDig: false, label: "warp #" + w.number,
      arrive: () => U.same(player.blockPos(), U.up(from, 1)) });
    const r = ctx.mover.tick();
    if (r.s === "fail") { ls.tries++; ctx.log("Cannot stand on warp #" + w.number + " (" + r.reason + "); clearing from here"); ctx.mover.stop(); }
    if (r.s === "arrived") { ctx.mover.stop(); ls.phase = "sweep"; }
    return { s: "busy" };
  }

  // 2) mine the next obstruction along the line; out of reach -> tunnel toward it (action relocation digs there)
  const eyeA = U.eyesOn(from)[0], topB = U.v(to.x + 0.5, to.y + 0.98, to.z + 0.5);
  ctx.detail = "Clearing " + label + " at " + U.fmt(target) + " (" + obs.length + " left)";
  const hold = new Set(obs.slice(0, 6).map(U.key)); // the held button may run on into the next line blocks
  const r = this.action("mine", target, this.linePoint(eyeA, topB, target), {
    allowGem: allowGem,
    allowOurCobble: lineOpts.allowOurCobble,
    hold: hold,
    tunnel: true, // reach it by tunnelling toward it, not by searching stand spots all over the cave
    fallbackBomb: ctx.cfg.useBombs() && ctx.cfg.bombLines() && !this.bombTried.has(tk),
    bombFrom: null,
  });
  if (r.s === "fail") {
    this.unreachable.set(tk, r.reason);
    ctx.warn(label + ": giving up on " + U.fmt(target) + " for now: " + r.reason);
  }
  if (r.s === "done") return { s: "busy" }; // next obstruction
  return r;
};

// ---------- generic travel ----------
Builder.prototype.travel = function (pos, label) {
  const ctx = this.ctx;
  const goal = {
    id: "travel:" + U.key(pos), pos: pos, near: 4, approach: true, label: label, allowEther: true, // long one-off trips only
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
  if (d > 9 || d < 1) return false; // throw right from where we placed the cobble
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
  const pred = kind === "place" ? (eye, feet) => !U.same(feet, cell) && !U.same(U.up(feet, 1), cell) && !!ctx.placer.faceFor(cell, eye) : null;
  ctx.blocks.standSpotsFor(cell, aim || U.center(cell), reach, 4, pred).forEach((f) => {
    if (kind === "bomb" && U.dist(U.center(f), aim) < 1) return;
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
    this.act = { key: k, kind: kind, cell: c, aim: aim || U.center(c), explicitAim: aim || null, opts: opts || {}, phase: "try", moves: 0, pre: null,
      pillar: kind === "place" && !!(opts && opts.pillar) && ctx.placer.canPillar(c), pmoves: 0, pillarMove: false };
    // pillar (jump + place under) only for columns under a floating waypoint or as a last resort
  }
  const a = this.act;

  if (a.phase === "move") {
    const r = ctx.mover.tick();
    if (r.s === "busy") return r;
    if (r.s === "arrived") { ctx.mover.stop(); a.phase = "try"; a.pillarMove = false; return { s: "busy" }; }
    if (a.opts.tunnel && !a.tunnelFailed) {
      // cannot tunnel there (pit, no floor, gems...): walk around to a spot that reaches it instead
      a.tunnelFailed = true;
      ctx.log("Cannot tunnel to " + U.fmt(c) + " (" + r.reason + "); looking for a spot that reaches it");
      ctx.mover.stop();
      a.phase = "try";
      return this.relocate(a, r.reason);
    }
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
  if (kind === "place" && ctx.blocks.isCobble(ctx.blocks.info(c).id)) { // already there: done, never walk back into it
    ctx.blocks.ourCobble.add(U.key(c));
    this.act = null;
    this.lastChangeAt = U.now();
    return { s: "done" };
  }
  if (kind === "place" && a.pillar) {
    // on the column (even on its edge): the placer centres us crouched, never send the mover (it walked us off)
    if (player.onGround() && !U.same(player.blockPos(), c) && !ctx.placer.onColumn(c)) {
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
    if (pr.s === "fail") { a.pillar = false; return { s: "fail", reason: "pillar placement failed: " + pr.reason }; }
    return { s: "busy" };
  }

  let r;
  if (kind === "mine") r = ctx.miner.tick(c, a.explicitAim ? Object.assign({}, a.opts, { aim: a.explicitAim }) : a.opts);
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
  if (this.bombTried.has(U.key(a.cell))) return null;
  this.bombTried.add(U.key(a.cell));
  ctx.log("No spot to mine " + U.fmt(a.cell) + " from; trying one Bob-omb");
  this.release();
  this.act = { key: "bomb:" + U.key(a.cell), kind: "bomb", cell: a.cell, aim: U.center(a.cell),
    opts: { prefer: a.opts.bombFrom ? [a.opts.bombFrom] : [] }, phase: "try", moves: 0, pre: null };
  return { s: "busy" };
};

Builder.prototype.relocate = function (a, reason) {
  const ctx = this.ctx;
  const lastResortPillar = () => {
    if (a.kind !== "place" || a.triedPillar || !ctx.placer.canPillar(a.cell)) return null;
    a.triedPillar = true;
    a.pillar = true;
    ctx.log("No spot sees a face to place " + U.fmt(a.cell) + " against; using pillar placement");
    return { s: "busy" };
  };
  if (++a.moves > 3) return lastResortPillar() || this.bombFallback(a) || { s: "fail", reason: reason + " (after 3 repositioning attempts)" };
  const here = U.up(player.blockPos(), -1);
  // never stand inside / on top of the cell we are about to fill
  const avoid = new Set(a.kind === "place" ? [U.key(U.up(a.cell, -1)), U.key(U.up(a.cell, -2))] : []);
  // tunnel mode (line obstructions): no stand-spot hunting around the cave, dig toward the block itself
  const tunnelMode = a.opts.tunnel && !a.tunnelFailed;
  const supports = tunnelMode ? [] : this.standSupports(a.kind, a.cell, a.aim, a.moves > 1 ? null : a.opts)
    .filter((s) => !U.same(s, here) && !avoid.has(U.key(s)));
  if (a.kind === "place" && !supports.length) { const pr = lastResortPillar(); if (pr) return pr; }
  const self = this;
  ctx.mover.stop();
  ctx.mover.goTo({
    id: "act:" + a.key + ":" + a.moves, pos: a.cell, supports: supports.length ? supports : null, near: 4, avoid: avoid,
    tunnelOnly: tunnelMode, digTarget: tunnelMode ? U.up(a.cell, -1) : a.cell, allowEther: false, label: a.kind + " " + U.fmt(a.cell),
    arrive: () => self.canActFromHere(a.kind, a.cell, a.aim),
  });
  a.phase = "move";
  return { s: "busy" };
};

module.exports = { Builder: Builder };
