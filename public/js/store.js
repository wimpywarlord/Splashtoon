(function attachStore(global) {
  'use strict';

  // Client-only persistence. No server / DB: the player's name, personal-best
  // stats, and audio prefs live entirely in localStorage. All access is guarded
  // so private-mode / disabled storage degrades to in-memory defaults.
  const NS = 'splashtoon';
  const KEY_NAME = NS + '.name';
  const KEY_STATS = NS + '.stats';
  const KEY_AUDIO = NS + '.audio';
  const KEY_SIM = NS + '.sim';
  const KEY_PREFS = NS + '.prefs';
  const KEY_SKIN = NS + '.skin';

  // Cosmetic brush skin ids. Kept in lockstep with SKINS in client.js (and the
  // server's allowlist); duplicated here so the standalone store can validate a
  // persisted value without importing the registry.
  const SKIN_IDS = ['default', 'unicorn', 'hela'];
  const DEFAULT_SKIN = 'default';

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

  const DEFAULT_STATS = { bestCoverage: 0, wins: 0, matches: 0, winStreak: 0, bestStreak: 0, lastResultId: '' };
  const DEFAULT_AUDIO = { muted: false, volume: 0.7, musicVol: 1, sfxVol: 1, brushVol: 1, countdown: true };
  const DEFAULT_SIM = { players: 6 };   // landing tutorial-sim player count (you + bots), 2..6
  const DEFAULT_PREFS = { chat: true }; // misc UI prefs (chat panel on/off via settings)

  function finiteNumber(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  function wholeNumber(v) {
    return Math.max(0, Math.floor(finiteNumber(v, 0)));
  }
  function normalizeStats(raw) {
    const s = Object.assign({}, DEFAULT_STATS, raw || {});
    s.bestCoverage = Math.max(0, Math.min(100, finiteNumber(s.bestCoverage, 0)));
    s.wins = wholeNumber(s.wins);
    s.matches = wholeNumber(s.matches);
    s.winStreak = wholeNumber(s.winStreak);
    s.bestStreak = Math.max(wholeNumber(s.bestStreak), s.winStreak);
    s.lastResultId = String(s.lastResultId || '');
    return s;
  }

  function getName() {
    try { return localStorage.getItem(KEY_NAME) || ''; } catch (_) { return ''; }
  }
  function setName(n) {
    try { localStorage.setItem(KEY_NAME, String(n || '').slice(0, 16)); } catch (_) { /* ignore */ }
  }

  function getStats() {
    return normalizeStats(readJSON(KEY_STATS, {}));
  }
  // coveragePct: this player's final % this round; won: did they win.
  function recordResult(coveragePct, won, resultId) {
    const s = getStats();
    const id = resultId ? String(resultId) : '';
    if (id && s.lastResultId === id) return s;
    s.matches += 1;
    const pct = Math.max(0, Math.min(100, finiteNumber(coveragePct, 0)));
    if (pct > s.bestCoverage) s.bestCoverage = pct;
    if (won) {
      s.wins += 1;
      s.winStreak += 1;
      if (s.winStreak > s.bestStreak) s.bestStreak = s.winStreak;
    } else {
      s.winStreak = 0;
    }
    s.lastResultId = id;
    writeJSON(KEY_STATS, s);
    return s;
  }

  function getAudio() {
    return Object.assign({}, DEFAULT_AUDIO, readJSON(KEY_AUDIO, {}));
  }
  function setAudio(patch) {
    writeJSON(KEY_AUDIO, Object.assign(getAudio(), patch));
  }

  function getSim() {
    return Object.assign({}, DEFAULT_SIM, readJSON(KEY_SIM, {}));
  }
  function setSim(patch) {
    writeJSON(KEY_SIM, Object.assign(getSim(), patch));
  }

  function getPrefs() {
    return Object.assign({}, DEFAULT_PREFS, readJSON(KEY_PREFS, {}));
  }
  function setPrefs(patch) {
    writeJSON(KEY_PREFS, Object.assign(getPrefs(), patch));
  }

  function getSkin() {
    try {
      const v = localStorage.getItem(KEY_SKIN);
      return SKIN_IDS.includes(v) ? v : DEFAULT_SKIN;
    } catch (_) { return DEFAULT_SKIN; }
  }
  function setSkin(id) {
    const v = SKIN_IDS.includes(id) ? id : DEFAULT_SKIN;
    try { localStorage.setItem(KEY_SKIN, v); } catch (_) { /* ignore */ }
    return v;
  }

  global.SplashtoonStore = { getName, setName, getStats, recordResult, getAudio, setAudio, getSim, setSim, getPrefs, setPrefs, getSkin, setSkin };
})(window);
