# BOSSFORM — agent notes

Arena twin-stick mech shooter (Vite + TypeScript + Three.js) on a standalone deterministic lockstep engine.
Read `README.md` and `engine/README.md` first; this file is what is easy to get wrong.

## Commands

- `npm run dev` — Vite on :4427. `npm run build` — typecheck all three projects, then `game/dist` (relative base).
- `npm run typecheck` — `engine`, `game`, `tools` (strict, `erasableSyntaxOnly`, `verbatimModuleSyntax`,
  imports carry `.ts` extensions, `noUnusedLocals`). Sources also run directly under Node (native type stripping).
- `npm run verify` — headless evals (boundary, engine numerics/lockstep/hostile, standalone build, real-game eval).
- `npm run verify:browsers` — builds, starts a static server (:4429, strict CSP) and Vite (:4427) itself, runs the
  Playwright scenarios, the cross-engine proof (needs firefox + webkit), online co-op (relay :4431, static :4430) and
  audio, then stops what it started. Run single scenarios with `node tools/verify/e2e.ts <basic|boss|bosses|coop|layout> <w> <h> <url>`.
- `node tools/verify/models.ts <name> '<json>'` renders the dev-only model viewer (`game/viewer.html`) for design review.
- `node tools/relay/server.ts` — dev relay + matchmaker for online co-op (never inspects game traffic).

## Rules that keep the architecture honest (enforced by `tools/verify/boundary.ts`)

- `engine/` imports only itself; no DOM/Node globals; no game words (bullet, enemy, boss, robot...). If a concept
  needs to cross, it becomes a generic contract in `engine/src/sim.ts`, not a game type.
- `game/src/sim/` is deterministic: fixed point only, no `Math.random/sin/cos/pow/sqrt/hypot`, no `Date`, no `Map/Set`,
  no float literals outside `fx.lit/deg/turns`, imports only `@metronome/engine` + siblings. **All** state goes in
  `LAYOUT` (`sim/layout.ts`); anything else is a desync waiting to happen. New fields there change the layout hash, so
  peers on different builds refuse to play together (bump `SIM_VERSION` when rules change).
- `view/ui/audio/render` read the sim via `sim/index.ts` only and never assign into `world.m.*`. `Math.random` is fine there.
- Tuning numbers live in `sim/constants.ts` (single owner); presentation constants in `game/src/config.ts`.
- Do not add a unit-test framework or test files: correctness is shown by running the real path (eval scripts, E2E).

## Gotchas

- Browser E2E against the **dev server** resets the game on every HMR reload while files change; use the static build.
- The composite pass converts linear -> sRGB, so shader colours meant to be dark must be authored in display space
  and `pow(c, 2.2)`'d (see `view/background.ts`), otherwise floors look washed out.
- Robots are drawn `MECH_VISUAL_SCALE` (1.5x) larger than their collision bodies; hitboxes are the tiny cores
  (`FRAME_STATS.hurtR`). The boss form absorbs bullets instead of being hurt.
- Sim events (`world.events`) exist for presentation only and are drained by `App.drainEvents`; overflow loses effects,
  never correctness. Replays and checkpoints come from `Session` (`recordReplay`), not from the app.
- Headless Chromium needs `--use-angle=swiftshader`; headless Firefox has no WebGL2 here, WebKit does.
- Hosting under a strict CSP (`connect-src 'self'`) works for solo/local play; online co-op needs a reachable relay.
- Kill processes by specific PID (`ss -ltnp`), never by port glob.

## Models and audio

Robot/enemy models (`view/models/*`, contract in `types.ts`) are procedural; verify changes visually with the model
viewer at gameplay scale (scale 1-1.6), not only zoomed in. Audio (`audio/*`) is procedural Web Audio;
`tools/verify/audio.ts` renders every SFX/track offline and checks level, length and NaNs.
