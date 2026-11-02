# Gemstone Route Setup (Polinex script)

This macro sets up a Gemstone Macro route for you. Select a route, start **Gemstone Route Setup** (Macros → Crystal Hollows), and it will:

1. **Inspect**: move around until Route Status has checked every warp and every line of the *active runtime route*.
2. **Decide**: if the route is buildable, build it. If it's "Not doable", try a lobby-specific Dynamic Route Fix. If no fix helps, switch lobbies and inspect again.
3. **Build**: for each warp: place cobblestone (plus a support bridge or column if it floats), throw a Bob-omb on it (cobble first, then bomb), re-check the cobble, and clear the Etherwarp line to the next warp.
4. **Verify**: re-read Route Status and rebuild whatever is still open, until `setUp === true`.

## Install

Copy the whole `gemstone_route_setup/` folder to `.minecraft/polinex/scripts/`, then run `.pnxscript reload`. The entry file is `main.js`.

## Before you start

- In the Crystal Hollows (or anywhere in SkyBlock; it will travel with the Return Command)
- A Gemstone Macro route is selected
- Drill/pickaxe in the hotbar
- Cobblestone (default minimum: 64), and one Bob-omb per bombable waypoint if "Bob-omb Waypoints" is on
- An Etherwarp item (optional; it's only used for big climbs)
- Route Status HUD on. Turn on Route Rendering → Bombs too, so `notBombable` is known.

## Stages on the HUD

`Starting → Inspecting route → Deciding → (Dynamic Route Fix) → (Switching lobby) → Checking materials → Building → Verifying → Done`

The HUD shows the stage, the current action, the Route Status verdict, the progress, the lobby id and the switch count, and the current **Blocked:** reason. The world overlay draws each line: green = OK, yellow = unchecked, red = has problems.

## Commands

| Command | What it does |
|---|---|
| `.grs` / `.grs status` | Route Status summary and problems per warp |
| `.grs managers` | List route manager ids (for "Route Manager Id") |
| `.grs fix` | Show which Dynamic Route Fix control the script found |
| `.grs lobby` | Current lobby id from the scoreboard |
| `.grs reset` | Forget build progress and the unbreakable-block blacklist |

## How the decisions work

- **Walk or dig**: the native planner plans the walk. The script also estimates the cost of a straight dug passage (break time of the blocks, never through gems, liquids, unknown terrain or structure cores). It digs when `walkCost > digCost × Dig Preference`. A planned path is followed to the end, and a slightly better path that appears later is ignored. To switch from digging back to walking, the walk has to be at least 40% cheaper.
- **Unknown terrain**: unloaded blocks are never treated as air. For far or unloaded targets the mover hops toward loaded spots in the same direction, so it never doubles back.
- **Etherwarp** only when the goal is at least `Etherwarp Min Rise` blocks up (legit handler `etherwarp.etherwarpTo`, with planner fallback). **Instant Transmission** is optional, and only used on long, straight, open walking segments.
- **Goblin Queen's Den / Jungle Temple**: only a sphere of `Structure Core Radius` around their centre is avoided (from `skyblock.chStructures()`), not the whole region. A walking path through a core is swapped for a dug one when possible.
- **Protected blocks**: gemstone glass and panes, bedrock and other unbreakables, cobblestone placed by other players, and anything not in "Breakable Blocks" (unless "Mine Unlisted Blocks" is on). A block that doesn't break within ~3× its expected time is blacklisted for this lobby and never tried again.
- **Lines**: rays go from three eye heights (1.27 / 1.54 / 1.62 while standing on the warp) to the next warp's top and centre. Wider rays are added if Route Status still reports the line blocked. After each change the script waits for Route Status again, and never trusts its own rays alone.
- **Floating waypoints**: the script finds the shortest bridge (up to `Max Support Bridge`) from a wall or floor that keeps clear of the landing space and the route lines. It builds columns by pillar-jumping, and other bridges by normal placement.
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
EXPECT_FAIL=1 node tools/sim.js gem   # gemstone on a line -> stops with a manual-step message
```

`TRACE=1` prints the mover/builder state every tick. The mock is simplified (physics, planners, Route Status), so it catches logic errors but doesn't replace testing in game.
