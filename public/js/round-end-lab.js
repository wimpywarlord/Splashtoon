(function attachRoundEndLab(global) {
  'use strict';

  const Audio = global.SplashtoonAudio;
  const reducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const canvas = document.getElementById('confetti-canvas');
  const ctx = canvas.getContext('2d');
  const resultPanel = document.getElementById('result-panel');
  const resultTitle = document.getElementById('result-title');
  const resultKicker = document.getElementById('result-kicker');
  const scoreboard = document.getElementById('scoreboard');
  const countdown = document.getElementById('next-countdown');
  const audioStatus = document.getElementById('audio-status');
  const density = document.getElementById('density');
  const fallSpeed = document.getElementById('fall-speed');
  const winnerConfetti = document.getElementById('winner-confetti');
  const playButton = document.getElementById('play-outcome');
  const confettiOnlyButton = document.getElementById('confetti-only');
  const soundToggle = document.getElementById('sound-toggle');
  const musicToggle = document.getElementById('music-toggle');
  const outcomeButtons = Array.from(document.querySelectorAll('[data-outcome]'));

  const colors = ['#ffe05d', '#16d7c7', '#ff5b51', '#a8ff78', '#f8f6ef', '#4f7dff'];
  const outcomes = {
    winner: {
      title: 'YOU WIN!',
      kicker: 'Round 12',
      audioWin: true,
      rows: [
        { name: 'You', score: 46.8, color: '#ffe05d', you: true },
        { name: 'Vanta', score: 31.4, color: '#16d7c7' },
        { name: 'Magpie', score: 14.9, color: '#ff5b51' },
        { name: 'Zed', score: 6.9, color: '#a8ff78' },
      ],
    },
    loser: {
      title: 'VANTA WINS',
      kicker: 'Round 12',
      audioWin: false,
      rows: [
        { name: 'Vanta', score: 43.1, color: '#16d7c7' },
        { name: 'You', score: 34.7, color: '#ffe05d', you: true },
        { name: 'Magpie', score: 13.8, color: '#ff5b51' },
        { name: 'Zed', score: 8.4, color: '#a8ff78' },
      ],
    },
    tie: {
      title: 'TIE!',
      kicker: 'Round 12',
      audioWin: false,
      rows: [
        { name: 'You', score: 38.6, color: '#ffe05d', you: true },
        { name: 'Vanta', score: 38.6, color: '#16d7c7' },
        { name: 'Magpie', score: 12.7, color: '#ff5b51' },
        { name: 'Zed', score: 10.1, color: '#a8ff78' },
      ],
    },
  };

  let outcome = 'winner';
  let dpr = 1;
  let particles = [];
  let animationId = 0;
  let lastTime = 0;
  let timerId = 0;
  let musicOn = false;
  let audioUnlocked = false;

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[ch]);
  }

  function resizeCanvas() {
    dpr = Math.max(1, Math.min(2, global.devicePixelRatio || 1));
    canvas.width = Math.round(global.innerWidth * dpr);
    canvas.height = Math.round(global.innerHeight * dpr);
    canvas.style.width = `${global.innerWidth}px`;
    canvas.style.height = `${global.innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function updateAudioControls() {
    if (!Audio) {
      audioStatus.textContent = 'No audio API';
      soundToggle.disabled = true;
      musicToggle.disabled = true;
      return;
    }
    const muted = Audio.isMuted();
    soundToggle.textContent = muted ? 'Sound off' : 'Sound on';
    soundToggle.classList.toggle('active', !muted);
    musicToggle.textContent = musicOn ? 'Music on' : 'Music off';
    musicToggle.classList.toggle('active', musicOn);
    audioStatus.textContent = audioUnlocked ? (muted ? 'Audio muted' : 'Audio ready') : 'Audio locked';
  }

  function unlockAudio() {
    if (!Audio) return;
    Audio.unlock();
    Audio.setMusicEnabled(musicOn);
    audioUnlocked = true;
    updateAudioControls();
  }

  function renderScoreboard(rows) {
    const topScore = rows.reduce((best, row) => Math.max(best, row.score), 0);
    scoreboard.innerHTML = rows.map((row) => `
      <div class="score-row${row.you ? ' you' : ''}">
        <span class="swatch" style="background:${row.color}"></span>
        <span class="score-name">${escapeHtml(row.name)}</span>
        <span class="bar" aria-hidden="true" style="--bar-color:${row.color};--pct:${topScore ? Math.max(8, (row.score / topScore) * 100) : 8}%"><span></span></span>
        <span class="score-pct">${row.score.toFixed(1)}%</span>
      </div>
    `).join('');
  }

  function setOutcome(nextOutcome) {
    outcome = nextOutcome;
    const data = outcomes[outcome];
    document.body.dataset.outcome = outcome;
    resultTitle.textContent = data.title;
    resultKicker.textContent = data.kicker;
    renderScoreboard(data.rows);
    outcomeButtons.forEach((button) => {
      const active = button.dataset.outcome === outcome;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function pulsePanel() {
    resultPanel.classList.remove('pulse');
    resultPanel.getBoundingClientRect();
    resultPanel.classList.add('pulse');
  }

  function startCountdown() {
    let left = 10;
    countdown.textContent = String(left);
    clearInterval(timerId);
    timerId = global.setInterval(() => {
      left = Math.max(0, left - 1);
      countdown.textContent = String(left);
      if (left <= 0) clearInterval(timerId);
    }, 1000);
  }

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function makeParticle(x, y, burstPower) {
    const paintDrop = Math.random() < 0.22;
    const size = paintDrop ? rand(7, 16) : rand(6, 14);
    return {
      x,
      y,
      vx: rand(-60, 60),
      vy: rand(100, 310) * burstPower,
      w: paintDrop ? size : rand(7, 18),
      h: paintDrop ? size * rand(0.72, 1.05) : rand(4, 10),
      color: colors[Math.floor(Math.random() * colors.length)],
      rot: rand(0, Math.PI * 2),
      vr: rand(-9, 9),
      life: 0,
      maxLife: rand(4.2, 6.0),
      gravity: rand(330, 520) * (Number(fallSpeed.value) / 112),
      drag: rand(0.982, 0.994),
      paintDrop,
    };
  }

  function burstConfetti(opts) {
    if (reducedMotion) return;
    const count = Math.round(Number(density.value) * (opts && opts.scale ? opts.scale : 1));
    const speedScale = Number(fallSpeed.value) / 112;
    for (let i = 0; i < count; i++) {
      const x = rand(0, global.innerWidth);
      const y = -18 - rand(0, Math.min(180, global.innerHeight * 0.24));
      const p = makeParticle(x, y, rand(0.82, 1.12) * speedScale);
      p.life = -(i / count) * 1.15;
      particles.push(p);
    }
    if (!animationId) {
      lastTime = performance.now();
      animationId = requestAnimationFrame(drawConfetti);
    }
  }

  function drawParticle(p) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - (p.life / p.maxLife));
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    if (p.paintDrop) {
      ctx.beginPath();
      ctx.ellipse(0, 0, p.w * 0.58, p.h * 0.48, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.w * 0.22, -p.h * 0.18, p.w * 0.18, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    }
    ctx.restore();
  }

  function drawConfetti(t) {
    const dt = Math.min(0.033, (t - lastTime) / 1000 || 0.016);
    lastTime = t;
    ctx.clearRect(0, 0, global.innerWidth, global.innerHeight);
    particles = particles.filter((p) => {
      p.life += dt;
      p.vx *= p.drag;
      p.vy = p.vy * p.drag + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      drawParticle(p);
      return p.life < p.maxLife && p.y < global.innerHeight + 80;
    });
    if (particles.length) {
      animationId = requestAnimationFrame(drawConfetti);
    } else {
      animationId = 0;
      ctx.clearRect(0, 0, global.innerWidth, global.innerHeight);
    }
  }

  function playOutcome() {
    unlockAudio();
    const data = outcomes[outcome];
    pulsePanel();
    startCountdown();
    if (Audio) Audio.roundEnd(data.audioWin);
    if (outcome === 'winner' && winnerConfetti.checked) burstConfetti({ scale: 1 });
  }

  outcomeButtons.forEach((button) => {
    button.addEventListener('click', () => setOutcome(button.dataset.outcome));
  });

  playButton.addEventListener('click', playOutcome);

  confettiOnlyButton.addEventListener('click', () => {
    pulsePanel();
    burstConfetti({ scale: 1.1 });
  });

  soundToggle.addEventListener('click', () => {
    unlockAudio();
    Audio.setMuted(!Audio.isMuted());
    if (global.SplashtoonStore) global.SplashtoonStore.setAudio({ muted: Audio.isMuted() });
    updateAudioControls();
  });

  musicToggle.addEventListener('click', () => {
    unlockAudio();
    musicOn = !musicOn;
    Audio.setMusicEnabled(musicOn);
    updateAudioControls();
  });

  global.addEventListener('resize', resizeCanvas);

  if (Audio) Audio.setMusicEnabled(false);
  resizeCanvas();
  setOutcome(outcome);
  updateAudioControls();
})(window);
