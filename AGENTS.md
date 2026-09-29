# BOSSFORM — agent notes

PvP arena mech shooter (Vite + TypeScript + Three.js) on a standalone deterministic lockstep engine.
Read `README.md` and `docs/game-design.md` first (rules, numbers, the boss-form tell rules), then `docs/client-architecture.md`
(who owns which directory and the Stage / Hud / Menus / AudioDirector / model contracts) and `engine/README.md`.
This file is what is easy to get wrong.

## Commands

- `npm run dev` — Vite on :4427. `npm run build` — typecheck all three projects, then `game/dist` (relative base).
- `npm run typecheck` — `engine`, `game`, `tools` (strict, `erasableSyntaxOnly`, `verbatimModuleSyntax`, imports carry
  `.ts` extensions, no enums, `noUnusedLocals`). Sources also run directly under Node 22 (native type stripping).
- `npm run verify` — headless evals: boundary lint, engine numerics / lockstep / hostile network / standalone / scale, and the
  game on the real sim (`game-rules`, `game-boss`, `game-match`, `game-determinism`).
- `npm run verify:browsers` — builds, starts a static server (:4429, strict CSP) itself, runs the Playwright scenarios
  (`node tools/verify/e2e.ts <menus|play|match|bosses|pad|layout|camera> <w> <h> <url>`), the cross-engine proof (V8 / SpiderMonkey /
  JavaScriptCore; needs firefox + webkit), online Chromium vs WebKit (`e2e-online.ts`; its own relay :4431 and static :4430) and
  audio, then stops what it started. On a machine with a GPU, prefix `BOSSFORM_GL=gl-egl` (or `vulkan`) to draw the E2E
  scenarios on it instead of SwiftShader: only a real GPU shows shader NaNs (see Rendering).
- `node tools/verify/balance.ts` — bot matches, prints time to first transformation, boss-form life, parts destroyed.
- `node tools/verify/shot.ts "<url>" out.png [--size=WxH] [--wait=ms]` — screenshot + console errors (viewer, stage-demo, real app).
- `node tools/relay/server.ts` — dev relay + room lobby (never inspects game traffic).

## Rules that keep the architecture honest (enforced by `tools/verify/boundary.ts`)

- `engine/` imports only itself; no DOM/Node globals; no game words (bullet, enemy, boss, robot...). A concept that has to
  cross becomes a generic contract in `engine/src/sim.ts`, not a game type.
- `game/src/sim/` is deterministic: fixed point only (`fx`), no `Math.random/sqrt/hypot/pow/sin/cos/atan2`, no `Date`, no
  `Map/Set`, no float literals outside `fx.lit/deg/turns`, imports only `@metronome/engine` + siblings (flat directory).
  **All** state goes in `SimMemory`, laid out from the seat count by `layoutFor(cap)` in `sim/layout.ts`; anything else is
  a desync waiting to happen. Changing the layout or the rules changes the handshake hash, so peers on different builds refuse
  to play together (bump `SIM_VERSION` when rules change).
- `render/view/ui/audio` read the sim through `sim/index.ts` only and never write into the world. `Math.random` is fine there.
- Tuning numbers live next to their definitions in `sim/` (`constants.ts`, `frames.ts`, `forms.ts`, `neutrals.ts`): single
  owner. Presentation constants live in `game/src/config.ts` or at the top of the file that uses them.
- No unit-test framework and no test files: correctness is shown by running the real path (eval scripts, E2E, replays).
- Distance maths: `fx.hypot` needs components under ~700 units, and `fx.len2` of raw fixed point stops being exact past
  ~1400 units apart. Compare arena-scale distances with `span2()` (shifted squares, exact up to the 4000-unit arena radius
  limit) and `inside()`; `within()` is for small radii (hitboxes, ranges) only.

## Gotchas

- Browser E2E against the **dev server** resets the game on every HMR reload while files change. Use the static build:
  `npm run build -w @bossform/game && node tools/verify/serve.ts 4429 hopinto` then `http://127.0.0.1:4429/r/local-test/index.html`
  (`serve.ts <port> open` allows the relay websocket; `hopinto` is the strict CSP).
- The WebGL canvas reads back blank through `drawImage`; E2E samples screenshot pixels instead (`regionStats`).
- Functions given to `page.evaluate` are serialised into the page: module constants are not visible there. Declare them
  inside the function or pass them as arguments.
- Input and camera checks count simulated ticks, never wall time: headless SwiftShader draws a few frames per second.
- three's clear colour must be pure black: the output pass brightens anything else. Bloom over additive fills whites the
  scene out, so tells are drawn as bold, bright edges, not big additive areas.
- Sim events (`world.events`) exist for presentation only; overflow loses effects, never correctness. Fire events carry the
  weapon slot in `c`, Hit events the attacker in `c`. Replays and checkpoints come from `Session` (`recordReplay`).
- `AudioDirector` must be given a valid focus seat (never -1). Spectating a dead pilot is the app's job (`App.focusSeat`).
- Online: the lobby is `net/lobby.ts` + `tools/relay/server.ts` (JSON `welcome/room/member/settings/start/left`, binary
  `[u16 peer][payload]`, `0xFFFF` = broadcast). The host machine owns the bots. A crashed peer aborts the session, online
  play cannot pause, a hidden tab stalls the others.
- Headless Chromium needs `--use-angle=swiftshader --enable-unsafe-swiftshader`; headless Firefox has no WebGL2 here, WebKit does.
  With a GPU, `--use-gl=angle --use-angle=gl-egl` draws on it (what `BOSSFORM_GL=gl-egl` does).
- Hosting under a strict CSP (`connect-src 'self'`) works for offline play; online play needs a reachable relay.
- Kill processes by specific PID (`ss -ltnp`), never by port glob.

## Rendering

- No NaN may leave a fragment shader: the scene renders into a half-float target and the bloom smears one NaN pixel over
  the whole screen (the arena goes black). Clamp before `pow` (negative base = NaN on real GPUs), never `normalize` a
  vector that can be zero (a mesh scaled flat on one axis has a singular normal matrix), no `atan(0, 0)`. SwiftShader
  never shows these; the `bosses` E2E fails on any blackout when run with `BOSSFORM_GL=gl-egl`.
- Canvas backing stores go through `config.backingScale()` (device pixel ratio capped by `MAX_DPR` and a 4K pixel budget).
- Camera: aim and floor picks use the steady camera, never the drawn one; no aim lead, no roll; only a colossus destroyed
  near the camera shakes it (`view/shake.ts`). The Stage's views own their reactions to events (`view/frame.ts`).

## Models and audio

Models (`view/models/*`, contract in `types.ts`, registry `index.ts`) are procedural vector meshes drawn by `render/vector.ts`
(barycentric edges, crease-angle edge hiding). Every model must be judged at game scale (viewer `zoom≈0.11` for robots,
`≈0.45` for colossi), not only zoomed in, and boss forms must place their parts at the sim's `FORMS[...]` offsets and radii.
Audio (`audio/*`): SFX are procedural Web Audio; music is synthesised into Float32Arrays by `audio/music.ts`, in 8-bar
sections rendered by `audio/musicWorker.ts` and scheduled back to back by `AudioEngine` (never synthesise on the main
thread). A section's notes are placed relative to its first bar (`BufferWriter` origin); each track has one fixed,
measured `gain` (never normalise per render: sections would jump in level). `tools/verify/audio.ts` measures BS.1770
loudness, true peak, DC, the battle energy contour, sections against the whole track, the limiter, main-thread long
tasks and the live output across section boundaries; it exports WAVs to `tools/verify/shots/music/`.
