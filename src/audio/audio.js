// star-wing — procedural audio. Every sound here is synthesised at runtime with
// WebAudio oscillators, filters and noise buffers: no files, no fetch, no assets.
// The kit is lazy: nothing is created until unlock() runs inside a user gesture.

/** Master trim. Individual events add their own envelopes on top of this. */
const MASTER = 0.55;
/** Ambient pad level, deliberately quiet so it sits under the combat layer. */
const AMBIENT = 0.085;
/** Hard cap on simultaneous synth voices (browsers choke in the hundreds). */
const MAX_VOICES = 28;

/** Minimum seconds between two retriggers of the same event. */
const GATES = Object.freeze({
  cannon: 0.055,
  missile: 0.18,
  explode: 0.1,
  hit: 0.06,
  lockOn: 0.2,
  waveClear: 0.5,
  upgrade: 0.4,
  gameOver: 1.2,
});

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

export class AudioKit {
  constructor() {
    this.muted = false;
    this.ambientRunning = false;

    this.ctx = null;
    this.master = null;
    this.sfx = null;
    this.pad = null;
    this.padVoice = null;
    this.noiseBuf = null;

    this.voices = 0;
    this.voiceEnd = [];
    this.lastPlayed = new Map();
    this._wantAmbient = false;
    this._noiseSeed = 0x9e3779b9;
  }

  // ----------------------------------------------------------------- unlock --

  /**
   * Create the AudioContext. Must be called from inside a user gesture
   * (keydown / pointerdown) or browsers keep everything silent.
   * @returns {boolean} true when a context is live
   */
  unlock() {
    if (this.ctx) {
      this._resume();
      return true;
    }
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (typeof Ctor !== 'function') return false;

    let ctx = null;
    try {
      ctx = new Ctor();
    } catch (err) {
      return false;
    }
    if (!ctx || typeof ctx.createGain !== 'function') return false;

    this.ctx = ctx;
    this.master = ctx.createGain();
    this._set(this.master.gain, this.muted ? 0 : MASTER);
    this.master.connect(ctx.destination);

    this.sfx = ctx.createGain();
    this._set(this.sfx.gain, 1);
    this.sfx.connect(this.master);

    this.pad = ctx.createGain();
    this._set(this.pad.gain, 1);
    this.pad.connect(this.master);

    this._resume();
    if (this._wantAmbient) this.startAmbient();
    return true;
  }

  _resume() {
    const ctx = this.ctx;
    if (!ctx) return;
    if (typeof ctx.resume === 'function' && ctx.state !== 'running') {
      try {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (err) {
        /* ignore: autoplay policy will surface on the next gesture */
      }
    }
  }

  // ------------------------------------------------------------- primitives --

  _now() {
    return num(this.ctx && this.ctx.currentTime, 0);
  }

  /** Set an AudioParam, tolerating stubs that omit optional params. */
  _set(param, value, at) {
    if (!param) return;
    const when = Number.isFinite(at) ? at : this._now();
    if (typeof param.setValueAtTime === 'function') {
      try {
        param.setValueAtTime(value, when);
      } catch (err) {
        param.value = value;
      }
    } else {
      param.value = value;
    }
  }

  /** Ramp an AudioParam; `curve` 'exp' needs a strictly positive target. */
  _ramp(param, target, at, curve = 'exp') {
    if (!param) return;
    try {
      if (curve === 'exp' && typeof param.exponentialRampToValueAtTime === 'function') {
        param.exponentialRampToValueAtTime(Math.max(1e-4, target), at);
      } else if (typeof param.linearRampToValueAtTime === 'function') {
        param.linearRampToValueAtTime(target, at);
      } else {
        param.value = target;
      }
    } catch (err) {
      param.value = target;
    }
  }

  /** Attack / hold / release envelope on a gain node, always starting at ~0. */
  _env(gain, t0, peak, attack, hold, release) {
    const g = gain && gain.gain;
    if (!g) return;
    const top = Math.max(1e-4, peak);
    this._set(g, 1e-4, t0);
    this._ramp(g, top, t0 + attack, 'exp');
    this._set(g, top, t0 + attack + hold);
    this._ramp(g, 1e-4, t0 + attack + hold + release, 'exp');
  }
  // ----------------------------------------------------------------- voices --

  /** Two seconds of deterministic white noise, built once per context. */
  _noiseBuffer() {
    if (this.noiseBuf) return this.noiseBuf;
    const ctx = this.ctx;
    const sr = Math.max(8000, num(ctx.sampleRate, 48000));
    const len = Math.max(1024, Math.floor(sr * 2));
    let buf = null;
    try {
      buf = ctx.createBuffer(1, len, sr);
    } catch (err) {
      return null;
    }
    const data = buf.getChannelData(0);
    let s = this._noiseSeed >>> 0;
    for (let i = 0; i < data.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      data[i] = s / 2147483648 - 1;
    }
    this.noiseBuf = buf;
    return buf;
  }

  /** Small LCG so debris hiss varies per hit but never uses Math.random. */
  _rand() {
    this._noiseSeed = (Math.imul(this._noiseSeed, 1103515245) + 12345) >>> 0;
    return this._noiseSeed / 4294967296;
  }

  _drop(...nodes) {
    for (const n of nodes) {
      if (!n || typeof n.disconnect !== 'function') continue;
      try {
        n.disconnect();
      } catch (err) {
        /* already gone */
      }
    }
  }

  /**
   * Reserve a voice slot. The cap is time-based rather than purely callback
   * based: a suspended context can stall `onended` for a long time, and a
   * counter that only ever goes down by callback would silence the kit forever.
   * @returns {object|null} a ticket to hand back to `_release`
   */
  _claim(endTime) {
    const now = this._now();
    if (this.voiceEnd.length) this.voiceEnd = this.voiceEnd.filter((end) => end > now);
    this.voices = this.voiceEnd.length;
    if (this.voices >= MAX_VOICES) return null;

    const ticket = { end: endTime };
    this.voiceEnd.push(ticket);
    this.voices += 1;
    return ticket;
  }

  /** Hand a reserved slot back early (voice failed, or onended fired). */
  _release(ticket) {
    if (!ticket) return;
    const at = this.voiceEnd.indexOf(ticket);
    if (at >= 0) this.voiceEnd.splice(at, 1);
    this.voices = this.voiceEnd.length;
  }

  /** One pitched voice: swept oscillator -> optional filter -> sfx bus. */
  _tone(t0, cfg = {}) {
    const ctx = this.ctx;
    if (!ctx || !this.sfx) return null;

    const dur = Math.max(0.01, num(cfg.dur, 0.2));
    const attack = Math.max(0.001, num(cfg.attack, 0.006));
    const hold = Math.max(0, num(cfg.hold, 0));
    const release = Math.max(0.01, num(cfg.release, dur * 0.8));
    const life = t0 + attack + hold + dur + release;

    const ticket = this._claim(life);
    if (!ticket) return null;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = cfg.type || 'sine';
    this._set(osc.frequency, Math.max(1, num(cfg.from, 440)), t0);
    if (Number.isFinite(cfg.to)) this._ramp(osc.frequency, Math.max(1, cfg.to), t0 + attack + hold + dur);
    if (Number.isFinite(cfg.detune)) this._set(osc.detune, cfg.detune, t0);
    this._env(gain, t0, num(cfg.peak, 0.2), attack, hold, release);

    osc.connect(gain);
    let tail = gain;
    if (cfg.filter) {
      const f = ctx.createBiquadFilter();
      f.type = cfg.filter;
      this._set(f.frequency, Math.max(20, num(cfg.cut, 1200)), t0);
      if (Number.isFinite(cfg.cutTo)) this._ramp(f.frequency, Math.max(20, cfg.cutTo), life);
      this._set(f.Q, num(cfg.q, 1), t0);
      gain.connect(f);
      tail = f;
    }
    tail.connect(this.sfx);

    osc.onended = () => {
      this._release(ticket);
      this._drop(osc, gain);
    };
    try {
      osc.start(t0);
      osc.stop(life + 0.02);
    } catch (err) {
      this._release(ticket);
      this._drop(osc, gain);
      return null;
    }
    return gain;
  }
  /** One filtered noise burst — the backbone of explosions, hiss and thumps. */
  _noise(t0, cfg = {}) {
    const ctx = this.ctx;
    if (!ctx || !this.sfx) return null;
    const buf = this._noiseBuffer();
    if (!buf) return null;
    const dur = Math.max(0.01, num(cfg.dur, 0.2));
    const attack = Math.max(0.001, num(cfg.attack, 0.004));
    const hold = Math.max(0, num(cfg.hold, 0));
    const release = Math.max(0.01, num(cfg.release, dur));
    const life = t0 + attack + hold + release;

    const ticket = this._claim(life);
    if (!ticket) return null;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    this._set(src.playbackRate, num(cfg.rate, 1), t0);

    const gain = ctx.createGain();
    this._env(gain, t0, num(cfg.peak, 0.18), attack, hold, release);
    src.connect(gain);

    let tail = gain;
    if (cfg.filter) {
      const f = ctx.createBiquadFilter();
      f.type = cfg.filter;
      this._set(f.frequency, Math.max(20, num(cfg.cut, 1400)), t0);
      if (Number.isFinite(cfg.cutTo)) this._ramp(f.frequency, Math.max(20, cfg.cutTo), life);
      this._set(f.Q, num(cfg.q, 0.9), t0);
      gain.connect(f);
      tail = f;
    }
    tail.connect(this.sfx);

    src.onended = () => {
      this._release(ticket);
      this._drop(src, gain);
    };
    const offset = this._rand();
    try {
      src.start(t0, offset);
      src.stop(life + 0.02);
    } catch (err) {
      this._release(ticket);
      this._drop(src, gain);
      return null;
    }
    return gain;
  }

  /** Convenience for fanfares / chimes: one short note of a scale degree. */
  _note(t0, freq, dur = 0.2, peak = 0.15, type = 'triangle') {
    return this._tone(t0, {
      type,
      from: freq,
      dur,
      peak,
      attack: 0.01,
      hold: dur * 0.35,
      release: dur * 0.75,
    });
  }

  /** Detuned triangle + sine pair: cheap shimmer for the fanfare/chime tier. */
  _chord(t0, freqs, dur, peak, step = 0) {
    for (let i = 0; i < freqs.length; i++) {
      const at = t0 + step * i;
      this._note(at, freqs[i], dur, peak, 'triangle');
      this._tone(at, {
        type: 'sine',
        from: freqs[i] * 2,
        dur: dur * 0.6,
        peak: peak * 0.4,
        detune: 7,
      });
    }
  }
  // ------------------------------------------------------------------ events --

  /**
   * Trigger an event by name. Silently no-ops before unlock(), while muted,
   * or when the same event was already audible a few frames ago.
   * @returns {boolean} true when the sound actually started
   */
  play(name, when) {
    const fn = this[name];
    if (typeof fn !== 'function') return false;
    return this._gated(name, () => fn.call(this, when));
  }

  _gated(name, run) {
    if (this.muted || !this.ctx) return false;
    const now = this._now();
    const gate = GATES[name];
    const last = this.lastPlayed.get(name);
    if (Number.isFinite(gate) && last !== undefined && now - last < gate) return false;
    this.lastPlayed.set(name, now);
    this._resume();
    return run() !== false;
  }

  /** Cannon zap: descending square through a highpass plus a muzzle crack. */
  cannon(t0 = this._now()) {
    const t = num(t0, this._now());
    this._tone(t, {
      type: 'square',
      from: 1180,
      to: 240,
      dur: 0.05,
      peak: 0.15,
      attack: 0.002,
      hold: 0.008,
      release: 0.05,
      filter: 'highpass',
      cut: 420,
    });
    this._noise(t, {
      dur: 0.05,
      peak: 0.08,
      attack: 0.001,
      release: 0.05,
      filter: 'bandpass',
      cut: 3200,
      q: 0.7,
    });
  }

  /** Missile whoosh: bandpass noise sweeping up as the motor bites. */
  missile(t0 = this._now()) {
    const t = num(t0, this._now());
    this._noise(t, {
      dur: 0.34,
      peak: 0.18,
      attack: 0.02,
      hold: 0.06,
      release: 0.3,
      filter: 'bandpass',
      cut: 380,
      cutTo: 2600,
      q: 2.4,
      rate: 0.8,
    });
    this._tone(t, {
      type: 'sawtooth',
      from: 120,
      to: 320,
      dur: 0.22,
      peak: 0.08,
      attack: 0.01,
      release: 0.2,
      filter: 'lowpass',
      cut: 900,
      cutTo: 2400,
    });
  }

  /** Lock-on beep: two clipped pips, the classic target-acquired chirp. */
  lockOn(t0 = this._now()) {
    const t = num(t0, this._now());
    this._tone(t, { type: 'square', from: 1320, dur: 0.05, peak: 0.09, attack: 0.004, hold: 0.03, release: 0.03 });
    this._tone(t + 0.09, { type: 'square', from: 1760, dur: 0.05, peak: 0.1, attack: 0.004, hold: 0.03, release: 0.03 });
  }

  /** Explosion: wide noise burst, lowpassed sub thump, then debris crackle. */
  explode(t0 = this._now()) {
    const t = num(t0, this._now());
    this._noise(t, {
      dur: 0.5,
      peak: 0.3,
      attack: 0.004,
      hold: 0.05,
      release: 0.5,
      filter: 'lowpass',
      cut: 2400,
      cutTo: 260,
      q: 1.2,
    });
    this._tone(t, {
      type: 'sine',
      from: 110,
      to: 34,
      dur: 0.28,
      peak: 0.3,
      attack: 0.008,
      hold: 0.04,
      release: 0.34,
      filter: 'lowpass',
      cut: 220,
      cutTo: 70,
    });
    this._noise(t + 0.12, {
      dur: 0.3,
      peak: 0.08,
      attack: 0.02,
      release: 0.3,
      filter: 'highpass',
      cut: 1800,
    });
  }

  /** Hit tick: tiny bright transient so volleys read as contact. */
  hit(t0 = this._now()) {
    const t = num(t0, this._now());
    this._tone(t, { type: 'square', from: 2400, to: 1500, dur: 0.02, peak: 0.06, attack: 0.001, release: 0.03 });
    this._noise(t, { dur: 0.03, peak: 0.05, attack: 0.001, release: 0.03, filter: 'bandpass', cut: 5200, q: 1.2 });
  }

  /** Wave-clear fanfare: rising major arpeggio with a shimmer octave. */
  waveClear(t0 = this._now()) {
    const t = num(t0, this._now());
    this._chord(t, [523.25, 659.25, 783.99, 1046.5], 0.3, 0.12, 0.09);
  }

  /** Upgrade chime: bell-like pair with a long tail. */
  upgrade(t0 = this._now()) {
    const t = num(t0, this._now());
    this._chord(t, [659.25, 987.77], 0.5, 0.13, 0.06);
    this._tone(t + 0.12, { type: 'sine', from: 1975.5, dur: 0.4, peak: 0.06, attack: 0.006, release: 0.5 });
  }

  /** Game over: slow descending minor motif. */
  gameOver(t0 = this._now()) {
    const t = num(t0, this._now());
    const motif = [440, 349.23, 293.66, 220];
    for (let i = 0; i < motif.length; i++) {
      const at = t + i * 0.26;
      this._note(at, motif[i], 0.34, 0.14, 'sawtooth');
      this._tone(at, {
        type: 'triangle',
        from: motif[i] / 2,
        dur: 0.4,
        peak: 0.08,
        attack: 0.02,
        release: 0.5,
        filter: 'lowpass',
        cut: 700,
      });
    }
  }
  // ----------------------------------------------------------------- ambient --

  /**
   * Start the drone pad: detuned oscillators through a lowpass that a very
   * slow LFO slides around. Idempotent; if called before unlock() the intent
   * is remembered and the pad starts as soon as a context exists.
   * @returns {boolean} true when the pad is (or will be) running
   */
  startAmbient() {
    this._wantAmbient = true;
    if (!this.ctx || !this.pad || this.padVoice) return Boolean(this.padVoice);

    const ctx = this.ctx;
    const t0 = this._now();
    const voice = { osc: [], gains: [], lfo: null, mix: null, lp: null };

    const mix = ctx.createGain();
    this._set(mix.gain, 1e-4, t0);
    this._ramp(mix.gain, AMBIENT, t0 + 2.5, 'exp');
    mix.connect(this.pad);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    this._set(lp.frequency, 620, t0);
    this._set(lp.Q, 3.5, t0);
    lp.connect(mix);

    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    this._set(lfo.frequency, 0.07, t0);
    this._set(depth.gain, 260, t0);
    lfo.connect(depth);
    depth.connect(lp.frequency);

    const partials = [
      [55, 'sawtooth', 0, 1],
      [55, 'sawtooth', 9, 1],
      [82.41, 'triangle', -7, 0.7],
      [110, 'sine', 5, 0.5],
    ];
    for (const [freq, type, detune, level] of partials) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      this._set(osc.frequency, freq, t0);
      this._set(osc.detune, detune, t0);
      this._set(g.gain, level * 0.25, t0);
      osc.connect(g);
      g.connect(lp);
      osc.start(t0);
      voice.osc.push(osc);
      voice.gains.push(g);
    }
    lfo.start(t0);

    voice.mix = mix;
    voice.lp = lp;
    voice.lfo = lfo;
    this.padVoice = voice;
    this.ambientRunning = true;
    return true;
  }

  /** Fade the pad out, then stop its oscillators. Idempotent. */
  stopAmbient() {
    this._wantAmbient = false;
    const v = this.padVoice;
    this.padVoice = null;
    this.ambientRunning = false;
    if (!v) return false;

    const t0 = this._now();
    this._ramp(v.mix.gain, 1e-4, t0 + 1.2, 'exp');
    const stop = (osc) => {
      if (!osc) return;
      osc.onended = () => this._drop(osc);
      try {
        osc.stop(t0 + 1.4);
      } catch (err) {
        /* already stopped */
      }
    };
    for (const osc of v.osc) stop(osc);
    stop(v.lfo);
    this._drop(v.lp, ...v.gains, v.mix);
    return true;
  }

  // -------------------------------------------------------------------- mute --

  /** @param {boolean} [next] omitted toggles. @returns {boolean} the new state */
  setMuted(next) {
    this.muted = next === undefined ? !this.muted : Boolean(next);
    this._applyMute();
    return this.muted;
  }

  toggleMute() {
    return this.setMuted(!this.muted);
  }

  _applyMute() {
    const g = this.master && this.master.gain;
    if (!g) return;
    const target = this.muted ? 1e-4 : MASTER;
    if (typeof g.cancelScheduledValues === 'function') {
      try {
        g.cancelScheduledValues(this._now());
      } catch (err) {
        /* param stub */
      }
    }
    this._set(g, this.muted ? 1e-4 : MASTER);
    this._ramp(g, target, this._now() + 0.08);
  }
}
