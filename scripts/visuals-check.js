'use strict';
// File-existence gate after the visuals stage. DO NOT MODIFY.
// Fails fast if the renderer/HTML stage produced an empty commit.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const fails = [];

const htmlPath = path.join(ROOT, 'index.html');
const rendPath = path.join(ROOT, 'src/render/renderer.js');
if (!fs.existsSync(htmlPath)) fails.push('missing:index.html');
if (!fs.existsSync(rendPath)) fails.push('missing:src/render/renderer.js');

if (!fails.length) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  if (!/<canvas[^>]*id="board"/.test(html)) fails.push('html:no-canvas-board');
  if (!/<script[^>]*type="module"[^>]*src="src\/main\.js"/.test(html)) fails.push('html:no-module-main');
  const rend = fs.readFileSync(rendPath, 'utf8');
  if (rend.length < 3000) fails.push(`renderer-too-small:${rend.length}B`);
  for (const m of ['resize', 'render', 'addShake', 'addFlash', 'showToast']) {
    if (!new RegExp(`${m}\\s*\\(`).test(rend)) fails.push(`renderer-missing:${m}`);
  }
}
if (fails.length) { fails.forEach((f) => console.error('FAIL:', f)); console.log('VISUALS_CHECK_FAILED'); process.exit(1); }
console.log('VISUALS_CHECK_OK');
