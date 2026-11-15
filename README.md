# star-wing — build brief

A top-down space combat roguelike, browser-based. You fly a fighter with a cannon and homing
missiles; wingmen fight beside you; each run is escalating waves with upgrade choices between
waves. Zero dependencies, zero external assets (no images, no audio files). Pure ESM
(`"type": "module"` in package.json), Node >= 20 for tests, modern browsers for the app.
Modular: `src/engine/**` and `src/game/**` must NEVER reference `document`, `window`,
`AudioContext`, or `requestAnimationFrame` — browser APIs live ONLY in render/audio/main.

## Required layout (exact paths — the acceptance script enforces them)

- `package.json` — `{ "type": "module" }`, no dependencies.
- `src/engine/physics.js` — flight model, sophisticated but accessible:
  - `createBody({ x, y, vx = 0, vy = 0, heading = 0 })` → body object `{ x, y, vx, vy, heading, angVel }`.
  - `stepBody(body, input, dtSec, params)` where `input = { thrust: -1..1, turn: -1..1, brake: boolean }`
    and `params = { accel, maxSpeed, drag, turnAccel, maxTurn, stabDamp }`.
    Thrust accelerates along `heading` (cos/sin); drag damps speed toward 0; `turn` integrates
    `angVel` with clamp `maxTurn`; when `turn === 0`, `angVel` decays by `stabDamp` (auto-stabilize:
    ship naturally straightens — that is the "accessible" part). Position integrates last.
- `src/engine/weapons.js` — `createCannon({ cooldown, damage, speed, spreadCount, spreadAngle, bulletTtl })`
  with `fire(state) → bullet[] | null` (null while `state.timer < 0`; `state = { timer }`, caller decrements
  by dt), bullets `{ x, y, vx, vy, dmg, ttl }`; `createMissileLauncher({ salvo, cooldown, turnRate, accel, maxSpeed, ttl, damage, lockAngleDeg, lockRange })`
  with `fire(state, origin, heading, targets) → missile[]` — each missile `{ x, y, vx, vy, heading, dmg, ttl, targetId }`,
  seeking `targets` (list of `{ id, x, y }`) nearest to the forward bearing within `lockAngleDeg`/`lockRange`, else flying straight.
- `src/engine/director.js` — `wavePlan(wave) → { enemyCount, enemySpeed, enemyAggression, enemyHealth }`
  monotonically increasing difficulty; `pickUpgradeChoices(rng, owned, count=3) → [{ id, label, desc }]`
  drawn from a pool of at least 8 distinct ids (cannon rate, cannon damage, missile salvo, missile
  count, turn rate, max speed, extra wingman (max 3), max hull, spread, shield-regen style ok);
  never repeats an owned id.
- `src/game/game.js` — `export class Game`:
  - `new Game({ seed })` (default: random), `start()`, `tick(dtMs)`,
  - `setInput({ thrust, turn, fire, fireMissile, brake })` (read every tick),
  - `chooseUpgrade(index)` valid only while `state === 'upgrade'`,
  - `snapshot()` → EXACTLY this shape:
    ```
    { state: 'active'|'upgrade'|'gameover', wave: int, score: int,
      player: { x, y, vx, vy, heading, health, maxHealth, cannonTimer, missileAmmo },
      wingmen: [{ x, y, heading, health, alive }],
      enemies: [{ id, x, y, heading, health, kind }],
      bullets: [{ x, y }], missiles: [{ x, y }],
      upgrades: [string], upgradeChoices: [{ id, label, desc }],
      shotsFired: int }
    ```
  Behavior: start with 1 alive wingman; wingmen hold formation offsets around the player, auto-fire
  at the nearest enemy in range, can die, respawn between waves; enemies spawn per `wavePlan` and chase;
  killing all enemies of a wave → `state='upgrade'` with 3 fresh `upgradeChoices`; `chooseUpgrade`
  applies the effect (owned ids in `upgrades`) and starts the next wave; player hull 0 → `gameover`;
  cannon fires on `fire` when `cannonTimer <= 0` and bumps `shotsFired`; missiles on `fireMissile` with
  ammo that refills between waves. Deterministic with a seed.
- `src/render/renderer.js` — `export class Renderer` with EXACTLY this public API (the shell calls
  only these):
  - `new Renderer(canvasElement)`, `resize(cssWidth, cssHeight, dpr = devicePixelRatio || 1)` —
    MUST set `canvas.width/height` to finite positive numbers,
  - `render(snapshot, options)` where `options = { dtMs, paused, messages }` — draws parallax
    starfield + nebula, ships as glowing triangles with engine trails, bullets as tracers, missiles
    with smoke trails, explosion particles + shockwave rings, screen shake, hit flash, HUD (hull bar,
    wave, score, missile ammo), side overlay when `state==='upgrade'` (numbered choices) or
    `'gameover'` (score + restart hint). HIGH production values: gradients, `shadowBlur` glow,
    particle FX everywhere.
  - `addShake(magnitude)`, `addFlash(alpha)`, `showToast(text, ms)`.
- `src/audio/audio.js` — `export class AudioKit` with EXACTLY this public API:
  - constructor takes nothing; `unlock() → boolean` (create AudioContext on first gesture),
  - `play(event)` for events `cannon, missile, explode, hit, lockOn, waveClear, upgrade, gameOver`,
  - `startAmbient()`, `stopAmbient()`, `setMuted(bool)`, `toggleMute()`, `muted` property,
    `ambientRunning` property. Procedural WebAudio only — synth every sound, no files.
- `src/main.js` — keyboard listeners on `window` (keydown/keyup maintaining a held-key map):
  WASD/arrows = turn+thrust (up/forward thrust, down/brake), Space = cannon, F = missiles,
  P = pause (pause lives HERE, Game has none), R = restart, M = mute, keys 1/2/3 choose upgrades
  when `state==='upgrade'`. requestAnimationFrame loop calling `game.setInput(...)` then
  `game.tick(dt)` then `renderer.render(...)`, deriving FX by diffing snapshots (explosions = enemy
  count drop → `audio.play('explode')` + `renderer.addShake`, wave clear → toast + fanfare).
  Touch support: left/right half turns, auto-thrust, tap = cannon, swipe down = missiles.
  Resize via `renderer.resize(...)` on load/resize. **MUST expose `window.__game = { game, renderer, audio }`**
  after boot and boot automatically on script load (DOMContentLoaded or immediately).
  Every CSS `#id` selector must match an element id that exists in the HTML.
- `index.html` — full-window canvas `id="board"`, `<script type="module" src="src/main.js">`, dark styling.

## Acceptance (enforced by pipeline gates)

1. `node --test test/` green (agent-written suites for engine and game)
2. `node scripts/browser-smoke.js` prints `BROWSER_SMOKE_OK` — boots index.html + src/main.js
   against stub window/document/canvas/WebAudio, runs frames, holds thrust and taps fire, and
   requires: zero console errors, finite non-zero canvas backing store, >100 draw calls, player
   speed > 0 after thrust frames, and `shotsFired` increasing after Space taps.
3. `node scripts/web-acceptance.js` prints `WEB_ACCEPT_OK` — layout, exports, physics behavior,
   seeded Game run, browser-API purity of engine/game, exact snapshot shape, and that index.html
   references only existing files.

Do not modify `scripts/web-acceptance.js`, `scripts/browser-smoke.js`, or this README.
