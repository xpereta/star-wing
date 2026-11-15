// star-wing weapons: cannon bullets and homing missiles.
// Pure module: never touches document/window/AudioContext/requestAnimationFrame.
//
// Both factories keep no firing state of their own — the cooldown lives on the
// caller's `state = { timer }` object, which the caller decrements by dt each
// tick. A weapon is READY when `state.timer <= 0`; firing resets it to the
// weapon's cooldown. That keeps the engine stateless and the Game deterministic.

import { MAX_DT, angleDiff, clamp, forwardVector, normalizeAngle } from './physics.js';

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** How far down the nose a projectile spawns, so it doesn't start inside the hull. */
const DEFAULT_MUZZLE = 16;

/**
 * Cannon factory.
 * fire(state, origin?, heading?) -> bullet[] | null  (null while still cooling)
 * bullet = { x, y, vx, vy, dmg, ttl }
 */
export function createCannon(options) {
  const o = options || {};
  const cfg = Object.freeze({
    cooldown: Math.max(0, finite(o.cooldown, 0.25)),
    damage: Math.max(0, finite(o.damage, 10)),
    speed: Math.max(0, finite(o.speed, 520)),
    spreadCount: Math.max(1, Math.round(finite(o.spreadCount, 1))),
    spreadAngle: finite(o.spreadAngle, 0), // total fan in radians, centered on heading
    bulletTtl: Math.max(0, finite(o.bulletTtl, 1.6)),
    muzzle: Math.max(0, finite(o.muzzle, DEFAULT_MUZZLE)),
  });

  return {
    config: cfg,

    /** True when the barrel is cool enough to fire. */
    canFire(state) {
      return Boolean(state) && finite(state.timer, 0) <= 0;
    },

    /**
     * Fired bullets, or null if the gun is still cooling.
     * `origin` may carry { x, y, vx, vy } — the ship's momentum is inherited by
     * the bullet, which makes firing while strafing feel right.
     */
    fire(state, origin, heading) {
      if (!state || finite(state.timer, 0) > 0) return null;
      state.timer = cfg.cooldown;

      const ox = finite(origin && origin.x, 0);
      const oy = finite(origin && origin.y, 0);
      const ovx = finite(origin && origin.vx, 0);
      const ovy = finite(origin && origin.vy, 0);
      const h = finite(heading, 0);
      const n = cfg.spreadCount;

      const bullets = [];
      for (let i = 0; i < n; i++) {
        // Fan the shots evenly across spreadAngle, centered on the heading.
        const t = n === 1 ? 0 : i / (n - 1) - 0.5;
        const a = normalizeAngle(h + t * cfg.spreadAngle);
        const dir = forwardVector(a);
        bullets.push({
          x: ox + dir.x * cfg.muzzle,
          y: oy + dir.y * cfg.muzzle,
          vx: ovx + dir.x * cfg.speed,
          vy: ovy + dir.y * cfg.speed,
          dmg: cfg.damage,
          ttl: cfg.bulletTtl,
        });
      }
      return bullets;
    },

    /** Advance a bullet; returns false once it has expired (ttl <= 0). */
    stepBullet(bullet, dtSec) {
      if (!bullet) return false;
      const dt = clamp(finite(dtSec, 1 / 60), 0, MAX_DT);
      bullet.x = finite(bullet.x, 0) + finite(bullet.vx, 0) * dt;
      bullet.y = finite(bullet.y, 0) + finite(bullet.vy, 0) * dt;
      bullet.ttl = finite(bullet.ttl, 0) - dt;
      return bullet.ttl > 0;
    },
  };
}

/**
 * Missile launcher factory.
 * fire(state, origin?, heading?, targets?) -> missile[]
 * missile = { x, y, vx, vy, heading, dmg, ttl, targetId }
 * targets = [{ id, x, y }, ...]
 */
export function createMissileLauncher(options) {
  const o = options || {};
  const cfg = Object.freeze({
    salvo: Math.max(0, Math.round(finite(o.salvo, 2))),
    cooldown: Math.max(0, finite(o.cooldown, 1.2)),
    turnRate: Math.max(0, finite(o.turnRate, 3.4)), // rad/s of seeker steering
    accel: Math.max(0, finite(o.accel, 300)),
    maxSpeed: Math.max(0, finite(o.maxSpeed, 440)),
    ttl: Math.max(0, finite(o.ttl, 3.5)),
    damage: Math.max(0, finite(o.damage, 26)),
    lockAngleDeg: finite(o.lockAngleDeg, 30),
    lockRange: Math.max(0, finite(o.lockRange, 520)),
    muzzle: Math.max(0, finite(o.muzzle, DEFAULT_MUZZLE)),
  });
  const lockRad = (Math.abs(cfg.lockAngleDeg) * Math.PI) / 180;
  const spawnSpeed = Math.min(cfg.maxSpeed, cfg.accel * 0.15);

  /** Targets inside the lock cone and lock range, best-aligned first. */
  function candidates(origin, heading, targets) {
    if (!Array.isArray(targets) || !targets.length) return [];
    const ox = finite(origin && origin.x, 0);
    const oy = finite(origin && origin.y, 0);
    const h = finite(heading, 0);
    const list = [];
    for (const t of targets) {
      if (!t) continue;
      const tx = finite(t.x, NaN);
      const ty = finite(t.y, NaN);
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
      const dx = tx - ox;
      const dy = ty - oy;
      const range = Math.hypot(dx, dy);
      if (range > cfg.lockRange) continue;
      const off = Math.abs(angleDiff(h, Math.atan2(dy, dx)));
      if (off > lockRad) continue;
      list.push({ target: t, off, range, id: t.id });
    }
    // Prefer targets nearest the forward bearing; break ties by proximity.
    list.sort((a, b) => a.off - b.off || a.range - b.range);
    return list;
  }

  /** Best single lock, or null if nothing is inside the cone. */
  function findTarget(origin, heading, targets) {
    const best = candidates(origin, heading, targets)[0];
    return best ? best.target : null;
  }

  return {
    config: cfg,
    lockRange: cfg.lockRange,
    lockAngleDeg: cfg.lockAngleDeg,

    canFire(state) {
      return Boolean(state) && finite(state.timer, 0) <= 0;
    },

    findTarget,

    /**
     * Launch the salvo. Always returns an array of missiles (empty only if
     * `salvo` is 0); null only when the launcher is still cooling. Missiles
     * with no lock get `targetId = null` and simply fly straight.
     */
    fire(state, origin, heading, targets) {
      if (!state || finite(state.timer, 0) > 0) return null;
      state.timer = cfg.cooldown;

      const locked = candidates(origin, heading, targets);
      const h0 = finite(heading, 0);
      const fan = 0.18; // rad between tubes so a salvo spreads instead of stacking
      const missiles = [];
      for (let i = 0; i < cfg.salvo; i++) {
        // Round-robin the lock list so a salvo doesn't double-tap one fighter.
        const pick = locked.length ? locked[i % locked.length] : null;
        const a = normalizeAngle(h0 + (pick ? 0 : (i - (cfg.salvo - 1) / 2) * fan));
        const dir = forwardVector(a);
        missiles.push({
          x: finite(origin && origin.x, 0) + dir.x * cfg.muzzle,
          y: finite(origin && origin.y, 0) + dir.y * cfg.muzzle,
          vx: finite(origin && origin.vx, 0) + dir.x * spawnSpeed,
          vy: finite(origin && origin.vy, 0) + dir.y * spawnSpeed,
          heading: a,
          dmg: cfg.damage,
          ttl: cfg.ttl,
          targetId: pick ? pick.id ?? null : null,
        });
      }
      return missiles;
    },

    /**
     * Steer + accelerate one missile. Re-acquires a fresh lock if the current
     * target died. Returns false when the missile expires (ttl <= 0).
     */
    step(missile, dtSec, targets) {
      if (!missile) return false;
      const dt = clamp(finite(dtSec, 1 / 60), 0, MAX_DT);

      // Seek: verify the lock is still alive, else try to grab a new one.
      let target = null;
      if (Array.isArray(targets)) {
        if (missile.targetId != null) {
          target = targets.find((t) => t && t.id === missile.targetId) || null;
        }
        if (!target) {
          const next = findTarget(missile, missile.heading, targets);
          missile.targetId = next ? next.id ?? null : null;
          target = next;
        }
      }

      if (target) {
        const mx = finite(missile.x, 0);
        const my = finite(missile.y, 0);
        const want = Math.atan2(finite(target.y, 0) - my, finite(target.x, 0) - mx);
        const err = angleDiff(missile.heading, want);
        const maxSteer = cfg.turnRate * dt;
        missile.heading = normalizeAngle(missile.heading + clamp(err, -maxSteer, maxSteer));
      }

      const dir = forwardVector(missile.heading);
      missile.vx = finite(missile.vx, 0) + dir.x * cfg.accel * dt;
      missile.vy = finite(missile.vy, 0) + dir.y * cfg.accel * dt;

      const speed = Math.hypot(missile.vx, missile.vy);
      if (speed > cfg.maxSpeed && speed > 0) {
        const k = cfg.maxSpeed / speed;
        missile.vx *= k;
        missile.vy *= k;
      }

      missile.x = finite(missile.x, 0) + missile.vx * dt;
      missile.y = finite(missile.y, 0) + missile.vy * dt;
      missile.ttl = finite(missile.ttl, 0) - dt;
      return missile.ttl > 0;
    },
  };
}
