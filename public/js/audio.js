(function attachAudio(global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Procedural Web Audio: every sound is synthesized at runtime (oscillators +
  // shaped noise), so there are no audio assets to ship or license. Sampled
  // music/SFX can replace these later behind the same API.
  //
  // Sync model: world events (pickup, missile impact, round end) are triggered
  // from the same server messages that drive the visuals, so audio stays in
  // lockstep with what the player sees. The player's own movement whoosh is
  // driven by the locally PREDICTED brush, so it has zero network lag.
  // Nothing plays until unlock() runs inside the Play-button gesture.
  // ---------------------------------------------------------------------------

  let ctx = null;
  let master = null;
  let musicGain = null;
  let sfxGain = null;
  let noiseBuf = null;

  let muted = false;
  let volume = 0.7;     // master (0..1)
  let musicOn = true;
  let musicVol = 1;     // music category level (0..1), scales MUSIC_MIX
  let sfxVol = 1;       // SFX category level (0..1), scales SFX_MIX

  // Per-category mix levels. The user's category volume (0..1) multiplies these,
  // so a category at 1.0 sounds exactly as it did before category controls.
  const MUSIC_MIX = 0.32;
  const SFX_MIX = 0.9;

  function clamp01(v) { return Math.max(0, Math.min(1, v || 0)); }

  let voices = 0;
  const MAX_VOICES = 18;

  // Movement whoosh nodes.
  let whooshGain = null;
  let whooshTarget = 0;
  let whooshCur = 0;

  // Music scheduler state.
  let musicTimer = null;
  let nextNoteTime = 0;
  let step = 0;

  function supported() {
    return !!(global.AudioContext || global.webkitAudioContext);
  }

  function makeNoiseBuffer() {
    const len = Math.floor(ctx.sampleRate * 1.2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function init() {
    if (ctx || !supported()) return;
    const AC = global.AudioContext || global.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    master.connect(ctx.destination);

    musicGain = ctx.createGain();
    musicGain.gain.value = MUSIC_MIX * musicVol;
    musicGain.connect(master);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = SFX_MIX * sfxVol;
    sfxGain.connect(master);

    noiseBuf = makeNoiseBuffer();
    startWhoosh();
    startMusic();
  }

  function unlock() {
    init();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  function now() { return ctx ? ctx.currentTime : 0; }

  // Track concurrent voices so a missile barrage can't spawn unbounded nodes.
  function claimVoice(seconds) {
    if (voices >= MAX_VOICES) return false;
    voices++;
    global.setTimeout(() => { voices = Math.max(0, voices - 1); }, seconds * 1000 + 60);
    return true;
  }

  // One enveloped oscillator note.
  function tone(opts) {
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = opts.type || 'sine';
    const t0 = (opts.at != null ? opts.at : now()) + (opts.delay || 0);
    const dur = opts.dur || 0.2;
    o.frequency.setValueAtTime(opts.f0 || 220, t0);
    if (opts.f1 != null) o.frequency.exponentialRampToValueAtTime(Math.max(1, opts.f1), t0 + dur);
    const peak = opts.gain != null ? opts.gain : 0.3;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (opts.attack || 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(opts.bus || sfxGain);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  // Shaped noise burst (impacts, hats).
  function noise(opts) {
    if (!ctx || !noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const filt = ctx.createBiquadFilter();
    filt.type = opts.filter || 'lowpass';
    filt.frequency.setValueAtTime(opts.freq || 1200, now());
    if (opts.q != null) filt.Q.value = opts.q;
    const g = ctx.createGain();
    const t0 = (opts.at != null ? opts.at : now());
    const dur = opts.dur || 0.18;
    const peak = opts.gain != null ? opts.gain : 0.3;
    g.gain.setValueAtTime(peak, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(opts.bus || sfxGain);
    const off = Math.random() * 0.4;
    src.start(t0, off, dur + 0.05);
  }

  // Music bus level after the user's category volume. duck() ramps back to this.
  function musicBase() { return MUSIC_MIX * musicVol; }

  // Briefly duck the music (sidechain feel) under a big event.
  function duck(amount, hold) {
    if (!ctx || !musicGain) return;
    const t = now();
    const base = musicBase();
    musicGain.gain.cancelScheduledValues(t);
    musicGain.gain.setValueAtTime(musicGain.gain.value, t);
    musicGain.gain.linearRampToValueAtTime(base * (1 - amount), t + 0.03);
    musicGain.gain.linearRampToValueAtTime(base, t + (hold || 0.5));
  }

  // ---- public SFX -----------------------------------------------------------
  function pickup(type) {
    if (!ctx || !claimVoice(0.5)) return;
    const t0 = now();
    if (type === 'speed') {
      tone({ type: 'triangle', f0: 520, f1: 980, dur: 0.16, gain: 0.32 });
      tone({ type: 'triangle', f0: 780, f1: 1460, dur: 0.14, gain: 0.18, delay: 0.05 });
    } else if (type === 'freeze') {
      tone({ type: 'sine', f0: 1300, f1: 1900, dur: 0.32, gain: 0.22 });
      noise({ filter: 'highpass', freq: 5000, dur: 0.3, gain: 0.06 });
    } else if (type === 'inkjam') {
      tone({ type: 'sawtooth', f0: 320, f1: 90, dur: 0.3, gain: 0.22 });
      noise({ filter: 'lowpass', freq: 700, dur: 0.22, gain: 0.12 });
    } else if (type === 'missile') {
      tone({ type: 'square', f0: 180, f1: 720, dur: 0.22, gain: 0.2 });
      tone({ type: 'sawtooth', f0: 90, f1: 360, dur: 0.26, gain: 0.14, delay: 0.02 });
    } else if (type === 'mega') {
      tone({ type: 'triangle', f0: 210, f1: 420, dur: 0.2, gain: 0.26 });
      tone({ type: 'sine', f0: 105, f1: 155, dur: 0.24, gain: 0.18, delay: 0.03 });
      noise({ filter: 'lowpass', freq: 620, dur: 0.14, gain: 0.11, at: t0 + 0.02 });
    } else if (type === 'echo') {
      tone({ type: 'sine', f0: 720, f1: 1180, dur: 0.13, gain: 0.18 });
      tone({ type: 'sine', f0: 720, f1: 1180, dur: 0.13, gain: 0.12, delay: 0.08 });
      tone({ type: 'triangle', f0: 480, f1: 760, dur: 0.2, gain: 0.12, delay: 0.04 });
    } else if (type === 'erase') {
      noise({ filter: 'bandpass', freq: 1200, q: 0.7, dur: 0.18, gain: 0.16, at: t0 });
      tone({ type: 'sawtooth', f0: 420, f1: 180, dur: 0.2, gain: 0.14 });
      tone({ type: 'triangle', f0: 760, f1: 540, dur: 0.12, gain: 0.1, delay: 0.08 });
    } else if (type === 'slow') {
      tone({ type: 'sawtooth', f0: 420, f1: 85, dur: 0.34, gain: 0.2 });
      noise({ filter: 'lowpass', freq: 360, q: 0.6, dur: 0.28, gain: 0.16, at: t0 + 0.02 });
    } else if (type === 'selfFreeze') {
      tone({ type: 'sine', f0: 1700, f1: 620, dur: 0.26, gain: 0.2 });
      noise({ filter: 'highpass', freq: 4200, dur: 0.16, gain: 0.09, at: t0 });
      tone({ type: 'triangle', f0: 310, f1: 180, dur: 0.18, gain: 0.11, delay: 0.08 });
    } else if (type === 'selfInkjam') {
      tone({ type: 'sawtooth', f0: 260, f1: 70, dur: 0.28, gain: 0.2 });
      noise({ filter: 'lowpass', freq: 520, q: 0.9, dur: 0.18, gain: 0.14, at: t0 });
      noise({ filter: 'bandpass', freq: 240, q: 0.5, dur: 0.16, gain: 0.11, at: t0 + 0.11 });
    } else if (type === 'badMissile') {
      noise({ filter: 'highpass', freq: 1800, dur: 0.08, gain: 0.22, at: t0 });
      tone({ type: 'square', f0: 620, f1: 110, dur: 0.24, gain: 0.16, delay: 0.02 });
      noise({ filter: 'lowpass', freq: 420, dur: 0.24, gain: 0.18, at: t0 + 0.05 });
      duck(0.18, 0.24);
    } else if (type === 'tiny') {
      tone({ type: 'triangle', f0: 1300, f1: 940, dur: 0.08, gain: 0.16 });
      tone({ type: 'triangle', f0: 980, f1: 720, dur: 0.08, gain: 0.12, delay: 0.07 });
      tone({ type: 'triangle', f0: 720, f1: 520, dur: 0.1, gain: 0.09, delay: 0.14 });
    } else {
      tone({ type: 'triangle', f0: 600, f1: 900, dur: 0.14, gain: 0.28 });
    }
  }

  function impact() {
    if (!ctx || !claimVoice(0.4)) return;
    tone({ type: 'sine', f0: 180, f1: 42, dur: 0.28, gain: 0.5 });
    noise({ filter: 'lowpass', freq: 900, q: 1, dur: 0.2, gain: 0.4 });
    duck(0.5, 0.35);
  }

  // secondsLeft: 10..1 rising ticks; a brighter beep at 0.
  function tick(secondsLeft) {
    if (!ctx || !claimVoice(0.2)) return;
    if (secondsLeft <= 0) {
      tone({ type: 'square', f0: 880, dur: 0.34, gain: 0.3 });
      return;
    }
    const f = 440 + (10 - Math.min(10, secondsLeft)) * 55;
    tone({ type: 'square', f0: f, dur: 0.09, gain: 0.22 });
  }

  function roundEnd(win) {
    if (!ctx) return;
    duck(0.6, 1.2);
    const t = now();
    if (win) {
      const notes = [523.25, 659.25, 783.99, 1046.5];   // C major arpeggio up
      notes.forEach((f, i) => tone({ type: 'triangle', f0: f, dur: 0.5, gain: 0.3, at: t + i * 0.12 }));
    } else {
      const notes = [392, 329.63, 261.63];               // descending minor-ish
      notes.forEach((f, i) => tone({ type: 'sawtooth', f0: f, f1: f * 0.97, dur: 0.5, gain: 0.22, at: t + i * 0.16 }));
    }
  }

  function spawn() {
    if (!ctx || !claimVoice(0.3)) return;
    tone({ type: 'triangle', f0: 300, f1: 620, dur: 0.2, gain: 0.26 });
  }

  // Lightning strike: a sharp crack with low-mid weight, an electric zap diving into
  // the sub, then a long rolling thunder roar -- deeper and bigger than a chime. The
  // music ducks under it.
  function powerupSpawn() {
    if (!ctx || !claimVoice(1.0)) return;
    const t0 = now();
    noise({ filter: 'highpass', freq: 2300, dur: 0.08, gain: 0.24, at: t0 });           // bright snap
    noise({ filter: 'bandpass', freq: 700, q: 0.6, dur: 0.12, gain: 0.30, at: t0 });     // crack body
    tone({ type: 'sawtooth', f0: 1200, f1: 70, dur: 0.18, gain: 0.12 });                 // zap into sub
    noise({ filter: 'lowpass', freq: 220, dur: 0.7, gain: 0.32, at: t0 + 0.04 });        // roar
    noise({ filter: 'lowpass', freq: 120, dur: 0.9, gain: 0.28, at: t0 + 0.10 });        // deep roll
    noise({ filter: 'lowpass', freq: 70, dur: 1.0, gain: 0.20, at: t0 + 0.16 });         // sub rumble
    tone({ type: 'sine', f0: 90, f1: 50, dur: 0.7, gain: 0.15, delay: 0.05 });           // body boom
    duck(0.3, 0.55);
  }

  // ---- movement whoosh (driven by predicted local speed) --------------------
  function startWhoosh() {
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 700;
    filt.Q.value = 0.7;
    whooshGain = ctx.createGain();
    whooshGain.gain.value = 0;
    src.connect(filt);
    filt.connect(whooshGain);
    whooshGain.connect(sfxGain);
    src.start();
  }
  // level: 0..1 (typically speed / maxSpeed). Smoothed internally.
  function movement(level) {
    whooshTarget = Math.max(0, Math.min(1, level || 0));
    if (!whooshGain || !ctx) return;
    whooshCur += (whooshTarget - whooshCur) * 0.12;
    whooshGain.gain.setTargetAtTime(whooshCur * 0.08, now(), 0.05);
  }

  // ---- music bed ------------------------------------------------------------
  // Calm 4-chord loop: sustained pad + sparse arpeggio + soft hat. Pentatonic
  // arp tones keep it consonant regardless of step.
  const PROG = [
    { root: 220.00, triad: [220.00, 261.63, 329.63] }, // Am
    { root: 174.61, triad: [174.61, 220.00, 261.63] }, // F
    { root: 261.63, triad: [261.63, 329.63, 392.00] }, // C
    { root: 196.00, triad: [196.00, 246.94, 293.66] }, // G
  ];
  const STEPS_PER_BAR = 8;
  const STEP_DUR = 0.19;
  const ARP_PATTERN = [1, 0, 1, 1, 0, 1, 0, 1];

  function scheduleStep(bar, s, t) {
    const chord = PROG[bar % PROG.length];
    // Pad on the downbeat: soft detuned triad with a slow swell.
    if (s === 0) {
      chord.triad.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = i === 0 ? 'sine' : 'triangle';
        o.frequency.value = f / 2;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.12, t + 0.25);
        g.gain.exponentialRampToValueAtTime(0.0001, t + STEP_DUR * STEPS_PER_BAR * 0.95);
        o.connect(g); g.connect(musicGain);
        o.start(t); o.stop(t + STEP_DUR * STEPS_PER_BAR);
      });
    }
    // Sparse arpeggio.
    if (ARP_PATTERN[s]) {
      const f = chord.triad[(s + bar) % chord.triad.length] * (s >= 5 ? 2 : 1);
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.10, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g); g.connect(musicGain);
      o.start(t); o.stop(t + 0.25);
    }
    // Soft hat on offbeats.
    if (s % 2 === 1) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const filt = ctx.createBiquadFilter();
      filt.type = 'highpass'; filt.frequency.value = 7000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.03, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      src.connect(filt); filt.connect(g); g.connect(musicGain);
      src.start(t, Math.random() * 0.3, 0.06);
    }
  }

  function musicScheduler() {
    if (!ctx) return;
    while (nextNoteTime < ctx.currentTime + 0.15) {
      const bar = Math.floor(step / STEPS_PER_BAR);
      const s = step % STEPS_PER_BAR;
      if (musicOn) scheduleStep(bar, s, nextNoteTime);
      nextNoteTime += STEP_DUR;
      step++;
    }
  }
  function startMusic() {
    if (!ctx || musicTimer) return;
    nextNoteTime = ctx.currentTime + 0.1;
    step = 0;
    musicTimer = global.setInterval(musicScheduler, 25);
  }

  // ---- settings -------------------------------------------------------------
  function applyMaster() {
    if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : volume, now(), 0.02);
  }
  function applyMusicVol() {
    if (musicGain && ctx) musicGain.gain.setTargetAtTime(musicBase(), now(), 0.02);
  }
  function applySfxVol() {
    if (sfxGain && ctx) sfxGain.gain.setTargetAtTime(SFX_MIX * sfxVol, now(), 0.02);
  }
  function setMuted(m) { muted = !!m; applyMaster(); }
  function isMuted() { return muted; }
  function setVolume(v) { volume = clamp01(v); applyMaster(); }
  function getVolume() { return volume; }
  function setMusicVolume(v) { musicVol = clamp01(v); applyMusicVol(); }
  function getMusicVolume() { return musicVol; }
  function setSfxVolume(v) { sfxVol = clamp01(v); applySfxVol(); }
  function getSfxVolume() { return sfxVol; }
  function setMusicEnabled(on) { musicOn = !!on; }

  // Initialize prefs from store if present.
  try {
    if (global.SplashtoonStore) {
      const a = global.SplashtoonStore.getAudio();
      muted = !!a.muted;
      volume = typeof a.volume === 'number' ? a.volume : volume;
      musicVol = typeof a.musicVol === 'number' ? a.musicVol : musicVol;
      sfxVol = typeof a.sfxVol === 'number' ? a.sfxVol : sfxVol;
    }
  } catch (_) { /* ignore */ }

  // Resume if the tab is backgrounded then refocused.
  global.addEventListener('visibilitychange', () => {
    if (ctx && !document.hidden && ctx.state === 'suspended') ctx.resume();
  });

  global.SplashtoonAudio = {
    unlock, pickup, impact, tick, roundEnd, spawn, powerupSpawn, movement, duck,
    setMuted, isMuted, setVolume, getVolume, setMusicEnabled,
    setMusicVolume, getMusicVolume, setSfxVolume, getSfxVolume,
  };
})(window);
