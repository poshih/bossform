# BOSSFORM

A **vector mech battle arena** in the spirit of *Senko no Ronde*: up to eight pilots (players and bots, in teams or
free-for-all) fight in a large circular arena where **every bullet is slow and readable**. Move and aim separately, graze
bullets for energy, and when the gauge is charged **become the boss**: a huge, heavy colossus with armour plates and
cannon pods that everyone else has to take apart piece by piece. Its attacks are told before they land.

It is built on **METRONOME**, a standalone deterministic lockstep engine, and the game is kept strictly separate from it.
Stack: Vite + TypeScript + Three.js (full-resolution MSAA + bloom, sleek vector meshes, procedural audio, no assets).

- Design: [`docs/game-design.md`](docs/game-design.md) (v0.2, the source of truth for rules and numbers)
- Client architecture and contracts: [`docs/client-architecture.md`](docs/client-architecture.md)
- Engine: [`engine/README.md`](engine/README.md)

```
engine/   @metronome/engine   deterministic lockstep engine: zero dependencies, no DOM, no Node, no game vocabulary
game/     @bossform/game      the game: deterministic sim (game/src/sim) + Three.js/DOM presentation
tools/    verify/ relay/      eval scripts (no test framework) and a dev WebSocket relay + room lobby
docs/                         game design, client architecture
```

## Play

```sh
npm install
npm run dev          # http://127.0.0.1:4427
npm run build        # typecheck everything, then game/dist (relative paths, ~220 KB gzip)
```

| | Keyboard + mouse | Gamepad |
|---|---|---|
| Move | `W A S D` | left stick |
| Aim (independent of movement) | mouse cursor (or arrow keys) | right stick |
| Fire / boss **Salvo** | left click, `J` | `RT`, `RB`, `A` |
| Alt / boss **Siege shot** | right click, `K` | `LT`, `B` |
| **Boost** (robot; its first instant dodges through bullets) | `Shift` | `LB` |
| **Transform** (boss gauge at least 50%) | `Space` | `Y` |
| Boss **Ultima** | `E` | `X` |
| Pause / mute | `Esc` `P` / `M` | `Start` |

**Modes.** *Elimination*: one life per round, last team standing, best of three; after 75 s the safe zone shrinks and the
storm hurts everything outside it. *Deathmatch*: score kills, respawn after 3 s, 3 minutes. Teams are free labels (2v2,
4v4, free-for-all). Bots fill any seat and are ordinary input sources.

**The rules that make it this game.** No projectile of any owner is ever faster than 3.2 units per tick: one cap,
enforced where projectiles are made and moved. Only a tiny core is vulnerable. A robot can take **at most its cap of
damage per window** (a per-robot balance value: lighter, faster robots take less). **A robot that is not firing has its
shield up**, and the shield and the guns share **one energy pool** (about 7 s of continuous fire, refilled in under 1.5 s
once the pilot lets go): attacking costs your guard. Grazing bullets, dealing and taking damage, and orbs fill the **boss
gauge**, which transforms the robot.

### The three robots and their boss forms

| Robot | Trope | Primary | Alt | Boss form |
|---|---|---|---|---|
| **VANGUARD** | versatile hero | 3-bullet fan rifle | two slow seeker orbs | **PALADIN**: plates, wing panels, shoulder cannons, prow lance |
| **GALE** | fast striker | twin darts | phase dash (protected) leaving a delayed ring | **TEMPEST**: the lightest colossus, four orbiting bit cannons |
| **JUGGERNAUT** | heavy bunker | slow mortar shell that bursts into shrapnel | bulwark wedge that swallows bullets into its boss gauge | **FORTRESS**: the heaviest, nine parts, a huge mortar |

### The boss form (the designer's brief: large, heavy, told)

Transform (46 ticks, safe while it unfolds) into a machine with an armoured body around a small core. Bullets hit plates
and pods first; **only the core hurts the pilot**, and only where no live plate covers it. Destroyed parts stay
destroyed until the next transformation. The body and every pod turn slowly and heavily, and **a gun fires where it points**.
The boss gauge is fuel: it burns steadily and every attack costs some; at zero the machine folds back into the robot.

| Attack | Input | Wind-up (the tell) | Character |
|---|---|---|---|
| **Salvo** | left click | 12 to 18 ticks | a fan of large slow orbs from each live cannon |
| **Siege shot** | right click | 36 to 48 ticks, rooted | one huge slow shell that bursts; aim lines and a burst marker show where |
| **Ultima** | `E` | 90 to 110 ticks, rooted | spirals and rings; everyone's HUD and speakers announce it |

No boss projectile can exist before its wind-up ends, every shot leaves a live pod's muzzle, and heavier attacks wind up
longer, recover longer and cost more: these are enforced in code and checked by the evals (see below).

## Architecture: no leaking between engine and game

- `engine/` imports nothing but itself, compiles with `lib: ES2023` and **no ambient types** (it cannot touch the DOM or
  Node), has zero dependencies and no game vocabulary. It knows three contracts: a `Simulation` (state memory + `step`),
  an `InputCodec` and a `Transport`.
- `game/src/sim/` implements them, imports only `@metronome/engine` and itself, and uses no floats outside
  `fx.lit/deg/turns` constants, no `Math.random/sin/cos/pow/sqrt/hypot`, no `Date`, no `Map/Set`. Its memory layout is built
  from the seat count, so nothing caps the number of pilots (the game rule is 8; verified up to 16 in evals).
- `game/src/{view,ui,audio,render}` only **read** the simulation (through `sim/index.ts`) and never write to it.
- All of this is enforced mechanically by `tools/verify/boundary.ts`.

## How determinism is achieved (and proven)

- **Numbers**: Q16.16 fixed point in `Int32Array`; `sqrt` is a `Math.sqrt` guess corrected by an exact integer fix-up;
  `sin/cos/atan2` come from tables built from IEEE-exact operations. Distances in the big arena use a shifted `radial()`.
- **State**: everything that affects a future tick lives in one `ArrayBuffer` (`SimMemory`), RNG included.
- **Lockstep** (engine v2): input delay, redundant un-acked input resend, stall until every seat's input is present, 64-bit
  checksums (a desync aborts loudly), a handshake hash over parameters + input encoding + memory layout, graceful leave,
  timeouts, replays. Seat and peer ids are 16-bit, frames are identical for every recipient so one broadcast serves all
  peers, and the relay fans out; a machine may own many seats (the host owns the bots).

Proof, all against the real game: replays of 8-pilot deathmatch, a whole 2v2 elimination match and a 12-pilot match are
bit-identical on **V8 (Node, Chromium), SpiderMonkey (Firefox) and JavaScriptCore (WebKit)**; eight simulated machines over
a lossy, jittery, duplicating network stay bit-identical (one leaving mid-match); Chromium and WebKit tabs play a real
online match through the relay.

## Verify

```sh
npm run typecheck
npm run verify            # headless (~2 min): architecture, numerics, engine lockstep / hostile network / scale, and the
                          #   game rules on the real simulation: definitions, movement and boost, damage window, graze,
                          #   teams, energy and the shield, the boss gauge,
                          #   boss form (parts, core rule, every attack's tell, cost, cancellation), neutrals, elimination,
                          #   sudden death, deathmatch, full bot matches watched tick by tick, determinism, scale
npm run verify:browsers   # builds, serves under a strict CSP, then real-browser E2E (menus, keyboard + mouse, gamepad,
                          #   the camera, bots turning into colossi, a whole match to the results, layouts), the
                          #   cross-engine proof, online Chromium vs WebKit (clean and lossy links) and the audio engine
BOSSFORM_GL=gl-egl npm run verify:browsers   # the same, drawing the E2E scenarios on this machine's GPU (only a real
                          #   GPU shows shader NaNs; SwiftShader, the default, never does)
node tools/verify/balance.ts   # prints the numbers the design is tuned by (time to first transformation, boss-form life...)
```

No unit-test framework is used: every check runs the real code path and prints PASS/FAIL. Screenshots land in
`tools/verify/shots/` (not committed). Browser checks need `npx playwright install chromium firefox webkit`.

## Online play

```sh
node tools/relay/server.ts                      # ws://127.0.0.1:4431  (RELAY_LATENCY_MS / RELAY_JITTER_MS / RELAY_LOSS to test)
# open the game in each browser with the relay address, choose ONLINE, enter the same room name:
http://127.0.0.1:4427/?relay=ws://127.0.0.1:4431/&name=ALPHA
```

The relay is a dumb room lobby (opaque per-member and room payloads, the lowest peer id is host) plus a datagram forwarder;
it never sees game state. The host chooses the mode, adds bots (owned by the host's machine) and starts. A static host
that forbids outbound connections can run everything except online play.

## URL options and dev pages (all optional)

- `?start=<mode>,<opponents>,<frame>,<seed>` (mode 0 elimination / 1 deathmatch) skips the menus; `&autoplay=1` lets a
  bot fly your seat too; `&timescale=N` (1 to 8) simulates faster on a single machine; `&freeze=N` freezes the simulation
  halfway through the first wind-up of boss attack N (1 salvo, 2 siege, 3 ultima) so a tell can be inspected;
  `&relay=` / `&name=` for online play. `window.__bossform.debug()` returns a read-only snapshot of the running match.
- Dev pages served by `npm run dev`: `viewer.html` (one model, posed from the URL), `stage-demo.html` (the scene with a bot
  match), `hud-demo.html`, `menus-demo.html`. `node tools/verify/shot.ts "<url>" out.png` takes a screenshot and reports
  console errors.

## Known limitations

- Balance is tuned with bot matches only; the numbers are starting points (see the design doc, §12) and need human play.
- The lobby uses a fixed input delay (6 ticks); adaptive delay from measured RTT is future work. A very lossy link makes the
  game stall (lockstep waits) rather than desync. A crashed peer aborts the session (only a graceful leave is handled
  deterministically); an online match cannot pause; a backgrounded tab stops advancing and stalls the others.
- Models are procedural vector designs; boss forms are readable at game scale but not detailed art.
