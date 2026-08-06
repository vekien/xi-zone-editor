// cutscene-author.js — modal UI for authoring + compiling xi.cutscene.v1 cutscenes.
//
// Backed by the `zone.compileCutscene` bridge endpoint which lowers a cutscene JSON
// to Event + Dialog DAT bytes via xi.event.xi_compile. The frontend keeps it simple:
// build the JSON in-memory as the user edits, send it dry-run to preview the disasm,
// send it non-dry-run to publish (writes the game DATs in place + .base backups).
//
// Camera / fade / anim / menu / branch step ops are gated with a tooltip because the
// backend still stubs them — dialog-only cutscenes are the shipped path today.

import { bridgeOnline, bridgeCall } from '../ffxi/bridge.js';
import { loadSetting, loadProjectSetting, saveProjectSetting } from '../editor/settings.js';
import { invalidateEvents } from './events-panel.js';
import { csOpenAuthor, csAuthorRefresh, csCloseSequencer, csLoadAuthorActors, csGetMarkers, isCsSequencerOpen, csIsAuthorMode, csDecomposeRoute, csRefreshOpenKeyframe, csSetActorIdle, csRefreshActorVisibility, CAMERA_SUB_KINDS } from '../viewport/cutscene.js';

// Reload the on-stage cast NPC models after a cast/owner change (no-op unless the
// sequencer is open in author mode).
function _reloadStageNpcs() { try { csLoadAuthorActors(); } catch {} }

// "Hide Trigger NPC in Level Editor" is an editor-only view preference, so it lives in the
// project (workspace) settings — persisted to <project>/project_settings.json and mirrored to
// localStorage — NOT in the shared/published cutscene def. One toggle applies to every cutscene
// opened in this workspace.
const HIDE_TRIGGER_NPC_KEY = 'cutsceneHideTriggerNpc';
// Layering (per settings.js): project file wins → else the localStorage cross-project seed → false.
const _loadHideTriggerNpc = () =>
  !!loadProjectSetting(HIDE_TRIGGER_NPC_KEY, loadSetting(HIDE_TRIGGER_NPC_KEY, false));

// ── Injected dependencies (set by initCutsceneAuthor) ────────────────────────
let _getCurrentZoneUrl = () => null;
let _currentZoneId    = () => null;
let _fetchActorList   = null;      // async () → [{actor_id, actor_name}]

// ── DOM refs (lazy — the modal is in index.html; the body populates on open) ──
const bodyEl   = () => document.getElementById('cs-author-body');
const modalEl  = () => document.getElementById('cs-author-modal');
const btnOpen  = () => document.getElementById('cs-author-btn');

// ── Author state — one in-progress cutscene at a time ────────────────────────
const state = {
  cast: [],           // [{id, entity, name}]
  lines: [],          // [{id, speaker, text}]
  owner: '',          // cast id that owns the event

  // Timeline model (Phase B+ pivot). Replaces the step list.
  totalFrames: 300,   // cutscene length in frames (30fps → 10 sec default)
  autoFadeIn:  0,     // frames of fdi1 fade-in at start (0 = off, needs scene DAT)
  autoFadeOut: 0,     // frames of fdo1 fade-out at end
  tracks: [],         // [{kind, castId, keyframes:[{frame, ...fields}]}]
  selected: null,     // {trackIdx, kfIdx} — currently-selected keyframe for the detail pane

  // Presentation
  eventMode:  0x0003, // 0x38 CliEventModeLocal (3 = retail cinematic)
  lockPlayer: false,
  cameraLock: false,
  cancelSet:  false,
  talkAnim:   'tlk0', // gesture while a line is spoken
  idleAnim:   'idl0', // gesture between lines / at rest
  hideActorsOnEnd: false, // hide all non-owner cast under the final fade-to-black
  hideNpcNames: false, // publish-time npc_list.namevis |= 8 on cast (no floating names)
  resetZoomOnEnd: true, // restore default camera zoom (focal 350) under the end fade — camera
                        // routes set the GLOBAL projection focal and the client never resets it
  hideOwnerInEditor: false, // editor-only view pref: hide the trigger NPC's staged model while framing.
                            // Source of truth = project (workspace) setting, seeded on every open.

  // Legacy — kept only for _seedFromCutscene backward compat.
  steps: [],

  // Remembers the event id from the first Publish so subsequent Publishes
  // REPLACE that event instead of appending a new one. Reset to null when a
  // fresh cutscene is started (seedDefaults) or when the user hits "New".
  // ★ publishedActorId is part of session identity: many retail NPCs share the
  //   same event id (Maat 0x010F3031 and 0x010F3032 both have event 93). Matching
  //   on eventId alone reopens the wrong cutscene with the wrong dialog/cast.
  publishedEventId: null,
  publishedActorId: null,    // u32 owner actor id for the session, or null
  cameraSceneFileId: null,   // the camera scene DAT file-id this cutscene owns (reused across publishes)
  // Where the camera scene DAT is written on disk: joined as ROM{rom}/{path}/{file}
  // (e.g. ROM10/490/50.DAT). REQUIRED before publishing a cutscene with a camera.
  cameraDat: { rom: '10', path: '', file: '' },

  actorsInZone: [],
  customNpcs: [],            // registered custom NPCs for this zone (Add-NPC "Custom NPCs" group)
  lastCompile: null,
  publishing: false,

  activeTab: 'trigger',   // which left-nav section is showing
};

// Warm the owner (trigger NPC)'s animation list. Thin wrapper over the SAME per-NPC
// cache every other dropdown uses (fetchNpcAnimsFor) — there is deliberately no
// separate "owner list" any more; every animation dropdown renders via animOptionsHtml.
export async function fetchNpcAnims() {
  const owner = state.cast.find((c) => c.id === state.owner);
  return (owner && owner.entity) ? fetchNpcAnimsFor(owner.entity) : null;
}

// Merge model clips + curated gestures into one suggestion list.
// ★ A model clip's MOTION is its first 3 chars — the 4th char is a variant/part, and
// the client resolves a motion parameterized on the first 3 (FlinchAnimation uses
// DatId("dfi?")), gathering the upper/lower pieces. So we dedupe clips by their 3-char
// motion and show that ("at0", "at1", "idl" …) like AltanaViewer, NOT "at00"/"at10".
// The option VALUE stays the real 4-char section id so the compiler/preview resolve it.
function _mergedAnimTags(modelClips, gestures) {
  const clips = modelClips || [];
  const gs = gestures || [];
  const seen = new Set();
  const out = [];
  for (const t of clips) {
    const motion = t.slice(0, 3);
    if (seen.has(motion)) continue;
    seen.add(motion);
    out.push({ tag: t, label: motion });   // value = 4-char id, display = 3-char motion
  }
  for (const g of gs) if (!seen.has(g.tag)) { seen.add(g.tag); out.push(g); }
  return out;
}

// Per-NPC animation cache (idle dropdowns + per-actor keyframe anim lists), keyed by
// entity hex. THE only animation-list store in the editor.
const _npcAnimCache = {};
const _npcAnimFetching = new Set();   // one fetch per entity per session (no re-render storms)
async function fetchNpcAnimsFor(hex) {
  if (!hex || hex === 'player' || !bridgeOnline()) return null;
  const key = _canonHex(hex);
  if (_npcAnimCache[key] || _npcAnimFetching.has(key)) return _npcAnimCache[key] || null;
  const actorId = key.toLowerCase().startsWith('0x') ? parseInt(key, 16) : null;
  if (actorId == null) return null;
  _npcAnimFetching.add(key);
  try {
    const r = await bridgeCall('zone.npcAnimations', { zone: _getCurrentZoneUrl(), zoneId: _currentZoneId(), actorId });
    if (r && r.ok) {
      // ★ Two lists per NPC, one cache:
      //  list (actions) — what a keyframe can PLAY IN GAME: the model's own 0x07
      //    scheduler routines (ati0/atk0/cast/dead…, each carrying the 0x2B clip it
      //    plays so the preview can show it) + curated gestures. Raw clips that no
      //    routine covers are appended as explicit "· preview only" entries — the
      //    compiler warns on them (0x2C SetAction can't fire a raw clip id).
      //  idleList — the model's raw clips (3-char motions: idl/wlk/btl) for the
      //    Default-idle dropdown. The idle is the always-on BASE layer (a rest-pose
      //    clip), NOT a scheduled action, so it lists clips directly — no "preview only"
      //    warning (that warning only makes sense in the keyframe Anim / action picker).
      const motions = r.motions || [];
      const gs = (r.gestures || []).map((g) => ({ tag: g.tag, label: g.label || g.tag }));
      let actions;
      if (motions.length) {
        // Only the things the game can actually fire (0x2C SetAction): the model's 0x07
        // scheduler routines + curated gestures. Raw clips with no covering routine are
        // dropped — they can't be scheduled in-game (they'd no-op), and the idle case is
        // handled by the keyframe's "return to idle" entry, not by picking a raw idl clip.
        // ★ '@'-prefixed SYSTEM routines (@tl0/@tr0 auto-turn) are dropped too: they're
        // schedulable but they're turn-in-place mechanics, not author anims — and '@tl0'
        // sorts right beside 'tlk0', so it kept getting mis-picked as a talk anim. The
        // only deliberate '@' entry is the separate IDLE_STOP ("return to idle") sentinel.
        actions = motions.filter((m) => !String(m.tag).startsWith('@'))
          .map((m) => ({ tag: m.tag, label: m.tag, clip: m.clip })).concat(gs);
      } else {
        actions = _mergedAnimTags(r.modelClips, r.gestures);   // old backend / equipped rig
      }
      _npcAnimCache[key] = { gestures: r.gestures || [], modelClips: r.modelClips || [],
                            motions, idle: r.idle || 'idl0', mobSkeleton: !!r.mobSkeleton,
                            list: actions,
                            idleList: _mergedAnimTags(r.modelClips, []) };
      _animListArrived();
      return _npcAnimCache[key];
    }
  } catch {}
  return null;
}

// A stable selector for the anim/idle <select> the user is in, so a re-render can put
// focus back on it — otherwise an async list arrival (or a change) blows away the DOM
// mid-interaction and the user can't arrow-key through the options.
function _animSelectSelector(el) {
  if (!el || el.tagName !== 'SELECT') return null;
  const cls = [...el.classList].filter((c) => c.startsWith('cs-')).map((c) => '.' + c).join('');
  if (!cls) return null;
  const dk = el.dataset.k != null ? `[data-k="${el.dataset.k}"]` : '';
  const di = el.dataset.idx != null ? `[data-idx="${el.dataset.idx}"]` : '';
  return 'select' + cls + dk + di;
}

// Re-run `rebuild`, then restore focus to whichever anim <select> had it (so arrow-key
// cycling survives the DOM rebuild). Exported-ish via module scope for the keyframe pane.
function _keepAnimFocus(rebuild) {
  const sel = _animSelectSelector(document.activeElement);
  rebuild();
  if (sel) { const el = document.querySelector(sel); if (el) el.focus(); }
}

// A per-NPC list just landed → refresh every anim dropdown currently on screen:
// the author modal (NPCs-tab idles) and the sequencer's open keyframe pane. Both
// re-render through animOptionsHtml, so they can't drift apart.
function _animListArrived() {
  _rebuildAnimTagClips();
  _keepAnimFocus(() => {
    const m = modalEl();
    if (m && m.classList.contains('open')) render();
    try { csRefreshOpenKeyframe(); } catch {}
  });
}

// state.animTagClips = {castId: {actionTag: clipName}} — how the 3D preview plays a
// ROUTINE tag (ati0) as the GLB clip it drives (at00). Rebuilt from the one anim cache
// whenever a list arrives or the cast changes; the sequencer reads it live per frame.
function _rebuildAnimTagClips() {
  const map = {};
  for (const c of state.cast || []) {
    if (!c || !c.entity || c.entity === 'player') continue;
    const rec = _npcAnimCache[_canonHex(c.entity)];
    if (!rec) continue;
    const m = {};
    for (const g of rec.list || []) if (g.clip) m[g.tag] = g.clip;
    map[c.id] = m;
  }
  state.animTagClips = map;
}

// Warm the cache for every cast member (fire-and-forget; each arrival re-renders the
// open anim dropdowns via _animListArrived). Also refreshes the preview tag→clip map
// synchronously for members already cached (no arrival event fires for those).
export function prefetchCastAnims() {
  for (const c of state.cast || []) {
    if (c && c.entity && c.entity !== 'player') fetchNpcAnimsFor(c.entity);
  }
  _rebuildAnimTagClips();
}

// ★ THE animation-options builder — the ONE function behind EVERY anim dropdown in
// the editor: the NPCs-tab Default idle AND the sequencer keyframe Anim selects
// (Dialog + Anim tracks read it via state.animOptionsFor). All of them show the
// actor's OWN motion list from _npcAnimCache — model clips deduped to 3-char motions
// (display label) with the real 4-char section id as the value, plus applicable
// gestures — so the lists can never diverge again. No hardcoded idl0-idl3.
// `ref` is an entity hex ("0x010F3031") OR a cast id ("npc2") — both resolve.
// Cold cache → the fetch is kicked here; when it lands _animListArrived re-renders
// every open dropdown. `emptyLabel` prepends a blank option (Dialog "default…");
// `emptyDisabled` makes that blank a non-reselectable "— pick —" placeholder.
// `kind`: 'action' (default) = the SCHEDULABLE motion routines a keyframe can fire
// in game; 'idle' = the model's raw clips (rest pose — a preview/staging concept).
// The sentinel value an Anim keyframe stores to mean "stop the current action and drop
// back to idle" — compiled to 0x5E (owner) / 0x6B (cast NPC), the retail stop-action ops.
export const IDLE_STOP = '@idle';

export function animOptionsHtml(ref, selected, { emptyLabel = null, emptyDisabled = false, kind = 'action', idleStop = false } = {}) {
  const hex = _entityHexOf(ref);
  const rec = hex ? _npcAnimCache[_canonHex(hex)] : null;
  if (hex && !rec) fetchNpcAnimsFor(hex);             // warm the cache → re-render on arrival
  const list = (rec && (kind === 'idle' ? (rec.idleList || rec.list) : rec.list)) || [];
  const seen = new Set(), opts = [];
  const add = (tag, label) => { if (tag && !seen.has(tag)) { seen.add(tag); opts.push({ tag, label }); } };
  if (idleStop) add(IDLE_STOP, '↩ return to idle');   // stop the current action → idle (0x5E/0x6B)
  for (const g of list) add(g.tag, g.label);          // the model's real motions
  let cur = (selected == null) ? '' : String(selected);
  if (!cur && emptyLabel == null) {                   // idle dropdowns: default = model's own idle
    if (!opts.length) add('idl0', 'idl');             // cache still loading → placeholder
    cur = (rec && rec.idle) || opts[0].tag;
  }
  if (cur) add(cur, cur.slice(0, 3));                 // guarantee current value is selectable
  // Show the MOTION name (label); value is the real 4-char id.
  const body = opts.map((o) => `<option value="${esc(o.tag)}"${o.tag === cur ? ' selected' : ''}>${esc(o.label || o.tag)}</option>`).join('');
  const head = (emptyLabel != null)
    ? `<option value=""${cur === '' ? ' selected' : ''}${emptyDisabled ? ' disabled' : ''}>${esc(emptyLabel)}</option>` : '';
  const tail = (hex && !rec) ? '<option value="" disabled>… loading list …</option>' : '';
  return head + body + tail;
}
state.animOptionsFor = animOptionsHtml;   // sequencer keyframe panes call it via the shared state

// Entity hex for a cast id / hex ref. Cast ids ("npc2", "player") never look like hex.
function _entityHexOf(ref) {
  if (!ref || ref === 'player') return null;
  const s = String(ref);
  if (/^(0x)?[0-9a-fA-F]{6,8}$/.test(s)) return s;
  const c = (state.cast || []).find((x) => x.id === s);
  return (c && c.entity && c.entity !== 'player') ? c.entity : null;
}

// Left-nav sections for the modal.
const CS_TABS = [
  { id: 'trigger',      label: 'Settings',     icon: 'settings' },
  { id: 'npcs',         label: 'NPCs',         icon: 'groups' },
  { id: 'dialog',       label: 'Dialog',       icon: 'chat' },
  { id: 'presentation', label: 'Presentation', icon: 'tune' },
  { id: 'publish',      label: 'Publish',      icon: 'publish' },
];

// Track kind metadata — display + which keyframe fields to render in the detail pane.
const TRACK_KINDS = {
  dialog:  { label: 'Dialog',    color: '#7fd88f', castRequired: true,  fields: ['line'] },
  face:    { label: 'Face',      color: '#82aaff', castRequired: true,  fields: ['target', 'talk'] },
  npc:     { label: 'NPC state', color: '#c792ea', castRequired: true,  fields: ['action'] },
  music:   { label: 'Music',     color: '#f7c873', castRequired: false, fields: ['song', 'slot'] },
  fade:    { label: 'Fade',      color: '#82aaff', castRequired: false, fields: ['kind'] },
  sfx:     { label: 'SFX',       color: '#ff8fcf', castRequired: false, fields: ['sfxId'], stub: true },
  vfx:     { label: 'VFX',       color: '#ff7b72', castRequired: false, fields: ['effectId'], stub: true },
  camera:  { label: 'Camera',    color: '#6fd3e0', castRequired: false, fields: ['shot'], stub: true },
};

// Which step ops the backend implements right now.
const STEP_OPS_ENABLED = new Set([
  'say', 'face', 'show', 'hide', 'place', 'music', 'music_volume', 'wait', 'end',
]);
const STEP_OPS_STUBBED = new Set([
  'camera', 'fade', 'anim', 'menu', 'branch', 'goto', 'load_zone',
]);

// ── Public init — called once from main.js ───────────────────────────────────
export function initCutsceneAuthor({ getCurrentZoneUrl, currentZoneId, fetchActorList }) {
  _getCurrentZoneUrl = getCurrentZoneUrl || _getCurrentZoneUrl;
  _currentZoneId    = currentZoneId    || _currentZoneId;
  _fetchActorList   = fetchActorList;

  // The Events-panel "Create" button opens the Create Event wizard.
  const btn = btnOpen();
  if (btn) btn.addEventListener('click', openCreateWizard);

  // Wizard "Create Event" → start a blank cutscene in edit mode.
  document.getElementById('cs-create-go')?.addEventListener('click', () => {
    const type = document.getElementById('cs-create-type')?.value || 'cutscene';
    if (type !== 'cutscene') return;           // only cutscene is wired for now
    _closeModal('cs-create-event-modal');
    startNewCutscene();
  });
  // Any [data-close] button inside the wizard dismisses it (Cancel + ×).
  document.getElementById('cs-create-event-modal')?.querySelectorAll('[data-close]')
    .forEach((b) => b.addEventListener('click', () => _closeModal('cs-create-event-modal')));
}

// True when there's unsaved authoring work for the CURRENT zone still in memory.
function _hasInProgress() {
  return state._zoneId === _currentZoneId()
    && (state.tracks.some((t) => (t.keyframes || []).length) || state.lines.length > 0 || state.cast.length > 2);
}

function openCreateWizard() {
  // Resume unsaved in-progress work for this zone instead of starting blank — the
  // author state is kept in memory across sequencer close until refresh/zone change.
  if (_hasInProgress()) { resumeAuthor(); return; }
  const w = document.getElementById('cs-create-event-modal');
  if (w) w.classList.add('open');
}

// Re-open the modal + sequencer on the EXISTING in-memory state (no reset) — used to
// resume after the sequencer was closed without publishing.
export async function resumeAuthor() {
  await ensureActorsLoaded();
  const m = modalEl(); if (m) m.classList.add('open');
  _setAuthorTitle(state.publishedEventId != null ? 'edit' : 'create');
  fetchNpcAnims();          // owner list → shared cache; _animListArrived re-renders
  prefetchCastAnims();
  render();
  // If the sequencer is already open and in author mode, just re-showing the modal is enough —
  // calling csOpenAuthor again would reset the playhead position, zoom, and rebuild the DOM.
  if (isCsSequencerOpen() && csIsAuthorMode()) return;
  try {
    csOpenAuthor(state, {
      title: state.publishedEventId != null
        ? `Edit Cutscene: Event ${state.publishedEventId}` : `Cutscene · ${_ownerDisplay()}`,
      onChange: (evt) => { if (evt && evt.type === 'publish') publish(); },
    });
  } catch {}
}
function _closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

// Set the author modal's title bar. mode: 'create' | 'edit'.
function _setAuthorTitle(mode) {
  const t = document.getElementById('cs-author-title');
  if (!t) return;
  t.textContent = (mode === 'edit' && state.publishedEventId != null)
    ? `Edit Cutscene: Event ${state.publishedEventId}`
    : 'Create Cutscene';
}

// Start a fresh blank cutscene and open the editor (create flow). Fully resets
// state so nothing leaks from a previous session/edit.
export async function startNewCutscene() {
  state.cast = []; state.lines = []; state.tracks = []; state.owner = '';
  state.publishedEventId = null; state.publishedActorId = null;
  state.eventIdOverride = null; state.lastCompile = null; state.cameraSceneFileId = null;
  state.cameraDat = { rom: '10', path: '', file: '' };
  state.totalFrames = 240; state.autoFadeIn = 0; state.autoFadeOut = 0;
  state.talkAnim = 'tlk0'; state.idleAnim = 'idl0'; state.eventMode = 0x0003;
  state.activeTab = 'trigger';
  await openModal('create');
}

// ── Public entry — open the modal seeded from an existing cutscene ───────────
//
// Called from the Events panel's "Edit Cutscene" button. Takes the same payload
// `zone.cutscene` returns (beats/animTracks/etc.) plus the event's owning actor
// info, walks the beats, and populates state so the author form shows the
// cutscene as editable steps. Deferred features (camera/anim/scheduler tasks)
// still round-trip as best-effort — the user can inspect them + republish.
function _canonActorU32(hexOrNum) {
  if (hexOrNum == null || hexOrNum === '') return null;
  if (typeof hexOrNum === 'number' && Number.isFinite(hexOrNum)) return hexOrNum >>> 0;
  const s = String(hexOrNum).trim();
  if (/^0x/i.test(s)) return parseInt(s, 16) >>> 0;
  const n = Number(s);
  return Number.isFinite(n) ? (n >>> 0) : null;
}

function _sessionMatches(eventId, actorId) {
  if (eventId == null || state.publishedEventId == null) return false;
  if (state.publishedEventId !== eventId) return false;
  // Actor is required when known — same event id on a different NPC is a different cutscene.
  if (actorId != null && state.publishedActorId != null) return state.publishedActorId === actorId;
  if (actorId != null && state.publishedActorId == null) return false;
  return true;
}

export async function openCutsceneAuthorFrom(cutsceneData, ownerActorHex, ownerActorName) {
  const eventId = cutsceneData && Number.isFinite(cutsceneData.eventId) ? cutsceneData.eventId : null;
  const actorId = _canonActorU32(
    (cutsceneData && cutsceneData.actorId) != null ? cutsceneData.actorId : ownerActorHex
  );

  // Already mid-edit on an in-memory session for this zone? Don't silently blow it away.
  if (_hasInProgress()) {
    // Re-opening the SAME actor+event you're already editing → just re-show it (keep edits).
    if (_sessionMatches(eventId, actorId)) { resumeAuthor(); return; }
    // A DIFFERENT event/actor → confirm before discarding the current in-progress edits.
    const curLabel = state.publishedEventId != null
      ? `Event ${state.publishedEventId}` + (state.publishedActorId != null ? ` @ 0x${state.publishedActorId.toString(16).toUpperCase()}` : '')
      : 'a new cutscene';
    const newLabel = eventId != null
      ? `Event ${eventId}` + (actorId != null ? ` @ 0x${actorId.toString(16).toUpperCase()}` : '')
      : 'a different cutscene';
    if (!await _csConfirm(
      `You're currently editing <b>${esc(curLabel)}</b>. Switch to <b>${esc(newLabel)}</b>? Any unsaved changes to ${esc(curLabel)} will be lost.`,
      { confirmLabel: 'Switch', cancelLabel: 'Keep editing' })) {
      return;   // keep editing the current one
    }
  }

  await ensureActorsLoaded();

  // Prefer the SAVED cutscene definition (lossless: flags, anims, exact tracks).
  // Only fall back to reconstructing from decoded beats when there's no saved def
  // (e.g. editing a retail cutscene we never authored). Keyed by actor+event — two
  // NPCs can share an event id (retail Maat 93 on 0x010F3031 vs 0x010F3032).
  let seeded = false;
  if (eventId != null && bridgeOnline()) {
    try {
      const r = await bridgeCall('zone.loadCutsceneDef', {
        zone: _getCurrentZoneUrl(), zoneId: _currentZoneId(), eventId, actorId,
      });
      if (r && r.ok && r.cutscene) { _seedFromDef(r.cutscene); seeded = true; }
    } catch {}
  }
  if (!seeded) _seedFromCutscene(cutsceneData, ownerActorHex, ownerActorName);

  const m = modalEl();
  if (m) m.classList.add('open');
  state._zoneId = _currentZoneId();     // tag the in-memory session to this zone (resume gate)
  state.activeTab = 'trigger';
  _setAuthorTitle('edit');
  fetchNpcAnims();          // owner list → shared cache; _animListArrived re-renders
  prefetchCastAnims();
  render();
  try {
    csOpenAuthor(state, {
      title: `Edit Cutscene: Event ${state.publishedEventId != null ? state.publishedEventId : ''} · ${_ownerDisplay()}`,
      onChange: (evt) => { if (evt && evt.type === 'publish') publish(); },
    });
  } catch {}
}

// Seed state from a SAVED cutscene definition (the exact dict buildCutscene made).
// Lossless — the source of truth for re-editing an authored cutscene.
function _seedFromDef(def) {
  const cast = (def.cast && def.cast.cast) || [];
  state.cast = cast.length ? cast.map((c) => ({ id: c.id, entity: c.entity, name: c.name })) : [
    { id: 'player', entity: 'player', name: 'Player' },
  ];
  state.owner = def.actor || (state.cast.find((c) => c.id !== 'player')?.id) || 'npc';
  state.lines = ((def.dialog && def.dialog.lines) || []).map((l) => ({ ...l }));
  state.tracks = ((def.timeline && def.timeline.tracks) || []).map((t) => ({
    ...t, keyframes: (t.keyframes || []).map((k) => ({ ...k })),
  }));
  ensureActorGroups();
  state.selected = null;
  state.totalFrames = Math.max(30, def.totalFrames | 0 || 240);
  const f = def.flags || {};
  state.eventMode = Number.isFinite(f.eventMode) ? f.eventMode : 0x0003;
  state.lockPlayer = !!f.lockPlayer;
  state.cameraLock = !!f.cameraLock;
  state.cancelSet  = !!f.cancelSet;
  state.talkAnim   = f.talkAnim || 'tlk0';
  state.idleAnim   = f.idleAnim || 'idl0';
  state.hideActorsOnEnd = !!f.hideActorsOnEnd;
  state.hideNpcNames = !!f.hideNpcNames;
  state.resetZoomOnEnd = f.resetZoomOnEnd !== false;   // default ON (old defs get it too)
  state.hideOwnerInEditor = _loadHideTriggerNpc();   // workspace/project-scoped view pref
  state.lastCompile = null;
  const id = Number.isFinite(def.eventId) ? def.eventId : null;
  state.publishedEventId = id;
  state.eventIdOverride = id;
  // Prefer actor id stored on the def; else the owner cast's entity hex.
  const ownerEnt = (state.cast.find((c) => c.id === state.owner) || {}).entity;
  state.publishedActorId = _canonActorU32(def.actorId != null ? def.actorId : ownerEnt);
  state.cameraSceneFileId = def.cameraSceneFileId || null;   // keep the same camera scene file on republish
  // Restore the Camera DAT placement so republish writes to the same file (older defs lack it).
  const cd = def.cameraDat || {};
  state.cameraDat = {
    rom:  cd.rom  != null ? String(cd.rom)  : '10',
    path: cd.path != null ? String(cd.path) : '',
    file: cd.file != null ? String(cd.file) : '',
  };
}

// How long (timeline frames @ 30fps) an imported camera shot takes to travel through its
// keyframes before it HOLDS the final pose. FFXI/UE plays each shot's parametric route over a
// fixed nominal window (~6s = PlaybackSeconds) then freezes the last frame while dialogue runs
// — it does NOT snap through them (old bug used b.dur ≈ 5) nor drift across the whole gap (some
// shot gaps are 90s+). Capped just short of the next shot's hard cut on import.
const CS_CAM_MOVE_FRAMES = 180;

// A shot's REAL authored move length (b.camDur = the routine camera command's raw u16 @+6) is in
// the SAME frame unit as the event's wait_time-derived shot starts — proven two ways: wait_time
// (0x1C) accumulates raw frame counts, and the compiler's _build_routine writes editor timeline
// frames straight into that same u16 byte-identical to retail (s075 move = 180). So the scale is
// 1.0 (camDur == timeline frames); this constant only exists to make that explicit / tunable.
const CS_CAM_DUR_SCALE = 1.0;

// FFXI camera routes store zoom as a FOCAL LENGTH (default 350), not an FOV angle; the client
// derives vertical FOV = 2·atan2(192, focal). Convert to degrees for the editor keyframe.
const _focalToFovDeg = (focal) => 2 * Math.atan2(192, +focal || 350) * 180 / Math.PI;

// Rebuild `state` from a parsed cutscene payload (bridge `zone.cutscene`).
function _seedFromCutscene(cs, ownerActorHex, ownerActorName) {
  state.cast = [
    { id: 'player', entity: 'player', name: 'Player' },
    { id: 'npc',    entity: _canonHex(ownerActorHex), name: ownerActorName || 'Owner' },
  ];
  state.owner = 'npc';
  state.lines = [];
  state.tracks = [];
  state.selected = null;
  state.totalFrames = Math.max(200, (cs && cs.totalFrames) | 0 || 300);
  state.eventMode = 0x0013;
  state.hideOwnerInEditor = _loadHideTriggerNpc();   // workspace/project-scoped view pref
  state.lastCompile = null;
  // Lock the edited event's id in so re-publishing UPDATES it in place instead
  // of allocating a new one. `cs.eventId` comes from the zone.cutscene payload.
  const editingId = (cs && Number.isFinite(cs.eventId)) ? cs.eventId : null;
  state.publishedEventId = editingId;
  state.eventIdOverride = editingId;
  state.publishedActorId = _canonActorU32(
    (cs && cs.actorId) != null ? cs.actorId : ownerActorHex
  );

  const beats = (cs && cs.beats) || [];

  // Build a cast map: hex → cast id. Owner is always 'npc'.
  const castByHex = new Map();
  castByHex.set(_canonHex(ownerActorHex), 'npc');

  // Ensure a cast entry exists for `actorId` (u32). Returns its id.
  const ensureCast = (actorId, name) => {
    if (!actorId) return null;
    const hex = '0x' + (actorId >>> 0).toString(16).padStart(8, '0').toUpperCase();
    if (castByHex.has(hex)) return castByHex.get(hex);
    let n = 2;
    while (state.cast.some((c) => c.id === `npc${n}`)) n += 1;
    const id = `npc${n}`;
    state.cast.push({ id, entity: hex, name: name || `NPC ${hex.slice(-4)}` });
    castByHex.set(hex, id);
    return id;
  };

  // Map speaker NAME to cast id (dialog beats carry the label, not the id).
  // Prefer the owner/trigger when the name matches — zone lists can have several
  // NPCs with the same display name (two "Maat"s), and picking the wrong one
  // used to add a second cast entry → double model in the viewport.
  const ensureCastByName = (name) => {
    if (!name) return null;
    const ownerC = state.cast.find((c) => c.id === state.owner);
    if (ownerC && ownerC.name === name) return ownerC.id;
    const hit = state.cast.find((c) => c.name === name);
    if (hit) return hit.id;
    // Prefer an in-zone actor whose id already matches the owner entity.
    const ownerHex = ownerC ? _canonHex(ownerC.entity) : '';
    const a = state.actorsInZone.find((x) => x.name === name
      && (!ownerHex || _actorHex(x) === ownerHex))
      || state.actorsInZone.find((x) => x.name === name);
    if (a) return ensureCast(+a.actorId, a.name);
    let n = 2;
    while (state.cast.some((c) => c.id === `npc${n}`)) n += 1;
    state.cast.push({ id: `npc${n}`, entity: '', name });
    return `npc${n}`;
  };

  const nextLine = () => {
    let n = state.lines.length + 1;
    while (state.lines.some((l) => l.id === `line${n}`)) n += 1;
    return `line${n}`;
  };

  // Group beats by track kind so the timeline UI mirrors the source cutscene.
  // Every retail beat type gets its own track so the user can see the full
  // structure. Types the compiler doesn't yet emit round-trip as read-only
  // "preview" tracks — they're skipped at Publish with a warning.
  const trackFor = new Map();  // key → track ref
  const useTrack = (key, mkNew) => {
    if (!trackFor.has(key)) {
      const t = mkNew();
      trackFor.set(key, t);
      state.tracks.push(t);
    }
    return trackFor.get(key);
  };
  const posSeeded = new Set();  // one Position keyframe per actor (first 0xBA staging spot)
  // Frames where a camera shot begins — used to end each shot's move just before the next
  // shot's hard cut (see the camera-import block below).
  const camBeatFrames = beats.filter((x) => x.camera && x.camera.length)
    .map((x) => x.frame | 0).sort((a, b) => a - b);

  for (const b of beats) {
    const frame = b.frame | 0;
    // Retail camera shots carry their pose samples (eye/look/fov over the shot) in
    // b.camera — regardless of the beat's lane type (camera/shot/task). Import them as
    // EDITABLE camera keyframes so Edit Cutscene loads the same pans/rotations/FOV that
    // Load view shows (first sample = a cut, later ones glide). fov is a focal length → °.
    if (b.camera && b.camera.length) {
      const cam = b.camera;
      // The route's keyframe `time` (0..1) is PARAMETRIC. Spread the shot over its real authored
      // move length (b.camDur) or the nominal, capped just short of the next shot's hard cut; the
      // camera then HOLDS its final pose. DECOMPOSE the route into three INDEPENDENT channels so a
      // held aim / a late zoom no longer drags position along (the coupling that looked "weird").
      const nextCam = camBeatFrames.find((f) => f > frame);
      const gap = (nextCam != null) ? (nextCam - frame) : CS_CAM_MOVE_FRAMES;
      const moveFrames = b.camDur ? Math.round(b.camDur * CS_CAM_DUR_SCALE) : CS_CAM_MOVE_FRAMES;
      const dur = Math.max(1, Math.min(moveFrames, gap - 1));
      const toFrame = (t) => frame + Math.round((t != null ? t : 0) * dur);
      const { pos, rot, zoom } = csDecomposeRoute(cam);
      const posT  = useTrack('campos',  () => ({ kind: 'campos',  keyframes: [] }));
      const rotT  = useTrack('camrot',  () => ({ kind: 'camrot',  keyframes: [] }));
      const zoomT = useTrack('camzoom', () => ({ kind: 'camzoom', keyframes: [] }));
      const smooth = cam[0].mode;   // route SmoothingType easing (per shot), carried on the cut
      // Position defines the shot: first point is a CUT, the rest MOVE (3+ → curved arc, 2 → line).
      pos.forEach((p, i) => posT.keyframes.push({
        frame: toFrame(p.t), eye: p.eye,
        camKind: (i === 0) ? 'still' : (pos.length >= 3 ? 'curved' : 'spline'),
        ...(smooth != null ? { smooth } : {}),
      }));
      rot.forEach((r) => rotT.keyframes.push({ frame: toFrame(r.t), look: r.look, ...(r.roll ? { roll: r.roll } : {}) }));
      zoom.forEach((z) => zoomT.keyframes.push({ frame: toFrame(z.t), fov: Math.round(_focalToFovDeg(z.fov) * 10) / 10 }));   // 1 decimal → near-exact focal round-trip (slider still shows integers)
    }
    switch (b.type) {
      case 'dialogue': {
        const speakerId = ensureCastByName(b.speaker) || 'npc';
        const lineId = nextLine();
        state.lines.push({ id: lineId, speaker: speakerId, text: b.text || '' });
        const t = useTrack(`dialog:${speakerId}`,
          () => ({ kind: 'dialog', castId: speakerId, keyframes: [] }));
        t.keyframes.push({ frame, line: lineId });
        break;
      }
      case 'npc': {
        const id = ensureCast(b.actorId, b.actor);
        if (!id) break;
        // Staging position: retail places each NPC with a 0xBA (the backend hangs it on the npc
        // beat as b.pos / b.dir). Import the FIRST one as a Position keyframe so the 3D actor
        // stands where the cutscene puts it — otherwise it falls back to its npc_list default.
        if (b.pos && !posSeeded.has(id)) {
          posSeeded.add(id);
          const pt = useTrack(`position:${id}`, () => ({ kind: 'position', castId: id, keyframes: [] }));
          const pkf = { frame: 0, actor: id, pos: b.pos };
          if (typeof b.dir === 'number') pkf.dir = b.dir;
          pt.keyframes.push(pkf);
        }
        if (b.action === 'show' || b.action === 'hide') {
          const t = useTrack(`npc:${id}`, () => ({ kind: 'npc', castId: id, keyframes: [] }));
          t.keyframes.push({ frame, action: b.action });
        }
        break;
      }
      case 'fade': {
        const kind = b.tag === 'fdo1' ? 'out' : b.tag === 'fdi1' ? 'in' : 'in';
        const t = useTrack('fade', () => ({ kind: 'fade', keyframes: [] }));
        // Carry the backend-estimated duration (b.dur) so the fade renders as a
        // bar of the right length — matching Load-cutscene view.
        t.keyframes.push({ frame, kind, tag: b.tag, dur: b.dur || 30 });
        break;
      }
      case 'camera':
        // Camera poses are imported above (b.camera) as EDITABLE keyframes; a bare
        // camera beat with no pose data has nothing to edit, so nothing to add here.
        break;
      case 'shot': {
        const t = useTrack('shot', () => ({ kind: 'shot', keyframes: [], readOnly: true }));
        t.keyframes.push({ frame, tag: b.tag, dur: b.dur });
        break;
      }
      case 'task': {
        const t = useTrack('task', () => ({ kind: 'task', keyframes: [], readOnly: true }));
        // Carry b.dur so the task renders as a bar of the same length as Load view.
        t.keyframes.push({ frame, tag: b.tag, res: b.res, dur: b.dur });
        break;
      }
      case 'taskEnd': {
        const t = useTrack('taskEnd', () => ({ kind: 'taskEnd', keyframes: [], readOnly: true }));
        t.keyframes.push({ frame, tag: b.tag });
        break;
      }
      case 'wait': {
        const t = useTrack('wait', () => ({ kind: 'wait', keyframes: [], readOnly: true }));
        t.keyframes.push({ frame, frames: b.frames });
        break;
      }
      case 'anim':
      case 'emote': {
        const id = ensureCast(b.actorId, b.actor) || 'npc';
        const t = useTrack(`anim:${id}`, () => ({ kind: 'anim', castId: id, keyframes: [], readOnly: true }));
        t.keyframes.push({ frame, name: b.name, actor: b.actor });
        break;
      }
      case 'vfx': {
        const t = useTrack('vfx', () => ({ kind: 'vfx', keyframes: [], readOnly: true }));
        t.keyframes.push({ frame, effect: b.effect, caster: b.caster, target: b.target });
        break;
      }
      case 'music': {
        const t = useTrack('music', () => ({ kind: 'music', keyframes: [] }));
        t.keyframes.push({ frame, name: b.name });
        break;
      }
      case 'end': {
        const t = useTrack('end', () => ({ kind: 'end', keyframes: [], readOnly: true }));
        t.keyframes.push({ frame });
        break;
      }
      case 'face': break;   // facing (look_at / set_yaw) handled in the post-pass below
      default: {
        // Unknown / future beat types — surface them so nothing is silently lost.
        const t = useTrack(`raw:${b.type}`, () => ({ kind: b.type, keyframes: [], readOnly: true }));
        t.keyframes.push({ frame, raw: b });
        break;
      }
    }
  }
  // ── Facing (0x4A look_at / 0x4B set_yaw) ──
  // look_at → a Face keyframe (the NPC turns to face the target; the player stays 'player').
  // set_yaw → an explicit heading; fold it into the actor's Position keyframe dir so the preview
  // rotates the NPC — this is the REAL facing (the 0xBA staging dir is often overridden by it).
  const hexOf = (aid) => '0x' + ((aid || 0) >>> 0).toString(16).padStart(8, '0').toUpperCase();
  const isPlayerLabel = (s) => /player|^you$/i.test(s || '');
  const yawSeen = new Set();
  for (const b of beats) {
    if (b.type !== 'face') continue;
    const id = castByHex.get(hexOf(b.actorId)) || ensureCast(b.actorId, b.actor);
    if (!id) continue;
    if (b.target || b.targetId != null) {
      // Magic ids (high byte 0x7F): "local player" → the player; "event entity"/others → the
      // owner NPC. Only a real entity id becomes (or reuses) a cast member.
      let tid;
      if (isPlayerLabel(b.target)) tid = 'player';
      else if (b.targetId != null && (b.targetId >>> 24) === 0x7F) tid = state.owner || 'npc';
      else if (b.targetId != null) tid = castByHex.get(hexOf(b.targetId)) || ensureCast(b.targetId, b.target);
      else tid = 'player';
      const ft = useTrack(`face:${id}`, () => ({ kind: 'face', castId: id, keyframes: [] }));
      ft.keyframes.push({ frame: b.frame | 0, actor: id, target: tid || 'player' });
    } else if (typeof b.yaw === 'number' && !yawSeen.has(id)) {
      yawSeen.add(id);
      let pt = trackFor.get(`position:${id}`);
      if (!pt) pt = useTrack(`position:${id}`, () => ({ kind: 'position', castId: id, keyframes: [] }));
      if (!pt.keyframes.length) pt.keyframes.push({ frame: 0, actor: id });
      if (typeof pt.keyframes[0].dir !== 'number') pt.keyframes[0].dir = b.yaw;
    }
  }

  // ── Import the per-NPC gesture timeline (0x5B sched_ext) ──
  // The decode returns `animTracks` = {entityId: [{frame, tag}]}, each tag a 4-char clip
  // (tlk0 / ann0 / bow0 …). A gesture that lines up with a dialogue line for that speaker IS
  // that line's talk gesture → stamp it on the Dialog keyframe (so it plays the real gesture
  // instead of the default tlk0). Every other gesture becomes a standalone Anim keyframe so the
  // NPC performs it. Also stash the raw tracks + resolved clips for the 3D preview (below).
  const animTracks = (cs && cs.animTracks) || {};
  state.sourceAnim = { animTracks, motionClips: (cs && cs.motionClips) || {} };
  for (const [entStr, gestures] of Object.entries(animTracks)) {
    const ent = parseInt(entStr, 10);
    if (!Number.isFinite(ent)) continue;
    const hex = '0x' + (ent >>> 0).toString(16).padStart(8, '0').toUpperCase();
    const id = castByHex.get(hex) || ensureCast(ent, null);
    if (!id) continue;
    const dialogTrack = trackFor.get(`dialog:${id}`);
    for (const g of (gestures || [])) {
      const tag = g && g.tag;
      if (!tag) continue;
      const frame = g.frame | 0;
      const dkf = dialogTrack && dialogTrack.keyframes.find((k) => Math.abs((k.frame | 0) - frame) <= 1 && !k.anim);
      if (dkf) { dkf.anim = tag; continue; }                 // this line's talk gesture
      const at = useTrack(`anim:${id}`, () => ({ kind: 'anim', castId: id, keyframes: [] }));
      at.keyframes.push({ frame, actor: id, anim: tag });     // standalone gesture
    }
  }

  // If the source cutscene has a totalFrames hint, use it; else derive from last beat + tail padding.
  const lastFrame = state.tracks.reduce((m, t) => Math.max(m, ...t.keyframes.map((k) => k.frame)), 0);
  state.totalFrames = Math.max(state.totalFrames, lastFrame + 60);
  // Fold into the grouped model (Actor groups + Position/Dialog/Anim sub-tracks), same as a
  // saved def. NPC/dialog/position/anim become editable sub-tracks; read-only retail structure
  // (shot/task/end) is dropped — the camera POSES already imported as editable keyframes above.
  ensureActorGroups();
}

// ── Modal open / close ────────────────────────────────────────────────────────
async function openModal(mode = 'create') {
  const m = modalEl();
  if (!m) return;
  m.classList.add('open');
  state._zoneId = _currentZoneId();     // tag the in-memory session to this zone (resume gate)
  await ensureActorsLoaded();
  seedDefaults();
  _setAuthorTitle(mode);
  fetchNpcAnims();                        // owner list → shared cache; _animListArrived re-renders
  prefetchCastAnims();                    // per-actor lists for the sequencer keyframe panes
  render();
  // Auto-open the sequencer so the user doesn't have to click again.
  try {
    csOpenAuthor(state, {
      title: mode === 'edit' && state.publishedEventId != null
        ? `Edit Cutscene: Event ${state.publishedEventId}` : `Cutscene · ${_ownerDisplay()}`,
      onChange: (evt) => { if (evt && evt.type === 'publish') publish(); },
    });
  } catch {}
}

// Organise the flat track list into the ACTOR-GROUP model the editor uses:
//   • one mandatory `camera` track (flat, first)
//   • one `actor` GROUP per cast member — its OWN keyframes are show/hide (from the
//     old `npc` tracks); it owns Face / Dialog / Position / Anim SUB-tracks
//     ({kind, castId}), kept adjacent right after the group
//   • flat Wait / Fade / Music / SFX / VFX tracks
// Migrates old flat cutscenes (dialog/face singletons w/ per-keyframe speaker/actor,
// plus npc + position tracks) AND is idempotent for already-grouped state. The compile
// flattens this back (actor→npc, sub-tracks keep their castId — see buildCutscene).
function ensureActorGroups() {
  _pruneDuplicateCast();
  const tracks = state.tracks || [];
  const SUB = ['face', 'dialog', 'position', 'anim'];
  const FLAT = new Set(['wait', 'fade', 'music', 'sfx', 'vfx']);
  const defaultActor = () => state.owner || (state.cast.find((c) => c.id !== 'player')?.id) || 'npc';

  const CAMERA_SUBS = new Set(CAMERA_SUB_KINDS);   // campos / camrot / camzoom
  // Camera is a GROUP (Position / Rotation / Zoom sub-tracks). Adopt existing sub-tracks; if none
  // exist, migrate an older single 'camera' track (each keyframe carried eye+look+fov together) by
  // splitting it into the three channels so it keeps working.
  let camera = tracks.find((t) => t.kind === 'camera');
  let camPos = tracks.find((t) => t.kind === 'campos');
  let camRot = tracks.find((t) => t.kind === 'camrot');
  let camZoom = tracks.find((t) => t.kind === 'camzoom');
  if (!camPos && !camRot && !camZoom) {
    camPos = { kind: 'campos', keyframes: [] };
    camRot = { kind: 'camrot', keyframes: [] };
    camZoom = { kind: 'camzoom', keyframes: [] };
    for (const kf of ((camera && camera.keyframes) || [])) {   // legacy single-camera migration
      const f = kf.frame | 0;
      camPos.keyframes.push({ frame: f, eye: kf.eye || [0, 0, 0], camKind: kf.camKind || 'still', ...(kf.smooth != null ? { smooth: kf.smooth } : {}) });
      camRot.keyframes.push({ frame: f, look: kf.look || kf.eye || [0, 0, 0], ...(kf.roll ? { roll: kf.roll } : {}) });
      camZoom.keyframes.push({ frame: f, fov: (kf.fov != null ? +kf.fov : 57) });
    }
  }
  camPos = camPos || { kind: 'campos', keyframes: [] };
  camRot = camRot || { kind: 'camrot', keyframes: [] };
  camZoom = camZoom || { kind: 'camzoom', keyframes: [] };
  camera = camera || { kind: 'camera', keyframes: [] };
  camera.keyframes = [];                          // the group owns no keyframes — cuts live on Position
  camera.mandatory = true; camera.group = true; delete camera.readOnly; delete camera.castId;
  if (camera.collapsed == null) camera.collapsed = false;

  // A locked Wait track always sits right under Fade (auto) — every sequence wants pacing,
  // so it's non-deletable (right-click it to drop Wait keyframes). Extra waits stay at the tail.
  let waitTrack = tracks.find((t) => t.kind === 'wait');
  if (!waitTrack) waitTrack = { kind: 'wait', keyframes: [] };
  waitTrack.locked = true; delete waitTrack.readOnly;

  const order = [];                    // first-seen actor order
  const groups = new Map();            // castId → { group, sub:{kind:track} }
  const groupFor = (cid) => {
    cid = cid || defaultActor();
    if (!groups.has(cid)) { groups.set(cid, { group: { kind: 'actor', castId: cid, collapsed: false, keyframes: [] }, sub: {} }); order.push(cid); }
    return groups.get(cid);
  };
  const subFor = (cid, kind) => {
    const g = groupFor(cid);
    if (!g.sub[kind]) g.sub[kind] = { kind, castId: g.group.castId, keyframes: [] };
    return g.sub[kind];
  };

  // The Player always gets a LOCKED group, created first so it renders just under Fade (auto).
  // You can't add the player via the cast picker, so this is where its Position / Face / etc. live.
  groupFor('player').group.locked = true;

  // Pass 1: adopt existing actor groups (keep their show/hide keyframes + collapsed).
  for (const t of tracks) {
    if (t.kind === 'actor') { const g = groupFor(t.castId); g.group.keyframes.push(...(t.keyframes || [])); g.group.collapsed = !!t.collapsed; }
  }
  // Pass 2: fold every actor-owned track's keyframes into the right group / sub-track.
  for (const t of tracks) {
    if (t.kind === 'actor' || t.kind === 'camera' || CAMERA_SUBS.has(t.kind) || FLAT.has(t.kind)) continue;
    const kfs = t.keyframes || [];
    if (t.kind === 'npc') { for (const kf of kfs) groupFor(t.castId).group.keyframes.push({ ...kf }); continue; }
    if (SUB.includes(t.kind)) {
      const actorKey = t.kind === 'dialog' ? 'speaker' : 'actor';
      for (const kf of kfs) {
        // The sub-track's castId wins over a (possibly stale) per-keyframe actor/speaker; a
        // legacy FLAT track has no castId, so it still falls back to the keyframe's own value.
        const cid = t.castId || kf[actorKey] || defaultActor();
        subFor(cid, t.kind).keyframes.push({ ...kf, [actorKey]: cid });   // re-stamp the actor onto the keyframe
      }
    }
    // other kinds (retail-only preview) are dropped — they were read-only anyway
  }
  // Deliberately DON'T force a group for the owner/trigger NPC — a track for it is only
  // created once it actually owns a keyframe (show/hide, dialog, position, anim). Adding an
  // empty owner group here cluttered every sequence with a trigger-NPC track nobody asked for.

  const byFrame = (a, b) => (a.frame | 0) - (b.frame | 0);
  const rebuilt = [camera, camPos, camRot, camZoom, waitTrack];   // Camera group + subs → Wait (locked) → actors
  for (const cid of order) {
    const { group, sub } = groups.get(cid);
    group.keyframes.sort(byFrame);
    rebuilt.push(group);
    for (const kind of SUB) if (sub[kind]) { sub[kind].keyframes.sort(byFrame); rebuilt.push(sub[kind]); }
  }
  rebuilt.push(...tracks.filter((t) => FLAT.has(t.kind) && t !== waitTrack));
  state.tracks = rebuilt;
}

function seedDefaults() {
  const isFresh = state.cast.length === 0 && state.lines.length === 0 && state.tracks.length === 0;
  if (state.cast.length === 0) {
    state.cast = [
      { id: 'player', entity: 'player', name: 'Player' },
      { id: 'npc',    entity: '',       name: 'NPC' },
    ];
    state.owner = 'npc';
  }
  // No starter dialog line: a pre-seeded line spoken by the owner would auto-create a
  // trigger-NPC dialog track. Start empty — the user adds lines/tracks themselves.
  if (state.tracks.length === 0) {
    state.totalFrames = 240;
    // Only the mandatory Camera track (+ auto Wait/Player from ensureActorGroups). No
    // owner/trigger-NPC track is seeded — it appears only once it owns a keyframe.
    state.tracks = [
      { kind: 'camera', keyframes: [] },
    ];
  }
  ensureActorGroups();
  state.hideOwnerInEditor = _loadHideTriggerNpc();   // workspace/project-scoped view pref
  if (isFresh) { state.publishedEventId = null; state.publishedActorId = null; state.eventIdOverride = null; }
}

// Auto-generate a stable numeric id for a new line — user never sees these.
function nextLineId() {
  let n = state.lines.length + 1;
  while (state.lines.some((l) => l.id === `line${n}`)) n += 1;
  return `line${n}`;
}

// Fresh step template — filled with sane defaults for every op that needs
// required fields. Prevents "KeyError: 'target'" style crashes when the user
// picks an op from the dropdown but doesn't touch the other selects (which
// just render their first option pre-selected without firing `change`).
function defaultStep(op) {
  const owner = state.owner || 'npc';
  const firstLine = state.lines[0]?.id || '';
  switch (op) {
    case 'face':          return { op, actor: owner, target: 'player', talk: true };
    case 'say':           return { op, line: firstLine };
    case 'narrate':       return { op, text: firstLine };
    case 'show':
    case 'hide':
    case 'place':         return { op, actor: owner };
    case 'wait':          return { op, frames: 30 };
    case 'music':         return { op, track: 0, song: 0 };
    case 'music_volume':  return { op, volume: 100, frames: 30 };
    case 'end':           return { op };
    // Stubbed ops — backend rejects them; still emit shells so the row renders.
    case 'anim':          return { op, actor: owner, tag: 'idl0' };
    case 'fade':          return { op, kind: 'in' };
    case 'camera':        return { op, shot: '' };
    case 'menu':          return { op, options: ['Yes', 'No'], text: firstLine };
    case 'branch':        return { op, on: 'menu_result', cases: {} };
    case 'goto':          return { op, to: '' };
    case 'load_zone':     return { op, zoneId: 0 };
    default:              return { op };
  }
}

async function ensureActorsLoaded() {
  const zid = _currentZoneId();
  // Custom NPCs registered for this zone → the "Custom NPCs" group at the top of the
  // Add-NPC picker. Refetched each time (tiny list) so an NPC just added in the Asset
  // Browser appears without reopening the author.
  try {
    const r = await bridgeCall('customNpc.list', zid ? { zoneId: zid } : {});
    state.customNpcs = (r && r.ok && Array.isArray(r.npcs)) ? r.npcs : [];
  } catch { state.customNpcs = []; }
  // Cache the actor list PER ZONE — otherwise loading a cutscene from another zone (e.g. editing
  // Balasiel, then back to Maat) leaves this stuck on the wrong zone's actors, so the Trigger NPC
  // can't be found and names show as "???". Reload whenever the zone changed.
  if (state.actorsInZone.length && state._actorsZoneId === zid) return;
  if (!_fetchActorList) return;
  try {
    const actors = await _fetchActorList();
    // Sort A-Z by name; unnamed rows (doors/gates/etc.) sink to the bottom.
    const arr = Array.isArray(actors) ? actors.slice() : [];
    arr.sort((a, b) => {
      const an = a.name || '';
      const bn = b.name || '';
      if (an && !bn) return -1;
      if (!an && bn) return 1;
      return an.localeCompare(bn);
    });
    state.actorsInZone = arr;
    state._actorsZoneId = zid;
  } catch (e) {
    state.actorsInZone = [];
    state._actorsZoneId = null;
  }
}

// ── Build the compilable xi.cutscene.v1 dict from state ────────────────────
function buildCutscene() {
  const castRows = state.cast.filter(
    (c) => c.id !== 'player' && c.entity !== 'player' && String(c.entity || '').trim() !== '');
  const cast = [{ id: 'player', entity: 'player', name: 'Player' }, ...castRows];

  // Timeline mode — hand the compiler tracks + total length. Read-only tracks
  // (populated by "Edit Cutscene" from retail — camera / shot / task / wait /
  // taskEnd / end / anim / vfx) are skipped: the compiler can't emit them yet
  // and rewriting them wholesale would lose retail-original bytes.
  // Position keyframes bind to a marker by NAME; re-resolve to the marker's CURRENT
  // position at publish time so moving a marker + re-publishing updates the placement.
  const markers = csGetMarkers();
  const tracks = state.tracks
    .filter((t) => t.keyframes && t.keyframes.length && !t.readOnly && t.kind !== 'camera')
    .map((t) => ({
      // Flatten the grouped model for the backend: an Actor group's own keyframes are
      // show/hide → an `npc` track; Face/Dialog/Position sub-tracks pass through with
      // their castId (the compiler reads track.castId as the actor/speaker).
      kind: t.kind === 'actor' ? 'npc' : t.kind,
      ...(t.castId ? { castId: t.castId } : {}),
      keyframes: t.keyframes
        .slice()
        .sort((a, b) => (a.frame | 0) - (b.frame | 0))
        .map((kf) => {
          const out = { ...kf, frame: kf.frame | 0 };
          if (t.kind === 'position' && out.marker) {
            const m = markers.find((x) => x.name === out.marker);
            if (m) out.pos = m.pos;                    // refresh from the live marker
          }
          return out;
        }),
    }));

  // Camera ships as the three sub-tracks (campos/camrot/camzoom); the backend recomposes them
  // directly (_lower_camera_tracks) into the route, so no flattened 'camera' track is needed.

  // Event id priority: user-set override > previously-published id > auto.
  // Manual override lets the user pin a specific number like 25000; the
  // publishedEventId auto-lock still kicks in for subsequent iterations of
  // the same cutscene.
  const eventIdOut = state.eventIdOverride != null
    ? state.eventIdOverride
    : (state.publishedEventId ?? 'auto');

  return {
    schema: 'xi.cutscene.v1',
    actor: state.owner,
    eventId: eventIdOut,
    cast: {
      schema: 'xi.cutscene.npc.v1',
      cast: cast.map((c) => ({ id: c.id, entity: c.entity, name: c.name })),
    },
    dialog: {
      schema: 'xi.cutscene.dialog.v1',
      lines: state.lines.map((l) => ({ id: l.id, text: l.text, speaker: l.speaker })),
    },
    flags: {
      lockPlayer:  !!state.lockPlayer,
      cameraLock:  !!state.cameraLock,
      cancelSet:   !!state.cancelSet,
      eventMode:   state.eventMode,
      talkAnim:    state.talkAnim || 'tlk0',
      idleAnim:    state.idleAnim || 'idl0',
      hideActorsOnEnd: !!state.hideActorsOnEnd,
      hideNpcNames: !!state.hideNpcNames,
      resetZoomOnEnd: state.resetZoomOnEnd !== false,
    },
    totalFrames: Math.max(30, state.totalFrames | 0),
    autoFadeIn:  Math.max(0, state.autoFadeIn | 0),
    autoFadeOut: Math.max(0, state.autoFadeOut | 0),
    // Round-trip the camera scene DAT id so the backend reuses the SAME file on every publish
    // (else it churns a new file each time → the running client can't load it → crash).
    ...(state.cameraSceneFileId ? { cameraSceneFileId: state.cameraSceneFileId } : {}),
    // Where the camera scene DAT is written on disk (ROM{rom}/{path}/{file}). Required to
    // publish a cutscene with a camera; the backend re-validates + gates on it.
    cameraDat: {
      rom:  String((state.cameraDat && state.cameraDat.rom)  || '').trim(),
      path: String((state.cameraDat && state.cameraDat.path) || '').trim(),
      file: String((state.cameraDat && state.cameraDat.file) || '').trim(),
    },
    timeline: { tracks },
  };
}

// ── Dry-run compile via bridge → populate state.lastCompile → re-render ──────

// Front-end validation — catch the common "empty picker" cases with clear
// messages before firing the compile call. Returns an error string, or null.
function _validate() {
  if (!bridgeOnline()) return 'Bridge offline — start `xi gui zone` first.';
  if (!_getCurrentZoneUrl() || _currentZoneId() == null) return 'Load a zone first.';
  const ownerCast = state.cast.find((c) => c.id === state.owner);
  if (!ownerCast || !String(ownerCast.entity || '').trim()) {
    return 'Pick a Trigger NPC at the top before compiling.';
  }
  if (state.lines.some((l) => !String(l.text || '').trim())) {
    return 'One or more dialog lines are empty — fill them in or remove the row.';
  }
  return null;
}

async function compilePreview() {
  const err = _validate();
  if (err) { state.lastCompile = { error: err }; render(); return; }
  try {
    const res = await bridgeCall('zone.compileCutscene', {
      zone: _getCurrentZoneUrl(), zoneId: _currentZoneId(),
      cutscene: buildCutscene(), dryRun: true,
    });
    state.lastCompile = res && res.ok ? res : { error: (res && res.error) || 'compile failed' };
  } catch (e) {
    state.lastCompile = { error: (e && e.message) || String(e) };
  }
  render();
}

async function publish() {
  if (state.publishing) return;
  const err = _validate();
  if (err) { state.lastCompile = { error: err }; render(); return; }
  // Hard gate: a cutscene with a camera can't publish without its Camera DAT placement set.
  if (_hasCameraTrack() && !_camDatComplete()) {
    state.activeTab = 'trigger';   // Settings tab holds the Camera DAT fields
    state.lastCompile = { error: 'Set the Camera DAT (ROM, Path, Dat Filename) in Settings before publishing.' };
    render();
    return;
  }
  state.publishing = true; render();
  try {
    const res = await bridgeCall('zone.compileCutscene', {
      zone: _getCurrentZoneUrl(), zoneId: _currentZoneId(),
      cutscene: buildCutscene(), dryRun: false,
      // Settings > Save / Publish > "Publish Cutscenes to Pivot" (default ON):
      // also patch the pivot overlay pack's F/VTABLEs so the client's overlay
      // tables can resolve the camera-scene file.
      publishPivot: loadSetting('publishCutscenesToPivot', true),
    });
    state.lastCompile = res && res.ok ? res : { error: (res && res.error) || 'publish failed' };
    if (res && res.ok) {
      // Lock the event id in — future Publishes overwrite this same event
      // instead of allocating a new one every time. A brand-new cutscene now
      // becomes "Edit Cutscene: Event N".
      state.publishedEventId = res.eventId;
      state.eventIdOverride = res.eventId;                 // pin it so buildCutscene sends the real id, not 'auto'
      const ownerCast = state.cast.find((c) => c.id === state.owner);
      state.publishedActorId = _canonActorU32(ownerCast && ownerCast.entity);
      if (res.cameraSceneFileId) state.cameraSceneFileId = res.cameraSceneFileId;   // reuse the SAME scene file next publish
      _setAuthorTitle('edit');
      try { invalidateEvents(); } catch {}
    }
  } catch (e) {
    state.lastCompile = { error: (e && e.message) || String(e) };
  } finally {
    state.publishing = false;
    render();
  }
}

// ── HTML-escape ──────────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── Render ───────────────────────────────────────────────────────────────────
function render() {
  const el = bodyEl();
  if (!el) return;

  const tab = state.activeTab || 'trigger';
  const navHtml = CS_TABS.map((t) => `
    <button class="lnav-btn${t.id === tab ? ' active' : ''}" data-tab="${t.id}">
      <span class="material-symbols-outlined lnav-ico">${t.icon}</span><span>${t.label}</span>
    </button>`).join('');

  let content = '';
  if (tab === 'trigger')      content = renderOwner();
  else if (tab === 'npcs')    content = renderCast();
  else if (tab === 'dialog')  content = renderDialog();
  else if (tab === 'presentation') content = renderFlags();
  else if (tab === 'publish') content = renderPublishTab();

  el.innerHTML = `
    <div class="cs-author-layout">
      <nav class="modal-lnav">
        ${navHtml}
        <div class="cs-nav-spacer"></div>
        <button class="lnav-btn lnav-action" id="cs-open-timeline" title="Open the timeline editor (bottom sequencer)">
          <span class="material-symbols-outlined lnav-ico">movie_edit</span><span>Timeline</span>
        </button>
      </nav>
      <div class="cs-tab-content">${content}</div>
    </div>
  `;

  el.querySelectorAll('.lnav-btn[data-tab]').forEach((b) => b.addEventListener('click', () => {
    state.activeTab = b.dataset.tab; render();
  }));
  el.querySelector('#cs-open-timeline')?.addEventListener('click', openTimeline);

  if (tab === 'trigger')      wireOwner(el);
  else if (tab === 'npcs')    wireCast(el);
  else if (tab === 'dialog')  wireDialog(el);
  else if (tab === 'presentation') wireFlags(el);
  else if (tab === 'publish') wirePublishTab(el);
}

function openTimeline() {
  csOpenAuthor(state, {
    title: `Cutscene (editing) · ${_ownerDisplay()}`,
    onChange: (evt) => { if (evt && evt.type === 'publish') publish(); },
    pilot: true,          // start already flying the cutscene camera
  });
}

// ── Publish tab — actions + compile preview ──────────────────────────────────

// Resolve the event id Publish will ACTUALLY write, live from the current state
// (the Trigger-tab override wins over the last-published id). Drives the hero so
// the headline can never go stale the way the old "Publish (updates N)" button did.
function _publishTarget() {
  const id = state.eventIdOverride;
  const last = state.publishedEventId;
  if (id == null) return { id: null, mode: 'auto' };
  if (last != null && id === last) return { id, mode: 'update' };
  return { id, mode: 'new' };
}

// Byte-count formatting for the metric tiles.
function _bytes(n) {
  const v = +n;
  return (n == null || n === '' || !Number.isFinite(v)) ? '—' : v.toLocaleString();
}
// before→after size change, as a signed, coloured chip descriptor.
function _delta(before, after) {
  const b = +before, a = +after;
  if (!Number.isFinite(b) || !Number.isFinite(a)) return null;
  const d = a - b;
  if (d === 0) return { text: 'no change', cls: 'zero' };
  return { text: (d > 0 ? '+' : '−') + Math.abs(d).toLocaleString() + ' B', cls: d > 0 ? 'up' : 'down' };
}

const _CSP_STATUS = {
  busy: { label: 'Publishing…',  ico: 'progress_activity',        col: '#f7c873' },
  err:  { label: 'Compile error', ico: 'error',                   col: '#ff8f8f' },
  ok:   { label: 'Published',    ico: 'check_circle',             col: '#7fd88f' },
  info: { label: 'Compiled',     ico: 'task_alt',                 col: '#82aaff' },
  idle: { label: 'Ready',        ico: 'radio_button_unchecked',   col: '#74b6ef' },
};

// Shared premium section header for the author tabs — accent icon tile + title + sub.
// `sub` is trusted authored HTML (never user data), so it isn't escaped.
function _csaHead(icon, title, sub, ac = '#7fd6e6') {
  return `<div class="csa-head" style="--ac:${ac}">
    <div class="csa-head-ico"><span class="material-symbols-outlined">${icon}</span></div>
    <div class="csa-head-main">
      <div class="csa-head-title">${esc(title)}</div>
      ${sub ? `<div class="csa-head-sub">${sub}</div>` : ''}
    </div>
  </div>`;
}

function renderPublishTab() {
  const tgt = _publishTarget();
  const r = state.lastCompile;

  let sk = 'idle';
  if (state.publishing)                        sk = 'busy';
  else if (r && r.error)                       sk = 'err';
  else if (r && r.written && r.written.length) sk = 'ok';
  else if (r)                                  sk = 'info';
  const st = _CSP_STATUS[sk];

  const owner = _ownerDisplay();
  const ownerCast = state.cast.find((c) => c.id === state.owner);
  const ownerHex = ownerCast && ownerCast.entity ? esc(String(ownerCast.entity)) : '';

  const idBig = tgt.id != null ? `Event ${tgt.id}` : 'New event';
  const modeBadge = { auto: 'Auto id', update: 'Overwrite', new: 'New' }[tgt.mode];

  const note = tgt.mode === 'auto'
    ? `A fresh id is assigned on publish (highest existing + 1). Pin one in the <b>Trigger</b> tab to control it.`
    : tgt.mode === 'update'
      ? `Overwrites <b>Event ${tgt.id}</b> on ${esc(owner)} in place — the pristine DAT is kept as a <code>.base</code> backup.`
      : `Creates <b>Event ${tgt.id}</b> on ${esc(owner)}. Change the number in the <b>Trigger</b> tab.`;

  return `
    <div class="csp">
      <div class="csp-hero" style="--ac:${st.col}">
        <div class="csp-hero-ico"><span class="material-symbols-outlined">rocket_launch</span></div>
        <div class="csp-hero-main">
          <div class="csp-hero-title">${idBig}<span class="csp-mode csp-mode-${tgt.mode}">${modeBadge}</span></div>
          <div class="csp-hero-sub">
            <span class="material-symbols-outlined csp-sub-ico">person</span>${esc(owner)}
            ${ownerHex ? `<span class="csp-hero-hex">${ownerHex}</span>` : ''}
          </div>
        </div>
        <div class="csp-status csp-status-${sk}">
          <span class="material-symbols-outlined">${st.ico}</span><span>${st.label}</span>
        </div>
      </div>

      <div class="csp-actions">
        <button id="cs-preview" class="csp-btn-ghost">
          <span class="material-symbols-outlined">science</span>Preview compile
        </button>
        <button id="cs-debug-copy" class="csp-btn-ghost" title="Copy cutscene debug dump to clipboard for AI / bug reports">
          <span class="material-symbols-outlined">content_copy</span>Copy Debug Data
        </button>
        <button id="cs-publish" class="csp-cta"${state.publishing ? ' disabled' : ''}>
          <span class="material-symbols-outlined">${state.publishing ? 'progress_activity' : 'publish'}</span>
          <span>${state.publishing ? 'Publishing…' : 'Publish'}</span>
          <span class="material-symbols-outlined csp-cta-arrow">arrow_forward</span>
        </button>
      </div>
      <p class="csp-note">${note} Writes the game DAT plus the Ashita pivot overlay, and prints the server Lua stub.</p>

      ${renderPreview()}
    </div>
  `;
}

function wirePublishTab(el) {
  el.querySelector('#cs-preview')?.addEventListener('click', compilePreview);
  el.querySelector('#cs-publish')?.addEventListener('click', publish);
  el.querySelector('#cs-debug-copy')?.addEventListener('click', copyDebugData);
}

// Build a plain-text dump of the open cutscene (cast, flags, tracks, last compile
// disasm/refs/paths) so it can be pasted into an AI / bug report. Prefer the latest
// compile when present; still useful before Preview (state-only).
function buildDebugData() {
  const zid = _currentZoneId();
  const zone = _getCurrentZoneUrl();
  const tgt = _publishTarget();
  const owner = state.cast.find((c) => c.id === state.owner) || null;
  const camPath = _camDatPathPreview();
  const lines = [];
  const push = (s = '') => lines.push(s);
  push('=== xi cutscene debug ===');
  push(`date: ${new Date().toISOString()}`);
  push(`zoneId: ${zid ?? '—'}`);
  push(`zone: ${zone || '—'}`);
  push(`eventId: ${tgt.id != null ? tgt.id : '(auto)'}  mode=${tgt.mode}`);
  push(`publishedEventId: ${state.publishedEventId ?? '—'}`);
  push(`publishedActorId: ${state.publishedActorId != null ? '0x' + (state.publishedActorId >>> 0).toString(16).toUpperCase().padStart(8, '0') : '—'}`);
  push(`owner: ${owner ? `${owner.name || owner.id} ${owner.entity || ''}` : (state.owner || '—')}`);
  push(`totalFrames: ${state.totalFrames}  autoFadeIn=${state.autoFadeIn}  autoFadeOut=${state.autoFadeOut}`);
  push(`flags: eventMode=0x${(state.eventMode >>> 0).toString(16)} lockPlayer=${!!state.lockPlayer} cameraLock=${!!state.cameraLock} cancelSet=${!!state.cancelSet} hideActorsOnEnd=${!!state.hideActorsOnEnd} hideNpcNames=${!!state.hideNpcNames} resetZoomOnEnd=${state.resetZoomOnEnd !== false} talkAnim=${state.talkAnim} idleAnim=${state.idleAnim}`);
  push(`cameraSceneFileId: ${state.cameraSceneFileId ?? '—'}`);
  push(`cameraDat: ${camPath || '(incomplete)'}  raw=${JSON.stringify(state.cameraDat || {})}`);
  push('');
  push('--- cast ---');
  for (const c of state.cast) {
    const custom = (state.customNpcs || []).find((n) => {
      const hex = (n.npcidHex || '').toUpperCase();
      const ent = String(c.entity || '').toUpperCase();
      return hex && ent && hex === ent;
    });
    let extra = '';
    if (custom) {
      // status = registry (what xi wrote); dbStatus = live npc_list row (what the
      // zone actually loaded at boot). Drift between them is a restart-the-server tell.
      const db = (custom.dbStatus == null) ? 'n/a' : custom.dbStatus;
      extra = `  [customNpc model=${custom.modelid} status=${custom.status} dbStatus=${db} fileId=${custom.fileId} dat=${custom.datRel || '?'}]`;
    }
    push(`  ${c.id}: entity=${c.entity || '—'} name=${c.name || ''}${extra}`);
  }
  push('');
  push('--- tracks ---');
  for (const t of state.tracks || []) {
    const kfs = t.keyframes || [];
    push(`  kind=${t.kind} castId=${t.castId || '—'} keyframes=${kfs.length}${t.readOnly ? ' [readOnly]' : ''}`);
    for (const kf of kfs.slice(0, 24)) {
      const bits = Object.entries(kf)
        .filter(([k]) => k !== 'frame')
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      push(`    @${kf.frame ?? 0} ${bits}`);
    }
    if (kfs.length > 24) push(`    … +${kfs.length - 24} more`);
  }
  push('');
  const r = state.lastCompile;
  if (!r) {
    push('--- compile ---');
    push('  (none — run Preview compile first for opcodes / written paths)');
  } else if (r.error) {
    push('--- compile ERROR ---');
    push(`  ${r.error}`);
  } else {
    push('--- compile ---');
    push(`  eventId: ${r.eventId}`);
    push(`  eventDat: ${r.eventDat || '—'}`);
    push(`  dialogDat: ${r.dialogDat || '—'}`);
    push(`  cameraSceneFileId: ${r.cameraSceneFileId ?? state.cameraSceneFileId ?? '—'}`);
    if (r.sizes) {
      push(`  sizes: event ${r.sizes.eventDatBefore}→${r.sizes.eventDatAfter}  dialog ${r.sizes.dialogDatBefore}→${r.sizes.dialogDatAfter}`);
    }
    if (r.warnings && r.warnings.length) {
      push('  warnings:');
      for (const w of r.warnings) push(`    - ${w}`);
    }
    if (r.written && r.written.length) {
      push('  written:');
      for (const p of r.written) push(`    ${p}`);
    }
    push('  opcodes:');
    for (const o of (r.disasm || [])) {
      push(`    +${(o.offset || 0).toString(16).padStart(4, '0')}  ${o.op}  ${o.name}  ${o.args || ''}`);
    }
    if (r.luaStub) {
      push('  luaStub:');
      for (const ln of String(r.luaStub).split(/\r?\n/)) push(`    ${ln}`);
    }
  }
  push('');
  push('--- cutscene json (buildCutscene) ---');
  try {
    push(JSON.stringify(buildCutscene(), null, 2));
  } catch (e) {
    push(`  (buildCutscene failed: ${e && e.message ? e.message : e})`);
  }
  push('=== end ===');
  return lines.join('\n');
}

async function copyDebugData() {
  // Refresh the custom-NPC records first — the cached list can carry a stale status
  // (the dump used to claim status=0 while the DB row was 6). Best-effort: a bridge
  // hiccup just means the dump uses the cached values.
  try {
    const zid = _currentZoneId();
    const r = await bridgeCall('customNpc.list', zid ? { zoneId: zid } : {});
    if (r && r.ok && Array.isArray(r.npcs)) state.customNpcs = r.npcs;
  } catch { /* keep cached list */ }
  const text = buildDebugData();
  const btn = document.getElementById('cs-debug-copy');
  const setLabel = (label, ico) => {
    if (!btn) return;
    btn.innerHTML = `<span class="material-symbols-outlined">${ico}</span>${label}`;
  };
  try {
    await navigator.clipboard.writeText(text);
    setLabel('Copied!', 'check');
    setTimeout(() => setLabel('Copy Debug Data', 'content_copy'), 1600);
  } catch {
    // Fallback when clipboard API is blocked (non-secure context, etc.)
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setLabel('Copied!', 'check');
      setTimeout(() => setLabel('Copy Debug Data', 'content_copy'), 1600);
    } catch (e) {
      setLabel('Copy failed', 'error');
      console.error('copyDebugData', e);
      setTimeout(() => setLabel('Copy Debug Data', 'content_copy'), 2000);
    }
  }
}

// ── Owner picker — the ONE NPC the cutscene attaches to ──────────────────────
//
// In FFXI a cutscene lives on a specific NPC's actor block. When the server does
// player:startEvent(N) against Maat, the client looks up event N on Maat's block.
// So "owner" = "which existing zone NPC do I hang this new cutscene onto?" —
// usually the NPC the player is standing in front of when they trigger it.
//
// The picker below lists every actor in the zone with a real name (from the NPC
// DAT). Picking one auto-fills the cast entry called 'npc' so the user never has
// to type a raw entity id.

function _actorHex(a) {
  // zone.events returns { actorId: <int>, actorIdHex: "0x…" }. Always lowercase-x
  // + uppercase digits so <option value> comparisons round-trip cleanly.
  const raw = a.actorIdHex || ('0x' + ((+a.actorId) >>> 0).toString(16).padStart(8, '0').toUpperCase());
  return '0x' + raw.slice(2).toUpperCase();
}

// Normalize any user-supplied or stored hex id to the same canonical form
// _actorHex produces, so `selected` <option> comparisons never miss.
function _canonHex(v) {
  const s = String(v || '');
  if (!s.toLowerCase().startsWith('0x')) return s;
  return '0x' + s.slice(2).toUpperCase();
}

// "Name · CODE" for a cast member — the 4-hex entity tail disambiguates same-name
// NPCs (e.g. the trigger Maat·3031 vs the staged Maat·3032) so a dropdown never
// conflates two distinct entities that share a display name.
function _castLabel(c) {
  const hex = _canonHex(c.entity || '');
  const tag = hex.toLowerCase().startsWith('0x') ? hex.slice(-4) : '';
  return tag ? `${c.name || c.id} · ${tag}` : (c.name || c.id);
}

function renderOwner() {
  // Named actors first (real NPCs), then unnamed (doors, gates, etc.) at the bottom.
  const named = state.actorsInZone.filter((a) => a.name).slice(0, 400);
  const unnamed = state.actorsInZone.filter((a) => !a.name).slice(0, 200);

  const ownerCast = state.cast.find((c) => c.id === state.owner);
  const currentEntity = ownerCast ? String(ownerCast.entity || '') : '';

  const mkOpt = (a) => {
    const hex = _actorHex(a);
    const evts = a.eventCount ? ` (${a.eventCount} events)` : '';
    const label = a.name ? `${a.name} — ${hex}${evts}` : `${hex}${evts}`;
    return `<option value="${hex}"${hex === _canonHex(currentEntity) ? ' selected' : ''}>${esc(label)}</option>`;
  };

  const namedHtml = named.map(mkOpt).join('');
  const unnamedHtml = unnamed.length
    ? `<optgroup label="Unnamed (doors, gates, invisible)">${unnamed.map(mkOpt).join('')}</optgroup>`
    : '';

  const idValue = state.eventIdOverride != null ? state.eventIdOverride : '';
  const idPlaceholder = state.publishedEventId != null
    ? `auto (last published: ${state.publishedEventId})`
    : 'auto';
  return `
    <div class="cs-section">
      ${_csaHead('ads_click', 'Trigger NPC', 'Who starts this cutscene', '#7fd6e6')}
      <p class="cs-hint">
        Pick the NPC the player interacts with to start the cutscene. The event
        attaches to their actor block; the server runs
        <code>player:startEvent(&lt;id&gt;)</code> against them.
      </p>
      <label class="csa-field-label">Trigger NPC</label>
      <select id="cs-owner-pick" class="cs-full">
        <option value=""${currentEntity ? '' : ' selected'}>— pick a trigger NPC —</option>
        ${namedHtml}
        ${unnamedHtml}
      </select>
      <label class="check" style="margin-top:8px;"
             title="Editor-only view toggle. Keeps the trigger NPC's staged model hidden while you frame the shot, so it doesn't block the camera. It does NOT change the published cutscene — the NPC still appears in-game.">
        <input type="checkbox" id="cs-hide-owner-editor" style="accent-color:#7fd6e6;" ${state.hideOwnerInEditor ? 'checked' : ''}/>
        Hide Trigger NPC in Level Editor
        <span class="cs-inline-note">view only</span>
      </label>
      <label class="csa-field-label">Event id</label>
      <input id="cs-event-id" class="cs-full" type="text" inputmode="numeric" pattern="[0-9]*"
             value="${idValue}" placeholder="${idPlaceholder}">
      <p class="cs-hint-sm">
        Leave blank for auto (max existing + 1). Type a number like <code>25000</code>
        to pin it. If that id already exists on this NPC, Publish will overwrite it.
      </p>
    </div>
    ${renderCameraDat()}
  `;
}

// ── Camera DAT placement ─────────────────────────────────────────────────────
// A cutscene camera writes its own scene DAT (evte + Route + EffectRoutine) and registers
// it in the base-game AND pivot file tables. These fields pick where it lands on disk —
// joined as ROM{rom}/{path}/{file} (e.g. ROM10/490/50.DAT) and REQUIRED before publishing
// any cutscene with a camera (the backend gates on it too).

// Live "ROM10/490/50.DAT" preview from the three fields, or null if incomplete.
function _camDatPathPreview() {
  const cd = state.cameraDat || {};
  const rom  = String(cd.rom  || '').trim().replace(/^rom/i, '');
  const path = String(cd.path || '').trim().replace(/^[\/\\]+|[\/\\]+$/g, '');
  let   file = String(cd.file || '').trim();
  if (!rom || !path || !file) return null;
  if (!/\.dat$/i.test(file)) file += '.DAT';
  return `ROM${rom}/${path}/${file}`.toUpperCase();
}

// Does this cutscene define an editable camera shot? (non-readOnly campos with keyframes —
// mirrors buildCutscene's send-filter, so the gate fires exactly when the backend will
// rebuild + write a camera scene DAT.)
function _hasCameraTrack() {
  return (state.tracks || []).some(
    (t) => t.kind === 'campos' && !t.readOnly && t.keyframes && t.keyframes.length);
}

// All three Camera DAT fields present + numerically valid (rom / subdir / slot).
function _camDatComplete() {
  const cd = state.cameraDat || {};
  const rom  = String(cd.rom  || '').trim().replace(/^rom/i, '');
  const path = String(cd.path || '').trim().replace(/^[\/\\]+|[\/\\]+$/g, '').split(/[\/\\]/).pop();
  const slot = String(cd.file || '').trim().replace(/\.dat$/i, '');
  return /^\d+$/.test(rom) && /^\d+$/.test(path || '') && /^\d+$/.test(slot);
}

function renderCameraDat() {
  const cd = state.cameraDat || {};
  const preview = _camDatPathPreview();
  const needsSet = _hasCameraTrack() && !_camDatComplete();
  return `
    <div class="cs-section" style="margin-top:12px">
      ${_csaHead('videocam', 'Camera DAT', 'Where the camera scene DAT is written', '#c792ea')}
      <p class="cs-hint">
        A cutscene camera writes its own scene DAT and registers it in the base-game
        <b>and</b> pivot file tables. Pick where it lands — joined as
        <code>ROM{rom}/{path}/{file}</code>.
      </p>
      <div class="csa-camdat-grid">
        <div>
          <label class="csa-field-label">ROM</label>
          <input id="cs-camdat-rom" class="cs-full" type="text" inputmode="numeric"
                 value="${esc(cd.rom || '')}" placeholder="10">
        </div>
        <div>
          <label class="csa-field-label">Path</label>
          <input id="cs-camdat-path" class="cs-full" type="text" inputmode="numeric"
                 value="${esc(cd.path || '')}" placeholder="490">
        </div>
        <div>
          <label class="csa-field-label">Dat Filename</label>
          <input id="cs-camdat-file" class="cs-full" type="text"
                 value="${esc(cd.file || '')}" placeholder="50.dat">
        </div>
      </div>
      <div class="csa-camdat-preview${preview ? '' : ' is-empty'}">
        <span class="material-symbols-outlined">folder</span>
        <span class="csa-camdat-path">${preview ? esc(preview) : 'ROM10 / 490 / 50.DAT'}</span>
      </div>
      ${needsSet
        ? `<p class="csa-camdat-warn"><span class="material-symbols-outlined">error</span>Required before publishing — fill in all three fields.</p>`
        : `<p class="cs-hint-sm">Required before publishing a cutscene with a camera.</p>`}
    </div>
  `;
}

function wireCameraDat(el) {
  const upd = (key) => (e) => {
    state.cameraDat = { ...(state.cameraDat || {}), [key]: e.target.value };
    // Live-update the preview + warning in place (a full re-render would drop input focus).
    const box = el.querySelector('.csa-camdat-preview');
    const p = _camDatPathPreview();
    if (box) {
      box.classList.toggle('is-empty', !p);
      const pathEl = box.querySelector('.csa-camdat-path');
      if (pathEl) pathEl.textContent = p || 'ROM10 / 490 / 50.DAT';
    }
  };
  el.querySelector('#cs-camdat-rom')?.addEventListener('input', upd('rom'));
  el.querySelector('#cs-camdat-path')?.addEventListener('input', upd('path'));
  el.querySelector('#cs-camdat-file')?.addEventListener('input', upd('file'));
}

function wireOwner(el) {
  el.querySelector('#cs-event-id')?.addEventListener('input', (e) => {
    const raw = String(e.target.value || '').trim();
    if (!raw) {
      state.eventIdOverride = null;
    } else {
      const n = parseInt(raw, 10);
      state.eventIdOverride = (Number.isFinite(n) && n >= 0 && n <= 65533) ? n : null;
    }
  });
  el.querySelector('#cs-owner-pick')?.addEventListener('change', (e) => {
    const hex = e.target.value;
    if (!hex) return;
    // Find the zone actor + take its name.
    const a = state.actorsInZone.find((x) => _actorHex(x) === _canonHex(hex));
    const name = a?.name || 'NPC';

    // Ensure there is a cast entry called 'npc' bound to this actor; make it owner.
    let npcCast = state.cast.find((c) => c.id === 'npc');
    if (!npcCast) {
      npcCast = { id: 'npc', entity: '', name: '' };
      state.cast.push(npcCast);
    }
    npcCast.entity = hex;
    npcCast.name = name;
    state.owner = 'npc';
    render();
    _reloadStageNpcs();                 // show the newly-picked NPC at its default position
    // Refresh the animation dropdowns for the new owner NPC (re-renders on arrival).
    fetchNpcAnims();
  });
  el.querySelector('#cs-hide-owner-editor')?.addEventListener('change', (e) => {
    state.hideOwnerInEditor = !!e.target.checked;
    saveProjectSetting(HIDE_TRIGGER_NPC_KEY, state.hideOwnerInEditor);   // persist to the workspace
    // Pure viewport toggle — no rebuild/refetch, just flip the staged trigger's visibility.
    csRefreshActorVisibility();
  });
  wireCameraDat(el);
}

// ── Cast editor — ADDITIONAL NPCs only (player + trigger are handled elsewhere) ──
//
// The "player" cast entry is invisible (auto-added at build).
// The TRIGGER / owner NPC is set in the Trigger tab only — it lives in
// state.cast under state.owner but is NOT listed here (listing it twice caused
// double-Maat in the viewport when the same entity was also added as an extra).

/** Drop cast extras that duplicate the trigger — by ENTITY only. Same-name NPCs
 *  with a different id (retail keeps several cutscene copies: Maat is 3031-3034)
 *  are legitimate cast members and MUST survive; the old same-name prune silently
 *  ate every Maat the user tried to add. */
function _pruneDuplicateCast() {
  const owner = state.cast.find((c) => c.id === state.owner);
  if (!owner) return;
  const ownerHex = _canonHex(owner.entity);
  const before = state.cast.length;
  state.cast = state.cast.filter((c) => {
    if (c.id === state.owner || c.id === 'player' || c.entity === 'player') return true;
    const hex = _canonHex(c.entity);
    if (ownerHex && hex && hex === ownerHex) {
      // Exact same entity as the trigger — a true duplicate. Same-NAME different-id
      // (Maat 3031 vs 3032) is legitimate and always survives.
      console.warn(`[cutscene] dropped cast row ${c.id}: same entity as trigger (${hex})`);
      return false;
    }
    return true;
  });
  if (state.cast.length !== before) {
    const keep = new Set(state.cast.map((c) => c.id));
    state.tracks = (state.tracks || []).filter((t) => !t.castId || keep.has(t.castId) || t.castId === 'player');
  }
}

function renderCast() {
  _pruneDuplicateCast();
  const namedZone = state.actorsInZone.filter((a) => a.name);
  const owner = state.cast.find((c) => c.id === state.owner);
  const ownerHex = owner ? _canonHex(owner.entity) : '';
  // Extra cast only: never player, never the trigger row, never a second entry
  // that points at the same entity as the trigger (dedupe by entity hex).
  const extras = state.cast.filter((c) => {
    if (c.entity === 'player' || c.id === 'player') return false;
    if (c.id === state.owner) return false;
    if (ownerHex && _canonHex(c.entity) && _canonHex(c.entity) === ownerHex) return false;
    return true;
  });

  const npcRow = (c) => {
    const realIdx = state.cast.indexOf(c);
    const cur = _canonHex(c.entity);
    // Custom NPCs registered for this zone → their own group at the TOP of the picker,
    // so they add exactly like any game NPC. The option value is the entity id, which the
    // compiler resolves and the on-stage preview renders (from the registry look).
    const customList = state.customNpcs || [];
    const customHex = (n) => _canonHex(
      n.npcidHex || ('0x' + ((n.npcid >>> 0).toString(16).padStart(8, '0').toUpperCase())));
    const customHexes = new Set(customList.map(customHex).filter(Boolean));
    const customOpts = customList.length
      ? '<optgroup label="Custom NPCs">' + customList.map((n) => {
          const hex = customHex(n);
          return `<option value="${hex}"${hex === cur ? ' selected' : ''}>${esc(n.name)} · model ${esc(n.modelid)}</option>`;
        }).join('') + '</optgroup>'
      : '';
    // Disambiguate same-name NPCs (two Maats) with the last 4 hex digits.
    // Drop zone actors whose id is already claimed by a custom NPC — duplicate
    // <option value>s make the select snap to the retail NPC after re-render.
    // Also drop the TRIGGER's exact id: it's set in the Trigger tab and staging it
    // again here double-spawns the owner (cast a DIFFERENT id, e.g. Maat·3032).
    const entOpts = namedZone
      .filter((a) => !customHexes.has(_actorHex(a)))
      .filter((a) => !ownerHex || _actorHex(a) !== ownerHex || _actorHex(a) === cur)
      .map((a) => {
        const hex = _actorHex(a);
        const tag = hex.slice(-4);
        const label = `${a.name} · ${tag}`;
        return `<option value="${hex}"${hex === cur ? ' selected' : ''}>${esc(label)}</option>`;
      }).join('');
    const gameOpts = entOpts ? ('<optgroup label="Zone NPCs">' + entOpts + '</optgroup>') : '';
    return `
    <div class="cs-npc-row" data-idx="${realIdx}">
      <span class="cs-npc-badge dim">NPC</span>
      <select class="cs-cast-entity" data-idx="${realIdx}"><option value="">— pick NPC —</option>${customOpts}${gameOpts}</select>
      <select class="cs-cast-idle" data-idx="${realIdx}" title="Default idle animation — the always-on rest pose this NPC plays between actions/lines (a resting clip, not a scheduled action)">${animOptionsHtml(c.entity, c.idleAnim, { kind: 'idle' })}</select>
      <button class="cs-cast-del cs-mini" data-idx="${realIdx}" title="Remove NPC">×</button>
    </div>`;
  };

  const rows = extras.map(npcRow).join('');
  const ownerHint = (owner && owner.entity)
    ? `<p class="cs-hint">Trigger is <b>${esc(owner.name || owner.id)}</b> (set in the Trigger tab). If you give it no keyframes it is <b>hidden for the whole scene</b> — to put the character ON stage, add one of its cutscene copies below (retail keeps several, e.g. Maat · 3032) and keyframe that instead.</p>`
    : `<p class="cs-hint">Pick the trigger NPC in the <b>Trigger</b> tab first, then add any other NPCs here.</p>`;
  return `
    <div class="cs-section">
      ${_csaHead('groups', 'NPCs', 'Other NPCs in the scene (not the trigger)', '#c792ea')}
      <p class="cs-hint">Each NPC's <b>default idle</b> is what they play at rest / between their lines.</p>
      ${ownerHint}
      <div class="cs-npc-head"><span></span><span>NPC</span><span>Default idle</span><span></span></div>
      <div id="cs-cast-rows" class="cs-table">${rows || '<div class="cs-hint" style="padding:8px 0">No extra NPCs yet.</div>'}</div>
      <button id="cs-cast-add" class="csa-add"><span class="material-symbols-outlined">add</span>Add NPC</button>
    </div>
  `;
}

function _ownerDisplay() {
  const ownerCast = state.cast.find((c) => c.id === state.owner);
  if (!ownerCast) return 'none picked yet';
  return ownerCast.name || ownerCast.id;
}

// Small styled confirm modal (replaces the native browser confirm() for destructive cutscene
// actions). Returns Promise<boolean>. Escape / click-outside / Cancel → false; Enter / OK → true.
// Appended to document.body so it isn't trapped by the sequencer's backdrop-filter ancestor.
function _csConfirm(messageHtml, { confirmLabel = 'Remove', cancelLabel = 'Cancel', danger = true } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'cs-confirm-overlay';
    overlay.innerHTML =
      `<div class="cs-confirm-card" role="dialog" aria-modal="true">
         <div class="cs-confirm-msg">${messageHtml}</div>
         <div class="cs-confirm-actions">
           <button class="cs-confirm-btn cs-confirm-cancel">${esc(cancelLabel)}</button>
           <button class="cs-confirm-btn cs-confirm-ok${danger ? ' danger' : ''}">${esc(confirmLabel)}</button>
         </div>
       </div>`;
    const close = (val) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(false); } else if (e.key === 'Enter') { e.preventDefault(); close(true); } };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
    overlay.querySelector('.cs-confirm-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.cs-confirm-ok').addEventListener('click', () => close(true));
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('.cs-confirm-ok').focus();
  });
}

function wireCast(el) {
  // Change an NPC's entity → refresh its idle list (fetch that NPC's animations).
  el.querySelectorAll('.cs-cast-entity').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const i = +e.target.dataset.idx;
      state.cast[i].entity = e.target.value;
      // Rename the cast member (and thus its timeline track label) to the newly-picked NPC.
      const hex = _canonHex(e.target.value);
      const za = state.actorsInZone.find((a) => _actorHex(a) === hex);
      const cn = (state.customNpcs || []).find((n) =>
        _canonHex(n.npcidHex || ('0x' + ((n.npcid >>> 0).toString(16).padStart(8, '0').toUpperCase()))) === hex);
      const optName = e.target.selectedOptions[0]?.textContent?.trim();
      // Custom registry wins over a colliding zone actor (same id → wrong name otherwise).
      if (cn?.name) state.cast[i].name = cn.name;
      else if (za?.name) state.cast[i].name = za.name;
      else if (optName) state.cast[i].name = optName;
      delete state.cast[i].idleAnim;                 // reset — the new NPC has its own idles
      fetchNpcAnimsFor(e.target.value);               // _animListArrived re-renders when it lands
      _rebuildAnimTagClips();                         // cached entity → no arrival event fires
      render(); try { csAuthorRefresh(); } catch {}   // refresh the timeline so its track label updates
      _reloadStageNpcs();
    });
  });
  // Per-NPC default-idle selection → swap the staged NPC's base idle LIVE (no respawn).
  el.querySelectorAll('.cs-cast-idle').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const c = state.cast[+e.target.dataset.idx];
      if (!c) return;
      c.idleAnim = e.target.value;
      try { csSetActorIdle(c.entity, e.target.value); } catch {}
    });
  });
  el.querySelectorAll('.cs-cast-del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const removed = state.cast[+e.target.dataset.idx];
      if (!removed) return;
      const n = (state.tracks || []).filter((t) => t.castId === removed.id).length;
      const ok = await _csConfirm(
        `Remove <b>${esc(removed.name || removed.id)}</b>${n ? ` and its ${n} track${n === 1 ? '' : 's'}` : ''}?`,
        { confirmLabel: 'Remove' });
      if (!ok) return;
      // Remove the NPC + its tracks (actor group + Face/Dialog/Position/Anim sub-tracks, keyed by
      // castId) + the dialogue lines only it spoke, so nothing lingers orphaned under a stale id.
      const idx = state.cast.indexOf(removed);
      if (idx >= 0) state.cast.splice(idx, 1);
      state.tracks = (state.tracks || []).filter((t) => t.castId !== removed.id);
      state.lines = (state.lines || []).filter((l) => l.speaker !== removed.id);
      render(); try { csAuthorRefresh(); } catch {}    // drop the row + its timeline tracks
      _reloadStageNpcs();
    });
  });
  el.querySelector('#cs-cast-add')?.addEventListener('click', () => {
    let n = 2;
    while (state.cast.some((c) => c.id === `npc${n}`)) n += 1;
    state.cast.push({ id: `npc${n}`, entity: '', name: '' }); render();
  });
  // Prefetch each NPC's animations so the idle dropdowns fill in (cached → no loop;
  // _animListArrived re-renders on each arrival).
  for (const c of state.cast) {
    if (c.entity && c.entity !== 'player') fetchNpcAnimsFor(c.entity);
  }
}

// ── Dialog editor ────────────────────────────────────────────────────────────
//
// One row per line: [speaker dropdown] [text input] [× delete]. The line's
// stable id (line1/line2/…) is auto-generated and never shown — the user just
// writes lines and references them by picking from the step's line dropdown.
// FFXI DOES show the speaker's name in the dialog box, so every line needs one.

function renderDialog() {
  // Speaker options: every cast member EXCEPT the trigger NPC (it's not on stage / not a
  // speaker), labelled "Name · CODE" so same-name NPCs (two Maats) are distinguishable and
  // a line binds to ONE specific entity, not a name. The current speaker is always kept
  // selectable even if it's the owner (legacy lines) so nothing silently re-points.
  const speakerOpts = (selected) => state.cast
    .filter((c) => c.id !== 'player' && c.entity !== 'player' && (c.id !== state.owner || c.id === selected))
    .map((c) => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(_castLabel(c))}</option>`)
    .join('');
  // Default speaker for a line with none set → first non-owner cast member (the placed NPC),
  // never the trigger.
  const defaultSpeaker = (state.cast.find((c) => c.id !== 'player' && c.entity !== 'player' && c.id !== state.owner)
    || {}).id || state.owner;

  const n = state.lines.length;
  const rows = state.lines.map((l, i) => `
    <div class="cs-dlg-row" data-idx="${i}">
      <span class="cs-rownum">${i + 1}</span>
      <select class="cs-dlg-speaker">${speakerOpts(l.speaker || defaultSpeaker)}</select>
      <input class="cs-dlg-text" value="${esc(l.text)}" placeholder="Line text (Shift-JIS)" />
      <span class="cs-dlg-actions">
        <button class="cs-dlg-up cs-mini" title="Move line up"${i === 0 ? ' disabled' : ''}>↑</button>
        <button class="cs-dlg-down cs-mini" title="Move line down"${i === n - 1 ? ' disabled' : ''}>↓</button>
        <button class="cs-dlg-del cs-mini" title="Remove line">×</button>
      </span>
    </div>
  `).join('');
  return `
    <div class="cs-section">
      ${_csaHead('forum', 'Dialog lines', 'Who says what', '#7fd88f')}
      <div class="cs-dlg-head"><span>#</span><span>Speaker</span><span>Line text</span><span></span></div>
      <div id="cs-dlg-rows" class="cs-table">${rows}</div>
      <button id="cs-dlg-add" class="csa-add"><span class="material-symbols-outlined">add</span>Add line</button>
      <div class="cs-escapes">
        <span class="cs-escapes-title">Escape codes</span>
        <div class="cs-escapes-grid">
          <code>\\n</code><span>new line</span>
          <code>\\v</code><span>▼ page break — waits for the player to press Enter</span>
          <code>{player}</code><span>the player's character name</span>
          <code>{auto:N}</code><span>auto-advance after N seconds (no Enter needed)</span>
        </div>
        <span class="cs-escapes-foot">Reference these lines from Dialog keyframes on the timeline.</span>
      </div>
    </div>
  `;
}

function wireDialog(el) {
  el.querySelectorAll('.cs-dlg-row').forEach((row) => {
    const i = +row.dataset.idx;
    row.querySelector('.cs-dlg-speaker').addEventListener('change', (e) => {
      state.lines[i].speaker = e.target.value;
      try { csAuthorRefresh(); } catch {}
    });
    row.querySelector('.cs-dlg-text').addEventListener('input', (e) => {
      state.lines[i].text = e.target.value;
      try { csAuthorRefresh(); } catch {}
    });
    row.querySelector('.cs-dlg-del').addEventListener('click', () => {
      state.lines.splice(i, 1); render();
      try { csAuthorRefresh(); } catch {}
    });
    const moveLine = (to) => {
      if (to < 0 || to >= state.lines.length) return;
      const [item] = state.lines.splice(i, 1); state.lines.splice(to, 0, item); render();
      try { csAuthorRefresh(); } catch {}
    };
    row.querySelector('.cs-dlg-up')?.addEventListener('click', () => moveLine(i - 1));
    row.querySelector('.cs-dlg-down')?.addEventListener('click', () => moveLine(i + 1));
  });
  el.querySelector('#cs-dlg-add')?.addEventListener('click', () => {
    state.lines.push({ id: nextLineId(), speaker: state.owner, text: '' }); render();
    try { csAuthorRefresh(); } catch {}
  });
}

// ── Steps editor ─────────────────────────────────────────────────────────────
//
// Each step is a small row: [op picker] [args grid] [× delete]. Args live in
// their own nested CSS grid so labels line up regardless of op — same look for
// face / say / show / music / etc.

function renderSteps(stepOpsHtml) {
  const rows = state.steps.map((s, i) => `
    <div class="cs-srow" data-idx="${i}" style="display:grid; grid-template-columns: 110px minmax(0, 1fr) 32px; gap:6px; align-items:center; padding:4px 0; border-top:1px solid #2a2d38;">
      <select class="cs-step-op" style="min-width:0;">${stepOpsHtml.replace(`value="${s.op}"`, `value="${s.op}" selected`)}</select>
      <div class="cs-step-args" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; min-width:0;">${renderStepArgs(s)}</div>
      <button class="cs-step-del" title="Remove">×</button>
    </div>
  `).join('');
  return `
    <div class="cs-section">
      <h3 style="margin:0 0 4px">Steps <span style="font-size:11px; opacity:.7;">(what happens in order)</span></h3>
      <div id="cs-step-rows" style="display:flex; flex-direction:column;">${rows}</div>
      <button id="cs-step-add" style="margin-top:6px;">+ Add step</button>
    </div>
  `;
}

// One reusable style set so every arg control looks the same.
const _lbl = 'font-size:11px; opacity:.75;';
const _sel = 'min-width:0;';
const _num = 'width:60px; min-width:0;';

function renderStepArgs(s) {
  const castOpts = state.cast.map((c) => `<option value="${esc(c.id)}"${c.id === (s.actor || s.speaker) ? ' selected' : ''}>${esc(c.name || c.id)}</option>`).join('');
  const targetOpts = state.cast.map((c) => `<option value="${esc(c.id)}"${c.id === s.target ? ' selected' : ''}>${esc(c.name || c.id)}</option>`).join('');
  const lineOpts = state.lines.map((l) => {
    // Show speaker + preview so the user can identify the line without needing to see its id.
    const spk = state.cast.find((c) => c.id === l.speaker);
    const label = `${spk ? (spk.name || spk.id) : '?'}: ${(l.text || '(empty)').slice(0, 40)}`;
    return `<option value="${esc(l.id)}"${l.id === s.line ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');

  switch (s.op) {
    case 'say': return `
      <span style="${_lbl}">line</span>
      <select class="cs-arg" data-k="line" style="${_sel} flex:1 1 auto;">${lineOpts}</select>`;

    case 'face': return `
      <select class="cs-arg" data-k="actor" style="${_sel}">${castOpts}</select>
      <span style="${_lbl}">→</span>
      <select class="cs-arg" data-k="target" style="${_sel}">${targetOpts}</select>
      <label class="check"><input type="checkbox" class="cs-arg cs-arg-cb" data-k="talk" ${s.talk ? 'checked' : ''}/> mouth-move</label>`;

    case 'show':
    case 'hide':
    case 'place':
      return `
        <span style="${_lbl}">actor</span>
        <select class="cs-arg" data-k="actor" style="${_sel} flex:1 1 auto;">${castOpts}</select>`;

    case 'music': return `
      <span style="${_lbl}">slot</span>
      <input class="cs-arg cs-arg-int" data-k="track" type="number" min="0" max="1" value="${s.track || 0}" style="${_num}"/>
      <span style="${_lbl}">song</span>
      <input class="cs-arg cs-arg-int" data-k="song" type="number" value="${s.song || 0}" style="${_num}"/>`;

    case 'music_volume': return `
      <span style="${_lbl}">volume</span>
      <input class="cs-arg cs-arg-int" data-k="volume" type="number" min="0" max="127" value="${s.volume || 0}" style="${_num}"/>
      <span style="${_lbl}">ease</span>
      <input class="cs-arg cs-arg-int" data-k="frames" type="number" value="${s.frames || 0}" style="${_num}"/>
      <span style="${_lbl}">frames</span>`;

    case 'wait': return `
      <span style="${_lbl}">wait</span>
      <input class="cs-arg cs-arg-int" data-k="frames" type="number" min="1" value="${s.frames || 30}" style="${_num}"/>
      <span style="${_lbl}">frames (30 = 1 sec)</span>`;

    case 'end':
      return `<em style="${_lbl}">scene ends here (auto-appended if omitted)</em>`;

    default:
      return `<em style="${_lbl} color:#f7c873;">stubbed — will fail compile until backend catches up</em>`;
  }
}

function wireSteps(el) {
  el.querySelectorAll('.cs-srow').forEach((row) => {
    const i = +row.dataset.idx;
    row.querySelector('.cs-step-op').addEventListener('change', (e) => {
      state.steps[i] = defaultStep(e.target.value);
      render();
    });
    row.querySelectorAll('.cs-arg').forEach((input) => {
      input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', (e) => {
        const k = e.target.dataset.k;
        const v = e.target.type === 'checkbox' ? e.target.checked
                : e.target.classList.contains('cs-arg-int') ? +e.target.value
                : e.target.value;
        state.steps[i][k] = v;
      });
    });
    row.querySelector('.cs-step-del').addEventListener('click', () => {
      state.steps.splice(i, 1); render();
    });
  });
  el.querySelector('#cs-step-add')?.addEventListener('click', () => {
    state.steps.push(defaultStep('say'));
    render();
  });
}

// ── Flags — 0x38 CliEventModeLocal bit toggles ───────────────────────────────
//
// Bits 0/1/2/4 pinned from xiclient decompile (ActorTelemetry.cpp / GameManager.cpp).
// Bits 3/7 appear in ~15% / 3% of retail events with unknown-to-us meaning; hidden
// under Advanced so users don't blindly toggle them. XiEvents doc doesn't name
// them either — Ailevia's 0x2003 example there conflicts with the pseudocode, so
// treat those bits as "leave alone unless you're reverse-engineering."

function renderFlags() {
  // The 0x38 handler applies HIBYTE(stored)|0x20 — only the HIGH byte of this value
  // reaches the client (xiclient ActorTelemetry: uninvolved-actor hide gates on the
  // applied bits). Cast NPCs are exempt: their involvement blocks mark them event-
  // involved, so these only affect everyone ELSE in the zone.
  const known = [
    { m: 0x1000, l: 'Hide all other NPCs during the scene', n: 'applied 0x10' },
    { m: 0x0200, l: 'Hide other players during the scene', n: 'applied 0x02' },
    { m: 0x0400, l: 'Camera tracks the talking NPC', n: 'applied 0x04' },
  ];
  const advanced = [
    { m: 0x0100, l: 'Applied bit 0x01 (unnamed)', n: 'applied 0x01' },
    { m: 0x0800, l: 'Applied bit 0x08 (unnamed)', n: 'applied 0x08' },
  ];
  const chk = (b) =>
    `<label class="check"><input type="checkbox" class="cs-mode-bit" data-mask="${b.m}" ${state.eventMode & b.m ? 'checked' : ''}/> ${b.l} <span class="cs-inline-note">${b.n || ('0x' + b.m.toString(16).padStart(4, '0'))}</span></label>`;
  return `
    <div class="cs-section">
      ${_csaHead('visibility', 'Presentation flags', 'What the client hides/shows', '#82aaff')}
      <div class="cs-mode-list">${known.map(chk).join('')}</div>
      <div class="cs-mode-list" style="margin-top:6px;">
        <label class="check" title="Hides every cast NPC (except the trigger NPC) under the final fade-to-black, so nothing is left standing when the scene ends — no Hide keyframes needed.">
          <input type="checkbox" id="cs-hide-actors-end" style="accent-color:#82aaff;" ${state.hideActorsOnEnd ? 'checked' : ''}/>
          Auto-hide all actors after the cutscene
          <span class="cs-inline-note">end fade</span>
        </label>
        <label class="check" title="Removes the floating name + health bar over every staged cast NPC. The trigger NPC is skipped on purpose — it's hidden for the whole scene, and its name is a WORLD property (hiding it would blank the real NPC's nameplate in the zone). Stage a separate copy (e.g. Maat·3032) for a visible-but-nameless character. Server-side on Publish; needs a map-server restart. Untick + republish to restore.">
          <input type="checkbox" id="cs-hide-npc-names" style="accent-color:#82aaff;" ${state.hideNpcNames ? 'checked' : ''}/>
          Hide cast NPC names
          <span class="cs-inline-note">server restart</span>
        </label>
        <label class="check" title="Camera shots change the client's GLOBAL zoom (projection focal length) and the game never resets it when the event ends — without this the player keeps the last shot's zoom after the cutscene. Fires a zoom-reset still (client default, focal 350) under the final fade-to-black. Untick only if you deliberately want the zoom to persist.">
          <input type="checkbox" id="cs-reset-zoom-end" style="accent-color:#82aaff;" ${state.resetZoomOnEnd !== false ? 'checked' : ''}/>
          Reset camera zoom after the cutscene
          <span class="cs-inline-note">end fade</span>
        </label>
      </div>
      <details>
        <summary>Advanced — unpinned bits</summary>
        <div class="cs-mode-list">${advanced.map(chk).join('')}</div>
      </details>
      <p class="cs-hint-sm">
        raw value = 0x${state.eventMode.toString(16).padStart(4, '0')}
        — full bit table in <code>docs/events/event_mode_bits.md</code>.
        The client applies HIBYTE|0x20; the low byte is stored but ignored. Cutscene cast
        members are never hidden by these — they're flagged event-involved.
      </p>
    </div>
  `;
}

function wireFlags(el) {
  el.querySelectorAll('.cs-mode-bit').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const m = +e.target.dataset.mask;
      state.eventMode = e.target.checked ? (state.eventMode | m) : (state.eventMode & ~m);
      render();
    });
  });
  el.querySelector('#cs-hide-actors-end')?.addEventListener('change', (e) => {
    state.hideActorsOnEnd = !!e.target.checked;
  });
  el.querySelector('#cs-hide-npc-names')?.addEventListener('change', (e) => {
    state.hideNpcNames = !!e.target.checked;
  });
  el.querySelector('#cs-reset-zoom-end')?.addEventListener('change', (e) => {
    state.resetZoomOnEnd = !!e.target.checked;
  });
}

// ── Timeline editor ──────────────────────────────────────────────────────────
//
// Left rail = track headers (kind + castId). Right = keyframe canvas. Click a
// keyframe → detail panel appears below. Click empty canvas → adds a keyframe
// at that frame. Add-track button opens a picker for available kinds.

const TIMELINE_HEIGHT = 260;    // px — total scrollable timeline area
const TRACK_HEIGHT    = 32;     // px per row
const RAIL_WIDTH      = 130;    // px

function renderTimelineHeader() {
  return `
    <div class="cs-tl-hdr" style="display:flex; gap:12px; align-items:center; padding:6px 8px; background:#1c1e26; border-radius:4px;">
      <label style="font-size:11px; opacity:.8;">Length
        <input id="cs-tl-total" type="number" min="30" value="${state.totalFrames}" style="width:70px; margin-left:4px;">
        <span style="opacity:.5; font-size:11px;">frames (${(state.totalFrames / 30).toFixed(1)}s)</span>
      </label>
      <label style="font-size:11px; opacity:.8;">Fade in
        <input id="cs-tl-fin" type="number" min="0" value="${state.autoFadeIn}" style="width:50px; margin-left:4px;">
      </label>
      <label style="font-size:11px; opacity:.8;">Fade out
        <input id="cs-tl-fout" type="number" min="0" value="${state.autoFadeOut}" style="width:50px; margin-left:4px;">
      </label>
      <div style="flex:1"></div>
      <select id="cs-tl-add-track">
        <option value="">+ Add track…</option>
        ${Object.entries(TRACK_KINDS).map(([k, m]) => `<option value="${k}"${m.stub ? ' data-stub="1"' : ''}>${esc(m.label)}${m.stub ? ' (stub)' : ''}</option>`).join('')}
      </select>
    </div>
  `;
}

function renderTimeline() {
  const total = Math.max(30, state.totalFrames);
  const tickCount = 10;
  const rulerTicks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const f = Math.round((i / tickCount) * total);
    const pct = (i / tickCount) * 100;
    return `<div style="position:absolute; left:${pct}%; top:0; height:100%; border-left:1px solid #2a2d38; opacity:.5; font-size:10px; color:#888; padding-left:2px;">${f}</div>`;
  }).join('');

  const trackRows = state.tracks.map((t, ti) => renderTrackRow(t, ti, total)).join('');
  const emptyMsg = state.tracks.length === 0
    ? `<div style="padding:16px; text-align:center; opacity:.5;">No tracks — add one from the "+ Add track" menu above.</div>`
    : '';

  return `
    <div class="cs-tl-body" style="background:#141620; border:1px solid #2a2d38; border-radius:4px; overflow:hidden; height:${TIMELINE_HEIGHT}px; display:flex; flex-direction:column;">
      <div class="cs-tl-ruler" style="display:flex; height:20px; border-bottom:1px solid #2a2d38; position:relative; background:#1c1e26;">
        <div style="width:${RAIL_WIDTH}px; flex-shrink:0; padding:3px 8px; font-size:10px; opacity:.6; border-right:1px solid #2a2d38;">Track</div>
        <div style="flex:1; position:relative;">${rulerTicks}</div>
      </div>
      <div class="cs-tl-tracks" style="flex:1; overflow-y:auto;">
        ${trackRows}
        ${emptyMsg}
      </div>
    </div>
  `;
}

function renderTrackRow(track, ti, total) {
  const meta = TRACK_KINDS[track.kind] || { label: track.kind, color: '#888' };
  const label = track.castId
    ? `${meta.label} · ${esc(state.cast.find((c) => c.id === track.castId)?.name || track.castId)}`
    : meta.label;

  const kfMarkers = track.keyframes.map((kf, ki) => {
    const pct = Math.min(100, (kf.frame / total) * 100);
    const isSel = state.selected && state.selected.trackIdx === ti && state.selected.kfIdx === ki;
    return `<button class="cs-kf" data-t="${ti}" data-k="${ki}"
      style="position:absolute; left:${pct}%; top:50%; transform:translate(-50%, -50%) rotate(45deg);
             width:10px; height:10px; background:${meta.color}; border:${isSel ? '2px solid #fff' : '1px solid #000'};
             padding:0; cursor:pointer;"
      title="frame ${kf.frame}"></button>`;
  }).join('');

  return `
    <div class="cs-tl-row" data-t="${ti}" style="display:flex; height:${TRACK_HEIGHT}px; border-bottom:1px solid #202230;">
      <div class="cs-tl-rail" style="width:${RAIL_WIDTH}px; flex-shrink:0; padding:6px 8px; display:flex; align-items:center; justify-content:space-between; gap:4px; background:#1a1c26; border-right:1px solid #2a2d38; overflow:hidden;">
        <span style="font-size:11px; color:${meta.color}; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;" title="${esc(label)}">${esc(label)}</span>
        <button class="cs-tl-del-track" data-t="${ti}" title="Remove track" style="width:18px; height:18px; padding:0; font-size:11px; line-height:1; flex-shrink:0;">×</button>
      </div>
      <div class="cs-tl-lane" data-t="${ti}" style="flex:1; position:relative; cursor:crosshair;">${kfMarkers}</div>
    </div>
  `;
}

function renderKeyframeDetail() {
  if (!state.selected) {
    return `<div style="padding:8px; opacity:.5; font-size:11px; text-align:center;">
      Click a keyframe to edit its details, or click an empty track lane to add one.
    </div>`;
  }
  const { trackIdx, kfIdx } = state.selected;
  const track = state.tracks[trackIdx];
  const kf = track?.keyframes[kfIdx];
  if (!track || !kf) { state.selected = null; return renderKeyframeDetail(); }
  const meta = TRACK_KINDS[track.kind] || {};

  return `
    <div class="cs-kf-detail" style="background:#1c1e26; padding:10px; border-radius:4px; display:flex; flex-direction:column; gap:8px;">
      <div style="display:flex; gap:12px; align-items:center;">
        <span style="font-weight:600; color:${meta.color || '#888'};">${esc(meta.label || track.kind)}${track.castId ? ' · ' + esc(state.cast.find((c) => c.id === track.castId)?.name || track.castId) : ''}</span>
        <label style="font-size:11px; opacity:.8;">Frame
          <input id="cs-kf-frame" type="number" min="0" max="${state.totalFrames}" value="${kf.frame}" style="width:70px; margin-left:4px;">
        </label>
        <div style="flex:1"></div>
        <button id="cs-kf-delete" title="Delete keyframe">Delete</button>
      </div>
      <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
        ${renderKfFields(track, kf)}
      </div>
    </div>
  `;
}

function renderKfFields(track, kf) {
  switch (track.kind) {
    case 'dialog': {
      const opts = state.lines.map((l) => {
        const speaker = state.cast.find((c) => c.id === l.speaker);
        const label = `${speaker ? (speaker.name || speaker.id) : '?'}: ${(l.text || '(empty)').slice(0, 40)}`;
        return `<option value="${esc(l.id)}"${l.id === kf.line ? ' selected' : ''}>${esc(label)}</option>`;
      }).join('');
      return `<label style="font-size:11px;">Line
        <select class="cs-kf-field" data-k="line" style="margin-left:4px;">${opts}</select>
      </label>`;
    }
    case 'face': {
      const opts = state.cast.map((c) =>
        `<option value="${esc(c.id)}"${c.id === (kf.target || 'player') ? ' selected' : ''}>${esc(c.name || c.id)}</option>`).join('');
      return `<label style="font-size:11px;">Target
        <select class="cs-kf-field" data-k="target" style="margin-left:4px;">${opts}</select>
      </label>
      <label class="check"><input type="checkbox" class="cs-kf-field cs-kf-cb" data-k="talk" ${kf.talk !== false ? 'checked' : ''}> mouth-move</label>`;
    }
    case 'npc':
      return `<label style="font-size:11px;">Action
        <select class="cs-kf-field" data-k="action" style="margin-left:4px;">
          <option value="show" ${(kf.action || 'show') === 'show' ? 'selected' : ''}>show</option>
          <option value="hide" ${kf.action === 'hide' ? 'selected' : ''}>hide</option>
          <option value="place" ${kf.action === 'place' ? 'selected' : ''}>place</option>
        </select>
      </label>`;
    case 'music':
      return `<label style="font-size:11px;">Song
        <input class="cs-kf-field cs-kf-int" data-k="song" type="number" min="0" value="${kf.song || 0}" style="width:70px; margin-left:4px;">
      </label>
      <label style="font-size:11px;">Slot
        <input class="cs-kf-field cs-kf-int" data-k="slot" type="number" min="0" max="1" value="${kf.slot || 0}" style="width:40px; margin-left:4px;">
      </label>`;
    case 'fade':
      return `<label style="font-size:11px;">Direction
        <select class="cs-kf-field" data-k="kind" style="margin-left:4px;">
          <option value="in" ${(kf.kind || 'in') === 'in' ? 'selected' : ''}>fade in</option>
          <option value="out" ${kf.kind === 'out' ? 'selected' : ''}>fade out</option>
        </select>
      </label>
      <em style="font-size:11px; color:#f7c873;">stub — needs scene-DAT writer</em>`;
    default:
      return `<em style="font-size:11px; opacity:.6;">Kind '${esc(track.kind)}' — no editable fields yet.</em>`;
  }
}

function wireTimeline(el) {
  el.querySelector('#cs-tl-total')?.addEventListener('input', (e) => {
    state.totalFrames = Math.max(30, +e.target.value | 0);
    render();
  });
  el.querySelector('#cs-tl-fin')?.addEventListener('input', (e) => {
    state.autoFadeIn = Math.max(0, +e.target.value | 0);
  });
  el.querySelector('#cs-tl-fout')?.addEventListener('input', (e) => {
    state.autoFadeOut = Math.max(0, +e.target.value | 0);
  });
  el.querySelector('#cs-tl-add-track')?.addEventListener('change', (e) => {
    const kind = e.target.value;
    if (!kind) return;
    const meta = TRACK_KINDS[kind];
    const track = { kind, keyframes: [] };
    if (meta.castRequired) {
      // Default to the owner NPC.
      track.castId = state.owner || 'npc';
    }
    state.tracks.push(track);
    render();
  });
  el.querySelectorAll('.cs-tl-del-track').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ti = +btn.dataset.t;
      if (!await _csConfirm('Remove this track and its keyframes?')) return;
      state.tracks.splice(ti, 1);
      if (state.selected && state.selected.trackIdx === ti) state.selected = null;
      render();
    });
  });
  el.querySelectorAll('.cs-kf').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.selected = { trackIdx: +btn.dataset.t, kfIdx: +btn.dataset.k };
      render();
    });
  });
  el.querySelectorAll('.cs-tl-lane').forEach((lane) => {
    lane.addEventListener('click', (e) => {
      if (e.target.classList.contains('cs-kf')) return;
      const ti = +lane.dataset.t;
      const track = state.tracks[ti];
      if (!track) return;
      const rect = lane.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      const frame = Math.round(pct * state.totalFrames);
      const meta = TRACK_KINDS[track.kind] || {};
      // Default fields per kind so the new keyframe is compile-ready.
      const kf = { frame };
      if (track.kind === 'dialog') kf.line = state.lines[0]?.id || '';
      if (track.kind === 'face')   { kf.target = 'player'; kf.talk = true; }
      if (track.kind === 'npc')    kf.action = 'show';
      if (track.kind === 'music')  { kf.song = 0; kf.slot = 0; }
      if (track.kind === 'fade')   kf.kind = 'in';
      track.keyframes.push(kf);
      // Keep keyframes sorted so re-render preserves the sort order + click index.
      track.keyframes.sort((a, b) => a.frame - b.frame);
      state.selected = { trackIdx: ti, kfIdx: track.keyframes.indexOf(kf) };
      render();
    });
  });
  el.querySelector('#cs-kf-frame')?.addEventListener('input', (e) => {
    if (!state.selected) return;
    const { trackIdx, kfIdx } = state.selected;
    const kf = state.tracks[trackIdx]?.keyframes[kfIdx];
    if (!kf) return;
    kf.frame = Math.max(0, +e.target.value | 0);
  });
  el.querySelector('#cs-kf-delete')?.addEventListener('click', () => {
    if (!state.selected) return;
    const { trackIdx, kfIdx } = state.selected;
    state.tracks[trackIdx]?.keyframes.splice(kfIdx, 1);
    state.selected = null;
    render();
  });
  el.querySelectorAll('.cs-kf-field').forEach((input) => {
    input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', (e) => {
      if (!state.selected) return;
      const { trackIdx, kfIdx } = state.selected;
      const kf = state.tracks[trackIdx]?.keyframes[kfIdx];
      if (!kf) return;
      const k = e.target.dataset.k;
      kf[k] = e.target.type === 'checkbox' ? e.target.checked
            : e.target.classList.contains('cs-kf-int') ? +e.target.value
            : e.target.value;
    });
  });
}

// ── Preview pane — compile metrics + warnings + written files + bytecode ─────
function renderPreview() {
  const r = state.lastCompile;

  if (!r) {
    return `
      <div class="csp-empty">
        <span class="material-symbols-outlined">science</span>
        <div>
          <div class="csp-empty-h">Nothing compiled yet</div>
          <div class="csp-empty-t">Run <b>Preview compile</b> to lower this cutscene to bytecode and see the byte-size diff before you publish.</div>
        </div>
      </div>`;
  }
  if (r.error) {
    return `
      <div class="csp-card csp-card-err">
        <div class="csp-card-h"><span class="material-symbols-outlined">error</span>Compile failed</div>
        <div class="csp-err-body">${esc(r.error)}</div>
      </div>`;
  }

  const sizes = r.sizes || {};
  const published = !!(r.written && r.written.length);
  const opCount = (r.disasm || []).length;

  // ── Metric tiles ──
  const tiles = [
    ['tag',         r.eventId != null ? String(r.eventId) : '—', 'Event id',   '#7fd6e6', null],
    ['data_object', String(opCount),                              'Opcodes',    '#c792ea', null],
    ['description', _bytes(sizes.eventDatAfter),                  'Event DAT',  '#82aaff', _delta(sizes.eventDatBefore, sizes.eventDatAfter)],
    ['forum',       _bytes(sizes.dialogDatAfter),                 'Dialog DAT', '#7fd88f', _delta(sizes.dialogDatBefore, sizes.dialogDatAfter)],
  ];
  let html = `<div class="csp-tiles">` + tiles.map(([ico, val, k, c, d]) =>
    `<div class="csp-tile" style="--ac:${c}">
       <span class="material-symbols-outlined csp-tile-ico">${ico}</span>
       <div class="csp-tile-val">${esc(val)}</div>
       <div class="csp-tile-key">${k}</div>
       ${d ? `<div class="csp-tile-delta csp-d-${d.cls}">${d.text}</div>` : ''}
     </div>`).join('') + `</div>`;

  // ── Warnings ──
  const warns = r.warnings || [];
  if (warns.length) {
    html += `<div class="csp-card csp-card-warn">
        <div class="csp-card-h"><span class="material-symbols-outlined">warning</span>${warns.length} warning${warns.length > 1 ? 's' : ''}</div>
        ${warns.map((w) => `<div class="csp-warn-row">${esc(w)}</div>`).join('')}
      </div>`;
  }

  // ── Written files (only after a real publish) — grouped game vs Ashita pivot ──
  if (published) {
    const files = r.written || [];
    const fileRow = (p) => {
      const pivot = /polplugins/i.test(p);
      return `<div class="csp-file"><span class="material-symbols-outlined csp-file-ico csp-file-${pivot ? 'pivot' : 'game'}">${pivot ? 'extension' : 'draft'}</span><span class="csp-file-path">${esc(p)}</span></div>`;
    };
    html += `<div class="csp-card csp-card-ok">
        <div class="csp-card-h"><span class="material-symbols-outlined">check_circle</span>Published · ${files.length} file${files.length > 1 ? 's' : ''} written</div>
        <div class="csp-files">${files.map(fileRow).join('')}</div>
      </div>`;
  }

  // ── Bytecode (collapsible; open before publish so you can inspect the diff) ──
  const rows = (r.disasm || []).map((o) =>
    `<div class="csp-op"><span class="csp-op-off">+${(o.offset || 0).toString(16).padStart(4, '0')}</span><span class="csp-op-hex">${esc(o.op)}</span><span class="csp-op-name">${esc(o.name)}</span><span class="csp-op-args">${esc(o.args)}</span></div>`
  ).join('');
  html += `<details class="csp-fold"${published ? '' : ' open'}>
      <summary><span class="material-symbols-outlined">code</span>Bytecode<span class="csp-fold-count">${opCount} ops</span></summary>
      <div class="csp-disasm">${rows || '<em class="csp-muted">no opcodes</em>'}</div>
    </details>`;

  // ── Server Lua stub (collapsible) ──
  if (r.luaStub) {
    html += `<details class="csp-fold">
        <summary><span class="material-symbols-outlined">terminal</span>Server Lua stub<span class="csp-fold-count">Lua</span></summary>
        <pre class="csp-lua">${esc(r.luaStub)}</pre>
      </details>`;
  }

  return html;
}
