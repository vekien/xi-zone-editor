// ── core/selection.js ───────────────────────────────────────────────────────
// Selection, hover-outline, pointer picking, TRS inputs, camera helpers, and
// undo/redo wrappers extracted from main.js.
//
// Call initSelection(deps) once after scene/camera/canvas are ready.
//
// All mutable main.js state (selected, selectedSet, hovered, hoveredIconNode,
// placements, zoneRoot, …) is accessed via the deps object so main.js owns the
// source of truth and can mutate it freely from other code paths.
//
// deps shape — every property is read at call time (no snapshot at init):
//   scene               THREE.Scene
//   camera              THREE.PerspectiveCamera
//   canvas              HTMLCanvasElement
//   transform           TransformControls
//   flyState            { flyLooking: bool }
//   csCamera            THREE.Camera
//   cutsceneCamActive   bool
//   selectionEl         HTMLElement
//   transformEl         HTMLElement | null
//   toolDeleteLabel     HTMLElement | null
//   getSelected()       → entry | null
//   setSelected(p)
//   getSelectedSet()    → Set
//   getHovered()        → entry | null
//   setHovered(p)
//   getHoveredIconNode() → node | null
//   setHoveredIconNode(n)
//   getPlacements()     → []
//   getZoneRoot()       → THREE.Group | null
//   getCurrentZoneUrl() → string | null
//   setNavScale(v)
//   getShowOutline()    → bool
//   getShowHoverOutline() → bool
//   getShowFrontNormal() → bool
//   getSimpleOutline()  → bool
//   getLists()          → { renderedObjs, renderedVfx, renderedSounds,
//                           renderedMarkers, renderedText, renderedSky }
//   isLocked(p)         → bool
//   isInitAnchor(p)     → bool
//   isWorldPickable(p)  → bool
//   groupForPlacement(p) → group | null
//   placementsInGroup(id) → []
//   toPlacement(obj)    → node | null
//   pickIcon(e)         → entry | null
//   tabForEntry(p)      → string
//   setActiveTab(tab)
//   openContextMenu(e, buildItems)
//   updateSpawnWarning()
//   updateMarkerDetailsPanel()
//   updateGlbDetailsPanel()
//   updateCollisionDetailsPanel()
//   updateSoundDetailsPanel()
//   updateSfxPlayUI()
//   updateChangesUI()
//   buildObjectList()
//   markChange(node)
//   pushCommand({ undo, redo })
//   saveZoneSetting(url, key, val)
//   loadZoneSetting(url, key)
//   getCsActors()
//   getCsLetterbox()    → bool
//   csToggleActorSelection(rec)
//   csClearActorSelection()
//   getMode()           → string

import * as THREE from 'three';

// ── outline objects (created in initSelection) ────────────────────────────────
let selectionOutline = null;
let selectionOutlineMat = null;
let selectionOutlineHullMat = null;
let hoverOutline = null;
let hoverOutlineMat = null;
let hoverOutlineHullMat = null;

// ── reusable scratch ──────────────────────────────────────────────────────────
const _hullScaleVec = new THREE.Vector3();
const _fnMat = new THREE.Matrix3();
const _fnTmp = new THREE.Vector3();
const _fnDir = new THREE.Vector3();
const _fnPos = new THREE.Vector3();
const _fnBox = new THREE.Box3();
let _frontArrow = null;
let _collArrowA = null;
let _collArrowB = null;

// ── raycaster ─────────────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// ── pointer drag state ────────────────────────────────────────────────────────
let downX = 0, downY = 0, downTime = 0;
let onGizmo = false;
let lastHoverPick = 0;

// ── readout state ─────────────────────────────────────────────────────────────
let readoutNode = null, readoutLocked = false;

// ── injected deps ─────────────────────────────────────────────────────────────
let D = null;

// ── init ──────────────────────────────────────────────────────────────────────
export function initSelection(deps) {
  D = deps;
  const scene = D.scene;

  selectionOutlineMat = new THREE.LineBasicMaterial({ color: 0xff8a00, depthTest: false, transparent: true, opacity: 0.95 });
  selectionOutlineHullMat = new THREE.MeshBasicMaterial({ color: 0xff8a00, side: THREE.BackSide, depthTest: false, transparent: true, opacity: 0.22 });
  selectionOutline = new THREE.Group();
  selectionOutline.visible = false;
  scene.add(selectionOutline);

  hoverOutlineMat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 });
  hoverOutlineHullMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide, depthTest: false, transparent: true, opacity: 0.18 });
  hoverOutline = new THREE.Group();
  hoverOutline.visible = false;
  scene.add(hoverOutline);
}

// Accessors for main.js code that still references these objects.
export function getSelectionOutline() { return selectionOutline; }
export function getHoverOutline() { return hoverOutline; }
export function getSelectionOutlineMat() { return selectionOutlineMat; }
export function getHoverOutlineMat() { return hoverOutlineMat; }
export function getHoverOutlineHullMat() { return hoverOutlineHullMat; }

// ── outline helpers ───────────────────────────────────────────────────────────
export function clearOutline(outline) {
  for (const child of outline.children) child.geometry?.dispose();
  outline.clear();
}

export function addOutline(outline, mat, node) {
  if (!node) return;
  node.updateWorldMatrix(true, true);
  const simpleOutline = D.getSimpleOutline();
  node.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    let obj;
    if (simpleOutline) {
      const hullMat = (outline === selectionOutline) ? selectionOutlineHullMat : hoverOutlineHullMat;
      obj = new THREE.Mesh(o.geometry, hullMat);
      obj.userData.isHull = true;
    } else {
      const edges = new THREE.EdgesGeometry(o.geometry, 25);
      obj = new THREE.LineSegments(edges, mat);
    }
    obj.matrixAutoUpdate = false;
    obj.renderOrder = 20000;
    obj.userData.source = o;
    obj.userData.root = node;
    outline.add(obj);
  });
}

export function rebuildOutline(outline, mat, node) {
  clearOutline(outline);
  addOutline(outline, mat, node);
}

export function clearSelectionOutline() { clearOutline(selectionOutline); }

export function rebuildSelectionOutline() {
  clearOutline(selectionOutline);
  for (const p of D.getSelectedSet()) addOutline(selectionOutline, selectionOutlineMat, p.node);
}

export function rebuildHoverOutline(node) {
  rebuildOutline(hoverOutline, hoverOutlineMat, node);
}

export function updateOutline(outline, enabled) {
  if (!enabled || outline.children.length === 0) { outline.visible = false; return; }
  let anyVisible = false;
  for (const obj of outline.children) {
    const visible = !!obj.userData.root?.visible;
    obj.visible = visible;
    if (visible) {
      obj.userData.root.updateWorldMatrix(true, true);
      obj.matrix.copy(obj.userData.source.matrixWorld);
      if (obj.userData.isHull) {
        _hullScaleVec.setScalar(1.025);
        obj.matrix.scale(_hullScaleVec);
      }
      anyVisible = true;
    }
  }
  outline.visible = anyVisible;
}

export function updateSelectionOutline() {
  updateOutline(selectionOutline, D.getShowOutline());
  updateNormalIndicator();
  updateCollisionArrows();
  D.updateSpawnWarning();
}

export function updateHoverOutline() {
  updateOutline(hoverOutline, D.getShowHoverOutline());
}

// ── front-face normal indicator ───────────────────────────────────────────────
export function computeFrontNormalLocal(node) {
  node.updateWorldMatrix(true, true);
  const nodeInv = node.matrixWorld.clone().invert();
  const acc = new THREE.Vector3();
  node.traverse((o) => {
    const na = o.isMesh && o.geometry?.attributes?.normal;
    if (!na) return;
    const avg = new THREE.Vector3();
    for (let i = 0; i < na.count; i++) { _fnTmp.fromBufferAttribute(na, i); avg.add(_fnTmp); }
    if (avg.lengthSq() < 1e-9) return;
    avg.normalize();
    o.updateWorldMatrix(true, false);
    _fnMat.getNormalMatrix(o.matrixWorld); avg.applyMatrix3(_fnMat).normalize();   // mesh-local → world
    _fnMat.getNormalMatrix(nodeInv);       avg.applyMatrix3(_fnMat).normalize();   // world → node-local
    acc.add(avg);
  });
  return acc.lengthSq() > 1e-6 ? acc.normalize() : null;
}

export function updateNormalIndicator() {
  // TEMP (revisit): the cyan front-normal arrow renders incorrectly in many cases,
  // so it's disabled for now. "Show Face Normal" is a no-op until we fix it.
  if (_frontArrow) _frontArrow.visible = false;
  return;
  // The dead code below is left intact to re-enable later.
  /* eslint-disable no-unreachable */
  if (!_frontArrow) {
    _frontArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 5, 0x36e0ff, 1.6, 1.0);
    for (const m of [_frontArrow.line.material, _frontArrow.cone.material]) { m.depthTest = false; m.transparent = true; m.opacity = 0.95; }
    _frontArrow.line.renderOrder = _frontArrow.cone.renderOrder = 21000;
    _frontArrow.line.raycast = _frontArrow.cone.raycast = () => {};
    _frontArrow.visible = false;
    D.scene.add(_frontArrow);
  }
  const selected = D.getSelected();
  const node = (D.getShowFrontNormal() && selected && !selected.isMarker && !selected.isEffect && !selected.isSound && !selected.isCollisionPrimitive) ? selected.node : null;
  if (!node || !node.visible) { _frontArrow.visible = false; return; }
  if (node.userData._frontNormalLocal === undefined) node.userData._frontNormalLocal = computeFrontNormalLocal(node);
  const local = node.userData._frontNormalLocal;
  if (!local) { _frontArrow.visible = false; return; }
  node.updateWorldMatrix(true, true);
  _fnMat.getNormalMatrix(node.matrixWorld);
  _fnDir.copy(local).applyMatrix3(_fnMat).normalize();
  _fnBox.setFromObject(node);
  if (_fnBox.isEmpty()) { _frontArrow.visible = false; return; }
  _fnBox.getCenter(_fnPos);
  const len = Math.min(6, Math.max(0.8, _fnBox.getSize(_fnTmp).length() * 0.1));
  _frontArrow.position.copy(_fnPos);
  _frontArrow.setDirection(_fnDir);
  _frontArrow.setLength(len, len * 0.28, len * 0.16);
  _frontArrow.visible = true;
  /* eslint-enable no-unreachable */
}

// ── collision blocking-side indicator ─────────────────────────────────────────
function makeCollArrow() {
  const a = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 5, 0xff5522, 1.6, 1.0);
  for (const m of [a.line.material, a.cone.material]) { m.depthTest = false; m.transparent = true; m.opacity = 0.95; }
  a.line.renderOrder = a.cone.renderOrder = 21000;
  a.line.raycast = a.cone.raycast = () => {};
  a.visible = false;
  D.scene.add(a);
  return a;
}

function collisionThinAxisLocal(node) {
  const s = node.scale, ax = Math.abs(s.x), ay = Math.abs(s.y), az = Math.abs(s.z);
  if (ax <= ay && ax <= az) return new THREE.Vector3(1, 0, 0);
  if (ay <= az) return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
}

export function updateCollisionArrows() {
  if (!_collArrowA) { _collArrowA = makeCollArrow(); _collArrowB = makeCollArrow(); }
  _collArrowA.visible = _collArrowB.visible = false;
  const selected = D.getSelected();
  const node = (D.getShowFrontNormal() && selected && selected.isCollisionPrimitive) ? selected.node : null;
  if (!node || !node.visible) return;
  if (node.userData._frontNormalLocal === undefined) node.userData._frontNormalLocal = computeFrontNormalLocal(node);
  let local = node.userData._frontNormalLocal;
  if (!local) local = collisionThinAxisLocal(node);
  if (!local) return;
  node.updateWorldMatrix(true, true);
  _fnMat.getNormalMatrix(node.matrixWorld);
  _fnDir.copy(local).applyMatrix3(_fnMat).normalize();
  _fnBox.setFromObject(node);
  if (_fnBox.isEmpty()) return;
  _fnBox.getCenter(_fnPos);
  const len = Math.min(6, Math.max(0.8, _fnBox.getSize(_fnTmp).length() * 0.1));
  const place = (arr, dir, color) => {
    arr.setColor(color); arr.position.copy(_fnPos); arr.setDirection(dir);
    arr.setLength(len, len * 0.28, len * 0.16); arr.visible = true;
  };
  if (node.userData.collisionMat && node.userData.collisionMat.wall) {
    place(_collArrowA, _fnDir, 0xff5522);
    place(_collArrowB, _fnTmp.copy(_fnDir).negate(), 0xff5522);
  } else {
    place(_collArrowA, _fnTmp.set(0, 1, 0), 0x44e060);
  }
}

// ── selection ─────────────────────────────────────────────────────────────────
export function lastSelectedEntry() {
  let last = null;
  for (const p of D.getSelectedSet()) last = p;
  return last;
}

export function select(p, multi = false) {
  const selectedSet = D.getSelectedSet();
  if (!multi) {
    for (const q of selectedSet) q.li?.classList.remove('sel');
    selectedSet.clear();
  }
  if (!p) {
    D.setSelected(null);
    D.transform.detach();
    D.selectionEl.textContent = 'nothing selected';
    D.syncSelectionModal?.(false);
    clearSelectionOutline(); updateSelectionOutline();
    D.updateMarkerDetailsPanel(); D.updateGlbDetailsPanel(); D.updateCollisionDetailsPanel(); D.updateSoundDetailsPanel();
    return;
  }
  if (multi && selectedSet.has(p)) {
    selectedSet.delete(p);
    p.li?.classList.remove('sel');
    const cur = D.getSelected();
    D.setSelected(cur === p ? lastSelectedEntry() : cur);
  } else {
    selectedSet.add(p);
    D.setSelected(p);
    if (p.li) { p.li.classList.add('sel'); p.li.scrollIntoView({ block: 'nearest' }); }
    if (!multi) {
      const grp = D.groupForPlacement(p);
      if (grp) {
        for (const m of D.placementsInGroup(grp.id)) {
          if (m !== p && !selectedSet.has(m)) { selectedSet.add(m); if (m.li) m.li.classList.add('sel'); }
        }
      }
    }
  }
  const sel = D.getSelected();
  if (sel && !D.isLocked(sel)) D.transform.attach(sel.node); else D.transform.detach();
  rebuildSelectionOutline();
  updateSelectionReadout();
  updateSelectionOutline();
  D.updateMarkerDetailsPanel(); D.updateGlbDetailsPanel(); D.updateCollisionDetailsPanel(); D.updateSoundDetailsPanel();
}

export function selectRange(anchor, target) {
  const { renderedObjs, renderedVfx, renderedSounds, renderedMarkers, renderedText, renderedSky } = D.getLists();
  const list = [renderedObjs, renderedVfx, renderedSounds, renderedMarkers, renderedText, renderedSky].find(l => l.includes(anchor) && l.includes(target));
  if (!list) { select(target, true); return; }
  const ai = list.indexOf(anchor), ti = list.indexOf(target);
  const [lo, hi] = ai < ti ? [ai, ti] : [ti, ai];
  const selectedSet = D.getSelectedSet();
  for (const q of selectedSet) q.li?.classList.remove('sel');
  selectedSet.clear();
  for (let i = lo; i <= hi; i++) { selectedSet.add(list[i]); list[i].li?.classList.add('sel'); }
  D.setSelected(target);
  const sel = D.getSelected();
  if (sel && !D.isLocked(sel)) D.transform.attach(sel.node); else D.transform.detach();
  rebuildSelectionOutline(); updateSelectionReadout(); updateSelectionOutline();
  D.updateMarkerDetailsPanel(); D.updateGlbDetailsPanel();
}

// ── selection readout ─────────────────────────────────────────────────────────
export function updateDeleteBtn() {
  if (!D.toolDeleteLabel) return;
  const n = D.getSelectedSet().size;
  D.toolDeleteLabel.textContent = n > 1 ? `Delete (${n})` : 'Delete';
}

export function updateSelectionReadout() {
  updateDeleteBtn();
  D.updateSfxPlayUI();
  const selected = D.getSelected();
  D.syncSelectionModal?.(!!selected);
  if (!selected) {
    D.selectionEl.textContent = 'nothing selected';
    if (D.transformEl) D.transformEl.innerHTML = '';
    readoutNode = null;
    return;
  }
  const n = selected.node;
  if (readoutNode === n && readoutLocked === D.isLocked(selected) && D.transformEl && D.transformEl.querySelector('.trs-in')) {
    refreshTrsInputs(n);
    const ni = D.selectionEl.querySelector('.name-in');
    if (ni && document.activeElement !== ni) ni.value = selected.name;
    return;
  }
  readoutNode = n; readoutLocked = D.isLocked(selected);
  const pl = n.userData.placement;
  const effect = n.userData.effect;
  const srcFxLine = (!pl && effect && selected.sourceDat)
    ? `<div class="kv"><span class="k">src</span><span>${selected.sourceDat} :: ${selected.sourceId || effect.sectionId}${selected.sourceOffset != null ? ` @ ${selected.sourceOffset}` : ''}</span></div>`
    : '';
  const offLine = effect && effect.sourceOffset != null
    ? `<div class="kv"><span class="k">off</span><span>0x${(effect.sourceOffset >>> 0).toString(16)} (${effect.sourceOffset})${effect.builder ? ` · ${effect.builder}` : ''}</span></div>`
    : (effect && effect.builder ? `<div class="kv"><span class="k">via</span><span>${effect.builder}</span></div>` : '');
  const srcDatLine = (pl && n.userData.sourceZone)
    ? `<div class="kv"><span class="k">source</span><span>${n.userData.sourceZone}${n.userData.sourceName ? `<br>${n.userData.sourceName}` : ''}</span></div>`
    : '';
  const meshLine = pl ? `<div class="kv"><span class="k">mesh</span><span>${pl.meshId}</span></div>${srcDatLine}`
    : effect ? `<div class="kv"><span class="k">id</span><span>${effect.sectionId}</span></div><div class="kv"><span class="k">vfx</span><span>${effect.mesh}</span></div>${offLine}${srcFxLine}`
    : (n.userData.markerCsIcon || n.userData.markerIcon) != null ? `<div class="kv"><span class="k">marker</span><span>${n.userData.markerCsIcon || n.userData.markerIcon}</span></div>`
    : `<div class="kv"><span class="k">status</span><span>(unplaced)</span></div>`;
  const nameDis = D.isInitAnchor(selected) ? 'disabled' : '';
  D.selectionEl.innerHTML =
    (readoutLocked ? '<div class="lock-icon" title="Transform locked">🔒</div>' : '') +
    `<input class="name-in" type="text" spellcheck="false" autocomplete="off" ${nameDis} title="Rename — Enter to apply, Esc to cancel" />` +
    meshLine +
    `${D.getSelectedSet().size > 1 ? `<div class="sel-multi">${D.getSelectedSet().size} selected</div>` : ''}`;
  const nameIn = D.selectionEl.querySelector('.name-in');
  if (nameIn) { nameIn.value = selected.name; if (!nameDis) wireNameInput(nameIn); }
  const dis = readoutLocked ? 'disabled' : '';
  const row = (label, kind, step) =>
    `<div class="trs-row"><span class="k">${label}</span>` +
    ['x', 'y', 'z'].map((ax) =>
      `<input class="trs-in" type="number" step="${step}" data-kind="${kind}" data-axis="${ax}" value="${+n[kind][ax].toFixed(4)}" ${dis} />`).join('') +
    `<button class="trs-reset" data-kind="${kind}" title="Reset ${label}" ${dis}><span class="material-symbols-outlined">refresh</span></button></div>`;
  if (D.transformEl) {
    D.transformEl.innerHTML = row('pos', 'position', 0.1) + row('rot', 'rotation', 0.05) + row('scale', 'scale', 0.01);
    if (!readoutLocked) wireTrsInputs();
    wireTrsContextMenus();
  }
}

export function refreshTrsInputs(n) {
  const active = document.activeElement;
  (D.transformEl || D.selectionEl).querySelectorAll('.trs-in').forEach((inp) => {
    if (inp === active) return;
    inp.value = +n[inp.dataset.kind][inp.dataset.axis].toFixed(4);
  });
}

export function wireNameInput(inp) {
  const commit = () => {
    const selected = D.getSelected();
    if (!selected) return;
    const v = inp.value.trim();
    if (!v || v === selected.name) { inp.value = selected.name; return; }
    renameSelected(selected, v);
  };
  inp.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') inp.blur();
    else if (e.key === 'Escape') { const s = D.getSelected(); inp.value = s ? s.name : ''; inp.blur(); }
  };
  inp.onblur = commit;
}

function renameSelected(entry, newName) {
  const oldName = entry.name;
  if (newName === oldName) return;
  const apply = (nm) => {
    entry.name = nm;
    if (entry.node) entry.node.name = nm;
    D.buildObjectList();
    updateSelectionReadout();
    D.updateChangesUI();
  };
  apply(newName);
  D.pushCommand({ undo: () => apply(oldName), redo: () => apply(newName) });
}

export function wireTrsInputs() {
  const host = D.transformEl || D.selectionEl;
  host.querySelectorAll('.trs-in').forEach((inp) => {
    inp.onchange = () => {
      const v = Number(inp.value);
      if (Number.isFinite(v)) applyTransformEdit(inp.dataset.kind, inp.dataset.axis, v);
      else updateSelectionReadout();
    };
  });
  host.querySelectorAll('.trs-reset').forEach((btn) => {
    btn.onclick = () => resetTransform(btn.dataset.kind);
  });
}

export function wireTrsContextMenus() {
  const host = D.transformEl || D.selectionEl;
  host.querySelectorAll('.trs-row').forEach((row) => {
    const label = row.querySelector('.k');
    const kind  = row.querySelector('.trs-in')?.dataset.kind;
    if (!label || !kind) return;
    label.addEventListener('contextmenu', (e) => {
      D.openContextMenu(e, (addItem) => {
        addItem('Copy', () => {
          const vals = [...row.querySelectorAll('.trs-in')].map((i) => i.value);
          navigator.clipboard.writeText(vals.join(', '));
        });
        addItem('Paste', () => {
          navigator.clipboard.readText().then((text) => {
            const nums = text.split(/[\s,]+/).map(Number);
            const selected = D.getSelected();
            if (nums.length >= 3 && nums.every(Number.isFinite) && selected && !D.isLocked(selected)) {
              const node = selected.node;
              const before = snapshotTRS(node);
              ['x', 'y', 'z'].forEach((ax, i) => { node[kind][ax] = nums[i]; });
              node.updateMatrix();
              pushSelectionTransformCommand([before], [snapshotTRS(node)]);
              rebuildSelectionOutline(); updateSelectionReadout(); updateSelectionOutline();
            }
          });
        }, { disabled: readoutLocked || !D.getSelected() });
      });
    });
  });
}

function applyTransformEdit(kind, axis, value) {
  const selected = D.getSelected();
  if (!selected || D.isLocked(selected)) return;
  const node = selected.node;
  const before = snapshotTRS(node);
  node[kind][axis] = value;
  node.updateMatrix();
  pushSelectionTransformCommand([before], [snapshotTRS(node)]);
  rebuildSelectionOutline(); updateSelectionReadout(); updateSelectionOutline();
}

export function resetTransform(kind) {
  const selected = D.getSelected();
  if (!selected || D.isLocked(selected)) return;
  const node = selected.node;
  const before = snapshotTRS(node);
  if (kind === 'position') node.position.set(0, 0, 0);
  else if (kind === 'rotation') node.rotation.set(0, 0, 0);
  else if (kind === 'scale') { node.scale.set(1, 1, 1); }
  node.updateMatrix();
  pushSelectionTransformCommand([before], [snapshotTRS(node)]);
  rebuildSelectionOutline(); updateSelectionReadout(); updateSelectionOutline();
}

// ── pointer handlers ───────────────────────────────────────────────────────────
// A "regular object" = a zone mesh placement (not a marker / VFX / sound / collision / sky).
// While Fixed Ratio (16:9) shot-framing is live we make these un-pickable so you can't
// accidentally move or delete scenery — markers, icons, collision + NPCs stay clickable.
function _isRegularObject(p) {
  return !!(p && !p.isMarker && !p.isEffect && !p.isSound && !p.isCollisionPrimitive && !p.isSky);
}
function _cineFraming() { return !!(D.getCsCinematicViewport && D.getCsCinematicViewport()); }

export function onPointerDown(e) {
  if (e.button !== 0) return;
  const n = D.clientToNdc(e.clientX, e.clientY);   // cine-aware (16:9 sub-rect)
  pointer.x = n.x; pointer.y = n.y;
  downX = e.clientX; downY = e.clientY;
  downTime = performance.now();
  onGizmo = !!D.transform.axis;
}

export function onPointerMovePick(e) {
  if (D.getMode() === 'view') {
    if (D.getHoveredIconNode()) { D.setHoveredIconNode(null); D.canvas.style.cursor = ''; }
    if (D.getHovered()) { D.setHovered(null); clearOutline(hoverOutline); updateHoverOutline(); }
    return;
  }
  const overIcon = (D.getZoneRoot() && !D.flyState.flyLooking && !D.transform.dragging && !D.transform.axis) ? D.pickIcon(e) : null;
  const overIconNode = overIcon?.node || null;
  if (overIconNode !== D.getHoveredIconNode()) {
    D.setHoveredIconNode(overIconNode);
    D.canvas.style.cursor = overIconNode ? 'pointer' : '';
  }
  if (!D.getShowHoverOutline() || !D.getZoneRoot() || D.flyState.flyLooking || D.transform.dragging || D.transform.axis) {
    D.setHovered(null); clearOutline(hoverOutline); updateHoverOutline(); return;
  }
  const now = performance.now();
  if (now - lastHoverPick < 120) return;
  lastHoverPick = now;
  const n = D.clientToNdc(e.clientX, e.clientY);   // cine-aware (16:9 sub-rect)
  pointer.x = n.x; pointer.y = n.y;
  raycaster.setFromCamera(pointer, D.getActiveCamera());
  const hits = raycaster.intersectObject(D.getZoneRoot(), true);
  const cine = _cineFraming();
  let next = null;
  for (const h of hits) {
    const node = D.toPlacement(h.object);
    const p = D.getPlacements().find((q) => q.node === node) || null;
    if (!node || !D.isWorldPickable(p)) continue;
    if (cine && _isRegularObject(p)) continue;   // Fixed Ratio: no hover wireframe on scenery
    // Nearest hoverable surface. If already selected, it OCCLUDES — stop rather than
    // falling through to the object behind (which the front object blocks anyway).
    if (!D.getSelectedSet().has(p)) next = p;
    break;
  }
  if (next !== D.getHovered()) {
    D.setHovered(next);
    rebuildOutline(hoverOutline, hoverOutlineMat, D.getHovered()?.node);
  }
  updateHoverOutline();
  // Cutscene NPC hover — screen-space proximity (SkinnedMesh bind-pose breaks world raycasting)
  const _csActors = D.getCsActors();
  if (!next && _csActors.length && !D.getCsLetterbox() && !D.flyState.flyLooking && !D.transform.dragging && !D.transform.axis) {
    const hr = D.canvas.getBoundingClientRect();
    const hcx = e.clientX - hr.left;
    const hcy = e.clientY - hr.top;
    const _hwp = new THREE.Vector3();
    const pickCam = D.cutsceneCamActive ? D.csCamera : D.camera;
    for (const rec of _csActors) {
      if (!rec.node.visible) continue;
      rec.node.getWorldPosition(_hwp);
      _hwp.project(pickCam);
      const hsx = (_hwp.x * 0.5 + 0.5) * hr.width;
      const hsy = (-_hwp.y * 0.5 + 0.5) * hr.height;
      if (Math.hypot(hcx - hsx, hcy - hsy) < 60) { D.canvas.style.cursor = 'pointer'; break; }
    }
  }
}

export function onPointerUp(e) {
  if (e.button !== 0) return;
  if (D.getMode() === 'view') return;   // View mode is pure visual — no click-to-select
  if (onGizmo || D.transform.dragging) return; // gizmo interaction, not a selection click
  if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return; // a look-drag, not a click
  if (!D.getZoneRoot()) return;
  const iconP = D.pickIcon(e);   // VFX/sound icons are always-on-top — pick them before world geometry
  if (iconP) { select(iconP, e.shiftKey); if (!e.shiftKey) D.setActiveTab(D.tabForEntry(iconP)); return; }
  const cinePick = _cineFraming();
  raycaster.setFromCamera(pointer, D.getActiveCamera());
  const hits = raycaster.intersectObject(D.getZoneRoot(), true);
  for (const h of hits) {
    const node = D.toPlacement(h.object);
    if (node) {
      const p = D.getPlacements().find((q) => q.node === node);
      if (cinePick && _isRegularObject(p)) continue;   // Fixed Ratio: scenery isn't selectable (fall through to markers behind)
      if (D.isWorldPickable(p)) { select(p, e.shiftKey); if (!e.shiftKey) D.setActiveTab(D.tabForEntry(p)); D.csClearActorSelection(); return; }
    }
  }
  // Cutscene NPC pick — screen-space proximity (SkinnedMesh bind-pose breaks world raycasting)
  const _csActorsPick = D.getCsActors();
  if (_csActorsPick.length && !D.getCsLetterbox()) {
    const r = D.canvas.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const _wp = new THREE.Vector3();
    const pickCam = D.cutsceneCamActive ? D.csCamera : D.camera;
    let bestRec = null, bestDist = 60;  // 60px hit radius
    for (const rec of _csActorsPick) {
      rec.node.getWorldPosition(_wp);
      _wp.project(pickCam);
      const sx = (_wp.x * 0.5 + 0.5) * r.width;
      const sy = (-_wp.y * 0.5 + 0.5) * r.height;
      const d = Math.hypot(cx - sx, cy - sy);
      console.log('[cs pick]', rec.name, 'visible:', rec.node.visible, 'dist:', d.toFixed(1), 'sx:', sx.toFixed(0), 'sy:', sy.toFixed(0), 'cx:', cx.toFixed(0), 'cy:', cy.toFixed(0));
      if (!rec.node.visible) continue;
      if (d < bestDist) { bestDist = d; bestRec = rec; }
    }
    console.log('[cs pick] bestRec:', bestRec?.name, 'bestDist:', bestDist.toFixed(1));
    if (bestRec) { D.csToggleActorSelection(bestRec); return; }
  }
  D.csClearActorSelection();
}

// ── camera helpers ─────────────────────────────────────────────────────────────
export function frameScene() {
  // Frame on real placements only — effect surfaces (huge sea plane) would skew it.
  const placements = D.getPlacements();
  const framing = placements.filter((p) => !p.isEffect && !p.isSky);
  if (!framing.length) return;
  // The dense walkable core is ringed by a few sprawling pieces (bridges, ocean
  // LOD) spanning ~10x its size; framing the full bbox shrinks the core to a speck.
  // Center on the median object and frame the 90th-percentile-closest cluster.
  const centers = framing.map((p) => p.node.getWorldPosition(new THREE.Vector3()));
  const med = (k) => [...centers].sort((a, b) => a[k] - b[k])[centers.length >> 1][k];
  const cx = med('x'), cz = med('z');
  const dists = centers.map((c) => Math.hypot(c.x - cx, c.z - cz)).sort((a, b) => a - b);
  const cutoff = dists[Math.floor(dists.length * 0.9)] || dists[dists.length - 1];

  const box = new THREE.Box3();
  framing.forEach((p, i) => { if (Math.hypot(centers[i].x - cx, centers[i].z - cz) <= cutoff) box.expandByObject(p.node); });
  if (box.isEmpty()) for (const p of framing) box.expandByObject(p.node);

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.6 || 50;
  D.setNavScale(radius);
  const camera = D.camera;
  camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.9, radius));
  camera.lookAt(center);
  camera.near = Math.max(radius / 500, 0.1);
  camera.far = radius * 200;
  camera.updateProjectionMatrix();
}

export function saveCurrentZoneCamera() {
  const url = D.getCurrentZoneUrl();
  if (!url) return;
  D.saveZoneSetting(url, 'camera', {
    position: D.camera.position.toArray(),
    quaternion: D.camera.quaternion.toArray(),
  });
}

export function restoreZoneCamera(url) {
  const saved = D.loadZoneSetting(url, 'camera');
  if (!saved?.position || !saved?.quaternion) return false;
  D.camera.position.fromArray(saved.position);
  D.camera.quaternion.fromArray(saved.quaternion);
  D.camera.updateMatrixWorld();
  return true;
}

// ── undo/redo helpers ──────────────────────────────────────────────────────────
export const snapshotTRS = (node) => ({ node, p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() });

export function reselectAfterEdit(node) {
  const p = D.getPlacements().find((q) => q.node === node);
  if (p) select(p); else updateSelectionReadout();
}

export function pushSelectionTransformCommand(before, after) {
  for (const t of before) D.markChange(t.node);
  const applySnaps = (snaps, changed = false) => {
    for (const t of snaps) {
      t.node.position.copy(t.p); t.node.quaternion.copy(t.q); t.node.scale.copy(t.s); t.node.updateMatrix();
      if (changed) D.markChange(t.node);
    }
    rebuildSelectionOutline();
    updateSelectionReadout();
    updateSelectionOutline();
  };
  D.pushCommand({ undo: () => applySnaps(before), redo: () => applySnaps(after, true) });
}
