// publish-mode.js — editor mode state ('edit' | 'view' | 'production' | 'base' | 'hd'),
// mode-switcher UI, and view-frame syncing.
//
// Modes:
//   edit       — editable working copy, your changes shown
//   view       — read-only, your edited changes still shown (blue frame)
//   production — read-only, the released (current on-disk) DAT, NO changes (red frame)
//   base       — read-only, the pristine .base backup, zero changes ever (orange frame)
//   hd         — read-only, the HD asset-pack DAT for this zone, NO changes (violet frame)
// edit<->view never reloads (changes stay put); crossing into/out of a clean mode
// (production/base/hd) reloads the DAT — production loads the current bytes, base loads
// the .base backup, hd loads the HD sibling — and replays your changes when returning to edit/view.
//
// Exports: initPublishMode, setMode, getMode, getEditMode, isCleanMode,
//   applyModeUI, syncViewFrame, closeModeMenu,
//   getModeReplayPending, setModeReplayPending,
//   getModeFetchedZone, setModeFetchedZone,
//   getSuppressStateFetch, setSuppressStateFetch

// ── DOM refs (resolved once at module load) ───────────────────────────────────
export const modeBtn        = document.getElementById('mode-btn');
export const modeMenu       = document.getElementById('mode-menu');
export const viewFrameEl    = document.getElementById('view-frame');
const appEl                 = document.getElementById('app');
const viewModeLabelEl       = document.getElementById('view-mode-label');

// ── module-level state ────────────────────────────────────────────────────────
let mode = 'edit';              // 'edit' | 'view' | 'production' | 'base' | 'hd'
let editMode = true;            // derived: mode === 'edit'
let activeVersionLabel = null;  // version number last restored/published, shown in mode button

// Read-only "clean" modes show the DAT with NO editor changes replayed.
export const isCleanMode = (m = mode) => m === 'production' || m === 'base' || m === 'hd';

let modeReplayPending = null;   // change-set to replay when (re)entering an edited state
let modeFetchedZone   = '';     // zone whose backend state we've already pulled
let _suppressStateFetch = false;
let _modeSwitching      = false;

export function getMode()               { return mode; }
export function getEditMode()           { return editMode; }
export function getModeReplayPending()  { return modeReplayPending; }
export function setModeReplayPending(v) { modeReplayPending = v; }
export function getModeFetchedZone()    { return modeFetchedZone; }
export function setModeFetchedZone(v)   { modeFetchedZone = v; }
export function getSuppressStateFetch() { return _suppressStateFetch; }
export function setSuppressStateFetch(v) { _suppressStateFetch = v; }

// ── lazy-injected callbacks ───────────────────────────────────────────────────
let _getCanvas              = null;
let _getTransform           = null;
let _getSelected            = null;
let _isLocked               = null;
let _hdVariantAvailable     = null;  // () => bool
let _setStatus              = null;
let _snapshotChanges        = null;
let _snapshotHasContent     = null;
let _loadChangesFromJson    = null;
let _applyWorkspaceViewState = null;
let _reloadZoneClean        = null;
let _markSaved              = null;
let _applyVfxIconVisibility = null;
let _applyIsolateCollision  = null;
let _applyIsolateNavmesh    = null;

export function initPublishMode({
  getCanvas, getTransform, getSelected, isLocked, hdVariantAvailable,
  setStatus, snapshotChanges, snapshotHasContent, loadChangesFromJson,
  applyWorkspaceViewState, reloadZoneClean, markSaved,
  applyVfxIconVisibility, applyIsolateCollision, applyIsolateNavmesh,
}) {
  _getCanvas               = getCanvas;
  _getTransform            = getTransform;
  _getSelected             = getSelected;
  _isLocked                = isLocked;
  _hdVariantAvailable      = hdVariantAvailable;
  _setStatus               = setStatus;
  _snapshotChanges         = snapshotChanges;
  _snapshotHasContent      = snapshotHasContent;
  _loadChangesFromJson     = loadChangesFromJson;
  _applyWorkspaceViewState = applyWorkspaceViewState;
  _reloadZoneClean         = reloadZoneClean;
  _markSaved               = markSaved;
  _applyVfxIconVisibility  = applyVfxIconVisibility;
  _applyIsolateCollision   = applyIsolateCollision;
  _applyIsolateNavmesh     = applyIsolateNavmesh;

  // Wire up the mode dropdown now that callbacks are available.
  _wireModeMenu();
}

// ── version label ─────────────────────────────────────────────────────────────
export function setActiveVersionLabel(n) {
  activeVersionLabel = n;
  applyModeUI();
}
export function getActiveVersionLabel() { return activeVersionLabel; }

// ── view frame sync ───────────────────────────────────────────────────────────
export function syncViewFrame() {
  if (!viewFrameEl) return;
  const canvas = _getCanvas ? _getCanvas() : null;
  if (!canvas) return;
  viewFrameEl.style.width  = canvas.clientWidth  + 'px';
  viewFrameEl.style.height = canvas.clientHeight + 'px';
}

// ── mode UI application ───────────────────────────────────────────────────────
export function applyModeUI() {
  appEl?.classList.toggle('readonly',        mode !== 'edit');
  appEl?.classList.toggle('view-mode',       mode === 'view');
  appEl?.classList.toggle('production-mode', mode === 'production');
  appEl?.classList.toggle('base-mode',       mode === 'base');
  appEl?.classList.toggle('hd-mode',         mode === 'hd');
  if (viewModeLabelEl) viewModeLabelEl.textContent =
    mode === 'production' ? 'PRODUCTION — RELEASED DAT' :
    mode === 'base'       ? 'BASE — PRISTINE DAT' :
    mode === 'hd'         ? 'HD ZONE — READ ONLY' : 'VIEWING MODE';
  const modeWord = mode === 'edit'       ? 'Editing'
                 : mode === 'view'       ? 'Viewing'
                 : mode === 'base'       ? 'Backup Base'
                 : mode === 'hd'         ? 'Live: HD Zone'
                 : 'Live: Standard Zone';
  if (modeBtn) {
    modeBtn.textContent = modeWord + (activeVersionLabel != null ? ` (v${activeVersionLabel})` : '');
    modeBtn.className   = `mode-btn mode-${mode}`;
  }
  if (modeMenu) {
    for (const b of modeMenu.querySelectorAll('button[data-mode]')) {
      b.classList.toggle('active', b.dataset.mode === mode);
    }
  }
  const transform = _getTransform ? _getTransform() : null;
  if (transform) {
    transform.enabled = editMode;
    if (!editMode) {
      transform.detach();
    } else {
      const sel = _getSelected ? _getSelected() : null;
      if (sel && _isLocked && !_isLocked(sel)) transform.attach(sel.node);
    }
  }
  if (_applyVfxIconVisibility)  _applyVfxIconVisibility();
  if (_applyIsolateCollision)   _applyIsolateCollision();
  if (_applyIsolateNavmesh)     _applyIsolateNavmesh();
  syncViewFrame();
}

// ── mode switching ────────────────────────────────────────────────────────────
export async function setMode(newMode) {
  if (newMode === mode || _modeSwitching) return;
  if (newMode === 'hd' && !(_hdVariantAvailable && _hdVariantAvailable())) {
    _setStatus('No HD asset-pack DAT exists for this zone.', true);
    return;
  }
  _modeSwitching = true;
  try {
    const prevMode  = mode;
    const wasReplay = !isCleanMode(prevMode);
    const willReplay = !isCleanMode(newMode);
    // Leaving the replay state → capture current edits so a clean mode can revert and we can restore.
    if (wasReplay && !willReplay) {
      const snap = _snapshotChanges();
      modeReplayPending = _snapshotHasContent(snap) ? snap : null;
    }
    mode     = newMode;
    editMode = (mode === 'edit');
    applyModeUI();
    const sig = (m) => `${m === 'base' ? 'base' : m === 'hd' ? 'hd' : 'cur'}|${isCleanMode(m) ? 'clean' : 'replay'}`;
    if (sig(prevMode) !== sig(newMode) && _reloadZoneClean) {
      // Reload whenever the displayed bytes change.
      _suppressStateFetch = true;
      try {
        await _reloadZoneClean(mode === 'base', mode === 'hd');
      } finally {
        _suppressStateFetch = false;
      }
      if (willReplay && _snapshotHasContent(modeReplayPending)) {
        try {
          await _loadChangesFromJson(modeReplayPending, '(restored)', { recordHistory: false });
          if (_applyWorkspaceViewState) _applyWorkspaceViewState(modeReplayPending);
        } catch (e) { console.error('[restore]', e); }
        modeReplayPending = null;
      }
      if (_markSaved) _markSaved();
    }
    if (_setStatus) {
      _setStatus(
        mode === 'edit'       ? 'Edit mode' :
        mode === 'view'       ? 'View mode — your changes, editing locked' :
        mode === 'base'       ? 'Base mode — pristine .base DAT, no changes ever' :
        mode === 'hd'         ? 'HD Zone mode — read-only HD asset-pack DAT, no changes' :
        'Production mode — released DAT, no changes'
      );
    }
  } finally { _modeSwitching = false; }
}

// ── mode dropdown ─────────────────────────────────────────────────────────────
export function closeModeMenu() { modeMenu?.classList.remove('open'); }

function _wireModeMenu() {
  if (!modeBtn || !modeMenu) return;
  modeBtn.onclick = (e) => {
    e.stopPropagation();
    if (modeMenu.classList.contains('open')) { closeModeMenu(); return; }
    const r = modeBtn.getBoundingClientRect();
    modeMenu.style.left = r.left + 'px';
    modeMenu.style.top  = (r.bottom + 6) + 'px';
    modeMenu.classList.add('open');
  };
  document.addEventListener('pointerdown', (e) => {
    if (modeMenu.classList.contains('open') && !modeMenu.contains(e.target) && e.target !== modeBtn) {
      closeModeMenu();
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModeMenu(); });
  modeMenu.querySelectorAll('button[data-mode]').forEach((b) => {
    b.onclick = () => { closeModeMenu(); setMode(b.dataset.mode); };
  });
}
