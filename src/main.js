// star-wing browser shell: boot, input, the rAF loop, and the glue that turns
// snapshot diffs into sound and screen FX. Nothing here simulates anything —
// Game owns the rules, Renderer owns the pixels, AudioKit owns the sound.
//
// The loop is deliberately dumb: read the held-key map, hand Game one input
// record, tick once, render once, diff the two snapshots for events.

import { Game } from './game/game.js';
import { Renderer } from './render/renderer.js';
import { AudioKit } from './audio/audio.js';

/** Longest step the shell will hand the sim; a tab-switch must not fast-forward. */
const MAX_FRAME_MS = 120;
/** Fallback step for the very first frame, when there is no previous stamp. */
const FIRST_FRAME_MS = 16.7;

/** How long one tap or swipe counts as a held trigger. */
const TAP_MS = 150;
/** Vertical drag distance that reads as "fire the salvo" instead of a turn. */
const SWIPE_DOWN_PX = 36;

const THRUST_KEYS = new Set(['KeyW', 'ArrowUp']);
const BRAKE_KEYS = new Set(['KeyS', 'ArrowDown']);
const LEFT_KEYS = new Set(['KeyA', 'ArrowLeft']);
const RIGHT_KEYS = new Set(['KeyD', 'ArrowRight']);

/** Everything the shell swallows so the page never scrolls under the player. */
const HANDLED = new Set([
  ...THRUST_KEYS, ...BRAKE_KEYS, ...LEFT_KEYS, ...RIGHT_KEYS,
  'Space', 'KeyF', 'KeyP', 'KeyR', 'KeyM', 'Digit1', 'Digit2', 'Digit3',
]);

const CHOICE_KEYS = new Map([['Digit1', 0], ['Digit2', 1], ['Digit3', 2]]);

function num(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * `?seed=7` (or `?seed=any-string`) makes a run reproducible; with no seed the
 * Game falls back to its own clock-derived one.
 */
function seedFromUrl() {
  const search = (globalThis.location && globalThis.location.search) || '';
  const match = /[?&]seed=([^&]*)/.exec(search);
  if (!match) return undefined;
  const raw = decodeURIComponent(match[1]);
  if (!raw) return undefined;
  const asNumber = Number(raw);
  return Number.isFinite(asNumber) ? asNumber : raw;
}

function nowMs() {
  const perf = globalThis.performance;
  if (perf && typeof perf.now === 'function') return perf.now();
  return Date.now();
}
/** The shell: owns the loop, the input map and the FX/audio wiring. */
class Shell {
  constructor(canvas) {
    const seed = seedFromUrl();
    this.game = new Game(seed === undefined ? {} : { seed });
    this.renderer = new Renderer(canvas);
    this.audio = new AudioKit();

    this.canvas = canvas;
    this.held = new Set();
    this.paused = false;

    // Tap/swipe triggers stay "held" for a beat so a flick is still read as a
    // trigger pull by a sim that only ever sees one input record per tick.
    this.pulse = { cannon: 0, missiles: 0 };
    this.touch = { active: false, turn: 0, thrust: 0, x0: 0, y0: 0, swiped: false };

    this.prev = null;
    this.prevStamp = 0;

    this._bind();
    this.resize();
  }

  // ------------------------------------------------------------------ input --

  _bind() {
    const on = (target, type, fn) => {
      if (target && typeof target.addEventListener === 'function') target.addEventListener(type, fn);
    };

    on(window, 'keydown', (ev) => this._onKeyDown(ev));
    on(window, 'keyup', (ev) => this._onKeyUp(ev));
    on(window, 'blur', () => this.held.clear());

    on(window, 'pointerdown', (ev) => this._onPointerDown(ev));
    on(window, 'pointermove', (ev) => this._onPointerMove(ev));
    on(window, 'pointerup', (ev) => this._onPointerUp(ev));
    on(window, 'pointercancel', () => this._releasePointer());

    on(window, 'resize', () => this.resize());
    on(window, 'orientationchange', () => this.resize());
  }

  _onKeyDown(ev) {
    const code = ev && ev.code;
    if (!code) return;
    if (HANDLED.has(code) && typeof ev.preventDefault === 'function') ev.preventDefault();
    this.audio.unlock();

    const choice = CHOICE_KEYS.get(code);
    if (choice !== undefined) {
      if (this.game.state === 'upgrade') this.game.chooseUpgrade(choice);
      return;
    }
    if (code === 'KeyP') {
      this._togglePause();
      return;
    }
    if (code === 'KeyR') {
      this.restart();
      return;
    }
    if (code === 'KeyM') {
      this._toggleMute();
      return;
    }

    if (code === 'KeyF' && !this.held.has(code)) this.audio.play('lockOn');
    this.held.add(code);
  }

  _onKeyUp(ev) {
    const code = ev && ev.code;
    if (code) this.held.delete(code);
  }

  /** Half-screen steering: left half turns left, right half turns right. */
  _onPointerDown(ev) {
    const rect = this.canvas.getBoundingClientRect ? this.canvas.getBoundingClientRect() : null;
    const x = num(ev && ev.clientX, 0);
    const y = num(ev && ev.clientY, 0);
    const width = num(rect && rect.width, num(this.canvas.clientWidth, 0));

    this.audio.unlock();
    this.touch.active = true;
    this.touch.swiped = false;
    this.touch.x0 = x;
    this.touch.y0 = y;
    this.touch.thrust = 1;
    this.touch.turn = width > 0 && x > width / 2 ? 1 : -1;
  }

  _onPointerMove(ev) {
    if (!this.touch.active) return;
    const y = num(ev && ev.clientY, this.touch.y0);
    if (!this.touch.swiped && y - this.touch.y0 > SWIPE_DOWN_PX) {
      this.touch.swiped = true;
      this.pulse.missiles = nowMs() + TAP_MS;
    }
  }

  _onPointerUp(ev) {
    if (!this.touch.active) return;
    const x = num(ev && ev.clientX, this.touch.x0);
    const y = num(ev && ev.clientY, this.touch.y0);
    if (Math.hypot(x - this.touch.x0, y - this.touch.y0) < SWIPE_DOWN_PX) {
      this.pulse.cannon = nowMs() + TAP_MS;
    }
    this._releasePointer();
  }

  _releasePointer() {
    this.touch.active = false;
    this.touch.turn = 0;
    this.touch.thrust = 0;
  }

  /** One normalised input record for this tick, from held keys + touch. */
  input(now = nowMs()) {
    let thrust = 0;
    let turn = 0;
    let brake = false;

    for (const code of this.held) {
      if (THRUST_KEYS.has(code)) thrust += 1;
      else if (BRAKE_KEYS.has(code)) {
        thrust -= 1;
        brake = true;
      }
      if (LEFT_KEYS.has(code)) turn -= 1;
      else if (RIGHT_KEYS.has(code)) turn += 1;
    }

    thrust += this.touch.thrust;
    turn += this.touch.turn;

    return {
      thrust: clamp(thrust, -1, 1),
      turn: clamp(turn, -1, 1),
      fire: this.held.has('Space') || now < this.pulse.cannon,
      fireMissile: this.held.has('KeyF') || now < this.pulse.missiles,
      brake,
    };
  }
  // -------------------------------------------------------------- the loop --

  frame(stamp) {
    const at = num(stamp, nowMs());
    let dtMs = this.prevStamp ? at - this.prevStamp : FIRST_FRAME_MS;
    this.prevStamp = at;
    dtMs = clamp(dtMs, 0, MAX_FRAME_MS);

    this.game.setInput(this.input(at));
    if (!this.paused) this.game.tick(dtMs);

    const snap = this.game.snapshot();
    this._observe(snap);
    this.renderer.render(snap, {
      dtMs: dtMs > 0 ? dtMs : FIRST_FRAME_MS,
      paused: this.paused,
      messages: this.hints(snap),
    });
  }

  start() {
    const step = (stamp) => {
      this.frame(stamp);
      this._schedule(step);
    };
    this._schedule(step);
  }

  _schedule(step) {
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(step);
  }

  _togglePause() {
    this.paused = !this.paused;
    this.renderer.showToast(this.paused ? 'PAUSED' : 'RESUME', 1400);
  }

  _toggleMute() {
    const muted = this.audio.toggleMute();
    this.renderer.showToast(muted ? 'AUDIO OFF' : 'AUDIO ON', 1200);
  }

  restart() {
    this.game.start();
    this.paused = false;
    this.prev = null;
    this.touch.active = false;
    this.touch.turn = 0;
    this.touch.thrust = 0;
    this.audio.play('upgrade');
    this.renderer.showToast('NEW RUN', 1600);
    this.renderer.addFlash(0.2, '120,220,255');
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect ? this.canvas.getBoundingClientRect() : null;
    const w = num(this.canvas.clientWidth, num(rect && rect.width, 960)) || 960;
    const h = num(this.canvas.clientHeight, num(rect && rect.height, 540)) || 540;
    const ratio = num(globalThis.devicePixelRatio, 1);
    this.renderer.resize(w, h, ratio);
  }

  hints(snap) {
    if (this.paused) return ['PAUSED — press P to resume'];
    if (snap.state === 'upgrade') {
      return ['CHOOSE ONE — press 1, 2 or 3', 'WASD / arrows fly · Space cannon · F missiles'];
    }
    if (snap.state === 'gameover') return ['RUN OVER — press R to launch again'];
    return ['WASD / arrows fly · Space cannon · F missiles · P pause · M mute · R restart'];
  }
  // --------------------------------------------------- snapshot diff -> FX --

  /**
   * The sim never announces its own events; every change between two snapshots
   * is one. Cheap to diff, and it keeps Game free of any presentation hook.
   */
  _observe(snap) {
    const prev = this.prev;
    const trace = {
      state: snap.state,
      wave: snap.wave,
      shots: snap.shotsFired,
      salvo: snap.missiles.length,
      hull: snap.player.health,
      wing: snap.wingmen.filter((w) => w.alive !== false).length,
      upgrades: snap.upgrades.length,
      ids: new Set(snap.enemies.map((e) => e.id)),
    };

    if (prev) {
      if (trace.shots > prev.shots) this.audio.play('cannon');
      if (trace.salvo > prev.salvo) this.audio.play('missile');

      let kills = 0;
      for (const id of prev.ids) if (!trace.ids.has(id)) kills += 1;
      if (kills > 0) this._boom(kills);

      if (trace.hull < prev.hull) {
        this.audio.play('hit');
        this.renderer.addShake(5);
        this.renderer.addFlash(0.16, '255,96,96');
      }

      if (trace.wing < prev.wing) {
        this.renderer.showToast('WINGMAN DOWN', 1600);
        this._boom(1);
      }

      if (trace.upgrades > prev.upgrades) {
        const picked = snap.upgrades[snap.upgrades.length - 1];
        this.audio.play('upgrade');
        this.renderer.showToast(typeof picked === 'string' ? picked.toUpperCase() : 'UPGRADE', 1600);
      }

      if (trace.state !== prev.state) this._stateChange(prev.state, trace.state, snap);
    }

    this.prev = trace;
  }

  _boom(kills) {
    this.audio.play('explode');
    this.renderer.addShake(clamp(6 + 3 * kills, 6, 18));
    this.renderer.addFlash(clamp(0.12 + 0.05 * kills, 0.12, 0.3), '255,190,120');
  }

  _stateChange(from, to, snap) {
    if (to === 'upgrade') {
      this.renderer.showToast(`WAVE ${snap.wave} CLEAR`, 2200);
      this.audio.play('waveClear');
      this.renderer.addFlash(0.24, '120,255,190');
      return;
    }
    if (to === 'gameover') {
      this.renderer.showToast('RUN OVER', 2400);
      this.renderer.addShake(24);
      this.renderer.addFlash(0.4, '255,120,90');
      this.audio.play('gameOver');
      this.audio.stopAmbient();
      return;
    }
    if (from === 'upgrade' && to === 'active') this.renderer.showToast(`WAVE ${snap.wave}`, 1800);
  }
}

function canvasLike(el) {
  return !!el && typeof el.getContext === 'function';
}

/**
 * The canvas is `#board` per the layout contract, but the shell boots from any
 * single canvas it can find rather than dying on an id mismatch.
 */
function findCanvas() {
  const doc = globalThis.document;
  if (!doc) return null;

  if (typeof doc.querySelector === 'function') {
    const picked = doc.querySelector('canvas#board');
    if (canvasLike(picked)) return picked;
  }
  for (const id of ['board', 'game']) {
    if (typeof doc.getElementById === 'function') {
      const el = doc.getElementById(id);
      if (canvasLike(el)) return el;
    }
  }
  if (typeof doc.getElementsByTagName === 'function') {
    const all = doc.getElementsByTagName('canvas') || [];
    for (const el of all) if (canvasLike(el)) return el;
  }
  return null;
}

function boot() {
  const canvas = findCanvas();
  if (!canvas) {
    if (typeof console !== 'undefined') console.warn('star-wing: no canvas found — not booting');
    return null;
  }

  const shell = new Shell(canvas);
  shell.audio.startAmbient();
  shell.start();

  window.__game = { game: shell.game, renderer: shell.renderer, audio: shell.audio };
  return shell;
}

if (typeof document !== 'undefined' && document.readyState === 'loading' &&
    typeof document.addEventListener === 'function') {
  document.addEventListener('DOMContentLoaded', () => boot());
} else {
  boot();
}
