/// <reference path="../polinex.d.ts" />
// Lobby switching: remember the lobby id from the scoreboard, warp to the Hub, come back with the
// configurable command and verify that the lobby id actually changed.
// tick() -> { s: "busy" } | { s: "done", id } | { s: "fail", reason }

const U = require("./util.js");

function currentLobbyId() {
  let lines = [];
  try { lines = U.arr(skyblock.scoreboard()).map(String); } catch (e) { return null; }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\d{1,2}\/\d{1,2}\/\d{2,4}\s+([A-Za-z]+\d+[A-Za-z]*)/);
    if (m) return m[1];
  }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\b((?:m|mini|mega)\d+[A-Za-z]*)\b/i);
    if (m) return m[1];
  }
  return null;
}

function Lobby(ctx) {
  this.ctx = ctx;
  this.job = null;
}

// returnOnly: we are not in the Crystal Hollows yet, just go there.
Lobby.prototype.begin = function (returnOnly) {
  const inCH = skyblock.location() === "CRYSTAL_HOLLOWS";
  this.job = {
    phase: returnOnly || !inCH ? "settle" : "hub",
    oldId: inCH ? currentLobbyId() : null,
    phaseAt: U.now(), cmdAt: 0, sends: 0, sameLobby: 0,
    settleMs: math.randomInt(2000, 3500),
    returnOnly: !!returnOnly,
  };
};

Lobby.prototype.cancel = function () { this.job = null; };

Lobby.prototype.send = function (cmd) {
  const j = this.job;
  if (U.now() - j.cmdAt < 3000) return false; // own pacing: sendCommand is not rate limited
  player.stopAllMovement();
  player.sendCommand(cmd);
  j.cmdAt = U.now();
  j.sends++;
  this.ctx.log("Sent /" + cmd);
  return true;
};

Lobby.prototype.setPhase = function (p) {
  this.job.phase = p;
  this.job.phaseAt = U.now();
  this.job.sends = 0;
  this.ctx.progress();
};

Lobby.prototype.tick = function () {
  const ctx = this.ctx;
  const j = this.job;
  if (!j) return { s: "fail", reason: "no lobby job" };
  const loc = skyblock.location();
  const age = U.now() - j.phaseAt;

  switch (j.phase) {
    case "hub": {
      ctx.detail = "Leaving lobby " + (j.oldId || "?") + " (/" + ctx.cfg.hubCmd() + ")";
      if (loc === "HUB") { this.setPhase("settle"); j.settleMs = math.randomInt(2000, 3500); return { s: "busy" }; }
      if (j.sends === 0 || U.now() - j.cmdAt > 15000) {
        if (j.sends >= 3) return { s: "fail", reason: "could not reach the Hub with /" + ctx.cfg.hubCmd() };
        this.send(ctx.cfg.hubCmd());
      }
      return { s: "busy" };
    }
    case "settle": {
      ctx.detail = "Waiting before /" + ctx.cfg.returnCmd();
      if (age >= j.settleMs) this.setPhase("return");
      return { s: "busy" };
    }
    case "return": {
      ctx.detail = "Returning with /" + ctx.cfg.returnCmd();
      if (loc === "CRYSTAL_HOLLOWS") { this.setPhase("verify"); return { s: "busy" }; }
      if (j.sends === 0 || U.now() - j.cmdAt > 20000) {
        if (j.sends >= 3) return { s: "fail", reason: "/" + ctx.cfg.returnCmd() + " did not bring us to the Crystal Hollows (scroll/pass missing?)" };
        this.send(ctx.cfg.returnCmd());
      }
      return { s: "busy" };
    }
    case "verify": {
      const id = currentLobbyId();
      ctx.detail = "Verifying lobby id (" + (id || "?") + ")";
      if (!id) {
        if (age > 12000) {
          ctx.warn("Could not read the lobby id from the scoreboard; assuming a new lobby");
          this.job = null;
          return { s: "done", id: null };
        }
        return { s: "busy" };
      }
      if (j.oldId && id === j.oldId && !j.returnOnly) {
        if (++j.sameLobby > 3) return { s: "fail", reason: "kept landing in the same lobby " + id };
        ctx.log("Still in lobby " + id + ", switching again");
        this.setPhase("hub");
        return { s: "busy" };
      }
      this.job = null;
      return { s: "done", id: id };
    }
  }
  return { s: "busy" };
};

module.exports = { Lobby: Lobby, currentLobbyId: currentLobbyId };
