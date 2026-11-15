// star-wing run shell: waves, wingmen, weapons, upgrades, score.
// Pure module: no canvas, no imagedata, no timers, no audio. Everything the
// browser does lives in src/render, src/audio and src/main.js.
//
// Design notes:
//  - All randomness comes from ONE seeded rng, and every system is stepped in
//    a fixed order, so two Games built from the same seed replay identically.
//  - Flight, cannons and missiles are delegated to src/engine; this file only
//    owns state: who is alive, what is fired, and what the next wave looks like.

import { MAX_DT, angleDiff, clamp, createBody, normalizeAngle, stepBody } from '../engine/physics.js';
import { createCannon, createMissileLauncher } from '../engine/weapons.js';
import { pickUpgradeChoices, wavePlan } from '../engine/director.js';

/** Playfield the shell simulates on. The renderer maps this to the viewport. */
export const ARENA = Object.freeze({ width: 1280, height: 720 });

/* Play area: a soft rim EDGE_MARGIN inside the arena. Crossing it does not
 * bounce or brake a ship — that would bleed speed, and a player holding thrust
 * straight into a wall would end up pinned at zero velocity. Instead the rim
 * banks the whole body (heading and velocity rotate together, so |v| is
 * exactly conserved) onto a line back toward the middle: touch the edge and you
 * carve an arc re-entering the fight. Deterministic, and the clamp underneath
 * is only a safety net so the renderer never sees an entity outside the arena. */
const EDGE_MARGIN = 90;
const RIM_RATE = 20; // rad/s of bank at the arena wall, ramping from zero at the rim
const RIM_LEAN = 0.6; // radians the escape line points back inside the arena

const PLAYER_START = Object.freeze({ x: ARENA.width * 0.5, y: ARENA.height * 0.62, heading: -Math.PI / 2 });

/** Collision radii (units). */
const PLAYER_RADIUS = 15;
const WINGMAN_RADIUS = 12;
const BULLET_RADIUS = 3;
const MISSILE_RADIUS = 7;

/** Baseline airframes. Upgrades mutate the player's copy. */
const BASE_FLIGHT = Object.freeze({
  accel: 540,
  maxSpeed: 340,
  drag: 1.9,
  turnAccel: 17,
  maxTurn: 4.4,
  stabDamp: 10,
});

const WING_FLIGHT = Object.freeze({
  accel: 500,
  maxSpeed: 320,
  drag: 2,
  turnAccel: 20,
  maxTurn: 5.4,
  stabDamp: 12,
});

/** Station each wingman slot holds, in the player's local frame (+x = nose). */
const FORMATION = Object.freeze([
  Object.freeze({ x: -46, y: -36 }),
  Object.freeze({ x: -46, y: 36 }),
  Object.freeze({ x: -88, y: 0 }),
]);

const WINGMAN_MAX = 3;
const WINGMAN_RANGE = 340;
const WINGMAN_COOLDOWN = 0.34;

/** Enemy archetypes; the plan's numbers are scaled by these. */
const KINDS = Object.freeze([
  Object.freeze({ kind: 'scout', radius: 12, health: 0.75, speed: 1.3, turn: 2.9, contact: 0.75, score: 80, minWave: 1 }),
  Object.freeze({ kind: 'fighter', radius: 15, health: 1, speed: 1, turn: 2.4, contact: 1, score: 110, minWave: 1 }),
  Object.freeze({ kind: 'bomber', radius: 20, health: 1.9, speed: 0.72, turn: 1.7, contact: 1.7, score: 160, minWave: 2 }),
  Object.freeze({ kind: 'interceptor', radius: 13, health: 1.15, speed: 1.42, turn: 3.2, contact: 1.1, score: 190, minWave: 3 }),
]);

/** Starting loadout; upgrades mutate this record, then syncWeapons() rebuilds. */
function baseStats() {
  return {
    maxHull: 100,
    cannonCooldown: 0.22,
    cannonDamage: 12,
    cannonSpeed: 620,
    spreadCount: 1,
    spreadAngle: 0.02,
    bulletTtl: 1.4,
    salvo: 2,
    missileCooldown: 1.1,
    missileDamage: 32,
    missileAmmoMax: 8,
    regen: 0,
  };
}

/** What each upgrade id actually does to the run. Keyed by director ids. */
const EFFECTS = {
  'cannon-rate': (g) => {
    g.stats.cannonCooldown = Math.max(0.05, g.stats.cannonCooldown * 0.85);
  },
  'cannon-damage': (g) => {
    g.stats.cannonDamage += 8;
  },
  spread: (g) => {
    g.stats.spreadCount += 1;
    g.stats.spreadAngle += 0.09;
  },
  'missile-salvo': (g) => {
    g.stats.salvo += 1;
    g.stats.missileAmmoMax += 2;
    g.missileAmmo += 2;
  },
  'missile-ammo': (g) => {
    g.stats.missileAmmoMax += 5;
    g.missileAmmo += 5;
  },
  'turn-rate': (g) => {
    g.flight.turnAccel *= 1.25;
    g.flight.maxTurn *= 1.15;
  },
  'max-speed': (g) => {
    g.flight.maxSpeed += 45;
    g.flight.accel += 30;
  },
  wingman: (g) => g.addWingman(),
  'max-hull': (g) => {
    g.stats.maxHull += 25;
    g.player.health = g.stats.maxHull;
  },
  'shield-regen': (g) => {
    g.stats.regen += 2.2;
  },
};

function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** FNV-1a so a string seed still gives a stable 32-bit stream. */
function hashSeed(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(Math.trunc(value)) >>> 0;
  if (typeof value === 'string') {
    let h = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193);
    return h >>> 0;
  }
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 0x9e3779b9;
}

/** mulberry32: tiny, fast, and reproducible across platforms. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Game {
  /**
   * @param {{seed?:number|string, arena?:{width:number,height:number}}} [options]
   */
  constructor(options = {}) {
    const opts = options || {};
    this.seed = opts.seed === undefined ? `t${Date.now()}` : opts.seed;
    this.rng = mulberry32(hashSeed(this.seed));

    const arena = opts.arena;
    this.arena = {
      width: arena && Number.isFinite(arena.width) ? arena.width : ARENA.width,
      height: arena && Number.isFinite(arena.height) ? arena.height : ARENA.height,
    };

    this.state = 'active';
    this.wave = 1;
    this.score = 0;
    this.shotsFired = 0;
    this.time = 0;
    this.upgrades = [];
    this.upgradeChoices = [];
    this.input = { thrust: 0, turn: 0, fire: false, fireMissile: false, brake: false };
    this.plan = wavePlan(1);

    this.start();
  }

  // ------------------------------------------------------------------ run --

  /** Begin (or restart) a run from wave 1. Safe to call at any time. */
  start() {
    this.state = 'active';
    this.wave = 1;
    this.score = 0;
    this.shotsFired = 0;
    this.time = 0;
    this.upgrades = [];
    this.upgradeChoices = [];
    this.flight = { ...BASE_FLIGHT };
    this.stats = baseStats();
    this.missileAmmo = this.stats.missileAmmoMax;

    this.player = createBody(PLAYER_START);
    this.player.radius = PLAYER_RADIUS;
    this.player.health = this.stats.maxHull;

    this.cannonState = { timer: 0 };
    this.missileState = { timer: 0 };
    this.bullets = [];
    this.missiles = [];
    this.enemies = [];
    this.nextId = 1;

    this.wingmen = [];
    this.addWingman();

    this.syncWeapons();
    this.spawnWave(this.wave);
    return this;
  }

  /** Read the current frame's controls; consumed by every following tick. */
  setInput(input = {}) {
    const src = input || {};
    this.input = {
      thrust: clamp(num(src.thrust, 0), -1, 1),
      turn: clamp(num(src.turn, 0), -1, 1),
      fire: Boolean(src.fire),
      fireMissile: Boolean(src.fireMissile),
      brake: Boolean(src.brake),
    };
    return this;
  }

  /**
   * Pick one of the between-waves offers. Only legal while state === 'upgrade'.
   * @param {number} index 0-based index into snapshot().upgradeChoices
   */
  chooseUpgrade(index) {
    if (this.state !== 'upgrade') return false;

    const i = Math.trunc(num(index, -1));
    const choice = i >= 0 && i < this.upgradeChoices.length ? this.upgradeChoices[i] : null;
    if (!choice) return false;

    const apply = EFFECTS[choice.id];
    if (apply) apply(this);
    this.syncWeapons();

    this.upgrades.push(choice.id);
    this.upgradeChoices = [];
    this.wave += 1;
    this.spawnWave(this.wave);
    this.state = 'active';
    return true;
  }

  // --------------------------------------------------------------- snapshot --

  /** The one view the renderer, audio and HUD are allowed to read. */
  snapshot() {
    return {
      state: this.state,
      wave: this.wave,
      score: this.score,
      player: {
        x: this.player.x,
        y: this.player.y,
        vx: this.player.vx,
        vy: this.player.vy,
        heading: this.player.heading,
        health: this.player.health,
        maxHealth: this.stats.maxHull,
        cannonTimer: this.cannonState.timer,
        missileAmmo: this.missileAmmo,
      },
      wingmen: this.wingmen.map((w) => ({
        x: w.x,
        y: w.y,
        heading: w.heading,
        health: w.health,
        alive: w.alive,
      })),
      enemies: this.enemies.map((e) => ({
        id: e.id,
        x: e.x,
        y: e.y,
        heading: e.heading,
        health: e.health,
        kind: e.kind,
      })),
      bullets: this.bullets.map((b) => ({ x: b.x, y: b.y })),
      missiles: this.missiles.map((m) => ({ x: m.x, y: m.y })),
      upgrades: this.upgrades.slice(),
      upgradeChoices: this.upgradeChoices.map((c) => ({ id: c.id, label: c.label, desc: c.desc })),
      shotsFired: this.shotsFired,
    };
  }

  // ------------------------------------------------------------------- tick --

  /** Advance the simulation by `dtMs` milliseconds (clamped, like the engine). */
  tick(dtMs) {
    const dt = clamp(num(dtMs, 0) / 1000, 0, MAX_DT);
    if (this.state !== 'active' || dt <= 0) return;

    this.time += dt;

    this.cannonState.timer = Math.max(0, this.cannonState.timer - dt);
    this.missileState.timer = Math.max(0, this.missileState.timer - dt);
    for (const w of this.wingmen) w.cannonState.timer = Math.max(0, w.cannonState.timer - dt);
    for (const e of this.enemies) e.attackTimer = Math.max(0, e.attackTimer - dt);

    this.stepPlayer(dt);
    this.stepWingmen(dt);
    this.stepEnemies(dt);
    this.separateEnemies();
    this.resolveContacts();
    // Last word on where anything is: separation and ramming can shove a body
    // across the rim, and the renderer is promised on-screen entities.
    this.confineAll(dt);
    this.stepBullets(dt);
    this.stepMissiles(dt);
    this.applyRegen(dt);
    this.reapEnemies();
    this.checkWaveClear();

    if (this.player.health <= 0) {
      this.player.health = 0;
      this.state = 'gameover';
    }
  }

  // ------------------------------------------------------------- subsystems --

  syncWeapons() {
    const s = this.stats;
    this.cannon = createCannon({
      cooldown: s.cannonCooldown,
      damage: s.cannonDamage,
      speed: s.cannonSpeed,
      spreadCount: s.spreadCount,
      spreadAngle: s.spreadAngle,
      bulletTtl: s.bulletTtl,
    });
    this.missileLauncher = createMissileLauncher({
      salvo: s.salvo,
      cooldown: s.missileCooldown,
      damage: s.missileDamage,
    });

    for (const w of this.wingmen) {
      w.cannon = createCannon({
        cooldown: WINGMAN_COOLDOWN,
        damage: Math.max(4, Math.round(s.cannonDamage * 0.55)),
        speed: s.cannonSpeed,
        spreadCount: 1,
        bulletTtl: s.bulletTtl,
      });
    }
  }

  addWingman() {
    if (this.wingmen.length >= WINGMAN_MAX) return false;

    const slot = FORMATION[this.wingmen.length % FORMATION.length];
    const p = this.player;
    const cos = Math.cos(p.heading);
    const sin = Math.sin(p.heading);
    const wing = createBody({
      x: p.x + slot.x * cos - slot.y * sin,
      y: p.y + slot.x * sin + slot.y * cos,
      vx: p.vx,
      vy: p.vy,
      heading: p.heading,
    });
    wing.id = this.nextId++;
    wing.radius = WINGMAN_RADIUS;
    wing.maxHealth = 60;
    wing.health = wing.maxHealth;
    wing.alive = true;
    wing.cannonState = { timer: 0 };
    wing.cannon = createCannon({
      cooldown: WINGMAN_COOLDOWN,
      damage: Math.max(4, Math.round(this.stats.cannonDamage * 0.55)),
      speed: this.stats.cannonSpeed,
      spreadCount: 1,
      bulletTtl: this.stats.bulletTtl,
    });

    this.wingmen.push(wing);
    return true;
  }

  spawnWave(wave) {
    this.plan = wavePlan(wave);
    this.enemies = [];

    const cx = this.arena.width / 2;
    const cy = this.arena.height / 2;
    const ring = Math.min(this.arena.width, this.arena.height) * 0.42;

    for (let i = 0; i < this.plan.enemyCount; i++) {
      let angle = this.rng() * Math.PI * 2;
      // Nudge off the player if the roll would drop a body on top of them.
      for (let tries = 0; tries < 8; tries++) {
        const px = cx + Math.cos(angle) * ring;
        const py = cy + Math.sin(angle) * ring;
        if (Math.hypot(px - this.player.x, py - this.player.y) > 260) break;
        angle += Math.PI / 4;
      }

      const kind = this.pickKind();
      const x = clamp(cx + Math.cos(angle) * ring, EDGE_MARGIN, this.arena.width - EDGE_MARGIN);
      const y = clamp(cy + Math.sin(angle) * ring, EDGE_MARGIN, this.arena.height - EDGE_MARGIN);

      const enemy = createBody({ x, y, heading: normalizeAngle(Math.atan2(this.player.y - y, this.player.x - x)) });
      enemy.id = this.nextId++;
      enemy.kind = kind.kind;
      enemy.radius = kind.radius;
      enemy.maxHealth = Math.round(this.plan.enemyHealth * kind.health);
      enemy.health = enemy.maxHealth;
      enemy.speed = this.plan.enemySpeed * kind.speed;
      enemy.turn = kind.turn;
      enemy.contactDamage = Math.max(2, this.plan.enemyAggression * 9 * kind.contact);
      enemy.score = kind.score;
      enemy.attackTimer = 0;
      enemy.spin = this.rng() < 0.5 ? -1 : 1;

      this.enemies.push(enemy);
    }
  }

  pickKind() {
    const pool = KINDS.filter((k) => this.wave >= k.minWave);
    const weights = pool.map((k) => (k.kind === 'fighter' ? 3 : k.kind === 'scout' ? 2 : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = this.rng() * total;
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  confineAll(dt) {
    this.confine(this.player, dt);
    for (const w of this.wingmen) {
      if (w.alive) this.confine(w, dt);
    }
    for (const e of this.enemies) this.confine(e, dt);
  }

  confine(body, dt) {
    const lo = EDGE_MARGIN + body.radius;
    const hiX = this.arena.width - lo;
    const hiY = this.arena.height - lo;

    let over = 0;
    if (body.x < lo) over = Math.max(over, lo - body.x);
    else if (body.x > hiX) over = Math.max(over, body.x - hiX);
    if (body.y < lo) over = Math.max(over, lo - body.y);
    else if (body.y > hiY) over = Math.max(over, body.y - hiY);

    if (over > 0) {
      const radial = Math.atan2(body.y - this.arena.height / 2, body.x - this.arena.width / 2);
      const travel = Math.atan2(body.vy, body.vx);
      // Bank toward the wall-hugging line that leans back inside the arena,
      // keeping whichever way along the wall we were already heading.
      const lean = Math.sin(angleDiff(radial, travel));
      const side = lean >= 0 ? 1 : -1;
      const escape = radial + side * (Math.PI / 2 + RIM_LEAN);
      const err = angleDiff(travel, escape);
      const step = Math.min(Math.abs(err), RIM_RATE * (over / EDGE_MARGIN) * dt);

      if (step > 0) {
        const delta = Math.sign(err) * step;
        const cos = Math.cos(delta);
        const sin = Math.sin(delta);
        const vx = body.vx * cos - body.vy * sin;
        const vy = body.vx * sin + body.vy * cos;
        body.heading = normalizeAngle(body.heading + delta);
        body.vx = vx;
        body.vy = vy;
      }
    }

    if (body.x < body.radius) {
      body.x = body.radius;
      body.vx = Math.abs(body.vx);
    } else if (body.x > this.arena.width - body.radius) {
      body.x = this.arena.width - body.radius;
      body.vx = -Math.abs(body.vx);
    }
    if (body.y < body.radius) {
      body.y = body.radius;
      body.vy = Math.abs(body.vy);
    } else if (body.y > this.arena.height - body.radius) {
      body.y = this.arena.height - body.radius;
      body.vy = -Math.abs(body.vy);
    }
  }

  stepPlayer(dt) {
    const input = this.input;
    stepBody(this.player, { thrust: input.thrust, turn: input.turn, brake: input.brake }, dt, this.flight);

    if (input.fire) {
      const shots = this.cannon.fire(this.cannonState, this.player, this.player.heading);
      if (shots && shots.length) {
        this.bullets.push(...shots);
        this.shotsFired += shots.length;
      }
    }

    if (input.fireMissile && this.missileAmmo >= this.stats.salvo) {
      const targets = this.enemies.map((e) => ({ id: e.id, x: e.x, y: e.y }));
      const salvo = this.missileLauncher.fire(this.missileState, this.player, this.player.heading, targets);
      if (salvo && salvo.length) {
        this.missiles.push(...salvo);
        this.missileAmmo -= salvo.length;
      }
    }
  }

  stepWingmen(dt) {
    const p = this.player;
    const cos = Math.cos(p.heading);
    const sin = Math.sin(p.heading);

    for (let i = 0; i < this.wingmen.length; i++) {
      const w = this.wingmen[i];
      if (!w.alive) continue;

      const slot = FORMATION[i % FORMATION.length];
      const stationX = p.x + slot.x * cos - slot.y * sin;
      const stationY = p.y + slot.x * sin + slot.y * cos;

      const dx = stationX - w.x;
      const dy = stationY - w.y;
      const dist = Math.hypot(dx, dy);
      const want = dist > 10 ? Math.atan2(dy, dx) : p.heading;
      const err = angleDiff(w.heading, want);

      // Fly to the station: point at it first, then burn harder the further out it is.
      const turn = clamp(err * 2.4, -1, 1);
      let thrust = clamp((dist - 18) / 70, -0.4, 1);
      if (Math.cos(err) < 0) thrust = -0.35;

      stepBody(w, { thrust, turn, brake: false }, dt, WING_FLIGHT);

      const target = this.nearestEnemy(w, WINGMAN_RANGE);
      if (target) {
        const aim = normalizeAngle(Math.atan2(target.y - w.y, target.x - w.x));
        const shots = w.cannon.fire(w.cannonState, w, aim);
        if (shots && shots.length) this.bullets.push(...shots);
      }
    }
  }

  stepEnemies(dt) {
    const aggression = this.plan.enemyAggression;
    // Meaner waves push in closer before they orbit.
    const standoff = 20 + 110 / Math.max(0.5, aggression);

    for (const e of this.enemies) {
      const target = this.nearestTarget(e);
      const dx = target.x - e.x;
      const dy = target.y - e.y;
      const dist = Math.hypot(dx, dy) || 1;
      const want = Math.atan2(dy, dx);

      let thrust = 1;
      let aim = want;
      if (dist < standoff) {
        // Close in: circle the target instead of piling into the hull.
        aim = normalizeAngle(want + e.spin * 0.9);
        thrust = 0.55;
      }

      const err = angleDiff(e.heading, aim);
      const turn = clamp(err * 2.2, -1, 1);
      const params = {
        accel: e.speed * 2.4,
        maxSpeed: e.speed,
        drag: 1.2,
        turnAccel: 11 + aggression * 2,
        maxTurn: e.turn + aggression * 0.25,
        stabDamp: 8,
      };
      stepBody(e, { thrust, turn, brake: false }, dt, params);
    }
  }

  /** Keep bodies from stacking into one sprite. */
  separateEnemies() {
    const list = this.enemies;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const min = a.radius + b.radius + 4;
        if (d >= min || d === 0) continue;
        const k = ((min - d) / d) * 0.5;
        a.x -= dx * k;
        a.y -= dy * k;
        b.x += dx * k;
        b.y += dy * k;
      }
    }
  }

  /** Ramming: enemies trade hull for hull with the player and live wingmen. */
  resolveContacts() {
    const friendlies = [{ body: this.player, radius: PLAYER_RADIUS, isPlayer: true }];
    for (const w of this.wingmen) {
      if (w.alive) friendlies.push({ body: w, radius: WINGMAN_RADIUS, isPlayer: false });
    }

    for (const e of this.enemies) {
      for (const f of friendlies) {
        const dx = f.body.x - e.x;
        const dy = f.body.y - e.y;
        const d = Math.hypot(dx, dy);
        const min = e.radius + f.radius;
        if (d >= min) continue;

        const overlap = min - d;
        const nx = d > 0 ? dx / d : 1;
        const ny = d > 0 ? dy / d : 0;

        // Split the shove: the enemy takes most of it, the ship a little.
        e.x -= nx * overlap * 0.75;
        e.y -= ny * overlap * 0.75;
        f.body.x += nx * overlap * 0.25;
        f.body.y += ny * overlap * 0.25;
        f.body.vx += nx * 40;
        f.body.vy += ny * 40;

        if (e.attackTimer <= 0) {
          e.attackTimer = 0.6;
          this.damageFriendly(f, e.contactDamage);
        }
      }
    }
  }

  damageFriendly(friendly, amount) {
    const body = friendly.body;
    body.health -= amount;
    if (friendly.isPlayer) return;
    if (body.health <= 0) {
      body.health = 0;
      body.alive = false;
    }
  }

  nearestEnemy(from, range = Infinity) {
    let best = null;
    let bestD = range;
    for (const e of this.enemies) {
      if (e.health <= 0) continue;
      const d = Math.hypot(e.x - from.x, e.y - from.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  nearestTarget(from) {
    let best = this.player;
    let bestD = Math.hypot(this.player.x - from.x, this.player.y - from.y);
    for (const w of this.wingmen) {
      if (!w.alive) continue;
      const d = Math.hypot(w.x - from.x, w.y - from.y);
      if (d < bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  }

  stepBullets(dt) {
    const keep = [];
    for (const b of this.bullets) {
      if (!this.cannon.stepBullet(b, dt)) continue;
      if (b.x < -40 || b.y < -40 || b.x > this.arena.width + 40 || b.y > this.arena.height + 40) continue;

      let spent = false;
      for (const e of this.enemies) {
        if (e.health <= 0) continue;
        if (Math.hypot(e.x - b.x, e.y - b.y) <= e.radius + BULLET_RADIUS) {
          e.health -= b.dmg;
          spent = true;
          break;
        }
      }
      if (!spent) keep.push(b);
    }
    this.bullets = keep;
  }

  stepMissiles(dt) {
    const targets = this.enemies.filter((e) => e.health > 0).map((e) => ({ id: e.id, x: e.x, y: e.y }));
    const keep = [];
    for (const m of this.missiles) {
      if (!this.missileLauncher.step(m, dt, targets)) continue;
      if (m.x < -40 || m.y < -40 || m.x > this.arena.width + 40 || m.y > this.arena.height + 40) continue;

      let hit = false;
      for (const e of this.enemies) {
        if (e.health <= 0) continue;
        if (Math.hypot(e.x - m.x, e.y - m.y) <= e.radius + MISSILE_RADIUS) {
          e.health -= m.dmg;
          hit = true;
          break;
        }
      }
      if (!hit) keep.push(m);
    }
    this.missiles = keep;
  }

  applyRegen(dt) {
    if (this.stats.regen <= 0) return;
    this.player.health = Math.min(this.stats.maxHull, this.player.health + this.stats.regen * dt);
  }

  reapEnemies() {
    if (!this.enemies.some((e) => e.health <= 0)) return;
    const keep = [];
    for (const e of this.enemies) {
      if (e.health <= 0) this.score += e.score;
      else keep.push(e);
    }
    this.enemies = keep;
  }

  checkWaveClear() {
    if (this.state !== 'active' || this.enemies.length > 0) return;

    this.score += 50 * this.wave;
    this.state = 'upgrade';
    this.upgradeChoices = pickUpgradeChoices(this.rng, this.upgrades, 3);

    // Between waves: restock the tubes, cool the guns, bring the flight back.
    this.missileAmmo = this.stats.missileAmmoMax;
    this.cannonState.timer = 0;
    this.missileState.timer = 0;
    this.bullets = [];
    this.missiles = [];

    const p = this.player;
    const cos = Math.cos(p.heading);
    const sin = Math.sin(p.heading);
    for (let i = 0; i < this.wingmen.length; i++) {
      const w = this.wingmen[i];
      const slot = FORMATION[i % FORMATION.length];
      w.alive = true;
      w.health = w.maxHealth;
      w.x = p.x + slot.x * cos - slot.y * sin;
      w.y = p.y + slot.x * sin + slot.y * cos;
      w.vx = p.vx;
      w.vy = p.vy;
      w.heading = p.heading;
      w.angVel = 0;
      w.cannonState.timer = 0;
    }
  }
}
