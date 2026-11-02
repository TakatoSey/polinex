/// <reference path="../polinex.d.ts" />
// Small vector / timing helpers shared by every file of the route-setup script.

const DIRS6 = [
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
];

const HORIZ4 = [
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
];

function v(x, y, z) { return { x: x, y: y, z: z }; }
function floor(p) { return v(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); }
function add(a, b) { return v(a.x + b.x, a.y + b.y, a.z + b.z); }
function sub(a, b) { return v(a.x - b.x, a.y - b.y, a.z - b.z); }
function scale(a, s) { return v(a.x * s, a.y * s, a.z * s); }
function up(p, n) { return v(p.x, p.y + (n === undefined ? 1 : n), p.z); }
function dist(a, b) { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
function distFlat(a, b) { const dx = a.x - b.x, dz = a.z - b.z; return Math.sqrt(dx * dx + dz * dz); }
function center(p) { return v(p.x + 0.5, p.y + 0.5, p.z + 0.5); }
function top(p) { return v(p.x + 0.5, p.y + 1.0, p.z + 0.5); }
function same(a, b) { return !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z; }
function key(p) { return Math.floor(p.x) + "," + Math.floor(p.y) + "," + Math.floor(p.z); }
function fmt(p) { return p ? "(" + Math.floor(p.x) + ", " + Math.floor(p.y) + ", " + Math.floor(p.z) + ")" : "(?)"; }
function now() { return Date.now(); }
function arr(hostList) { return hostList ? Array.from(hostList) : []; }

function inBox(p, b) {
  return !!b && p.x >= b[0] && p.y >= b[1] && p.z >= b[2] && p.x <= b[3] + 1 && p.y <= b[4] + 1 && p.z <= b[5] + 1;
}

// Feet position the player has while standing on a support block.
function feetOn(support) { return v(support.x, support.y + 1, support.z); }

// Eye positions to test when the player stands (sneaking) on a support block.
// Polinex runs on a modern client (1.27 sneak eye), Hypixel validates with 1.8 values (1.54).
function eyesOn(support) {
  return [
    v(support.x + 0.5, support.y + 1 + 1.54, support.z + 0.5),
    v(support.x + 0.5, support.y + 1 + 1.27, support.z + 0.5),
    v(support.x + 0.5, support.y + 1 + 1.62, support.z + 0.5),
  ];
}

module.exports = {
  DIRS6: DIRS6, HORIZ4: HORIZ4,
  v: v, floor: floor, add: add, sub: sub, scale: scale, up: up, dist: dist, distFlat: distFlat,
  center: center, top: top, same: same, key: key, fmt: fmt, now: now, arr: arr, inBox: inBox,
  feetOn: feetOn, eyesOn: eyesOn,
};
