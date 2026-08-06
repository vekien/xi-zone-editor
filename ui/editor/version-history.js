// version-history.js — version history panel for the level editor
// Call initVersionHistory(deps) once after the DOM is ready.
// openConsole / closeConsole live in backend-log.js and are imported here.

import { openConsole, closeConsole } from './backend-log.js';
export { openConsole, closeConsole };

let _bridgeCall = null;
let _bridgeOnline = null;
let _setStatus = null;
let _showErrorBanner = null;
let _xi_confirm = null;
let _xi_alert = null;
let _getCurrentZoneUrl = null;
let _getCurrentProject = null;
let _snapshotHasContent = null;
let _changesHaveCategories = null;
let _isCleanMode = null;
let _setMode = null;
let _reloadZoneClean = null;
let _loadChangesFromJson = null;
let _applyWorkspaceViewState = null;
let _setModeFetchedZone = null;
let _setVersionLabel = null;
let _zoneNameForPath = null;
let _openModal = null;
let _fileBtn = null;

export function initVersionHistory({
  bridgeCall, bridgeOnline, setStatus, showErrorBanner,
  xi_confirm, xi_alert,
  getCurrentZoneUrl, getCurrentProject,
  snapshotHasContent, changesHaveCategories,
  isCleanMode, setMode,
  reloadZoneClean, loadChangesFromJson, applyWorkspaceViewState,
  setModeFetchedZone, setVersionLabel,
  zoneNameForPath,
  openModal, fileBtn,
}) {
  _bridgeCall = bridgeCall;
  _bridgeOnline = bridgeOnline;
  _setStatus = setStatus;
  _showErrorBanner = showErrorBanner;
  _xi_confirm = xi_confirm;
  _xi_alert = xi_alert;
  _getCurrentZoneUrl = getCurrentZoneUrl;
  _getCurrentProject = getCurrentProject;
  _snapshotHasContent = snapshotHasContent;
  _changesHaveCategories = changesHaveCategories;
  _isCleanMode = isCleanMode;
  _setMode = setMode;
  _reloadZoneClean = reloadZoneClean;
  _loadChangesFromJson = loadChangesFromJson;
  _applyWorkspaceViewState = applyWorkspaceViewState;
  _setModeFetchedZone = setModeFetchedZone;
  _setVersionLabel = setVersionLabel;
  _zoneNameForPath = zoneNameForPath;
  _openModal = openModal;
  _fileBtn = fileBtn;
}

// Re-open a stored publish log (from Version History) in the same console window.
export async function viewVersionLog(n) {
  if (!_bridgeOnline()) { _setStatus('Viewing a publish log needs the backend.', true); return; }
  const currentZoneUrl = _getCurrentZoneUrl();
  try {
    const r = await _bridgeCall('zone.versionGet', { zone: currentZoneUrl, version: n });
    const con = openConsole(`Publish log — v${n}`);
    con.log((r && r.log) || '(no log was saved for this version)');
    con.done('');
  } catch (e) { _setStatus(`Failed to load v${n} log: ${e.message}`, true); }
}

export async function viewVersionChanges(n) {
  if (!_bridgeOnline()) { _setStatus('Viewing changes needs the backend.', true); return; }
  const currentZoneUrl = _getCurrentZoneUrl();
  try {
    const r = await _bridgeCall('zone.versionGet', { zone: currentZoneUrl, version: n });
    const ch = (r && r.changes) || {};
    const lines = [];
    const SEP = '─'.repeat(48);

    function section(title, items, labelFn) {
      if (!items || !items.length) return;
      lines.push('', `${title}  (${items.length})`, SEP);
      for (const it of items) lines.push(`  ${labelFn(it)}`);
    }

    const opPrefix = (op) => op === 'add' ? '+' : op === 'delete' || op === 'remove' ? '-' : '~';

    section('Placements', ch.placements, (it) => {
      const label = (it.op === 'modify' ? (it.instanceName || it.name) : it.name) || '(unnamed)';
      const suffix = it.op === 'modify' ? ' (moved/scaled)' : '';
      return `${opPrefix(it.op)}  ${label}${suffix}`;
    });

    section('VFX', ch.vfx, (it) => {
      const label = it.name || `id:${it.id ?? it.source_id ?? '?'}`;
      return `${opPrefix(it.op)}  ${label}`;
    });

    section('Markers', ch.markers, (it) => `+  ${it.name || '(unnamed)'}${it.type ? ` (${it.type})` : ''}`);

    section('Collisions', ch.collisions, (it) => `+  ${it.name || '(unnamed)'}${it.collisionType ? ` (${it.collisionType})` : ''}`);

    section('Sounds', ch.sounds, (it) => {
      const label = it.name || it.soundFile || `id:${it.soundId ?? '?'}`;
      return `${opPrefix(it.op)}  ${label}`;
    });

    section('Mobs', ch.mobs, (it) => {
      const label = it.name || `pool:${it.poolid ?? '?'}`;
      return `${opPrefix(it.op)}  ${label}`;
    });

    if (ch.music && Object.keys(ch.music).length) {
      const slots = Object.keys(ch.music);
      lines.push('', `Music  (${slots.length})`, SEP);
      for (const slot of slots) lines.push(`  ~  ${slot}`);
    }

    if (ch.stripInteractions && ch.stripInteractions.length) {
      lines.push('', 'Zone Actions', SEP);
      lines.push('  ~  Remove sub-areas & zone lines');
    }

    if (ch.footsteps?.sourceZone) {
      lines.push('', 'Footsteps', SEP);
      lines.push(`  ~  Source zone: ${_zoneNameForPath(ch.footsteps.sourceZone)}`);
    }

    const con = openConsole(`Changes — v${n}`);
    con.log(lines.length ? lines.join('\n').trimStart() : '(no changes recorded for this version)');
    con.done('');
  } catch (e) { _setStatus(`Failed to load v${n} changes: ${e.message}`, true); }
}

export async function openVersionHistory() {
  const panel = document.getElementById('version-panel');
  if (!panel) return;
  _openModal(panel, _fileBtn);
  const currentZoneUrl = _getCurrentZoneUrl();
  const zoneEl = document.getElementById('vh-zone');
  const listEl = document.getElementById('vh-list');
  const zoneName = (currentZoneUrl || '').split(/[\\/]/).pop() || '(no zone loaded)';
  if (zoneEl) {
    zoneEl.textContent = 'Published versions for ';
    const s = document.createElement('strong'); s.textContent = zoneName; zoneEl.appendChild(s);
  }
  if (!listEl) return;
  if (!_bridgeOnline()) {
    listEl.innerHTML = '<div class="vh-empty">Version history needs the backend — run the editor via <code>xi gui zone</code>.</div>';
    return;
  }
  listEl.innerHTML = '<div class="vh-empty">Loading…</div>';
  try {
    const r = await _bridgeCall('zone.versions', { zone: currentZoneUrl });
    renderVersionList((r && r.versions) || [], (r && r.current) || 0);
  } catch (e) {
    listEl.innerHTML = `<div class="vh-empty">Failed to load versions: ${e.message}</div>`;
  }
}

export function renderVersionList(versions, current) {
  const listEl = document.getElementById('vh-list');
  const sb = document.getElementById('vh-statusbar');
  if (!listEl) return;
  listEl.textContent = '';
  if (!versions.length) {
    listEl.innerHTML = '<div class="vh-empty">No published versions yet — each Publish saves one here.</div>';
    if (sb) sb.textContent = '0 versions';
    return;
  }

  // Build a colored +add -del ~mod span for one category.
  // Handles legacy format (raw is a number = total) and new format ({add,delete,modify}).
  function opsSpan(label, raw) {
    if (!raw) return null;
    const wrap = document.createElement('span'); wrap.className = 'vh-op-group';
    const mk = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
    if (typeof raw === 'number') {
      if (!raw) return null;
      wrap.append(mk('', String(raw)));
    } else {
      const add = raw.add || 0, dels = raw.delete || 0, mod = raw.modify || 0;
      if (!add && !dels && !mod) return null;
      if (add)  wrap.append(mk('vh-add', `+${add}`));
      if (dels) wrap.append(mk('vh-del', `-${dels}`));
      if (mod)  wrap.append(mk('vh-mod', `~${mod}`));
    }
    wrap.append(mk('vh-op-label', ` ${label}`));
    return wrap;
  }

  for (const v of versions) {
    const c = v.counts || {};
    const row = document.createElement('div');
    row.className = 'vh-row' + (v.version === current ? ' current' : '');
    const ver = document.createElement('span'); ver.className = 'vh-ver'; ver.textContent = `v${v.version}`;
    const ts  = document.createElement('span'); ts.className  = 'vh-ts';  ts.textContent  = (v.ts || '').replace('T', ' ');
    const counts = document.createElement('span'); counts.className = 'vh-counts';
    const groups = [
      opsSpan('obj',  c.placements),
      opsSpan('vfx',  c.vfx),
      opsSpan('mark', c.markers),
      opsSpan('col',  c.collisions),
    ].filter(Boolean);
    if (groups.length) {
      groups.forEach((g, i) => {
        if (i) counts.append(Object.assign(document.createElement('span'), { className: 'vh-sep', textContent: ' · ' }));
        counts.appendChild(g);
      });
    } else {
      counts.textContent = 'empty';
    }
    row.append(ver, ts, counts);
    const chgBtn = document.createElement('button'); chgBtn.className = 'vh-log'; chgBtn.textContent = 'Changes';
    chgBtn.title = 'View the list of changes in this version';
    chgBtn.onclick = () => viewVersionChanges(v.version);
    row.append(chgBtn);
    if (v.hasLog) {
      const logBtn = document.createElement('button'); logBtn.className = 'vh-log'; logBtn.textContent = 'Publish Log';
      logBtn.title = 'View the publish log saved for this version';
      logBtn.onclick = () => viewVersionLog(v.version);
      row.append(logBtn);
    }
    const btn = document.createElement('button'); btn.className = 'vh-restore'; btn.textContent = 'Restore';
    btn.onclick = () => restoreVersion(v.version);
    row.append(btn);
    listEl.appendChild(row);
  }

  if (sb) {
    const n = versions.length;
    sb.textContent = `${n} version${n === 1 ? '' : 's'} · current: v${current}`;
  }
}

// Restore: reload the pristine DAT, then replay the chosen version's change-set onto it
// (mirrors the Production→Edit replay path). Does NOT publish — the user reviews, then
// Saves or Publishes to keep it.
export async function restoreVersion(n) {
  const currentZoneUrl = _getCurrentZoneUrl();
  if (!_bridgeOnline()) { _setStatus('Restore needs the backend.', true); return; }
  if (!await _xi_confirm(`Restore Version v${n}`,
      `This reloads the zone and replays the v${n} change-set, replacing your current `
      + `scene edits — any unsaved edits are discarded.\n\n`
      + `Restoring does NOT publish. Review, then Save or Publish to keep it.`, 'Restore')) return;
  _setStatus(`Restoring v${n}…`);
  try {
    const r = await _bridgeCall('zone.versionGet', { zone: currentZoneUrl, version: n });
    const changes = r && r.changes;
    const hasViewState = !!(changes && (Object.keys(changes.visibility || {}).length || Object.keys(changes.locks || {}).length)) || _changesHaveCategories(changes);
    if (!_snapshotHasContent(changes) && !hasViewState) { _setStatus(`v${n} has no changes to restore.`, true); return; }
    if (_isCleanMode()) await _setMode('edit');   // Production/Base can't show edits
    await _reloadZoneClean(currentZoneUrl);
    if (_snapshotHasContent(changes)) await _loadChangesFromJson(changes, `v${n}`);
    _applyWorkspaceViewState(changes);
    _setModeFetchedZone(currentZoneUrl);   // this scene is now the source of truth — don't re-pull the save
    document.getElementById('version-panel')?.classList.remove('open');
    _setVersionLabel(n);
    _setStatus(`Restored v${n} — review, then Save or Publish to keep it.`);
  } catch (e) { _showErrorBanner(`Restore failed: ${e.message}`); _setStatus(`Restore failed: ${e.message}`, true); }
}

// Wipe a zone's Publish history: deletes its versions/ snapshots and resets the
// counter to v1. Does NOT touch the live scene or the saved change-set.
export async function clearVersionHistory() {
  const currentZoneUrl = _getCurrentZoneUrl();
  if (!_bridgeOnline()) { await _xi_alert('Bridge Offline', 'Clearing version history needs the backend — run the editor via `xi gui zone`.'); return; }
  if (!currentZoneUrl) { _setStatus('No zone loaded.', true); return; }
  const zoneName = (currentZoneUrl || '').split(/[\\/]/).pop() || 'this zone';
  if (!await _xi_confirm('Clear Version History',
      `Permanently delete all published version snapshots for ${zoneName} and reset its version counter to v1.\n\n`
      + `Your current scene and saved change-set are NOT affected — only the Publish history is removed. Cannot be undone.`,
      'Clear History')) return;
  _setStatus('Clearing version history…');
  try {
    const r = await _bridgeCall('zone.versionsClear', { zone: currentZoneUrl });
    const n = r?.removed ?? 0;
    _setStatus(`Cleared version history — removed ${n} snapshot${n === 1 ? '' : 's'}.`);
    // Refresh the Version History panel if it's open so the list empties out.
    if (document.getElementById('version-panel')?.classList.contains('open')) openVersionHistory();
  } catch (e) {
    _showErrorBanner(`Clear version history failed: ${e.message}`);
    _setStatus(`Clear version history failed: ${e.message}`, true);
  }
}
