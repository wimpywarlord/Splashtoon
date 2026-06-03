(function attachStore(global) {
  'use strict';

  // Client-only persistence. No server / DB: the player's name, personal-best
  // stats, and audio prefs live entirely in localStorage. All access is guarded
  // so private-mode / disabled storage degrades to in-memory defaults.
  const NS = 'splashtoon';
  const KEY_NAME = NS + '.name';
  const KEY_STATS = NS + '.stats';
  const KEY_AUDIO = NS + '.audio';

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* ignore */ }
  }

  const DEFAULT_STATS = { bestCoverage: 0, wins: 0, matches: 0, winStreak: 0, bestStreak: 0 };
  const DEFAULT_AUDIO = { muted: false, volume: 0.7, musicVol: 1, sfxVol: 1 };

  function getName() {
    try { return localStorage.getItem(KEY_NAME) || ''; } catch (_) { return ''; }
  }
  function setName(n) {
    try { localStorage.setItem(KEY_NAME, String(n || '').slice(0, 16)); } catch (_) { /* ignore */ }
  }

  function getStats() {
    return Object.assign({}, DEFAULT_STATS, readJSON(KEY_STATS, {}));
  }
  // coveragePct: this player's final % this round; won: did they win.
  function recordResult(coveragePct, won) {
    const s = getStats();
    s.matches += 1;
    if (Number.isFinite(coveragePct) && coveragePct > s.bestCoverage) s.bestCoverage = coveragePct;
    if (won) {
      s.wins += 1;
      s.winStreak += 1;
      if (s.winStreak > s.bestStreak) s.bestStreak = s.winStreak;
    } else {
      s.winStreak = 0;
    }
    writeJSON(KEY_STATS, s);
    return s;
  }

  function getAudio() {
    return Object.assign({}, DEFAULT_AUDIO, readJSON(KEY_AUDIO, {}));
  }
  function setAudio(patch) {
    writeJSON(KEY_AUDIO, Object.assign(getAudio(), patch));
  }

  global.SplashtoonStore = { getName, setName, getStats, recordResult, getAudio, setAudio };
})(window);
