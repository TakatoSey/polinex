/// <reference path="../polinex.d.ts" />
// Settings shown on the macro card, plus a typed accessor object (cfg) the rest of the script reads.

const DEFAULT_BREAKABLE = [
  "stone", "granite", "diorite", "andesite", "polished_granite", "polished_diorite", "polished_andesite",
  "*_ore", "dirt", "coarse_dirt", "rooted_dirt", "grass_block", "podzol", "mycelium", "gravel", "sand", "red_sand",
  "sandstone", "clay", "terracotta", "*_terracotta", "prismarine", "prismarine_bricks", "dark_prismarine",
  "*_wool", "netherrack", "magma_block", "*_leaves", "*_log", "*_wood", "vine", "moss_block",
  "stone_bricks", "mossy_stone_bricks", "cracked_stone_bricks", "mossy_cobblestone", "infested_*",
  "short_grass", "tall_grass", "fern", "large_fern", "dead_bush",
].join(",");

const SETTINGS = [
  // ---- Route & lobby ----
  { id: "managerId", type: "string", name: "Route Manager Id", default: "",
    description: "Leave blank to auto-detect the Gemstone route manager (routes.managers())." },
  { id: "hubCmd", type: "string", name: "Hub Command", default: "warp hub",
    description: "Command (without /) used to leave the lobby." },
  { id: "returnCmd", type: "string", name: "Return Command", default: "warp cn",
    description: "Command (without /) used to get back into the Crystal Hollows, e.g. warp cn / warp ch / warp crystals." },
  { id: "maxLobbySwitches", type: "slider", name: "Max Lobby Switches", min: 0, max: 60, default: 15,
    description: "Give up (and explain why) after this many lobby switches." },
  { id: "useFix", type: "boolean", name: "Use Dynamic Route Fix", default: true,
    description: "Try a lobby-specific Dynamic Route Fix before switching lobbies." },
  { id: "fixSetting", type: "string", name: "Fix Setting Override", default: "",
    description: "Optional exact 'Owner > Setting' (e.g. 'Gemstone Macro > Dynamic Route Fix'). Blank = auto probe." },
  { id: "manualFixWaitSec", type: "slider", name: "Manual Fix Wait (s)", min: 0, max: 300, default: 45,
    description: "If no fix setting can be driven by script, wait this long for you to accept the fix manually. 0 = skip." },
  { id: "startGemMacro", type: "boolean", name: "Start Gemstone Macro When Done", default: false,
    description: "Start the native Gemstone Macro once Route Status reports Set up." },

  // ---- Movement ----
  { id: "etherMinRise", type: "slider", name: "Etherwarp Min Rise", min: 3, max: 40, default: 8,
    description: "Only use Etherwarp when the goal is at least this many blocks above you." },
  { id: "useAotv", type: "boolean", name: "Use Instant Transmission", default: false,
    description: "Use AOTE/AOTV Instant Transmission on long, straight, open walking segments." },
  { id: "aotvMinDist", type: "slider", name: "Instant Transmission Min Distance", min: 8, max: 40, default: 14 },
  { id: "allowDig", type: "boolean", name: "Dig Passages", default: true,
    description: "Dig a passage when it is cheaper than the walking detour (or no walking path exists)." },
  { id: "digFactor", type: "decimalSlider", name: "Dig Preference", min: 0.5, max: 3, default: 1.0, increment: 0.05,
    description: "Dig when walkCost > digCost x this. Higher = dig less often." },
  { id: "maxDigLen", type: "slider", name: "Max Dig Length", min: 8, max: 160, default: 70,
    description: "Never plan a dug passage longer than this many blocks." },
  { id: "avoidRadius", type: "slider", name: "Structure Core Radius", min: 0, max: 30, default: 10,
    description: "Avoid digging/bombing within this radius of the Goblin Queen's Den / Jungle Temple centers." },
  { id: "planBudget", type: "slider", name: "Etherwarp Plan Budget (ms)", min: 25, max: 2000, default: 150 },

  // ---- Mining ----
  { id: "breakable", type: "string", name: "Breakable Blocks", default: DEFAULT_BREAKABLE,
    description: "Comma list of block ids (no minecraft:, * wildcards) the script may mine." },
  { id: "mineUnknown", type: "boolean", name: "Mine Unlisted Blocks", default: false,
    description: "Also try blocks that are not in the list (unbreakable ones get blacklisted after one try)." },
  { id: "mineGemsOnLine", type: "boolean", name: "Mine Gems Blocking A Line", default: false,
    description: "Off = gemstone glass/panes are never mined." },
  { id: "useAbility", type: "boolean", name: "Use Pickaxe Ability", default: true },
  { id: "breakTicks", type: "slider", name: "Avg Break Ticks", min: 1, max: 60, default: 6,
    description: "Fallback break time per block, used for dig-vs-walk cost estimates." },
  { id: "reach", type: "decimalSlider", name: "Reach", min: 3, max: 5, default: 4.4, increment: 0.1 },

  // ---- Build ----
  { id: "placeItem", type: "string", name: "Support Block Item", default: "Cobblestone" },
  { id: "minCobble", type: "slider", name: "Min Support Blocks", min: 0, max: 640, default: 64,
    description: "Refuse to start construction with fewer blocks than max(this, needed)." },
  { id: "yOffset", type: "plusMinus", name: "Cobble Y Offset", min: -2, max: 1, default: 0,
    description: "0 = cobble goes exactly at the waypoint. -1 = waypoint is the standing spot above the cobble." },
  { id: "maxBridge", type: "slider", name: "Max Support Bridge", min: 1, max: 12, default: 6,
    description: "Max extra blocks to connect a floating waypoint to a wall/floor." },
  { id: "useBombs", type: "boolean", name: "Bob-omb Waypoints", default: true,
    description: "After the cobble is placed, throw a Bob-omb at the waypoint to clear the stone around the vein." },
  { id: "bombLines", type: "boolean", name: "Bob-omb Line Obstructions", default: true,
    description: "Bomb far line obstructions that cannot be mined from a reachable spot." },
  { id: "bombItem", type: "string", name: "Bob-omb Item", default: "Bob-omb" },
  { id: "bombFuseMs", type: "slider", name: "Bob-omb Wait (ms)", min: 1000, max: 10000, default: 4500 },
  { id: "requireBombs", type: "boolean", name: "Require Enough Bob-ombs", default: true,
    description: "Stop before building when you don't have one Bob-omb per bombable waypoint." },
  { id: "materialSlot", type: "slider", name: "Material Hotbar Slot", min: 1, max: 9, default: 8,
    description: "Hotbar slot used when cobble / Bob-ombs must be moved from the inventory." },

  // ---- Display ----
  { id: "render", type: "boolean", name: "Render Route Overlay", default: true },
  { id: "debug", type: "boolean", name: "Debug Log", default: false },
];

function makeCfg(m) {
  const s = (id) => m.setting(id);
  const num = (id) => Number(s(id));
  const str = (id) => String(s(id) == null ? "" : s(id)).trim();
  return {
    managerId: () => str("managerId"),
    hubCmd: () => str("hubCmd").replace(/^\//, ""),
    returnCmd: () => str("returnCmd").replace(/^\//, ""),
    maxLobbySwitches: () => num("maxLobbySwitches"),
    useFix: () => s("useFix") === true,
    fixSetting: () => str("fixSetting"),
    manualFixWaitMs: () => num("manualFixWaitSec") * 1000,
    startGemMacro: () => s("startGemMacro") === true,
    etherMinRise: () => num("etherMinRise"),
    useAotv: () => s("useAotv") === true,
    aotvMinDist: () => num("aotvMinDist"),
    allowDig: () => s("allowDig") === true,
    digFactor: () => num("digFactor"),
    maxDigLen: () => num("maxDigLen"),
    avoidRadius: () => num("avoidRadius"),
    planBudget: () => Math.max(1, Math.min(2000, Math.round(num("planBudget")))),
    breakable: () => str("breakable"),
    mineUnknown: () => s("mineUnknown") === true,
    mineGemsOnLine: () => s("mineGemsOnLine") === true,
    useAbility: () => s("useAbility") === true,
    breakTicks: () => num("breakTicks"),
    reach: () => num("reach"),
    placeItem: () => str("placeItem"),
    minCobble: () => num("minCobble"),
    yOffset: () => num("yOffset"),
    maxBridge: () => num("maxBridge"),
    useBombs: () => s("useBombs") === true,
    bombLines: () => s("bombLines") === true,
    bombItem: () => str("bombItem"),
    bombFuseMs: () => num("bombFuseMs"),
    requireBombs: () => s("requireBombs") === true,
    materialSlot: () => Math.max(0, Math.min(8, num("materialSlot") - 1)),
    render: () => s("render") === true,
    debug: () => s("debug") === true,
  };
}

module.exports = { SETTINGS: SETTINGS, makeCfg: makeCfg };
