import { loadSetting, saveSetting } from '../editor/settings.js';
import { bridgeCall, bridgeOnline } from '../ffxi/bridge.js';

let _deps = {};

export function initZoneNav(deps) {
  _deps = deps;
}

// ── Zone info panel ─────────────────────────────────────────────────────────

export function updateZoneInfo() {
  const el = document.getElementById('zone-info');
  if (!el || !_deps.getZonesData) return;
  const zonesData = _deps.getZonesData();
  const customZonesData = _deps.getCustomZonesData();
  const currentZoneUrl = _deps.getCurrentZoneUrl();
  const zoneEntry = zonesData.find((z) => z.path === currentZoneUrl)
    || customZonesData.find((z) => z.path === currentZoneUrl);
  const isHd = (_deps.getMode() === 'hd');
  const datDisplay = (currentZoneUrl || '').replace(/^game\//, '') || '—';
  const datRel = (currentZoneUrl || '').replace(/^game(-hd)?\//, '');
  const datBase = isHd ? _deps.getFfxiHdDir() : _deps.getFfxiDir();
  const datFull = (datBase && datRel)
    ? datBase.replace(/[\\/]+$/, '') + '\\' + datRel.replace(/\//g, '\\')
    : datDisplay;
  const absDat = (rel) => (datBase && rel) ? datBase.replace(/[\\/]+$/, '') + '\\' + rel.replace(/\//g, '\\') : rel;
  const rows = [
    ['Name', document.getElementById('zone')?.selectedOptions?.[0]?.text || '—'],
    ['DAT', datDisplay, !!(currentZoneUrl), datFull],
  ];
  const currentCompanionDats = _deps.getCurrentCompanionDats();
  if (currentCompanionDats) {
    if (currentCompanionDats.event)  rows.push(['Event DAT',  currentCompanionDats.event,  true, absDat(currentCompanionDats.event)]);
    if (currentCompanionDats.dialog) rows.push(['Dialog DAT', currentCompanionDats.dialog, true, absDat(currentCompanionDats.dialog)]);
    if (currentCompanionDats.npc)    rows.push(['NPC DAT',    currentCompanionDats.npc,    true, absDat(currentCompanionDats.npc)]);
  }
  const coll = _deps.getParsed()?.collision;
  const colsTrisEl = document.getElementById('cols-tris');
  if (colsTrisEl) colsTrisEl.textContent = coll ? `${coll.triCount.toLocaleString()} collision tris` : (_deps.getParsed() ? 'No collision mesh' : '');
  if (zoneEntry?.id != null) {
    const zid = zoneEntry.id;
    const fid = zid < 0x100 ? 0x64 + zid : 0x147B3 + (zid - 0x100);
    rows.push(['Zone ID', zid, true, `!zone ${zid}`]);
    rows.push(['File ID', fid]);
  }
  const navmeshNavFile = _deps.getNavmeshNavFile();
  const navmeshGroup = _deps.getNavmeshGroup();
  if (navmeshNavFile) rows.push(['NavMesh', navmeshNavFile.split(/[\\/]/).pop()]);
  else if (_deps.getParsed()) rows.push(['NavMesh', navmeshGroup ? '✓ loaded' : '—']);
  if (isHd) rows.push(['Assets', 'HD Textures']);
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  el.innerHTML = '<div class="section-title">ZONE INFO</div>' + rows.map(([k, v, copyable, copyVal]) => {
    const copy = copyVal != null ? copyVal : v;
    return `<div class="zi-row"><span class="zi-k">${k}</span><span class="zi-v${copyable ? ' zi-copy' : ''}" ${copyable ? `data-copy="${esc(copy)}" title="${esc(copy)}"` : ''}>${esc(v)}</span></div>`;
  }).join('');
  el.querySelectorAll('.zi-copy[data-copy]').forEach((copyEl) => {
    copyEl.onclick = () => {
      navigator.clipboard.writeText(copyEl.dataset.copy).catch(() => {});
      const prev = copyEl.textContent;
      copyEl.textContent = 'copied!';
      setTimeout(() => { copyEl.textContent = prev; }, 1200);
    };
  });
  _deps.updateHdUI();
  _deps.updateDeleteZoneBtn?.();
  _deps.updateMakeTemplateBtn();
  _deps.ensureZoneMusic();
}

export async function loadZoneSettingsPanel() {
  const el = document.getElementById('zone-settings');
  if (!el) return;
  const zid = _deps.currentZoneId();
  if (!zid || !bridgeOnline()) { el.style.display = 'none'; return; }
  el.style.display = '';

  let settings = null;
  try { const r = await bridgeCall('zone.getSettings', { zoneId: zid }); if (!r?.error) settings = r; } catch { /* DB offline */ }
  if (!settings) return;

  const typeSelect = document.getElementById('zs-zonetype');
  if (typeSelect) typeSelect.value = String(settings.zonetype || 0);

  el.querySelectorAll('input[data-bit][data-field="misc"]').forEach((cb) => {
    cb.checked = !!((settings.misc || 0) & +cb.dataset.bit);
  });
}

// ── Window title ─────────────────────────────────────────────────────────────

export function updateWindowTitle() {
  const launcherState = _deps.getLauncherState();
  const currentZoneUrl = _deps.getCurrentZoneUrl();
  const base = (launcherState.browseOnly || !launcherState.currentProject) ? 'FFXI Zone Editor' : 'XI Zone Editor';
  const proj = (!launcherState.browseOnly && launcherState.currentProject) ? (launcherState.currentProject.name || launcherState.currentProject.id) : '';
  const zone = currentZoneUrl ? zoneNameForPath(currentZoneUrl) : '';
  document.title = [zone, proj, base].filter(Boolean).join(' — ');
}

// ── Time-of-day / weather UI ─────────────────────────────────────────────────

export const fmtTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function populateWeather() {
  const sel = document.getElementById('weather'); if (!sel) return;
  const environments = _deps.getEnvironments();
  const keys = [...environments.keys()];
  sel.innerHTML = keys.length ? '' : '<option>—</option>';
  for (const k of keys) { const o = document.createElement('option'); o.value = k; o.textContent = k; sel.appendChild(o); }
  const currentWeather = keys.includes('suny') ? 'suny' : keys.includes('fine') ? 'fine' : (keys[0] || 'default');
  _deps.setCurrentWeather(currentWeather);
  sel.value = currentWeather; sel.disabled = !keys.length;
}

// ── Shared zone loader ────────────────────────────────────────────────────────

export async function goToZone(path) {
  const currentZoneUrl = _deps.getCurrentZoneUrl();
  if (currentZoneUrl && path !== currentZoneUrl && _deps.hasUnsavedChanges()) {
    const ok = await _deps.xi_confirm('Unsaved Changes', 'You have unsaved changes. Continue and discard them?', 'Discard');
    if (!ok) return false;
  }
  const zoneEl = document.getElementById('zone');
  if (zoneEl) zoneEl.value = path;
  _deps.loadZone(path);
  return true;
}

// ── Pinned zones ──────────────────────────────────────────────────────────────

export function loadPinnedZones() {
  try { return JSON.parse(loadSetting('pinnedZones', '[]')) || []; } catch { return []; }
}
export function savePinnedZones(arr) { saveSetting('pinnedZones', JSON.stringify(arr)); }
export function isZonePinned(path) { return loadPinnedZones().includes(path); }
export function zoneNameForPath(path) {
  const zonesData = _deps.getZonesData();
  const customZonesData = _deps.getCustomZonesData();
  const z = zonesData.find((z) => z.path === path) || customZonesData.find((z) => z.path === path);
  return z?.name || path.replace(/^game\//, '');
}
export function pinZone(path) {
  const pins = loadPinnedZones();
  if (pins.includes(path)) return;
  pins.push(path);
  savePinnedZones(pins);
  renderPinnedZones();
}
export function unpinZone(path) {
  savePinnedZones(loadPinnedZones().filter((p) => p !== path));
  renderPinnedZones();
}
export function renderPinnedZones() {
  const pinnedZonesBlockEl = document.getElementById('pinned-zones-block');
  const pinnedZonesEl = document.getElementById('pinned-zones');
  if (!pinnedZonesBlockEl || !pinnedZonesEl) return;
  const currentZoneUrl = _deps.getCurrentZoneUrl();
  const pins = loadPinnedZones();
  pinnedZonesEl.innerHTML = '';
  pinnedZonesBlockEl.style.display = pins.length ? '' : 'none';
  for (const path of pins) {
    const li = document.createElement('li');
    li.className = 'pz-item' + (path === currentZoneUrl ? ' active' : '');
    li.title = path.replace(/^game\//, '');
    const name = document.createElement('span');
    name.className = 'pz-name';
    name.textContent = zoneNameForPath(path);
    li.appendChild(name);
    const unpin = document.createElement('button');
    unpin.className = 'pz-unpin';
    unpin.textContent = '×';
    unpin.title = 'Unpin zone';
    unpin.onclick = (e) => { e.stopPropagation(); unpinZone(path); };
    li.appendChild(unpin);
    li.onclick = () => goToZone(path);
    li.addEventListener('contextmenu', (e) => _deps.openContextMenu(e, (addItem) => {
      addItem('Unpin zone', () => unpinZone(path));
    }));
    pinnedZonesEl.appendChild(li);
  }
}

// ── Project zones ─────────────────────────────────────────────────────────────

export async function removeZoneFromProject(path) {
  if (!bridgeOnline()) return;
  try { await bridgeCall('project.removeZone', { zone: path }); } catch (e) { console.warn('removeZone failed', e); }
  refreshProjectZones();
}

export async function refreshProjectZones() {
  const block = document.getElementById('project-zones-block');
  const ul = document.getElementById('project-zones');
  if (!block || !ul) return [];
  const launcherState = _deps.getLauncherState();
  if (!launcherState.currentProject || launcherState.browseOnly || !bridgeOnline()) { block.style.display = 'none'; return []; }
  let zones = [];
  try { const r = await bridgeCall('project.zones', {}); zones = (r && r.zones) || []; }
  catch { block.style.display = 'none'; return []; }
  const currentZoneUrl = _deps.getCurrentZoneUrl();
  ul.innerHTML = '';
  block.style.display = zones.length ? '' : 'none';
  for (const z of zones) {
    const path = z.zone || '';
    if (!path) continue;
    const li = document.createElement('li');
    li.className = 'pz-item' + (path === currentZoneUrl ? ' active' : '');
    li.title = path.replace(/^game\//, '');
    const name = document.createElement('span');
    name.className = 'pz-name';
    name.textContent = zoneNameForPath(path);
    li.appendChild(name);
    if (z.total) {
      const badge = document.createElement('span');
      badge.className = 'pz-count';
      badge.textContent = String(z.total);
      badge.title = `${z.total} change${z.total === 1 ? '' : 's'}`;
      li.appendChild(badge);
    }
    const rmBtn = document.createElement('button');
    rmBtn.className = 'pz-remove';
    rmBtn.textContent = '×';
    rmBtn.title = 'Remove from project';
    rmBtn.onclick = (e) => { e.stopPropagation(); removeZoneFromProject(path); };
    li.appendChild(rmBtn);
    li.onclick = () => goToZone(path);
    li.addEventListener('contextmenu', (e) => _deps.openContextMenu(e, (addItem) => {
      addItem('Remove from project', () => removeZoneFromProject(path));
    }));
    ul.appendChild(li);
  }
  return zones;
}

// ── Zone search ───────────────────────────────────────────────────────────────

export function updateZoneSearch() {
  const zoneSearchEl = document.getElementById('zone-search');
  const zoneSearchResultsEl = document.getElementById('zone-search-results');
  if (!zoneSearchEl || !zoneSearchResultsEl) return;
  const zonesData = _deps.getZonesData();
  const customZonesData = _deps.getCustomZonesData();
  const q = zoneSearchEl.value.trim().toLowerCase();
  zoneSearchResultsEl.innerHTML = '';
  if (!q) return;
  const all = [...zonesData, ...customZonesData];
  const matches = all.filter(z => z.name.toLowerCase().includes(q) || z.path.toLowerCase().includes(q)).slice(0, 25);
  for (const z of matches) {
    const li = document.createElement('li');
    li.className = 'zsr-item';
    li.textContent = z.name;
    li.title = z.path.replace(/^game\//, '');
    li.onclick = async () => {
      if (!await goToZone(z.path)) return;
      zoneSearchEl.value = '';
      zoneSearchResultsEl.innerHTML = '';
    };
    li.addEventListener('contextmenu', (e) => _deps.openContextMenu(e, (addItem) => {
      if (isZonePinned(z.path)) addItem('Unpin zone', () => unpinZone(z.path));
      else addItem('📌 Pin zone', () => pinZone(z.path));
    }));
    zoneSearchResultsEl.appendChild(li);
  }
}

// ── Right-side tabs ───────────────────────────────────────────────────────────

export function setActiveTab(tab) {
  const sideTabsEl = document.getElementById('side-tabs');
  const tabPaneEls = document.querySelectorAll('#panel .tab-pane');
  const _panelEl = document.getElementById('panel');
  if (sideTabsEl) for (const b of sideTabsEl.querySelectorAll('.side-tab')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of tabPaneEls) p.classList.toggle('active', p.dataset.pane === tab);
  saveSetting('activeTab', tab);
  if (_panelEl) _panelEl.setAttribute('data-active-tab', tab);
  if (tab === 'evts') { try { _deps.ensureEventsLoaded(); } catch {} }
}

export function tabForEntry(p) {
  if (!p) return null;
  if (p.isCollisionPrimitive) return 'cols';
  if (p.isSound) return 'sfx';
  if (p.isEffect) return 'vfx';
  if (p.isMarker) return 'mkrs';
  if (p.isTextPlane || p.isTextBaked) return 'text';
  if (p.isSky) return 'sky';
  if (p.isMob) return 'mobs';
  return 'objs';
}

// ── Custom zones ──────────────────────────────────────────────────────────────

export async function refreshCustomZones() {
  if (!bridgeOnline()) return;
  const sel = document.getElementById('zone');
  if (!sel) return;
  try {
    const r = await bridgeCall('zone.list-custom', {});
    sel.querySelector('optgroup[label="ROM10 — CUSTOM"]')?.remove();
    // Prefer the real zone_settings name the bridge resolves; "Zone 507" is a
    // last resort for when the DB is unreachable.
    const customZonesData = (r?.zones || []).map((z) => ({
      id: z.zoneId,
      name: z.name ? `${z.zoneId} — ${z.name}` : `Zone ${z.zoneId}`,
      path: z.datUrl,
      fileId: z.fileId,
    }));
    _deps.setCustomZonesData(customZonesData);
    if (!customZonesData.length) return;
    const grp = document.createElement('optgroup');
    grp.label = 'ROM10 — CUSTOM';
    for (const z of customZonesData) {
      const o = document.createElement('option');
      o.value = z.path; o.textContent = z.name;
      grp.appendChild(o);
    }
    sel.insertBefore(grp, sel.firstChild);
    const currentZoneUrl = _deps.getCurrentZoneUrl();
    if (currentZoneUrl) sel.value = currentZoneUrl;
    _deps.populateFootstepSourceZones();
    _deps.updateDeleteZoneBtn?.();
    renderPinnedZones?.();
    _deps.applyClearCollisionPolicy?.();
  } catch (e) {
    console.warn('[custom zones] fetch failed:', e);
  }
}

export async function populateZones() {
  const sel = document.getElementById('zone');
  if (!sel) return;
  const lastZone = loadSetting('lastZone', '');
  try {
    const zones = await fetch('zones.json').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    _deps.setZonesData(zones);
    sel.innerHTML = '<option value="">---</option>';
    const romOf = (z) => (z.path.match(/game\/(ROM\d*)\//i)?.[1] || 'ROM').toUpperCase();
    const groupOf = (z) => z.group || romOf(z);
    const groupLabel = (g) => g === 'ROM' ? 'ROM (base)' : g;
    // ROM groups by number first, then the two curated groups at the bottom.
    const TAIL = ['Dev / Prototype', 'Rooms'];
    const groups = [...new Set(zones.map(groupOf))].sort((a, b) => {
      const ta = TAIL.indexOf(a), tb = TAIL.indexOf(b);
      if (ta !== -1 || tb !== -1) return (ta === -1 ? -1 : ta) - (tb === -1 ? -1 : tb);
      return (+a.slice(3) || 1) - (+b.slice(3) || 1);
    });
    for (const grp of groups) {
      const og = document.createElement('optgroup');
      og.label = groupLabel(grp);
      for (const z of zones.filter((z) => groupOf(z) === grp)) {
        const o = document.createElement('option');
        o.value = z.path; o.textContent = z.name;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    await refreshCustomZones();
    _deps.populateFootstepSourceZones();
    const customZonesData = _deps.getCustomZonesData();
    const inRetail = lastZone && zones.find((z) => z.path === lastZone);
    const inCustom = lastZone && customZonesData.find((z) => z.path === lastZone);
    if (inRetail || inCustom) {
      sel.value = lastZone;
    } else if (lastZone) {
      sel.value = '';
      const customEl = document.getElementById('custom-dat');
      if (customEl) customEl.value = lastZone.replace(/^game\//, '');
    } else {
      const def = zones.find((z) => z.path.toUpperCase().endsWith('ROM/1/41.DAT'));
      if (def) sel.value = def.path;
    }
  } catch (e) {
    console.error('zones.json not found — run gen_zones.py', e);
    sel.innerHTML = '<option value="game/ROM/1/41.DAT">ROM/1/41 — Lower Jeuno</option>';
  }
  const launcherState = _deps.getLauncherState();
  if (!launcherState.setupGateActive && !launcherState.launcherActive) _deps.loadZone(lastZone || sel.value);
}
