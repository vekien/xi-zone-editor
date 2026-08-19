// ── core/object-list.js ──────────────────────────────────────────────────────
// Object-list panel, category management, group management, hotkeys bar,
// and bulk-visibility helpers — extracted from main.js.
//
// Call initObjectList(refs) once after DOM and placements are available.
//
// All mutable main.js state is accessed via _R (set by initObjectList).

import * as THREE from 'three';
import { vfxBaseName, newGroupId, newHotkeyId } from '../editor/utils.js';
import { loadZoneSetting, saveZoneSetting, removeZoneSetting } from '../editor/settings.js';
import { scheduleAutoSave } from '../editor/auto-save.js';
import { isSkyName } from '../ffxi/zone.js';

let _R = {};
export function initObjectList(refs) { _R = refs; }

// ── Visibility helpers (shared with restoreVisibilityOverrides) ───────────────

export function defaultVisibilityFor(p) {
  if (p.isSound) return true;
  if (p.isEffect && p.node.userData.defaultVisible !== undefined) return p.node.userData.defaultVisible;
  return !p.isEffect;
}
export function visibilityKeyFor(p) {
  return p.isEffect ? `vfx:${p.node.userData.effect?.sectionId || p.name}` : `object:${p.name}`;
}
export function setVisibilityOverride(p, visible) {
  const url = _R.getCurrentZoneUrl();
  const overrides = { ...(loadZoneSetting(url, 'visibility') || {}) };
  const key = visibilityKeyFor(p);
  if (visible === defaultVisibilityFor(p)) delete overrides[key];
  else overrides[key] = visible;
  if (Object.keys(overrides).length) saveZoneSetting(url, 'visibility', overrides);
  else removeZoneSetting(url, 'visibility');
  scheduleAutoSave();
}
export function restoreVisibilityOverrides(url) {
  const overrides = loadZoneSetting(url, 'visibility') || {};
  for (const p of _R.getPlacements()) {
    const key = visibilityKeyFor(p);
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    const vis = !!overrides[key];
    if (p.isSound) { _R.setIconVisible(p.node, vis); }
    else { p.node.visible = vis; if (p.isEffect) _R.setIconVisible(p.node, vis); }
  }
}

function setLockOverride(p, locked) {
  const url = _R.getCurrentZoneUrl();
  const overrides = { ...(loadZoneSetting(url, 'locks') || {}) };
  const key = visibilityKeyFor(p);
  if (locked) overrides[key] = true;
  else delete overrides[key];
  if (Object.keys(overrides).length) saveZoneSetting(url, 'locks', overrides);
  else removeZoneSetting(url, 'locks');
  scheduleAutoSave();
}
export function restoreLockOverrides(url) {
  const overrides = loadZoneSetting(url, 'locks') || {};
  for (const p of _R.getPlacements()) {
    p.node.userData.locked = !!overrides[visibilityKeyFor(p)];
    if (_R.isInitAnchor(p)) p.node.visible = false;
  }
}

// ── Placement Groups ──────────────────────────────────────────────────────────
const GROUP_COLORS = ['#4fc3f7','#81c784','#ffb74d','#f06292','#ce93d8','#80cbc4','#fff176','#ff8a65','#ef9a9a','#a5d6a7'];
function groupKeyFor(p) { return p.node.userData.xiId || p.name; }
export function groupForPlacement(p) { const k = groupKeyFor(p); return _R.getPlacementGroups().find(g => g.members.includes(k)) || null; }
export function placementsInGroup(groupId) { const g = _R.getPlacementGroups().find(g => g.id === groupId); return g ? _R.getPlacements().filter(p => g.members.includes(groupKeyFor(p))) : []; }
function nextGroupColor() { const used = new Set(_R.getPlacementGroups().map(g => g.color)); return GROUP_COLORS.find(c => !used.has(c)) || GROUP_COLORS[_R.getPlacementGroups().length % GROUP_COLORS.length]; }

function saveGroups() {
  const url = _R.getCurrentZoneUrl();
  if (url) { saveZoneSetting(url, 'groups', _R.getPlacementGroups()); scheduleAutoSave(); }
}
export function restoreGroups(url) {
  const saved = loadZoneSetting(url, 'groups');
  _R.setPlacementGroups(Array.isArray(saved) ? saved : []);
}
function createGroup(members) {
  const groups = _R.getPlacementGroups();
  const keys = members.map(groupKeyFor);
  for (const g of groups) g.members = g.members.filter(k => !keys.includes(k));
  _R.setPlacementGroups(groups.filter(g => g.members.length > 0));
  _R.getPlacementGroups().push({ id: newGroupId(), name: `Group ${_R.getPlacementGroups().length + 1}`, color: nextGroupColor(), members: keys });
  saveGroups();
  buildObjectList();
}
function removeFromGroup(p) {
  const k = groupKeyFor(p);
  const groups = _R.getPlacementGroups();
  for (const g of groups) g.members = g.members.filter(m => m !== k);
  _R.setPlacementGroups(groups.filter(g => g.members.length > 0));
  saveGroups();
  buildObjectList();
}
function dissolveGroup(groupId) {
  _R.setPlacementGroups(_R.getPlacementGroups().filter(g => g.id !== groupId));
  saveGroups();
  buildObjectList();
}
export function autoGroupXiEffects() {
  const xi = _R.getPlacements().filter(p => {
    if (!p.isEffect) return false;
    const sid = p.node.userData.effect?.sectionId;
    return sid && /^x[a-zA-Z]{2}[0-9A-Za-z]$/.test(sid);
  });
  const buckets = new Map();
  for (const p of xi) {
    const sid = p.node.userData.effect.sectionId;
    const key = sid[0] + sid[1] + sid[3];
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }
  let changed = false;
  for (const [key, members] of buckets) {
    if (members.length < 2) continue;
    const existing = groupForPlacement(members[0]);
    if (existing && members.every(p => groupForPlacement(p)?.id === existing.id)) continue;
    const keys = members.map(groupKeyFor);
    const groups = _R.getPlacementGroups();
    for (const g of groups) g.members = g.members.filter(k => !keys.includes(k));
    _R.setPlacementGroups(groups.filter(g => g.members.length > 0));
    _R.getPlacementGroups().push({ id: newGroupId(), name: key, color: nextGroupColor(), members: keys });
    changed = true;
  }
  if (changed) saveGroups();
  return changed;
}
function renameGroup(groupId, newName) {
  newName = (newName || '').trim();
  if (!newName) return false;
  const g = _R.getPlacementGroups().find(g => g.id === groupId);
  if (!g || g.name === newName) return false;
  g.name = newName;
  saveGroups();
  buildObjectList();
  return true;
}

// ── "Manage Groups" modal ─────────────────────────────────────────────────────
function openManageGroupsModal() {
  const groups = _R.getPlacementGroups();
  if (!groups.length) { _R.setStatus('No groups to manage'); return; }
  const modal = document.getElementById('manage-groups-modal');
  const sel = document.getElementById('mg-select');
  const nameIn = document.getElementById('mg-name');
  const err = document.getElementById('mg-error');
  sel.innerHTML = '';
  for (const g of groups) {
    const o = document.createElement('option'); o.value = g.id; o.textContent = `${g.name} (${g.members.length})`;
    sel.appendChild(o);
  }
  const syncName = () => { const g = groups.find(g => g.id === sel.value); nameIn.value = g ? g.name : ''; if (err) err.hidden = true; };
  sel.onchange = syncName;
  syncName();
  _R.openModal(modal, null);
  setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
}
export function saveManageGroups() {
  const sel = document.getElementById('mg-select');
  const nameIn = document.getElementById('mg-name');
  const err = document.getElementById('mg-error');
  const g = _R.getPlacementGroups().find(g => g.id === sel.value);
  if (!g) return;
  const name = (nameIn.value || '').trim();
  if (!name) { if (err) { err.textContent = 'Enter a group name.'; err.hidden = false; } return; }
  renameGroup(g.id, name);
  if (err) err.hidden = true;
  document.getElementById('manage-groups-modal')?.classList.remove('open');
  _R.setStatus(`Group renamed to "${name}"`);
}

// ── List Categories ───────────────────────────────────────────────────────────
const CAT_ALPHA = 'Alpha Meshes', CAT_CUSTOM = 'Custom Meshes', CAT_ZONE = 'Zone Meshes';
const CAT_UNCAT = 'Uncategorized';

function autoObjs(p) {
  const pl = p.node?.userData?.placement;
  // Building-interior objects group under a per-sub-area header (edits publish to that interior DAT).
  if (pl?.subAreaId != null) return `SubRoom 0x${Number(pl.subAreaId).toString(16)}`;
  const nm = pl?.meshId || p.name || '';
  if (nm[0] === '_') return CAT_ALPHA;
  if (nm.startsWith('xi_')) return CAT_CUSTOM;
  return CAT_ZONE;
}
function autoVfx(p) { return vfxBaseName(p) || 'Effects'; }
const CATEGORY_KINDS = {
  objs:    { auto: autoObjs, defaults: [CAT_CUSTOM, CAT_ZONE, CAT_ALPHA] },
  vfx:     { auto: autoVfx,  defaults: [] },
  sfx:     { auto: () => 'Zone Sounds', defaults: ['Zone Sounds'] },
  markers: { auto: null, defaults: [] },
  text:    { auto: null, defaults: [] },
  sky:     { auto: () => 'Zone Sky Meshes', defaults: ['Zone Sky Meshes'] },
  mobs:    { auto: null, defaults: [] },
  cols:    { auto: null, defaults: [] },
};
let categorySets = {};
function catSet(kind) { return categorySets[kind] || (categorySets[kind] = { order: [], assign: {}, collapsed: [] }); }
export function kindOf(p) {
  if (!p) return null;
  if (p.isCollisionPrimitive) return 'cols';
  if (p.isMob) return 'mobs';
  if (p.isSky) return 'sky';
  if (p.isMarker) return 'markers';
  if (p.isSound) return 'sfx';
  if (p.isEffect) return 'vfx';
  if (p.isTextPlane) return 'text';
  if (p.isTextBaked) return null;
  return 'objs';
}
function kindSupportsCategories(kind) { return !!kind && kind in CATEGORY_KINDS; }
function catKeyFor(p) {
  return p.node.userData.xiId
    || (p.isEffect ? `fx:${p.node.userData.effect?.sectionId ?? p.name}` : null)
    || p.name;
}
function autoCategoryForKind(kind, p) { const fn = CATEGORY_KINDS[kind]?.auto; return fn ? fn(p) : null; }
function categoryForItem(kind, p) {
  const set = catSet(kind);
  return set.assign[catKeyFor(p)] || autoCategoryForKind(kind, p) || CAT_UNCAT;
}
function kindIsSectioned(kind) {
  const set = catSet(kind);
  return !!CATEGORY_KINDS[kind]?.auto || set.order.length > 0 || Object.keys(set.assign).length > 0;
}
function orderedCategoryNamesForKind(kind, present) {
  const set = catSet(kind), s = new Set(present), out = [], seen = new Set();
  const push = (n) => { if (s.has(n) && !seen.has(n) && n !== CAT_UNCAT) { seen.add(n); out.push(n); } };
  for (const n of set.order) push(n);
  for (const n of (CATEGORY_KINDS[kind]?.defaults || [])) push(n);
  for (const n of [...present].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) push(n);
  if (s.has(CAT_UNCAT)) out.push(CAT_UNCAT);
  return out;
}
function knownCategoryNamesForKind(kind, items) {
  const set = catSet(kind), present = new Set(set.order);
  for (const p of items) present.add(categoryForItem(kind, p));
  present.delete(CAT_UNCAT);
  return orderedCategoryNamesForKind(kind, [...present]);
}
function listItemsForKind(kind) { return _R.getPlacements().filter((p) => kindOf(p) === kind); }
function categorySetHasState(set) { return Object.keys(set.assign).length > 0 || set.order.length > 0 || set.collapsed.length > 0; }
function isCategoryCollapsed(kind, name) { return catSet(kind).collapsed.includes(name); }
function toggleCategoryCollapse(kind, name) {
  const set = catSet(kind);
  if (set.collapsed.includes(name)) set.collapsed = set.collapsed.filter((n) => n !== name);
  else set.collapsed.push(name);
  saveCategories();
  buildObjectList();
}
function serializeCategorySets() {
  const out = {};
  for (const [kind, set] of Object.entries(categorySets)) if (categorySetHasState(set)) out[kind] = set;
  return out;
}
function saveCategories() {
  const url = _R.getCurrentZoneUrl();
  if (!url) return;
  const out = serializeCategorySets();
  if (Object.keys(out).length) saveZoneSetting(url, 'categorySets', out);
  else removeZoneSetting(url, 'categorySets');
  scheduleAutoSave();
}
export function restoreCategories(url) {
  const raw = loadZoneSetting(url, 'categorySets') || legacyCategorySets(loadZoneSetting(url, 'categories'));
  categorySets = normalizeCategorySets(raw);
}
function legacyCategorySets(oldObjsCats) { return oldObjsCats ? { objs: oldObjsCats } : null; }
function normalizeCatSet(set) {
  return {
    order: Array.isArray(set?.order) ? set.order.filter((n) => typeof n === 'string') : [],
    assign: (set && typeof set.assign === 'object' && set.assign) ? { ...set.assign } : {},
    collapsed: Array.isArray(set?.collapsed) ? set.collapsed.filter((n) => typeof n === 'string') : [],
  };
}
function normalizeCategorySets(raw) {
  const out = {};
  if (raw && typeof raw === 'object') for (const [kind, set] of Object.entries(raw)) out[kind] = normalizeCatSet(set);
  return out;
}
export function setsHaveState(raw) {
  return !!raw && typeof raw === 'object' && Object.values(raw).some((s) =>
    s && ((s.assign && Object.keys(s.assign).length) || (s.order && s.order.length) || (s.collapsed && s.collapsed.length)));
}
function assignItemsToCategory(kind, targets, name) {
  name = (name || '').trim();
  if (!name || !kindSupportsCategories(kind)) return;
  const set = catSet(kind);
  for (const t of targets) if (kindOf(t) === kind) set.assign[catKeyFor(t)] = name;
  if (!set.order.includes(name)) set.order.push(name);
  saveCategories();
  buildObjectList();
}
function resetItemsCategory(kind, targets) {
  const set = catSet(kind); let changed = false;
  for (const t of targets) { const k = catKeyFor(t); if (k in set.assign) { delete set.assign[k]; changed = true; } }
  if (changed) { saveCategories(); buildObjectList(); }
}
function itemsForCategoryAction(kind, p) {
  const selectedSet = _R.getSelectedSet();
  const sel = [...selectedSet].filter((q) => kindOf(q) === kind);
  return (sel.length > 1 && selectedSet.has(p)) ? sel : [p];
}

// ── "Add to Category" modal ───────────────────────────────────────────────────
let _catModalKind = 'objs', _catModalTargets = [];
function openCategoryModal(kind, targets) {
  _catModalKind = kind;
  _catModalTargets = (targets || []).filter((t) => kindOf(t) === kind);
  if (!_catModalTargets.length) return;
  const modal = document.getElementById('category-modal');
  const sel = document.getElementById('cat-existing');
  const newIn = document.getElementById('cat-new');
  const err = document.getElementById('cat-error');
  const note = document.getElementById('cat-target-note');
  const names = knownCategoryNamesForKind(kind, listItemsForKind(kind));
  const cur = new Set(_catModalTargets.map((t) => categoryForItem(kind, t)));
  const current = cur.size === 1 ? [...cur][0] : '';
  sel.innerHTML = '';
  if (!names.length) {
    const o = document.createElement('option'); o.value = ''; o.textContent = '(no categories yet)'; o.disabled = true; sel.appendChild(o);
  }
  for (const n of names) {
    const o = document.createElement('option'); o.value = n; o.textContent = n;
    if (n === current) o.selected = true;
    sel.appendChild(o);
  }
  if (note) note.textContent = _catModalTargets.length > 1
    ? `Assigning ${_catModalTargets.length} items.`
    : `Assigning "${_catModalTargets[0].name}".`;
  newIn.value = '';
  if (err) { err.hidden = true; err.textContent = ''; }
  _R.openModal(modal, null);
  setTimeout(() => newIn.focus(), 0);
}
export function applyCategoryModal() {
  const sel = document.getElementById('cat-existing');
  const newIn = document.getElementById('cat-new');
  const err = document.getElementById('cat-error');
  const name = (newIn.value.trim()) || (sel.value || '');
  if (!name) { if (err) { err.textContent = 'Type a new category name or pick an existing one.'; err.hidden = false; } return; }
  assignItemsToCategory(_catModalKind, _catModalTargets, name);
  document.getElementById('category-modal')?.classList.remove('open');
}

// ── Hotkeys ───────────────────────────────────────────────────────────────────
let hotkeys = [];
const hotkeyBarEl = document.getElementById('hotkey-bar');
const _hkThumbCache = new Map();
let _hkThumbRenderer = null;

function saveHotkeys() {
  const url = _R.getCurrentZoneUrl();
  if (url) { saveZoneSetting(url, 'hotkeys', hotkeys); scheduleAutoSave(); }
}
export function restoreHotkeys(url) {
  const saved = loadZoneSetting(url, 'hotkeys');
  hotkeys = Array.isArray(saved) ? saved : [];
  _hkThumbCache.clear();
}
function hotkeyKeyFor(p) { return p.node.userData.xiId || p.node.userData.placement?.meshId || p.name; }
function hotkeyHasObject(p) { const k = hotkeyKeyFor(p); return hotkeys.some(h => h.key === k); }

function addHotkey(p) {
  const meshId = p.node.userData.placement?.meshId;
  if (!meshId) { _R.setStatus('hotkey: select a placed object first'); return; }
  const key = hotkeyKeyFor(p);
  if (hotkeys.some(h => h.key === key)) { _R.setStatus('already on the hotkey bar'); return; }
  const n = p.node;
  hotkeys.push({
    id: newHotkeyId(), key, meshId, xiId: n.userData.xiId,
    name: _R.xiName(meshId),
    rot: [n.rotation.x, n.rotation.y, n.rotation.z],
    scale: [n.scale.x, n.scale.y, n.scale.z],
    glb: _R.lightGlbRef(n) || undefined,
    sourceZone: n.userData.sourceZone, sourceName: n.userData.sourceName,
  });
  saveHotkeys();
  renderHotkeyBar();
  _R.setStatus(`added "${_R.xiName(meshId)}" to hotkeys`);
}

function removeHotkey(id) {
  hotkeys = hotkeys.filter(h => h.id !== id);
  saveHotkeys();
  renderHotkeyBar();
}

function findHotkeySource(h) {
  const eligible = (p) => !p.isEffect && !p.isMarker && !p.isMob && !p.isSound && p.node.userData.placement?.meshId;
  return _R.getPlacements().find(p => eligible(p) && hotkeyKeyFor(p) === h.key)
      || _R.getPlacements().find(p => eligible(p) && p.node.userData.placement.meshId === h.meshId)
      || null;
}

const _hkSurfacePred = (h) => _R.getPlacementSet().has(h.object.parent ?? h.object) ||
  h.object.parent?.userData?.zoneMesh || h.object.userData?.zoneMesh;
function inViewport(worldPoint) {
  const camera = _R.getCamera();
  const ndc = worldPoint.clone().project(camera);
  return ndc.z < 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
}
export function groundPointAhead() {
  const camera = _R.getCamera();
  const raycaster = _R.getRaycaster();
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const fwd = raycaster.intersectObject(_R.getZoneRoot(), true).filter(_hkSurfacePred);
  if (fwd.length) return fwd[0].point.clone();
  const front = raycaster.ray.at(30, new THREE.Vector3());
  const downRay = new THREE.Raycaster(front.clone().setY(front.y + 50), new THREE.Vector3(0, -1, 0), 0, 4000);
  downRay.camera = camera;
  const down = downRay.intersectObject(_R.getZoneRoot(), true).filter(_hkSurfacePred);
  if (down.length && inViewport(down[0].point)) return down[0].point.clone();
  return front;
}

export function spawnHotkey(h) {
  if (!_R.getEditMode()) { _R.setStatus('Switch to Edit mode to spawn objects', true); return; }
  if (!_R.getZoneRoot()) { _R.setStatus('load a zone first'); return; }
  const dropLocal = _R.getZoneRoot().worldToLocal(groundPointAhead());

  const src = findHotkeySource(h);
  let node = null;
  if (src) {
    const s = src.node;
    node = s.clone(true);
    node.rotation.order = 'ZYX';
    node.position.copy(dropLocal);
    node.quaternion.copy(s.quaternion);
    node.scale.copy(s.scale);
    node.name = _R.uniquePlacementName(_R.xiName(h.meshId));
    node.userData = { placement: { ...s.userData.placement, meshId: h.meshId },
      addName: s.userData.addName ?? h.meshId, xiId: s.userData.xiId };
    const glbRef = _R.lightGlbRef(s);
    if (glbRef) node.userData.glbImport = glbRef;
    if (s.userData.sourceZone) { node.userData.sourceZone = s.userData.sourceZone; node.userData.sourceName = s.userData.sourceName; }
  } else if (_R.getTemplates() && _R.getTemplates().has(h.meshId)) {
    node = _R.instantiate(_R.getTemplates(), h.meshId);
    node.rotation.order = 'ZYX';
    node.position.copy(dropLocal);
    node.rotation.set(...(Array.isArray(h.rot) ? h.rot : [0, 0, 0]));
    node.scale.set(...(Array.isArray(h.scale) ? h.scale : [1, 1, 1]));
    node.name = _R.uniquePlacementName(_R.xiName(h.meshId));
    node.userData = { placement: { meshId: h.meshId }, addName: h.meshId, xiId: h.xiId };
    if (h.glb) node.userData.glbImport = h.glb;
    if (h.sourceZone) { node.userData.sourceZone = h.sourceZone; node.userData.sourceName = h.sourceName; }
  } else {
    _R.setStatus(`hotkey: mesh "${h.meshId}" isn't in this zone`, true); return;
  }
  node.updateMatrix();
  node.userData.original = { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() };
  const entry = { node, name: node.name, isEffect: false };
  _R.commitPastedItems([{ node, entry, parent: _R.getZoneRoot() }], `spawned "${_R.xiName(h.meshId)}"`);
}

function hotkeyThumbnail(h) {
  const cacheKey = h.xiId || h.meshId;
  if (_hkThumbCache.has(cacheKey)) return _hkThumbCache.get(cacheKey);
  let url = null;
  try { url = renderMeshThumbnail(h); } catch (e) { console.warn('[hotkey] thumbnail failed', e); }
  if (url) _hkThumbCache.set(cacheKey, url);
  return url;
}

function renderMeshThumbnail(h) {
  const src = findHotkeySource(h);
  let obj = null;
  if (src) obj = src.node.clone(true);
  else if (_R.getTemplates() && _R.getTemplates().has(h.meshId)) obj = _R.instantiate(_R.getTemplates(), h.meshId);
  if (!obj) return null;

  const SIZE = 96;
  if (!_hkThumbRenderer) {
    _hkThumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    _hkThumbRenderer.setSize(SIZE, SIZE);
    _hkThumbRenderer.setClearAlpha(0);
  }
  const r = _hkThumbRenderer;
  const scn = new THREE.Scene();
  const root = new THREE.Group();
  const zoneRoot = _R.getZoneRoot();
  if (zoneRoot) { root.quaternion.copy(zoneRoot.quaternion); root.scale.copy(zoneRoot.scale); }
  root.add(obj);
  scn.add(root);
  scn.add(new THREE.AmbientLight(0xffffff, 0.95));
  const dl = new THREE.DirectionalLight(0xffffff, 0.55); dl.position.set(1, 2, 1.5); scn.add(dl);
  scn.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return null;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const center = sphere.center, radius = sphere.radius || 1;
  const fov = 35;
  const cam = new THREE.PerspectiveCamera(fov, 1, Math.max(0.01, radius * 0.05), radius * 50);
  const dir = new THREE.Vector3(0.85, 0.6, 1).normalize();
  const dist = radius / Math.sin((fov * Math.PI / 180) / 2) * 1.15;
  cam.position.copy(center.clone().add(dir.multiplyScalar(dist)));
  cam.lookAt(center);

  r.render(scn, cam);
  return r.domElement.toDataURL('image/png');
}

export function renderHotkeyBar() {
  if (!hotkeyBarEl) return;
  hotkeyBarEl.innerHTML = '';
  if (!hotkeys.length) { hotkeyBarEl.hidden = true; return; }
  hotkeyBarEl.hidden = false;
  for (const h of hotkeys) {
    const chip = document.createElement('button');
    chip.className = 'hotkey-chip';
    chip.title = `Spawn "${h.name}" in front of the camera`;
    chip.onclick = () => spawnHotkey(h);

    const rm = document.createElement('span');
    rm.className = 'hk-remove';
    rm.textContent = '×';
    rm.title = 'Remove from hotkeys';
    rm.onclick = (e) => { e.stopPropagation(); removeHotkey(h.id); };

    const thumb = document.createElement('div');
    thumb.className = 'hk-thumb';
    const dataUrl = hotkeyThumbnail(h);
    if (dataUrl) { const img = document.createElement('img'); img.src = dataUrl; img.alt = h.name; thumb.appendChild(img); }
    else { const ic = document.createElement('span'); ic.className = 'material-symbols-outlined'; ic.textContent = 'deployed_code'; thumb.appendChild(ic); }

    const label = document.createElement('div');
    label.className = 'hk-name';
    label.textContent = h.name;

    chip.appendChild(rm);
    chip.appendChild(thumb);
    chip.appendChild(label);
    hotkeyBarEl.appendChild(chip);
  }
}

export function applyWorkspaceViewState(changes) {
  const url = _R.getCurrentZoneUrl();
  const incomingCats = changes?.categorySets || (changes?.categories ? { objs: changes.categories } : null);
  if (incomingCats && setsHaveState(incomingCats)) {
    categorySets = normalizeCategorySets(incomingCats);
    saveZoneSetting(url, 'categorySets', serializeCategorySets());
    buildObjectList();
  }
  const visibility = changes?.visibility || {};
  const locks = changes?.locks || {};
  const hasVis = Object.keys(visibility).length > 0;
  const hasLocks = Object.keys(locks).length > 0;
  if (!hasVis && !hasLocks) return;
  for (const p of _R.getPlacements()) {
    const key = visibilityKeyFor(p);
    if (hasVis && Object.prototype.hasOwnProperty.call(visibility, key)) {
      const vis = !!visibility[key];
      if (p.isSound) { _R.setIconVisible(p.node, vis); }
      else { p.node.visible = vis; if (p.isEffect) _R.setIconVisible(p.node, vis); }
    }
    if (hasLocks) p.node.userData.locked = !!locks[key];
    if (_R.isInitAnchor(p)) p.node.visible = false;
  }
  if (hasVis) saveZoneSetting(url, 'visibility', visibility);
  if (hasLocks) saveZoneSetting(url, 'locks', locks);
  else removeZoneSetting(url, 'locks');
  buildObjectList();
}

// ── Context menu ──────────────────────────────────────────────────────────────
const rowContextMenu = document.createElement('div');
rowContextMenu.id = 'row-context-menu';
rowContextMenu.className = 'row-context-menu';
Object.assign(rowContextMenu.style, {
  position: 'fixed',
  zIndex: '10000',
  display: 'none',
});
document.body.appendChild(rowContextMenu);
export function hideRowContextMenu() { rowContextMenu.classList.remove('open'); rowContextMenu.style.display = 'none'; rowContextMenu.innerHTML = ''; }
export function openContextMenu(e, buildItems) {
  e.preventDefault();
  e.stopPropagation();
  hideRowContextMenu();
  const addItem = (label, action, opts = {}) => {
    const btn = document.createElement('button');
    if (opts.icon) {
      const ic = document.createElement('span');
      ic.className = 'material-symbols-outlined ctx-ico';
      ic.textContent = opts.icon;
      btn.appendChild(ic);
    }
    btn.appendChild(document.createTextNode(label));
    if (opts.danger) btn.style.color = '#f07070';
    else if (opts.color) btn.style.color = opts.color;
    if (opts.disabled) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.style.cursor = 'default';
    } else {
      btn.onclick = () => { hideRowContextMenu(); action(); };
    }
    rowContextMenu.appendChild(btn);
  };
  const addDivider = () => {
    const div = document.createElement('div');
    div.className = 'divider';
    rowContextMenu.appendChild(div);
  };
  buildItems(addItem, addDivider);
  rowContextMenu.style.left = `${e.clientX}px`;
  rowContextMenu.style.top = `${e.clientY}px`;
  rowContextMenu.style.display = 'block';
  rowContextMenu.classList.add('open');
  const _r = rowContextMenu.getBoundingClientRect();
  if (_r.right  > window.innerWidth)  rowContextMenu.style.left = `${Math.max(0, e.clientX - _r.width)}px`;
  if (_r.bottom > window.innerHeight) rowContextMenu.style.top  = `${Math.max(0, e.clientY - _r.height)}px`;
}

let clipboardTransform = null;

function addObjectContextItems(p, addItem, addDivider) {
  if (_R.isInitAnchor(p)) { addItem('🔒 Protected anchor (xi_init)', () => {}, { disabled: true }); return; }
  const selectedSet = _R.getSelectedSet();
  const _bulk = selectedSet.has(p) && selectedSet.size > 1;
  const _vlTargets = _bulk ? [...selectedSet].filter((t) => !_R.isInitAnchor(t)) : [p];
  addItem(_bulk ? `Toggle Visibility (${_vlTargets.length})` : 'Toggle Visibility', () => {
    const vis = p.isSound ? !_R.iconVisible(p.node) : !p.node.visible;
    for (const t of _vlTargets) {
      if (t.isSound) { _R.setIconVisible(t.node, vis); setVisibilityOverride(t, vis); }
      else {
        t.node.visible = vis;
        setVisibilityOverride(t, t.node.visible);
        if (t.isEffect) _R.setIconVisible(t.node, t.node.visible);
      }
    }
    buildObjectList();
    _R.updateSelectionOutline();
  }, { icon: 'visibility' });
  addItem(_bulk ? `Toggle Lock (${_vlTargets.length})` : 'Toggle Lock', () => {
    const locked = !_R.isLocked(p);
    for (const t of _vlTargets) {
      t.node.userData.locked = locked;
      setLockOverride(t, locked);
    }
    const selected = _R.getSelected();
    if (selected) { if (_R.isLocked(selected)) _R.transform.detach(); else _R.transform.attach(selected.node); }
    buildObjectList();
    _R.rebuildSelectionOutline();
    _R.updateSelectionReadout();
    _R.updateSelectionOutline();
  }, { icon: 'lock' });
  if (p.isSound) {
    const sid = p.node.userData.effect?.soundId;
    addItem('Play Sound', () => _R.playSound(p), { disabled: sid == null });
    addItem('Stop Sound', () => _R.stopSound(), { disabled: !_R.isSfxStoppable() });
  }
  if (p.node.userData?.textPlane) addItem('Edit Text…', () => { _R.select(p); _R.updateGlbDetailsPanel(); _R.tpText?.focus(); }, { disabled: !_R.getEditMode() });
  if (!p.isCollisionPrimitive && !p.isEffect && !p.isMarker && !p.isSky) {
    if (addDivider) addDivider();
    if (p.node.userData?.glbImport) addItem('Refresh GLB from disk', () => _R.refreshGlbModel(p), { disabled: !_R.getEditMode(), color: '#f5dd88', icon: 'frame_reload' });
    const eligibleSel = [...selectedSet].filter((e) => !e.isCollisionPrimitive && !e.isEffect && !e.isMarker && !e.isSky);
    const multi = eligibleSel.length > 1;
    const label = multi ? `Create Collision from Selection (${eligibleSel.length})` : 'Create Collision from Mesh';
    addItem(label, () => _R.createCollisionFromMesh(multi ? eligibleSel : p), { disabled: !_R.getEditMode(), color: '#f5dd88', icon: 'deployed_code' });
  }
  {
    const rightClickInGroup = groupForPlacement(p);
    const selForGroup = [...selectedSet].filter(q => !q.isEffect && !q.isMarker && !q.isSky && !q.isCollisionPrimitive);
    const allInSameGroup = selForGroup.length >= 2 && rightClickInGroup && selForGroup.every(q => groupForPlacement(q)?.id === rightClickInGroup.id);
    const showGroup = selForGroup.length >= 2 && !allInSameGroup;
    const showAddTo = !rightClickInGroup && selForGroup.length <= 1 && _R.getPlacementGroups().length > 0;
    if (showGroup || rightClickInGroup || showAddTo) {
      if (addDivider) addDivider();
      if (_R.getPlacementGroups().length > 0) addItem('Manage Groups…', () => openManageGroupsModal(), { icon: 'circle_circle' });
      if (showGroup) addItem(`Group Selection (${selForGroup.length})`, () => createGroup(selForGroup), { icon: 'circle_circle' });
      if (rightClickInGroup) {
        addItem(`Remove from "${rightClickInGroup.name}"`, () => removeFromGroup(p), { icon: 'circle_circle' });
        addItem(`Dissolve "${rightClickInGroup.name}"`, () => dissolveGroup(rightClickInGroup.id), { icon: 'circle_circle' });
      }
      if (showAddTo) {
        for (const g of _R.getPlacementGroups()) {
          addItem(`Add to "${g.name}"`, () => { if (!g.members.includes(groupKeyFor(p))) { g.members.push(groupKeyFor(p)); saveGroups(); buildObjectList(); } }, { icon: 'circle_circle' });
        }
      }
    }
  }
  {
    const catKind = kindOf(p);
    if (kindSupportsCategories(catKind)) {
      if (addDivider) addDivider();
      const catTargets = itemsForCategoryAction(catKind, p);
      const n = catTargets.length;
      addItem(n > 1 ? `Add to Category… (${n})` : 'Add to Category…', () => openCategoryModal(catKind, catTargets), { color: '#8fe0e8', icon: 'bookmark_stacks' });
      const set = catSet(catKind);
      if (catTargets.some((t) => catKeyFor(t) in set.assign)) {
        addItem('Reset Category — Auto', () => resetItemsCategory(catKind, catTargets));
      }
    }
  }
  if (!p.isEffect && !p.isMarker && !p.isSky && !p.isSound && !p.isMob && !p.isCollisionPrimitive && p.node.userData.placement?.meshId) {
    if (addDivider) addDivider();
    if (hotkeyHasObject(p)) addItem('Remove from Hotkey', () => { const h = hotkeys.find(h => h.key === hotkeyKeyFor(p)); if (h) removeHotkey(h.id); }, { color: '#8fe0e8', icon: 'animated_images' });
    else addItem('Add to Hotkey', () => addHotkey(p), { color: '#8fe0e8', icon: 'animated_images' });
  }
  if (addDivider) addDivider();
  const _meshCopyable = (q) => !q.isEffect && !q.isMarker && !q.isSound && !q.isMob && !q.isSky && !q.isTextPlane && !q.isTextBaked
    && (q.node.userData.placement || q.isCollisionPrimitive || (q.node.name || q.name));
  if (_meshCopyable(p)) {
    const copyTargets = (selectedSet.has(p) && selectedSet.size > 1) ? [...selectedSet].filter(_meshCopyable) : [p];
    addItem(copyTargets.length > 1 ? `Copy Mesh (${copyTargets.length})` : 'Copy Mesh',
      () => _R.copySelected(copyTargets), { icon: 'content_copy' });
  }
  {
    const cs = _R.clipboardSummary();
    addItem(cs ? `Paste Mesh (${cs})` : 'Paste Mesh',
      () => Promise.resolve(_R.pasteFromClipboard()).catch(err => _R.setStatus(`paste error: ${err.message}`, true)),
      { disabled: !_R.getEditMode() || !cs, icon: 'content_paste' });
  }
  if (addDivider) addDivider();
  addItem('Copy Transform', () => {
    clipboardTransform = {
      p: p.node.position.clone(),
      q: p.node.quaternion.clone(),
      s: p.node.scale.clone(),
    };
  });
  addItem(clipboardTransform ? 'Paste Transform' : 'Paste Transform (empty)', () => {
    if (!clipboardTransform) return;
    if (!_R.getEditMode()) return;
    const targets = [...selectedSet].filter((t) => !_R.isLocked(t));
    if (!targets.length) return;
    const before = targets.map((t) => _R.snapshotTRS(t.node));
    for (const t of targets) {
      t.node.position.copy(clipboardTransform.p);
      t.node.quaternion.copy(clipboardTransform.q);
      if (_R.getCopyTransformIncludeScale()) t.node.scale.copy(clipboardTransform.s);
      t.node.updateMatrix();
    }
    const after = targets.map((t) => _R.snapshotTRS(t.node));
    _R.pushSelectionTransformCommand(before, after);
    _R.updateSelectionReadout();
  }, { disabled: !_R.getEditMode() });
  if (addDivider) addDivider();
  const fv = (v) => +v.toFixed(4);
  addItem('Copy Position', () => { const {x,y,z} = p.node.position; navigator.clipboard.writeText(`${fv(x)}, ${fv(y)}, ${fv(z)}`); });
  addItem('Copy Rotation', () => { const {x,y,z} = p.node.rotation; navigator.clipboard.writeText(`${fv(x)}, ${fv(y)}, ${fv(z)}`); });
  addItem('Copy Scale',    () => { const {x,y,z} = p.node.scale;    navigator.clipboard.writeText(`${fv(x)}, ${fv(y)}, ${fv(z)}`); });
}

export function buildViewportContextMenu(p, e) {
  openContextMenu(e, (addItem, addDivider) => {
    addObjectContextItems(p, addItem, addDivider);
    addDivider();
    addItem('Delete', () => { if (!_R.getSelectedSet().has(p)) _R.select(p); _R.deleteSelected(); }, { disabled: !_R.getEditMode(), danger: true, icon: 'delete_forever' });
  });
}

function showRowContextMenu(p, e) {
  openContextMenu(e, (addItem, addDivider) => {
    addObjectContextItems(p, addItem, addDivider);
    addDivider();
    addItem('Delete', () => { if (!_R.getSelectedSet().has(p)) _R.select(p); _R.deleteSelected(); }, { disabled: !_R.getEditMode(), danger: true, icon: 'delete_forever' });
  });
}

// ── Object row ────────────────────────────────────────────────────────────────
let lastClickAnchor = null;

// exported so selection.js can expose it
export function getLastClickAnchor() { return lastClickAnchor; }
export function setLastClickAnchor(p) { lastClickAnchor = p; }

function makeObjectRow(p) {
  const li = document.createElement('li');
  const protectedAnchor = _R.isInitAnchor(p);
  let cb = null;
  if (!protectedAnchor) {
    cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'vis';
    cb.title = 'Visibility';
    if (p.isSound) {
      cb.checked = _R.iconVisible(p.node);
      cb.onclick = (e) => { e.stopPropagation(); _R.setIconVisible(p.node, cb.checked); setVisibilityOverride(p, cb.checked); };
    } else {
      cb.checked = p.node.visible;
      cb.onclick = (e) => {
        e.stopPropagation();
        p.node.visible = cb.checked;
        setVisibilityOverride(p, p.node.visible);
        if (p.isEffect) _R.setIconVisible(p.node, cb.checked);
      };
    }
  }
  const label = document.createElement('span');
  label.className = 'obj-name'; label.textContent = `${_R.isLocked(p) ? '🔒 ' : ''}${p.name}`;
  label.onclick = (e) => {
    if (e.shiftKey && lastClickAnchor && lastClickAnchor !== p) {
      _R.selectRange(lastClickAnchor, p);
    } else {
      if (!e.shiftKey) lastClickAnchor = p;
      _R.select(p, e.shiftKey);
    }
  };
  li.addEventListener('contextmenu', (e) => showRowContextMenu(p, e));
  if (_R.isLocked(p)) li.classList.add('locked');
  if (cb) li.append(cb, label); else li.append(label);
  const effBuilder = p.isEffect && p.node.userData.effect?.builder;
  if (effBuilder === 'runtime' || effBuilder === 'runtime·light') {
    const badge = document.createElement('span');
    badge.className = 'rt-badge';
    badge.textContent = 'RT';
    badge.title = 'Runtime-positioned — no fixed position in DAT (omit --pos when using xi fx copy)';
    li.appendChild(badge);
  }
  if (p.isUnplaced) {
    const badge = document.createElement('span');
    badge.className = 'rt-badge unplaced-badge';
    badge.textContent = 'UNPLACED';
    badge.title = 'No placement record references this mesh — the editor draws it at '
                + 'the origin, but the game client never spawns it.';
    li.appendChild(badge);
  }
  const pGrp = groupForPlacement(p);
  if (pGrp) {
    const dot = document.createElement('span');
    dot.className = 'group-dot';
    dot.style.background = pGrp.color;
    dot.title = `Group: ${pGrp.name}`;
    li.appendChild(dot);
  }
  if (_R.getSelectedSet().has(p)) li.classList.add('sel');
  p.li = li;
  return li;
}

let renderedObjs = [], renderedVfx = [], renderedMarkers = [], renderedSounds = [], renderedSky = [], renderedMobs = [], renderedCols = [], renderedText = [], renderedTextBaked = [];
export function getRenderedLists() {
  return { renderedObjs, renderedVfx, renderedMarkers, renderedSounds, renderedSky, renderedMobs, renderedCols, renderedText, renderedTextBaked };
}

function makeCategoryHeader(kind, name, count) {
  const collapsed = isCategoryCollapsed(kind, name);
  const li = document.createElement('li');
  li.className = 'cat-header' + (collapsed ? ' collapsed' : '');
  li.title = collapsed ? `Expand "${name}"` : `Collapse "${name}"`;
    const caret = document.createElement('span'); caret.className = 'cat-caret material-symbols-outlined'; caret.textContent = collapsed ? 'keyboard_arrow_right' : 'keyboard_arrow_down';
  const nm = document.createElement('span'); nm.className = 'cat-name'; nm.textContent = name;
  const ct = document.createElement('span'); ct.className = 'cat-count'; ct.textContent = `(${count})`;
  const ln = document.createElement('span'); ln.className = 'cat-line';
  li.append(caret, nm, ln, ct);
  li.onclick = () => toggleCategoryCollapse(kind, name);
  return li;
}

const _matchFilter = (p, filter) => !filter || p.name.toLowerCase().includes(filter) || (_R.isLocked(p) && 'locked'.includes(filter)) || (groupForPlacement(p)?.name || '').toLowerCase().includes(filter);

function fillCategorized(kind, items, listEl, countEl, searchEl, rendered) {
  if (listEl) listEl.innerHTML = '';
  const filter = (searchEl?.value || '').trim().toLowerCase();
  const matched = items.filter((p) => _matchFilter(p, filter));
  if (countEl) countEl.textContent = filter ? `(${matched.length}/${items.length})` : `(${items.length})`;
  if (!kindIsSectioned(kind)) {
    for (const p of matched) { listEl?.appendChild(makeObjectRow(p)); rendered.push(p); }
    return;
  }
  const buckets = new Map();
  for (const p of matched) {
    const cat = categoryForItem(kind, p);
    (buckets.get(cat) || buckets.set(cat, []).get(cat)).push(p);
  }
  for (const cat of orderedCategoryNamesForKind(kind, [...buckets.keys()])) {
    const bucket = buckets.get(cat);
    if (!bucket || !bucket.length) continue;
    listEl?.appendChild(makeCategoryHeader(kind, cat, bucket.length));
    if (isCategoryCollapsed(kind, cat)) continue;
    for (const p of bucket) { listEl?.appendChild(makeObjectRow(p)); rendered.push(p); }
  }
}

export function buildObjectList() {
  const placements = _R.getPlacements();
  const objlistEl = _R.getEl('objlist');
  const objcountEl = _R.getEl('objcount');
  const filterEl = _R.getEl('filter');
  const vfxlistEl = _R.getEl('vfxlist');
  const vfxcountEl = _R.getEl('vfxcount');
  const vfxFilterEl = _R.getEl('vfx-filter');
  const soundlistEl = _R.getEl('soundlist');
  const soundcountEl = _R.getEl('soundcount');
  const soundFilterEl = _R.getEl('sound-filter');
  const markerlistEl = _R.getEl('markerlist');
  const markercountEl = _R.getEl('markercount');
  const markerFilterEl = _R.getEl('marker-filter');
  const textlistEl = _R.getEl('textlist');
  const textcountEl = _R.getEl('textcount');
  const textFilterEl = _R.getEl('text-filter');
  const textbakedlistEl = _R.getEl('textbakedlist');
  const textbakedcountEl = _R.getEl('textbakedcount');
  const skylistEl = _R.getEl('skylist');
  const skycountEl = _R.getEl('skycount');
  const skyFilterEl = _R.getEl('sky-filter');
  const moblistEl = _R.getEl('moblist');
  const mobcountEl = _R.getEl('mobcount');
  const mobFilterEl = _R.getEl('mob-filter');
  const colslistEl = _R.getEl('colslist');
  const colscountEl = _R.getEl('colscount');
  const colsFilterEl = _R.getEl('cols-filter');

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const isReal = (p) => !p.isEffect && !p.isMarker && !p.isSky && !p.isCollisionPrimitive && !p.isMob && !p.isTextPlane && !p.isTextBaked;
  // Unplaced meshes are listed alongside real objects but tagged, so it's obvious
  // which geometry the client will never spawn. Hidden entirely when the toggle is off.
  const showUnplaced = document.getElementById('obj-unplaced')?.classList.contains('active') ?? true;
  const objs = placements.filter((p) => isReal(p) && (showUnplaced || !p.isUnplaced)).sort(byName);
  const cols = placements.filter((p) => p.isCollisionPrimitive).sort(byName);
  const vfx = placements.filter((p) => p.isEffect && !p.isSound && !p.isMarker).sort(byName);
  const sounds = placements.filter((p) => p.isSound).sort(byName);
  const markers = placements.filter((p) => p.isMarker).sort(byName);
  const texts = placements.filter((p) => p.isTextPlane).sort(byName);
  const textBaked = placements.filter((p) => p.isTextBaked).sort(byName);
  const sky  = placements.filter((p) => p.isSky).sort(byName);
  const mobs = placements.filter((p) => p.isMob).sort(byName);
  for (const p of placements) p.li = null;
  renderedObjs = []; renderedVfx = []; renderedMarkers = []; renderedSounds = []; renderedSky = []; renderedMobs = []; renderedCols = []; renderedText = []; renderedTextBaked = [];

  const fill = (items, listEl, countEl, searchEl, rendered) => {
    if (listEl) listEl.innerHTML = '';
    const filter = (searchEl?.value || '').trim().toLowerCase();
    let shown = 0;
    for (const p of items) if (_matchFilter(p, filter)) { listEl?.appendChild(makeObjectRow(p)); rendered.push(p); shown++; }
    if (countEl) countEl.textContent = filter ? `(${shown}/${items.length})` : `(${items.length})`;
  };
  fillCategorized('objs', objs, objlistEl, objcountEl, filterEl, renderedObjs);
  fillCategorized('vfx', vfx, vfxlistEl, vfxcountEl, vfxFilterEl, renderedVfx);
  fillCategorized('sfx', sounds, soundlistEl, soundcountEl, soundFilterEl, renderedSounds);
  fillCategorized('markers', markers, markerlistEl, markercountEl, markerFilterEl, renderedMarkers);
  fillCategorized('text', texts, textlistEl, textcountEl, textFilterEl, renderedText);
  fill(textBaked, textbakedlistEl, textbakedcountEl, null, renderedTextBaked);
  fillCategorized('sky', sky, skylistEl, skycountEl, skyFilterEl, renderedSky);
  fillCategorized('mobs', mobs, moblistEl, mobcountEl, mobFilterEl, renderedMobs);
  fillCategorized('cols', cols, colslistEl, colscountEl, colsFilterEl, renderedCols);
  _R.updateZoneInfo();
  _R.loadZoneSettingsPanel();
}

export function setListedVisibility(isEffect, visible) {
  for (const p of _R.getPlacements()) {
    if (p.isMarker || p.isSound || p.isSky || p.isEffect !== isEffect || !p.li) continue;
    p.node.visible = visible;
    setVisibilityOverride(p, visible);
    if (isEffect) _R.setIconVisible(p.node, visible);
    const cb = p.li.querySelector('input.vis');
    if (cb) cb.checked = visible;
  }
}

export function setMarkerVisibility(visible) { _R.setMarkerVisibilityImpl(visible, _R.getPlacements()); }

export function setMobVisibility(visible) {
  for (const p of _R.getPlacements()) {
    if (!p.isMob) continue;
    p.node.visible = visible;
    setVisibilityOverride(p, visible);
    const cb = p.li?.querySelector('input.vis');
    if (cb) cb.checked = visible;
  }
}

export function setSkyVisible(visible) {
  for (const p of _R.getPlacements()) {
    if (!p.isSky) continue;
    p.node.visible = visible;
    setVisibilityOverride(p, visible);
    const cb = p.li?.querySelector('input.vis');
    if (cb) cb.checked = visible;
  }
}

document.addEventListener('pointerdown', (e) => { if (!rowContextMenu.contains(e.target)) hideRowContextMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideRowContextMenu(); });
