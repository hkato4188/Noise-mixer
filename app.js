const SOUNDS = [
  { id: "rain",  name: "Rain",        icon: "🌧️", url: "audio/rain.mp3" },
  { id: "cafe",  name: "Coffee Shop", icon: "☕",  url: "audio/cafe.mp3" },
  { id: "lofi",  name: "Lofi Beats",  icon: "🎧", url: "audio/lofi.mp3" },
  { id: "waves", name: "Waves",       icon: "🌊", url: "audio/waves.mp3" },
  { id: "fire",  name: "Campfire",    icon: "🔥", url: "audio/fire.mp3" },
  { id: "wind",  name: "Wind",        icon: "💨", url: "audio/wind.mp3" },
];

const STORAGE_KEY = "noise_mixer_v2";
const MASTER_PANEL_COLLAPSED_KEY = "noise_mixer_master_panel_collapsed";

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
const side = document.querySelector(".side");
const masterToggleBtn = document.getElementById("masterToggleBtn");

loadState();
renderTracks();
renderActive();
syncStartButton();
initMasterPanelToggle();

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
  stopAll();
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
  const anySolo = hasSoloTracks();

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
        <button class="smallbtn ${t.solo ? "on" : ""}" data-action="solo">${getSoloButtonLabel(t, anySolo)}</button>
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
      else {
        stopSound(s.id);
        if (t.solo) t.solo = false;
      }

      saveState();
      syncUiAndAudio();
    });

    // Mute / Solo
    row.querySelector('[data-action="mute"]').addEventListener("click", () => {
      t.muted = !t.muted;
      // Muting a soloed track removes it from the solo set.
      if (t.muted && t.solo) t.solo = false;
      // If you mute, keep playing but set gain to 0
      saveState();
      syncUiAndAudio();
    });

    row.querySelector('[data-action="solo"]').addEventListener("click", async () => {
      const hadAnySolo = hasSoloTracks();

      if (!hadAnySolo) {
        // Enter solo mode by isolating one track.
        clearSoloFlags();
        t.solo = true;
      } else if (t.solo) {
        // Clicking an already-soloed track removes it.
        // If it was the last one, this exits solo mode.
        t.solo = false;
      } else {
        // Solo mode is active: add this track to the layered solo set.
        t.solo = true;
      }

      // Solo intent means "make this track audible now".
      if (t.solo) {
        if (t.muted) t.muted = false;
        if (t.level01 === 0) t.level01 = 0.35;
        await ensureAudioStarted();
        t.playing = true;
        await ensurePlaying(s.id);
      }

      saveState();
      syncUiAndAudio();
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
        if (t.solo) t.solo = false;
        renderTracks(); // update meta
      }

      saveState();
      applyAllGains();
      renderActive();
    });
  }
}

function renderActive() {
  const anySolo = hasSoloTracks();
  const active = SOUNDS.filter(s => {
    const t = state.tracks[s.id];
    const allowedBySolo = anySolo ? t.solo : true;
    return t.playing && t.level01 > 0 && !t.muted && allowedBySolo;
  }).map(s => s.name);

  activeList.textContent = active.length ? active.join(", ") : "None";
}

/* ---------- Audio ---------- */

function syncStartButton() {
  startBtn.textContent = state.started ? "Audio Ready" : "Start Audio";
  startBtn.disabled = state.started;
}

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
    syncStartButton();

    // Create gain nodes for each track
    for (const s of SOUNDS) {
      if (!nodes.has(s.id)) {
        const g = audioCtx.createGain();
        g.gain.value = 0;
        g.connect(masterGain);
        nodes.set(s.id, { gain: g, source: null, buffer: null, loading: false });
      }
    }

    // Auto-start tracks based on selected slider levels.
    // If volume is above 0, mark the track as playing and start its source.
    for (const s of SOUNDS) {
      const t = state.tracks[s.id];
      if (t.level01 > 0) {
        t.playing = true;
        await ensurePlaying(s.id);
      }
    }
    saveState();
    syncUiAndAudio();
  }
}

async function ensurePlaying(id) {
  const node = nodes.get(id);
  if (!node || node.source) return;

  const def = SOUNDS.find(x => x.id === id);
  if (!def) return;

  if (!node.buffer && !node.loading) {
    node.loading = true;
    try {
      node.buffer = await loadAudioBuffer(def.url);
    } catch (err) {
      console.error(`Unable to load audio for "${id}"`, err);
    } finally {
      node.loading = false;
    }
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
  clearSoloFlags();
  state.started = false;
  syncStartButton();
  saveState();
  syncUiAndAudio();
}

function applyAllGains() {
  if (!state.started) return;

  // Master
  masterGain.gain.setTargetAtTime(state.master, audioCtx.currentTime, 0.02);

  const anySolo = hasSoloTracks();

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

function hasSoloTracks() {
  return SOUNDS.some(s => state.tracks[s.id].solo);
}

function clearSoloFlags() {
  for (const s of SOUNDS) state.tracks[s.id].solo = false;
}

function getSoloButtonLabel(track, anySolo) {
  if (track.solo) return "Remove Layer";
  return anySolo ? "Add Layer" : "Solo";
}

function syncUiAndAudio() {
  renderTracks();
  applyAllGains();
  renderActive();
}

function initMasterPanelToggle() {
  if (!side || !masterToggleBtn) return;

  const collapsed = localStorage.getItem(MASTER_PANEL_COLLAPSED_KEY) === "1";
  setMasterPanelCollapsed(collapsed);

  masterToggleBtn.addEventListener("click", () => {
    const isCollapsed = side.classList.contains("collapsed");
    setMasterPanelCollapsed(!isCollapsed);
  });
}

function setMasterPanelCollapsed(collapsed) {
  if (!side || !masterToggleBtn) return;

  side.classList.toggle("collapsed", collapsed);
  masterToggleBtn.textContent = collapsed ? "Expand" : "Collapse";
  masterToggleBtn.setAttribute("aria-expanded", String(!collapsed));
  localStorage.setItem(MASTER_PANEL_COLLAPSED_KEY, collapsed ? "1" : "0");
}
