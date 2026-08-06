// auto-save.js — periodic + per-action auto-save extracted from main.js
// Two modes: "save every action" (debounced 1.2s on each change) and "every 60s").
// A change-signature gate (changeSig / lastSavedSig, maintained in main.js) skips
// saves when nothing has actually changed since the last write.
//
// The DOM toggles (toggle-autosave, toggle-autosave-action) remain wired in
// main.js because they directly mutate main-local `autoSave` / `saveEveryAction`
// let-vars; they call applyAutoSaveMode() after updating the flags.

// ── injected dependencies (set via initAutoSave) ───────────────────────────────
let _getAutoSave, _getSaveEveryAction, _getMode;
let _bridgeOnline, _snapshotChanges, _snapshotHasContent, _uploadGlbAssets, _bridgeCall;
let _showErrorBanner, _getCurrentZoneUrl, _changeSig;
let _getLastSavedSig, _getLastSavedHadContent, _setLastSavedSig, _setModeFetchedZone;

let _autoSaveDebounce = null, _autoSaveInterval = null, _autoSaving = false;

/**
 * Wire up auto-save. Call once during startup.
 *
 * @param {object} opts
 * @param {() => boolean}     opts.getAutoSave
 * @param {() => boolean}     opts.getSaveEveryAction
 * @param {() => string}      opts.getMode              — returns 'view' | 'edit'
 * @param {() => boolean}     opts.bridgeOnline
 * @param {() => object}      opts.snapshotChanges
 * @param {(snap) => boolean} opts.snapshotHasContent
 * @param {(snap) => Promise} opts.uploadGlbAssets
 * @param {Function}          opts.bridgeCall
 * @param {Function}          opts.showErrorBanner
 * @param {() => string}      opts.getCurrentZoneUrl
 * @param {(snap) => string}  opts.changeSig
 * @param {() => string}      opts.getLastSavedSig
 * @param {() => boolean}     opts.getLastSavedHadContent
 * @param {(s: string) => void} opts.setLastSavedSig
 * @param {(url: string) => void} opts.setModeFetchedZone
 */
export function initAutoSave({
  getAutoSave, getSaveEveryAction, getMode,
  bridgeOnline, snapshotChanges, snapshotHasContent, uploadGlbAssets, bridgeCall,
  showErrorBanner, getCurrentZoneUrl, changeSig,
  getLastSavedSig, getLastSavedHadContent, setLastSavedSig, setModeFetchedZone,
}) {
  _getAutoSave        = getAutoSave;
  _getSaveEveryAction = getSaveEveryAction;
  _getMode            = getMode;
  _bridgeOnline       = bridgeOnline;
  _snapshotChanges    = snapshotChanges;
  _snapshotHasContent = snapshotHasContent;
  _uploadGlbAssets    = uploadGlbAssets;
  _bridgeCall         = bridgeCall;
  _showErrorBanner    = showErrorBanner;
  _getCurrentZoneUrl  = getCurrentZoneUrl;
  _changeSig          = changeSig;
  _getLastSavedSig    = getLastSavedSig;
  _getLastSavedHadContent = getLastSavedHadContent;
  _setLastSavedSig    = setLastSavedSig;
  _setModeFetchedZone = setModeFetchedZone;
}

export function applyAutoSaveMode() {
  clearInterval(_autoSaveInterval); _autoSaveInterval = null;
  if (_getAutoSave() && !_getSaveEveryAction()) _autoSaveInterval = setInterval(() => doAutoSave(), 60000);
}

// Called from updateChangesUI (on any change). Debounced when "every action" is on.
export function scheduleAutoSave() {
  if (!_getAutoSave() || !_getSaveEveryAction() || _getMode() !== 'edit' || !_getCurrentZoneUrl()) return;
  clearTimeout(_autoSaveDebounce);
  _autoSaveDebounce = setTimeout(() => doAutoSave(), 1200);
}

export async function doAutoSave() {
  if (!_getAutoSave() || _getMode() !== 'edit' || !_bridgeOnline() || _autoSaving) return;
  const zone = _getCurrentZoneUrl();
  if (!zone) return;
  const snap = _snapshotChanges();
  const sig = _changeSig(snap);
  if (sig === _getLastSavedSig()) return;        // nothing new since the last save
  const hasContent = _snapshotHasContent(snap);
  _autoSaving = true;
  try {
    await _uploadGlbAssets(snap);
    await _bridgeCall('zone.saveChanges', { zone, changes: snap });
    _setLastSavedSig(sig, hasContent);
    _setModeFetchedZone(zone);
  } catch (e) {
    console.error('[autosave]', e);
    _showErrorBanner(`Auto-save failed: ${e.message}`);
  } finally { _autoSaving = false; }
}
