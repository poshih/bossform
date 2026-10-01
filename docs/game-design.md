# BOSSFORM — Game Design Document

**Version 0.3 · living document.** Owner: designer (poshih) with engineering. v0.3 adds six robots (§5.6) and the rules
they needed (§1 decisions 8 to 11, §5.8).

Legend: **[SET]** decided by the designer · **[PROPOSED]** engineering proposal awaiting sign-off · **[OPEN]** undecided (§12).
All numbers are tuning starting points, not commitments. Units: 1 unit = 1 simulation unit; 60 ticks per second.

## 0. Why this document exists

The v0 prototype (solo / 2-seat PvE stages, 16-bit pixel look, fast shots, hitscan beam) was built on wrong assumptions.
This document replaces it. It is tagged `v0-prototype` in git; everything in it that contradicts this document is
scheduled for removal (§13).

## 1. Decisions so far

**Direction [SET]**
- Like **Senko no Ronde**: a mech **battle arena**, **mostly PvP**. **Enemy units** are an extra damage source.
- **Player bullets are normal speed, like enemy bullets. No instant or very fast shots.** *(v0.3: beams and hitscan are
  allowed behind a laser tell, decision 9; every projectile still obeys the speed cap.)*
- **Not 16-bit.** Sleek **vector mesh** visuals and fluid **motion**.
- **Up to 8 players for now, never limited by technology.** Same lockstep engine.
- Move and aim separately (twin-stick). Three tropey robot designs to start: **versatile / fast / heavy**. *(v0.3: nine,
  decision 8.)*

**Answers to the design questions [SET]**
1. **Match format:** generic teams (free-for-all = every player their own team).
2. **Round rule:** both selectable: Elimination rounds and Timed deathmatch.
3. **Boss form:** a large, heavy, **Gradius V style** boss with multiple attacks (§5.5).
4. **Arena:** **large scrolling arena with a follow camera** (§4).
5. **Lethality:** each robot can take at most **X damage per time window**, a per-robot balance value (§5.3).
6. **Boost dodge [SET]:** `Shift` bursts the robot toward where the pilot steers; its first instant dodges through
   bullets (§5.1).
7. **Shield and energy [SET]:** a robot that is not firing has its **energy shield** up; attacks and the shield share
   **one energy pool**, sized and refilled to keep the game fast (§5.4).

**Roster expansion, v0.3 [SET]**
8. **Nine robots.** The first three plus **LONGBOW** (sniper), **PRISM** (beam specialist), **HAILSTORM** (bomber, a walking
   arsenal), **RONIN** (samurai duelist), **SHADE** (stealth ninja) and **GAUNTLET** (super robot), each with its own boss
   form (§5.6, §5.5.4). Menus show them 3 × 3 in id order: the originals, the ranged specialists, the close-range specialists.
9. **Beams and hitscan are allowed, only after a thin laser tell that shows exactly where they will fire.** A robot's beam
   tells for at least 18 ticks; a robot's hitscan shot tells for at least 36 ticks along a locked direction; a boss beam's
   tell is its attack's wind-up (never shorter than the attack's minimum), drawn as thin lasers along each firing pod's line.
   A beam stops at the first hostile thing it meets: a shield bubble, a core, a boss part, a bulwark wedge, a parry arc, a
   neutral unit. Ordinary projectiles keep the speed cap.
10. **Indirect fire.** Lobbed shells (carpet bombs, artillery, bombardments) fly over everything and explode at a point on
    the floor; their landing marker and blast radius are visible from launch.
11. **Everything else stands:** damage windows; one energy pool for the shield and the weapons (a primary costs about 135
    energy a second and refires faster than the pool's refill delay); the shield is up while the pilot is not attacking;
    the shared boost; the boss tell rules (§5.5.2) and at most 12 boss parts. On touch the primary is held and the alt is a
    tap: every alt works as a tap.

## 2. Vision and pillars

*You are a mech in a huge arena full of slow, beautiful, lethal bullets. Read the patterns, thread the gaps, fire or
shield, boost through the gap, graze to fill your gauge, and when you are charged, become the boss: a colossus that the
others must take apart piece by piece.*

1. **Dodging is the game.** Every projectile is slow, visible and readable; every beam and rail shows its laser before it
   fires. Skill is positioning and pattern reading.
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
- **Follow camera [SET]:** follows the ship as it is drawn (interpolated) with a critically damped spring: no roll, and
  no lead toward the aim (the aim is read through the camera, so a camera that moves with the aim feeds back into the
  aim). It pulls back while the local player is in boss form. It shakes only when a colossus is destroyed near it; every
  other impact reads through light and motion. Never shows fog: other players are visible whenever they are in view.
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

Robots are responsive but not weightless: they brake twice as hard as they accelerate (`brake` and `accel` in
`FRAME_STATS`), so letting go stops a robot in 5 to 7 ticks with 4 to 6 units of slide, reversing at full speed takes 12 to
19 ticks, and a turn never adds speed. Boss forms keep one slow limit for every change of velocity: that is their weight.

**Boost [SET]** (`Shift`, pad `LB`; `FRAME_STATS[frame].boost`). A robot bursts toward the direction its pilot presses
(pressing nothing, toward where it aims) at 2.5 to 3.5 times its top speed for 12 ticks, then drops back to its top speed.
The **first 6 ticks are a dodge**: projectiles pass through the robot, and one that touches its core only grazes (so a
well-timed boost through a bullet fills the boss gauge). Held, it boosts again whenever the cooldown allows. Boss forms
never boost. A GALE phase dash cancels a running boost. Movement and aim stay independent: a robot fires while it boosts.

| Robot | Boost speed | Reach (12 ticks) | Cooldown |
|---|---|---|---|
| RONIN | 7.8 | 94 units | 40 ticks (0.67 s) |
| GALE | 7.5 | 90 units | 36 ticks (0.6 s) |
| SHADE | 7.2 | 86 units | 38 ticks (0.63 s) |
| VANGUARD | 6.5 | 78 units | 45 ticks (0.75 s) |
| PRISM | 6.4 | 77 units | 46 ticks (0.77 s) |
| GAUNTLET | 6.4 | 77 units | 48 ticks (0.8 s) |
| LONGBOW | 6.0 | 72 units | 52 ticks (0.87 s) |
| HAILSTORM | 6.0 | 72 units | 50 ticks (0.83 s) |
| JUGGERNAUT | 5.5 | 66 units | 54 ticks (0.9 s) |

### 5.2 Projectiles: the normal-speed rule [SET]
- **Every projectile, whoever fires it, travels at 1.2 to 3.2 units/tick** (72 to 192 units/s), enforced by one cap in
  the code that spawns projectiles. The one exception is a harmless inert fuse, which may stand still: the GALE dash leaves
  one where it began (it bursts into moving shrapnel), and mines wait in place until something comes close (§5.8).
- **Beams and hitscan only behind a laser tell [SET, v0.3]** (§1 decision 9, §5.8); nothing else is instant. Area effects
  are slow rings, delayed detonations, shrapnel, and blasts where lobbed shells land (their ring is shown from launch).
- Shots may also curve (SHADE's shuriken), come back to their owner (GAUNTLET's rocket fist), fly over everything to a
  point on the floor (lobbed shells), wait as mines, or shove the robot they strike (knockback); see §5.8.
- One kind of object for all: owner (a seat or "neutral"), team, radius, damage, heading, speed, optional slow
  acceleration or curvature. Player and neutral bullets follow identical rules.
- **Readability [PROPOSED]:** hostile bullets are bright with a hard core; allied bullets are ghosted.
- **Weight through size, not speed:** heavy weapons fire larger, slower, harder-hitting projectiles.

### 5.3 Being hit: the damage window [SET]
- In order, a hostile bullet meets: RONIN's parry arc, which sends it back (§5.8); JUGGERNAUT's bulwark wedge;
  protection (spawn, phase dash, a boost's dodge ticks), which lets it pass; the **shield** at the graze radius, if raised
  (§5.4), which stops it; then the core. A beam meets the same things in the same order along its line.
- Tiny **core hurtbox** inside a larger body; bullets hurt only on touching the core.
- **A robot can only take X damage per window.** Damage is applied normally until the running total inside the current
  window reaches the robot's cap; further hits in that window do nothing (the bullet is still consumed and flashes).
  The window opens on the first damage and lasts `windowTicks`; then it resets.
- **Per-robot balance values:** `hp`, `windowCap`, `windowTicks`. Lower-hp, faster robots take a lower cap, so
  the quickest frame is not also unkillable, and the bulkiest can shrug off a heavy shell.

  | Frame | hp | cap per window (60 ticks) | Windows to die | Fastest possible death |
  |---|---|---|---|---|
  | VANGUARD | 120 | 30 | 4 | 3.0 s |
  | GALE | 88 | 20 | 5 | 4.0 s |
  | JUGGERNAUT | 220 | 55 | 4 | 3.0 s |
  | LONGBOW | 96 | 24 | 4 | 3.0 s |
  | PRISM | 104 | 26 | 4 | 3.0 s |
  | HAILSTORM | 160 | 40 | 4 | 3.0 s |
  | RONIN | 110 | 26 | 5 | 4.0 s |
  | SHADE | 84 | 20 | 5 | 4.0 s |
  | GAUNTLET | 190 | 46 | 5 | 4.0 s |
  The window is anchored: it opens on the first hit and closes `windowTicks` later, so relentless fire kills in exactly
  `(windows - 1) x windowTicks` ticks.
- In boss form the same rule applies to the **core**, which carries the robot's own hp and cap; armour and cannon parts
  have their own hit points and are not windowed (§5.5).

### 5.4 Energy, the shield and the boss gauge [SET]
Two resources, never to be confused:

**Energy (the pool) [SET]** — 1000 per robot, one pool that powers **both the shield and every weapon** (`energy.ts`).
- **Weapons pay per shot** (`cost` in `frames.ts`): each primary weapon drains a full pool in about **7 s of continuous
  fire** (VANGUARD rifle 20 per volley, GALE darts 11, JUGGERNAUT mortar 80, HAILSTORM 7 per round, RONIN 32 per slash,
  SHADE 22 per throw, GAUNTLET 27 per shot; LONGBOW pays 2 per tick while it charges, PRISM 2 per tick of beam tell and 3
  per tick of beam). Alts: VANGUARD's seekers 100, LONGBOW's tripmine 100, PRISM's lance 160, HAILSTORM's carpet bomb 200,
  SHADE's veil 150, GAUNTLET's rocket punch 120; the phase dash, the bulwark and the parry are free. A weapon whose cost
  the pool cannot pay stays silent (a charge holds, a beam ends).
- **It refills fast**: 20 per tick (empty to full in 0.8 s), starting 0.6 s after the last spend (a shot or a stopped
  bullet). That delay is longer than any weapon's refire, so a pilot who keeps firing never refills: bursts, then breathe.
- **The shield is up whenever the pilot is not attacking.** Holding a weapon's button (fire; the alts that are attacks:
  VANGUARD's seekers, PRISM's lance, HAILSTORM's carpet bomb, GAUNTLET's rocket punch) drops it on that very tick; it
  returns 12 ticks (0.2 s) after the button is released, if the pool holds at least 100. GALE's phase dash, LONGBOW's
  tripmine, RONIN's parry and SHADE's veil are not attacks, but the shield stays down while a parry or a lance tell runs;
  JUGGERNAUT's bulwark takes the shield's place while raised (it covers the front only).
- **The shield is a bubble at the graze radius** (15 to 22 units: SHADE 15, GALE 16, LONGBOW and RONIN 17, VANGUARD and
  PRISM 18, HAILSTORM 20, GAUNTLET 21, JUGGERNAUT 22): whatever hostile reaches it is stopped and
  smothered (a shell does not burst), and the pool pays **20 per point of damage**, so a full pool stops 50 damage. A pool
  that cannot pay still stops that bullet, then the shield **shatters**: the pool is empty and the shield stays down for
  2 s. Stopped bullets pay the shooter's boss gauge as a hit would; the shielded pilot earns nothing (no damage taken).
- Boss forms and transforming robots have no shield and spend no energy (their attacks burn the boss gauge); the pool
  keeps refilling for when the colossus folds back.
- JUGGERNAUT's bulwark swallows bullets in its wedge for the same price per point of damage (it catches only what the
  pool can pay for) and still pays the boss gauge per bullet.
- Pace (bot matches, `tools/verify/balance.ts`): robots have their shield up about 10 to 15% of the time (bots attack
  most of the time), boost 10 to 13 times a minute and first transform after about 35 to 37 s; pilots die 0.5 (elimination)
  to 0.7 (deathmatch) times a minute, against about 1.0 in deathmatch before the shield existed. The window caps were
  raised from 24 / 16 / 44 to the values above to win part of that back; fights are more about breaking a shield, then
  punishing the pilot who has to attack without one.

**Boss gauge [SET: gauge and transformation; PROPOSED: sources]** — 1000 points. It fills from: grazing hostile
bullets (near miss, once per bullet, 4 points), damaging opponents or their shields (0.35 per point), destroying
neutral units (they drop orbs), and being damaged (0.4 per point: comeback). At or above the transform threshold (500)
the boss button transforms the frame. **In boss form, the gauge is fuel** (§5.5.3).

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
- **Big means large and slow:** projectile radius mostly 5 to 14 units, speed mostly 1.2 to 2.4 units/tick, high damage.
  The danger area is wide, but it can be dodged because it moves slowly. (BALLISTA's needles are the exception: thin and
  as fast as the cap allows, told by the longest wind-ups of their class.)
- **Recoil and root:** heavy attacks root the body while they charge and kick it backwards on release.
- **Fires from where the guns are:** every projectile spawns at a live pod's muzzle. A destroyed pod cannot fire, and
  destroying a pod during its wind-up cancels its shot (the energy is still spent); if every pod an attack needs is gone,
  nothing is released and the machine goes straight into its recovery. Salvo and siege fire along the pod's facing; the
  ultima's pods are radial emitters: each fires its spiral and its ring all around its own muzzle. A beam attack fires from
  each firing pod along its facing during the release and sweeps only as fast as the pod turns; artillery lobs shells from
  the pods to points on the floor around a target; a carpet lays a line of bombs along the pod's facing; a wheel ultima
  turns a beam outward from every live ultima pod; a bombardment rains shells around the target from every live ultima pod.
  Every ultima also keeps its rings.
- **Feedback:** a deep zoom-out and low-frequency sound, parts that visibly shift and recoil. The camera itself only shakes
  when a colossus is destroyed (the rare big explosion); every other impact is shown by effects and a brief colour punch.

#### 5.5.1 Attacks [SET: three attacks on left click, right click and one more key; numbers PROPOSED]

| Input | Attack | Wind-up (tell) | Recovery | Energy cost |
|---|---|---|---|---|
| **Left click** (hold) | **Salvo**: basic boss spread, differs per robot | 12 to 18 ticks | 18 to 30 ticks | 5 to 8 |
| **Right click** | **Siege shot**: slower and heavier | 36 to 50 ticks, rooted | 40 to 60 ticks | 45 to 55 |
| **`E` / gamepad `X`** | **Ultima**: the final boss attack | 90 to 110 ticks, rooted, then a 4 s barrage | 120 to 150 ticks; 10 to 12 s cooldown | 300 to 330 |

The exact numbers per boss form are in §5.5.4.

**An attack needs its whole fuel up front.** It starts only if the tank holds its cost plus all the fuel its wind-up, the
ultima's barrage and its recovery will burn (`attackFuel` in `sim/boss.ts`; the HUD's energy-bar markers and the bots use
the same rule). So a colossus never folds back in the middle of a tell (the tell never lies) and the recovery, the punish
window, always happens. In numbers: a salvo needs about 15 points, a siege shot about 70, the ultima 430 to 470: most of
what a transformation starts with. An attack also needs a live pod of its role.

*Key choice:* the ultima gets its own key (`E` / gamepad `X`), separate from the transform button (`Space` / `Y`), so
it can never be triggered by mistake while tapping to transform.

#### 5.5.2 Every attack has a reason and a tell

| Attack | Reason: why a colossus attacks this way | Tell: what everyone sees and hears first | Answer: how it is beaten |
|---|---|---|---|
| **Salvo** | Its basic weapons are heavy cannon mounts that must swing round and cycle. They cannot aim precisely, so they fill space: a fan of large slow orbs that denies an area instead of hunting a target. | Pods swing toward the target (visible, slow slew), muzzles glow from dim to bright over 12 ticks, short rising tone. | Step through the gaps of the fan (slow orbs, known angles). Out-turn it: the pods lag. Shoot a pod to remove its share of the fan. |
| **Siege shot** | A heavy shell needs a planted platform to absorb the recoil, so the machine stops, braces, and spends time charging one huge slow shell that bursts into shrapnel. | Body stops and lowers, main barrel extends and glows white-hot, a soft marker shows the burst point, low rising hum; on release the body is thrown backwards. | It is rooted: this is the window to attack the charging pod or the core, or to leave the burst area (the shell needs seconds to arrive). Destroying the charging pod cancels the shot. |
| **Ultima** | It dumps the whole reactor through every weapon at once. That is why it needs most of the energy a transformation starts with, why the machine is locked in place while capacitors charge, and why it cannot do anything else. | Whole body lights up, plates unfold, energy lines flow from the core to each live pod (so you can see which pods will fire), the arena dims, a ring collapses inward, a loud tone rises for 1.5 s, and every player's HUD flags it. | Break pods during the charge (each dead pod loses its spiral and its share of the rings; with no ultima pod left it cannot start, and it stops the moment the last one falls), then leave the dense zone: the spirals and rings are slow and full of gaps. Killing the core ends it. |

**Tell rules.** Each is enforced by code and checked by verification (§9), not left to art:
1. **Minimum wind-up:** Salvo at least 12 ticks, Siege 36, Ultima 90. No boss-attack projectile exists before its wind-up ends.
2. **One truth:** the wind-up state (which pods, how far along) lives in simulation memory. The view draws the tell
   from it and verification reads the same value, so the picture and the real attack cannot disagree.
3. **Heavier means longer:** longer wind-up, longer recovery and higher energy cost, in that order: Salvo < Siege < Ultima
   for every boss form.
4. **Recovery is the punish window [PROPOSED]:** pods that just fired are hot for the recovery time (take +50%
   damage), shown as glowing vents.
5. **Same speed cap:** every boss projectile still respects the 3.2 units/tick limit (§5.2).
6. **Beams and lobs are told too [SET, v0.3]:** a beam attack's wind-up draws a thin laser along each firing pod's line (the
   pod keeps turning, so the laser always shows where it points now); a lobbed shell shows its landing marker and blast
   radius from the moment it is launched.

#### 5.5.3 Energy is fuel [SET]
The gauge is 1000 points. Transformation needs 500. Boss form drains energy passively (about 17 per second) and **every
attack costs energy**: the more powerful the attack, the more it costs. **When energy reaches zero the boss form ends** and
the robot returns to normal with its remaining health; an expanding ring marks the end. Attackers gain energy for damage
they deal to a boss form and a bounty for killing one **[PROPOSED]**, so a boss form is a target the whole arena wants.

#### 5.5.4 Per-robot boss forms [PROPOSED: behaviour differs, weight is common]

| Robot | Boss form | Top speed | Body turn | Pod turn | Size (reach) | Parts (hit points) | Character |
|---|---|---|---|---|---|---|---|
| VANGUARD | **PALADIN** | 1.2 | 1.5°/tick | cannons 3.0, prow 2.0 | 69 units | 7 (854) | balanced: wing plates and shoulder cannons; salvo = 5-fan; siege = seeker-bursting shell; ultima = rotating spiral |
| GALE | **TEMPEST** | 1.7 | 2.2°/tick | bits 4.5 | 57 units | 6 (504) | the lightest colossus: four orbiting bit cannons; salvo = aimed streams; siege = bit swarm of seekers; ultima = blade rings |
| JUGGERNAUT | **FORTRESS** | 0.8 | 0.9°/tick | turrets 2.0, mortar 1.0 | 96 units | 9 (1736) | the heaviest: thickest armour, biggest shells; salvo = wide slow volley; siege = huge mortar; ultima = siege barrage |
| LONGBOW | **BALLISTA** | 1.0 | 1.1°/tick | flechette guns 3.0, lenses 2.4, rail 1.2 | 78 units | 9 (938) | a siege bow: rail spine, swept bow limbs; salvo = FLECHETTE needles; siege = RAIL SHOT, one huge fast needle; ultima = ARROW RAIN, a bombardment around the target |
| PRISM | **HELIOS** | 1.1 | 1.4°/tick | prisms 3.0, focus 0.6 | 68 units | 9 (896) | a floating sun disk with four orbiting prisms; salvo = PRISM LANCES, short beams; siege = SOLAR CANNON, a long wide beam; ultima = HALO WHEEL, turning spokes of light |
| HAILSTORM | **ARMADA** | 0.9 | 1.0°/tick | gatlings 2.8, missile silos 2.0 | 78 units | 9 (1274) | a flying warship; salvo = BROADSIDE; siege = MISSILE CARNIVAL, a swarm of seekers; ultima = CARPET BOMBARDMENT |
| RONIN | **SHOGUN** | 1.3 | 1.8°/tick | arm blades 3.2, banners 2.6, great sword 2.0 | 72 units | 11 (1092) | a crested warlord; salvo = CRESCENT slashes; siege = ISSEN, a sword-beam flash from the great sword; ultima = THOUSAND CUTS, slashing spirals |
| SHADE | **KITSUNE** | 1.6 | 2.0°/tick | tails 3.0 | 64 units | 11 (728) | a nine-tailed fox, the most pods and the thinnest armour; salvo = FOXFIRE; siege = FOXFIRE SNARE, lobbed foxfire that becomes a mine field; ultima = NIGHT PARADE |
| GAUNTLET | **ATLAS** | 1.0 | 1.2°/tick | fists 2.2, boosters 2.0 | 95 units | 9 (1204) | a super robot colossus; salvo = KNUCKLE BARRAGE; siege = GIGA ROCKET PUNCH, a giant fist that comes back; ultima = FINAL BREAKER |

Colossi are drawn and built at 150% of their design size (core 125%, part hit points 140%) so they dwarf the robot they
come from. A part is a circle in body space; the model draws each part where and as large as the table says.

Attack numbers per form, as wind-up / recovery ticks / energy cost (the ordering Salvo < Siege < Ultima holds in every column):

| Boss form | Salvo | Siege | Ultima (barrage 4 s, cooldown) |
|---|---|---|---|
| PALADIN | 14 / 22 / 5 | 40 / 45 / 45 | 96 / 130 / 300 (10 s) |
| TEMPEST | 12 / 18 / 5 | 36 / 40 / 45 | 90 / 120 / 300 (10 s) |
| FORTRESS | 18 / 30 / 8 | 48 / 60 / 55 | 110 / 150 / 330 (12 s) |
| BALLISTA | 16 / 24 / 6 | 46 / 52 / 50 | 100 / 136 / 310 (11 s) |
| HELIOS | 18 / 26 / 6.5 | 50 / 60 / 52 | 104 / 140 / 320 (11.7 s) |
| ARMADA | 16 / 26 / 6.5 | 42 / 52 / 50 | 104 / 140 / 320 (11.3 s) |
| SHOGUN | 14 / 22 / 5.5 | 40 / 48 / 48 | 98 / 135 / 310 (10.7 s) |
| KITSUNE | 12 / 18 / 5 | 38 / 44 / 46 | 94 / 128 / 305 (10.3 s) |
| ATLAS | 15 / 24 / 6 | 42 / 56 / 52 | 106 / 146 / 325 (11.7 s) |

### 5.6 The nine robots in normal form [SET: archetypes and kits (v0.3); PROPOSED: numbers]
Every projectile obeys the normal-speed rule; beams and the lance obey the laser-tell rule (§5.8).

| Robot | Trope | Primary | Alt (right click / tap) | Speed |
|---|---|---|---|---|
| **VANGUARD** | versatile hero | FAN RIFLE: 3-bullet fan | SEEKERS: two slow seeker orbs | 2.1 |
| **GALE** | fast striker | TWIN DARTS, high rate | PHASE DASH with brief protection, leaves a delayed ring | 3.0 |
| **JUGGERNAUT** | heavy bunker | MORTAR: big slow shell that bursts into shrapnel | BULWARK arc: swallows bullets into its boss gauge (paid from energy) | 1.5 |
| **LONGBOW** | sniper | RAIL RIFLE: hold to charge, release fires a needle by charge tier | TRIPMINE: a mine at its feet | 1.9 |
| **PRISM** | beam specialist | PRISM BEAM: held beam after a short laser tell | LANCE: a told hitscan rail along a locked line | 2.0 |
| **HAILSTORM** | bomber, walking arsenal | ROTARY CANNON: spins up the longer it fires | CARPET BOMB: six bombs lobbed in a line | 1.8 |
| **RONIN** | samurai duelist | KATANA: a short, wide fan of slashes | PARRY: a guard arc that sends shots back | 2.6 |
| **SHADE** | stealth ninja | SHURIKEN: two stars that curve across the aim line | SHADOW VEIL: 2.5 s of cloak | 2.8 |
| **GAUNTLET** | super robot | KNUCKLE CANNON: alternating shots that shove | ROCKET PUNCH: a fist that flies out and comes back | 1.9 |

The six specialists, as they are meant to play:
- **LONGBOW** wins from far away and loses up close. A FULL charge (1 s) hits hard and fast; a SNAP shot is a quick poke.
  Its mines guard the flanks it cannot watch. The charge line tells everyone where it aims, and brightens as it fills.
- **PRISM** trades damage for honesty: every beam is announced by its laser, then sweeps slowly toward the aim. The LANCE is
  the hardest single hit in normal form and the most visible: 0.7 s of a locked, pulsing line.
- **HAILSTORM** is big, slow and relentless: its cannon is weak at first and a hose once spun up, and its carpet bombs
  deny a strip of ground (the landing rings show where, and the nearest bombs land first).
- **RONIN** must get close: its katana reaches about 75 units. The PARRY is its way in: timed well, it sends a volley back
  and shortens its own cooldown.
- **SHADE** is fragile and elusive: the veil hides it from eyes, radar and ears; the first throw out of it is an ambush.
  Damage or a shield stop breaks the veil.
- **GAUNTLET** is the heaviest brawler: knuckle shots shove what they strike, and the rocket fist can hit on the way out
  and on the way back.

### 5.7 Neutral units [SET: exist; PROPOSED: behaviour]
Hostile to everyone: pressure and an energy source, never a substitute for PvP.
- Waves from the rim (about every 25 s, `2 + n/2` units), growing over the match.
- **Drone** (aimed bursts), **Sentinel** (slow rotating spiral), **Warden** (rare boss-pattern unit that drops a big
  energy payout: an objective players contest).

### 5.8 New mechanics (v0.3) [SET: rules; PROPOSED: numbers]
- **Charge (LONGBOW).** Holding fire charges up to 60 ticks at 2 energy a tick (a tick the pool cannot pay holds the
  charge). Release fires by tier: SNAP from 12 ticks (10 damage), HALF from 36 (18), FULL at 60 (30, at the speed cap);
  below 12 nothing fires, and a charge still held when the round ends is dropped, not fired. Every pilot sees the
  charging robot's aim line brighten; a glint marks FULL.
- **Mines (LONGBOW's tripmine, KITSUNE's snare).** Inert discs that arm after a short delay (36 ticks; 20 for the snare)
  and burst into shrapnel when a hostile fighting body or a neutral unit comes within their trigger radius (40 units; 34),
  cloaked pilots included. Visible to all, with a faint trigger ring once armed.
- **Beams (PRISM, HELIOS, SHOGUN's ISSEN).** PRISM's beam tells for 18 ticks, then fires while fire is held: 360 units
  long, 3 damage every 6 ticks to the first hostile thing on its line, turning toward the aim at 1.2° a tick; 2 energy a
  tick in the tell, 3 while firing. It starts only with 39 energy in the pool (the whole tell and the first firing tick),
  so a tell always ends in a beam. A colossus's beam fires from each firing pod along its facing during the release.
- **Lance (PRISM).** A hitscan rail behind a 42-tick tell: the direction locks at the tap, a bright laser shows the exact
  line and pulses faster near the end; PRISM braces (a running boost ends, it stops where it stands and cannot boost, so
  the line stays put), the shield stays down and the beam cannot fire meanwhile. Then one instant rail, 900 units long,
  26 damage to the first thing it meets.
- **Spin-up (HAILSTORM).** The rotary cannon starts at 6 rounds a second and gains speed with every round, up to 20 a
  second; the spin runs down while the trigger is released.
- **Carpet bombing (HAILSTORM, ARMADA).** Bombs lobbed in a line along the aim or a pod's facing; the nearest land first.
  Each blast hurts every hostile robot core and boss part inside its radius (a raised shield absorbs it; protection and a
  boost's dodge keep a robot safe from it, as from every other hit).
- **Artillery and bombardment (BALLISTA, KITSUNE).** Shells lobbed to points around a target: the nearest targetable
  hostile within 30° of the pod's facing and within range, else the point at range along the facing.
- **Parry (RONIN).** 14 ticks of a front guard arc (36 units, ±80°): hostile shots entering it fly back along RONIN's aim as
  RONIN's own, at the same speed and damage; beams entering it are cut. The first reflection shortens the cooldown to 50
  ticks (the riposte). Free, and not an attack, but the shield is down and the katana cannot cut while it is up.
- **Cloak (SHADE).** For 150 ticks opponents see at most a faint shimmer when it moves fast: no radar dot, name tag,
  pointer, boost trail, graze spark or sound except its shots; its own team sees it translucent. Seekers and neutral units
  ignore it (mines do not), orbs are not pulled toward it, and a beam's tell (or a beam between its damage pulses) passes
  through it: only a pulse finds it. Damage, a shield stop, firing, transforming, dying or leaving reveal it.
- **Boomerang (GAUNTLET's rocket fist, ATLAS's giga punch).** Flies out until its turn point or its first strike (which
  turns it at once), then homes back to its owner and may strike again (never the same target twice in a row); caught
  within the owner's pickup radius. Its owner cannot launch another while one is out.
- **Knockback.** Knuckle shots and fists shove a robot they strike on the core or the shield, along their heading (never
  through a bulwark, never a protected or dodging robot, never a colossus).

## 6. Controls

| | Keyboard + mouse | Gamepad | Touch (landscape) |
|---|---|---|---|
| Move | `W A S D` | left stick | drag left thumb |
| Aim | mouse cursor (or arrows) | right stick | drag right thumb |
| Fire / **Salvo** | left click, `J` | `RT`, `RB`, `A` | push the right drag outward |
| Alt / **Siege shot** | right click, `K` | `LT`, `B` | tap right |
| **Boost** (robot) | `Shift` | `LB` | tap left |
| Transform | `Space` | `Y` | hold both thumbs |
| **Ultima** (boss form) | `E` | `X` | hold both thumbs |
| Pause | `Esc`, `P` | `Start` | tap both thumbs |
| Mute | `M` | none | pause menu |

Mobile play uses floating twin-stick gestures with only a faint trace under each active thumb. Essential status moves to a
thin safe-area-aware strip at the top. Landscape is the supported orientation; rotating does not restart or alter the match.
The controls are the same for all nine robots: the primary is held (LONGBOW charges while it is held and fires on release;
PRISM's beam fires while it is held) and every alt works as a single tap.

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
transformation as a morph (edges slide and unfold). Impacts are sold with light (flashes, a bloom punch) and motion,
not with the camera, which stays steady (§4). Accents pulse on the music's beat. Rendering is interpolated between
simulation ticks so high-refresh displays are smooth.

### 7.3 Interface
Clean sans type with wide tracking and thin vector frames. The local player's panel (health, damage-window meter,
energy, cooldowns) sits at the bottom; radar in a corner; opponents get compact tags; kill feed and timer on top. The
panel names the robot's own primary and alt and reads their state: LONGBOW's charge tier, PRISM's beam, HAILSTORM's spin,
SHADE's ambush; the alt as READY, cooling down, or running (LANCE 0.4S, GUARD, CLOAKED 1.8S, IN FLIGHT). A cloaked
opponent has no radar dot, name tag or edge pointer.

### 7.4 Audio [SET]
Procedural, no assets. Small robots: light, crisp shots. Boss form: deep, slow, low-frequency weight on every wind-up,
salvo and impact. Each colossus winds up in its own voice (BALLISTA a rail whine, HELIOS a chord of light, ARMADA a klaxon,
SHOGUN drawn steel and war drums, KITSUNE shrine bells, ATLAS an engine spooling up); live beams hum while they burn; a
cloaked pilot makes no sound its opponents can hear except its shots and its reveal.

Music is arcade trance, synthesized in the browser (a worker renders 8-bar sections while the previous ones play):
- **Title** 136 BPM, 16 bars, E minor.
- **In-match** tracks share 145 BPM, so they switch on the bar grid without a tempo jump:
  - **battle** is 64 bars in song form: intro, theme, build, drop, breakdown, build, final drop, and a bridge back to the
    loop start;
  - **boss form** (32 bars, a darker motif) plays while a colossus is near the local player;
  - **sudden death** (32 bars, an alarm lead) plays once the storm closes in.
- **Victory and defeat** stingers.

Loops sit at about -15 LUFS integrated with true peaks under -1 dBTP. Battle's energy follows its form: the intro sits
at least 3 LU under the drop, builds rise, and the breakdown drops the drums, not the music.

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
- every boss projectile spawns at the muzzle of a live pod (salvo and siege along that pod's facing at release, ultima
  spirals and rings all around it), and a pod destroyed during its wind-up spawns nothing;
- wind-up, recovery and cost are ordered Salvo < Siege < Ultima in every boss form;
- body and pod turn rates never exceed the configured limits, and speed and acceleration never exceed the boss-form
  limits (the weight rules);
- parts stay destroyed until the next transformation and are all restored by it; the core takes damage only through
  the damage window; boss form ends exactly when energy reaches zero.

## 10. Roadmap

Status: steps 1 to 5 are built and verified (engine v2, simulation v1, vector client, lobby and relay); step 6 is
partly done (audio and E2E and the cross-engine proof exist; balance still needs human play).

1. Design sign-off (this document).
2. Engine v2: N-seat wire format, broadcast frames, multi-seat machines. Verified with the toy game first.
3. Simulation v1: arena, ships, unified projectiles, damage window, graze, boss gauge, boss form, neutrals, modes, bots; v4 adds energy, the shield and the boost.
4. Vector renderer, camera, radar, robots and boss forms, neutral units, effects.
5. Interface, lobby and relay for up to 8 players and bots.
6. Audio retune, balance passes, browser E2E, cross-engine proof.
7. Roster expansion (v0.3, simulation v5): six robots and their colossi, beams and the lance, lobbed shells, mines, the
   parry, the cloak, boomerang fists and knockback, each with a bespoke model and bot tactics. Next: tuning from human
   play.

## 11. Risks

- **Readability in a big arena:** mitigated by radar, edge arrows, ghosted allied bullets and a projectile budget.
- **Encounters:** a large arena can be empty; neutral waves, gauge orbs, the Warden objective and sudden death drive
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
single-screen assumptions. (v0.3 brings beams and a hitscan lance back, only behind a laser tell: §1 decision 9.)
**Kept and evolved:** engine core, determinism tooling, the three-robot concept and boss-form idea, twin-stick input,
procedural audio, relay, the verification approach.
