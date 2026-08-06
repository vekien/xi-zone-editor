// subarea.js — building-interior sub-area system extracted from main.js
//
// A zone's shops and buildings are FFXI "sub-areas": each interior lives in a
// SEPARATE DAT that the client swaps in when the player enters a 0x36 trigger
// volume. We enumerate them from the zone's 0x36 section (parsed.subAreas),
// resolve each id to its interior DAT via the backend FTABLE lookup, then load
// + spawn every one at once so they're all visible. Each is a toggleable group
// listed in the Zone panel. Purely a viewer overlay — sub-area geometry isn't
// pickable or editable.

import * as THREE from 'three';

// ── injected dependencies (set via initSubAreas) ──────────────────────────────
let _getZoneRoot, _getParsed, _bridgeCall, _bridgeOnline;
let _parseZone, _getKeyTables, _buildMeshTemplates, _buildTextures;
let _instantiate, _trsMatrix, _isSkyName, _datUrl, _resolveMeshName;
let _updateChangesUI, _setStatus, _goToZone, _xi_confirm;
let _getCamera, _setNavScale, _getCurrentZoneUrl;
let _registerPlacement, _buildObjectList, _uniquePlacementName;

// ── exported state (main.js clears these on zone change) ─────────────────────
export let subAreaGroup = null;
export const subAreaState = new Map();
export const subAreaPlaceholders = new Map();
export let stripInteractions = [];

// "Remove Sub-areas & Zone Lines" link kinds that get stripped on Publish.
const STRIP_KINDS = ['m', 'z'];

/**
 * Wire up sub-area dependencies. Call once during startup.
 */
export function initSubAreas({
  getZoneRoot, getParsed, bridgeCall, bridgeOnline,
  parseZone, getKeyTables, buildMeshTemplates, buildTextures,
  instantiate, trsMatrix, isSkyName, datUrl, resolveMeshName,
  updateChangesUI, setStatus, goToZone, xi_confirm,
  getCamera, setNavScale, getCurrentZoneUrl,
  registerPlacement, buildObjectList, uniquePlacementName,
}) {
  _getZoneRoot        = getZoneRoot;
  _getParsed          = getParsed;
  _bridgeCall         = bridgeCall;
  _bridgeOnline       = bridgeOnline;
  _parseZone          = parseZone;
  _getKeyTables       = getKeyTables;
  _buildMeshTemplates = buildMeshTemplates;
  _buildTextures      = buildTextures;
  _instantiate        = instantiate;
  _trsMatrix          = trsMatrix;
  _isSkyName          = isSkyName;
  _datUrl             = datUrl;
  _resolveMeshName    = resolveMeshName;
  _updateChangesUI    = updateChangesUI;
  _setStatus          = setStatus;
  _goToZone           = goToZone;
  _xi_confirm       = xi_confirm;
  _getCamera          = getCamera;
  _setNavScale        = setNavScale;
  _getCurrentZoneUrl  = getCurrentZoneUrl;
  _registerPlacement  = registerPlacement;
  _buildObjectList    = buildObjectList;
  _uniquePlacementName = uniquePlacementName;

  // DOM event wiring
  document.getElementById('subarea-show')?.addEventListener('click', () => setAllSubAreas(true));
  document.getElementById('subarea-hide')?.addEventListener('click', () => setAllSubAreas(false));
  document.getElementById('subarea-strip')?.addEventListener('click', () => toggleStripInteractions());
}

// Reset exported state — call this during zone change (mirrors what main.js did inline).
export function resetSubAreaState() {
  subAreaGroup = null;
  subAreaState.clear();
  subAreaPlaceholders.clear();
  stripInteractions = [];
}

// Setter for stripInteractions — used by loadChangesFromJson in main.js to restore
// the strip flag from a saved change-set.
export function setStripInteractions(arr) {
  stripInteractions = Array.isArray(arr) ? [...arr] : [];
}

// ── loading ───────────────────────────────────────────────────────────────────

export async function loadSubAreas() {
  renderSubAreaParent(null);
  const subs = _getParsed()?.subAreas || [];
  if (!subs.length) {
    // No interiors of its own → it might BE an interior. Ask the backend which zone owns it.
    renderSubAreaPanel([]);
    if (_bridgeOnline()) {
      const url = _getCurrentZoneUrl();
      try {
        const pr = await _bridgeCall('zone.subareaParent', { zone: url });
        if (pr?.ok && pr.parent) renderSubAreaParent(pr.parent);
      } catch (e) { /* parent lookup is best-effort */ }
    }
    return;
  }
  if (!_bridgeOnline()) {
    renderSubAreaPanel(subs.map((s) => ({ id: s.id, status: 'bridge offline' })));
    return;
  }
  const capturedRoot = _getZoneRoot();

  let resolved;
  try {
    resolved = await _bridgeCall('zone.subareas', { ids: subs.map((s) => s.id) });
  } catch (e) {
    console.warn('[subarea] resolve failed', e);
    renderSubAreaPanel(subs.map((s) => ({ id: s.id, status: 'resolve failed' })));
    return;
  }
  if (_getZoneRoot() !== capturedRoot) return;   // user switched zones while resolving
  const byId = new Map((resolved?.subAreas || []).map((r) => [r.id, r]));

  subAreaGroup = new THREE.Group();
  subAreaGroup.name = 'subareas';
  capturedRoot.add(subAreaGroup);

  const kt = await _getKeyTables();
  for (const s of subs) {
    const r = byId.get(s.id) || {};
    const row = { id: s.id, fileId: r.fileId, dat: r.dat || null, group: null, meshCount: 0, visible: true, status: '' };
    subAreaState.set(s.id, row);
    if (!r.dat) { row.status = 'unregistered'; renderSubAreaPanel([...subAreaState.values()]); continue; }
    try {
      const buf = await fetch(_datUrl('game/' + r.dat)).then((x) => {
        if (!x.ok) throw new Error(`HTTP ${x.status}`);
        return x.arrayBuffer();
      });
      if (_getZoneRoot() !== capturedRoot) return;
      const g = buildSubAreaGroup(_parseZone(buf, kt), s.id, r.dat);
      g.name = `subarea_${s.id}`;
      row.group = g;
      row.meshCount = g.userData.meshCount || 0;
      subAreaGroup.add(g);
      setSubAreaVisible(row, true);   // spawned visible → hide the placeholder shell it replaces
    } catch (e) {
      row.status = 'load error';
      console.warn('[subarea] load', s.id, r.dat, e);
    }
    renderSubAreaPanel([...subAreaState.values()]);   // progressive: rows appear as each loads
  }
  renderSubAreaPanel([...subAreaState.values()]);
  // Interior objects were registered into placements[] above — refresh the Objects panel so
  // they show up (grouped under their "SubRoom 0x…" auto-category).
  _buildObjectList?.();
  syncStripVisual();   // re-hide interiors if a "remove sub-areas" change is active for this zone
}

// Build a THREE.Group for one sub-area DAT (its own meshes + placements, already in this
// zone's world space). Mirrors loadZone's placement loop. PLACED objects are registered as
// real, editable placements (pickable, listed in the Objects panel under a "SubRoom 0x…"
// category, publishable back to this interior DAT via subAreaId/subAreaDat/index identity).
// UNPLACED meshes (rare) stay viewer-only — they have no DAT placement record to edit.
function buildSubAreaGroup(sp, subAreaId, subAreaDat) {
  const { meshes, placements: plc, textures } = sp;
  const tmpl = _buildMeshTemplates(meshes, _buildTextures(textures));
  const group = new THREE.Group();
  const placedNames = new Set();
  let count = 0;
  for (const p of plc) {
    const resolved = _resolveMeshName(p.meshId, meshes);
    if (!resolved) continue;
    placedNames.add(resolved);
    const node = _instantiate(tmpl, resolved);
    node.rotation.order = 'ZYX';
    _trsMatrix(p.pos, p.rot, p.scale).decompose(node.position, node.quaternion, node.scale);
    // Editable interior object: unique display name (deterministic load order) + identity that
    // routes edits to THIS interior DAT. Node stays under `group` so the Zone-panel per-interior
    // show/hide (group.visible) + placeholder-shell swap keep working; ancestor-visibility gating
    // in isWorldPickable means hiding the interior also blocks picking its children.
    node.name = _uniquePlacementName ? _uniquePlacementName(p.meshId) : p.meshId;
    node.userData.placement = { ...p, subAreaId, subAreaDat };   // p carries meshId + DAT-local index
    group.add(node);
    _registerPlacement?.(node);   // pushes into placements[] (isEffect/isSky = false)
    count++;
  }
  for (const name of meshes.keys()) {                  // any unplaced interior mesh (rare) — drop at origin
    if (placedNames.has(name) || _isSkyName(name)) continue;
    const node = _instantiate(tmpl, name);
    node.traverse((o) => { o.raycast = () => {}; });   // viewer-only; never intercept editor clicks
    group.add(node); count++;
  }
  group.userData.meshCount = count;
  return group;
}

// ── panel rendering ───────────────────────────────────────────────────────────

// Render the Zone-panel sub-area list (id, interior DAT, mesh count) with per-row
// show/hide + frame controls. Hidden entirely when the zone has no sub-areas.
function renderSubAreaPanel(rows) {
  const own     = document.getElementById('subarea-own');
  const list    = document.getElementById('subarea-list');
  const countEl = document.getElementById('subarea-count');
  if (!own || !list) return;
  if (!rows.length) { own.style.display = 'none'; list.innerHTML = ''; if (countEl) countEl.textContent = ''; syncSubAreaBlock(); return; }
  own.style.display = '';
  const loaded = rows.filter((r) => r.group).length;
  if (countEl) countEl.textContent = `(${loaded}/${rows.length})`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  list.innerHTML = rows.map((r) => {
    const hex = '0x' + Number(r.id).toString(16);
    const detail = r.group ? `${r.dat} · ${r.meshCount} mesh` : (r.status || r.dat || '—');
    const on = r.group && r.visible !== false;
    const datLink = r.dat ? ' subarea-dat-link' : '';   // clickable → load that interior as its own zone
    return `<li class="subarea-row" data-id="${r.id}">`
      + `<input type="checkbox" class="subarea-vis" ${on ? 'checked' : ''} ${r.group ? '' : 'disabled'} title="Show / hide this interior"/>`
      + `<span class="subarea-id">${hex}</span>`
      + `<span class="subarea-dat${datLink}" title="${r.dat ? esc('Load ' + r.dat) : esc(detail)}">${esc(detail)}</span>`
      + `<button class="subarea-focus" ${r.group ? '' : 'disabled'} title="Frame this interior">◎</button>`
      + `</li>`;
  }).join('');
  list.querySelectorAll('.subarea-row').forEach((li) => {
    const st = subAreaState.get(Number(li.dataset.id));
    if (!st) return;
    li.querySelector('.subarea-dat-link')?.addEventListener('click', async () => {
      const ok = await _xi_confirm('Load SubRoom', `Load this SubRoom?  \`${st.dat}\``, 'Load');
      if (ok) _goToZone('game/' + st.dat);
    });
    if (!st.group) return;
    li.querySelector('.subarea-vis').onchange = (e) => setSubAreaVisible(st, e.target.checked);
    li.querySelector('.subarea-focus').onclick = () => frameObject(st.group);
  });
  syncSubAreaBlock();
}

// When THIS DAT is itself a building interior, show a link back to the zone that owns it
// (reverse 0x36 lookup, backend zone.subareaParent). null hides the parent row.
function renderSubAreaParent(parent) {
  const el = document.getElementById('subarea-parent');
  if (!el) return;
  if (!parent) { el.style.display = 'none'; el.innerHTML = ''; syncSubAreaBlock(); return; }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const name = parent.zoneName || 'parent zone';
  const hex = '0x' + Number(parent.subAreaId || 0).toString(16);
  el.style.display = '';
  el.innerHTML = `<span class="subarea-parent-label" title="This DAT is a building interior (sub-area ${hex}) of ${esc(name)}">`
    + `↰ Interior of <b>${esc(name)}</b> <span class="subarea-parent-dat">${esc(parent.dat || '')}</span></span>`
    + `<button class="subarea-parent-load" title="Open the owning zone">Open</button>`;
  el.querySelector('.subarea-parent-load').onclick = async () => {
    const ok = await _xi_confirm('Open Parent Zone', `Open <b>${esc(name)}</b>?  \`${esc(parent.dat)}\``, 'Open');
    if (ok) _goToZone('game/' + parent.dat);
  };
  syncSubAreaBlock();
}

// The #zone-subareas block shows if EITHER a parent row or the own-interior list is visible.
function syncSubAreaBlock() {
  const block = document.getElementById('zone-subareas');
  const par   = document.getElementById('subarea-parent');
  const own   = document.getElementById('subarea-own');
  if (!block) return;
  const show = (par && par.style.display !== 'none') || (own && own.style.display !== 'none');
  block.style.display = show ? '' : 'none';
}

// ── visibility ────────────────────────────────────────────────────────────────

// Show/hide one interior AND, in lockstep, the main-zone placeholder shell it replaces.
export function setSubAreaVisible(st, visible) {
  if (!st || !st.group) return;
  st.visible = visible;
  st.group.visible = visible;
  const placeholders = subAreaPlaceholders.get(st.id);
  if (placeholders) for (const node of placeholders) node.visible = !visible;
}

export function setAllSubAreas(visible) {
  for (const st of subAreaState.values()) setSubAreaVisible(st, visible);
  document.querySelectorAll('#subarea-list .subarea-vis:not(:disabled)').forEach((cb) => { cb.checked = visible; });
}

// ── strip interactions ────────────────────────────────────────────────────────

// "Remove Sub-areas & Zone Lines" — a tracked, publishable change that strips the
// zone's 0x36 'm' (shop/building swaps) + 'z' (zone-line edge teleports) so a city
// can be templated into a standalone custom zone.

export function stripActive() { return stripInteractions.length > 0; }

export function syncStripVisual() {
  if (stripActive() && subAreaState.size) setAllSubAreas(false);
  const btn = document.getElementById('subarea-strip');
  if (btn) {
    btn.textContent = stripActive() ? 'Restore Sub-areas & Zone Lines' : 'Remove Sub-areas & Zone Lines';
    btn.classList.toggle('active', stripActive());
  }
}

export function toggleStripInteractions() {
  if (stripActive()) {
    stripInteractions = [];
    setAllSubAreas(true);
    syncStripVisual();
    _updateChangesUI();
    _setStatus('Sub-areas + zone lines kept.');
  } else {
    stripInteractions = [...STRIP_KINDS];
    syncStripVisual();
    _updateChangesUI();
    _setStatus('Sub-areas + zone lines will be removed on Publish (tracked as a change).');
  }
}

// ── framing ───────────────────────────────────────────────────────────────────

// Frame the camera on one object's bounding box (mirrors frameScene's placement math).
function frameObject(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.7 || 20;
  _setNavScale(radius);
  const camera = _getCamera();
  camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.9, radius));
  camera.lookAt(center);
  camera.near = Math.max(radius / 500, 0.1);
  camera.far = radius * 200;
  camera.updateProjectionMatrix();
}
