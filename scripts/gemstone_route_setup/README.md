# Gemstone Route Setup (Polinex script)

This macro sets up a Gemstone Macro route for you. Select a route, start **Gemstone Route Setup** (Macros → Crystal Hollows), and it will:

1. **Inspect**: move around until Route Status has checked every warp and every line of the *active runtime route*.
2. **Decide**: if the route is buildable, build it. If it's "Not doable", try a lobby-specific Dynamic Route Fix. If no fix helps, switch lobbies and inspect again.
3. **Build** in two phases. First every waypoint is built, then every line is cleared, so each line has a cobble at *both* ends to stand on. Per warp:
   - Mine any gemstones sitting in the waypoint block.
   - Place the cobblestone, plus a block under it if there is none, so the Bob-omb lands on it.
   - Throw a Bob-omb right away from where you stand, and check it was used and really exploded.
   - Re-check the cobble and clear the 2 landing blocks above it (gems included).
   - Break the temporary support blocks again (blocks directly under a waypoint stay).
   - Clear the Etherwarp line to the next warp.
4. **Verify**: re-read Route Status and rebuild whatever is still open, until `setUp === true`.

## Install

Copy the whole `gemstone_route_setup/` folder to `.minecraft/polinex/scripts/`, then run `.pnxscript reload`. The entry file is `main.js`.

## Before you start

- In the Crystal Hollows (or anywhere in SkyBlock; it will travel with the Return Command)
- A Gemstone Macro route is selected
- Drill/pickaxe in the hotbar
- Cobblestone (default minimum: 64), and one Bob-omb per bombable waypoint if "Bob-omb Waypoints" is on
- An Etherwarp item (optional; only used for a one-off long trip or a big climb, never for moving around while building)
- Route Status HUD on. Turn on Route Rendering → Bombs too, so `notBombable` is known.

## Stages on the HUD

`Starting → Inspecting route → Deciding → (Dynamic Route Fix) → (Switching lobby) → Checking materials → Building → Verifying → Done`

The HUD shows the stage, the current action, the Route Status verdict, the progress, the lobby id and the switch count, and the current **Blocked:** reason. The world overlay draws each line: green = OK, yellow = unchecked, red = has problems.

## Logs

Every message goes to three places:

1. The **script console** (in game).
2. **`.minecraft/logs/latest.log`**, where every line starts with `[GRS]`.
3. A **persistent copy of the last 400 lines** in `.minecraft/polinex/scripts/data/gemstone_route_setup.properties` (key `log`). It survives restarts.

Each line has the time, level (INFO/WARN/FAIL), stage and your block position, e.g.
`14:03:12 WARN [BUILD @512,88,431] Warp #4: line #4 -> #5 blocked by protected gemstone ...`

In game: `.grs log` (or `.grs log 200`) puts the recent lines into the **Copy Log** box in the macro settings. Copy them from there with Ctrl+A, Ctrl+C. `.grs logchat` shows them in chat, and `.grs clearlog` empties the log. Turn on **Debug Log** to also echo the INFO lines in chat. If something goes wrong, send me the `log` value or the `[GRS]` lines from latest.log.

## Commands

| Command | What it does |
|---|---|
| `.grs` / `.grs status` | Route Status summary and problems per warp |
| `.grs log [n]` | Puts the last n log lines (default 60) into the macro setting **Copy Log**: click it, Ctrl+A, Ctrl+C. Nothing goes into chat; scripts have no clipboard access |
| `.grs logchat [n]` | Last n log lines in chat |
| `.grs clearlog` | Empty the persistent log |
| `.grs managers` | List route manager ids (for "Route Manager Id") |
| `.grs fix` | Show which Dynamic Route Fix control the script found |
| `.grs lobby` | Current lobby id from the scoreboard |
| `.grs reset` | Forget build progress and the unbreakable-block blacklist |

## How the decisions work

- **Walk or mine straight**: the native planner only sees loaded terrain, so early in a lobby it often picks a detour and has to come back later. With **Prefer Mining Straight** (default on), the script mines straight toward the target whenever the walking path is longer than `straight distance × Detour Threshold` (1.35) or its first blocks lead *away* from the target. It also mines when `walkCost > digCost × Dig Preference`. It never mines through gems, liquids, unknown terrain or structure cores. A planned path is followed to the end, and a slightly better one found later is ignored. Leaving a tunnel for a walk needs a walk that is at least 40% cheaper *and* not a detour.
- **Inspection is X/Z only**: the full height is always loaded and only X/Z render in later, so inspection only needs to get close in X/Z. *Walking* there may still go up or down freely, through caves and drops, if the planner finds a good path. Only *digging* stays level at the current height, and it never Etherwarps or digs up or down just to check a warp.
- **Tunnelling like a player**: it looks *once* along the tunnel (fixed yaw, `Tunnel Pitch` 25° down (the flattest angle that still breaks the feet block)), crouches, holds left-click and presses W only when the space ahead is open, so it never walks into the wall. The camera does **not** move per block: at 30° the held crosshair breaks the head block, then the feet block, then the next ones as you move forward. Left-click is only held while the crosshair is on a tunnel block it may mine. It's released immediately (also predicted ~3 ticks ahead) before it could touch the floor, a gem or anything else. Tunnels run along one axis (an L-shape, never a zigzag). A blocked straight line is passed with a sidestep: never a U-turn, at most 3 in a row. A dead-man switch releases the button and keys if the digger stops being driven.
- **No 45° digging down**: the digger has no diagonal-down staircase, because that pattern trips failsafes. To go lower it walks, drops off a ledge onto known ground (up to `Max Drop`), or tunnels level until it's above the target and then digs a straight vertical shaft.
- **Crystal Nucleus**: `/warp cn` lands you in the Nucleus, where nothing can be mined. The script *walks* out with the pathfinder only (no digging, no Etherwarp): toward the route first, then the four directions out of the Nucleus. Mining is refused while you're inside.
- **Treasure chests**: avoided, not waited for. A chest is never mined or walked into. If one spawns in the tunnel ahead or in the block you're stepping into, that step is dropped at once and the digger goes around it (sidestep, no U-turn). A background scanner and the chat message notice chests immediately. `Treasure Chest Pause` (default 0) can add a stop if you ever want one.
- **Walking faces forward**: for any move longer than about a block it turns toward where it walks (yaw only, level look) and walks forward. No long backwards or sideways (A D) walking. Small corrections while tunnelling only move forward/back toward the wall.
- **Stays in mining mode**: once a tunnel is started it's finished. It doesn't switch to the pathfinder halfway (the pathfinder is only used again if the tunnel fails).
- - **Light on the game (no lag)**: every block lookup is a single game call, classified by block id and cached for the current tick. Before this, one tick could read 20,000+ blocks with ~5 calls each. Searches are bounded: the worst tick reads ~1,000 blocks, a normal one ≤ ~250.
- **No wobbling (W S W S / A D A D)**: getting onto a spot crouch-walks, *taps* the keys within 0.6 blocks, waits after an overshoot instead of reversing, and accepts ~0.3 blocks instead of chasing the exact centre.
- **No pointless climbing**: it only climbs when the target is 2+ blocks higher, or 1 higher and directly there, at most 2 jump tries per step. No more looking up and jump-spamming for a block that's within reach.
- **Mine or walk**: it walks the planner's path unless that path is a real detour (much longer *and* 8+ blocks extra) *and* the straight line actually needs mining. In open caves it just walks.
- **Aiming**: the miner waits until you've stopped sliding before choosing where to look, and only uses points the crosshair can't slip off (no edges or corners: rays a hair to each side must hit the block too). Otherwise it mines the block in front first, or moves.
- **Gemstones are just blocks while building** (they regrow): `Protect Gemstones` is off by default. Turn it on to keep them, in which case `Mine Gems At Waypoints` / `Mine Gems Blocking A Line` decide the exceptions.
- **Jumping like a player (no lagbacks)**: a jump is a real jump-key press for ~2 ticks, only from the ground, with a cooldown. It never uses `player.jump()`, which may be a scripted velocity jump that can get you teleported back. Sneak is only changed while standing on the ground, never mid-air. Tower placement first crouch-walks exactly onto the block centre and stands still, looks almost straight down, jumps, and places only at the **top** of the jump. Placing earlier, while the server still thinks you're inside the cell because of ping, gets the block rejected, you land on a ghost block and get lagged back. This also works with jump boost (god potion): the near-vertical look keeps the crosshair on the block even at the higher apex.
- **Never mines its own blocks by accident**: placed waypoints, blocks under waypoints and support blocks are protected from tunnelling/movement. Only the support cleanup and line clearing remove a support block, explicitly, and never a waypoint block or the block under one.
- **Steady camera**: aim points almost straight below/above you are moved ~0.3 blocks forward along your current facing, because straight down has no defined yaw and the camera would spin.
- **No movement while mining**: the miner releases WASD every tick it mines. For a vertical shaft it first sneaks onto the block centre, waits until it stands completely still, then mines the block under its feet without touching a key. It aims ~80° down slightly *in front of* itself along its current facing; aiming exactly straight down makes the yaw undefined and the camera spins. Then it just falls, only onto known ground within `Max Drop`.
- **No blocks while tunnelling**: the digger never places blocks. A missing floor is a safe drop or a blocked direction, and steps are only planned while standing on the ground, so jump boost (god potion) no longer looks like "no floor here". Blocks are only placed for the waypoint itself, the block under it, and support to reach a floating waypoint.
- **Unknown terrain**: unloaded blocks are never treated as air. For far or unloaded targets the mover hops toward loaded spots in the same direction, so it never doubles back.
- **Etherwarp is not a way of moving around.** It's only used for a single long trip to a far-away spot (`Etherwarp Min Distance`, 70) or a big climb (`Etherwarp Min Rise`, 15). It's always exactly one warp (`etherwarp.directTo`, never a planned chain of warps), at most once per `Etherwarp Cooldown` (45 s), and never while inspecting or for building moves. **Instant Transmission** is optional (off), and only used on long, straight, open walking segments.
- **Goblin Queen's Den / Jungle Temple**: only a sphere of `Structure Core Radius` around their centre is avoided (from `skyblock.chStructures()`), not the whole region. A walking path through a core is swapped for a dug one when possible.
- **Protected blocks**: gemstone glass and panes, bedrock and other unbreakables, cobblestone placed by other players, and anything not in "Breakable Blocks" (unless "Mine Unlisted Blocks" is on). A block that doesn't break within ~3× its expected time is blacklisted for this lobby and never tried again.
- **Clearing lines in route order**, like walking the route (24 → 25 → 26 …): walk onto warp A (walk only), then mine the obstructions in order from A, looking along the line. An obstruction out of reach gets a tunnel dug toward it (where the blocks to break are), then it carries on toward B, and the next line starts from B. Only if tunnelling there is impossible (a pit, no floor) does it walk around to a spot that reaches it, and as the very last resort throw one Bob-omb. A block it can't reach is remembered and never retried in a loop: the next time it stops with `cannot reach the obstruction (x, y, z) ... Manual step: mine that block`.
- **Lines**: rays go from three eye heights (1.27 / 1.54 / 1.62 while standing on the warp) to the next warp's top and centre. Wider rays are added if Route Status still reports the line blocked. After each change the script waits for Route Status again, and never trusts its own rays alone.
- **Floating waypoints**: the script finds the shortest support chain (up to `Max Support Bridge`) from a wall or floor that keeps clear of the landing space and the route lines. Blocks are normally placed from the side, standing where a face to click on is actually visible. Only a straight column *under* a floating waypoint is built by towering up (jump, then place under yourself once your feet are clearly above the block; clicking at the moment of the jump gets rejected). That pillar placement is otherwise just the last resort. After the Bob-omb, every support block is broken again except blocks directly under a waypoint.
- **Gems at the waypoint**: gemstones in the waypoint block and the 2 landing blocks above it are mined (`Mine Gems At Waypoints`, on). Gems anywhere else (the veins) are never touched.
- **Lobby switch**: it records the scoreboard id, runs `/warp hub`, waits, runs the Return Command (default `warp cn`), and checks that the id changed. If you landed in the same lobby, it switches again.
- **Dynamic Route Fix**: see the limitations below. If the fix changes the runtime route (waypoints moved or removed), the corrected route is fully re-inspected.

## Pause / failsafe / world changes

- Failsafe/break pause: every input, rotation, nav/etherwarp action and pending query is released. On resume, the current stage is re-entered and replanned.
- World change / disconnect / death: everything is released, and the script waits to get back into SkyBlock. If you're not in the Hollows, it returns. If the lobby id changed, it starts over in the new lobby. Otherwise it re-inspects and keeps the build progress.
- Route changed (other route selected, or a fix moved waypoints): it re-inspects.
- Stuck checks per stage: 3 strikes, then it stops with the reason. A warp that fails 3 times is skipped, and the end report names it.

## Limitations of the scripting API (read this)

1. **Dynamic Route Fix has no scripting API.** The script probes the `Gemstone Macro` settings and a few likely modules (`Dynamic Route Fix`, `Route Status`, `Route Rendering`, …) for a setting named like *dynamic/route fix* and turns it on. If yours is named differently, set **Fix Setting Override** to `Owner > Setting` (check with `.grs fix`). If nothing scriptable exists, the script waits `Manual Fix Wait` seconds for **you to accept the fix**. It then switches lobby.
2. **Block placement**: there's no place-block call, so placing is done by aiming at a face (general rotation engine) and right-clicking while sneaking.
3. **Bob-omb**: there's no API for it. The script right-clicks while aiming at the waypoint, detects that the item was consumed, and waits `Bob-omb Wait (ms)`. It can't see where the TNT lands, so the cobble is always re-checked afterwards.
4. **Route Status problem codes aren't documented.** How they're read here: `badWarpSpot`, `lineBlocked` and `lineToMine` → build/clear. `veinMissing`, `veinUnderStructure`, `veinWrongGemType`, `veinNotRegrowing` and `someonesCobble` → lobby problem. The final verdict always comes from Polinex (`verdict` / `setUp`).
5. **Polinex's exact Etherwarp obstruction check isn't exposed**, which is why Route Status is always re-checked.
6. **Manual steps it may ask for**: a waypoint floating more than `Max Support Bridge` blocks from anything; a gemstone (or someone's cobble) in a line or landing space; a line Route Status calls blocked while no ray finds anything.
7. **Permanent passage map**: CleanCH is a world save, and scripts can't read files outside their folder. The script relies on live world data and the native planner instead.
8. **Combat**: Crystal Hollows mobs aren't fought. Use Polinex's own failsafes/helpers.

## Offline test harness

`tools/sim.js` mocks the scripting API on a small voxel world and runs the real macro state machine:

```bash
node tools/sim.js basic    # floor waypoint, floating waypoint (column), pillar blocking a line
node tools/sim.js tunnel   # start in a sealed pocket, must dig out
node tools/sim.js lobby    # Not doable -> no fix -> lobby switch (first retry lands in the same lobby)
node tools/sim.js fix      # Not doable -> Dynamic Route Fix toggle -> re-inspect corrected route
node tools/sim.js far      # X/Z render distance, a corridor that leads away first, lower target cavern:
                           # must mine straight, stay level while inspecting, never dig 45 degrees down
node tools/sim.js diag     # target exactly diagonal: L-shaped straight tunnels, no zigzag
node tools/sim.js gemspot  # gems in and above the waypoints (mined) next to a vein (kept)
node tools/sim.js bridge   # waypoint floating beside a wall: sideways support, removed again afterwards
JUMPBOOST=1 node tools/sim.js far   # jump boost: still no blocks placed while tunnelling
node tools/sim.js midline  # obstruction near the far end over a deep pit: tunnel impossible -> walks around to reach it
EXPECT_FAIL=1 TICKS=40000 node tools/sim.js pit   # unreachable: stops with a manual-step message, no loop
node tools/sim.js nucleus  # start in the Crystal Nucleus: walks out, never mines there
node tools/sim.js chest    # a treasure chest spawns right in front of you mid-tunnel: it goes around, never into it
node tools/sim.js shaft    # route straight below a sealed pocket: centre, dig a vertical shaft standing still, drop in
node tools/sim.js gem      # gemstone on a line: mined like any block (Protect Gemstones off)
```

`TRACE=1` prints the mover/builder state every tick. The mock is simplified (physics, planners, Route Status), so it catches logic errors but doesn't replace testing in game.
