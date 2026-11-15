// star-wing run director: how hard each wave is, and which upgrades you draw.
// Pure module: no canvas, no imagedata, no timers, no audio — the run shell in
// src/game/game.js owns state; this file only answers "what comes next".

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** [0, 1) — tolerant of a sloppy rng that ever returns exactly 1. */
function unit(rng) {
  const r = rng();
  if (!Number.isFinite(r)) return 0;
  return r < 0 ? 0 : r >= 1 ? 0.9999999999 : r;
}

/**
 * Difficulty curve for one wave. Every field climbs with the wave number, so
 * a run always tightens: more bodies, faster bodies, meaner contact damage,
 * tougher hulls. Caps keep wave 12+ playable rather than absurd.
 *
 * @returns {{enemyCount:number, enemySpeed:number, enemyAggression:number, enemyHealth:number}}
 */
export function wavePlan(wave) {
  const w = Math.max(1, Math.round(finite(wave, 1)));

  return {
    enemyCount: Math.min(3 + w, 24),
    enemySpeed: Math.min(100 + w * 16, 320),
    enemyAggression: Math.min(0.7 + w * 0.15, 3),
    enemyHealth: Math.round(22 * Math.pow(1.18, w - 1)),
  };
}

/**
 * The upgrade pool. Ten distinct ids (the brief asks for at least eight); the
 * run shell owns what each id actually *does*, so this list stays pure data.
 */
export const UPGRADE_POOL = Object.freeze([
  Object.freeze({ id: 'cannon-rate', label: 'Rapid Breech', desc: 'Cannon cycles 15% faster.' }),
  Object.freeze({ id: 'cannon-damage', label: 'Heavy Slugs', desc: 'Cannon rounds deal +8 damage.' }),
  Object.freeze({ id: 'spread', label: 'Split Barrel', desc: 'Cannon fires one extra round per salvo, wider fan.' }),
  Object.freeze({ id: 'missile-salvo', label: 'Salvo Racks', desc: '+1 missile per launch, +2 max ammo.' }),
  Object.freeze({ id: 'missile-ammo', label: 'Munitions Locker', desc: '+5 missile ammo, restocked every wave.' }),
  Object.freeze({ id: 'turn-rate', label: 'Vector Thrusters', desc: 'Sharper rudder authority and faster spin-up.' }),
  Object.freeze({ id: 'max-speed', label: 'Overdriven Drive', desc: 'Higher top speed and stronger thrust.' }),
  Object.freeze({ id: 'wingman', label: 'Wingman Request', desc: 'Another fighter joins the flight (max 3).' }),
  Object.freeze({ id: 'max-hull', label: 'Reinforced Hull', desc: '+25 max hull, patched back to full.' }),
  Object.freeze({ id: 'shield-regen', label: 'Nanoweave Plating', desc: 'Hull slowly repairs itself in combat.' }),
]);

/** Every id the director can hand out — handy for the run shell's effect table. */
export const UPGRADE_IDS = Object.freeze(UPGRADE_POOL.map((u) => u.id));

/**
 * Draft `count` upgrade offers for the between-waves screen.
 * Already-owned ids are never offered again, so a run always sees something new.
 *
 * @param {() => number} rng seeded source of [0,1); pass the run's own rng for determinism
 * @param {string[]} owned ids the player already has
 * @param {number} count how many offers to return (default 3)
 * @returns {Array<{id:string,label:string,desc:string}>}
 */
export function pickUpgradeChoices(rng, owned, count = 3) {
  const rand = typeof rng === 'function' ? rng : Math.random;
  const taken = new Set(Array.isArray(owned) ? owned : []);
  const bag = UPGRADE_POOL.filter((u) => !taken.has(u.id));

  const want = Math.max(0, Math.min(Math.round(finite(count, 3)), bag.length));
  const picks = [];

  // Partial Fisher-Yates: draw distinct entries without a second pass.
  for (let i = 0; i < want; i++) {
    const j = i + Math.floor(unit(rand) * (bag.length - i));
    const pick = bag.splice(j, 1)[0];
    picks.push({ id: pick.id, label: pick.label, desc: pick.desc });
  }

  return picks;
}
