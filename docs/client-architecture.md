# BOSSFORM client architecture (v1)

The client is presentation only. It reads the simulation (`game/src/sim/index.ts`) and never writes to it; the only way
in is the input codec. Everything here follows the design in [game-design.md](game-design.md); §7 (look and motion) and
§5.5 (the boss form, its weight and its tells) are the parts that matter most for rendering.

```
game/src/
  sim/        the deterministic simulation (do not edit from the client side)
  bot/        computer pilots (input sources)
  render/     Pipeline (full-res MSAA + bloom), vector-mesh material kit, camera rig, arena floor
  view/       Stage (the scene for one match) + views (ships, projectiles, neutrals, orbs, effects)
  view/models procedural robots, colossi and neutral units (contract: view/models/types.ts)
  ui/         HUD (canvas 2D) and menus / lobby / results (DOM)
  audio/      procedural synth engine + AudioDirector (events -> sound)
  input/      keyboard, mouse and gamepad -> GameInput
  net/        relay room client (lobby, start message, transport)
  app.ts run.ts main.ts setup.ts config.ts   application shell (state machine, match runner, shared setup types)
```

## Look (from the design doc, §7)

Sleek vector meshes: dark translucent faces with crisp glowing edges (`render/vector.ts`), full-resolution rendering with
MSAA and a soft bloom (`render/pipeline.ts`). No pixel art, low-res targets, dithering, scanlines or bitmap fonts. Motion
eases everywhere. Team colours are `TEAM_COLORS` in `config.ts` (neutral units use `NEUTRAL_COLORS`).

World: ground plane XY, +Z toward the camera, 1 world unit = 1 simulation unit, angles in radians counter-clockwise from +X
(the simulation's binary angles convert with `fx.toRadians`). Fixed-point values convert with `fx.toFloat`
(value / 65536). The camera is a perspective camera looking down at the ship it follows, tilted back a little.

## Ownership and contracts

| Area | Files | Contract |
|---|---|---|
| Vector kit, pipeline | `render/vector.ts`, `render/pipeline.ts` | done; use as is (`createVectorMaterial`, `vectorMesh`, `edgeGeometry`, `Pipeline`) |
| Models | `view/models/*` | `view/models/types.ts` (poses in, meshes out); registry `view/models/index.ts` |
| Stage and views | `render/camera.ts`, `render/arena.ts`, `view/*` (not models) | `Stage` below |
| HUD, menus | `ui/*` | `Hud`, `Menus` below, types in `setup.ts` |
| Audio | `audio/*` | `AudioDirector` below |
| Application | `app.ts`, `run.ts`, `main.ts`, `input/*`, `net/*`, `index.html` | integrates all of the above |

### Stage (`view/stage.ts`)

```ts
class Stage {
  constructor(canvas: HTMLCanvasElement, world: World);
  focus(seat: number): void;                       // the ship the camera follows
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void;
  tick(world: World): void;                        // once after EVERY simulation tick: snapshot for interpolation
  handleEvents(world: World): void;                // react to world.events (the caller clears the queue afterwards)
  render(world: World, alpha: number, dtSeconds: number): void;   // alpha = 0..1 between the last two ticks
  project(x: number, y: number, out: { x: number; y: number }): void;  // world units -> CSS pixels on the canvas
  aimFrom(seat: number, cssX: number, cssY: number): number;      // binary angle from that ship to a cursor position
  dispose(): void;
}
```

### Hud (`ui/hud.ts`)

```ts
interface HudView {
  world: World; seat: number;                      // whose panel to show
  names: readonly string[];                        // per seat
  width: number; height: number;                   // overlay size in CSS pixels
  project(x: number, y: number, out: { x: number; y: number }): void;   // Stage.project
  time: number;                                    // seconds
}
class Hud {
  handleEvents(world: World): void;                // kill feed, banners, ultima warnings...
  draw(ctx: CanvasRenderingContext2D, view: HudView): void;   // the caller clears the canvas
}
```

### Menus (`ui/menus.ts`, DOM overlay)

Screens: title / quick match setup, offline match setup (mode, your frame, opponents, teams), online lobby (`LobbyState`
and `LobbyEdits` in `setup.ts`), pause, results. The class reports user intent through callbacks and never starts a match
itself.

### AudioDirector (`audio/director.ts`)

```ts
class AudioDirector {
  constructor(engine: AudioEngine);
  handleEvents(world: World, localSeat: number): void;   // positional: nearer to the local ship = louder, panned by side
  update(world: World, localSeat: number, dtSeconds: number): void;   // music state, boss-form drone, warnings
}
```

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

