const SOUNDS = [
  { id: "rain",  name: "Rain",        icon: "🌧️", url: "audio/rain.mp3" },
  { id: "cafe",  name: "Coffee Shop", icon: "☕",  url: "audio/cafe.mp3" },
  { id: "lofi",  name: "Lofi Beats",  icon: "🎧", url: "audio/lofi.mp3" },
  { id: "waves", name: "Waves",       icon: "🌊", url: "audio/waves.mp3" },
  { id: "fire",  name: "Campfire",    icon: "🔥", url: "audio/fire.mp3" },
  { id: "wind",  name: "Wind",        icon: "💨", url: "audio/wind.mp3" },
];

const STORAGE_KEY = "noise_mixer_v2";

let audioCtx = null;
let masterGain = null;

const state = {
  started: false,
  master: 1.0,
  // per track: { level01, playing, muted, solo }
  tracks: Object.fromEntries(SOUNDS.map(s => [s.id, { level01: 0, playing: false, muted: false, solo: false }]))
};

// Map id -> { gain, source, buffer, loading }
const nodes = new Map();

const trackList = document.getElementById("trackList");
const startBtn = document.getElementById("startBtn");
const stopAllBtn = document.getElementById("stopAllBtn");
const resetBtn = document.getElementById("resetBtn");

const masterSlider = document.getElementById("masterSlider");
const masterPct = document.getElementById("masterPct");
const activeList = document.getElementById("activeList");

loadState();
renderTracks();
renderActive();

/* ---------- UI events ---------- */

startBtn.addEventListener("click", async () => {
  await ensureAudioStarted();
});

stopAllBtn.addEventListener("click", () => {
  stopAll();
});

resetBtn.addEventListener("click", () => {
  for (const s of SOUNDS) {
    state.tracks[s.id] = { level01: 0, playing: false, muted: false, solo: false };
  }
  state.master = 1.0;
  saveState();
  stopAll();
  renderTracks();
  applyAllGains();
  renderActive();
});

masterSlider.addEventListener("input", async () => {
  state.master = Number(masterSlider.value) / 100;
  masterPct.textContent = String(Math.round(state.master * 100));
  saveState();
  if (state.started) applyAllGains();
});

document.addEventListener("keydown", async (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    await ensureAudioStarted();
  }
  if (e.code === "Escape") {
    stopAll();
  }
});

/* ---------- Rendering ---------- */

function renderTracks() {
  trackList.innerHTML = "";

  masterSlider.value = String(Math.round(state.master * 100));
  masterPct.textContent = String(Math.round(state.master * 100));

  for (const s of SOUNDS) {
    const t = state.tracks[s.id];

    const row = document.createElement("div");
    row.className = "track";
    row.dataset.id = s.id;

    row.innerHTML = `
      <div class="track-head">
        <div class="badge">${s.icon}</div>
        <div class="name">
          <button class="toggle" title="Toggle play">${s.name}</button>
          <div class="meta">${t.playing ? "Playing" : "Stopped"} • ${t.muted ? "Muted" : "Live"}${t.solo ? " • Solo" : ""}</div>
        </div>
      </div>

      <div class="controls">
        <button class="smallbtn ${t.muted ? "on" : ""}" data-action="mute">${t.muted ? "Muted" : "Mute"}</button>
        <button class="smallbtn ${t.solo ? "on" : ""}" data-action="solo">Solo</button>
      </div>

      <div class="vol">
        <div class="pct" data-pct>${Math.round(t.level01 * 100)}</div>
        <input class="slider" data-action="vol" type="range" min="0" max="100" value="${Math.round(t.level01 * 100)}" />
      </div>
    `;

    trackList.appendChild(row);

    // Toggle play by clicking name (nice UX)
    row.querySelector(".toggle").addEventListener("click", async () => {
      await ensureAudioStarted();
      t.playing = !t.playing;
      if (t.playing && t.level01 === 0) t.level01 = 0.35; // sensible default
      if (t.playing) await ensurePlaying(s.id);
      else stopSound(s.id);

      saveState();
      renderTracks();
      applyAllGains();
      renderActive();
    });

    // Mute / Solo
    row.querySelector('[data-action="mute"]').addEventListener("click", () => {
      t.muted = !t.muted;
      // If you mute, keep playing but set gain to 0
      saveState();
      renderTracks();
      applyAllGains();
      renderActive();
    });

    row.querySelector('[data-action="solo"]').addEventListener("click", () => {
      t.solo = !t.solo;
      saveState();
      renderTracks();
      applyAllGains();
      renderActive();
    });

    // Volume slider
    const vol = row.querySelector('[data-action="vol"]');
    const pctEl = row.querySelector("[data-pct]");

    vol.addEventListener("input", async () => {
      const v = Number(vol.value);
      t.level01 = v / 100;
      pctEl.textContent = String(v);

      // Auto behavior: if user drags above 0, start playing; if 0, stop.
      if (t.level01 > 0) {
        await ensureAudioStarted();
        if (!t.playing) {
          t.playing = true;
          await ensurePlaying(s.id);
          renderTracks(); // update meta
        }
      } else {
        t.playing = false;
        stopSound(s.id);
        renderTracks(); // update meta
      }

      saveState();
      applyAllGains();
      renderActive();
    });
  }
}

function renderActive() {
  const active = SOUNDS.filter(s => {
    const t = state.tracks[s.id];
    return t.playing && t.level01 > 0 && !t.muted;
  }).map(s => s.name);

  activeList.textContent = active.length ? active.join(", ") : "None";
}

/* ---------- Audio ---------- */

async function ensureAudioStarted() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = state.master;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state !== "running") await audioCtx.resume();

  if (!state.started) {
    state.started = true;
    startBtn.textContent = "Audio Ready";
    startBtn.disabled = true;

    // Create gain nodes for each track
    for (const s of SOUNDS) {
      if (!nodes.has(s.id)) {
        const g = audioCtx.createGain();
        g.gain.value = 0;
        g.connect(masterGain);
        nodes.set(s.id, { gain: g, source: null, buffer: null, loading: false });
      }
    }

    // If any track is marked playing, start it
    for (const s of SOUNDS) {
      const t = state.tracks[s.id];
      if (t.playing && t.level01 > 0) await ensurePlaying(s.id);
    }
    applyAllGains();
    renderActive();
  }
}

async function ensurePlaying(id) {
  const node = nodes.get(id);
  if (!node || node.source) return;

  const def = SOUNDS.find(x => x.id === id);
  if (!def) return;

  if (!node.buffer && !node.loading) {
    node.loading = true;
    node.buffer = await loadAudioBuffer(def.url);
    node.loading = false;
  }
  if (!node.buffer) return;

  const src = audioCtx.createBufferSource();
  src.buffer = node.buffer;
  src.loop = true;
  src.connect(node.gain);
  src.start();
  node.source = src;

  src.onended = () => {
    if (node.source === src) node.source = null;
  };
}

function stopSound(id) {
  const node = nodes.get(id);
  if (!node || !node.source) return;
  try { node.source.stop(); } catch {}
  try { node.source.disconnect(); } catch {}
  node.source = null;
}

function stopAll() {
  for (const s of SOUNDS) {
    state.tracks[s.id].playing = false;
    stopSound(s.id);
  }
  saveState();
  renderTracks();
  applyAllGains();
  renderActive();
}

function applyAllGains() {
  if (!state.started) return;

  // Master
  masterGain.gain.setTargetAtTime(state.master, audioCtx.currentTime, 0.02);

  const anySolo = SOUNDS.some(s => state.tracks[s.id].solo);

  for (const s of SOUNDS) {
    const t = state.tracks[s.id];
    const node = nodes.get(s.id);
    if (!node) continue;

    const allowedBySolo = anySolo ? t.solo : true;
    const shouldBeAudible = t.playing && t.level01 > 0 && !t.muted && allowedBySolo;

    const target = shouldBeAudible ? volumeCurve(t.level01) : 0;
    node.gain.gain.setTargetAtTime(target, audioCtx.currentTime, 0.03);
  }
}

// user-friendly curve: linear-ish but slightly refined at low end
function volumeCurve(v01) {
  // more resolution near 0 without “dead” feeling:
  // 0..1 -> 0..1 using a mild power curve
  return Math.pow(v01, 1.25);
}

async function loadAudioBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed: ${url} (${res.status})`);
  const buf = await res.arrayBuffer();
  return await audioCtx.decodeAudioData(buf);
}

/* ---------- Persistence ---------- */

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);

    if (typeof saved.master === "number") state.master = clamp(saved.master, 0, 1);

    if (saved.tracks && typeof saved.tracks === "object") {
      for (const s of SOUNDS) {
        const t = saved.tracks[s.id];
        if (!t) continue;
        state.tracks[s.id] = {
          level01: clamp(Number(t.level01 ?? 0), 0, 1),
          playing: Boolean(t.playing),
          muted: Boolean(t.muted),
          solo: Boolean(t.solo),
        };
      }
    }
  } catch {}
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    master: state.master,
    tracks: state.tracks
  }));
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
