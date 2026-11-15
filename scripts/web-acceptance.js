'use strict';
// Independent acceptance contract for star-wing. DO NOT MODIFY.
// Checks: layout, package type, purity, renderer/audio API presence,
// physics behavior, director difficulty ramp, seeded Game run + exact snapshot shape,
// index.html references only existing local files. Prints WEB_ACCEPT_OK on green.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const failures = [];

const REQUIRED = [
  'package.json',
  'index.html',
  'src/engine/physics.js',
  'src/engine/weapons.js',
  'src/engine/director.js',
  'src/game/game.js',
  'src/render/renderer.js',
  'src/audio/audio.js',
  'src/main.js',
];

for (const rel of REQUIRED) {
  if (!fs.existsSync(path.join(ROOT, rel))) failures.push(`missing:${rel}`);
}

if (failures.length) { report(); }

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (pkg.type !== 'module') failures.push('pkg:not-module');
if (pkg.dependencies && Object.keys(pkg.dependencies).length) failures.push('pkg:has-dependencies');

const PURE = ['src/engine/physics.js', 'src/engine/weapons.js', 'src/engine/director.js', 'src/game/game.js'];
for (const rel of PURE) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const re of [/document\./, /window\./, /new AudioContext/, /requestAnimationFrame\(/]) {
    if (re.test(src)) failures.push(`browser-api:${rel}:${re}`);
  }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
if (!/<script[^>]*type="module"[^>]*src="src\/main\.js"/.test(html)) failures.push('html:no-module-main');
if (!/<canvas[^>]*id="board"/.test(html)) failures.push('html:no-canvas-board');
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const ref = m[1];
  if (/^https?:/.test(ref)) failures.push(`external-asset:${ref}`);
  else if (!/^(#|data:)/.test(ref) && ref && !fs.existsSync(path.join(ROOT, ref.split('?')[0]))) failures.push(`missing-ref:${ref}`);
}

const rendererSrc = fs.readFileSync(path.join(ROOT, 'src/render/renderer.js'), 'utf8');
for (const method of ['render', 'resize', 'addShake', 'addFlash', 'showToast']) {
  if (!new RegExp(`${method}\\s*\\(`).test(rendererSrc)) failures.push(`renderer-missing:${method}`);
}
if (!/export\s+(class|function)\s+Renderer|Renderer\s*=/.test(rendererSrc)) failures.push('renderer:no-Renderer-export');

const audioSrc = fs.readFileSync(path.join(ROOT, 'src/audio/audio.js'), 'utf8');
for (const method of ['unlock', 'play', 'startAmbient', 'stopAmbient', 'setMuted', 'toggleMute']) {
  if (!new RegExp(`${method}\\s*\\(`).test(audioSrc)) failures.push(`audio-missing:${method}`);
}
if (/new\s+Audio\(|\.mp3|\.wav|\.ogg|fetch\(/.test(audioSrc)) failures.push('audio:not-procedural');

const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
if (!/window\.__game\s*=/.test(mainSrc)) failures.push('main:no-__game-handle');

function report() {
  for (const f of failures) console.error('FAIL:', f);
  console.log('WEB_ACCEPT_FAILED');
  process.exit(1);
}

// ------------------------------------------------------ behavioral smoke --
(async () => {
  const phys = await import(path.join(ROOT, 'src/engine/physics.js'));
  const weapons = await import(path.join(ROOT, 'src/engine/weapons.js'));
  const director = await import(path.join(ROOT, 'src/engine/director.js'));
  const gameMod = await import(path.join(ROOT, 'src/game/game.js'));

  try {
    const body = phys.createBody({ x: 0, y: 0, heading: 0 });
    for (let i = 0; i < 30; i++) {
      phys.stepBody(body, { thrust: 1, turn: 0, brake: false }, 1 / 60,
        { accel: 400, maxSpeed: 300, drag: 1.5, turnAccel: 12, maxTurn: 4, stabDamp: 8 });
    }
    if (!(body.vx > 10)) failures.push('physics:no-thrust-along-heading');
    if (failures.length) return report();

    const body2 = phys.createBody({ x: 0, y: 0, vx: 200, vy: 0, heading: 0 });
    for (let i = 0; i < 120; i++) {
      phys.stepBody(body2, { thrust: 0, turn: 0, brake: false }, 1 / 60,
        { accel: 400, maxSpeed: 300, drag: 1.5, turnAccel: 12, maxTurn: 4, stabDamp: 8 });
    }
    if (Math.hypot(body2.vx, body2.vy) >= 200) failures.push('physics:no-drag');

    const body3 = phys.createBody({ x: 0, y: 0, heading: 0 });
    for (let i = 0; i < 30; i++) {
      phys.stepBody(body3, { thrust: 0, turn: 1, brake: false }, 1 / 60,
        { accel: 400, maxSpeed: 300, drag: 1.5, turnAccel: 12, maxTurn: 4, stabDamp: 8 });
    }
    if (!(body3.heading !== 0)) failures.push('physics:no-turn');

    const cState = { timer: 0 };
    const bullets = phys && weapons.createCannon({ cooldown: 0.2, damage: 1, speed: 500, spreadCount: 1, spreadAngle: 0, bulletTtl: 2 }).fire(cState);
    if (!Array.isArray(bullets) || bullets.length !== 1) failures.push('cannon:fire-shape');

    const w1 = director.wavePlan(1), w4 = director.wavePlan(4);
    if (!(w4.enemyCount > w1.enemyCount)) failures.push('director:no-difficulty-ramp');

    const choices = director.pickUpgradeChoices(Math.random, [], 3);
    if (!Array.isArray(choices) || choices.length !== 3 || !choices[0].id || !choices[0].label) failures.push('director:upgrade-shape');
    const owned = choices.map((c) => c.id);
    const again = director.pickUpgradeChoices(Math.random, owned, 3);
    if (again.some((c) => owned.includes(c.id))) failures.push('director:repeat-upgrade');

    const Game = gameMod.Game || gameMod.default;
    if (typeof Game !== 'function') failures.push('game:no-Game-export');
    else {
      const g = new Game({ seed: 7 });
      g.start();
      g.setInput({ thrust: 1, turn: 0, fire: true, fireMissile: false, brake: false });
      for (let i = 0; i < 180; i++) g.tick(16);
      const s = g.snapshot();
      for (const k of ['state', 'wave', 'score', 'player', 'wingmen', 'enemies', 'bullets', 'missiles', 'upgrades', 'upgradeChoices', 'shotsFired']) {
        if (!(k in s)) failures.push(`snapshot-missing:${k}`);
      }
      for (const k of ['x', 'y', 'vx', 'vy', 'heading', 'health']) {
        if (s.player && !(k in s.player)) failures.push(`player-missing:${k}`);
      }
      if (s.state === 'active') {
        if (!(s.shotsFired > 0)) failures.push('game:cannon-never-fired-under-fire-input');
        if (!(Math.hypot(s.player.vx, s.player.vy) > 0)) failures.push('game:no-thrust-in-run');
      }
      const g2 = new Game({ seed: 7 });
      g2.start();
      g2.setInput({ thrust: 0, turn: 0, fire: false, fireMissile: false, brake: false });
      for (let i = 0; i < 60; i++) g2.tick(16);
      const s2 = g2.snapshot();
      const g3 = new Game({ seed: 7 });
      g3.start();
      g3.setInput({ thrust: 0, turn: 0, fire: false, fireMissile: false, brake: false });
      for (let i = 0; i < 60; i++) g3.tick(16);
      const s3 = g3.snapshot();
      if (JSON.stringify(s2.player) !== JSON.stringify(s3.player)) failures.push('game:not-deterministic');
    }
  } catch (err) {
    failures.push(`import-run-threw:${err && err.message}`);
  }

  if (failures.length) return report();
  console.log('WEB_ACCEPT_OK');
})();
