// zone-music.js — BGM preview player + zone music slot assignment
// Extracted from main.js. Import and call initZoneMusic() to wire up.

import { bridgeOnline, onBridgeStatus, bridgeCall } from '../ffxi/bridge.js';
import { decodeBgmWithExportFallback } from '../ffxi/audio-helper.js';
import { loadSetting, saveSetting } from '../editor/settings.js';

// ── Injected globals (set via initZoneMusic) ──────────────────────────────
let _getZoneUrl = () => '';
let _currentZoneId = () => null;
let _setStatus = () => {};
let _xi_alert = async () => {};
let _showErrorBanner = () => {};
let _updateChangesUI = () => {};

export function initZoneMusic({ getZoneUrl, currentZoneId, setStatus, xi_alert, showErrorBanner, updateChangesUI }) {
  _getZoneUrl = getZoneUrl;
  _currentZoneId = currentZoneId;
  _setStatus = setStatus;
  _xi_alert = xi_alert;
  _showErrorBanner = showErrorBanner;
  _updateChangesUI = updateChangesUI;
  // Refresh once the bridge comes online (a zone may have auto-loaded while connecting).
  onBridgeStatus((online) => { if (online) ensureZoneMusic(); });
}

// ── BGM player state ──────────────────────────────────────────────────────
let _bgmAudio = null;        // reused HTMLAudioElement (loops)
let _bgmObjUrl = null;       // current blob URL (revoked on unload)
let _bgmLoadedId = null;     // musicId whose WAV is loaded into _bgmAudio (null = none)
let _bgmLoadingId = null;    // musicId currently decoding
let _bgmReq = 0;             // monotonic token — invalidates a superseded decode
let _bgmDur = 0;             // current track duration (s), from decode header then metadata
let _bgmSeeking = false;     // user is dragging the scrubber — don't fight it from timeupdate
let _bgmNowText = '';        // "ADPCM · 44.1kHz · stereo"
let _bgmZone = null;         // zone key playback belongs to (unload on zone change)
let _zoneBgm = null;         // { zoneKey, ok, error, zoneId, zoneName, slots }
let _zoneBgmFetching = null; // zone key with a fetch in flight
let _zoneBgmRenderedKey = null;  // signature of what's in the DOM (skip needless rebuilds)
let _bgmNowTitle = '';       // title of the loaded track (player bar)
let _bgmNowLabel = '';       // which slot triggered playback (Day/Night/…)
let _bgmVolume = Math.max(0, Math.min(1, loadSetting('bgmVolume', 1)));   // 0..1, persisted
let _bgmMuted = false;
export let musicBaseline = {};      // current DB ids per slot (day/night/battlesolo/battlemulti)
export let musicChanges = {};       // slot -> new id (differs from baseline) — pending change-set
export const _MUSIC_SLOT_NAME = { day: 'music_day', night: 'music_night', battlesolo: 'music_battle_solo', battlemulti: 'music_battle_party' };

export const bgmFmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};
export function getBgmAudio() { return _bgmAudio; }

// ── Zone music assignment constants ──────────────────────────────────────
const _ZONE_MUSIC_SLOTS = [['day', 'Day'], ['night', 'Night'],
  ['battlesolo', 'Battle (solo)'], ['battlemulti', 'Battle (party)']];
let _allMusicCache = null;

// ── Functions ─────────────────────────────────────────────────────────────

function renderBgmMessage(msg, sig) {
  const el = document.getElementById('zone-music');
  if (!el) return;
  if (_zoneBgmRenderedKey === sig) return;
  _zoneBgmRenderedKey = sig;
  el.innerHTML = `<div class="bgm-msg"></div>`;
  el.querySelector('.bgm-msg').textContent = msg;
}

// Called from updateZoneInfo: fetch once per zone, render cheaply, unload on zone change.
export function ensureZoneMusic() {
  const el = document.getElementById('zone-music');
  if (!el) return;
  const key = _getZoneUrl() || '';
  if (key !== _bgmZone) { _bgmZone = key; unloadBgm(); musicChanges = {}; musicBaseline = {}; }   // new zone → tear down prior preview + pending music edits
  if (!key) { el.innerHTML = ''; _zoneBgm = null; _zoneBgmRenderedKey = null; return; }
  if (!bridgeOnline()) { renderBgmMessage('Needs the backend — run via `xi gui zone`.', 'offline:' + key); return; }
  if ((!_zoneBgm || _zoneBgm.zoneKey !== key) && _zoneBgmFetching !== key) fetchZoneBgm(key);
  renderZoneMusic();
}

async function fetchZoneBgm(key) {
  _zoneBgmFetching = key;
  renderBgmMessage('Loading…', 'loading:' + key);
  let data;
  try {
    const r = await bridgeCall('zone.bgm', { zone: key, zoneId: _currentZoneId() });
    data = { zoneKey: key, ...r };
  } catch (e) {
    data = { zoneKey: key, ok: false, error: e?.message || String(e) };
  }
  if (_zoneBgmFetching === key) _zoneBgmFetching = null;
  _zoneBgm = data;
  if ((_getZoneUrl() || '') === key) renderZoneMusic();
}

export async function renderZoneMusic() {
  const el = document.getElementById('zone-music');
  if (!el) return;
  const key = _getZoneUrl() || '';
  if (!key) return;
  const data = (_zoneBgm && _zoneBgm.zoneKey === key) ? _zoneBgm : null;
  if (!data) { renderBgmMessage('Loading…', 'loading:' + key); return; }
  if (!data.ok) { renderBgmMessage(data.error || 'No music info.', 'err:' + key + ':' + (data.error || '')); return; }
  const slots = data.slots || [];
  musicBaseline = {};
  for (const s of slots) musicBaseline[s.key] = s.id || 0;
  const sig = 'music2:' + key + ':' + slots.map((s) => `${s.key}=${s.id}`).join(',') + ':' + JSON.stringify(musicChanges);
  if (sig === _zoneBgmRenderedKey) { updateBgmUI(); return; }   // structurally unchanged
  _zoneBgmRenderedKey = sig;
  el.innerHTML =
    `<div class="bgm-player">`
    +   `<div class="bgm-now-title" id="zone-bgm-title">Nothing playing</div>`
    +   `<div class="bgm-controls">`
    +     `<button class="bgm-btn" id="zone-bgm-play" title="Play">▶</button>`
    +     `<button class="bgm-btn" id="zone-bgm-pause" title="Pause">⏸</button>`
    +     `<button class="bgm-btn" id="zone-bgm-stop" title="Stop">⏹</button>`
    +     `<span class="bgm-vol-ico" id="zone-bgm-vol-ico" title="Mute / unmute">🔊</span>`
    +     `<input class="bgm-vol" id="zone-bgm-vol" type="range" min="0" max="100" step="1" title="Volume" />`
    +     `<span class="bgm-time" id="zone-bgm-time">0:00 / 0:00</span>`
    +   `</div>`
    +   `<input class="bgm-seek" id="zone-bgm-seek" type="range" min="0" max="1000" step="1" value="0" />`
    +   `<div class="bgm-now" id="zone-bgm-now"></div>`
    + `</div>`
    + `<div class="bgm-slots" id="zone-bgm-slots"></div>`;
  el.querySelector('#zone-bgm-play')?.addEventListener('click', bgmPlayResume);
  el.querySelector('#zone-bgm-pause')?.addEventListener('click', bgmPause);
  el.querySelector('#zone-bgm-stop')?.addEventListener('click', bgmStop);
  const seek = el.querySelector('#zone-bgm-seek');
  if (seek) {
    const seekTo = () => { if (_bgmAudio && _bgmDur) { _bgmAudio.currentTime = (seek.value / 1000) * _bgmDur; updateBgmProgress(); } };
    seek.addEventListener('pointerdown', () => { _bgmSeeking = true; });
    seek.addEventListener('input', () => { _bgmSeeking = true; seekTo(); });
    seek.addEventListener('change', () => { seekTo(); _bgmSeeking = false; });
    seek.addEventListener('pointerup', () => { _bgmSeeking = false; });
  }
  const vol = el.querySelector('#zone-bgm-vol');
  if (vol) {
    vol.value = String(Math.round(_bgmVolume * 100));
    vol.oninput = () => { _bgmVolume = (parseInt(vol.value, 10) || 0) / 100; _bgmMuted = false; applyBgmVolume(); saveSetting('bgmVolume', _bgmVolume); };
  }
  el.querySelector('#zone-bgm-vol-ico')?.addEventListener('click', () => { _bgmMuted = !_bgmMuted; applyBgmVolume(); });
  updateBgmVolIcon();
  // Slot rows: a label on its own line, then a dropdown of EVERY game song + a play button.
  const slotsEl = el.querySelector('#zone-bgm-slots');
  let tracks = [];
  try { tracks = await loadAllMusic(); } catch { /* no catalog — rows still render with current id */ }
  for (const [slot, slabel] of _ZONE_MUSIC_SLOTS) {
    const row = document.createElement('div'); row.className = 'bgm-slot-row';
    const lab = document.createElement('span'); lab.className = 'bgm-slot-label'; lab.textContent = slabel;
    const sel = document.createElement('select'); sel.className = 'bgm-slot-select'; sel.dataset.slot = slot;
    sel.add(new Option('None (silent)', '0'));
    for (const t of tracks) sel.add(new Option(`${t.id} — ${t.title || ('Music #' + t.id)}${t.playable ? '' : ' (missing)'}`, String(t.id)));
    sel.value = String(musicSlotId(slot));
    sel.classList.toggle('changed', (slot in musicChanges));
    sel.addEventListener('change', () => onMusicSlotChange(slot, parseInt(sel.value, 10) || 0));
    const play = document.createElement('button'); play.className = 'bgm-slot-play'; play.title = 'Play this track'; play.textContent = '▶';
    play.addEventListener('click', () => playMusicId(musicSlotId(slot), slabel));
    const ctl = document.createElement('div'); ctl.className = 'bgm-slot-controls';
    ctl.appendChild(sel); ctl.appendChild(play);
    row.appendChild(lab); row.appendChild(ctl);
    slotsEl.appendChild(row);
  }
  updateBgmUI();
}

export function musicSlotId(slot) {
  return (slot in musicChanges) ? musicChanges[slot] : (musicBaseline[slot] || 0);
}
export function onMusicSlotChange(slot, id) {
  if (id === (musicBaseline[slot] || 0)) delete musicChanges[slot]; else musicChanges[slot] = id;
  const sel = document.querySelector(`#zone-bgm-slots select[data-slot="${slot}"]`);
  if (sel) sel.classList.toggle('changed', (slot in musicChanges));
  _updateChangesUI();   // badge + Changes panel + autosave + Publish-enabled state
}
export function revertMusicChange(slot) {
  delete musicChanges[slot];
  _zoneBgmRenderedKey = null; renderZoneMusic();
  _updateChangesUI();
}
export function bgmPlayResume() {
  if (_bgmLoadedId != null && _bgmAudio) { _bgmAudio.play().catch(() => {}); updateBgmUI(); }
}
export function applyBgmVolume() {
  if (_bgmAudio) _bgmAudio.volume = _bgmMuted ? 0 : _bgmVolume;
  updateBgmVolIcon();
}
export function updateBgmVolIcon() {
  const ico = document.getElementById('zone-bgm-vol-ico');
  if (ico) ico.textContent = (_bgmMuted || _bgmVolume === 0) ? '🔇' : (_bgmVolume < 0.5 ? '🔉' : '🔊');
  const vol = document.getElementById('zone-bgm-vol');
  if (vol) vol.value = String(Math.round((_bgmMuted ? 0 : _bgmVolume) * 100));
}

export function bgmEnsureAudio() {
  if (_bgmAudio) return;
  _bgmAudio = new Audio();
  _bgmAudio.loop = true;       // zone BGM loops continuously, like in-game
  _bgmAudio.volume = _bgmMuted ? 0 : _bgmVolume;
  _bgmAudio.addEventListener('timeupdate', updateBgmProgress);
  _bgmAudio.addEventListener('loadedmetadata', () => {
    if (isFinite(_bgmAudio.duration) && _bgmAudio.duration > 0) _bgmDur = _bgmAudio.duration;
    updateBgmProgress();
  });
  _bgmAudio.addEventListener('play', updateBgmUI);
  _bgmAudio.addEventListener('pause', updateBgmUI);
  _bgmAudio.addEventListener('error', () => { _setStatus('Could not play the decoded music.', true); updateBgmUI(); });
}

export async function playMusicId(id, label) {
  if (!id) return;
  if (!bridgeOnline()) { await _xi_alert('Bridge Offline', 'Playing music needs the backend — run the editor via `xi gui zone`.'); return; }
  if (_bgmLoadedId === id && _bgmAudio) {     // same track already decoded → resume
    _bgmNowLabel = label || _bgmNowLabel;
    try { await _bgmAudio.play(); } catch {}
    updateBgmUI();
    return;
  }
  unloadBgm();                 // tear down prior track + bump the token
  const myReq = _bgmReq;
  _bgmLoadingId = id;
  _bgmNowLabel = label || '';
  updateBgmUI();
  try {
    const r = await decodeBgmWithExportFallback(id);
    if (myReq !== _bgmReq) return;   // a newer action superseded this decode
    const bin = atob(r.wavBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    _bgmObjUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    bgmEnsureAudio();
    _bgmAudio.src = _bgmObjUrl;
    _bgmLoadedId = id;
    _bgmLoadingId = null;
    _bgmDur = r.duration || 0;
    _bgmNowTitle = r.title || ('Music #' + id);
    const khz = r.sampleRate ? (r.sampleRate / 1000).toFixed(1) + 'kHz' : '';
    const ch = r.channels === 2 ? 'stereo' : r.channels === 1 ? 'mono' : '';
    _bgmNowText = [r.format, khz, ch].filter(Boolean).join(' · ');
    await _bgmAudio.play();
    _setStatus(`Playing ${_bgmNowLabel || 'music'}: ${r.title} (${r.format}).`);
    updateBgmUI();
  } catch (e) {
    if (myReq !== _bgmReq) return;   // a newer action already moved on — swallow its error
    _bgmLoadingId = null;
    _showErrorBanner(`Play music failed: ${e.message}`);
    _setStatus(`Play music failed: ${e.message}`, true);
    updateBgmUI();
  }
}

export function bgmPause() {
  if (_bgmAudio && !_bgmAudio.paused) { try { _bgmAudio.pause(); } catch {} }
  updateBgmUI();
}

// Stop = halt + rewind, but keep the decoded clip loaded so Play restarts instantly.
export function bgmStop() {
  _bgmReq++;                 // cancel any in-flight decode
  _bgmLoadingId = null;
  if (_bgmAudio) { try { _bgmAudio.pause(); } catch {} try { _bgmAudio.currentTime = 0; } catch {} }
  updateBgmProgress();
  updateBgmUI();
}

// Full teardown — release the blob + clip (zone change, or switching to another track).
export function unloadBgm() {
  _bgmReq++;
  _bgmLoadingId = null;
  if (_bgmAudio) { try { _bgmAudio.pause(); } catch {} try { _bgmAudio.removeAttribute('src'); _bgmAudio.load(); } catch {} }
  if (_bgmObjUrl) { URL.revokeObjectURL(_bgmObjUrl); _bgmObjUrl = null; }
  _bgmLoadedId = null;
  _bgmDur = 0;
  _bgmNowText = '';
  updateBgmProgress();
  updateBgmUI();
}

export function updateBgmProgress() {
  const cur = _bgmAudio ? (_bgmAudio.currentTime || 0) : 0;
  const dur = _bgmDur || (_bgmAudio && isFinite(_bgmAudio.duration) ? _bgmAudio.duration : 0);
  const seek = document.getElementById('zone-bgm-seek');
  if (seek && !_bgmSeeking) seek.value = dur ? String(Math.round((cur / dur) * 1000)) : '0';
  const t = document.getElementById('zone-bgm-time');
  if (t) t.textContent = `${bgmFmtTime(cur)} / ${bgmFmtTime(dur)}`;
}

export function updateBgmUI() {
  const loading = _bgmLoadingId != null;
  const loaded = _bgmLoadedId != null && !!_bgmAudio;
  const playing = loaded && !_bgmAudio.paused;
  const atStart = !_bgmAudio || (_bgmAudio.currentTime || 0) < 0.05;
  const playBtn = document.getElementById('zone-bgm-play');
  const pauseBtn = document.getElementById('zone-bgm-pause');
  const stopBtn = document.getElementById('zone-bgm-stop');
  const seek = document.getElementById('zone-bgm-seek');
  const now = document.getElementById('zone-bgm-now');
  const title = document.getElementById('zone-bgm-title');
  if (playBtn) { playBtn.disabled = !loaded || loading || playing; playBtn.classList.toggle('active', playing); }
  if (pauseBtn) pauseBtn.disabled = !playing;
  if (stopBtn) stopBtn.disabled = !(loading || playing || (loaded && !atStart));
  if (seek) seek.disabled = !loaded;
  if (now) now.textContent = loading ? 'decoding…' : (loaded ? _bgmNowText : '');
  if (title) title.textContent = loading
    ? (_bgmNowLabel ? `Loading ${_bgmNowLabel}…` : 'Loading…')
    : (loaded ? `${_bgmNowLabel ? _bgmNowLabel + ': ' : ''}${_bgmNowTitle}` : 'Nothing playing');
}

// ── Zone music assignment (zone_settings.music_* via DB) ──────────────────
export async function loadAllMusic() {
  if (_allMusicCache) return _allMusicCache;
  const r = await bridgeCall('audio.musicCatalog', {});
  _allMusicCache = (r?.rows || []).slice().sort((a, b) => (a.id || 0) - (b.id || 0));
  return _allMusicCache;
}

export function refreshZoneMusic() {
  _zoneBgm = null; _zoneBgmFetching = null; _zoneBgmRenderedKey = null;
  ensureZoneMusic();
}

export async function setZoneMusicSlot(slot, musicId, label) {
  const zid = _currentZoneId();
  if (!zid) { _setStatus('Load a zone first to set its music.', true); return false; }
  if (!bridgeOnline()) { await _xi_alert('Bridge Offline', 'Setting zone music needs the backend (database) — run the editor via `xi gui zone`.'); return false; }
  try {
    const r = await bridgeCall('zone.setBgm', { zoneId: zid, zone: _getZoneUrl(), updates: { [slot]: musicId } });
    if (!r?.ok) { _showErrorBanner(`Set zone music failed: ${r?.error || 'unknown'}`); _setStatus(`Set zone music failed: ${r?.error || 'unknown'}`, true); return false; }
    _setStatus(`Zone ${zid}: ${label || slot} music set to #${musicId}.`);
    refreshZoneMusic();
    return true;
  } catch (e) {
    _showErrorBanner(`Set zone music failed: ${e.message}`);
    _setStatus(`Set zone music failed: ${e.message}`, true);
    return false;
  }
}

export async function openZoneMusicModal() {
  const modal = document.getElementById('zone-music-modal');
  if (!modal) return;
  const zid = _currentZoneId();
  if (!zid) { _setStatus('Load a zone first.', true); return; }
  if (!bridgeOnline()) { await _xi_alert('Bridge Offline', 'Managing zone music needs the backend (database).'); return; }
  const titleEl = document.getElementById('zmm-title');
  if (titleEl) titleEl.textContent = `Manage Zone Music — zone ${zid}`;
  const statusEl = document.getElementById('zmm-status');
  if (statusEl) statusEl.textContent = 'loading…';
  modal.style.display = 'flex';
  // current values — fetch fresh so a stale panel cache can't zero a slot on save
  const curMap = {};
  try {
    const b = await bridgeCall('zone.bgm', { zoneId: zid, zone: _getZoneUrl() });
    if (b?.ok) for (const s of (b.slots || [])) curMap[s.key] = s.id;
  } catch { /* fall back to defaults below */ }
  let tracks = [];
  try { tracks = await loadAllMusic(); } catch (e) { if (statusEl) statusEl.textContent = `couldn't load tracks: ${e.message}`; }
  for (const [key] of _ZONE_MUSIC_SLOTS) {
    const sel = document.getElementById('zmm-' + key);
    if (!sel) continue;
    sel.innerHTML = '';
    sel.add(new Option('0 — None (silent)', '0'));
    for (const t of tracks) {
      sel.add(new Option(`${t.id} — ${t.title || ('Music #' + t.id)}${t.playable ? '' : ' (missing)'}`, String(t.id)));
    }
    sel.value = String(curMap[key] ?? 0);
  }
  if (statusEl) statusEl.textContent = '';
}

export function initZoneMusicModalListeners(getCurrentZoneUrl, getCurrentZoneId) {
  document.getElementById('zmm-close')?.addEventListener('click', () => { const m = document.getElementById('zone-music-modal'); if (m) m.style.display = 'none'; });
  document.getElementById('zone-music-modal')?.addEventListener('click', (e) => { if (e.target.id === 'zone-music-modal') e.currentTarget.style.display = 'none'; });
  document.getElementById('zmm-save')?.addEventListener('click', async () => {
    const zid = getCurrentZoneId();
    if (!zid) return;
    const updates = {};
    for (const [key] of _ZONE_MUSIC_SLOTS) {
      const sel = document.getElementById('zmm-' + key);
      if (sel) updates[key] = parseInt(sel.value, 10) || 0;
    }
    const statusEl = document.getElementById('zmm-status');
    if (statusEl) statusEl.textContent = 'saving…';
    try {
      const r = await bridgeCall('zone.setBgm', { zoneId: zid, zone: getCurrentZoneUrl(), updates });
      if (!r?.ok) { if (statusEl) statusEl.textContent = `failed: ${r?.error || 'unknown'}`; return; }
      if (statusEl) statusEl.textContent = `saved — zone ${zid} updated.`;
      refreshZoneMusic();
      _setStatus(`Zone ${zid} music updated in the database.`);
      setTimeout(() => { const m = document.getElementById('zone-music-modal'); if (m) m.style.display = 'none'; }, 700);
    } catch (e) {
      if (statusEl) statusEl.textContent = `failed: ${e.message}`;
    }
  });
}

export function showMusicContextMenu(x, y, musicId, title) {
  const menu = document.getElementById('music-ctx-menu');
  if (!menu) return;
  menu.dataset.musicId = String(musicId);
  menu.dataset.title = title || '';
  menu.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 160) + 'px';
  menu.style.display = 'block';
}
export function hideMusicContextMenu() { const m = document.getElementById('music-ctx-menu'); if (m) m.style.display = 'none'; }

export function setMusicChanges(v) { musicChanges = v; }
export function clearZoneBgmKey() { _zoneBgmRenderedKey = null; }

export function initMusicContextMenuListeners() {
  document.querySelectorAll('#music-ctx-menu [data-slot]').forEach((b) => {
    b.addEventListener('click', () => {
      const menu = document.getElementById('music-ctx-menu');
      const id = parseInt(menu.dataset.musicId, 10);
      const slot = b.dataset.slot;
      const label = (_ZONE_MUSIC_SLOTS.find((s) => s[0] === slot) || [])[1] || slot;
      hideMusicContextMenu();
      if (id) setZoneMusicSlot(slot, id, label);
    });
  });
  document.addEventListener('click', hideMusicContextMenu);
  document.addEventListener('scroll', hideMusicContextMenu, true);
}
