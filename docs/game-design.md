# BOSSFORM — Game Design Document

**Version 0.2 · living document.** Owner: designer (poshih) with engineering.

Legend: **[SET]** decided by the designer · **[PROPOSED]** engineering proposal awaiting sign-off · **[OPEN]** undecided (§12).
All numbers are tuning starting points, not commitments. Units: 1 unit = 1 simulation unit; 60 ticks per second.

## 0. Why this document exists

The v0 prototype (solo / 2-seat PvE stages, 16-bit pixel look, fast shots, hitscan beam) was built on wrong assumptions.
This document replaces it. It is tagged `v0-prototype` in git; everything in it that contradicts this document is
scheduled for removal (§13).

## 1. Decisions so far

**Direction [SET]**
- Like **Senko no Ronde**: a mech **battle arena**, **mostly PvP**. **Enemy units** are an extra damage source.
- **Player bullets are normal speed, like enemy bullets. No instant or very fast shots.**
- **Not 16-bit.** Sleek **vector mesh** visuals and fluid **motion**.
- **Up to 8 players for now, never limited by technology.** Same lockstep engine.
- Move and aim separately (twin-stick). Three tropey robot designs to start: **versatile / fast / heavy**.

**Answers to the design questions [SET]**
1. **Match format:** generic teams (free-for-all = every player their own team).
2. **Round rule:** both selectable: Elimination rounds and Timed deathmatch.
3. **Boss form:** a large, heavy, **Gradius V style** boss with multiple attacks (§5.5).
4. **Arena:** **large scrolling arena with a follow camera** (§4).
5. **Lethality:** each robot can take at most **X damage per time window**, a per-robot balance value (§5.3).

## 2. Vision and pillars

*You are a mech in a huge arena full of slow, beautiful, lethal bullets. Read the patterns, thread the gaps, graze
for energy, and when you are charged, become the boss: a colossus that the others must take apart piece by piece.*

1. **Dodging is the game.** Every projectile is slow, visible and readable. Skill is positioning and pattern reading.
2. **Duel-dance PvP.** Independent move and aim, graze for reward, transform. The environment only adds pressure.
3. **Sleek vector language.** Glowing edges over translucent faces, smooth motion, trails and easing.
4. **Weight.** The boss form is large and heavy, and everything about it must say so (§5.5).
5. **Scales with players.** 2 to 8 today; the engine and simulation carry no hard cap.
6. **Everyone sees the same game.** Deterministic lockstep: no host advantage, identical on every JS engine.

## 3. Match structure

- **Players:** 2 to 8 (a game-rule constant; nothing technical prevents more).
- **Teams:** every seat has a team id (any byte, so lobby colours carry into the match); no friendly fire. 2v2, 4v4, 2v2v2v2 and free-for-all all use the same code.
- **Elimination [SET]:** one life per round, last team standing wins the round, best of 3. After 75 s the safe zone
  shrinks (sudden death) and neutral units intensify.
- **Deathmatch [SET]:** respawn after 3 s with brief protection; team score = kills (a boss-form kill is worth more);
  3 minute limit.
- **AI seats [PROPOSED]:** bots fill empty seats. A bot is an input source owned by one machine, so lockstep needs
  no special case. Bots also let 8-player matches be tested headlessly.
- **Flow:** lobby (frame, team, mode) -> countdown -> battle -> results -> rematch.

## 4. The arena [SET: large, scrolling, follow camera]

- **Circular arena [PROPOSED]** (exact in fixed point, reads as sleek). Radius scales with players:
  `R(n) = 500 + 100 n` (2 players 700, 8 players 1300). The camera shows about 520 units of height, so the arena is
  several screens across and players must hunt each other.
- **Follow camera [PROPOSED]:** smooth, leads slightly toward the aim direction, zooms out while the local player is in
  boss form. Never shows fog: other players are visible whenever they are in view.
- **Awareness aids [PROPOSED]:** a **radar** (arena circle with team-coloured dots, neutral units, safe zone) and
  **edge arrows** pointing at off-screen players and the boss-form players everyone should know about.
- **Rim and safe zone:** the rim is solid (ships stop, bullets die). In sudden death everything outside the shrinking
  safe zone takes steady damage that ignores the damage window.
- **Spawns:** ships start evenly spaced on a ring at 70% of R, facing the centre. Deathmatch respawns pick a rim
  position furthest from opponents.

## 5. Core mechanics

### 5.1 Movement and aim [SET]
Twin-stick: analog movement, independent 360 degree aim. In normal form aim is instantaneous (skill lives in
movement). In boss form aim and body turning are slew-limited (§5.5).

### 5.2 Projectiles: the normal-speed rule [SET]
- **Every projectile, whoever fires it, travels at 1.2 to 3.2 units/tick** (72 to 192 units/s), enforced by one cap in
  the code that spawns projectiles.
- No hitscan, no beams, no instant effects. Area effects are slow rings, delayed detonations, or shrapnel.
- One kind of object for all: owner (a seat or "neutral"), team, radius, damage, heading, speed, optional slow
  acceleration or curvature. Player and neutral bullets follow identical rules.
- **Readability [PROPOSED]:** hostile bullets are bright with a hard core; allied bullets are ghosted.
- **Weight through size, not speed:** heavy weapons fire larger, slower, harder-hitting projectiles.

### 5.3 Being hit: the damage window [SET]
- Tiny **core hurtbox** inside a larger body; bullets hurt only on touching the core.
- **A robot can only take X damage per window.** Damage is applied normally until the running total inside the current
  window reaches the robot's cap; further hits in that window do nothing (the bullet is still consumed and flashes).
  The window opens on the first damage and lasts `windowTicks`; then it resets.
- **Per-robot balance values:** `hp`, `windowCap`, `windowTicks`. Lower-hp, faster robots take a lower cap, so
  the quickest frame is not also unkillable, and the bulkiest can shrug off a heavy shell.

  | Frame | hp | cap per window (60 ticks) | Windows to die | Fastest possible death |
  |---|---|---|---|---|
  | VANGUARD | 120 | 24 | 5 | 4.0 s |
  | GALE | 88 | 16 | 6 | 5.0 s |
  | JUGGERNAUT | 220 | 44 | 5 | 4.0 s |
  The window is anchored: it opens on the first hit and closes `windowTicks` later, so relentless fire kills in exactly
  `(windows - 1) x windowTicks` ticks.
- In boss form the same rule applies to the **core**, which carries the robot's own hp and cap; armour and cannon parts
  have their own hit points and are not windowed (§5.5).

### 5.4 Graze and energy [SET: gauge and transformation; PROPOSED: sources]
Energy is a gauge of 1000 points. It fills from: grazing hostile bullets (near miss, once per bullet), damaging
opponents, destroying neutral units (they drop orbs), and being damaged (comeback). At or above the transform threshold
(500) the boss button transforms the frame. **In boss form, energy is fuel** (§5.5.3).

### 5.5 Boss form: "become the boss" [SET]

A **large, heavy, Gradius V style colossus**: a big articulated machine with a small glowing **core** at the centre,
surrounded by **armour plates** and **cannon pods**. Bullets hit the outer parts first; **only the core takes real
damage** (through the damage window, §5.3), and it can be reached only where the plates covering it are gone.
**Destroyed parts do not recover until the next transformation**, which restores every part.
The robot's health carries over unchanged: boss form is a shell of armour and guns around the same core.

**Weight principle [SET].** The boss is big and heavy, so every rule must say so, and every attack must be *reasoned*
from that weight and must *tell* the arena what is coming before it lands:
- **Inertia:** acceleration is a fraction of normal and top speed is about 55%. Starting and stopping take time.
- **Slow to turn, in layers:** the body slews slowly, each cannon pod slews faster than the body, and heavier mounts
  slew slower than light ones. Aim is no longer instant. **A gun fires along its own current facing, not along the
  cursor,** so where a gun points is where it will fire: the tell is always truthful, and a quick opponent can exploit
  the turn lag.
- **Every attack has a wind-up (the tell), a release and a recovery.** Nothing is machine-gunned.
- **Big means large and slow:** projectile radius 5 to 14 units, speed 1.2 to 2.4 units/tick, high damage. The danger
  area is wide, but it can be dodged because it moves slowly.
- **Recoil and root:** heavy attacks root the body while they charge and kick it backwards on release.
- **Fires from where the guns are:** every projectile spawns at a live pod's muzzle. A destroyed pod cannot fire, and
  destroying a pod during its wind-up cancels its shot (the energy is still spent).
- **Feedback:** camera shake and zoom-out, deep low-frequency sound, parts that visibly shift and recoil.

#### 5.5.1 Attacks [SET: three attacks on left click, right click and one more key; numbers PROPOSED]

| Input | Attack | Wind-up (tell) | Recovery | Energy cost |
|---|---|---|---|---|
| **Left click** (hold) | **Salvo**: basic boss spread, differs per robot | 12 ticks | 22 ticks | 5 |
| **Right click** | **Siege shot**: slower and heavier | 36 ticks, rooted | 45 ticks | 45 |
| **`E` / gamepad `X`** | **Ultima**: the final boss attack | 90 ticks, rooted | 120 ticks after a ~4 s barrage | 350 (needs at least that much energy) |

*Key choice:* the ultima gets its own key (`E` / gamepad `X`), separate from the transform button (`Space` / `Y`), so
it can never be triggered by mistake while tapping to transform.

#### 5.5.2 Every attack has a reason and a tell

| Attack | Reason: why a colossus attacks this way | Tell: what everyone sees and hears first | Answer: how it is beaten |
|---|---|---|---|
| **Salvo** | Its basic weapons are heavy cannon mounts that must swing round and cycle. They cannot aim precisely, so they fill space: a fan of large slow orbs that denies an area instead of hunting a target. | Pods swing toward the target (visible, slow slew), muzzles glow from dim to bright over 12 ticks, short rising tone. | Step through the gaps of the fan (slow orbs, known angles). Out-turn it: the pods lag. Shoot a pod to remove its share of the fan. |
| **Siege shot** | A heavy shell needs a planted platform to absorb the recoil, so the machine stops, braces, and spends time charging one huge slow shell that bursts into shrapnel. | Body stops and lowers, main barrel extends and glows white-hot, a soft marker shows the burst point, low rising hum, small camera zoom-out; on release the body is thrown backwards. | It is rooted: this is the window to attack the charging pod or the core, or to leave the burst area (the shell needs seconds to arrive). Destroying the charging pod cancels the shot. |
| **Ultima** | It dumps the whole reactor through every weapon at once. That is why it needs almost a full gauge, why the machine is locked in place while capacitors charge, and why it cannot do anything else. | Whole body lights up, plates unfold, energy lines flow from the core to each live pod (so you can see which pods will fire), the arena dims, a ring collapses inward, a loud tone rises for 1.5 s, and every player's HUD flags it. | Break pods during the charge (each dead pod loses its stream), then leave the dense zone: the spirals and rings are slow and full of gaps. Killing the core ends it. |

**Tell rules.** Each is enforced by code and checked by verification (§9), not left to art:
1. **Minimum wind-up:** Salvo at least 12 ticks, Siege 36, Ultima 90. No boss-attack projectile exists before its wind-up ends.
2. **One truth:** the wind-up state (which pods, how far along) lives in simulation memory. The view draws the tell
   from it and verification reads the same value, so the picture and the real attack cannot disagree.
3. **Heavier means longer:** longer wind-up, longer recovery and higher energy cost, in that order: Salvo < Siege < Ultima
   for every boss form.
4. **Recovery is the punish window [PROPOSED]:** pods that just fired are hot for the recovery time (take +50%
   damage), shown as glowing vents.
5. **Same speed cap:** every boss projectile still respects the 3.2 units/tick limit (§5.2).

#### 5.5.3 Energy is fuel [SET]
The gauge is 1000 points. Transformation needs 500. Boss form drains energy passively (about 21 per second) and **every
attack costs energy**: the more powerful the attack, the more it costs. **When energy reaches zero the boss form ends** and
the robot returns to normal with its remaining health; an expanding ring marks the end. Attackers gain energy for damage
they deal to a boss form and a bounty for killing one **[PROPOSED]**, so a boss form is a target the whole arena wants.

#### 5.5.4 Per-robot boss forms [PROPOSED: behaviour differs, weight is common]

| Robot | Boss form | Top speed | Body turn | Pod turn | Wind-ups (salvo / siege / ultima) | Character |
|---|---|---|---|---|---|---|
| VANGUARD | **PALADIN** | 1.2 | 1.5°/tick | cannons 3.0, prow 2.0 | 14 / 40 / 96 | balanced: wing plates and shoulder cannons; salvo = 5-fan; siege = seeker-bursting shell; ultima = rotating spiral |
| GALE | **TEMPEST** | 1.7 | 2.2°/tick | bits 4.5 | 12 / 36 / 90 | the lightest colossus: four orbiting bit cannons; salvo = aimed streams; siege = bit swarm of seekers; ultima = blade rings |
| JUGGERNAUT | **FORTRESS** | 0.8 | 0.9°/tick | turrets 2.0, mortar 1.0 | 18 / 48 / 110 | the heaviest: thickest armour, biggest shells; salvo = wide slow volley; siege = huge mortar; ultima = siege barrage |

### 5.6 The three robots in normal form [SET: archetypes; PROPOSED: kits]
Every weapon obeys the normal-speed rule.

| Robot | Trope | Primary | Alt (right click) | Speed |
|---|---|---|---|---|
| **VANGUARD** | versatile hero | 3-bullet fan rifle | two slow seeker orbs | 2.1 |
| **GALE** | fast striker | twin darts, high rate | phase dash with brief protection, leaves a delayed ring | 3.0 |
| **JUGGERNAUT** | heavy bunker | big slow mortar shell that bursts into shrapnel | bulwark arc: absorbs bullets into energy | 1.5 |

### 5.7 Neutral units [SET: exist; PROPOSED: behaviour]
Hostile to everyone: pressure and an energy source, never a substitute for PvP.
- Waves from the rim (about every 25 s, `2 + n/2` units), growing over the match.
- **Drone** (aimed bursts), **Sentinel** (slow rotating spiral), **Warden** (rare boss-pattern unit that drops a big
  energy payout: an objective players contest).

## 6. Controls

| | Keyboard + mouse | Gamepad |
|---|---|---|
| Move | `W A S D` | left stick |
| Aim | mouse cursor (or arrows) | right stick |
| Fire / **Salvo** | left click, `J` | `RT`, `A` |
| Alt / **Siege shot** | right click, `K` | `LT`, `B` |
| Transform | `Space` | `Y` |
| **Ultima** (boss form) | `E` | `X` |
| Pause | `Esc` | `Start` |

## 7. Presentation

### 7.1 Visual language: sleek vector mesh [SET]
- **Not pixel art.** Full-resolution rendering with anti-aliasing. No low-res target, dithering, mosaic or CRT.
- Hulls: faceted low-poly meshes drawn as **dark translucent faces with crisp glowing edges** in the team colour
  (8 distinct colour-blind-safe colours). Boss-form parts are visibly separate pieces that fall away when destroyed.
- Bullets: bright lozenges and rings with short additive trails. Explosions: expanding rings and line shards.
- Arena: near-black void, a faint world-space grid that makes scrolling readable, a luminous rim and safe-zone ring.
- Bloom is restrained; gameplay contrast comes from shape, brightness and motion.

### 7.2 Motion language
Everything eases. Hull banking, engine ribbons, springy recoil on small guns and **heavy, slow recoil on boss cannons**,
transformation as a morph (edges slide and unfold), camera lean and shake scaled to the weight of what just happened.
Rendering is interpolated between simulation ticks so high-refresh displays are smooth.

### 7.3 Interface
Clean sans type with wide tracking and thin vector frames. The local player's panel (health, damage-window meter,
energy, cooldowns) sits at the bottom; radar in a corner; opponents get compact tags; kill feed and timer on top.

### 7.4 Audio [PROPOSED]
Keep the procedural engine; retune to clean electronic. Small robots: light, crisp shots. Boss form: deep, slow,
low-frequency weight on every wind-up, salvo and impact.

## 8. Technical design

Kept from v0: deterministic fixed-point simulation, all state in one memory block, engine and game fully separated,
presentation reads the simulation and never writes to it.

**Engine [PROPOSED]** no seat cap by design: seat and peer ids 16-bit on the wire, replay presence a bitset; frame
packets peer-independent so one identical packet can be broadcast (a relay fans it out, so uplink does not grow with
player count); a machine may own several seats (bots, local players) or none.

**Simulation [PROPOSED]**
- Memory layout is built from the seat count at construction, so nothing is capped by a constant.
- One projectile pool with owner and team. Ships, boss-form parts, neutrals and orbs in fixed pools.
- The damage-window and boss-form rules (inertia, slew limits, wind-up and recovery state machines) are ordinary state
  in memory, driven only by inputs and prior state.
- A match state machine (countdown, battle, round end, sudden death, results) with the two round rules.
- Budget: 8 players plus neutrals, ~2000 projectiles, well under 0.3 ms per tick.

**Network:** relay rooms with a lobby (host starts; frames, teams, mode chosen; bots fill empty seats).

## 9. Verification plan

Same philosophy as v0 (no test framework; run the real thing): boundary lint; determinism audit and replay round-trip at
8 seats; lockstep over hostile networks with 8 peers; every rule asserted in headless bot matches (hit, graze, damage
window, energy, boss form parts and attacks and drain, respawn, elimination, sudden death, teams, no friendly fire); the
**normal-speed cap asserted over every projectile of full matches**; cross-engine replay proof; browser E2E with
multiple pages; visual review of the vector look at gameplay scale.

**Weight and tell checks (§5.5)** run over full matches in which bots use every boss attack:
- no boss-attack projectile is spawned before its wind-up reached the minimum (12 / 36 / 90 ticks);
- every boss projectile spawns at the muzzle of a live pod, along that pod's facing at release, and a pod destroyed
  during its wind-up spawns nothing;
- wind-up, recovery and cost are ordered Salvo < Siege < Ultima in every boss form;
- body and pod turn rates never exceed the configured limits, and speed and acceleration never exceed the boss-form
  limits (the weight rules);
- parts stay destroyed until the next transformation and are all restored by it; the core takes damage only through
  the damage window; boss form ends exactly when energy reaches zero.

## 10. Roadmap

1. Design sign-off (this document).
2. Engine v2: N-seat wire format, broadcast frames, multi-seat machines. Verified with the toy game first.
3. Simulation v1: arena, ships, unified projectiles, damage window, graze, energy, boss form, neutrals, modes, bots.
4. Vector renderer, camera, radar, robots and boss forms, neutral units, effects.
5. Interface, lobby and relay for up to 8 players and bots.
6. Audio retune, balance passes, browser E2E, cross-engine proof.

## 11. Risks

- **Readability in a big arena:** mitigated by radar, edge arrows, ghosted allied bullets and a projectile budget.
- **Encounters:** a large arena can be empty; neutral waves, energy orbs, the Warden objective and sudden death drive
  contact. Arena size is a single tunable.
- **Boss form balance:** a heavy colossus must be threatening but takeable: the parts system and wind-ups are the
  counterplay. Needs human playtests; v0 was only exercised by an autopilot.
- **Lockstep pace:** the slowest machine paces everyone. Mitigation: adaptive input delay, bots for absent players.

## 12. Open questions

1. **Boss-form contact:** should a boss form crush or shove small ships it touches? (proposed: shove only, no damage)
2. **Spectating:** eliminated players in Elimination watch; do we want a free camera or follow-the-killer?
3. **Bot difficulty levels** and whether bots count toward records.

## 13. Changes from v0

**Removed:** PvE stage scripts and scripted bosses (a boss-pattern unit survives as the neutral Warden), the hitscan
beam, every shot faster than 3.2 units/tick, the low-res dithered/CRT pipeline and bitmap font, the fixed 2-seat and
single-screen assumptions.
**Kept and evolved:** engine core, determinism tooling, the three-robot concept and boss-form idea, twin-stick input,
procedural audio, relay, the verification approach.
