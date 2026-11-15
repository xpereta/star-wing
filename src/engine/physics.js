// star-wing flight model.
// Pure module: never touches document/window/AudioContext/requestAnimationFrame.
//
// The model is "sophisticated but accessible": acceleration is applied along the
// ship's heading (Newtonian-ish drift), drag bleeds speed off, and — the
// accessible part — angular velocity self-stabilises the moment the player
// releases the rudder, so the ship naturally flies straight instead of spinning.

/** Baseline tuning for a nimble fighter. Any field can be overridden per call. */
export const DEFAULT_PARAMS = Object.freeze({
  accel: 420, // thrust acceleration (units/s^2)
  maxSpeed: 320, // hard speed cap (units/s)
  drag: 1.6, // exponential velocity damping coefficient (1/s)
  turnAccel: 14, // rudder authority (rad/s^2)
  maxTurn: 5, // clamp on |angVel| (rad/s)
  stabDamp: 9, // auto-stabilize decay rate for angVel (1/s)
});

/** Extra drag multiplier applied while `input.brake` is held. */
export const BRAKE_DRAG_MULTIPLIER = 3.5;

/** Longest timestep we integrate in one call — keeps large frames stable. */
export const MAX_DT = 0.05;

const TAU = Math.PI * 2;

/** Below this, angVel is snapped to 0 so "straightened" really means straight. */
const ANGVEL_EPSILON = 1e-6;

export function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** Wrap an angle into [-PI, PI] so heading stays comparable and renderable. */
export function normalizeAngle(angle) {
  if (!Number.isFinite(angle)) return 0;
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

/** Smallest signed difference from `from` to `to` (result in [-PI, PI]). */
export function angleDiff(from, to) {
  return normalizeAngle(to - from);
}

/** Unit vector for a heading — 0 rad points along +x. */
export function forwardVector(heading) {
  return { x: Math.cos(heading), y: Math.sin(heading) };
}

/** Merge caller params over the defaults, ignoring non-finite values. */
export function resolveParams(params) {
  const src = params || {};
  const out = {};
  for (const key of Object.keys(DEFAULT_PARAMS)) {
    out[key] = Math.max(0, num(src[key], DEFAULT_PARAMS[key]));
  }
  return out;
}

/**
 * Create a flight body.
 * @returns {{x:number,y:number,vx:number,vy:number,heading:number,angVel:number}}
 */
export function createBody({ x = 0, y = 0, vx = 0, vy = 0, heading = 0, angVel = 0 } = {}) {
  return {
    x: num(x, 0),
    y: num(y, 0),
    vx: num(vx, 0),
    vy: num(vy, 0),
    heading: normalizeAngle(heading),
    angVel: num(angVel, 0),
  };
}

/** Current scalar speed of a body. */
export function speedOf(body) {
  if (!body) return 0;
  return Math.hypot(body.vx, body.vy);
}

/**
 * Advance one body by `dtSec` seconds.
 * input  = { thrust: -1..1, turn: -1..1, brake: boolean }
 * params = { accel, maxSpeed, drag, turnAccel, maxTurn, stabDamp }
 *
 * Order: rudder -> heading -> thrust along heading -> drag (brake boosts it)
 * -> speed cap -> position integrates last. Mutates and returns `body`.
 */
export function stepBody(body, input, dtSec, params) {
  if (!body) return body;

  const dt = clamp(num(dtSec, 1 / 60), 0, MAX_DT);
  const p = resolveParams(params);
  const thrust = clamp(num(input && input.thrust, 0), -1, 1);
  const turn = clamp(num(input && input.turn, 0), -1, 1);
  const brake = Boolean(input && input.brake);

  // 1. Rudder: integrate angVel, hard-clamped to maxTurn in both directions.
  if (turn !== 0) {
    body.angVel = clamp(body.angVel + turn * p.turnAccel * dt, -p.maxTurn, p.maxTurn);
  } else {
    // 2. Auto-stabilize: no rudder input -> angVel decays toward 0.
    const stab = Math.exp(-p.stabDamp * dt);
    body.angVel *= stab;
    if (Math.abs(body.angVel) < ANGVEL_EPSILON) body.angVel = 0;
  }

  // 3. Orientation follows angular velocity.
  body.heading = normalizeAngle(body.heading + body.angVel * dt);

  // 4. Thrust accelerates along heading (negative thrust pushes in reverse).
  const cos = Math.cos(body.heading);
  const sin = Math.sin(body.heading);
  body.vx += cos * p.accel * thrust * dt;
  body.vy += sin * p.accel * thrust * dt;

  // 5. Drag damps speed toward 0; braking just multiplies that damping.
  const drag = p.drag * (brake ? BRAKE_DRAG_MULTIPLIER : 1);
  if (drag > 0) {
    const damp = Math.exp(-drag * dt);
    body.vx *= damp;
    body.vy *= damp;
  }

  // 6. Clamp to maxSpeed so thrust can't run away.
  const speed = Math.hypot(body.vx, body.vy);
  if (speed > p.maxSpeed && speed > 0) {
    const k = p.maxSpeed / speed;
    body.vx *= k;
    body.vy *= k;
  }

  // 7. Position integrates last.
  body.x += body.vx * dt;
  body.y += body.vy * dt;

  return body;
}

/** Rotate a body instantly (used for spawns/knockback), keeping angVel intact. */
export function setHeading(body, heading) {
  if (!body) return body;
  body.heading = normalizeAngle(heading);
  return body;
}
