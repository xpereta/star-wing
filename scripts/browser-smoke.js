'use strict';
// Browser-integration smoke gate for star-wing. DO NOT MODIFY.
// Boots index.html + src/main.js against deterministic stubs for
// window/document/canvas2d/WebAudio, runs frames, holds thrust and taps fire,
// then requires: zero console errors, a finite non-zero canvas backing store,
// >100 draw calls, player speed > 0 after thrust, and shotsFired increasing.
// Prints BROWSER_SMOKE_OK on green, BROWSER_SMOKE_FAILED + reasons otherwise.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const reasons = [];
function fail(why) { reasons.push(why); }

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
const styleText = styleMatch ? styleMatch[1] : '';
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

for (const m of styleText.matchAll(/#([a-zA-Z][\w-]*)/g)) {
  if (/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{4}$|^[0-9a-fA-F]{6}$|^[0-9a-fA-F]{8}$/.test(m[1])) continue;
  if (!htmlIds.has(m[1])) fail(`CSS references #${m[1]} but no element has that id`);
}
if (!/<canvas[^>]*id="board"/.test(html)) fail('index.html has no <canvas id="board">');
if (!/<script[^>]*type="module"[^>]*src="src\/main\.js"/.test(html)) fail('index.html does not load src/main.js as a module');

class FakeCanvas {
  constructor(id) {
    this.id = id; this.width = 0; this.height = 0;
    this.clientWidth = 1024; this.clientHeight = 640;
    this.drawCalls = { n: 0 };
    this.ctx = this._makeCtx();
    this.listeners = {};
  }
  _makeCtx() {
    const self = this;
    const store = { canvas: this };
    const grad = { addColorStop() {} };
    const param = () => ({
      value: 0, setValueAtTime() {}, linearRampToValueAtTime() {},
      exponentialRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {},
    });
    const node = () => ({
      connect() {}, disconnect() {}, start() {}, stop() {},
      frequency: param(), gain: param(), Q: param(), detune: param(),
      pan: param(), type: 'sine', buffer: null, onended: null,
    });
    const factories = {
      createLinearGradient: () => grad, createRadialGradient: () => grad,
      createPattern: () => grad, createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4) }),
      measureText: () => ({ width: 10 }),
      createGain: node, createOscillator: node, createBufferSource: node,
      createBiquadFilter: node, createDynamicsCompressor: node,
      createStereoPanner: node, createWaveShaper: node,
      createBuffer: (ch, len) => ({ length: len, getChannelData: () => new Float32Array(len) }),
    };
    return new Proxy(store, {
      get(t, k) {
        if (k in t) return t[k];
        if (k in factories) { t[k] = factories[k]; return t[k]; }
        if (typeof k === 'string') { const fn = () => { self.drawCalls.n++; }; t[k] = fn; return fn; }
        return undefined;
      },
      set(t, k, v) { t[k] = v; return true; },
    });
  }
  getContext() { return this.ctx; }
  getBoundingClientRect() { return { width: this.clientWidth, height: this.clientHeight, left: 0, top: 0 }; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
}

function fakeElement(id) {
  return { id, textContent: '', className: '', children: [], appendChild(n) { this.children.push(n); }, addEventListener() {} };
}

const canvas = new FakeCanvas('board');
const elements = { board: canvas };
const rafQueue = [];
const winListeners = {};

globalThis.HTMLCanvasElement = FakeCanvas;
globalThis.document = {
  readyState: 'complete', hidden: false,
  getElementById(id) { if (!elements[id]) elements[id] = fakeElement(id); return elements[id]; },
  createElement(tag) { return fakeElement(tag); },
  querySelector(sel) { return sel === 'canvas#board' ? canvas : null; },
  addEventListener() {},
};
globalThis.window = {
  addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
  removeEventListener() {},
  requestAnimationFrame(cb) { rafQueue.push(cb); return rafQueue.length; },
  devicePixelRatio: 1,
};
globalThis.devicePixelRatio = 1;
globalThis.AudioContext = function FakeAudioContext() {
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} });
  const node = () => ({ connect() {}, disconnect() {}, start() {}, stop() {}, frequency: param(), gain: param(), Q: param(), detune: param(), pan: param(), type: 'sine', buffer: null, onended: null });
  return {
    currentTime: 0, sampleRate: 48000, state: 'running', destination: {},
    resume: () => Promise.resolve(),
    createGain: node, createOscillator: node, createBufferSource: node,
    createBiquadFilter: node, createDynamicsCompressor: node,
    createStereoPanner: node, createWaveShaper: node,
    createBuffer: (ch, len) => ({ length: len, getChannelData: () => new Float32Array(len) }),
  };
};

const consoleErrors = [];
const realError = console.error;
console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); };

function runFrames(n) {
  let t = performance.now();
  for (let i = 0; i < n; i++) {
    const q = rafQueue.splice(0, rafQueue.length);
    t += 16.7;
    for (const cb of q) { try { cb(t); } catch (err) { fail(`frame threw: ${err && err.message}`); return; } }
  }
}

function key(code, kind) {
  const ev = { code, repeat: false, preventDefault() {} };
  for (const fn of (winListeners[kind] || [])) {
    try { fn(ev); } catch (err) { fail(`${kind} ${code} threw: ${err && err.message}`); }
  }
}

(async () => {
  runFrames(1);
  try {
    await import(path.join(ROOT, 'src', 'main.js'));
  } catch (err) { fail(`importing src/main.js threw: ${err && err.message}`); }

  runFrames(3);

  const shell = globalThis.window.__game;
  if (!shell) fail('boot did not expose window.__game (required contract for the smoke harness)');
  else {
    let before = null;
    try { before = shell.game.snapshot(); } catch (err) { fail(`game.snapshot() threw: ${err && err.message}`); }

    key('ArrowUp', 'keydown');
    runFrames(90);
    key('ArrowUp', 'keyup');
    let mid = null;
    try { mid = shell.game.snapshot(); } catch (err) { fail(`snapshot after thrust threw: ${err && err.message}`); }
    if (mid) {
      const speed = Math.hypot(mid.player.vx, mid.player.vy);
      if (!(speed > 50)) fail(`player speed only ${speed.toFixed(1)} after 90 thrust frames — thrust input likely not reaching physics (drift noise passes a >0 check)`);
    }

    for (let i = 0; i < 6; i++) { key('Space', 'keydown'); runFrames(8); key('Space', 'keyup'); runFrames(2); }
    let after = null;
    try { after = shell.game.snapshot(); } catch (err) { fail(`snapshot after fire threw: ${err && err.message}`); }
    if (after && before && !(after.shotsFired > before.shotsFired)) {
      fail(`shotsFired did not increase (${before.shotsFired} -> ${after.shotsFired}) — fire input broken`);
    }
  }

  runFrames(30);

  if (!Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width <= 0 || canvas.height <= 0) {
    fail(`canvas backing store invalid (w=${canvas.width}, h=${canvas.height}) — resize()/layout bug`);
  }
  if (canvas.drawCalls.n < 100) fail(`only ${canvas.drawCalls.n} draw calls after full frames — renderer not drawing`);
  if (consoleErrors.length) fail(`console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);

  console.error = realError;
  if (reasons.length) { for (const r of reasons) console.error('FAIL:', r); console.log('BROWSER_SMOKE_FAILED'); process.exit(1); }
  console.log('BROWSER_SMOKE_OK');
})();
