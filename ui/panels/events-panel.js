// events-panel.js — EVTS tab: event actor tree, dialogue inspector, zone peek.
// Extracted from main.js. Import initEventsPanel and call it once all deps are ready.

import { bridgeOnline, bridgeCall } from '../ffxi/bridge.js';
import { loadZoneSetting, saveZoneSetting, loadSetting, saveSetting } from '../editor/settings.js';
import { csCloseSequencer, csStop, csIsAuthorMode, csAuthorRefresh, CS_BEAT_META, CS_LANE_ORDER, csLaneOf } from '../viewport/cutscene.js';
import { openCutsceneAuthorFrom } from './cutscene-author.js';

// ── Injected dependencies (set by initEventsPanel) ───────────────────────────
let _getCurrentZoneUrl;   // () => currentZoneUrl
let _currentZoneId;       // () => currentZoneId value
let _getPanelEl;          // () => _panelEl DOM element
let _getZonesData;        // () => zonesData array
let _getCustomZonesData;  // () => customZonesData array
let _openModal;           // openModal(modal, anchor)
let _openContextMenu;     // openContextMenu(e, buildItems)
let _fetchEventCutscene;  // fetchEventCutscene(key, actorId, eventId)
let _renderCutsceneView;  // renderCutsceneView(key)
let _loadZone;            // loadZone(path)

export function initEventsPanel({
  getCurrentZoneUrl,
  currentZoneId,
  getPanelEl,
  getZonesData,
  getCustomZonesData,
  openModal,
  openContextMenu,
  fetchEventCutscene,
  renderCutsceneView,
  loadZone,
}) {
  _getCurrentZoneUrl   = getCurrentZoneUrl;
  _currentZoneId       = currentZoneId;
  _getPanelEl          = getPanelEl;
  _getZonesData        = getZonesData;
  _getCustomZonesData  = getCustomZonesData;
  _openModal           = openModal;
  _openContextMenu     = openContextMenu;
  _fetchEventCutscene  = fetchEventCutscene;
  _renderCutsceneView  = renderCutsceneView;
  _loadZone            = loadZone;

  _wireEventListeners();
}

// ── Category metadata ─────────────────────────────────────────────────────────
const EVT_CAT_META = {
  Cutscene: { color: '#c792ea' },
  Menu:     { color: '#82aaff' },
  Dialogue: { color: '#7fd88f' },
  Door:     { color: '#f7c873' },
  Magic:    { color: '#ff8fcf' },
  Script:   { color: '#9aa3b2' },
  Empty:    { color: '#5b6270' },
};
const EVT_CAT_ORDER = ['Cutscene', 'Menu', 'Dialogue', 'Door', 'Magic', 'Script', 'Empty'];

// ── Module state ──────────────────────────────────────────────────────────────
const eventsState = {
  loadedFor: null, loading: false, data: null, error: null,
  filter: '', cat: '', expanded: new Set(),
  pinned: new Set(), pinsLoadedFor: null, pinnedOpen: true,
};

// Per-event decoded dialogue + opcodes, fetched lazily when a dialogue event is clicked
// and shown in the #evt-dialog-modal window. key = `${actorId}:${eventId}`.
const eventsDialog = new Map();          // key → { state:'loading'|'done'|'error', lines?, error? }
const eventsOpcodes = new Map();         // key → { state, opcodes?, error? }  (the Opcodes tab)
// csLetterbox is managed in cutscene.js (imported as getCsLetterbox())
export const eventsCutscene = new Map(); // key → { state, data?, error? }     (the Timeline tab)

let eventsDialogModalKey = null;         // key currently shown in the dialogue modal
let eventsDialogView = 'lines';          // 'info' | 'timeline' | 'lines' | 'opcodes' — active tab
let eventsDialogHasLines = false;        // does the open event print dialogue? (gates the Lines tab)
let eventsDialogIsCutscene = false;      // is the open event a cutscene? (gates the Timeline tab)

// ── DOM element references ────────────────────────────────────────────────────
const evtListEl    = document.getElementById('evtlist');
const evtCountEl   = document.getElementById('evtcount');
const evtCatsEl    = document.getElementById('evt-cats');
const evtFilterEl  = document.getElementById('evt-filter');
const evtRefreshBtn = document.getElementById('evt-refresh');
const evtExpandBtn  = document.getElementById('evt-expand');
// csData, csFrame, csPlaying etc. are managed in cutscene.js
const evtDialogModal   = document.getElementById('evt-dialog-modal');
const evtDialogTitleEl = document.getElementById('evt-dialog-title');
const evtDialogSubEl   = document.getElementById('evt-dialog-sub');
// evt-dialog-meta was removed — event metadata now lives in the Info tab body.
const evtDialogBodyEl  = document.getElementById('evt-dialog-modal-body');

const evtZonePeekModal = document.getElementById('evt-zone-peek-modal');
const evtZonePeekTitle = document.getElementById('evt-zone-peek-title');
const evtZonePeekBody  = document.getElementById('evt-zone-peek-body');
const zonePeekCache = new Map();   // zoneId → { state:'loading'|'done'|'error', data?, error? }

// ── HTML-escape helper ────────────────────────────────────────────────────────
export function evtEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── Events loading ────────────────────────────────────────────────────────────
export function invalidateEvents() {
  const currentZoneUrl = _getCurrentZoneUrl();
  eventsState.loadedFor = null;
  eventsState.data = null;
  eventsState.error = null;
  eventsState.expanded.clear();
  eventsDialog.clear();
  eventsOpcodes.clear();
  eventsCutscene.clear();
  // Only close the sequencer when it's showing a retail cutscene. In author
  // mode the user has an in-progress edit + is likely publishing — closing
  // the sequencer would rip their timeline out from under them.
  if (!csIsAuthorMode()) {
    csCloseSequencer();
    eventsDialogModalKey = null;
    if (evtDialogModal) evtDialogModal.classList.remove('open');
  }
  const panelEl = _getPanelEl ? _getPanelEl() : null;
  if (panelEl && panelEl.getAttribute('data-active-tab') === 'evts') {
    ensureEventsLoaded();
  } else if (evtListEl) {
    evtListEl.innerHTML = '';
    if (evtCountEl) evtCountEl.textContent = '';
    if (evtCatsEl) evtCatsEl.innerHTML = '';
  }
}

export function ensureEventsLoaded() {
  const currentZoneUrl = _getCurrentZoneUrl();
  if (!currentZoneUrl) { renderEventsMessage('Load a zone to see its events.'); return; }
  if (eventsState.loading) return;
  if (eventsState.loadedFor === currentZoneUrl && (eventsState.data || eventsState.error)) {
    renderEvents();
    return;
  }
  loadEvents();
}

async function loadEvents() {
  const zoneUrl = _getCurrentZoneUrl();
  if (!zoneUrl) { renderEventsMessage('Load a zone to see its events.'); return; }
  if (!bridgeOnline()) {
    eventsState.data = null;
    eventsState.error = 'Events need the XI backend. Launch the editor with `xi gui zone`.';
    eventsState.loadedFor = zoneUrl;
    renderEvents();
    return;
  }
  eventsState.loading = true;
  eventsState.error = null;
  renderEventsMessage('Parsing event DAT…');

  let r = null, err = null;
  try {
    r = await bridgeCall('zone.events', { zone: zoneUrl, zoneId: _currentZoneId() });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  eventsState.loading = false;                  // always clear, even if the zone changed

  if (zoneUrl !== _getCurrentZoneUrl()) {       // switched zones mid-fetch — discard, reload current
    ensureEventsLoaded();
    return;
  }
  if (err) { eventsState.data = null; eventsState.error = err; }
  else if (r && r.ok) { eventsState.data = r; eventsState.error = null; }
  else { eventsState.data = null; eventsState.error = (r && r.error) || 'Failed to parse events.'; }
  eventsState.loadedFor = zoneUrl;
  renderEvents();
}

function renderEventsMessage(msg) {
  if (!evtListEl) return;
  evtListEl.innerHTML = `<li class="evt-msg">${evtEsc(msg)}</li>`;
  if (evtCountEl) evtCountEl.textContent = '';
}

function renderEventsCats() {
  if (!evtCatsEl) return;
  const data = eventsState.data;
  if (!data) { evtCatsEl.innerHTML = ''; return; }
  const by = data.stats.byCategory || {};
  const total = data.stats.eventCount || 0;
  const chips = [
    `<button class="evt-cat-chip${eventsState.cat === '' ? ' active' : ''}" data-cat="">All <b>${total}</b></button>`,
  ];
  for (const c of EVT_CAT_ORDER) {
    const n = by[c] || 0;
    if (!n) continue;
    const col = EVT_CAT_META[c]?.color || '#888';
    chips.push(
      `<button class="evt-cat-chip${eventsState.cat === c ? ' active' : ''}" data-cat="${c}" style="--cc:${col}">`
      + `<span class="evt-cat-dot"></span>${c} <b>${n}</b></button>`);
  }
  evtCatsEl.innerHTML = chips.join('');
}

// ── Pinned events ──────────────────────────────────────────────────────────────
// A per-zone bookmark list: right-click any event → Pin, and it gets its own
// collapsible group at the very top of the tree (across all actors/categories).
// Persisted per zone in localStorage so pins survive reloads + zone switches.
function ensurePinsLoaded() {
  const currentZoneUrl = _getCurrentZoneUrl();
  if (eventsState.pinsLoadedFor === currentZoneUrl) return;
  const arr = loadZoneSetting(currentZoneUrl, 'eventPins');
  eventsState.pinned = new Set(Array.isArray(arr) ? arr : []);
  eventsState.pinsLoadedFor = currentZoneUrl;
}
function eventPinKey(actorId, eventId) { return `${actorId}:${eventId}`; }
function isEventPinned(actorId, eventId) {
  ensurePinsLoaded();
  return eventsState.pinned.has(eventPinKey(actorId, eventId));
}
function toggleEventPin(actorId, eventId) {
  const currentZoneUrl = _getCurrentZoneUrl();
  ensurePinsLoaded();
  const key = eventPinKey(actorId, eventId);
  if (eventsState.pinned.has(key)) eventsState.pinned.delete(key);
  else { eventsState.pinned.add(key); eventsState.pinnedOpen = true; }   // pinning reveals the group
  saveZoneSetting(currentZoneUrl, 'eventPins', [...eventsState.pinned]);
  renderEvents();
}
function clearEventPins() {
  const currentZoneUrl = _getCurrentZoneUrl();
  ensurePinsLoaded();
  if (!eventsState.pinned.size) return;
  eventsState.pinned.clear();
  saveZoneSetting(currentZoneUrl, 'eventPins', []);
  renderEvents();
}

// Build one event row's HTML. Used for both normal actor children and the Pinned
// group; `showActor` swaps the event hex for the owning actor's name (the pinned
// group lists events from many actors, so it needs that context).
function evtEventRowHtml(a, e, { showActor = false } = {}) {
  const col = EVT_CAT_META[e.category]?.color || '#888';
  const hasDlg = e.dialogCount > 0;
  const key = eventPinKey(a.actorId, e.eventId);
  const active = eventsDialogModalKey === key;
  const pinned = eventsState.pinned.has(key);
  const tip = `event ${e.eventId} (0x${e.eventIdHex}) — ${e.category}`
    + (hasDlg ? `, ${e.dialogCount} dialogue line${e.dialogCount === 1 ? '' : 's'}` : '')
    + `, ${e.opcodeCount} opcodes @0x${e.offset.toString(16)} — click to inspect, right-click to ${pinned ? 'unpin' : 'pin'}`;
  return `<li class="evt-event${hasDlg ? ' has-dialog' : ''}${active ? ' active' : ''}${pinned ? ' pinned' : ''}"`
    + ` data-actor="${a.actorId}" data-event="${e.eventId}" style="--cc:${col}" title="${evtEsc(tip)}">`
    + `<span class="evt-badge">${e.category}</span>`
    + `<span class="evt-ev-id">Event ${e.eventId}</span>`
    + (showActor
        ? `<span class="evt-pin-actor">${a.name ? evtEsc(a.name) : a.actorIdHex}</span>`
        : `<span class="evt-ev-hex">0x${e.eventIdHex}</span>`)
    + (hasDlg ? `<span class="evt-ev-dlgico material-symbols-outlined">chat_bubble</span>` : '')
    + (pinned ? `<span class="evt-pin-ico material-symbols-outlined" title="Pinned">push_pin</span>` : '')
    + `</li>`;
}

function renderEvents() {
  renderEventsCats();
  if (!evtListEl) return;
  if (eventsState.loading) return;
  if (eventsState.error) { renderEventsMessage(eventsState.error); return; }
  const data = eventsState.data;
  if (!data) { renderEventsMessage('No event data.'); return; }
  if (!data.actors.length) {
    renderEventsMessage('This zone has no events.');
    if (evtCountEl) evtCountEl.textContent = '(0)';
    return;
  }

  ensurePinsLoaded();
  const q = eventsState.filter.trim().toLowerCase();
  const catF = eventsState.cat;
  const autoExpand = q.length > 0;   // searching reveals matched events without manual expand

  // Pinned group: a curated cross-category bookmark list, so it ignores the category
  // chip (it would defeat the purpose) but still narrows to the text search.
  const pinnedRows = [];
  if (eventsState.pinned.size) {
    for (const a of data.actors) {
      const nameLc = (a.name || '').toLowerCase();
      for (const e of a.events) {
        if (!eventsState.pinned.has(eventPinKey(a.actorId, e.eventId))) continue;
        const textOk = !q || nameLc.includes(q) || a.actorIdHex.toLowerCase().includes(q)
          || String(e.eventId).includes(q) || e.eventIdHex.toLowerCase().includes(q)
          || e.category.toLowerCase().includes(q);
        if (textOk) pinnedRows.push(evtEventRowHtml(a, e, { showActor: true }));
      }
    }
  }
  const pinnedParts = [];
  if (pinnedRows.length) {
    const open = eventsState.pinnedOpen;
    pinnedParts.push(
      `<li class="evt-actor evt-pinned-group${open ? ' open' : ''}" data-pinned="1">`
      + `<div class="evt-actor-head">`
      +   `<span class="evt-caret material-symbols-outlined">chevron_right</span>`
      +   `<span class="evt-pin-ico material-symbols-outlined">push_pin</span>`
      +   `<span class="evt-actor-name">Pinned</span>`
      +   `<span class="evt-actor-count">${pinnedRows.length}</span>`
      + `</div>`);
    if (open) pinnedParts.push(`<ul class="evt-events">${pinnedRows.join('')}</ul>`);
    pinnedParts.push('</li>');
  }

  const parts = [];
  let shownActors = 0, shownEvents = 0;
  for (const a of data.actors) {
    const hex = a.actorIdHex.toLowerCase();
    const nameLc = (a.name || '').toLowerCase();
    const actorMatches = !q || nameLc.includes(q) || hex.includes(q) || String(a.targetIndex).includes(q);
    const evs = [];
    for (const e of a.events) {
      if (catF && e.category !== catF) continue;
      const textOk = !q || actorMatches
        || String(e.eventId).includes(q)
        || e.eventIdHex.toLowerCase().includes(q)
        || e.category.toLowerCase().includes(q);
      if (textOk) evs.push(e);
    }
    if (!evs.length) continue;
    shownActors++; shownEvents += evs.length;

    const expanded = autoExpand || eventsState.expanded.has(a.actorId);
    const label = a.name ? evtEsc(a.name) : a.actorIdHex;
    const idTag = a.name ? `<span class="evt-actor-id">${a.actorIdHex}</span>` : '';
    const presentCats = new Set(a.events.map((e) => e.category));
    const dots = EVT_CAT_ORDER.filter((c) => presentCats.has(c))
      .map((c) => `<span class="evt-dot" style="background:${EVT_CAT_META[c]?.color || '#888'}" title="${c}"></span>`)
      .join('');

    parts.push(
      `<li class="evt-actor${expanded ? ' open' : ''}" data-actor="${a.actorId}">`
      + `<div class="evt-actor-head">`
      +   `<span class="evt-caret material-symbols-outlined">chevron_right</span>`
      +   `<span class="evt-actor-name">${label}</span>`
      +   idTag
      +   `<span class="evt-dots">${dots}</span>`
      +   `<span class="evt-actor-count">${evs.length}</span>`
      + `</div>`);

    if (expanded) {
      const rows = evs.map((e) => evtEventRowHtml(a, e)).join('');
      parts.push(`<ul class="evt-events">${rows}</ul>`);
    }
    parts.push('</li>');
  }

  evtListEl.innerHTML = (pinnedParts.join('') + parts.join(''))
    || '<li class="evt-msg">No events match the filter.</li>';
  if (evtCountEl) {
    const totA = data.stats.actorCount, totE = data.stats.eventCount;
    evtCountEl.textContent = (q || catF)
      ? `(${shownActors}/${totA} • ${shownEvents}/${totE})`
      : `(${totA} actors • ${totE} events)`;
  }
}

export function openEventDialog(actorId, eventId, anchorEl) {
  if (!Number.isFinite(actorId) || !Number.isFinite(eventId)) return;
  const key = `${actorId}:${eventId}`;
  eventsDialogModalKey = key;
  csStop();   // fresh playback per opened event (frame resets when sequencer opens)

  // Title + sub-header from the event tree.
  const actor = eventsState.data?.actors.find((a) => a.actorId === actorId);
  const ev = actor?.events.find((x) => x.eventId === eventId);
  const who = actor ? (actor.name || actor.actorIdHex) : `0x${(actorId >>> 0).toString(16).toUpperCase()}`;
  if (evtDialogTitleEl) evtDialogTitleEl.textContent = `${who} — Event ${eventId}`;
  eventsDialogHasLines = !!(ev && ev.dialogCount > 0);
  // Colour the sub-header's underline by the event's category (Dialogue=green, Cutscene=purple…).
  if (evtDialogSubEl) evtDialogSubEl.style.setProperty('--cc', (ev && EVT_CAT_META[ev.category]?.color) || '#2a2a31');
  eventsDialogIsCutscene = !!(ev && ev.isCutscene);
  // Lines tab is conditional — only when the event prints dialogue. The cutscene timeline is
  // merged into the Info tab (shown there for cutscene events), so there's no separate tab.
  const linesTab = evtDialogModal?.querySelector('.evt-dlg-tab[data-view="lines"]');
  if (linesTab) linesTab.hidden = !eventsDialogHasLines;

  if (evtDialogModal) { evtDialogModal.style.width = '880px'; evtDialogModal.style.height = '500px'; _openModal(evtDialogModal, anchorEl); }   // reset any prior drag-resize
  // Pick the most relevant default view: cutscene → Info (metadata + timeline), dialogue → Lines, else Opcodes.
  showDialogView(eventsDialogIsCutscene ? 'info' : (eventsDialogHasLines ? 'lines' : 'opcodes'));
  renderEvents();              // refresh the active-row highlight
}

// Switch the modal between Info / Timeline / Lines / Opcodes; lazy-fetches the view's data.
export function showDialogView(view) {
  if (view === 'timeline') view = 'info';                       // timeline is merged into Info now
  if (view === 'lines' && !eventsDialogHasLines) view = 'opcodes';
  eventsDialogView = view;
  if (evtDialogModal) {
    for (const b of evtDialogModal.querySelectorAll('.evt-dlg-tab')) {
      b.classList.toggle('active', b.dataset.view === view);
    }
  }
  const key = eventsDialogModalKey;
  if (key) {
    const [actorId, eventId] = key.split(':').map(Number);
    if (view === 'info') {
      // Info renders a cutscene timeline section for cutscene events — lazy-fetch it once.
      if (eventsDialogIsCutscene && !eventsCutscene.has(key)) _fetchEventCutscene(key, actorId, eventId);
    } else if (view === 'opcodes') {
      if (!eventsOpcodes.has(key)) fetchEventOpcodes(key, actorId, eventId);
    } else if (view === 'lines') {
      if (!eventsDialog.has(key)) fetchEventDialog(key, actorId, eventId);
      // The timeline carries per-line speakers — fetch it so the chat can attribute names.
      if (eventsDialogIsCutscene && !eventsCutscene.has(key)) _fetchEventCutscene(key, actorId, eventId);
    }
  }
  renderDialogModal();
}

export async function fetchEventCutscene(key, actorId, eventId) {
  const currentZoneUrl = _getCurrentZoneUrl();
  if (!bridgeOnline()) {
    eventsCutscene.set(key, { state: 'error', error: 'Timeline needs the XI backend (run via `xi gui zone`).' });
    renderDialogModal(); return;
  }
  eventsCutscene.set(key, { state: 'loading' });
  renderDialogModal();
  const zoneUrl = currentZoneUrl;
  try {
    const r = await bridgeCall('zone.cutscene', { zone: zoneUrl, zoneId: _currentZoneId(), actorId, eventId });
    if (zoneUrl !== _getCurrentZoneUrl()) return;
    if (r && r.ok) {
      // Also pull the saved EDIT def (if you authored this event) so the Timeline stats reflect
      // what you BUILT, not a decode of the published DAT. Null for retail cutscenes.
      let def = null;
      try {
        const dr = await bridgeCall('zone.loadCutsceneDef', {
          zone: zoneUrl, zoneId: _currentZoneId(), eventId, actorId,
        });
        if (zoneUrl !== _getCurrentZoneUrl()) return;
        if (dr && dr.ok) def = dr.cutscene || null;
      } catch {}
      eventsCutscene.set(key, { state: 'done', data: r, def });
    } else eventsCutscene.set(key, { state: 'error', error: (r && r.error) || 'Failed to build timeline.' });
  } catch (err) {
    if (zoneUrl !== _getCurrentZoneUrl()) return;
    eventsCutscene.set(key, { state: 'error', error: (err && err.message) || String(err) });
  }
  if (eventsDialogModalKey === key && (eventsDialogView === 'info' || eventsDialogView === 'lines')) renderDialogModal();
}

// The Info tab now merges event metadata + (for cutscenes) the timeline summary + a
// custom-only Delete. Kept exported under the old name for main.js's injection wiring.
export function renderCutsceneView(key) { renderMergedInfo(key); }

// Category → hero icon (colour comes from EVT_CAT_META).
const _CAT_ICON = {
  Cutscene: 'movie', Dialogue: 'forum', Menu: 'menu', Door: 'meeting_room',
  Magic: 'auto_awesome', Script: 'code', Empty: 'help',
};

// Compose the Info view as a dashboard: hero → metric tiles → (cutscene: composition + CTA +
// server) → (Delete if custom). Redesigned from the old label/value tables.
function renderMergedInfo(key) {
  const [actorId, eventId] = key.split(':').map(Number);
  const actor = eventsState.data?.actors.find((a) => a.actorId === actorId);
  const ev = actor?.events.find((x) => x.eventId === eventId);
  if (!actor || !ev) { evtDialogBodyEl.innerHTML = `<div class="evt-dlg-msg">(no event metadata)</div>`; return; }

  const ac = EVT_CAT_META[ev.category]?.color || '#9aa3b2';
  const icon = _CAT_ICON[ev.category] || 'bolt';
  const isCs = eventsDialogIsCutscene;
  const stats = isCs ? _cutsceneStats(key) : null;

  // ── Hero ──
  const flagBadges = [
    ev.hasMenu ? `<span class="evx-badge evx-badge-flag">Menu</span>` : '',
    ev.hasDoor ? `<span class="evx-badge evx-badge-flag">Door</span>` : '',
  ].join('');
  let html = `<div class="evx">`
    + `<div class="evx-hero" style="--ac:${ac}">`
    +   `<div class="evx-hero-ico"><span class="material-symbols-outlined">${icon}</span></div>`
    +   `<div class="evx-hero-main">`
    +     `<div class="evx-hero-name">${evtEsc(actor.name || '(unnamed)')}</div>`
    +     `<div class="evx-hero-sub">`
    +       `<span class="evx-badge" style="--ac:${ac}">${evtEsc(ev.category)}</span>${flagBadges}`
    +       `<span class="evx-hero-id">Event ${ev.eventId}</span>`
    +       `<span class="evx-hero-hex">0x${evtEsc(ev.eventIdHex)}</span>`
    +     `</div>`
    +   `</div>`
    +   `<div class="evx-hero-meta">`
    +     `<div><span class="evx-hero-meta-k">Actor</span><span class="evx-hero-meta-v">${evtEsc(actor.actorIdHex)}</span></div>`
    +     `<div><span class="evx-hero-meta-k">Offset</span><span class="evx-hero-meta-v">+${ev.offset}</span></div>`
    +   `</div>`
    + `</div>`;

  // ── Metric tiles ──
  const tiles = [];
  if (isCs && stats && stats.state === 'done') {
    tiles.push(['schedule',   `${(stats.content / stats.fps).toFixed(1)}s`, 'Duration',  '#82aaff']);
    tiles.push(['movie',      String(stats.content),  'Frames',    '#c792ea']);
    tiles.push(['videocam',   String(stats.camShots), 'Cam shots', '#f7c873']);
    tiles.push(['graphic_eq', String(stats.beatsCount), 'Beats',   '#7fd88f']);
    if (stats.prompts) tiles.push(['forum', String(stats.prompts), 'Dialogue', '#7fd6e6']);
  } else {
    tiles.push(['forum', String(ev.dialogCount || 0), 'Dialog lines', '#7fd88f']);
  }
  tiles.push(['code', String(ev.opcodeCount || 0), 'Opcodes', '#6fd3e0']);
  html += `<div class="evx-tiles">` + tiles.map(([ico, val, k, c]) =>
      `<div class="evx-tile" style="--ac:${c}"><span class="material-symbols-outlined evx-tile-ico">${ico}</span>`
      + `<div class="evx-tile-val">${val}</div><div class="evx-tile-key">${k}</div></div>`).join('')
    + `</div>`;

  // ── Cutscene: composition + CTA + server (only once the timeline is decoded) ──
  if (isCs) {
    if (!stats || stats.state === 'loading') {
      // Skeleton of the Composition card this becomes once the timeline is decoded.
      html += `<div class="evx-card">`
        +   `<div class="evx-card-h">Composition</div>`
        +   `<div class="evx-loadbar"><span></span></div>`
        +   `<div class="evx-loadmsg"><span class="material-symbols-outlined">progress_activity</span>Building timeline…</div>`
        + `</div>`;
    }
    else if (stats.state === 'error')        html += `<div class="evx-card evx-err">${evtEsc(stats.error)}</div>`;
    else {
      const bar = stats.segs.map((s) => `<span class="evx-seg" style="--cc:${s.color}; flex:${s.c}" title="${evtEsc(s.label)} ${s.c}"></span>`).join('');
      const legend = stats.segs.map((s) => `<span class="evx-leg"><i style="--cc:${s.color}"></i>${evtEsc(s.label)} <b>${s.c}</b></span>`).join('');
      const resTag = (label, arr, col) => (arr && arr.length)
        ? `<div class="evx-res"><span class="evx-res-k" style="--cc:${col}">${label}</span><span class="evx-res-v">${arr.map(evtEsc).join(', ')}</span></div>` : '';
      const res = resTag('Cast', stats.cast, '#6fd3e0') + resTag('VFX', stats.vfx.vfx, '#ff7b72')
        + resTag('Anim', stats.vfx.anim, '#b48ead') + resTag('SFX', stats.vfx.sound, '#ff8fcf');
      html += `<div class="evx-card">`
        +   `<div class="evx-card-h">Composition</div>`
        +   `<div class="evx-compbar">${bar}</div>`
        +   `<div class="evx-legend">${legend}</div>`
        +   (res ? `<div class="evx-res-wrap">${res}</div>` : '')
        + `</div>`;
      html += `<button id="cs-edit-btn" class="evx-cta"><span class="material-symbols-outlined">movie_edit</span>`
        +   `<span>Open Timeline Sequencer</span><span class="material-symbols-outlined evx-cta-arrow">arrow_forward</span></button>`;
      html += `<div class="evx-card">`
        +   `<div class="evx-card-h">Server script</div>`
        +   `<div class="evx-server-row">`
        +     `<input id="cs-server-path" class="evx-input" spellcheck="false" value="${evtEsc(loadSetting('serverPath', 'D:\\\\xi-server'))}">`
        +     `<button id="cs-server-find" class="evx-btn">Find script</button>`
        +   `</div>`
        +   `<div id="cs-server-out" class="cs-server-out"></div>`
        + `</div>`;
    }
  }

  // ── Danger zone (custom events only) ──
  if (ev.isCustom) {
    html += `<div class="evx-danger">`
      +   `<div class="evx-danger-h"><span class="material-symbols-outlined">warning</span>Danger zone</div>`
      +   `<div class="evx-danger-txt">Removes event ${ev.eventId} from ${evtEsc(actor.name || actor.actorIdHex)}'s block. Writes the game DAT in place + backs up the pristine bytes on first delete.</div>`
      +   `<button id="evt-delete-btn" class="evx-del"><span class="material-symbols-outlined">delete</span>Delete this event</button>`
      + `</div>`;
  }

  html += `</div>`;
  evtDialogBodyEl.innerHTML = html;

  document.getElementById('evt-delete-btn')?.addEventListener('click', _deleteCurrentEvent);
  if (isCs) _wireCutsceneSection(key);
}

// Per-kind chip label + colour for EDIT-def stats (kinds from the author track model).
const DEF_KIND_META = {
  camera:   ['Camera',   '#f7c873'],
  dialog:   ['Dialogue', '#7fd88f'],
  npc:      ['Actor',    '#6fd3e0'],
  face:     ['Face',     '#b48ead'],
  position: ['Position', '#8fd3ff'],
  anim:     ['Anim',     '#e5b567'],
  wait:     ['Wait',     '#7e8698'],
  fade:     ['Fade',     '#82aaff'],
  music:    ['Music',    '#ff8fcf'],
  sfx:      ['SFX',      '#ff8fcf'],
  vfx:      ['VFX',      '#ff7b72'],
};
const _DEF_KIND_ORDER = Object.keys(DEF_KIND_META);
const _defKindOrder = (k) => { const i = _DEF_KIND_ORDER.indexOf(k); return i < 0 ? 99 : i; };

// Decode the cutscene timeline into structured stats for the Info dashboard. Prefers the saved
// EDIT def (what you BUILT) over a decode of the published DAT (which re-groups into routes).
// Returns { state:'loading'|'error'|'done', ... }.
function _cutsceneStats(key) {
  const d = eventsCutscene.get(key);
  if (!d || d.state === 'loading') return { state: 'loading' };
  if (d.state === 'error') return { state: 'error', error: d.error };
  const cs = d.data;
  const def = d.def;   // saved EDIT def, or null for a retail cutscene

  let fps, content, beatsCount, camShots, counts, prompts;
  if (def) {
    const tracks = (def.timeline && def.timeline.tracks) || [];
    fps = 30;
    content = Math.max(1, def.totalFrames | 0);
    counts = new Map(); beatsCount = 0;
    for (const t of tracks) {
      const n = (t.keyframes || []).length;
      counts.set(t.kind, (counts.get(t.kind) || 0) + n);
      beatsCount += n;
    }
    camShots = counts.get('camera') || 0;
    prompts = counts.get('dialog') || 0;
  } else {
    fps = cs.fps || 30;
    content = Math.max(1, cs.contentFrames != null ? cs.contentFrames : Math.max(1, cs.totalFrames || 1));
    counts = new Map();
    for (const b of cs.beats) counts.set(b.type, (counts.get(b.type) || 0) + 1);
    beatsCount = cs.beats.length;
    camShots = cs.cameraShots || 0;
    prompts = cs.dialoguePrompts || 0;
  }
  // Composition segments (ordered like the timeline lanes), each { k, c, label, color }.
  const meta = (k) => def ? (DEF_KIND_META[k] || [k, '#888']) : (CS_BEAT_META[k] || [k, '#888']);
  const ord = (a, b) => def
    ? _defKindOrder(a) - _defKindOrder(b)
    : CS_LANE_ORDER.indexOf(csLaneOf(a)) - CS_LANE_ORDER.indexOf(csLaneOf(b));
  const segs = [...counts.entries()].filter(([, c]) => c > 0).sort((x, y) => ord(x[0], y[0]))
    .map(([k, c]) => { const [label, color] = meta(k); return { k, c, label, color }; });
  const cast = [...new Set(cs.beats.filter((b) => b.type === 'npc' && b.action === 'show' && b.actor).map((b) => b.actor))];
  return { state: 'done', def: !!def, fps, content, beatsCount, camShots, prompts, segs, cast, vfx: cs.vfxResources || {} };
}

// Wire the cutscene section's buttons (only present once the timeline finished decoding).
function _wireCutsceneSection(key) {
  const d = eventsCutscene.get(key);
  if (!d || d.state !== 'done') return;
  const cs = d.data;
  document.getElementById('cs-edit-btn')?.addEventListener('click', () => {
    // Seed the Create Cutscene form from the parsed timeline + open its modal.
    const [actorId] = key.split(':').map(Number);
    const actor = eventsState.data?.actors.find((a) => a.actorId === actorId);
    const hex = actor?.actorIdHex || ('0x' + (actorId >>> 0).toString(16).padStart(8, '0').toUpperCase());
    const name = actor?.name || null;
    openCutsceneAuthorFrom(cs, hex, name);
  });
  csWireServerLookup(key);
}

async function csWireServerLookup(key) {
  const pathInput = document.getElementById('cs-server-path');
  const findBtn = document.getElementById('cs-server-find');
  const out = document.getElementById('cs-server-out');
  if (!pathInput || !findBtn || !out) return;
  const eventId = Number(key.split(':')[1]);
  async function doFind() {
    const sp = pathInput.value.trim();
    saveSetting('serverPath', sp);
    out.innerHTML = `<div class="cs-server-msg">Searching…</div>`;
    let r;
    try { r = await bridgeCall('zone.serverEventInfo', { serverPath: sp, zoneId: _currentZoneId(), eventId }); }
    catch (e) { out.innerHTML = `<div class="cs-server-msg err">${evtEsc(String(e))}</div>`; return; }
    if (!r || !r.ok) { out.innerHTML = `<div class="cs-server-msg err">${evtEsc((r && r.error) || 'lookup failed')}</div>`; return; }
    if (!r.matches.length) { out.innerHTML = `<div class="cs-server-msg">No script starts event ${eventId} in ${evtEsc(r.zoneName || ('zone ' + r.zoneId))}.</div>`; return; }
    out.innerHTML = (r.name ? `<div class="cs-server-name">${evtEsc(r.name)}<span class="cs-server-kind">${evtEsc(r.kind || '')}</span></div>` : '')
      + `<div class="cs-server-zone">${evtEsc(r.zoneName || ('zone ' + r.zoneId))} · event ${eventId}</div>`
      + r.matches.map((m) =>
        `<div class="cs-server-match${m.namesZone ? ' is-zone' : ''}">`
        + `<div class="cs-server-file">${evtEsc(m.file)}</div>`
        + m.lines.map((l) => `<div class="cs-server-line"><span class="ln">L${l.n}</span>${evtEsc(l.text)}</div>`).join('')
        + (m.movement.length
            ? `<div class="cs-server-mvh">NPC movement</div>` + m.movement.map((l) => `<div class="cs-server-line mv"><span class="ln">L${l.n}</span>${evtEsc(l.text)}</div>`).join('')
            : '')
        + `</div>`).join('');
  }
  findBtn.addEventListener('click', doFind);
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doFind(); });
  doFind();
}

export function closeEventDialog() {
  if (evtDialogModal) evtDialogModal.classList.remove('open');
  if (eventsDialogModalKey != null) { eventsDialogModalKey = null; renderEvents(); }
}

async function fetchEventDialog(key, actorId, eventId) {
  const currentZoneUrl = _getCurrentZoneUrl();
  const actor = eventsState.data?.actors.find((a) => a.actorId === actorId);
  const ev = actor?.events.find((x) => x.eventId === eventId);
  const ids = (ev && ev.dialogIds) || [];
  if (!ids.length) { eventsDialog.set(key, { state: 'done', lines: [] }); renderDialogModal(); return; }
  if (!bridgeOnline()) {
    eventsDialog.set(key, { state: 'error', error: 'Dialogue needs the XI backend (run via `xi gui zone`).' });
    renderDialogModal(); return;
  }
  eventsDialog.set(key, { state: 'loading' });
  renderDialogModal();
  const zoneUrl = currentZoneUrl;
  try {
    const r = await bridgeCall('zone.dialog', { zone: zoneUrl, zoneId: _currentZoneId(), ids });
    if (zoneUrl !== _getCurrentZoneUrl()) return;     // zone changed mid-flight — drop stale result
    if (r && r.ok) eventsDialog.set(key, { state: 'done', lines: r.lines || [] });
    else eventsDialog.set(key, { state: 'error', error: (r && r.error) || 'Failed to decode dialogue.' });
  } catch (err) {
    if (zoneUrl !== _getCurrentZoneUrl()) return;
    eventsDialog.set(key, { state: 'error', error: (err && err.message) || String(err) });
  }
  renderDialogModal();
}

async function fetchEventOpcodes(key, actorId, eventId) {
  const currentZoneUrl = _getCurrentZoneUrl();
  if (!bridgeOnline()) {
    eventsOpcodes.set(key, { state: 'error', error: 'Opcodes need the XI backend (run via `xi gui zone`).' });
    renderDialogModal(); return;
  }
  eventsOpcodes.set(key, { state: 'loading' });
  renderDialogModal();
  const zoneUrl = currentZoneUrl;
  try {
    const r = await bridgeCall('zone.eventOpcodes', { zone: zoneUrl, zoneId: _currentZoneId(), actorId, eventId });
    if (zoneUrl !== _getCurrentZoneUrl()) return;
    if (r && r.ok) eventsOpcodes.set(key, { state: 'done', opcodes: r.opcodes || [] });
    else eventsOpcodes.set(key, { state: 'error', error: (r && r.error) || 'Failed to disassemble event.' });
  } catch (err) {
    if (zoneUrl !== _getCurrentZoneUrl()) return;
    eventsOpcodes.set(key, { state: 'error', error: (err && err.message) || String(err) });
  }
  renderDialogModal();
}

function renderDialogModal() {
  if (!evtDialogBodyEl) return;
  const key = eventsDialogModalKey;
  if (!key) { evtDialogBodyEl.innerHTML = ''; return; }
  if (eventsDialogView === 'info' || eventsDialogView === 'timeline') { renderMergedInfo(key); return; }
  evtDialogBodyEl.innerHTML = (eventsDialogView === 'opcodes')
    ? renderOpcodesHtml(key)
    : renderLinesHtml(key);
}


async function _deleteCurrentEvent() {
  const key = eventsDialogModalKey;
  if (!key) return;
  const [actorId, eventId] = key.split(':').map(Number);
  const actor = eventsState.data?.actors.find((a) => a.actorId === actorId);
  const who = actor?.name || actor?.actorIdHex || `actor 0x${(actorId >>> 0).toString(16)}`;
  if (!confirm(`Delete event ${eventId} from ${who}?\n\nThis edits the zone Event DAT. The pristine DAT is preserved as a .base backup so you can revert.`)) {
    return;
  }
  if (!bridgeOnline()) {
    alert('Bridge offline — start `xi gui zone` first.');
    return;
  }
  try {
    const r = await bridgeCall('zone.deleteEvent', {
      zone: _getCurrentZoneUrl(), zoneId: _currentZoneId(),
      actorId, eventId,
    });
    if (!r || !r.ok) { alert('Delete failed: ' + (r?.error || 'unknown error')); return; }
    // Close the modal + hard-refresh the events tree.
    closeEventDialog();
    invalidateEvents();
  } catch (e) {
    alert('Delete failed: ' + (e?.message || e));
  }
}

// Stable, pleasant colour per speaker name (hashed into a small curated palette).
const _SPEAKER_COLORS = ['#6fd3e0', '#c792ea', '#7fd88f', '#f7c873', '#ff8fcf', '#82aaff', '#e5928b', '#b0c674'];
function _speakerColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return _SPEAKER_COLORS[h % _SPEAKER_COLORS.length];
}
// The player's lines sit on the right (SMS "me"); everyone else on the left. The event
// decoder labels the player entity "local player".
function _isPlayerSpeaker(label) { return /player|^you$/i.test(label || ''); }

function renderLinesHtml(key) {
  const d = eventsDialog.get(key);
  if (!d || d.state === 'loading') return `<div class="evt-dlg-msg">Decoding dialogue…</div>`;
  if (d.state === 'error') return `<div class="evt-dlg-msg">${evtEsc(d.error)}</div>`;
  if (!d.lines || !d.lines.length) return `<div class="evt-dlg-msg">(no dialogue lines)</div>`;

  // Attribute a speaker to each line: prefer the cutscene timeline's per-message speaker
  // (0x2B print-with-speaker); otherwise the event's own NPC — a plain print_msg speaks as
  // the actor the event belongs to.
  const [actorId] = key.split(':').map(Number);
  const eventActor = eventsState.data?.actors.find((a) => a.actorId === actorId);
  const defaultSpeaker = eventActor?.name || 'Narrator';
  const speakerByMsg = new Map();
  const cs = eventsCutscene.get(key);
  if (cs && cs.state === 'done') {
    for (const b of (cs.data.beats || [])) {
      if (b.type === 'dialogue' && b.msgId != null && b.speaker) speakerByMsg.set(b.msgId, b.speaker);
    }
  }

  let prevSpeaker = null;
  const rows = d.lines.map((ln) => {
    const speaker = speakerByMsg.get(ln.id) || defaultSpeaker;
    const self = _isPlayerSpeaker(speaker);
    const showWho = speaker !== prevSpeaker;      // collapse the name on a run from one speaker
    prevSpeaker = speaker;
    const col = self ? '#7fd6e6' : _speakerColor(speaker);
    const text = ln.missing ? '<i>(not in dialogue table)</i>' : evtEsc(ln.text);
    return `<div class="evt-chat-msg${self ? ' self' : ''}">`
      + `<div class="evt-chat-col">`
      +   (showWho ? `<div class="evt-chat-who" style="--sc:${col}">${evtEsc(speaker)}</div>` : '')
      +   `<div class="evt-chat-bubble" style="--sc:${col}">`
      +     `<span class="evt-chat-text">${text}</span>`
      +     `<span class="evt-chat-id">${ln.id}</span>`
      +   `</div>`
      + `</div>`
      + `</div>`;
  }).join('');
  return `<div class="evt-chat">${rows}</div>`;
}

function renderOpcodesHtml(key) {
  const d = eventsOpcodes.get(key);
  if (!d || d.state === 'loading') return `<div class="evt-dlg-msg">Disassembling…</div>`;
  if (d.state === 'error') return `<div class="evt-dlg-msg">${evtEsc(d.error)}</div>`;
  if (!d.opcodes || !d.opcodes.length) return `<div class="evt-dlg-msg">(no opcodes)</div>`;
  // "What this script does" at a glance: the most-used opcodes (skip filler noop/end).
  const freq = new Map();
  for (const o of d.opcodes) {
    if (o.name === 'noop' || o.name === 'end') continue;
    freq.set(o.name, (freq.get(o.name) || 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const head = top.length
    ? `<div class="evt-op-tags"><span class="evt-op-tags-k">most-used</span>`
      + top.map(([n, c]) => `<span class="evt-op-tag">${evtEsc(n)} <b>×${c}</b></span>`).join('')
      + `</div>`
    : '';
  const rows = d.opcodes.map((o) => {
    const off = (typeof o.offset === 'number') ? o.offset.toString(16).padStart(4, '0') : o.offset;
    const ref = (o.dialog_ref != null) ? `<span class="evt-op-ref">→ msg ${o.dialog_ref}</span>` : '';
    // load_zone (0x34/0x35) → a clickable chip that opens the loaded zone side-by-side.
    const zref = (o.zone_ref != null)
      ? `<span class="evt-op-zone" role="button" tabindex="0"`
        + ` data-zone="${o.zone_ref}" data-zone-name="${evtEsc(o.zone_name || '')}"`
        + ` title="Open zone ${o.zone_ref}${o.zone_name ? ' — ' + evtEsc(o.zone_name) : ''} side-by-side">`
        + `→ zone ${o.zone_ref}${o.zone_name ? ' ' + evtEsc(o.zone_name) : ''}</span>`
      : '';
    // Who this opcode acts on (NPC name / player / event entity), from its actor-id operand(s).
    const aref = (o.actors && o.actors.length)
      ? `<span class="evt-op-actor" title="entity this opcode acts on">→ ${o.actors.map((x) => evtEsc(x.label)).join(', ')}</span>`
      : '';
    return `<div class="evt-op-line">`
      + `<span class="evt-op-off">+${off}</span>`
      + `<span class="evt-op-code">${evtEsc(o.op)}</span>`
      + `<span class="evt-op-name">${evtEsc(o.name)}</span>`
      + `<span class="evt-op-args">${o.args ? evtEsc(o.args) : ''}</span>`
      + ref + zref + aref
      + `</div>`;
  }).join('');
  // Rows go in their own horizontal scroller so long operands scroll sideways
  // instead of squashing the args column to a 1-char-per-line sliver (narrow modal).
  return head + `<div class="evt-op-list">` + rows + `</div>`;
}

// ── Loaded-zone peek (opened from a load_zone 0x34/0x35 opcode) ────────────
// Clicking a "→ zone N" chip in the Opcodes view opens this second, independent modal
// showing that zone's events — so a cutscene that swaps maps (e.g. Lower Delkfutt's →
// Qufim Island) can be inspected alongside the zone it loads.
function zonePeekEntry(zoneId) {
  const zonesData = _getZonesData ? _getZonesData() : [];
  const customZonesData = _getCustomZonesData ? _getCustomZonesData() : [];
  return zonesData.find((z) => z.id === zoneId)
      || customZonesData.find((z) => z.id === zoneId)
      || null;
}

function openZonePeek(zoneId, name) {
  if (!Number.isFinite(zoneId) || !evtZonePeekModal) return;
  const entry = zonePeekEntry(zoneId);
  const label = name || (entry && !/^Zone \d+$/.test(entry.name) ? entry.name : '');
  if (evtZonePeekTitle) evtZonePeekTitle.textContent = label ? `Zone ${zoneId} · ${label}` : `Zone ${zoneId}`;
  _openModal(evtZonePeekModal, null);
  // Sit beside the event modal rather than on top of it, for a true side-by-side view.
  if (evtDialogModal?.classList.contains('open')) {
    const er = evtDialogModal.getBoundingClientRect();
    const w = evtZonePeekModal.offsetWidth || 360;
    let left = er.left - w - 16;
    if (left < 12) left = Math.min(window.innerWidth - w - 12, er.right + 16);
    evtZonePeekModal.style.left = Math.max(12, left) + 'px';
    evtZonePeekModal.style.top = Math.max(12, er.top) + 'px';
  }
  renderZonePeek(zoneId);
  if (!zonePeekCache.has(zoneId)) {
    if (!entry) { zonePeekCache.set(zoneId, { state: 'error', error: `Zone ${zoneId} isn't in the zone list — it may not be extracted.` }); renderZonePeek(zoneId); return; }
    fetchZonePeek(zoneId, entry.path);
  }
}

async function fetchZonePeek(zoneId, path) {
  if (!bridgeOnline()) {
    zonePeekCache.set(zoneId, { state: 'error', error: 'Zone peek needs the XI backend (run via `xi gui zone`).' });
    renderZonePeek(zoneId); return;
  }
  zonePeekCache.set(zoneId, { state: 'loading' });
  renderZonePeek(zoneId);
  try {
    const r = await bridgeCall('zone.events', { zone: path, zoneId });
    if (r && r.ok) zonePeekCache.set(zoneId, { state: 'done', data: r });
    else zonePeekCache.set(zoneId, { state: 'error', error: (r && r.error) || 'Failed to load zone events.' });
  } catch (err) {
    zonePeekCache.set(zoneId, { state: 'error', error: (err && err.message) || String(err) });
  }
  renderZonePeek(zoneId);
}

function renderZonePeek(zoneId) {
  if (!evtZonePeekBody) return;
  const entry = zonePeekEntry(zoneId);
  const d = zonePeekCache.get(zoneId);
  const openBtn = entry
    ? `<button class="evt-zone-open" data-open-zone="${evtEsc(entry.path)}">Open in editor</button>` : '';
  let body;
  if (!d || d.state === 'loading') body = `<div class="evt-dlg-msg">Loading zone events…</div>`;
  else if (d.state === 'error') body = `<div class="evt-dlg-msg">${evtEsc(d.error)}</div>`;
  else {
    const s = d.data.stats || {};
    const stat = (k, v) => `<div class="evt-zone-stat"><span class="evt-zone-k">${k}</span><span class="evt-zone-v">${v}</span></div>`;
    const stats = `<div class="evt-zone-stats">`
      + stat('Actors', s.actorCount || 0)
      + stat('Events', s.eventCount || 0)
      + stat('Cutscenes', s.cutsceneCount || 0)
      + `</div>`;
    const dat = d.data.eventDat ? `<div class="evt-zone-dat">${evtEsc(d.data.eventDat)}</div>` : '';
    const actors = d.data.actors || [];
    const list = actors.map((a) => {
      const who = a.name ? evtEsc(a.name) : a.actorIdHex;
      const evs = a.events.map((e) =>
        `<span class="evt-zone-ev" style="--cc:${EVT_CAT_META[e.category]?.color || '#888'}"`
        + ` title="event ${e.eventId} — ${e.category}${e.isCutscene ? ' (cutscene)' : ''}">${e.eventId}</span>`).join('');
      return `<div class="evt-zone-actor"><span class="evt-zone-actor-name">${who}</span>`
        + `<span class="evt-zone-evs">${evs}</span></div>`;
    }).join('');
    body = stats + dat + `<div class="evt-zone-list">${list || '<div class="evt-dlg-msg">This zone has no events.</div>'}</div>`;
  }
  evtZonePeekBody.innerHTML = `<div class="evt-zone-head">${openBtn}</div>` + body;
}

// ── DOM event listeners (wired once after initEventsPanel is called) ──────────
function _wireEventListeners() {
  if (evtListEl) evtListEl.addEventListener('click', (e) => {
    // Any event row → open its inspector modal (dialogue + opcodes).
    const evRow = e.target.closest('.evt-event');
    if (evRow) {
      openEventDialog(Number(evRow.dataset.actor), Number(evRow.dataset.event), evRow);
      return;
    }
    // Otherwise a group header → expand/collapse.
    const head = e.target.closest('.evt-actor-head');
    if (!head) return;
    const grp = head.closest('.evt-actor');
    if (grp?.dataset.pinned) {   // the Pinned group has its own open flag (no actor id)
      eventsState.pinnedOpen = !eventsState.pinnedOpen;
      renderEvents();
      return;
    }
    const id = Number(grp?.dataset.actor);
    if (!Number.isFinite(id)) return;
    if (eventsState.expanded.has(id)) eventsState.expanded.delete(id);
    else eventsState.expanded.add(id);
    renderEvents();
  });
  // Right-click an event → Pin/Unpin; right-click the Pinned header → Unpin all.
  if (evtListEl) evtListEl.addEventListener('contextmenu', (e) => {
    const evRow = e.target.closest('.evt-event');
    if (evRow) {
      const actorId = Number(evRow.dataset.actor);
      const eventId = Number(evRow.dataset.event);
      if (!Number.isFinite(actorId) || !Number.isFinite(eventId)) return;
      const pinned = isEventPinned(actorId, eventId);
      _openContextMenu(e, (addItem) => {
        addItem(pinned ? 'Unpin event' : 'Pin event', () => toggleEventPin(actorId, eventId));
      });
      return;
    }
    if (e.target.closest('.evt-pinned-group .evt-actor-head')) {
      _openContextMenu(e, (addItem) => addItem('Unpin all', () => clearEventPins(), { danger: true }));
    }
  });
  if (evtFilterEl) evtFilterEl.addEventListener('input', () => {
    eventsState.filter = evtFilterEl.value;
    renderEvents();
  });
  if (evtCatsEl) evtCatsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.evt-cat-chip');
    if (!chip) return;
    eventsState.cat = chip.dataset.cat || '';
    renderEvents();
  });
  if (evtRefreshBtn) evtRefreshBtn.addEventListener('click', () => {
    eventsState.loadedFor = null;
    eventsState.data = null;
    ensureEventsLoaded();
  });
  if (evtExpandBtn) evtExpandBtn.addEventListener('click', () => {
    const data = eventsState.data;
    if (!data) return;
    if (eventsState.expanded.size > 0) {
      eventsState.expanded.clear();
      evtExpandBtn.textContent = 'Expand';
    } else {
      for (const a of data.actors) eventsState.expanded.add(a.actorId);
      evtExpandBtn.textContent = 'Collapse';
    }
    renderEvents();
  });

  // "→ zone N" chip in the Opcodes view → open the peek.
  evtDialogBodyEl?.addEventListener('click', (e) => {
    const chip = e.target.closest('.evt-op-zone');
    if (!chip) return;
    openZonePeek(Number(chip.dataset.zone), chip.dataset.zoneName || '');
  });
  evtDialogBodyEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const chip = e.target.closest('.evt-op-zone');
    if (!chip) return;
    e.preventDefault();
    openZonePeek(Number(chip.dataset.zone), chip.dataset.zoneName || '');
  });
  // "Open in editor" inside the peek → load that zone in the main viewport.
  evtZonePeekBody?.addEventListener('click', (e) => {
    const ob = e.target.closest('[data-open-zone]');
    if (!ob) return;
    const sel = document.getElementById('zone');
    if (sel) sel.value = ob.dataset.openZone;
    _loadZone(ob.dataset.openZone);
  });

  // Timeline / Lines / Opcodes tab toggle.
  evtDialogModal?.querySelectorAll('.evt-dlg-tab').forEach((b) =>
    b.addEventListener('click', () => showDialogView(b.dataset.view)));

  // Close button (in addition to the generic .modal-close handler) + Escape clear the
  // active-row highlight when the dialogue modal is dismissed.
  evtDialogModal?.querySelector('.modal-close')?.addEventListener('click', closeEventDialog);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && evtDialogModal?.classList.contains('open')) {
      e.stopPropagation();
      closeEventDialog();
    }
  });
}
