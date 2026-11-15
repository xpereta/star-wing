// Engine simulation tests for star-wing (physics + weapons).
// Run with: node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBody, speedOf, stepBody } from '../../src/engine/physics.js';
import { createCannon, createMissileLauncher } from '../../src/engine/weapons.js';

const DT = 1 / 60;
const P = { accel: 400, maxSpeed: 300, drag: 1.5, turnAccel: 12, maxTurn: 4, stabDamp: 8 };

function runFor(body, input, steps, params = P) {
  for (let i = 0; i < steps; i++) stepBody(body, input, DT, params);
  return body;
}

test('createBody returns the flight-model shape with sane defaults', () => {
  const b = createBody({ x: 3, y: -4, heading: 1 });
  assert.deepEqual(Object.keys(b).sort(), ['angVel', 'heading', 'vx', 'vy', 'x', 'y'].sort());
  assert.equal(b.x, 3);
  assert.equal(b.y, -4);
  assert.equal(b.heading, 1);
  assert.equal(b.vx, 0);
  assert.equal(b.vy, 0);
  assert.equal(b.angVel, 0);

  const d = createBody();
  assert.equal(d.x, 0);
  assert.equal(d.heading, 0);
});

test('thrust accelerates along heading, not along world axes', () => {
  const east = runFor(createBody({ heading: 0 }), { thrust: 1, turn: 0, brake: false }, 30);
  assert.ok(east.vx > 10, `expected forward vx, got ${east.vx}`);
  assert.ok(Math.abs(east.vy) < 1e-9, `heading 0 must not drift in y: ${east.vy}`);

  const north = runFor(createBody({ heading: Math.PI / 2 }), { thrust: 1, turn: 0, brake: false }, 30);
  assert.ok(north.vy > 10, `expected +y thrust at heading PI/2, got ${north.vy}`);
  assert.ok(Math.abs(north.vx) < 1e-9, `heading PI/2 must not drift in x: ${north.vx}`);

  assert.ok(speedOf(north) > 0);
});

test('drag decays speed toward zero with no thrust', () => {
  const b = createBody({ vx: 200, vy: 0 });
  let prev = Infinity;
  for (let i = 0; i < 120; i++) {
    stepBody(b, { thrust: 0, turn: 0, brake: false }, DT, P);
    const s = speedOf(b);
    assert.ok(s <= prev + 1e-12, 'drag must never speed the ship up');
    prev = s;
  }
  assert.ok(prev < 20, `expected strong decay from 200, ended at ${prev}`);
  assert.ok(prev > 0, 'drag should asymptote to 0, not overshoot');

  // Brake is just extra drag: it stops the ship faster.
  const coasting = runFor(createBody({ vx: 200 }), { thrust: 0, turn: 0, brake: false }, 30);
  const braking = runFor(createBody({ vx: 200 }), { thrust: 0, turn: 0, brake: true }, 30);
  assert.ok(speedOf(braking) < speedOf(coasting));
});

test('turn input changes heading (right positive, left negative)', () => {
  const right = runFor(createBody({ heading: 0 }), { thrust: 0, turn: 1, brake: false }, 30);
  assert.ok(right.heading > 0.5, `expected positive heading, got ${right.heading}`);

  const left = runFor(createBody({ heading: 0 }), { thrust: 0, turn: -1, brake: false }, 30);
  assert.ok(left.heading < -0.5, `expected negative heading, got ${left.heading}`);
});

test('auto-stabilize: angVel decays and the ship straightens when turn is 0', () => {
  const b = runFor(createBody({ heading: 0 }), { thrust: 0, turn: 1, brake: false }, 30);
  const spinning = b.angVel;
  assert.ok(spinning > 0, 'turning should have built up angVel');

  runFor(b, { thrust: 0, turn: 0, brake: false }, 60);
  assert.ok(Math.abs(b.angVel) < spinning / 100, `angVel should decay, still ${b.angVel}`);

  runFor(b, { thrust: 0, turn: 0, brake: false }, 240);
  assert.equal(b.angVel, 0, 'auto-stabilize should settle exactly at 0');

  const heading = b.heading;
  runFor(b, { thrust: 0, turn: 0, brake: false }, 30);
  assert.equal(b.heading, heading, 'a settled ship must fly perfectly straight');
});

test('maxTurn clamps angVel in both directions', () => {
  const clockwise = runFor(createBody(), { thrust: 0, turn: 1, brake: false }, 240);
  assert.equal(clockwise.angVel, P.maxTurn);

  const counter = runFor(createBody(), { thrust: 0, turn: -1, brake: false }, 240);
  assert.equal(counter.angVel, -P.maxTurn);
});

test('cannon fires only when the timer has cooled, then resets it', () => {
  const cannon = createCannon({ cooldown: 0.2, damage: 7, speed: 500, spreadCount: 1, spreadAngle: 0, bulletTtl: 2 });

  const cooling = { timer: 0.2 };
  assert.equal(cannon.fire(cooling, { x: 0, y: 0 }, 0), null);
  assert.equal(cooling.timer, 0.2, 'a blocked shot must not consume the gun');

  const hot = { timer: 0 };
  const volley = cannon.fire(hot, { x: 0, y: 0 }, 0);
  assert.ok(Array.isArray(volley), 'ready gun must return an array');
  assert.equal(volley.length, 1);
  assert.equal(hot.timer, 0.2, 'firing should re-arm the cooldown');

  // A timer driven negative by dt subtraction is still ready.
  const cold = { timer: -0.05 };
  assert.ok(Array.isArray(cannon.fire(cold, { x: 0, y: 0 }, 0)));
});

test('cannon bullets have the contract shape, spread evenly, inherit momentum', () => {
  const cannon = createCannon({ cooldown: 0.1, damage: 12, speed: 500, spreadCount: 3, spreadAngle: 0.6, bulletTtl: 1.5 });
  const shots = cannon.fire({ timer: 0 }, { x: 10, y: 5, vx: 60, vy: 20 }, 0);

  assert.equal(shots.length, 3);
  for (const b of shots) {
    assert.deepEqual(Object.keys(b).sort(), ['dmg', 'ttl', 'vx', 'vy', 'x', 'y'].sort());
    assert.equal(b.dmg, 12);
    assert.equal(b.ttl, 1.5);
  }

  const angles = shots.map((b) => Math.atan2(b.vy - 20, b.vx - 60));
  assert.ok(Math.abs(angles[0] + 0.3) < 1e-9, `left shot should be -0.3 rad, got ${angles[0]}`);
  assert.ok(Math.abs(angles[1]) < 1e-9, 'center shot should follow the heading');
  assert.ok(Math.abs(angles[2] - 0.3) < 1e-9, `right shot should be +0.3 rad, got ${angles[2]}`);

  for (const b of shots) {
    const rel = Math.hypot(b.vx - 60, b.vy - 20);
    assert.ok(Math.abs(rel - 500) < 1e-9, 'muzzle speed is relative to the ship');
    assert.ok(b.x > 10, 'bullets spawn down the nose, not inside the hull');
  }
});

test('missile launcher returns a salvo and re-arms its cooldown', () => {
  const launcher = createMissileLauncher({
    salvo: 3, cooldown: 1, turnRate: 3, accel: 300, maxSpeed: 420, ttl: 3,
    damage: 25, lockAngleDeg: 30, lockRange: 400,
  });
  const state = { timer: 0 };
  const salvo = launcher.fire(state, { x: 0, y: 0 }, 0, []);

  assert.ok(Array.isArray(salvo));
  assert.equal(salvo.length, 3);
  for (const m of salvo) {
    assert.deepEqual(Object.keys(m).sort(), ['dmg', 'heading', 'targetId', 'ttl', 'vx', 'vy', 'x', 'y'].sort());
    assert.equal(m.dmg, 25);
    assert.equal(m.ttl, 3);
    assert.equal(m.targetId, null, 'no targets in range means no lock');
  }
  assert.ok(salvo[0].vx > 0, 'missiles leave the tubes moving forward');
  assert.equal(state.timer, 1);
  assert.equal(launcher.fire(state, { x: 0, y: 0 }, 0, []), null, 'still cooling');

  // No lock -> flies straight, keeping its heading (the center tube aims dead ahead).
  const straight = salvo[1];
  assert.equal(straight.heading, 0);
  const h = straight.heading;
  for (let i = 0; i < 30; i++) launcher.step(straight, DT, []);
  assert.equal(straight.heading, h);
  assert.ok(straight.x > 50, `missile should travel forward, got x=${straight.x}`);
  assert.ok(Math.abs(straight.y) < 1e-9, `unlocked missile must not curve, got y=${straight.y}`);
  assert.ok(Math.abs(Math.atan2(straight.vy, straight.vx) - h) < 1e-9, 'velocity must stay aligned to heading');
});

test('missiles lock the target nearest the forward bearing, within cone and range', () => {
  const launcher = createMissileLauncher({
    salvo: 2, cooldown: 1, turnRate: 3, accel: 300, maxSpeed: 420, ttl: 3,
    damage: 25, lockAngleDeg: 30, lockRange: 400,
  });
  const targets = [
    { id: 'beam', x: 40, y: -90 }, // close, but ~66 deg off the nose: outside the cone
    { id: 'far', x: 5000, y: 0 }, // dead ahead, but outside lockRange
    { id: 'nose', x: 300, y: 25 }, // slightly off-axis but well inside the cone
  ];
  const salvo = launcher.fire({ timer: 0 }, { x: 0, y: 0 }, 0, targets);

  assert.deepEqual(salvo.map((m) => m.targetId), ['nose', 'nose']);
  assert.equal(launcher.findTarget({ x: 0, y: 0 }, 0, targets).id, 'nose');

  // The seeker should actually steer toward the lock and close on it.
  const m = salvo[0];
  for (let i = 0; i < 60; i++) launcher.step(m, DT, targets);
  assert.ok(Math.abs(m.y) < 90, `homing missile should converge, ended at y=${m.y}`);
});
