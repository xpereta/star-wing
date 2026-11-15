// star-wing renderer — the whole presentation layer.
//
// Contract (README): `new Renderer(canvas)`, `resize(cssW, cssH, dpr)`,
// `render(snapshot, { dtMs, paused, messages })`, `addShake(mag)`,
// `addFlash(alpha)`, `showToast(text, ms)`. Nothing else is public: main.js
// drives input/audio and only hands us snapshots.
//
// Design notes:
//  - The simulation runs on a fixed arena (ARENA from the game shell). The
//    renderer owns the camera: one fit-scale + centring transform, so the
//    playfield is fully visible at any window size and aspect ratio.
//  - All animation time accumulates from the dtMs the shell hands us, never
//    from a wall clock, so a headless run and a browser run look identical.
//  - FX state (particles, shockwave rings, shake, flash, toasts) lives here and
//    decays every frame. The shell nudges it through addShake/addFlash/showToast;
//    we also derive kills ourselves by diffing consecutive snapshots, because
//    `enemies` only ever lists the living.

import { ARENA } from '../game/game.js';

const TAU = Math.PI * 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);
const ok = (v) => Number.isFinite(v);

/** Deterministic PRNG for star/nebula layout — stable across reloads. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** '#rrggbb' -> [r, g, b]. Tolerates short hex and junk (falls back to grey). */
function hexRgb(hex) {
  const s = String(hex || '').replace('#', '');
  const pair = (a, b) => (b === undefined ? parseInt(s.slice(a, a + 1).repeat(2), 16) : parseInt(s.slice(a, b), 16));
  const r = s.length >= 6 ? pair(0, 2) : pair(0, 1);
  const g = s.length >= 6 ? pair(2, 4) : pair(1, 2);
  const b = s.length >= 6 ? pair(4, 6) : pair(2, 3);
  return [clamp(num(r, 200), 0, 255), clamp(num(g, 200), 0, 255), clamp(num(b, 200), 0, 255)];
}

/** A hull colour pushed hot-red — the "I'm hurt" read on an enemy. */
function mixTint(hex) {
  const [r, g, b] = hexRgb(hex);
  const t = 0.55;
  return `rgba(${Math.round(lerp(r, 255, t))},${Math.round(lerp(g, 80, t))},${Math.round(lerp(b, 80, t))},0.85)`;
}

/**
 * Safe {x, y} copy of a snapshot point list. The sim never puts holes in these
 * arrays, but a frame that is short or malformed should not take the render —
 * and with it the run — down.
 */
function pts(list) {
  const out = [];
  for (const p of list || []) {
    if (p && ok(p.x) && ok(p.y)) out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** Palette: one hue family per faction, hot whites for ordnance. */
const COLORS = Object.freeze({
  player: '#8ff4ff',
  playerEdge: '#e8fdff',
  wing: '#7fd6c8',
  flameCore: '#fff6d0',
  flame: '#ffb43c',
  flameSmoke: '#8d6a4a',
  bullet: '#fff2b0',
  missile: '#ffd98a',
  missileBody: '#cfd8e6',
  smoke: '#9aa4b4',
  spark: '#ffd27a',
  hud: '#cfe9ff',
  hudDim: 'rgba(160,190,220,0.55)',
  danger: '#ff5470',
  good: '#66f0a8',
});

const KIND_LOOK = Object.freeze({
  scout: Object.freeze({ color: '#ff9ec4', edge: '#ffd9e8', size: 11 }),
  fighter: Object.freeze({ color: '#ffb45c', edge: '#ffe6c4', size: 14 }),
  bomber: Object.freeze({ color: '#ff6470', edge: '#ffc8cd', size: 19 }),
  interceptor: Object.freeze({ color: '#c07dff', edge: '#ecd4ff', size: 13 }),
});
const DEFAULT_LOOK = Object.freeze({ color: '#ff8f9a', edge: '#ffd2d6', size: 13 });

const MAX_PARTICLES = 900;

/**
 * Silhouettes in nose-forward units: +x is the nose, +y the right wing. The
 * renderer scales these by each ship's size, so one table covers every role.
 */
const SHAPES = Object.freeze({
  player: Object.freeze([
    Object.freeze([1.2, 0]), Object.freeze([0.25, 0.5]), Object.freeze([-0.7, 0.8]),
    Object.freeze([-0.35, 0]), Object.freeze([-0.7, -0.8]), Object.freeze([0.25, -0.5]),
  ]),
  wing: Object.freeze([
    Object.freeze([1, 0]), Object.freeze([-0.55, 0.62]),
    Object.freeze([-0.25, 0]), Object.freeze([-0.55, -0.62]),
  ]),
  scout: Object.freeze([
    Object.freeze([0.95, 0]), Object.freeze([-0.55, 0.55]),
    Object.freeze([-0.3, 0]), Object.freeze([-0.55, -0.55]),
  ]),
  fighter: Object.freeze([
    Object.freeze([1, 0]), Object.freeze([0.15, 0.8]), Object.freeze([-0.7, 0.6]),
    Object.freeze([-0.35, 0]), Object.freeze([-0.7, -0.6]), Object.freeze([0.15, -0.8]),
  ]),
  bomber: Object.freeze([
    Object.freeze([0.85, 0]), Object.freeze([0.35, 0.72]), Object.freeze([-0.75, 0.85]),
    Object.freeze([-0.95, 0]), Object.freeze([-0.75, -0.85]), Object.freeze([0.35, -0.72]),
  ]),
  interceptor: Object.freeze([
    Object.freeze([1.25, 0]), Object.freeze([-0.3, 0.95]),
    Object.freeze([-0.05, 0]), Object.freeze([-0.3, -0.95]),
  ]),
});

export class Renderer {
  constructor(canvasElement) {
    if (!canvasElement) throw new Error('Renderer needs a canvas element');
    const ctx = canvasElement.getContext && canvasElement.getContext('2d');
    if (!ctx) throw new Error('Renderer: no 2d context on the canvas');
    this.canvas = canvasElement;
    this.ctx = ctx;

    this.dpr = 1;
    this.cssW = 960;
    this.cssH = 540;
    this.w = 960;
    this.h = 540;

    this.time = 0; // ms of rendered time (never a wall clock)
    this.frame = 0;
    this.kills = 0; // counted from enemy-count diffs; reset on a new run

    // Transient screen FX, all decayed in _advanceFx.
    this.shake = 0;
    this.flash = 0;
    this.flashTint = '255,255,255';
    this.toasts = [];
    this.particles = [];
    this.rings = [];

    // Snapshot diffing state: what the last frame looked like.
    this.prev = {
      state: 'active',
      wave: 1,
      score: 0,
      hull: 0,
      shots: 0,
      enemies: new Map(), // id -> { x, y, kind } of the last frame it lived
      bullets: [],
      missiles: [],
      speed: 0,
      wingAlive: 0,
    };

    this._rng = mulberry32(0x57a7a17);
    this.stars = this._buildStars();
    this.nebulae = this._buildNebula();
    this.view = { scale: 1, ox: 0, oy: 0 };
    this.thrust = 0.55; // inferred throttle, smoothed in _observe
    this.roundVec = { bullets: [], missiles: [] };
    this.wingVec = [];

    this.resize(canvasElement.clientWidth, canvasElement.clientHeight, 1);
  }

  // ------------------------------------------------------------------ layout --

  /**
   * Make the backing store match the CSS box at `dpr`. MUST leave canvas.width
   * and canvas.height finite and positive — a resize to a collapsed window has
   * to clamp rather than zero the surface, or every later draw is wasted.
   */
  resize(cssWidth, cssHeight, dpr = (typeof globalThis !== 'undefined' && globalThis.devicePixelRatio) || 1) {
    const rect = this.canvas.getBoundingClientRect ? this.canvas.getBoundingClientRect() : null;
    const cw = num(cssWidth, num(rect && rect.width, num(this.canvas.clientWidth, this.cssW)));
    const ch = num(cssHeight, num(rect && rect.height, num(this.canvas.clientHeight, this.cssH)));
    const ratio = num(dpr, 1);

    this.cssW = Math.max(1, Math.round(cw));
    this.cssH = Math.max(1, Math.round(ch));
    this.dpr = clamp(ratio, 0.5, 4);
    this.w = Math.max(1, Math.round(this.cssW * this.dpr));
    this.h = Math.max(1, Math.round(this.cssH * this.dpr));

    this.canvas.width = this.w;
    this.canvas.height = this.h;

    // Fit the arena inside the viewport, then centre it: the whole playfield is
    // always on screen, and the letterbox bands get the nebula/vignette instead.
    const scale = Math.min(this.cssW / ARENA.width, this.cssH / ARENA.height);
    this.view = {
      scale: ok(scale) && scale > 0 ? scale : 1,
      ox: (this.cssW - ARENA.width * scale) / 2,
      oy: (this.cssH - ARENA.height * scale) / 2,
    };

    // Stars are stored in normalized space so a resize keeps the sky identical.
    if (!this.stars) this.stars = this._buildStars();
    return { width: this.canvas.width, height: this.canvas.height };
  }

  /** Three parallax layers, denser+dimmer = farther away. */
  _buildStars() {
    const rnd = mulberry32(0x9e3779b9);
    const layers = [
      { depth: 0.10, count: 190, rMin: 0.35, rMax: 0.9, alpha: 0.45, tint: 210 },
      { depth: 0.28, count: 130, rMin: 0.6, rMax: 1.5, alpha: 0.7, tint: 190 },
      { depth: 0.62, count: 70, rMin: 1.0, rMax: 2.2, alpha: 0.95, tint: 45 },
    ];
    for (const layer of layers) {
      layer.pts = [];
      for (let i = 0; i < layer.count; i++) {
        layer.pts.push({
          x: rnd(),
          y: rnd(),
          r: lerp(layer.rMin, layer.rMax, rnd()),
          tw: rnd() * TAU, // twinkle phase
          twRate: 0.6 + rnd() * 2.4,
        });
      }
    }
    return layers;
  }

  /** Soft radial nebulae: painted once per frame under the starfield. */
  _buildNebula() {
    const rnd = mulberry32(0x2545f491);
    const tints = [
      ['124,58,237', '236,72,153'], // violet -> rose
      ['14,165,233', '34,197,94'], // azure -> teal
      ['244,114,182', '250,204,21'], // rose -> amber
      ['45,212,191', '59,130,246'], // teal -> blue
    ];
    const out = [];
    for (let i = 0; i < tints.length; i++) {
      out.push({
        x: 0.12 + rnd() * 0.76,
        y: 0.1 + rnd() * 0.8,
        r: 0.32 + rnd() * 0.42,
        inner: tints[i][0],
        outer: tints[i][1],
        alpha: 0.10 + rnd() * 0.12,
        drift: 0.15 + rnd() * 0.35,
        phase: rnd() * TAU,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------- fx api --

  /** Kick the camera. Magnitude is in arena pixels; it decays as it plays. */
  addShake(magnitude) {
    this.shake = Math.min(46, this.shake + Math.abs(num(magnitude, 6)));
  }

  /** Full-screen additive flash; `alpha` in 0..1 and additive across calls. */
  addFlash(alpha, tint) {
    this.flash = Math.min(1, this.flash + clamp01(num(alpha, 0.35)));
    if (tint) this.flashTint = tint;
  }

  /** Transient banner text; the HUD stacks live toasts under the score bar. */
  showToast(text, ms = 1900) {
    const value = typeof text === 'string' ? text : String(text == null ? '' : text);
    if (!value) return;
    const life = Math.max(300, num(ms, 1900));
    // A repeat of the current toast refreshes it instead of stacking twins.
    const live = this.toasts.find((t) => t.text === value);
    if (live) {
      live.ttl = life;
      live.ttlMax = life;
      return;
    }
    this.toasts.push({ text: value, ttl: life, ttlMax: life });
    if (this.toasts.length > 5) this.toasts.shift();
  }

  // ------------------------------------------------------------------- frame --

  /**
   * Draw one frame. `snapshot` is the shell's only view of the sim; `options`
   * is `{ dtMs, paused, messages }`, all optional.
   */
  render(snapshot, options = {}) {
    const dtMs = clamp(num(options.dtMs, 16.7), 1, 120);
    const dt = dtMs / 1000;
    this.frame += 1;
    this.time += dtMs;

    const snap = snapshot && typeof snapshot === 'object' ? snapshot : null;

    // Safety net: a surface that has never been resized (or collapsed to zero)
    // would make every later draw a no-op, so fix it before anything else.
    if (!ok(this.canvas.width) || !ok(this.canvas.height) || this.canvas.width <= 0 || this.canvas.height <= 0) {
      this.resize(this.cssW, this.cssH, this.dpr);
    }

    this._advanceFx(dt);
    if (snap) this._observe(snap, dt);

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    // Sky: backdrop + parallax, deliberately unshaken so the shake reads as
    // the camera fighting the impact rather than the whole universe lurching.
    this._paintBackdrop();
    this._paintStars(snap);

    ctx.save();
    this._applyShake();
    ctx.translate(this.view.ox, this.view.oy);
    ctx.scale(this.view.scale, this.view.scale);
    this._paintArena(snap);
    this._paintSmoke();
    this._paintRings();
    if (snap) {
      this._paintMissiles(snap);
      this._paintBullets(snap);
      this._paintEnemies(snap);
      this._paintWingmen(snap);
      this._paintPlayer(snap);
    }
    this._paintSparks();
    ctx.restore();

    // Screen-space post pass + chrome.
    this._paintVignette();
    this._paintFlashOverlay();
    if (snap) {
      this._paintHud(snap, options);
      this._paintOverlay(snap, options);
    }
    this._paintToasts(options);
    return this;
  }

  // ------------------------------------------------------ snapshot diffing --

  /**
   * Compare this snapshot with the previous one and turn the deltas into FX:
   * vanished enemies explode, health drops flash, ships and missiles trail.
   * The sim never reports deaths — `enemies` only lists the living — so the
   * renderer keeps its own id -> position memory between frames.
   */
  _observe(snap, dt) {
    const prev = this.prev;
    const rnd = this._rng;
    const player = snap.player || {};

    // --- enemy bookkeeping: motion vectors need last frame's positions first.
    const now = new Map();
    for (const e of snap.enemies || []) {
      if (!e || !ok(e.x) || !ok(e.y)) continue;
      const seen = prev.enemies.get(e.id);
      const hp = num(e.health, 0);
      now.set(e.id, {
        x: e.x,
        y: e.y,
        kind: e.kind,
        hp,
        hpMax: seen ? Math.max(seen.hpMax, hp) : Math.max(hp, 1),
      });
    }

    const scoreUp = num(snap.score, 0) - num(prev.score, 0);
    // A score that goes backwards means the shell started a new run.
    if (scoreUp < 0 || (prev.state === 'gameover' && snap.state === 'active')) this.kills = 0;
    for (const [id, ghost] of prev.enemies) {
      if (now.has(id)) continue;
      this.kills += 1;
      const look = KIND_LOOK[ghost.kind] || DEFAULT_LOOK;
      const heavy = ghost.kind === 'bomber';
      this._explode(ghost.x, ghost.y, look, heavy ? 1.6 : 1);
      this._ring(ghost.x, ghost.y, heavy ? 120 : 84, look.color);
      this.addShake(heavy ? 12 : 7);
      if (scoreUp > 0) this._popText(ghost.x, ghost.y, `+${scoreUp}`, COLORS.good);
    }

    // --- ordnance: nearest-prev match gives each round its travel vector,
    // which is what turns a dot into a tracer and a missile into an arc.
    const bulletVec = this._motionVectors(prev.bullets, snap.bullets, 90);
    const missileVec = this._motionVectors(prev.missiles, snap.missiles, 140);
    this.roundVec = { bullets: bulletVec, missiles: missileVec };

    for (const m of snap.missiles || []) {
      if (!m || !ok(m.x) || !ok(m.y)) continue;
      this._smokePuff(m.x, m.y, rnd);
    }

    // --- engine trails, keyed off how fast each ship is actually moving.
    const pdx = num(player.vx, 0) * dt;
    const pdy = num(player.vy, 0) * dt;
    this._trail(player.x, player.y, player.heading, pdx, pdy, 1, COLORS.flame, rnd);
    const liveWing = (snap.wingmen || []).filter((w) => w && w.alive && ok(w.x) && ok(w.y));
    const wingVec = this._motionVectors(prev.wingmen, liveWing, 120);
    for (let i = 0; i < liveWing.length; i++) {
      const w = liveWing[i];
      const v = wingVec[i] || { dx: 0, dy: 0 };
      this._trail(w.x, w.y, w.heading, v.dx, v.dy, 0.62, COLORS.flame, rnd);
    }
    this.wingVec = wingVec;

    // --- damage taken by the player: flash the screen, spit debris.
    const hull = num(player.health, 0);
    if (ok(prev.hull) && hull < prev.hull - 0.5) {
      const bite = clamp01((prev.hull - hull) / Math.max(1, num(player.maxHealth, 100)));
      this.addFlash(0.12 + bite * 0.5, '255,90,110');
      this.addShake(6 + bite * 26);
      for (let i = 0; i < 10; i++) {
        this._spark(num(player.x, 0), num(player.y, 0), 120 + rnd() * 200, COLORS.danger, 0.45);
      }
    }

    // --- run milestones.
    if (snap.wave !== prev.wave && num(snap.wave, 0) > num(prev.wave, 0)) {
      this.addFlash(0.18, '140,220,255');
      this._ring(num(player.x, ARENA.width / 2), num(player.y, ARENA.height / 2), 260, '#8ff4ff');
    }
    if (snap.state === 'gameover' && prev.state !== 'gameover') {
      this._explode(num(player.x, 0), num(player.y, 0), { color: COLORS.player, edge: '#ffffff', size: 16 }, 2.2);
      this._ring(num(player.x, 0), num(player.y, 0), 320, COLORS.player);
      this.addFlash(0.8, '255,255,255');
      this.addShake(34);
    }

    prev.state = snap.state;
    prev.wave = snap.wave;
    prev.score = snap.score;
    prev.hull = hull;
    prev.shots = num(snap.shotsFired, prev.shots);
    const speed = Math.hypot(num(player.vx, 0), num(player.vy, 0));
    // Thrust is inferred, not reported: velocity gain lights the burner, drag
    // dims it. Smoothed so the flame never strobes frame to frame.
    const accel = (speed - num(prev.speed, speed)) / Math.max(dt, 1e-4);
    const target = clamp01(0.55 + accel / 420);
    this.thrust = lerp(this.thrust, target, 1 - Math.exp(-7 * dt));
    prev.speed = speed;
    prev.enemies = now;
    prev.bullets = pts(snap.bullets);
    prev.missiles = pts(snap.missiles);
    prev.wingmen = liveWing.map((w) => ({ x: w.x, y: w.y }));
  }

  /**
   * Per-frame travel vectors for a list of moving points. When the population
   * is unchanged the arrays pair up by index (exact and free); when rounds were
   * spent or expire the pairing is by nearest neighbour instead.
   */
  _motionVectors(prevPts, curPts, maxDist) {
    const a = prevPts || [];
    const b = curPts || [];
    const out = new Array(b.length);
    for (let i = 0; i < b.length; i++) out[i] = { dx: 0, dy: 0 };
    if (a.length === b.length) {
      for (let i = 0; i < b.length; i++) {
        if (!b[i] || !a[i]) continue;
        out[i] = { dx: num(b[i].x, 0) - num(a[i].x, 0), dy: num(b[i].y, 0) - num(a[i].y, 0) };
      }
      return out;
    }
    for (let i = 0; i < b.length; i++) {
      if (!b[i]) continue;
      let best = null;
      let bestD = maxDist * maxDist;
      for (let j = 0; j < a.length; j++) {
        if (!a[j]) continue;
        const dx = num(b[i].x, 0) - num(a[j].x, 0);
        const dy = num(b[i].y, 0) - num(a[j].y, 0);
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { dx, dy };
        }
      }
      if (best) out[i] = best;
    }
    return out;
  }

  // ------------------------------------------------------------- fx plumbing --

  /** One place decays every transient: shake, flash, toasts, particles, rings. */
  _advanceFx(dt) {
    this.shake *= Math.exp(-7.5 * dt);
    if (this.shake < 0.05) this.shake = 0;
    this.flash *= Math.exp(-4.2 * dt);
    if (this.flash < 0.004) this.flash = 0;

    const ms = dt * 1000;
    for (const t of this.toasts) t.ttl -= ms;
    this.toasts = this.toasts.filter((t) => t.ttl > 0);

    const keep = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      const damp = Math.exp(-p.drag * dt);
      p.vx *= damp;
      p.vy *= damp;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.r += p.grow * dt;
      keep.push(p);
    }
    this.particles = keep;

    const rings = [];
    for (const ring of this.rings) {
      ring.life -= dt;
      if (ring.life <= 0) continue;
      const t = 1 - ring.life / ring.ttl;
      ring.r = lerp(ring.r0, ring.rMax, 1 - Math.pow(1 - t, 2.2));
      rings.push(ring);
    }
    this.rings = rings;
  }

  _push(p) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    p.ttl = p.life;
    p.a = num(p.a, 1); // peak alpha; fade is linear against ttl
    this.particles.push(p);
  }

  /** Expanding shockwave ring — the signature of a confirmed kill. */
  _ring(x, y, rMax, color) {
    this.rings.push({
      x, y, r: 6, r0: 6, rMax: Math.max(20, rMax),
      life: 0.55, ttl: 0.55, color: color || '#ffffff', width: 3.5,
    });
    if (this.rings.length > 60) this.rings.shift();
  }

  /** Floating combat text ("+110"), rides the same pool as the particles. */
  _popText(x, y, text, color) {
    this._push({
      x, y: y - 6, vx: 0, vy: -34,
      life: 1.15, r: 12, grow: 0, drag: 0.6,
      layer: 'text', a: 1, text, color: color || COLORS.hud,
    });
  }

  _spark(x, y, speed, color, life = 0.5) {
    const rnd = this._rng;
    const a = rnd() * TAU;
    this._push({
      x, y,
      vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
      life: life * (0.6 + rnd() * 0.8),
      r: 1 + rnd() * 1.6, grow: -0.3, drag: 2.4,
      layer: 'spark', a: 0.9, color,
    });
  }

  /** Missile exhaust: slow, fat, grey — reads as a smoke trail, not a flame. */
  _smokePuff(x, y, rnd) {
    this._push({
      x: x + (rnd() - 0.5) * 3, y: y + (rnd() - 0.5) * 3,
      vx: (rnd() - 0.5) * 26, vy: (rnd() - 0.5) * 26,
      life: 0.5 + rnd() * 0.6,
      r: 2.4 + rnd() * 2.2, grow: 11, drag: 2.8,
      layer: 'smoke', a: 0.34, color: COLORS.smoke,
    });
  }

  /**
   * Engine exhaust. `dx`/`dy` are the ship's travel over the last frame, so a
   * coasting ship trails hard and a stationary one barely farts.
   */
  _trail(x, y, heading, dx, dy, scale, color, rnd) {
    const moved = Math.hypot(dx, dy);
    const throttle = scale >= 1 ? this.thrust : clamp01(moved / 5) * scale;
    if (throttle < 0.08) return;
    const back = num(heading, 0) + Math.PI;
    const nozzle = 9 * scale;
    const count = throttle > 0.55 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const spread = (rnd() - 0.5) * 0.7;
      const dir = back + spread;
      const sp = (30 + throttle * 190) * (0.6 + rnd() * 0.6);
      this._push({
        x: x + Math.cos(back) * nozzle, y: y + Math.sin(back) * nozzle,
        vx: Math.cos(dir) * sp - dx * 12, vy: Math.sin(dir) * sp - dy * 12,
        life: 0.22 + rnd() * 0.35,
        r: 2 + throttle * 3.5 * scale, grow: 3.5, drag: 3.4,
        layer: 'spark', a: 0.42 * throttle + 0.18,
        color: rnd() < 0.45 ? color : COLORS.flameCore,
      });
    }
  }

  /** Camera kick. Noise is time-derived, so two runs shake identically. */
  _applyShake() {
    if (this.shake <= 0.05) return;
    const t = this.time * 0.055;
    const m = this.shake;
    const ctx = this.ctx;
    ctx.translate(
      Math.sin(t * 3.7) * m * 0.9 + Math.sin(t * 11.3) * m * 0.35,
      Math.cos(t * 4.3) * m * 0.9 + Math.sin(t * 9.1) * m * 0.3,
    );
  }
  /** Death burst: hot sparks additively, a few slow puffs of debris smoke. */
  _explode(x, y, look, scale = 1) {
    const rnd = this._rng;
    const sparks = Math.round(clamp(16 + look.size * 1.5, 18, 46) * scale);
    for (let i = 0; i < sparks; i++) {
      const a = rnd() * TAU;
      const sp = (40 + rnd() * 320) * scale;
      this._push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.25 + rnd() * 0.75 * scale,
        r: 1 + rnd() * 2.4 * scale, grow: -0.5, drag: 1.9,
        layer: 'spark', a: 0.95,
        color: rnd() < 0.34 ? '#ffffff' : rnd() < 0.6 ? COLORS.spark : look.color,
      });
    }
    for (let i = 0; i < Math.round(7 * scale); i++) {
      const a = rnd() * TAU;
      const sp = 20 + rnd() * 90;
      this._push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.6 + rnd() * 0.9,
        r: 4 + rnd() * 7, grow: 9, drag: 2.6,
        layer: 'smoke', a: 0.3, color: COLORS.smoke,
      });
    }
  }

  // ------------------------------------------------------------- background --

  /** Deep-space wash + drifting nebulae, painted in screen space. */
  _paintBackdrop() {
    const ctx = this.ctx;
    const w = this.cssW;
    const h = this.cssH;

    const base = ctx.createLinearGradient(0, 0, 0, h);
    base.addColorStop(0, '#050711');
    base.addColorStop(0.55, '#070a16');
    base.addColorStop(1, '#03040a');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const t = this.time * 0.00012;
    for (const neb of this.nebulae) {
      const cx = (neb.x + Math.sin(t * neb.drift + neb.phase) * 0.05) * w;
      const cy = (neb.y + Math.cos(t * neb.drift * 1.3 + neb.phase) * 0.045) * h;
      const rad = neb.r * Math.max(w, h) * (0.9 + 0.1 * Math.sin(t * 2 + neb.phase));
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, `rgba(${neb.inner},${neb.alpha})`);
      g.addColorStop(0.45, `rgba(${neb.outer},${neb.alpha * 0.45})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    }
    ctx.restore();
  }

  /**
   * Three parallax layers. The camera does not scroll — the arena is the whole
   * playfield — so parallax comes from the player's own position: swing across
   * the map and the near stars slide against the far ones.
   */
  _paintStars(snap) {
    const ctx = this.ctx;
    const w = this.cssW;
    const h = this.cssH;
    const p = (snap && snap.player) || {};
    const px = (num(p.x, ARENA.width / 2) - ARENA.width / 2) / ARENA.width;
    const py = (num(p.y, ARENA.height / 2) - ARENA.height / 2) / ARENA.height;
    const drift = this.time * 0.0000075;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const layer of this.stars) {
      const offX = -px * layer.depth * 0.55 + drift * layer.depth;
      const offY = -py * layer.depth * 0.55;
      for (const s of layer.pts) {
        const fx = (((s.x + offX) % 1) + 1) % 1;
        const fy = (((s.y + offY) % 1) + 1) % 1;
        const x = fx * w;
        const y = fy * h;
        const tw = 0.6 + 0.4 * Math.sin(s.tw + this.time * 0.0016 * s.twRate);
        const a = layer.alpha * tw;
        if (s.r < 0.8) {
          ctx.globalAlpha = a * 0.9;
          ctx.fillStyle = '#cfe4ff';
          ctx.fillRect(x, y, 1.2, 1.2);
        } else {
          ctx.globalAlpha = a;
          ctx.fillStyle = layer.tint > 100 ? '#eaf4ff' : '#fff3d6';
          ctx.beginPath();
          ctx.arc(x, y, s.r, 0, TAU);
          ctx.fill();
          if (layer.depth > 0.5 && tw > 0.85) {
            // Bright layer gets a four-point glint: cheap, reads like a lens.
            ctx.globalAlpha = a * 0.35;
            const arm = s.r * 3.2;
            ctx.fillRect(x - arm, y - 0.4, arm * 2, 0.8);
            ctx.fillRect(x - 0.4, y - arm, 0.8, arm * 2);
          }
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /** The playfield: grid, rim glow, corner brackets. World space. */
  _paintArena(snap) {
    const ctx = this.ctx;
    const W = ARENA.width;
    const H = ARENA.height;

    ctx.save();
    ctx.globalAlpha = 0.09;
    ctx.strokeStyle = '#4a6a96';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 160; x < W; x += 160) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    for (let y = 160; y < H; y += 160) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
    ctx.restore();

    // Danger rim: the soft wall the shell banks you back away from.
    const pulse = 0.32 + 0.1 * Math.sin(this.time * 0.0022);
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = '#2f6f9a';
    ctx.lineWidth = 2;
    ctx.strokeRect(4, 4, W - 8, H - 8);
    ctx.globalAlpha = pulse * 0.35;
    ctx.lineWidth = 12;
    ctx.strokeRect(4, 4, W - 8, H - 8);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = snap && snap.state === 'gameover' ? COLORS.danger : '#7fb6d8';
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 3;
    const arm = 34;
    const corners = [[8, 8, 1, 1], [W - 8, 8, -1, 1], [8, H - 8, 1, -1], [W - 8, H - 8, -1, -1]];
    for (const [cx, cy, sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx + sx * arm, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + sy * arm);
      ctx.stroke();
    }
    ctx.restore();
  }

  // -------------------------------------------------------------- particles --

  /** Debris/smoke half of the particle pool — drawn under the ships. */
  _paintSmoke() {
    const ctx = this.ctx;
    ctx.save();
    for (const p of this.particles) {
      if (p.layer !== 'smoke') continue;
      const k = p.life / p.ttl;
      ctx.globalAlpha = p.a * k * k;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.4, p.r), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Sparks and floating text — drawn over the ships so they read as light. */
  _paintSparks() {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      if (p.layer !== 'spark') continue;
      const k = p.life / p.ttl;
      ctx.globalAlpha = p.a * k;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.4, p.r), 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    for (const p of this.particles) {
      if (p.layer !== 'text') continue;
      const k = p.life / p.ttl;
      ctx.globalAlpha = clamp01(k * 1.4);
      ctx.font = '600 15px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.restore();
  }

  /** Kill shockwaves: an additive ring that widens and thins as it dies. */
  _paintRings() {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const ring of this.rings) {
      const k = ring.life / ring.ttl;
      ctx.globalAlpha = 0.75 * k;
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = Math.max(0.5, ring.width * k);
      ctx.shadowColor = ring.color;
      ctx.shadowBlur = 14 * k;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, Math.max(1, ring.r), 0, TAU);
      ctx.stroke();
      // Inner echo ring for a bit more depth.
      ctx.globalAlpha = 0.3 * k;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, Math.max(1, ring.r * 0.62), 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  // --------------------------------------------------------------- ordnance --

  /** Cannon rounds: bright tracers stretched along their own travel vector. */
  _paintBullets(snap) {
    const ctx = this.ctx;
    const list = snap.bullets || [];
    const vecs = (this.roundVec && this.roundVec.bullets) || [];
    const fallback = num(snap.player && snap.player.heading, 0);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.shadowColor = COLORS.bullet;
    ctx.shadowBlur = 12;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b || !ok(b.x) || !ok(b.y)) continue;
      const v = vecs[i] || { dx: 0, dy: 0 };
      const moved = Math.hypot(v.dx, v.dy);
      const ang = moved > 0.5 ? Math.atan2(v.dy, v.dx) : fallback;
      const stretch = clamp(moved * 1.8, 6, 26);
      const tx = b.x - Math.cos(ang) * stretch;
      const ty = b.y - Math.sin(ang) * stretch;

      const g = ctx.createLinearGradient(tx, ty, b.x, b.y);
      g.addColorStop(0, 'rgba(255,210,120,0)');
      g.addColorStop(0.55, 'rgba(255,225,150,0.85)');
      g.addColorStop(1, '#ffffff');
      ctx.strokeStyle = g;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      ctx.fillStyle = '#fffbe8';
      ctx.beginPath();
      ctx.arc(b.x, b.y, 1.7, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Missiles: a dart with a burner, plus a swept glow arc that shows the curve
   * it is flying. The smoke it leaves behind is emitted in _observe and drawn
   * by the under-ship smoke pass, so the trail reads as a proper exhaust plume.
   */
  _paintMissiles(snap) {
    const ctx = this.ctx;
    const list = snap.missiles || [];
    const vecs = (this.roundVec && this.roundVec.missiles) || [];

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m || !ok(m.x) || !ok(m.y)) continue;
      const v = vecs[i] || { dx: 0, dy: 0 };
      const moved = Math.hypot(v.dx, v.dy);
      const ang = moved > 0.5 ? Math.atan2(v.dy, v.dx) : num(snap.player && snap.player.heading, 0);
      const nx = Math.cos(ang);
      const ny = Math.sin(ang);

      // Arc: a quadratic bow perpendicular to travel — visible turn, no history.
      const bend = clamp(moved * 0.35, 3, 14);
      const ax = m.x - nx * 34;
      const ay = m.y - ny * 34;
      const cx = (m.x + ax) / 2 - ny * bend;
      const cy = (m.y + ay) / 2 + nx * bend;
      const g = ctx.createLinearGradient(ax, ay, m.x, m.y);
      g.addColorStop(0, 'rgba(255,180,90,0)');
      g.addColorStop(1, 'rgba(255,214,140,0.75)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 3.2;
      ctx.shadowColor = COLORS.missile;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(cx, cy, m.x, m.y);
      ctx.stroke();

      // Body + burner.
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(ang);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = COLORS.missileBody;
      ctx.strokeStyle = '#8fa3bd';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(7, 0);
      ctx.lineTo(-4, 2.6);
      ctx.lineTo(-6, 0);
      ctx.lineTo(-4, -2.6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.globalCompositeOperation = 'lighter';
      const flameLen = 8 + 4 * Math.abs(Math.sin(this.time * 0.02 + i));
      const fg = ctx.createLinearGradient(-6, 0, -6 - flameLen, 0);
      fg.addColorStop(0, 'rgba(255,255,225,0.95)');
      fg.addColorStop(0.5, 'rgba(255,170,60,0.6)');
      fg.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(-6, 2.2);
      ctx.lineTo(-6 - flameLen, 0);
      ctx.lineTo(-6, -2.2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ ships --

  /**
   * One silhouette per role, in nose-forward units of `size`. Keeping these as
   * tables (instead of a pile of if-branches) is what makes a screenful of
   * different enemies legible at a glance.
   */
  _hull(x, y, heading, size, shape) {
    const ctx = this.ctx;
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    ctx.beginPath();
    let first = true;
    for (const [ux, uy] of shape) {
      const px = x + (ux * c - uy * s) * size;
      const py = y + (ux * s + uy * c) * size;
      if (first) {
        ctx.moveTo(px, py);
        first = false;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.closePath();
  }

  /** Burner plume: length and brightness ride the inferred throttle. */
  _flame(x, y, heading, size, throttle, seed = 0) {
    if (throttle <= 0.02) return;
    const ctx = this.ctx;
    const pulse = 0.72 + 0.28 * Math.sin(this.time * 0.019 + seed * 2.3);
    const len = size * (0.55 + throttle * 1.5) * pulse;
    const back = heading + Math.PI;
    const tipX = x + Math.cos(back) * (size * 0.62 + len);
    const tipY = y + Math.sin(back) * (size * 0.62 + len);
    const baseX = x + Math.cos(back) * size * 0.55;
    const baseY = y + Math.sin(back) * size * 0.55;
    const px = -Math.sin(back);
    const py = Math.cos(back);
    const w = size * (0.3 + 0.16 * throttle);

    const g = ctx.createLinearGradient(baseX, baseY, tipX, tipY);
    g.addColorStop(0, 'rgba(255,252,235,0.95)');
    g.addColorStop(0.35, 'rgba(255,190,80,0.72)');
    g.addColorStop(1, 'rgba(255,110,40,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(baseX + px * w, baseY + py * w);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(baseX - px * w, baseY - py * w);
    ctx.closePath();
    ctx.fill();
  }

  /** A ship: hull fill, hot edge, glow, burner. Drawn in world space. */
  _ship(x, y, heading, size, shape, fill, edge, glow, throttle, seed = 0) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this._flame(x, y, heading, size, throttle, seed);
    ctx.restore();

    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = 16;
    ctx.fillStyle = fill;
    this._hull(x, y, heading, size, shape);
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = edge;
    this._hull(x, y, heading, size, shape);
    ctx.stroke();
    ctx.restore();

    // Cockpit highlight, offset toward the nose.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(240,252,255,0.75)';
    ctx.beginPath();
    ctx.arc(x + Math.cos(heading) * size * 0.28, y + Math.sin(heading) * size * 0.28, size * 0.17, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  _paintPlayer(snap) {
    const ctx = this.ctx;
    const p = snap.player || {};
    if (!ok(p.x) || !ok(p.y)) return;
    const heading = num(p.heading, 0);
    const size = 15;
    const hurt = num(p.health, 0) <= num(p.maxHealth, 100) * 0.3;

    // Lock-on halo: the shell only hands us ammo, so "ready" is enough.
    if (num(p.missileAmmo, 0) > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.16 + 0.06 * Math.sin(this.time * 0.004);
      ctx.strokeStyle = COLORS.missile;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size * 1.9, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    this._ship(p.x, p.y, heading, size, SHAPES.player,
      hurt ? 'rgba(255,110,130,0.85)' : 'rgba(120,225,255,0.8)',
      hurt ? '#ffd2da' : COLORS.playerEdge,
      hurt ? COLORS.danger : COLORS.player,
      this.thrust, 0);

    // Cannon cooldown ring: how long until the next shot, in the hull's hue.
    const cool = clamp01(num(p.cannonTimer, 0) / 0.25);
    if (cool > 0.02) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = COLORS.bullet;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size * 1.35, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - cool));
      ctx.stroke();
      ctx.restore();
    }
  }

  _paintWingmen(snap) {
    const ctx = this.ctx;
    const list = snap.wingmen || [];
    const vecs = this.wingVec || [];
    let slot = 0;
    for (const w of list) {
      if (!w) continue;
      if (!w.alive) {
        // A downed wingman leaves a drifting beacon until the next wave.
        if (ok(w.x) && ok(w.y)) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.18 + 0.12 * Math.sin(this.time * 0.006 + slot);
          ctx.strokeStyle = COLORS.wing;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(w.x, w.y, 9, 0, TAU);
          ctx.stroke();
          ctx.restore();
        }
        continue;
      }
      if (!ok(w.x) || !ok(w.y)) continue;
      const heading = num(w.heading, 0);
      const size = 12;
      const throttle = 0.55 + 0.35 * Math.sin(this.time * 0.004 + slot * 1.7);
      this._ship(w.x, w.y, heading, size, SHAPES.wing,
        'rgba(110,205,190,0.72)', '#d6fff4', COLORS.wing, throttle, slot + 1);

      // Formation health: a stubby bar over the wing, only when it is hurt.
      const hp = clamp01(num(w.health, 1) / 100);
      if (hp < 0.999) {
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = 'rgba(10,16,26,0.75)';
        ctx.fillRect(w.x - 10, w.y - size - 8, 20, 3);
        ctx.fillStyle = hp > 0.4 ? COLORS.good : COLORS.danger;
        ctx.fillRect(w.x - 10, w.y - size - 8, 20 * hp, 3);
        ctx.restore();
      }
      slot += 1;
    }
  }

  /**
   * Enemies. Silhouette and hue come from `kind`; damage shows as a hot red
   * rim plus a tick bar, both tracked from our own frame-to-frame memory since
   * the snapshot carries current health but no maximum.
   */
  _paintEnemies(snap) {
    const ctx = this.ctx;
    const known = this.prev.enemies;
    const list = snap.enemies || [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || !ok(e.x) || !ok(e.y)) continue;
      const look = KIND_LOOK[e.kind] || DEFAULT_LOOK;
      const ghost = known.get(e.id);
      const hp = num(e.health, 0);
      const hpMax = ghost && ghost.hpMax > 0 ? ghost.hpMax : Math.max(hp, 1);
      const hurt = hp / hpMax < 0.72;
      const size = look.size;
      const heading = num(e.heading, 0);
      const fill = hurt ? mixTint(look.color) : look.color;

      this._ship(e.x, e.y, heading, size, SHAPES[e.kind] || SHAPES.fighter,
        fill, hurt ? '#ffdada' : look.edge, look.color, 0.6 + 0.3 * Math.sin(this.time * 0.005 + i), i + 2);

      if (hp < hpMax - 0.01) {
        const w = size * 1.6;
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = 'rgba(10,16,26,0.7)';
        ctx.fillRect(e.x - w / 2, e.y - size - 8, w, 3);
        ctx.fillStyle = COLORS.danger;
        ctx.fillRect(e.x - w / 2, e.y - size - 8, w * clamp01(hp / hpMax), 3);
        ctx.restore();
      }
    }
  }

  // ------------------------------------------------------- post + screen fx --

  _paintVignette() {
    const ctx = this.ctx;
    const w = this.cssW;
    const h = this.cssH;
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.78);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.62)');
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  /** Hit flash: the whole screen goes the colour of whatever just hurt you. */
  _paintFlashOverlay() {
    if (this.flash <= 0.004) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(${this.flashTint},${clamp01(this.flash)})`;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.restore();
  }

  // --------------------------------------------------------------------- hud --

  /** UI scale: the HUD keeps its proportions from phone to ultrawide. */
  _ui() {
    return clamp(Math.min(this.cssW, this.cssH) / 540, 0.66, 1.7);
  }

  _panel(x, y, w, h, u) {
    const ctx = this.ctx;
    const r = 8 * u;
    ctx.save();
    ctx.fillStyle = 'rgba(6,11,20,0.62)';
    ctx.strokeStyle = 'rgba(140,190,235,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  _text(x, y, value, opts = {}) {
    const ctx = this.ctx;
    const u = opts.u || 1;
    ctx.save();
    ctx.font = `${opts.weight || '600'} ${Math.round((opts.size || 14) * u)}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = opts.align || 'left';
    ctx.textBaseline = opts.baseline || 'alphabetic';
    ctx.globalAlpha = num(opts.alpha, 1);
    if (opts.glow) {
      ctx.shadowColor = opts.glow;
      ctx.shadowBlur = num(opts.blur, 12);
    }
    ctx.fillStyle = opts.color || COLORS.hud;
    ctx.fillText(String(value), x, y);
    ctx.restore();
  }

  /** Hull bar, wave, score, missile ammo, owned upgrades. Screen space. */
  _paintHud(snap, options) {
    const ctx = this.ctx;
    const u = this._ui();
    const p = snap.player || {};
    const pad = 16 * u;

    // ---- left cluster: hull ------------------------------------------------
    const barW = Math.min(300 * u, this.cssW * 0.42);
    const barH = 13 * u;
    this._panel(pad, pad, barW + 78 * u, 54 * u, u);
    this._text(pad + 10 * u, pad + 20 * u, 'HULL', { u, size: 11, color: COLORS.hudDim, weight: '700' });
    const frac = clamp01(num(p.health, 0) / Math.max(1, num(p.maxHealth, 100)));
    const x0 = pad + 10 * u;
    const y0 = pad + 28 * u;
    ctx.save();
    ctx.fillStyle = 'rgba(10,18,30,0.85)';
    ctx.fillRect(x0, y0, barW, barH);
    const hue = frac > 0.55 ? '102,240,168' : frac > 0.28 ? '255,206,84' : '255,84,112';
    const grad = ctx.createLinearGradient(x0, y0, x0 + barW, y0);
    grad.addColorStop(0, `rgba(${hue},0.65)`);
    grad.addColorStop(1, `rgba(${hue},1)`);
    ctx.fillStyle = grad;
    ctx.shadowColor = `rgba(${hue},0.9)`;
    ctx.shadowBlur = 10;
    ctx.fillRect(x0, y0, barW * frac, barH);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(150,200,240,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, barW, barH);
    for (let i = 1; i < 5; i++) {
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#0a1220';
      ctx.fillRect(x0 + (barW / 5) * i, y0, 1.5, barH);
    }
    ctx.restore();
    this._text(x0 + barW + 6 * u, y0 + barH, `${Math.max(0, Math.round(num(p.health, 0)))}`, {
      u, size: 12, color: frac > 0.28 ? COLORS.hud : COLORS.danger,
    });

    // ---- right cluster: wave, score, ammo ---------------------------------
    const rightW = 208 * u;
    const rightX = this.cssW - pad - rightW;
    this._panel(rightX, pad, rightW, 74 * u, u);
    this._text(rightX + rightW - 12 * u, pad + 24 * u, `WAVE ${num(snap.wave, 1)}`, {
      u, size: 15, align: 'right', color: '#bfe6ff', glow: '#3fa9ff', blur: 10,
    });
    this._text(rightX + rightW - 12 * u, pad + 48 * u, num(snap.score, 0).toLocaleString('en-US'), {
      u, size: 22, align: 'right', color: '#ffffff', glow: '#9fd8ff', blur: 14, weight: '800',
    });
    const ammo = Math.max(0, Math.round(num(p.missileAmmo, 0)));
    const pips = Math.min(12, Math.max(ammo, 0));
    const pipY = pad + 60 * u;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < pips; i++) {
      const px = rightX + rightW - 12 * u - i * 8 * u;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = COLORS.missile;
      ctx.beginPath();
      ctx.ellipse(px, pipY, 2.6 * u, 3.4 * u, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    this._text(rightX + 12 * u, pipY + 4 * u, ammo > 0 ? `MSL ${ammo}` : 'MSL DRY', {
      u, size: 11, color: ammo > 0 ? COLORS.missile : COLORS.danger, weight: '700',
    });

    // ---- upgrades owned this run: small chips along the bottom ------------
    const owned = Array.isArray(snap.upgrades) ? snap.upgrades : [];
    if (owned.length) {
      const chipH = 17 * u;
      const baseY = this.cssH - pad - chipH;
      let cx = pad;
      ctx.save();
      ctx.font = `600 ${Math.round(10 * u)}px "Segoe UI", system-ui, sans-serif`;
      for (const id of owned.slice(-9)) {
        const label = String(id).replace(/-/g, ' ').toUpperCase();
        const w = ctx.measureText(label).width + 16 * u;
        if (cx + w > this.cssW - pad) break;
        ctx.fillStyle = 'rgba(8,14,24,0.6)';
        ctx.strokeStyle = 'rgba(120,220,200,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(cx, baseY, w, chipH, 5 * u) : ctx.rect(cx, baseY, w, chipH);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(150,235,215,0.9)';
        ctx.fillText(label, cx + 8 * u, baseY + 12 * u);
        cx += w + 6 * u;
      }
      ctx.restore();
    }
  }

  // ------------------------------------------------------- state overlays --

  _wrap(text, maxW) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word;
      if (line && this.ctx.measureText(trial).width > maxW) {
        lines.push(line);
        line = word;
      } else {
        line = trial;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  /**
   * Full-canvas state overlays. Upgrade is a side panel so you can still see
   * the field you are about to fly back into; gameover owns the whole screen.
   */
  _paintOverlay(snap, options) {
    const state = snap.state;
    if (state === 'upgrade') this._paintUpgradePanel(snap, options);
    else if (state === 'gameover') this._paintGameOver(snap);
    if (options && options.paused && state !== 'gameover') this._paintPaused();
  }

  _paintUpgradePanel(snap, options) {
    const ctx = this.ctx;
    const u = this._ui();
    const choices = Array.isArray(snap.upgradeChoices) ? snap.upgradeChoices : [];
    const pad = 18 * u;
    const w = Math.min(400 * u, this.cssW * 0.46);
    const x = this.cssW - pad - w;
    const rowH = 74 * u;
    const headH = 62 * u;
    const y = Math.max(pad, (this.cssH - (headH + rowH * Math.max(1, choices.length))) / 2);
    const h = headH + rowH * Math.max(1, choices.length) + 12 * u;

    ctx.save();
    ctx.fillStyle = 'rgba(2,6,14,0.72)';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.restore();

    const pulse = 0.3 + 0.18 * Math.sin(this.time * 0.004);
    ctx.save();
    ctx.fillStyle = 'rgba(8,16,30,0.9)';
    ctx.strokeStyle = `rgba(120,220,255,${pulse + 0.25})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    this._text(x + 16 * u, y + 26 * u, `WAVE ${num(snap.wave, 1)} CLEARED`, {
      u, size: 13, color: COLORS.good, glow: COLORS.good, blur: 10, weight: '700',
    });
    this._text(x + 16 * u, y + 48 * u, 'CHOOSE AN UPGRADE', {
      u, size: 20, color: '#eaf6ff', glow: '#6fd2ff', blur: 14, weight: '800',
    });

    if (!choices.length) {
      this._text(x + 16 * u, y + headH, 'no offers — press any number to continue', { u, size: 12, color: COLORS.hudDim });
      return;
    }

    for (let i = 0; i < choices.length; i++) {
      const c = choices[i] || {};
      const ry = y + headH + rowH * i;
      const hot = !!(options && options.highlight === i);

      ctx.save();
      ctx.fillStyle = hot ? 'rgba(40,80,120,0.55)' : 'rgba(20,36,58,0.55)';
      ctx.strokeStyle = hot ? 'rgba(160,235,255,0.75)' : 'rgba(120,180,220,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(x + 12 * u, ry + 6 * u, w - 24 * u, rowH - 10 * u);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Number badge: the key that picks it.
      ctx.save();
      ctx.fillStyle = 'rgba(120,220,255,0.16)';
      ctx.strokeStyle = 'rgba(150,230,255,0.7)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x + 32 * u, ry + 30 * u, 13 * u, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      this._text(x + 32 * u, ry + 35 * u, i + 1, {
        u, size: 15, align: 'center', color: '#dff4ff', glow: '#59c8ff', blur: 8, weight: '800',
      });

      this._text(x + 54 * u, ry + 30 * u, c.label || c.id || `upgrade ${i + 1}`, {
        u, size: 15, color: '#f2f8ff', weight: '700', glow: '#2c6f9a', blur: 6,
      });
      const descW = w - 78 * u;
      const lines = this._wrap(c.desc || '', descW);
      for (let j = 0; j < Math.min(lines.length, 2); j++) {
        this._text(x + 54 * u, ry + 48 * u + j * 14 * u, lines[j], { u, size: 11.5, color: 'rgba(180,205,230,0.85)' });
      }
    }
    this._text(x + 16 * u, y + h - 6 * u, 'press  1 / 2 / 3', {
      u, size: 11, color: `rgba(150,230,255,${0.55 + pulse})`, weight: '700',
    });
  }

  _paintGameOver(snap) {
    const ctx = this.ctx;
    const u = this._ui();
    const w = Math.min(460 * u, this.cssW * 0.86);
    const h = 250 * u;
    const x = (this.cssW - w) / 2;
    const y = (this.cssH - h) / 2;

    ctx.save();
    ctx.fillStyle = 'rgba(2,4,10,0.74)';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.restore();

    ctx.save();
    ctx.fillStyle = 'rgba(10,8,16,0.92)';
    ctx.strokeStyle = 'rgba(255,90,110,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    this._text(this.cssW / 2, y + 52 * u, 'RUN ENDED', {
      u, size: 34, align: 'center', color: COLORS.danger, glow: COLORS.danger, blur: 22, weight: '800',
    });
    this._text(this.cssW / 2, y + 82 * u, `wave ${num(snap.wave, 1)} · ${this.kills} kills`, {
      u, size: 13, align: 'center', color: COLORS.hudDim, weight: '600',
    });
    this._text(this.cssW / 2, y + 118 * u, 'SCORE', {
      u, size: 12, align: 'center', color: COLORS.hudDim, weight: '700',
    });
    this._text(this.cssW / 2, y + 160 * u, num(snap.score, 0).toLocaleString('en-US'), {
      u, size: 38, align: 'center', color: '#ffffff', glow: '#9fd8ff', blur: 18, weight: '800',
    });

    const pulse = 0.45 + 0.35 * Math.sin(this.time * 0.005);
    this._text(this.cssW / 2, y + 208 * u, 'press  R  to fly again', {
      u, size: 15, align: 'center', color: `rgba(214,240,255,${pulse})`, weight: '700', glow: '#4fb0ff', blur: 12,
    });
  }

  _paintPaused() {
    const ctx = this.ctx;
    const u = this._ui();
    ctx.save();
    ctx.fillStyle = 'rgba(2,5,12,0.5)';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.restore();
    this._text(this.cssW / 2, this.cssH / 2, 'PAUSED', {
      u, size: 40, align: 'center', baseline: 'middle', color: '#dff4ff', glow: '#59c8ff', blur: 22, weight: '800',
    });
    this._text(this.cssW / 2, this.cssH / 2 + 36 * u, 'P to resume', {
      u, size: 13, align: 'center', color: COLORS.hudDim, weight: '600',
    });
  }

  /** Toast stack (top-center) plus any hint lines the shell hands us. */
  _paintToasts(options) {
    const u = this._ui();
    const cx = this.cssW / 2;
    let y = 96 * u;
    for (const t of this.toasts) {
      const inPhase = clamp01((t.ttlMax - t.ttl) / 180);
      const outPhase = clamp01(t.ttl / 400);
      this._text(cx, y, t.text, {
        u, size: 20, align: 'center', color: '#eaf6ff', glow: '#59c8ff', blur: 16,
        weight: '800', alpha: Math.min(inPhase, outPhase),
      });
      y += 26 * u;
    }

    const raw = options && options.messages;
    const lines = Array.isArray(raw) ? raw : raw ? [raw] : [];
    let by = this.cssH - 24 * u;
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = String(lines[i] || '');
      if (!text) continue;
      this._text(cx, by, text, { u, size: 12, align: 'center', color: 'rgba(170,200,225,0.72)', weight: '600' });
      by -= 17 * u;
    }
  }
}
