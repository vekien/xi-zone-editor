// asset-browser.js — Asset Browser panel extracted from main.js
// Handles: GLB/asset catalog, music catalog, SFX catalog, mob catalog,
// drag-to-viewport drop handlers, and all related state.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bridgeCall, bridgeOnline, exportsUrl } from '../ffxi/bridge.js';
import { decodeBgmWithExportFallback } from '../ffxi/audio-helper.js';
import { pushCommand } from '../editor/undo-redo.js';

// ── injected dependencies (set via initAssetBrowser) ──────────────────────────
let _getScene, _getZoneRoot, _camera, _canvas, _setStatus;
let _selectNode, _buildGlbNode, _commitAdded, _commitAddedSound;
let _raycaster, _placementSet, _gltfLoader;
// helpers from main.js passed in
let _setActiveTab, _toggleModal, _loadSetting, _saveSetting;
let _xi_alert, _xi_confirm, _showMusicContextMenu, _showErrorBanner, _bgmFmtTime;
let _getBgmAudio, _updateBgmUI;
let _uniquePlacementName, _newXiId, _xiName, _commitPastedItems;
let _editMode, _getEditMode;
let _select, _placements, _getPlacements, _addedEntries, _getAddedEntries;
let _buildObjectList, _updateChangesUI, _markChange, _addVfxIcon, _getVfxIconGroup;
let _rebuildSelectionOutline, _updateSelectionReadout, _updateSelectionOutline;
let _lastSelectedEntry, _isLocked, _transform, _selectedSet;
let _getCurrentZoneId, _getCurrentZoneUrl, _getCurrentZoneName;

/**
 * Initialise the asset browser. Must be called once after the DOM is ready.
 */
export function initAssetBrowser({
  getScene, getZoneRoot, camera, canvas, setStatus,
  selectNode, buildGlbNode, commitAdded, commitAddedSound,
  raycaster, placementSet, gltfLoader,
  setActiveTab, toggleModal, loadSetting, saveSetting,
  xi_alert, xi_confirm, showMusicContextMenu, showErrorBanner, bgmFmtTime,
  getBgmAudio, updateBgmUI,
  uniquePlacementName, newXiId, xiName, commitPastedItems,
  getEditMode,
  select, getPlacements, getAddedEntries,
  buildObjectList, updateChangesUI, markChange, addVfxIcon, getVfxIconGroup,
  rebuildSelectionOutline, updateSelectionReadout, updateSelectionOutline,
  lastSelectedEntry, isLocked, transform, selectedSet,
  getCurrentZoneId, getCurrentZoneUrl, getCurrentZoneName,
}) {
  _getScene = getScene;
  _getZoneRoot = getZoneRoot;
  _camera = camera;
  _canvas = canvas;
  _setStatus = setStatus;
  _selectNode = selectNode;
  _buildGlbNode = buildGlbNode;
  _commitAdded = commitAdded;
  _commitAddedSound = commitAddedSound;
  _raycaster = raycaster;
  _placementSet = placementSet;
  _gltfLoader = gltfLoader;
  _setActiveTab = setActiveTab;
  _toggleModal = toggleModal;
  _loadSetting = loadSetting;
  _saveSetting = saveSetting;
  _xi_alert = xi_alert;
  _xi_confirm = xi_confirm;
  _showMusicContextMenu = showMusicContextMenu;
  _showErrorBanner = showErrorBanner;
  _bgmFmtTime = bgmFmtTime;
  _getBgmAudio = getBgmAudio;
  _updateBgmUI = updateBgmUI;
  _uniquePlacementName = uniquePlacementName;
  _newXiId = newXiId;
  _xiName = xiName;
  _commitPastedItems = commitPastedItems;
  _getEditMode = getEditMode;
  _select = select;
  _getPlacements = getPlacements;
  _getAddedEntries = getAddedEntries;
  _buildObjectList = buildObjectList;
  _updateChangesUI = updateChangesUI;
  _markChange = markChange;
  _addVfxIcon = addVfxIcon;
  _getVfxIconGroup = getVfxIconGroup;
  _rebuildSelectionOutline = rebuildSelectionOutline;
  _updateSelectionReadout = updateSelectionReadout;
  _updateSelectionOutline = updateSelectionOutline;
  _lastSelectedEntry = lastSelectedEntry;
  _isLocked = isLocked;
  _transform = transform;
  _selectedSet = selectedSet;
  _getCurrentZoneId = getCurrentZoneId;
  _getCurrentZoneUrl = getCurrentZoneUrl;
  _getCurrentZoneName = getCurrentZoneName;

  _initAssetBrowserDOM();
}

// ── DOM refs + state (initialised in _initAssetBrowserDOM) ────────────────────
let assetsBtn, assetsPanel;
export let cbGrid, cbSearchEl, cbZoneFilterEl;
let cbSoundFileEl, cbMusicFileEl;

const CB_MANIFESTS = {
  objects:   () => exportsUrl('assets/manifest_object.json'),
  floors:    () => exportsUrl('assets/manifest_floor.json'),
  walls:     () => exportsUrl('assets/manifest_wall.json'),
  terrain:   () => exportsUrl('assets/manifest_terrain.json'),
  structure: () => exportsUrl('assets/manifest_structure.json'),
  misc:      () => exportsUrl('assets/manifest_unknown.json'),
};
const CB_PAGE = 80;

export let cbCat = 'objects';
let cbAllData    = {};
let cbSheetMeta  = {};
let cbFiltered   = [];
let cbRendered   = 0;
let cbDragOverlay = null;
export let cbSpritesheet = null;
export let cbSheetReady  = {};

let cbFavs = {};
try { cbFavs = JSON.parse(localStorage.getItem('cbFavourites') || '{}') || {}; } catch { cbFavs = {}; }
const cbFavSave = () => { try { localStorage.setItem('cbFavourites', JSON.stringify(cbFavs)); } catch {} };
export const cbFavList = () => Object.values(cbFavs);
export const cbCurrent = () => (cbCat === 'favourites' ? cbFavList() : (cbAllData[cbCat] || []));

export let cbStatusBar = null;

// ── music player bar DOM refs ─────────────────────────────────────────────────
let mcpBar, mcpNow, mcpPlay, mcpPause, mcpStopB, mcpCur, mcpDurEl, mcpSeek, mcpVol, mcpVolIco;

let mcData = null;
let mcAudio = null;
let mcUrl = null;
let mcLoadedId = null;
let mcLoadingId = null;
let mcReq = 0;
let mcDur = 0;
let mcSeeking = false;
let mcMuted = false;
let mcVolume = 1;
let mcNowTitle = '';

// ── SFX catalog state ─────────────────────────────────────────────────────────
let sfxcData = null;
let sfxcAudio = null, sfxcUrl = null, sfxcReq = 0;
let sfxcPlayingId = null, sfxcLoadingId = null;
const sfxcExpanded = new Set();
const _seLabel = (id) => 'se' + String(id).padStart(6, '0');

// ── Mob catalog state ─────────────────────────────────────────────────────────
let mobcData = null;

// ── Custom NPC state ──────────────────────────────────────────────────────────
let cnData = null;   // { ok, npcs:[…], count } from customNpc.list (current zone)

// ── GLB loader (shared with drop handlers) ────────────────────────────────────
const gltfLoader = new GLTFLoader();

// ── HTML escape helper ────────────────────────────────────────────────────────
export function cbEsc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── Spritesheet helpers ───────────────────────────────────────────────────────
function cbSheetUrl(si) {
  const f   = cbSpritesheet?.fmt || 'png';
  const sub = cbSpritesheet?.subdir ? cbSpritesheet.subdir + '/' : '';
  return exportsUrl(`assets/sprites/${sub}sheet_${String(si).padStart(3, '0')}.${f}`);
}

function cbEnsureSheet(si) {
  if (!cbSheetReady[si]) {
    cbSheetReady[si] = new Promise((resolve) => {
      const img = new Image();
      const url = cbSheetUrl(si);
      img.onload = img.onerror = () => resolve(url);
      img.src = url;
    });
  }
  return cbSheetReady[si];
}

// ── favourites ────────────────────────────────────────────────────────────────
function cbFavCountUpdate() {
  const el = document.getElementById('cb-count-favourites');
  const n = Object.keys(cbFavs).length;
  if (el) el.textContent = n ? n.toLocaleString() : '';
}

function cbToggleFav(e) {
  if (cbFavs[e.id]) { delete cbFavs[e.id]; }
  else {
    const f = { id: e.id, cat: cbCat, sample_mesh: e.sample_mesh, sample_zone: e.sample_zone, sample_dat: e.sample_dat };
    if (e.sheet)                        { f.sheet = e.sheet; f.sprite = e.sprite; }
    else if (cbSpritesheet && e.sprite) { f.sheet = cbSheetUrl(e.sprite.si); f.sprite = { sx: e.sprite.sx, sy: e.sprite.sy }; }
    else if (e.file)                    { f.file = e.file; }
    cbFavs[e.id] = f;
  }
  cbFavSave(); cbFavCountUpdate();
  return !!cbFavs[e.id];
}

// ── lazy image + scroll observers (created in _initAssetBrowserDOM) ───────────
let cbImgObs = null;
let cbSentinel = null;
let cbScrollObs = null;

// ── cbAppendBatch ─────────────────────────────────────────────────────────────
function cbAppendBatch() {
  const slice = cbFiltered.slice(cbRendered, cbRendered + CB_PAGE);
  if (!slice.length) { cbSentinel?.remove(); cbSentinel = null; return; }

  const frag = document.createDocumentFragment();
  for (const e of slice) {
    const div = document.createElement('div');
    div.className = cbFavs[e.id] ? 'cb-item cb-faved' : 'cb-item';
    div.draggable = true;

    const labels =
      `<div class="cb-labels">` +
      `<div class="cb-mesh" title="${cbEsc(e.sample_mesh)}">${cbEsc(e.sample_mesh || e.id)}</div>` +
      `<div class="cb-zone" title="${cbEsc(e.sample_zone)}">${cbEsc(e.sample_zone || '')}</div>` +
      `</div>`;
    const star = `<button class="cb-star" title="Favourite (or right-click the tile)"><span class="material-symbols-outlined" aria-hidden="true">star</span></button>`;

    const isSprite = !!(e.sheet || (cbSpritesheet && e.sprite));
    const sp = isSprite;
    if (e.sheet) {
      div.innerHTML =
        `<div class="cb-thumb"><div class="cb-sp cb-ok" style="background-image:url(${cbEsc(e.sheet)});background-position:-${e.sprite.sx}px -${e.sprite.sy}px"></div></div>` +
        labels + star;
    } else if (cbSpritesheet && e.sprite) {
      div.innerHTML =
        `<div class="cb-thumb"><div class="cb-sp" data-si="${e.sprite.si}" data-sx="${e.sprite.sx}" data-sy="${e.sprite.sy}"></div></div>` +
        labels + star;
      const spEl = div.querySelector('.cb-sp');
      cbEnsureSheet(e.sprite.si).then((url) => {
        spEl.style.backgroundImage = `url(${url})`;
        spEl.style.backgroundPosition = `-${e.sprite.sx}px -${e.sprite.sy}px`;
        spEl.classList.add('cb-ok');
      });
    } else {
      div.innerHTML =
        `<div class="cb-thumb"><img data-src="${cbEsc(exportsUrl('assets/' + e.file))}" alt="" /></div>` +
        labels + star;
      cbImgObs.observe(div.querySelector('img'));
    }

    const cbDoFav = () => {
      const on = cbToggleFav(e);
      div.classList.toggle('cb-faved', on);
      if (cbCat === 'favourites' && !on) cbRender(cbFavList());
    };
    div.querySelector('.cb-star')?.addEventListener('click', (ev) => { ev.stopPropagation(); cbDoFav(); });
    div.addEventListener('contextmenu', (ev) => { ev.preventDefault(); cbDoFav(); });

    div.addEventListener('dragstart', (ev) => {
      _setActiveTab('objs');
      ev.dataTransfer.effectAllowed = 'copy';
      ev.dataTransfer.setData('application/x-xi-asset', JSON.stringify({
        id: e.id, sample_dat: e.sample_dat, sample_mesh: e.sample_mesh, sample_zone: e.sample_zone,
      }));
      const blank = document.createElement('canvas');
      blank.width = blank.height = 1;
      ev.dataTransfer.setDragImage(blank, 0, 0);
      const ghost = div.cloneNode(true);
      if (!sp) {
        const liveImg = div.querySelector('img');
        const ghostImg = ghost.querySelector('img');
        if (liveImg && ghostImg) ghostImg.src = liveImg.src || liveImg.dataset.src || '';
      }
      const rect = div.getBoundingClientRect();
      const ox = ev.clientX - rect.left;
      const oy = ev.clientY - rect.top;
      ghost.dataset.ox = ox;
      ghost.dataset.oy = oy;
      ghost.style.cssText = [
        'position:fixed', 'left:0', 'top:0', 'margin:0', 'pointer-events:none', 'z-index:99999',
        'overflow:visible', 'transition:none',
        `transform:translate(${rect.left}px,${rect.top}px) scale(1.08)`,
        'transform-origin:top left',
        'box-shadow:0 12px 32px rgba(0,0,0,0.8),0 0 0 2px #4a9eff',
        'border-radius:5px',
      ].join(';');
      document.body.appendChild(ghost);
      cbDragOverlay = ghost;
    });
    div.addEventListener('drag', (ev) => {
      if (!cbDragOverlay || (ev.clientX === 0 && ev.clientY === 0)) return;
      const x = ev.clientX - +cbDragOverlay.dataset.ox;
      const y = ev.clientY - +cbDragOverlay.dataset.oy;
      cbDragOverlay.style.transform = `translate(${x}px,${y}px) scale(1.08)`;
    });
    div.addEventListener('dragend', () => { cbDragOverlay?.remove(); cbDragOverlay = null; });
    frag.appendChild(div);
  }
  cbRendered += slice.length;

  cbSentinel?.remove(); cbSentinel = null;
  cbGrid.appendChild(frag);

  if (cbRendered < cbFiltered.length) {
    cbSentinel = document.createElement('div');
    cbSentinel.style.cssText = 'width:100%;height:1px;flex-basis:100%;pointer-events:none';
    cbGrid.appendChild(cbSentinel);
    cbScrollObs.observe(cbSentinel);
  }
}

// ── cbPopulateZoneFilter ──────────────────────────────────────────────────────
export function cbPopulateZoneFilter(entries) {
  if (!cbZoneFilterEl) return;
  const current = cbZoneFilterEl.value;
  const all = [...new Set(entries.map((e) => e.sample_zone || '').filter(Boolean))].sort();
  const named = all.filter((z) => !z.toUpperCase().startsWith('ROM'));
  const rom   = all.filter((z) =>  z.toUpperCase().startsWith('ROM'));
  const opt   = (z) => `<option value="${cbEsc(z)}"${z === current ? ' selected' : ''}>${cbEsc(z)}</option>`;
  cbZoneFilterEl.innerHTML =
    '<option value="">All zones</option>' +
    (named.length ? `<optgroup label="Zones">${named.map(opt).join('')}</optgroup>` : '') +
    (rom.length   ? `<optgroup label="ROM (unnamed)">${rom.map(opt).join('')}</optgroup>` : '');
}

// ── cbRender ──────────────────────────────────────────────────────────────────
export function cbRender(entries) {
  const q    = (cbSearchEl?.value || '').trim().toLowerCase();
  const zone = cbZoneFilterEl?.value || '';
  cbFiltered = entries.filter((e) =>
    (!q    || (e.sample_mesh || '').toLowerCase().includes(q) || (e.sample_zone || '').toLowerCase().includes(q)) &&
    (!zone || (e.sample_zone || '') === zone));

  const total = entries.length;
  const shown = cbFiltered.length;
  if (cbStatusBar) cbStatusBar.textContent = (q || zone)
    ? `${shown.toLocaleString()} of ${total.toLocaleString()} assets`
    : `${total.toLocaleString()} assets`;

  cbScrollObs.disconnect();
  cbImgObs.disconnect();
  cbSentinel = null;
  cbRendered = 0;
  cbGrid.innerHTML = '';

  if (!cbFiltered.length) {
    cbGrid.innerHTML = `<div class="cb-msg">${(q || zone) ? `No results` : 'No items'}</div>`;
    return;
  }
  cbAppendBatch();
}

// ── cbLoad ────────────────────────────────────────────────────────────────────
export async function cbLoad(cat) {
  const isMusic = cat === 'music', isSfx = cat === 'sfx', isMobs = cat === 'mobs';
  const isCustomNpcs = cat === 'customnpcs';
  if (cbZoneFilterEl) cbZoneFilterEl.style.display = (isMusic || isSfx || isMobs || isCustomNpcs) ? 'none' : '';
  if (mcpBar) mcpBar.style.display = isMusic ? '' : 'none';
  if (cbSearchEl) cbSearchEl.placeholder = isMusic ? 'Search music…' : isSfx ? 'Search sounds…' : isMobs ? 'Search mobs…' : isCustomNpcs ? 'Search custom NPCs…' : 'Search assets…';
  if (!isMusic) mcUnload();
  if (!isSfx) sfxcStop();
  if (isMusic) { loadMusicCatalog(); return; }
  if (isSfx) { loadSfxCatalog(); return; }
  if (isMobs) { loadMobCatalog(); return; }
  if (isCustomNpcs) { loadCustomNpcs(); return; }
  if (cat === 'favourites') {
    cbSpritesheet = null; cbSheetReady = {};
    cbPopulateZoneFilter(cbFavList());
    cbRender(cbFavList());
    return;
  }
  if (cbAllData[cat]) {
    cbSpritesheet = cbSheetMeta[cat] || null;
    cbSheetReady  = {};
    cbPopulateZoneFilter(cbAllData[cat]); cbRender(cbAllData[cat]); return;
  }
  const urlFn = CB_MANIFESTS[cat];
  if (!urlFn) { cbGrid.innerHTML = '<div class="cb-msg">Coming soon</div>'; return; }
  const url = typeof urlFn === 'function' ? urlFn() : urlFn;

  cbGrid.innerHTML = '<div class="cb-msg cb-spin">Loading…</div>';
  try {
    const data = await fetch(url).then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); });
    const entries = Object.entries(data.icons || data).map(([id, v]) => ({ id, ...v }));
    cbSpritesheet     = data.spritesheet || null;
    cbSheetReady      = {};
    cbSheetMeta[cat]  = cbSpritesheet;
    cbAllData[cat]    = entries;
    const countEl = document.getElementById(`cb-count-${cat}`);
    if (countEl) countEl.textContent = entries.length.toLocaleString();
    if (cbCat === cat) { cbPopulateZoneFilter(entries); cbRender(entries); }
  } catch (err) {
    if (cbCat === cat) cbGrid.innerHTML = `<div class="cb-msg">Failed: ${cbEsc(err.message)}</div>`;
  }
}

// ── cbReRender ────────────────────────────────────────────────────────────────
export function cbReRender() {
  if (cbCat === 'music') mcRender();
  else if (cbCat === 'sfx') sfxcRender();
  else if (cbCat === 'mobs') mobcRender();
  else if (cbCat === 'customnpcs') cnRender();
  else cbRender(cbCurrent());
}

// ── count prefetch ────────────────────────────────────────────────────────────
let cbCountsLoaded = false;
async function cbLoadCounts() {
  if (cbCountsLoaded) return;
  try {
    const counts = await fetch(exportsUrl('assets/manifest_counts.json'), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null));
    if (!counts) return;
    cbCountsLoaded = true;
    for (const [cat, n] of Object.entries(counts)) {
      const el = document.getElementById(`cb-count-${cat}`);
      if (el && el.textContent === '') el.textContent = Number(n).toLocaleString();
    }
  } catch { /* no cache yet */ }
}

// ── Music catalog ─────────────────────────────────────────────────────────────
export async function loadMusicCatalog() {
  if (mcData) { mcRender(); return; }
  if (!bridgeOnline()) {
    cbGrid.innerHTML = '<div class="cb-msg">Bridge offline — run via `xi gui zone`</div>';
    if (cbStatusBar) cbStatusBar.textContent = '';
    return;
  }
  cbGrid.innerHTML = '<div class="cb-msg cb-spin">Loading…</div>';
  try {
    const r = await bridgeCall('audio.musicCatalog', {});
    mcData = r;
    const el = document.getElementById('cb-count-music');
    if (el) el.textContent = (r.count || 0).toLocaleString();
    if (cbCat === 'music') mcRender();
  } catch (e) {
    if (cbCat === 'music') cbGrid.innerHTML = `<div class="cb-msg">Failed: ${cbEsc(e.message)}</div>`;
  }
}

function mcFilteredRows() {
  const q = (cbSearchEl?.value || '').trim().toLowerCase();
  const rows = mcData?.rows || [];
  if (!q) return rows;
  return rows.filter((r) =>
    (r.title || '').toLowerCase().includes(q) ||
    (r.file || '').toLowerCase().includes(q) ||
    String(r.id ?? '').includes(q) ||
    (r.format || '').toLowerCase().includes(q));
}

export function mcRender() {
  if (!mcData) { loadMusicCatalog(); return; }
  const rows = mcFilteredRows();
  const total = mcData.rows.length;
  if (cbStatusBar) cbStatusBar.textContent = rows.length === total
    ? `${total.toLocaleString()} tracks`
    : `${rows.length.toLocaleString()} of ${total.toLocaleString()} tracks`;
  if (!rows.length) { cbGrid.innerHTML = `<div class="cb-msg">No tracks</div>`; return; }
  const html = rows.map((r) => {
    const dur = r.duration != null ? _bgmFmtTime(r.duration) : '—';
    const meta = [r.file, r.id != null ? `#${r.id}` : null, r.format,
      r.sampleRate ? (r.sampleRate / 1000).toFixed(1) + 'kHz' : null,
      r.channels === 2 ? 'stereo' : r.channels === 1 ? 'mono' : null,
      r.looped ? 'loop' : null].filter(Boolean).join(' · ');
    const cls = 'mc-row' + (r.playable ? '' : ' mc-unavail');
    const tip = (r.playable ? 'Click to play' : (r.format === 'ATRAC3' ? 'ATRAC3 needs vgmstream' : 'Not decodable'))
      + ' · drag onto a cutscene timeline to key it as the Music track';
    return `<div class="${cls}" data-id="${r.id}" draggable="true" title="${cbEsc(tip)}">`
      + `<span class="mc-ico">play_arrow</span>`
      + `<span class="mc-line"><span class="mc-title">${cbEsc(r.title)}</span>`
      + `<span class="mc-meta">${cbEsc(meta)}</span></span>`
      + `<span class="mc-dur">${dur}</span></div>`;
  }).join('');
  cbGrid.innerHTML = `<div class="mc-list">${html}</div>`;
  cbGrid.querySelectorAll('.mc-row').forEach((row) => {
    const id = parseInt(row.dataset.id, 10);
    if (!row.classList.contains('mc-unavail')) {
      row.addEventListener('click', () => mcLoadAndPlay(id, mcData.rows.find((x) => x.id === id)));
    }
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      _showMusicContextMenu(e.clientX, e.clientY, id, (mcData.rows.find((x) => x.id === id) || {}).title);
    });
    // Drag a song onto the cutscene sequencer → cutscene.js keys it as the Music track.
    row.addEventListener('dragstart', (ev) => {
      const r = mcData.rows.find((x) => x.id === id) || {};
      ev.dataTransfer.effectAllowed = 'copy';
      ev.dataTransfer.setData('application/x-xi-music', JSON.stringify({ musicId: id, title: r.title || '' }));
    });
  });
  mcUpdateRows();
}

function mcUpdateRows() {
  cbGrid.querySelectorAll('.mc-row').forEach((row) => {
    const id = parseInt(row.dataset.id, 10);
    const ico = row.querySelector('.mc-ico');
    const playing = id === mcLoadedId && mcAudio && !mcAudio.paused;
    const loading = id === mcLoadingId;
    row.classList.toggle('mc-active', id === mcLoadedId || loading);
    if (ico && !row.classList.contains('mc-unavail')) ico.textContent = loading ? 'sync' : (playing ? 'volume_up' : 'play_arrow');
  });
}

function mcUpdateProgress() {
  const cur = mcAudio ? (mcAudio.currentTime || 0) : 0;
  const dur = mcDur || (mcAudio && isFinite(mcAudio.duration) ? mcAudio.duration : 0);
  if (mcpSeek && !mcSeeking) mcpSeek.value = dur ? String(Math.round((cur / dur) * 1000)) : '0';
  if (mcpCur) mcpCur.textContent = _bgmFmtTime(cur);
  if (mcpDurEl) mcpDurEl.textContent = _bgmFmtTime(dur);
}

function mcUpdateBar() {
  const loaded = mcLoadedId != null && !!mcAudio;
  const loading = mcLoadingId != null;
  const playing = loaded && !mcAudio.paused;
  if (mcpNow) mcpNow.textContent = loading
    ? `Loading: ${mcNowTitle || '…'}`
    : (loaded ? `Now Playing: ${mcNowTitle}` : 'Now Playing: —');
  if (mcpPlay)  { mcpPlay.disabled = playing || loading; mcpPlay.classList.toggle('active', playing); }
  if (mcpPause) mcpPause.disabled = !playing;
  if (mcpStopB) mcpStopB.disabled = !(loaded || loading);
  if (mcpSeek)  mcpSeek.disabled = !loaded;
}

function mcApplyVolume() {
  if (mcAudio) mcAudio.volume = mcMuted ? 0 : mcVolume;
  if (mcpVol) mcpVol.value = String(Math.round((mcMuted ? 0 : mcVolume) * 100));
  if (mcpVolIco) mcpVolIco.textContent = (mcMuted || mcVolume === 0) ? '🔇' : (mcVolume < 0.5 ? '🔈' : '🔊');
}

function mcEnsureAudio() {
  if (mcAudio) return;
  mcAudio = new Audio();
  mcAudio.volume = mcMuted ? 0 : mcVolume;
  mcAudio.addEventListener('timeupdate', mcUpdateProgress);
  mcAudio.addEventListener('loadedmetadata', () => {
    if (isFinite(mcAudio.duration) && mcAudio.duration > 0) mcDur = mcAudio.duration;
    mcUpdateProgress();
  });
  mcAudio.addEventListener('play', () => { mcUpdateBar(); mcUpdateRows(); });
  mcAudio.addEventListener('pause', () => { mcUpdateBar(); mcUpdateRows(); });
  mcAudio.addEventListener('ended', () => { mcUpdateBar(); mcUpdateRows(); });
  mcAudio.addEventListener('error', () => { _setStatus('Could not play the decoded music.', true); mcUpdateBar(); mcUpdateRows(); });
}

async function mcLoadAndPlay(id, row) {
  if (!id) return;
  if (!bridgeOnline()) { await _xi_alert('Bridge Offline', 'Playing music needs the backend — run the editor via `xi gui zone`.'); return; }
  try { const bgm = _getBgmAudio(); if (bgm && !bgm.paused) { bgm.pause(); if (typeof _updateBgmUI === 'function') _updateBgmUI(); } } catch {}
  mcNowTitle = row?.title || ('Music #' + id);
  if (mcLoadedId === id && mcAudio) {
    mcEnsureAudio();
    mcAudio.loop = !!row?.looped;
    try { mcAudio.currentTime = 0; await mcAudio.play(); } catch {}
    mcUpdateBar(); mcUpdateRows();
    return;
  }
  mcStop();
  const myReq = mcReq;
  mcLoadingId = id; mcUpdateBar(); mcUpdateRows();
  try {
    const r = await decodeBgmWithExportFallback(id);
    if (myReq !== mcReq) return;
    const bin = atob(r.wavBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (mcUrl) { URL.revokeObjectURL(mcUrl); mcUrl = null; }
    mcUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    mcEnsureAudio();
    mcAudio.src = mcUrl;
    mcAudio.loop = !!row?.looped;
    mcLoadedId = id; mcLoadingId = null;
    mcDur = r.duration || 0;
    if (row && row.duration == null && r.duration) {
      row.duration = r.duration;
      const cell = cbGrid.querySelector(`.mc-row[data-id="${id}"] .mc-dur`);
      if (cell) cell.textContent = _bgmFmtTime(r.duration);
    }
    await mcAudio.play();
    _setStatus(`Playing ${mcNowTitle} (${r.format}).`);
    mcUpdateBar(); mcUpdateProgress(); mcUpdateRows();
  } catch (e) {
    if (myReq !== mcReq) return;
    mcLoadingId = null;
    _showErrorBanner(`Play music failed: ${e.message}`);
    _setStatus(`Play music failed: ${e.message}`, true);
    mcUpdateBar(); mcUpdateRows();
  }
}

function mcBarPlay() {
  if (mcLoadedId != null && mcAudio) { if (mcAudio.paused) mcAudio.play().catch(() => {}); mcUpdateBar(); mcUpdateRows(); return; }
  const first = mcFilteredRows().find((r) => r.playable);
  if (first) mcLoadAndPlay(first.id, first);
}
function mcBarPause() { if (mcAudio && !mcAudio.paused) { try { mcAudio.pause(); } catch {} } mcUpdateBar(); mcUpdateRows(); }

export function mcPlay() { mcBarPlay(); }

export function mcStop() {
  mcReq++;
  mcLoadingId = null;
  if (mcAudio) { try { mcAudio.pause(); } catch {} try { mcAudio.currentTime = 0; } catch {} }
  mcUpdateBar(); mcUpdateProgress(); mcUpdateRows();
}

export function mcUnload() {
  mcReq++;
  mcLoadingId = null;
  if (mcAudio) { try { mcAudio.pause(); } catch {} try { mcAudio.removeAttribute('src'); mcAudio.load(); } catch {} }
  if (mcUrl) { URL.revokeObjectURL(mcUrl); mcUrl = null; }
  mcLoadedId = null; mcDur = 0; mcNowTitle = '';
  mcUpdateBar(); mcUpdateProgress(); mcUpdateRows();
}

// ── SFX catalog ───────────────────────────────────────────────────────────────
export async function loadSfxCatalog() {
  if (sfxcData) { sfxcRender(); return; }
  if (!bridgeOnline()) {
    cbGrid.innerHTML = '<div class="cb-msg">Bridge offline — run via `xi gui zone`</div>';
    if (cbStatusBar) cbStatusBar.textContent = '';
    return;
  }
  cbGrid.innerHTML = '<div class="cb-msg cb-spin">Loading…</div>';
  try {
    const r = await bridgeCall('audio.sfxCatalog', {});
    sfxcData = r;
    const el = document.getElementById('cb-count-sfx');
    if (el) el.textContent = (r.count || 0).toLocaleString();
    if (cbCat === 'sfx') sfxcRender();
  } catch (e) {
    if (cbCat === 'sfx') cbGrid.innerHTML = `<div class="cb-msg">Failed: ${cbEsc(e.message)}</div>`;
  }
}

function sfxcRowsHtml(sounds) {
  return sounds.map((s) => {
    const name = s.title || s.file;
    const meta = s.title ? s.file : '';
    return `<div class="sfx-row" data-id="${s.id}" data-file="${cbEsc(s.file)}" data-title="${cbEsc(s.title || '')}" draggable="true" title="Click to play · drag onto the map to place — ${cbEsc(s.file)}">`
      + `<span class="sfx-ico">play_arrow</span><span class="sfx-name">${cbEsc(name)}</span>`
      + (meta ? `<span class="sfx-fmeta">${cbEsc(meta)}</span>` : '')
      + `</div>`;
  }).join('');
}

function sfxcWireRows(container) {
  container.querySelectorAll('.sfx-row:not([data-wired])').forEach((row) => {
    row.dataset.wired = '1';
    const id = parseInt(row.dataset.id, 10);
    row.addEventListener('click', () => (id === sfxcPlayingId ? sfxcStop() : sfxcPlay(id)));
    row.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.effectAllowed = 'copy';
      ev.dataTransfer.setData('application/x-xi-sound', JSON.stringify({
        soundId: id, file: row.dataset.file || '', title: row.dataset.title || '',
      }));
    });
  });
}

export function sfxcRender() {
  if (!sfxcData) { loadSfxCatalog(); return; }
  const q = (cbSearchEl?.value || '').trim().toLowerCase();
  let groups, shown = 0;
  if (q) {
    groups = [];
    for (const g of sfxcData.groups) {
      const labelHit = g.label.toLowerCase().includes(q) || g.key.toLowerCase().includes(q);
      const sounds = labelHit ? g.sounds : g.sounds.filter((s) =>
        (s.title || '').toLowerCase().includes(q) || s.file.toLowerCase().includes(q) || String(s.id).includes(q));
      if (sounds.length) { groups.push({ key: g.key, label: g.label, sounds, open: true }); shown += sounds.length; }
    }
  } else {
    groups = sfxcData.groups.map((g) => ({ key: g.key, label: g.label, sounds: g.sounds, open: sfxcExpanded.has(g.key) }));
    shown = sfxcData.count;
  }
  if (cbStatusBar) cbStatusBar.textContent = q
    ? `${shown.toLocaleString()} of ${sfxcData.count.toLocaleString()} sounds`
    : `${sfxcData.count.toLocaleString()} sounds · ${sfxcData.groupCount} groups`;
  if (!groups.length) { cbGrid.innerHTML = `<div class="cb-msg">No sounds</div>`; return; }
  const html = groups.map((g) =>
    `<div class="sfx-group${g.open ? ' open' : ''}" data-key="${cbEsc(g.key)}">`
    + `<div class="sfx-ghead"><span class="sfx-caret material-symbols-outlined"></span>`
    + `<span class="sfx-glabel">${cbEsc(g.label)}</span>`
    + `<span class="sfx-gkey">${cbEsc(g.key)}</span>`
    + `<span class="sfx-gcount">${g.sounds.length}</span></div>`
    + `<div class="sfx-rows">${g.open ? sfxcRowsHtml(g.sounds) : ''}</div></div>`).join('');
  cbGrid.innerHTML = `<div class="sfx-list">${html}</div>`;
  cbGrid.querySelectorAll('.sfx-group').forEach((gEl) => {
    const key = gEl.dataset.key;
    gEl.querySelector('.sfx-ghead').addEventListener('click', () => {
      const open = gEl.classList.toggle('open');
      const rowsEl = gEl.querySelector('.sfx-rows');
      if (open) {
        sfxcExpanded.add(key);
        if (rowsEl.childElementCount === 0) {
          const g = sfxcData.groups.find((x) => x.key === key);
          rowsEl.innerHTML = sfxcRowsHtml(g.sounds);
          sfxcWireRows(rowsEl);
          sfxcUpdateRows();
        }
      } else {
        sfxcExpanded.delete(key);
      }
    });
  });
  sfxcWireRows(cbGrid);
  sfxcUpdateRows();
}

function sfxcUpdateRows() {
  cbGrid.querySelectorAll('.sfx-row').forEach((row) => {
    const id = parseInt(row.dataset.id, 10);
    const ico = row.querySelector('.sfx-ico');
    const playing = id === sfxcPlayingId, loading = id === sfxcLoadingId;
    row.classList.toggle('sfx-playing', playing || loading);
    if (ico) ico.textContent = loading ? 'sync' : (playing ? 'volume_up' : 'play_arrow');
  });
}

export function sfxcStop() {
  sfxcReq++;
  sfxcLoadingId = null;
  if (sfxcAudio) { try { sfxcAudio.pause(); } catch {} try { sfxcAudio.currentTime = 0; } catch {} }
  sfxcPlayingId = null;
  sfxcUpdateRows();
}

async function sfxcPlay(id) {
  if (!id) return;
  if (!bridgeOnline()) { await _xi_alert('Bridge Offline', 'Playing sounds needs the backend — run the editor via `xi gui zone`.'); return; }
  sfxcStop();
  const myReq = sfxcReq;
  sfxcLoadingId = id; sfxcUpdateRows();
  try {
    const r = await bridgeCall('audio.decodeSfx', { soundId: id });
    if (myReq !== sfxcReq) return;
    const bin = atob(r.wavBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (sfxcUrl) { URL.revokeObjectURL(sfxcUrl); sfxcUrl = null; }
    sfxcUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    if (!sfxcAudio) {
      sfxcAudio = new Audio();
      sfxcAudio.onended = () => { sfxcPlayingId = null; sfxcUpdateRows(); };
      sfxcAudio.onerror = () => { sfxcPlayingId = null; sfxcUpdateRows(); };
    }
    sfxcAudio.src = sfxcUrl;
    sfxcPlayingId = id; sfxcLoadingId = null;
    await sfxcAudio.play();
    _setStatus(`Playing ${_seLabel(id)} (${r.format}).`);
    sfxcUpdateRows();
  } catch (e) {
    if (myReq !== sfxcReq) return;
    sfxcLoadingId = null;
    _setStatus(`Play sound failed: ${e.message}`, true);
    sfxcUpdateRows();
  }
}

// ── Mob catalog ───────────────────────────────────────────────────────────────
export async function loadMobCatalog() {
  if (mobcData) { mobcRender(); return; }
  if (!bridgeOnline()) {
    cbGrid.innerHTML = '<div class="cb-msg">Bridge offline — run via `xi gui zone`</div>';
    if (cbStatusBar) cbStatusBar.textContent = '';
    return;
  }
  cbGrid.innerHTML = '<div class="cb-msg cb-spin">Loading mobs…</div>';
  try {
    const r = await bridgeCall('zone.mobList', {});
    mobcData = r;
    const el = document.getElementById('cb-count-mobs');
    if (el) el.textContent = (r.count || 0).toLocaleString();
    if (cbCat === 'mobs') mobcRender();
  } catch (e) {
    if (cbCat === 'mobs') cbGrid.innerHTML = `<div class="cb-msg">Failed: ${cbEsc(e.message)}</div>`;
  }
}

function mobcRowsHtml(mobs) {
  return mobs.map((m) =>
    `<div class="sfx-row" data-poolid="${m.poolid}" data-model="${cbEsc(m.modelid)}" data-name="${cbEsc(m.name)}" data-family="${m.family}" draggable="true" title="Drag onto the map (or click) to place — family ${m.family}, model ${cbEsc(m.modelid)}">`
    + `<span class="sfx-ico">person</span><span class="sfx-name">${cbEsc(m.name)}</span>`
    + `<span class="sfx-fmeta">#${m.poolid} · fam ${m.family}</span></div>`).join('');
}

function mobcWireRows(container) {
  container.querySelectorAll('.sfx-row:not([data-wired])').forEach((row) => {
    row.dataset.wired = '1';
    const mob = { poolid: parseInt(row.dataset.poolid, 10), modelid: row.dataset.model || '',
                  name: row.dataset.name || '', family: parseInt(row.dataset.family, 10) || 0 };
    row.addEventListener('click', () => {
      const r = _canvas.getBoundingClientRect();
      dropMobOnViewport(mob, r.left + r.width / 2, r.top + r.height / 2);
    });
    row.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.effectAllowed = 'copy';
      ev.dataTransfer.setData('application/x-xi-mob', JSON.stringify(mob));
    });
  });
}

const MOB_ROW_CAP = 600;
export function mobcRender() {
  if (!mobcData) { loadMobCatalog(); return; }
  if (!mobcData.ok) { cbGrid.innerHTML = `<div class="cb-msg">Failed: ${cbEsc(mobcData.error || 'unknown')}</div>`; return; }
  const q = (cbSearchEl?.value || '').trim().toLowerCase();
  let mobs = mobcData.mobs || [];
  if (q) mobs = mobs.filter((m) => m.name.toLowerCase().includes(q) || String(m.poolid).includes(q));
  if (cbStatusBar) cbStatusBar.textContent = q
    ? `${mobs.length.toLocaleString()} of ${(mobcData.count || 0).toLocaleString()} mobs`
    : `${(mobcData.count || 0).toLocaleString()} mobs · drag onto the map to place a spawn`;
  const capped = mobs.slice(0, MOB_ROW_CAP);
  const newBar = `<div class="cb-mob-newbar"><button id="cb-mob-new" class="load-btn" title="Create a mob from a chosen model DAT + model id">+ New Mob</button></div>`;
  const body = capped.length ? `<div class="sfx-list">${mobcRowsHtml(capped)}</div>` : '<div class="cb-msg">No mobs match</div>';
  const more = mobs.length > MOB_ROW_CAP ? `<div class="cb-msg">Showing first ${MOB_ROW_CAP} of ${mobs.length.toLocaleString()} — refine your search.</div>` : '';
  cbGrid.innerHTML = newBar + body + more;
  mobcWireRows(cbGrid);
  document.getElementById('cb-mob-new')?.addEventListener('click', openNewMobDialog);
}

async function openNewMobDialog() {
  if (!bridgeOnline()) { _xi_alert('Bridge Offline', 'Creating a mob needs the backend — run via `xi gui zone`.'); return; }
  if (!_getZoneRoot()) { _xi_alert('No Zone', 'Load a zone first, then create a mob.'); return; }
  document.getElementById('new-mob-overlay')?.remove();
  const ov = document.createElement('div');
  ov.id = 'new-mob-overlay';
  ov.className = 'nm-overlay';
  ov.innerHTML =
    `<div class="nm-dialog">` +
    `<div class="nm-title">New Mob</div>` +
    `<label class="nm-row"><span>Name</span><input id="nm-name" type="text" placeholder="My Mob" autocomplete="off" /></label>` +
    `<label class="nm-row"><span>Model ID</span><input id="nm-model" type="number" min="0" placeholder="e.g. 1383" autocomplete="off" /></label>` +
    `<div class="nm-hint">Uses an existing game model, resolved from its model id. The mob is placed in front of the camera — drag it into position, then Publish to write its spawn.</div>` +
    `<div class="nm-status" id="nm-status"></div>` +
    `<div class="nm-btns"><button id="nm-cancel" class="load-btn">Cancel</button><button id="nm-create" class="nz-create-btn">Create</button></div>` +
    `</div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.querySelector('#nm-cancel').onclick = close;
  const nameEl = ov.querySelector('#nm-name');
  const modelEl = ov.querySelector('#nm-model');
  const statusEl = ov.querySelector('#nm-status');
  nameEl.focus();
  const create = async () => {
    const id = parseInt(modelEl.value, 10);
    if (!Number.isFinite(id) || id < 0) { statusEl.textContent = 'Enter a valid model id.'; return; }
    const name = (nameEl.value || '').trim() || `model_${id}`;
    const look = [0, 0, id & 0xff, (id >> 8) & 0xff, ...new Array(16).fill(0)];
    const modelid = look.map((b) => b.toString(16).padStart(2, '0')).join('');
    statusEl.textContent = 'Loading model…';
    try {
      const g = await bridgeCall('zone.mobGlb', { modelid });
      if (!g || !g.ok) { statusEl.textContent = `Model ${id}: ${g?.error || 'not found'}`; return; }
      const r = _canvas.getBoundingClientRect();
      await dropMobOnViewport({ poolid: 0, modelid, name, family: null }, r.left + r.width / 2, r.top + r.height / 2);
      close();
    } catch (e) { statusEl.textContent = `Failed: ${e.message}`; }
  };
  ov.querySelector('#nm-create').onclick = create;
  modelEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') modelEl.focus(); });
}

// ── Custom NPCs ───────────────────────────────────────────────────────────────
// A custom NPC registers an already-placed entity model (a model id in the FTABLE)
// as a zone NPC: it records the row in the project (custom-npcs.json), stages the
// npc_list SQL for Package Project, and best-effort inserts it into the live DB. The
// same registry feeds the cutscene author's "Custom NPCs" actor group.
//
// ``status`` is npc_list.STATUS_TYPE — Normal / Disappear / Invisible / Cutscene only.
// Editable on create and inline on each Asset Browser row.

// Values are LSB STATUS_TYPE. Only two matter for a custom NPC:
//   0 Normal        — SpawnNPCs pushes it every tick → stands in the zone.
//   6 Cutscene only — never pushed; cutscenes CHARREQ it on demand (recommended).
// 2/3 are retail scripted-hidden states — on this server they behave like 6
// (not pushed) and exist only so imported retail rows round-trip.
const CN_STATUS_OPTS = [
  { v: 0, label: 'Normal — stands in zone' },
  { v: 2, label: 'Disappear (scripted hide)' },
  { v: 3, label: 'Invisible (scripted hide)' },
  { v: 6, label: 'Cutscene only ★' },
];
function cnStatusOptionsHtml(selected) {
  const sel = Number.isFinite(+selected) ? +selected : 0;
  const known = CN_STATUS_OPTS.some((o) => o.v === sel);
  const opts = CN_STATUS_OPTS.map((o) =>
    `<option value="${o.v}"${known && o.v === sel ? ' selected' : ''}>${o.label}</option>`);
  // Unknown value (hand-edited SQL / future STATUS_TYPE): show it honestly instead
  // of silently rendering as "Normal".
  if (!known) opts.push(`<option value="${sel}" selected>status ${sel}</option>`);
  return opts.join('');
}
function cnStatusLabel(v) {
  const o = CN_STATUS_OPTS.find((x) => x.v === +v);
  return o ? o.label : `status ${+v}`;
}

export async function loadCustomNpcs() {
  if (!bridgeOnline()) {
    cbGrid.innerHTML = '<div class="cb-msg">Bridge offline — run via `xi gui zone`</div>';
    if (cbStatusBar) cbStatusBar.textContent = '';
    return;
  }
  cbGrid.innerHTML = '<div class="cb-msg cb-spin">Loading custom NPCs…</div>';
  try {
    const zoneId = _getCurrentZoneId ? _getCurrentZoneId() : null;
    const r = await bridgeCall('customNpc.list', zoneId ? { zoneId } : {});
    cnData = r;
    const el = document.getElementById('cb-count-customnpcs');
    if (el) el.textContent = (r.count || 0).toLocaleString();
    if (cbCat === 'customnpcs') cnRender();
  } catch (e) {
    if (cbCat === 'customnpcs') cbGrid.innerHTML = `<div class="cb-msg">Failed: ${cbEsc(e.message)}</div>`;
  }
}

function cnRowsHtml(npcs) {
  return npcs.map((n) => {
    const st = (n.status != null) ? +n.status : 0;
    // dbStatus (when the bridge could reach MariaDB) is the LIVE npc_list row. If it
    // differs from the registry, the zone is running an old value → restart needed.
    const drift = (n.dbStatus != null && +n.dbStatus !== st)
      ? ` · ⚠ DB row is ${cbEsc(cnStatusLabel(n.dbStatus))} — restart the server to apply`
      : '';
    return `<div class="sfx-row cn-row" data-npcid="${n.npcid}" title="${cbEsc(n.name)} · model ${cbEsc(n.modelid)} · ${cbEsc(n.npcidHex)} · ${cbEsc(cnStatusLabel(st))}${drift}">`
      + `<span class="sfx-ico material-symbols-outlined">person_pin</span>`
      + `<span class="sfx-name">${cbEsc(n.name)}${(n.dbStatus != null && +n.dbStatus !== st) ? ' <span class="cn-drift" title="Registry and live DB status differ — restart the server">⚠</span>' : ''}</span>`
      + `<span class="sfx-fmeta">model ${cbEsc(n.modelid)} · ${cbEsc(n.zoneName || ('zone ' + ((n.npcid >> 12) & 0xFFF)))}</span>`
      + `<select class="cn-status" data-npcid="${n.npcid}" data-name="${cbEsc(n.name)}" title="npc_list status — ★ Cutscene only: hidden in the zone, fetched automatically by cutscenes. Normal: stands in the zone permanently.">${cnStatusOptionsHtml(st)}</select>`
      + `<button class="cn-del cs-mini" data-npcid="${n.npcid}" data-name="${cbEsc(n.name)}" title="Remove this custom NPC">×</button>`
      + `</div>`;
  }).join('');
}

export function cnRender() {
  if (!cnData) { loadCustomNpcs(); return; }
  if (!cnData.ok) { cbGrid.innerHTML = `<div class="cb-msg">Failed: ${cbEsc(cnData.error || 'unknown')}</div>`; return; }
  const q = (cbSearchEl?.value || '').trim().toLowerCase();
  let npcs = cnData.npcs || [];
  if (q) npcs = npcs.filter((n) => (n.name || '').toLowerCase().includes(q)
    || String(n.modelid).includes(q) || (n.npcidHex || '').toLowerCase().includes(q)
    || cnStatusLabel(n.status).toLowerCase().includes(q));
  const zoneName = (_getCurrentZoneName && _getCurrentZoneName()) || '';
  if (cbStatusBar) cbStatusBar.textContent = zoneName
    ? `${npcs.length.toLocaleString()} custom NPC${npcs.length === 1 ? '' : 's'} · ${cbEsc(zoneName)}`
    : `${npcs.length.toLocaleString()} custom NPC${npcs.length === 1 ? '' : 's'}`;
  const newBar = `<div class="cb-mob-newbar"><button id="cb-cn-new" class="load-btn" title="Register a placed model id as a zone NPC">+ New Custom NPC</button></div>`;
  const body = npcs.length
    ? `<div class="sfx-list">${cnRowsHtml(npcs)}</div>`
    : '<div class="cb-msg">No custom NPCs yet — add one to use it in cutscenes.</div>';
  cbGrid.innerHTML = newBar + body;
  cbGrid.querySelectorAll('.cn-del').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteCustomNpc(parseInt(btn.dataset.npcid, 10), btn.dataset.name || '');
    });
  });
  cbGrid.querySelectorAll('.cn-status').forEach((sel) => {
    sel.addEventListener('click', (ev) => ev.stopPropagation());
    sel.addEventListener('change', (ev) => {
      ev.stopPropagation();
      updateCustomNpcStatus(parseInt(sel.dataset.npcid, 10), sel.dataset.name || '', +sel.value, sel);
    });
  });
  document.getElementById('cb-cn-new')?.addEventListener('click', openNewCustomNpcDialog);
}

async function updateCustomNpcStatus(npcid, name, status, selEl) {
  if (!Number.isFinite(npcid)) return;
  const prev = (cnData?.npcs || []).find((n) => +n.npcid === npcid)?.status;
  try {
    const r = await bridgeCall('customNpc.update', { npcid, status });
    if (!r || !r.ok) throw new Error(r?.error || 'update failed');
    // Keep the in-memory list in sync so a re-render doesn't flash the old value.
    if (cnData && Array.isArray(cnData.npcs)) {
      const row = cnData.npcs.find((n) => +n.npcid === npcid);
      if (row) {
        row.status = status;
        if (r.dbWritten) row.dbStatus = status;   // live row replaced too — no drift
      }
    }
    const dbMsg = r.dbWritten ? 'live DB updated' : `DB not written (${r.dbDetail || 'unreachable'})`;
    _setStatus(`Custom NPC "${name}" → ${cnStatusLabel(status)} · ${dbMsg}. Restart the zone for in-game.`);
  } catch (e) {
    if (selEl && prev != null) selEl.value = String(prev);
    _setStatus(`Status update failed: ${e.message}`, true);
  }
}

async function deleteCustomNpc(npcid, name) {
  if (!Number.isFinite(npcid)) return;
  const ok = _xi_confirm
    ? await _xi_confirm('Remove Custom NPC', `Remove "${name}"?\n\nThis drops it from the project + SQL (and the live DB row if reachable).`, 'Remove')
    : window.confirm(`Remove "${name}"?`);
  if (!ok) return;
  try {
    await bridgeCall('customNpc.delete', { npcid });
    cnData = null;
    loadCustomNpcs();
    _setStatus(`Removed custom NPC "${name}".`);
  } catch (e) { _setStatus(`Delete failed: ${e.message}`, true); }
}

async function openNewCustomNpcDialog() {
  if (!bridgeOnline()) { _xi_alert('Bridge Offline', 'Creating a custom NPC needs the backend — run via `xi gui zone`.'); return; }
  const zoneId = _getCurrentZoneId ? _getCurrentZoneId() : null;
  if (!zoneId) { _xi_alert('No Zone', 'Load a zone first, then create a custom NPC for it.'); return; }
  const zoneName = (_getCurrentZoneName && _getCurrentZoneName()) || `zone ${zoneId}`;
  document.getElementById('new-cn-overlay')?.remove();
  const ov = document.createElement('div');
  ov.id = 'new-cn-overlay';
  ov.className = 'nm-overlay';
  ov.innerHTML =
    `<div class="nm-dialog">` +
    `<div class="nm-title">New Custom NPC</div>` +
    `<label class="nm-row"><span>Name</span><input id="cn-name" type="text" placeholder="e.g. Gate Guard" autocomplete="off" maxlength="24" /></label>` +
    `<label class="nm-row"><span>Model ID</span><input id="cn-model" type="number" min="0" placeholder="e.g. 25001" autocomplete="off" /></label>` +
    `<label class="nm-row"><span>Status</span><select id="cn-status-sel">${cnStatusOptionsHtml(6)}</select></label>` +
    `<div class="nm-hint">Uses a model already injected into the FTABLE. Registered in <b>${cbEsc(zoneName)}</b>. <b>Cutscene only</b> keeps it out of the world until an event shows it; <b>Normal</b> is a standing zone NPC.</div>` +
    `<div class="nm-status" id="cn-status"></div>` +
    `<div class="nm-btns"><button id="cn-cancel" class="load-btn">Cancel</button><button id="cn-create" class="nz-create-btn">Create</button></div>` +
    `</div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.querySelector('#cn-cancel').onclick = close;
  const nameEl = ov.querySelector('#cn-name');
  const modelEl = ov.querySelector('#cn-model');
  const statusSel = ov.querySelector('#cn-status-sel');
  const statusEl = ov.querySelector('#cn-status');
  nameEl.focus();
  const create = async () => {
    const name = (nameEl.value || '').trim();
    const modelid = parseInt(modelEl.value, 10);
    const status = parseInt(statusSel.value, 10);
    if (!name) { statusEl.textContent = 'Enter a name.'; return; }
    if (!Number.isFinite(modelid) || modelid < 0) { statusEl.textContent = 'Enter a valid model id.'; return; }
    statusEl.textContent = 'Registering…';
    try {
      // Default CUTSCENE_ONLY (6) — matches retail Lion/Iroha. Never fall back to 0
      // (Normal) on a bad parse or the NPC stands at 0,0,0 in the zone forever.
      const st = Number.isFinite(status) ? status : 6;
      const r = await bridgeCall('customNpc.create', {
        zoneId, zoneName, zone: _getCurrentZoneUrl ? _getCurrentZoneUrl() : undefined,
        name, modelid, status: st,
      });
      if (!r || !r.ok) { statusEl.textContent = `Failed: ${r?.error || 'unknown error'}`; return; }
      close();
      cnData = null;
      if (cbSearchEl) cbSearchEl.value = '';
      loadCustomNpcs();
      const dbMsg = r.dbWritten ? 'live DB row inserted' : `DB not written (${r.dbDetail || 'unreachable'})`;
      const nameMsg = r.nameTableWritten ? 'name DAT updated' : 'name DAT NOT written (will show as "NPC")';
      _setStatus(`Custom NPC "${name}" registered as ${r.npc.npcidHex} (model ${modelid}, ${cnStatusLabel(r.npc.status)}) · ${dbMsg} · ${nameMsg}. Restart the zone. It's now in the cutscene Add-NPC list.`);
    } catch (e) { statusEl.textContent = `Failed: ${e.message}`; }
  };
  ov.querySelector('#cn-create').onclick = create;
  modelEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') modelEl.focus(); });
}

// ── sfx/music import helpers (used by file-input handlers wired in _initAssetBrowserDOM) ──
let _cbSyncClear = null;

export function showSfxCategory() {
  if (assetsPanel && !assetsPanel.classList.contains('open')) { _toggleModal(assetsPanel, assetsBtn); cbLoadCounts(); cbFavCountUpdate(); }
  document.querySelectorAll('.cb-cat').forEach((b) => b.classList.toggle('active', b.dataset.cat === 'sfx'));
  cbCat = 'sfx';
  cbLoad('sfx');
}

async function importSoundFile(file) {
  if (!file) return;
  if (!bridgeOnline()) { await _xi_alert('Bridge Offline', 'Importing sounds needs the backend — run the editor via `xi gui zone`.'); return; }
  _setStatus(`Importing ${file.name}…`);
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    const r = await bridgeCall('audio.importSound', {
      filename: file.name, dataBase64: btoa(bin), format: 'adpcm',
    });
    if (!r || !r.ok) { _showErrorBanner(`Import failed: ${r?.error || 'unknown error'}`); _setStatus(`Import failed: ${r?.error || 'unknown'}`, true); return; }
    sfxcData = null;
    sfxcExpanded.add(`se${String(Math.floor(r.soundId / 1000)).padStart(3, '0')}`);
    if (cbSearchEl) cbSearchEl.value = r.title || String(r.soundId);
    _cbSyncClear?.();
    showSfxCategory();
    _setStatus(`Imported "${r.title}" as soundId ${r.soundId} (${r.file}). Drag it onto the map to place it.`);
  } catch (e) {
    _showErrorBanner(`Import failed: ${e.message}`);
    _setStatus(`Import failed: ${e.message}`, true);
  }
}

export function showMusicCategory() {
  if (assetsPanel && !assetsPanel.classList.contains('open')) { _toggleModal(assetsPanel, assetsBtn); cbLoadCounts(); cbFavCountUpdate(); }
  document.querySelectorAll('.cb-cat').forEach((b) => b.classList.toggle('active', b.dataset.cat === 'music'));
  cbCat = 'music';
  cbLoad('music');
}

async function importMusicFile(file) {
  if (!file) return;
  if (!bridgeOnline()) { await _xi_alert('Bridge Offline', 'Importing music needs the backend — run the editor via `xi gui zone`.'); return; }
  _setStatus(`Importing ${file.name}…`);
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    const r = await bridgeCall('audio.importMusic', {
      filename: file.name, dataBase64: btoa(bin), format: 'adpcm',
    });
    if (!r || !r.ok) { _showErrorBanner(`Import failed: ${r?.error || 'unknown error'}`); _setStatus(`Import failed: ${r?.error || 'unknown'}`, true); return; }
    mcData = null;
    if (cbSearchEl) cbSearchEl.value = r.title || String(r.musicId);
    _cbSyncClear?.();
    showMusicCategory();
    _setStatus(`Imported "${r.title}" as music ${r.musicId} (${r.file}). Assign it to a zone via zone music.`);
  } catch (e) {
    _showErrorBanner(`Import failed: ${e.message}`);
    _setStatus(`Import failed: ${e.message}`, true);
  }
}

// ── Drop handlers ─────────────────────────────────────────────────────────────
export async function buildMobNode(mob, posLocal) {
  const zoneRoot = _getZoneRoot();
  const g = await bridgeCall('zone.mobGlb', { modelid: mob.modelid, poolid: mob.poolid });
  if (!g || !g.ok || !g.bytesBase64) throw new Error(g?.error || 'no model');
  const bin = atob(g.bytesBase64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const loader = _gltfLoader || gltfLoader;
  const gltf = await loader.parseAsync(u.buffer, '');
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const src = Array.isArray(o.material) ? o.material[0] : o.material;
    o.material = new THREE.MeshBasicMaterial({
      map: src.map || null, color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
      transparent: !!src.transparent, opacity: src.opacity ?? 1, alphaTest: src.alphaTest || 0, side: THREE.DoubleSide });
    o.frustumCulled = false;
  });
  const wrap = new THREE.Group();
  wrap.quaternion.copy(zoneRoot.quaternion);
  wrap.scale.copy(zoneRoot.scale);
  wrap.add(gltf.scene);
  const node = new THREE.Group();
  node.rotation.order = 'ZYX';
  node.add(wrap);
  if (posLocal) node.position.copy(posLocal);
  node.updateMatrix();
  const base = (mob.name || `pool${mob.poolid}`).replace(/[^A-Za-z0-9_]+/g, '_');
  node.name = _uniquePlacementName(`mob_${base}`);
  node.userData = {
    mob: { poolid: mob.poolid, modelid: (g.modelid || mob.modelid || '').toLowerCase(),
           name: mob.name || '', family: mob.family ?? null },
    original: { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() },
  };
  if (gltf.animations && gltf.animations.length) {
    const mixer = new THREE.AnimationMixer(gltf.scene);
    const idle = (g.meta && g.meta.idle) ? gltf.animations.find((c) => c.name === g.meta.idle) : null;
    mixer.clipAction(idle || gltf.animations[0]).play();
    node.userData.mobMixer = mixer;
  }
  return { node, entry: { node, name: node.name, isMob: true }, parent: zoneRoot };
}

export async function dropMobOnViewport(mob, clientX, clientY) {
  const zoneRoot = _getZoneRoot();
  if (!zoneRoot) { _setStatus('drop: no zone loaded', true); return; }
  if (!_getEditMode()) { _setStatus('Switch to Edit mode to add mobs', true); return; }
  if (!bridgeOnline()) { _setStatus('Placing mobs needs the backend — run via `xi gui zone`', true); return; }
  const r = _canvas.getBoundingClientRect();
  const nx = ((clientX - r.left) / r.width) * 2 - 1;
  const ny = -((clientY - r.top) / r.height) * 2 + 1;
  _raycaster.setFromCamera({ x: nx, y: ny }, _camera);
  const hits = _raycaster.intersectObject(zoneRoot, true)
    .filter(h => _placementSet.has(h.object.parent ?? h.object) || h.object.parent?.userData?.zoneMesh || h.object.userData?.zoneMesh);
  let hitPoint = hits.length ? hits[0].point.clone() : null;
  if (!hitPoint) {
    const originW = zoneRoot.localToWorld(new THREE.Vector3());
    const dist = Math.min(Math.max(_camera.position.distanceTo(originW), 10), 500);
    hitPoint = _raycaster.ray.at(dist, new THREE.Vector3());
  }
  const posLocal = zoneRoot.worldToLocal(hitPoint.clone());
  _setStatus(`Loading ${mob.name || 'mob'} model…`);
  try {
    const item = await buildMobNode(mob, posLocal);
    _commitPastedItems([item], `placed mob ${mob.name || ('pool ' + mob.poolid)} — Publish writes the spawn to the DB`);
    _setActiveTab('mobs');
  } catch (e) {
    _setStatus(`mob: ${e.message}`, true);
  }
}

export function dropSoundOnViewport(snd, clientX, clientY) {
  const zoneRoot = _getZoneRoot();
  if (!zoneRoot) { _setStatus('drop: no zone loaded', true); return; }
  if (!_getEditMode()) { _setStatus('Switch to Edit mode to add sounds', true); return; }
  const soundId = (snd?.soundId | 0);
  if (!soundId) { _setStatus('drop: no sound id', true); return; }
  const r = _canvas.getBoundingClientRect();
  const nx = ((clientX - r.left) / r.width) * 2 - 1;
  const ny = -((clientY - r.top) / r.height) * 2 + 1;
  _raycaster.setFromCamera({ x: nx, y: ny }, _camera);
  const hits = _raycaster.intersectObject(zoneRoot, true)
    .filter(h => _placementSet.has(h.object.parent ?? h.object) || h.object.parent?.userData?.zoneMesh);
  let hitPoint = hits.length ? hits[0].point.clone() : null;
  if (!hitPoint) {
    const originW = zoneRoot.localToWorld(new THREE.Vector3());
    const dist = Math.min(Math.max(_camera.position.distanceTo(originW), 10), 500);
    hitPoint = _raycaster.ray.at(dist, new THREE.Vector3());
  }
  const folder = String(Math.floor(soundId / 1000)).padStart(3, '0');
  const file = snd.file || `se${folder}/se${String(soundId).padStart(6, '0')}.spw`;
  const node = new THREE.Group();
  node.rotation.order = 'ZYX';
  node.position.copy(zoneRoot.worldToLocal(hitPoint.clone()));
  node.quaternion.identity(); node.scale.set(1, 1, 1); node.updateMatrix();
  node.visible = false;
  node.userData.effect = { sound: true, added: true, soundId, soundFile: file, repeat: false };
  node.name = _uniquePlacementName(`sound se${String(soundId).padStart(6, '0')}`);
  node.userData.original = { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() };
  const entry = { node, name: node.name, isEffect: true, isSound: true };
  _commitAddedSound(node, entry, `placed sound ${file} — editor-only (write-back is Phase 2)`);
}

export function dropGlbOnViewport(asset, clientX, clientY) {
  // alias kept for symmetry — the actual implementation stays in main.js as dropAssetOnViewport
  // and is called from the canvas drop handler there.
  throw new Error('dropGlbOnViewport: call dropAssetOnViewport in main.js instead');
}

// ── DOM init (called by initAssetBrowser) ─────────────────────────────────────
function _initAssetBrowserDOM() {
  assetsBtn      = document.getElementById('assets-btn');
  assetsPanel    = document.getElementById('assets-panel');
  cbGrid         = document.getElementById('cb-grid');
  cbSearchEl     = document.getElementById('cb-search');
  cbZoneFilterEl = document.getElementById('cb-zone-filter');
  cbSoundFileEl  = document.getElementById('cb-sound-file');
  cbMusicFileEl  = document.getElementById('cb-music-file');
  cbStatusBar    = document.getElementById('cb-statusbar');

  mcpBar    = document.getElementById('cb-music-player');
  mcpNow    = document.getElementById('mcp-now');
  mcpPlay   = document.getElementById('mcp-play');
  mcpPause  = document.getElementById('mcp-pause');
  mcpStopB  = document.getElementById('mcp-stop');
  mcpCur    = document.getElementById('mcp-cur');
  mcpDurEl  = document.getElementById('mcp-dur');
  mcpSeek   = document.getElementById('mcp-seek');
  mcpVol    = document.getElementById('mcp-vol');
  mcpVolIco = document.getElementById('mcp-vol-ico');

  mcVolume = Math.min(1, Math.max(0, parseFloat(_loadSetting('mcVolume', '1')) || 1));

  // Persist panel size
  const savedW = _loadSetting('assetsPanelW', '');
  const savedH = _loadSetting('assetsPanelH', '');
  if (savedW && assetsPanel) assetsPanel.style.width  = savedW;
  if (savedH && assetsPanel) assetsPanel.style.height = savedH;
  if (assetsPanel) {
    new ResizeObserver(() => {
      if (assetsPanel.offsetWidth > 0) {
        _saveSetting('assetsPanelW', assetsPanel.offsetWidth  + 'px');
        _saveSetting('assetsPanelH', assetsPanel.offsetHeight + 'px');
      }
    }).observe(assetsPanel);
  }

  // Lazy image observer
  cbImgObs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const img = e.target;
      if (e.isIntersecting) {
        if (!img.getAttribute('src')) {
          img.onload = img.onerror = () => img.classList.add('cb-ok');
          img.src = img.dataset.src;
        }
      } else if (img.getAttribute('src') && !img.classList.contains('cb-ok')) {
        img.removeAttribute('src');
      }
    }
  }, { root: cbGrid, rootMargin: '120px' });

  cbScrollObs = new IntersectionObserver((entries) => {
    if (entries[0]?.isIntersecting) cbAppendBatch();
  }, { root: cbGrid, rootMargin: '300px' });

  // Music player bar wiring
  mcpPlay?.addEventListener('click', mcBarPlay);
  mcpPause?.addEventListener('click', mcBarPause);
  mcpStopB?.addEventListener('click', mcStop);
  if (mcpSeek) {
    const seekTo = () => { if (mcAudio && mcDur) { mcAudio.currentTime = (mcpSeek.value / 1000) * mcDur; mcUpdateProgress(); } };
    mcpSeek.addEventListener('pointerdown', () => { mcSeeking = true; });
    mcpSeek.addEventListener('input', () => { mcSeeking = true; seekTo(); });
    mcpSeek.addEventListener('change', () => { seekTo(); mcSeeking = false; });
    mcpSeek.addEventListener('pointerup', () => { mcSeeking = false; });
  }
  mcpVol?.addEventListener('input', () => {
    mcVolume = (parseInt(mcpVol.value, 10) || 0) / 100;
    mcMuted = false;
    _saveSetting('mcVolume', String(mcVolume));
    mcApplyVolume();
  });
  mcpVolIco?.addEventListener('click', () => { mcMuted = !mcMuted; mcApplyVolume(); });
  mcApplyVolume();
  mcUpdateBar();
  mcUpdateProgress();

  // Assets panel open/close
  if (assetsBtn) assetsBtn.onclick = () => {
    _toggleModal(assetsPanel, assetsBtn);
    if (assetsPanel?.classList.contains('open')) { cbLoadCounts(); cbFavCountUpdate(); cbLoad(cbCat); }
    else { mcUnload(); sfxcStop(); }
  };
  document.querySelector('[data-close="assets-panel"]')?.addEventListener('click', () => { mcUnload(); sfxcStop(); });

  // Category tab buttons
  for (const btn of document.querySelectorAll('.cb-cat')) {
    btn.onclick = () => {
      document.querySelectorAll('.cb-cat').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      cbCat = btn.dataset.cat;
      if (cbZoneFilterEl) cbZoneFilterEl.value = '';
      cbLoad(cbCat);
    };
  }

  // Search + clear
  const cbClearBtn = document.getElementById('cb-clear');
  function cbSyncClear() { if (cbClearBtn) cbClearBtn.style.display = cbSearchEl?.value ? '' : 'none'; }
  _cbSyncClear = cbSyncClear;

  let cbSearchTimer = null;
  cbSearchEl?.addEventListener('input', () => {
    cbSyncClear();
    clearTimeout(cbSearchTimer);
    cbSearchTimer = setTimeout(cbReRender, 200);
  });
  cbClearBtn?.addEventListener('click', () => {
    if (cbSearchEl) cbSearchEl.value = '';
    cbSyncClear();
    cbReRender();
    cbSearchEl?.focus();
  });

  cbZoneFilterEl?.addEventListener('change', () => cbRender(cbCurrent()));

  // Drag-to-viewport
  const isXiDrag = (ev) => ev.dataTransfer.types.includes('application/x-xi-asset')
    || ev.dataTransfer.types.includes('application/x-xi-sound')
    || ev.dataTransfer.types.includes('application/x-xi-mob');
  document.addEventListener('dragover', (ev) => {
    if (isXiDrag(ev)) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    }
  });
  _canvas.addEventListener('dragover', (ev) => {
    if (!isXiDrag(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    _canvas.classList.add('cb-drop-target');
  });
  _canvas.addEventListener('dragleave', (ev) => {
    if (!_canvas.contains(ev.relatedTarget)) _canvas.classList.remove('cb-drop-target');
  });
  _canvas.addEventListener('drop', async (ev) => {
    _canvas.classList.remove('cb-drop-target');
    const sndRaw = ev.dataTransfer.getData('application/x-xi-sound');
    if (sndRaw) {
      ev.preventDefault();
      let snd; try { snd = JSON.parse(sndRaw); } catch { return; }
      dropSoundOnViewport(snd, ev.clientX, ev.clientY);
      return;
    }
    const mobRaw = ev.dataTransfer.getData('application/x-xi-mob');
    if (mobRaw) {
      ev.preventDefault();
      let mob; try { mob = JSON.parse(mobRaw); } catch { return; }
      await dropMobOnViewport(mob, ev.clientX, ev.clientY);
      return;
    }
    const raw = ev.dataTransfer.getData('application/x-xi-asset');
    if (!raw) return;
    ev.preventDefault();
    let asset;
    try { asset = JSON.parse(raw); } catch { return; }
    // dropAssetOnViewport stays in main.js — call back up via the injected callback
    await _commitAdded(asset, ev.clientX, ev.clientY);
  });

  // Sound + music file input handlers
  cbSoundFileEl?.addEventListener('change', () => {
    const f = cbSoundFileEl.files?.[0];
    cbSoundFileEl.value = '';
    importSoundFile(f);
  });
  cbMusicFileEl?.addEventListener('change', () => {
    const f = cbMusicFileEl.files?.[0];
    cbMusicFileEl.value = '';
    importMusicFile(f);
  });

  cbFavCountUpdate();
}
