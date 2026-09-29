# BOSSFORM

> **Design:** the current design is [`docs/game-design.md`](docs/game-design.md) (v0.2: PvP battle arena, slow
> bullets only, vector-mesh look, up to 8 players). The sections below still describe the **v0 prototype**
> (tag `v0-prototype`) and are rewritten as the redesign lands.

An arena mech shoot-'em-up in the spirit of *Senko no Ronde*, built on **METRONOME**, a standalone
deterministic lockstep engine. Move and aim separately (twin-stick), fill the energy gauge by grazing bullets and
wrecking enemies, then press the boss button and **transform into your frame's colossal boss form**.

Stack (same as `retrocause`): Vite + TypeScript + Three.js, a low-res dithered/bloomed post pipeline, a bitmap
font, and fully procedural meshes, VFX, music and SFX. No asset files.

```
engine/   @metronome/engine   deterministic lockstep engine: zero dependencies, no DOM, no Node, no game vocabulary
game/     @bossform/game      the game: deterministic sim (game/src/sim) + Three.js/DOM presentation
tools/    verify/ relay/      eval scripts (no test framework) and a dev WebSocket relay
```

## Play

```sh
npm install
npm run dev          # http://127.0.0.1:4427
npm run build        # typecheck everything, then game/dist (relative paths, ~210 KB gzip)
```

| | Keyboard + mouse | Gamepad |
|---|---|---|
| Move | `W A S D` | left stick |
| Aim (independent of movement) | mouse cursor, or arrow keys | right stick |
| Fire | click, `J`, `Z` | `A`, `RT`, `RB` |
| Alt weapon | right click, `K`, `X`, `Shift` | `B`, `LT`, `LB` |
| **Boss form** (gauge full) | `Space`, `E` | `Y`, `X` |
| Pause / mute | `Esc` `P` / `M` | `Start` |

### The three frames (robot designs)

| Frame | Trope | Fire | Alt | Boss form |
|---|---|---|---|---|
| **VANGUARD** | versatile hero | beam rifle | seeker missiles | **PALADIN**: winged, 5-way spread cannon + hold-to-fire judgement beam |
| **GALE** | fast striker | twin needles | dash-slash (i-frames) | **TEMPEST**: needles + 4 orbiting blade bits, blade storm |
| **JUGGERNAUT** | heavy bunker | howitzer (splash) | bulwark shield (absorbs bullets) | **FORTRESS**: twin siege cannons, rocket barrage |

### Boss mode
Grazing bullets, hitting enemies and collecting energy orbs fills the gauge. At 100% press the boss button: the
frame roots for a moment while it transforms (invulnerable), a shockwave clears bullets, then for ~11 s it is huge,
**absorbs every bullet that touches it** (each burns a little of the timer), crushes small enemies by ramming, doubles
score and gets a second weapon set. Kills and orbs extend the timer (capped). It ends with another pulse.

Three stages of four rounds each, ending in the bosses **BULWARK**, **SERAPH** and **OVERLORD** (three phases each,
switching at 66% and 33% health). Chained kills raise a score multiplier; a stage without damage doubles the clear
bonus. Modes: solo, **local co-op** (P2 on a gamepad), **online co-op** (below). Attract-mode demo on the title.

## Architecture: no leaking between engine and game

* `engine/` imports nothing but itself, is compiled with `lib: ES2023` and **no ambient types** (so it cannot touch
  DOM or Node), has zero dependencies, and contains no game vocabulary. It knows only three contracts: a
  `Simulation` (state memory + `step`), an `InputCodec` (fixed-size bytes per seat per tick) and a `Transport`.
* `game/src/sim/` implements those contracts, imports only `@metronome/engine` (public entry) and itself, and uses no
  floats outside `fx.lit/deg/turns` constants, no `Math.random/sin/cos/pow/sqrt/hypot`, no `Date`, no `Map/Set`.
* `game/src/{view,ui,audio,render}` only **read** the sim (through `sim/index.ts`) and never write to its memory.
  Presentation-only randomness (particles, shake) is allowed there.
* All of this is enforced mechanically by `tools/verify/boundary.ts`.

## How determinism is achieved (and proven)

* **Numbers**: Q16.16 fixed point in `Int32Array`. `sqrt` is a `Math.sqrt` *guess* corrected by an exact integer
  fix-up; `sin/cos/atan2` use tables built at load from Taylor series that use only `+ - * /` (IEEE-exact), so no
  reliance on implementation-approximated `Math.*`.
* **State**: everything that affects a future tick lives in one `ArrayBuffer` (`SimMemory`), RNG included, so
  snapshot = memcpy, checksum = one pass, and hidden state is detectable.
* **Lockstep**: input delay, redundant un-acked input resend (works over unreliable/reordering transports), stall
  until every seat's input is present, 64-bit state checksums exchanged periodically (fail loud on desync),
  handshake hash covering parameters + input encoding + memory layout, graceful leave, peer timeouts, replays.

Proof, all run against the real game: same recordings replayed bit-identically on **V8 (Node, Chromium),
SpiderMonkey (Firefox) and JavaScriptCore (WebKit)**; a Chromium-vs-WebKit online match over a lossy, reordering
link ends with identical inputs and checksums on both machines; Node reproduces them.

## Verify

```sh
npm run typecheck
npm run verify            # headless: architecture, numerics, lockstep/hostile-network/hostile-packet evals,
                          #           standalone engine build, real-game mechanics + determinism (~15 s)
npm run verify:browsers   # builds, serves under a strict CSP, then real-browser E2E (solo, boss mode x3 frames,
                          #   local co-op with a gamepad, layouts), cross-engine proof, online co-op, audio (~3 min)
```

No unit-test framework is used: every check runs the real code path and prints PASS/FAIL. Screenshots land in
`tools/verify/shots/` (not committed). Browser checks need `npx playwright install chromium firefox webkit`.

## Online co-op

```sh
node tools/relay/server.ts            # ws://127.0.0.1:4431  (RELAY_LATENCY_MS / RELAY_JITTER_MS / RELAY_LOSS to test)
# then open two tabs:
http://127.0.0.1:4427/?relay=ws://127.0.0.1:4431/&room=abc            # menu: ONLINE CO-OP, pick a frame
http://127.0.0.1:4427/?relay=ws://127.0.0.1:4431/&room=abc&auto=2     # auto-join with frame 2
```
The relay only forwards opaque datagrams and matches two players into a room; it never sees game state. A static
host that forbids outbound connections (e.g. a strict CSP) can run solo and local co-op but not online.

## Known limitations

* The lobby uses a fixed input delay (6 ticks); adaptive delay from measured RTT is future work. Over a very lossy
  link the game stalls (lockstep waits) rather than desyncs.
* A crashed peer aborts the session (only a graceful leave is handled deterministically). Online play cannot pause.
* Robot and enemy models are procedural low-poly designs, readable at gameplay scale but not detailed art.
