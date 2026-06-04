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
  let musicPump = null;   // sidechain "pump" bus -- ducks on every kick
  let musicComp = null;   // glue/limiter across the (now dense) music bed
  let sfxGain = null;
  let brushGain = null;   // own bus so the movement loop has its own setting
  let noiseBuf = null;

  let muted = false;
  let volume = 0.7;     // master (0..1)
  let musicOn = true;
  let musicVol = 0.75;  // music category level (0..1), scales MUSIC_MIX -- default a notch under full
  let sfxVol = 1;       // SFX category level (0..1), scales SFX_MIX
  let brushVol = 1;     // brush whoosh level (0..1), scales BRUSH_MIX

  // Per-category mix levels. The user's category volume (0..1) multiplies these,
  // so a category at 1.0 sounds exactly as it did before category controls.
  const MUSIC_MIX = 0.30;   // dense driving bed; a touch under the old calm pad
  const SFX_MIX = 0.9;
  const BRUSH_MIX = 0.9;  // matches SFX_MIX so the default whoosh level is unchanged

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

    // Music bus: musicPump (sidechain) -> musicGain (category vol + duck) ->
    // musicComp (glue/limiter) -> master. The kick taps musicGain directly so it
    // punches through the pump; everything else rides musicPump.
    musicComp = ctx.createDynamicsCompressor();
    musicComp.threshold.value = -18;
    musicComp.knee.value = 10;
    musicComp.ratio.value = 4;
    musicComp.attack.value = 0.003;
    musicComp.release.value = 0.18;
    musicComp.connect(master);

    musicGain = ctx.createGain();
    musicGain.gain.value = MUSIC_MIX * musicVol;
    musicGain.connect(musicComp);

    musicPump = ctx.createGain();
    musicPump.gain.value = 1;
    musicPump.connect(musicGain);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = SFX_MIX * sfxVol;
    sfxGain.connect(master);

    brushGain = ctx.createGain();
    brushGain.gain.value = BRUSH_MIX * brushVol;
    brushGain.connect(master);

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

  // Briefly duck the music (sidechain) so the effect cuts through -- called by EVERY game
  // sound, so the Tron bed always sits under the SFX instead of fighting them.
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
    duck(0.55, 0.3);          // every pickup ducks the bed so the cue reads clearly
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
    } else if (type === 'tiny') {
      tone({ type: 'triangle', f0: 1300, f1: 940, dur: 0.08, gain: 0.16 });
      tone({ type: 'triangle', f0: 980, f1: 720, dur: 0.08, gain: 0.12, delay: 0.07 });
      tone({ type: 'triangle', f0: 720, f1: 520, dur: 0.1, gain: 0.09, delay: 0.14 });
    } else if (type === 'mortar') {
      // "Mortar": incoming bombardment -- a falling whistle into a low thud.
      tone({ type: 'sawtooth', f0: 1300, f1: 240, dur: 0.30, gain: 0.16 });
      tone({ type: 'sine', f0: 150, f1: 60, dur: 0.26, gain: 0.20, delay: 0.18 });
      noise({ filter: 'lowpass', freq: 520, dur: 0.20, gain: 0.12, at: t0 + 0.18 });
    } else if (type === 'snap') {
      // The finger-snap transient; the board boom rides on snap() (the wipe event).
      noise({ filter: 'highpass', freq: 3600, dur: 0.04, gain: 0.30, at: t0 });
      tone({ type: 'square', f0: 1200, f1: 320, dur: 0.05, gain: 0.12 });
    } else {
      tone({ type: 'triangle', f0: 600, f1: 900, dur: 0.14, gain: 0.28 });
    }
  }

  function impact() {
    if (!ctx || !claimVoice(0.4)) return;
    tone({ type: 'sine', f0: 180, f1: 42, dur: 0.28, gain: 0.5 });
    noise({ filter: 'lowpass', freq: 900, q: 1, dur: 0.2, gain: 0.4 });
    duck(0.7, 0.35);
  }

  // "Snap" half-wipe: a finger-snap crack into a white-noise sweep and a deep boom --
  // the sound of half the board flashing white and vanishing. Music ducks under it.
  function snap() {
    if (!ctx || !claimVoice(0.9)) return;
    const t0 = now();
    noise({ filter: 'highpass', freq: 4200, dur: 0.05, gain: 0.30, at: t0 });          // snap crack
    noise({ filter: 'bandpass', freq: 1400, q: 0.5, dur: 0.18, gain: 0.30, at: t0 });   // white sweep
    tone({ type: 'sine', f0: 150, f1: 40, dur: 0.36, gain: 0.42 });                     // boom
    noise({ filter: 'lowpass', freq: 200, dur: 0.5, gain: 0.24, at: t0 + 0.03 });       // rumble
    duck(0.7, 0.4);
  }

  // secondsLeft: 10..1 rising ticks; a brighter beep at 0.
  function tick(secondsLeft) {
    if (!ctx || !claimVoice(0.2)) return;
    duck(0.4, 0.16);
    if (secondsLeft <= 0) {
      tone({ type: 'square', f0: 880, dur: 0.34, gain: 0.3 });
      return;
    }
    const f = 440 + (10 - Math.min(10, secondsLeft)) * 55;
    tone({ type: 'square', f0: f, dur: 0.09, gain: 0.22 });
  }

  function roundEnd(win) {
    if (!ctx) return;
    duck(0.7, 1.2);
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
    duck(0.45, 0.24);
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
    duck(0.6, 0.55);
  }

  // ---- pre-round countdown (synthesized 3-2-1-GO) ---------------------------
  // Scheduled on the audio clock from round start: a rising beep per second for
  // 3 / 2 / 1, then a brighter fanfare at GO -- so it lines up with the on-screen
  // numbers (server countdown = 3s) with zero drift, no asset to load. Always
  // on (the old toggle is gone); Master at 0 is the mute.
  function countdown() {
    if (!ctx || muted) return;
    const t0 = now();
    duck(0.45, 3.4);          // hold the bed under the whole 3-2-1, swelling back by GO
    const beep = (at, f) => {
      tone({ type: 'square',   f0: f,     dur: 0.15, gain: 0.26, at, attack: 0.004 });
      tone({ type: 'triangle', f0: f / 2, dur: 0.16, gain: 0.12, at });            // body
    };
    beep(t0 + 0, 620);   // "3"
    beep(t0 + 1, 700);   // "2"
    beep(t0 + 2, 820);   // "1"
    const g = t0 + 3;    // "GO!" -- right as the field unfreezes
    tone({ type: 'triangle', f0: 760, f1: 1240, dur: 0.5,  gain: 0.34, at: g, attack: 0.005 });
    tone({ type: 'sine',     f0: 1240,          dur: 0.45, gain: 0.16, at: g + 0.02 });
    tone({ type: 'square',   f0: 380, f1: 620,  dur: 0.45, gain: 0.12, at: g });
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
    whooshGain.connect(brushGain);
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
  // Tron-style driving electro: four-on-the-floor kick, a resonant 16th-note saw
  // bassline (the "Derezzed" acid engine), a sidechain pump so the whole bed
  // breathes under the kick, crisp hats + backbeat clap, and supersaw lead stabs
  // that swell in over an 8-bar build. Same A-minor roots (i-VI-III-VII) as the
  // SFX so stings stay in key. The kick taps musicGain directly; everything else
  // rides musicPump.
  const PROG = [
    { root: 110.00, notes: [110.00, 130.81, 164.81, 220.00, 261.63, 329.63] }, // Am
    { root: 87.31,  notes: [87.31,  110.00, 130.81, 174.61, 220.00, 261.63] }, // F
    { root: 130.81, notes: [130.81, 164.81, 196.00, 261.63, 329.63, 392.00] }, // C
    { root: 98.00,  notes: [98.00,  123.47, 146.83, 196.00, 246.94, 293.66] }, // G
  ];
  const STEPS_PER_BAR = 16;     // 16th-note grid
  const STEP_DUR = 0.1125;      // ~133 BPM
  const BEAT = STEP_DUR * 4;
  const SUPER_BARS = 8;         // 8-bar build (lead + filter swell, then reset)
  // notes[] index per 16th: mostly root (0) with octave pops (3), melodic turn on beat 4.
  const BASS_IDX = [0, 0, 3, 0, 0, 0, 3, 0, 0, 3, 0, 3, 1, 3, 2, 3];
  const LEAD_PAT = [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0];

  // Punchy kick: pitched sine drop + a noise click. Straight to musicGain so it
  // punches through the pump that ducks everything else.
  function mKick(t) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.10);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.62, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.20);
    o.connect(g); g.connect(musicGain);
    o.start(t); o.stop(t + 0.22);
    const c = ctx.createBufferSource();
    c.buffer = noiseBuf;
    const cf = ctx.createBiquadFilter();
    cf.type = 'highpass'; cf.frequency.value = 1600;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.35, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
    c.connect(cf); cf.connect(cg); cg.connect(musicGain);
    c.start(t, Math.random() * 0.3, 0.03);
  }

  // Sub floor, one per beat, an octave under the bass root. Pumps under the kick.
  function mSub(t, f) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = f / 2;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + BEAT * 0.9);
    o.connect(g); g.connect(musicPump);
    o.start(t); o.stop(t + BEAT);
  }

  // The engine: two detuned saws through a resonant lowpass with a quick filter
  // envelope -- the acid/Derezzed pluck. cut rises with the 8-bar build.
  function mBass(t, f, accent, cut) {
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.Q.value = 7;
    filt.frequency.setValueAtTime(Math.min(cut * 2.4, 6500), t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(cut, 120), t + 0.09);
    const g = ctx.createGain();
    const peak = accent ? 0.20 : 0.13;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + STEP_DUR * 0.95);
    filt.connect(g); g.connect(musicPump);
    [0, 9].forEach((det) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      o.connect(filt); o.start(t); o.stop(t + STEP_DUR);
    });
  }

  // Hat: short closed / longer open, bright noise. Pumps so it shuffles under the kick.
  function mHat(t, open, gain) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 8000;
    const g = ctx.createGain();
    const dur = open ? 0.10 : 0.035;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hp); hp.connect(g); g.connect(musicPump);
    src.start(t, Math.random() * 0.4, dur + 0.02);
  }

  // Clap on the backbeat: three quick bandpassed noise bursts with a tail.
  function mClap(t) {
    for (let i = 0; i < 3; i++) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
      const g = ctx.createGain();
      const tt = t + i * 0.008;
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(0.20, tt + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + (i === 2 ? 0.12 : 0.03));
      src.connect(bp); bp.connect(g); g.connect(musicPump);
      src.start(tt, Math.random() * 0.3, 0.14);
    }
  }

  // Supersaw lead stab: detuned saws with a snappy filter "wah". Enters in the
  // back half of the build for lift.
  function mLead(t, freqs) {
    const lf = ctx.createBiquadFilter();
    lf.type = 'lowpass'; lf.Q.value = 0.8;
    lf.frequency.setValueAtTime(1200, t);
    lf.frequency.exponentialRampToValueAtTime(3600, t + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.085, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    lf.connect(g); g.connect(musicPump);
    freqs.forEach((f) => [-8, 8].forEach((det) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      o.connect(lf); o.start(t); o.stop(t + 0.20);
    }));
  }

  // Dark detuned-saw pad holding the chord across the bar. Low and breathing.
  function mPad(t, freqs, cut) {
    const lf = ctx.createBiquadFilter();
    lf.type = 'lowpass'; lf.frequency.value = cut; lf.Q.value = 0.5;
    const g = ctx.createGain();
    const dur = BEAT * 4;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.045, t + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.98);
    lf.connect(g); g.connect(musicPump);
    freqs.forEach((f) => [-6, 6].forEach((det) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      o.connect(lf); o.start(t); o.stop(t + dur);
    }));
  }

  // Rising filtered-noise sweep into the top of the 8-bar loop.
  function mRiser(t, dur) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.exponentialRampToValueAtTime(7000, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + dur * 0.9);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp); bp.connect(g); g.connect(musicPump);
    src.start(t); src.stop(t + dur + 0.05);
  }

  function scheduleStep(bar, s, t) {
    const chord = PROG[bar % PROG.length];
    const superBar = bar % SUPER_BARS;
    const build = (superBar * STEPS_PER_BAR + s) / (SUPER_BARS * STEPS_PER_BAR); // 0..1
    const onBeat = (s % 4 === 0);

    // Sidechain pump: duck the bed on every beat, swell back before the next.
    if (onBeat && musicPump) {
      musicPump.gain.cancelScheduledValues(t);
      musicPump.gain.setValueAtTime(0.30, t);
      musicPump.gain.linearRampToValueAtTime(1.0, t + BEAT * 0.85);
    }

    if (onBeat) { mKick(t); mSub(t, chord.root); }
    if (s === 0) mPad(t, [chord.notes[2], chord.notes[3], chord.notes[4]], 900 + build * 1800);
    if (s === 4 || s === 12) mClap(t);

    // Hats: open on the offbeat eighths, closed fills elsewhere -> 16th drive.
    if (s === 2 || s === 6 || s === 10 || s === 14) mHat(t, true, 0.06);
    else if (s % 2 === 0) mHat(t, false, 0.045);
    if (s % 2 === 1) mHat(t, false, 0.022);

    // Bassline engine on every 16th.
    mBass(t, chord.notes[BASS_IDX[s]], onBeat, 320 + build * 700);

    // Lead stabs enter in the back half of the build.
    if (superBar >= 4 && LEAD_PAT[s]) {
      mLead(t, [chord.notes[3] * 2, chord.notes[4] * 2, chord.notes[5] * 2]);
    }

    // Riser into the next loop top.
    if (superBar === SUPER_BARS - 1 && s === 0) mRiser(t, BEAT * 4);
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
  function applyBrushVol() {
    if (brushGain && ctx) brushGain.gain.setTargetAtTime(BRUSH_MIX * brushVol, now(), 0.02);
  }
  function setMuted(m) { muted = !!m; applyMaster(); }
  function isMuted() { return muted; }
  function setVolume(v) { volume = clamp01(v); applyMaster(); }
  function getVolume() { return volume; }
  function setMusicVolume(v) { musicVol = clamp01(v); applyMusicVol(); }
  function getMusicVolume() { return musicVol; }
  function setSfxVolume(v) { sfxVol = clamp01(v); applySfxVol(); }
  function getSfxVolume() { return sfxVol; }
  function setBrushVolume(v) { brushVol = clamp01(v); applyBrushVol(); }
  function getBrushVolume() { return brushVol; }
  function setMusicEnabled(on) { musicOn = !!on; }

  // Initialize prefs from store if present.
  try {
    if (global.SplashtoonStore) {
      const a = global.SplashtoonStore.getAudio();
      // Stored `muted` and the legacy `countdown` toggle are intentionally
      // ignored: both controls are gone (Master at 0 is the mute; the 3-2-1
      // always plays), so a stored "off" must not strand the user with no
      // control to undo it.
      volume = typeof a.volume === 'number' ? a.volume : volume;
      musicVol = typeof a.musicVol === 'number' ? a.musicVol : musicVol;
      sfxVol = typeof a.sfxVol === 'number' ? a.sfxVol : sfxVol;
      brushVol = typeof a.brushVol === 'number' ? a.brushVol : brushVol;
    }
  } catch (_) { /* ignore */ }

  // Resume if the tab is backgrounded then refocused.
  global.addEventListener('visibilitychange', () => {
    if (ctx && !document.hidden && ctx.state === 'suspended') ctx.resume();
  });

  global.SplashtoonAudio = {
    unlock, pickup, impact, snap, tick, roundEnd, spawn, powerupSpawn, movement, duck,
    countdown,
    setMuted, isMuted, setVolume, getVolume, setMusicEnabled,
    setMusicVolume, getMusicVolume, setSfxVolume, getSfxVolume,
    setBrushVolume, getBrushVolume,
  };
})(window);
