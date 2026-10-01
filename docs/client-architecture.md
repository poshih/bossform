# BOSSFORM client architecture (v1)

The client is presentation only. It reads the simulation (`game/src/sim/index.ts`) and never writes to it; the only way
in is the input codec. Everything here follows the design in [game-design.md](game-design.md); §7 (look and motion) and
§5.5 (the boss form, its weight and its tells) are the parts that matter most for rendering.

```
game/src/
  sim/        the deterministic simulation (do not edit from the client side; read it through sim/index.ts)
  bot/        computer pilots (input sources): bot.ts (the shared pilot), tactics.ts (its contract with each robot's own
              tactics, bot/<robot>.ts), hazards.ts (landing rings, armed mines, beam lines and laser tells to step out of)
  render/     Pipeline (full-res MSAA + bloom), vector-mesh material kit, camera rig, arena floor
  view/       Stage (the scene for one match) + views (ships, projectiles, neutrals, orbs, effects)
  view/models procedural robots, colossi and neutral units (contract: view/models/types.ts)
  ui/         HUD (canvas 2D) and menus / lobby / results (DOM)
  audio/      procedural synth engine + AudioDirector (events -> sound)
  input/      keyboard, mouse, gamepad and touch controls -> GameInput
  net/        relay room client (lobby, start message, transport)
  app.ts run.ts main.ts setup.ts config.ts   application shell (state machine, match runner, shared setup types)
```

## The simulation's modules (sim v5, nine frames)

The client never imports these directly: `sim/index.ts` re-exports what the presentation needs. They are listed so readers
know where a rule lives.

| Module | Holds |
|---|---|
| `frame-ids.ts` | `Frame` (VANGUARD 0 ... GAUNTLET 8, wire format) and `FRAME_COUNT`; a leaf, re-exported by `frames.ts` |
| `frames.ts` | assembles `FRAME_STATS`, `PRIMARY_WEAPONS` (`interval`, `cost`, aim-leading `speed`, `reach`) and `ALT_ABILITIES` (`attack`, `cost`), nine rows each |
| `formkit.ts`, `forms.ts` | the boss-form kit (`PartKind`, `Role`, `Pattern`, part and attack types, `defineForm`); `forms.ts` keeps PALADIN, TEMPEST, FORTRESS and assembles `FORMS` in frame order |
| `<robot>.ts` (longbow, prism, hailstorm, ronin, shade, gauntlet) | one robot's tables (`LONGBOW` ...), its `FrameStats` and its boss form (`BALLISTA`, `HELIOS`, `ARMADA`, `SHOGUN`, `KITSUNE`, `ATLAS`) |
| `<robot>-weapons.ts` | that robot's normal-form weapons (`fire<Robot>`, called every tick from `fireNormal`) and readiness helpers |
| `beams.ts` | the one ray cast every beam uses (PRISM's beam and lance, boss beam patterns, wheel ultimas): first hostile obstacle wins |
| `shots.ts`, `projectiles.ts` | shot kinds and flags (seek, inert, proximity mines, returning shots, lobbed shells); `lob`, `carpet`, artillery targeting, `hasReturning` |
| `blast.ts` | how projectiles end: burst into shrapnel, blast the area around a lobbed shell or a mine, expire |
| `kit.ts`, `parts.ts` | the robot kits' state and how it ends (`reveal`, `clearKit`); boss parts' damage and clearing a colossus |
| `boss.ts` | boss attacks by pattern: volley, beam, artillery, carpet (salvo and siege); spiral, wheel, bombard, carpet (ultima) |

Per-seat state the HUD, views and audio read: `plCharge` (LONGBOW), `plBeam`, `plBeamAng`, `plBeamLen`, `plLance`,
`plLanceAng` (PRISM), `plSpin` (HAILSTORM), `plParry` (RONIN), `plCloak` (SHADE), `plSide` (the side the next alternating
shot leaves from: RONIN's swing, GAUNTLET's arms); per part `ptBeamLen`; per projectile
`pMode` (returning), `pLast`, `pFuse` (a lobbed shell's flight). Presentation events 32 to 40: `ParryUp`, `Reflect`,
`Cloak`, `Reveal`, `Catch`, `ChargeFull`, `Blast`, `BeamOn`, `LanceFire`. `targetable(w, seat)` is false for a cloaked
pilot; `hasReturning(w, seat)` says a robot's rocket fist is out.

## Look (from the design doc, §7)

Sleek vector meshes: dark translucent faces with crisp glowing edges (`render/vector.ts`), full-resolution rendering with
MSAA and a soft bloom (`render/pipeline.ts`). No pixel art, low-res targets, dithering, scanlines or bitmap fonts. Motion
eases everywhere. Team colours are `TEAM_COLORS` in `config.ts` (neutral units use `NEUTRAL_COLORS`).

Rendering rules:
- **No NaN may leave a fragment shader.** The scene renders into a half-float target and the bloom blurs it: one NaN pixel
  is smeared over the whole screen and the arena goes black. Clamp before `pow` (a negative base is NaN on real GPUs), never
  `normalize` a vector that can be zero (a part scaled flat on one axis has a singular normal matrix), no `atan(0, 0)`.
  SwiftShader (the default headless renderer) hides these: check on a GPU (`BOSSFORM_GL=gl-egl`, see AGENTS.md).
- Canvas backing stores use `config.backingScale()`: the device pixel ratio capped by `MAX_DPR` and a 4K pixel budget.

World: ground plane XY, +Z toward the camera, 1 world unit = 1 simulation unit, angles in radians counter-clockwise from +X
(the simulation's binary angles convert with `fx.toRadians`). Fixed-point values convert with `fx.toFloat`
(value / 65536). The camera (`render/camera.ts`) is a perspective camera looking down at the ship it follows, tilted back a
little. It follows the DRAWN (interpolated) ship with a critically damped spring: no aim lead, no roll, pulled back in boss
form. Aiming and floor picks use its steady twin, never the drawn camera, so nothing the camera does can move the aim. Only a
colossus destroyed near the camera shakes it (translation only, falloff in `view/shake.ts`); everything else reacts with
light and motion, never with camera movement.

## Ownership and contracts

| Area | Files | Contract |
|---|---|---|
| Vector kit, pipeline | `render/vector.ts`, `render/pipeline.ts` | done; use as is (`createVectorMaterial`, `vectorMesh`, `edgeGeometry`, `Pipeline`) |
| Models | `view/models/*` | `view/models/types.ts` (poses in, meshes out); registry `view/models/index.ts`; one module per robot (`view/models/<robot>.ts`: `create<Robot>()` and `create<Form>()`) |
| Stage and views | `render/camera.ts`, `render/arena.ts`, `view/*` (not models) | `Stage` below |
| HUD, menus | `ui/*` | `Hud`, `Menus` below, types and presentation names in `setup.ts` |
| Robot kits | `sim/<robot>.ts`, `sim/<robot>-weapons.ts`, `view/models/<robot>.ts`, `bot/<robot>.ts` | one owner per new robot: its tables, weapons, model and bot tactics |
| Audio | `audio/*` | `AudioDirector` below |
| Application | `app.ts`, `run.ts`, `main.ts`, `input/*`, `net/*`, `index.html` | integrates all of the above |

### Stage (`view/stage.ts`)

```ts
class Stage {
  constructor(canvas: HTMLCanvasElement, world: World);
  focus(seat: number): void;                       // the ship the camera follows
  viewer(seat: number): void;                      // the local pilot (-1: none): whom a cloak hides from, even while spectating
  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void;   // pixelRatio = config.backingScale(...)
  tick(world: World): void;                        // once after EVERY simulation tick: snapshot for interpolation
  handleEvents(world: World): void;                // each view reacts to world.events (the caller clears the queue afterwards)
  render(world: World, alpha: number, dtSeconds: number, beat: Beat): void;   // alpha = 0..1 between the last two ticks
  seatPoint(seat: number, out: { x: number; y: number }): void;   // where a pilot is DRAWN this frame, world units
  seatScreen(seat: number, out: { x: number; y: number }): void;  // the same, CSS pixels (overlays glued to the ship)
  project(x: number, y: number, out: { x: number; y: number }): void;  // world units -> CSS pixels on the canvas
  ground(cssX: number, cssY: number, out: { x: number; y: number }): void;  // CSS pixels -> floor point, world units (steady camera)
  aimFrom(seat: number, cssX: number, cssY: number): number;      // binary angle from that ship to a cursor position (steady camera)
  dispose(): void;
}
```

Models are posed from the snapshot (`view/models/types.ts`). `RobotPose.alt` is the alt's activity (PRISM: the lance
tell's progress, 0 to 1); `RobotPose.special` is the robot's own weapon state, 0 for the first three: LONGBOW's charge
(1 = FULL), PRISM's beam (0 idle, up to 0.5 through its tell, 1 firing), HAILSTORM's spin, RONIN's parry stance, SHADE's
cloak (drawn only for its own team; opponents see at most a shimmer), GAUNTLET's fist in flight. `PartPose.away` hides a
pod's rocket fist while it is out. Robots are drawn at `ROBOT_VISUAL_SCALE` (`config.ts`) times their model size;
`drawnMuzzle(frame)` (registry) is how far along the aim a robot's weapon is drawn, where muzzle effects belong (the
simulation's `MUZZLE`, except LONGBOW's long rifle). Beams, lance rails, lobbed shells with their landing rings, mines and blasts are views
of their own, each on a `DrawLayer`.

The Stage draws a list of views (`view/frame.ts`: `StageView` with `handleEvents`, `update(previous, current, frame)` and a
`root` group): arena floor, orbs, projectiles, neutral units, ships, shields and boosts, effects. Their order in the list is
only their update order: what is drawn above what is `render/layers.ts` (`DrawLayer`, bottom to top: backdrop, floor,
storm, orbs, floor marks, ship underlays, bodies, shields, ship overlays, ship effects, explosions, beams, bullets, hurtbox
cores), set as each renderable's `renderOrder`, because every material is transparent and nothing writes depth. Models stay on `Bodies` and
stack their own parts by height. Anything drawn at a pilot uses `drawnSeatPoint` (`view/snapshot.ts`), the same
interpolation as the ship. Each view owns its reactions to events; `FrameContext` carries the interpolation alpha, frame
time, focus seat and team, and the music's `Beat` (`beat.ts`: the App's `BeatClock` follows `AudioEngine.musicPosition()`,
so visuals pulse in time with the music).

### Hud (`ui/hud.ts`)

```ts
interface HudView {
  world: World; seat: number;                      // whose panel to show
  viewerTeam?: number;                             // whom a cloak hides from: the local pilot's team even while spectating (default: seat's)
  names: readonly string[];                        // per seat
  width: number; height: number;                   // overlay size in CSS pixels
  project(x: number, y: number, out: { x: number; y: number }): void;   // Stage.project: WORLD UNITS in (convert sim fixed point with fx.toFloat)
  ground(cssX: number, cssY: number, out: { x: number; y: number }): void;   // Stage.ground: the floor point under a pixel
  seatScreen(seat: number, out: { x: number; y: number }): void;   // Stage.seatScreen: where a pilot is drawn this frame
  beat: Beat;                                      // accents pulse in time with the music
  time: number;                                    // seconds
  cursor: { x: number; y: number } | null;         // the reticle position, CSS pixels
}
class Hud {
  handleEvents(world: World): void;                // kill feed, banners, ultima warnings...
  draw(ctx: CanvasRenderingContext2D, view: HudView): void;   // the caller clears the canvas
}
```

Panels report the area they cover (their height depends on the rows drawn); off-screen pointers are placed along the screen
edges clear of those areas, with their labels on the side facing the screen centre.

Every per-robot word comes from `setup.ts` (`FRAME_NAMES`, `FORM_NAMES`, `FRAME_TAGLINES`, `FRAME_BLURBS`, `PRIMARY_LABELS`,
`ALT_LABELS`, one entry per frame, checked against `FRAME_COUNT` when the module loads). The local panel's LMB chip shows
the primary and its state (LONGBOW's charge tier with SNAP and HALF marks, PRISM's TELL / FIRING, HAILSTORM's spin,
SHADE's AMBUSH, DRY when the pool cannot pay); the RMB chip names the alt and reads it from the sim: running (LANCE 0.4S,
GUARD, CLOAKED 1.8S, IN FLIGHT, RAISED 1.2S), READY (`canUseAlt`), its cooldown, or NO ENERGY. The touch strip uses the same
words. A cloaked pilot that is not on the local pilot's team (`viewerTeam`, kept while the camera spectates someone else) has
no radar dot, name tag or edge pointer.

### Menus (`ui/menus.ts`, DOM overlay)

Screens: title, offline match setup (mode, your frame, opponents, teams), online lobby (`LobbyState` and `LobbyEdits` in
`setup.ts`), pause, results. The class reports user intent through callbacks and never starts a match itself. The frame
select is a 3 × 3 grid of compact cards (emblems from `ui/icons.ts`) that stays three columns on phones; arrow keys move
through any card grid by the row length it has on screen.

### AudioDirector (`audio/director.ts`)

```ts
class AudioDirector {
  constructor(engine: AudioEngine);
  handleEvents(world: World, localSeat: number, viewerTeam?: number): void;   // positional: nearer to the local ship = louder, panned by side; a cloak hides sounds from viewerTeam's opponents
  update(world: World, localSeat: number, dtSeconds: number): void;   // music state, boss-form drone, warnings
  silence(): void;                                         // every loop layer off: the run ended (App.leaveRun)
}
```

Sounds are procedural (`audio/synth.ts`). Each robot's `Ev.Fire` has its own sound (primary and, where the alt fires
something, alt); abilities with their own events (parry, cloak, reveal, fist catch, charge full, blasts, beam ignition,
the lance's crack) map one to one. Boss wind-ups are generated per frame and attack (`salvoWindup<Robot>` ...
`ultimaWindup<Robot>`), each form with its own voice, and last exactly as long as the attack's wind-up. Loop layers:
`bossDrone`, `ultimaBarrage`, and `beamHum` for the loudest live beam near the listener. A cloaked pilot's own sounds
(boost, graze, hits, pickups, the veil itself) are not played for its opponents: only its shots and its reveal are.

## Rules for everyone (the project's standing rules)

- No unit tests, test files or test frameworks. Verify by running the real thing: dev page + Playwright screenshots, eval
  scripts under `tools/verify/`. The browser console must stay error-free.
- SSOT: one owner per concept. Sizes and positions of boss parts come from `FORMS`, projectile radii from `SHOT_DEFS`,
  frames from `FRAME_STATS`; never copy their numbers into the client.
- Explicit parameters (no setting state as a side effect before a call), no fallbacks (`||` chains that paper over gaps), no
  magic numbers (named constants), no dead code, no boolean-trap parameters, fail loud on programmer errors, validate only at
  boundaries.
- The client reads the simulation only through `sim/index.ts` and never assigns into `world.m` (`tools/verify/boundary.ts`
  enforces it: `npm run typecheck` and `node tools/verify/boundary.ts`).
- Kill processes only by a specific numeric PID (`ss -ltnp` to find one); never `pkill` or `kill $(...)`.
- Dev server: `npm run dev` serves `game/` on http://127.0.0.1:4427 (already running while you work; do not start another).
  Headless Chromium needs `--use-angle=swiftshader --enable-unsafe-swiftshader`.
- Visual review: `node tools/verify/shot.ts "http://127.0.0.1:4427/<page>?<params>" out.png [--size=960x540] [--wait=1500]
  [--ready=<js expression>]` saves a screenshot and reports console errors. Look at the image (view tool) and iterate until
  it is genuinely good, not merely working. `game/viewer.html` (see `src/viewer.ts` for its URL parameters) shows one
  model posed from the URL.
- Do not `git commit` and do not touch files owned by another area; report anything you need from them instead.
