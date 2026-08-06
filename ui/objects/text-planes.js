// text-planes.js — editable text billboard system extracted from main.js
//
// A "text plane" is a flat editable sign typed in the editor — its OWN object
// type (the TEXT tab) and the SOURCE of truth. It renders live as a canvas-textured
// plane (no GLB while editing), modelled exactly like markers: a parallel editor
// object that round-trips through the change-set's textPlanes[] array. On Publish,
// rebuildTextBakes() bakes each editable plane to a GLB (plane + text PNG) and
// injects those through the normal glbImport pipeline — listed read-only under
// "Baked GLB (auto)" and regenerated every Publish.

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// ── injected dependencies (set via initTextPlanes) ────────────────────────────
let _getZoneRoot, _getSelected, _placements, _placementSet, _addedEntries;
let _pushCommand, _markChange, _updateChangesUI, _buildObjectList;
let _setActiveTab, _select, _focusSelected, _setStatus, _editMode;
let _inFrontOfCamera, _trsMatrix, _uniquePlacementName, _newXiId, _xiName;
let _disposeSubtree, _rebuildSelectionOutline, _updateSelectionOutline, _loadGlbWrap;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const textPlanePanel    = document.getElementById('textplane-details');
export const tpText     = document.getElementById('tp-text');
const tpSize         = document.getElementById('tp-size');
const tpSizeVal      = document.getElementById('tp-size-val');
const tpColor        = document.getElementById('tp-color');
const tpPanel        = document.getElementById('tp-panel');

// ── constants ─────────────────────────────────────────────────────────────────
export const TEXTPLANE_DEFAULTS = { text: 'New Text', fontSize: 64, color: '#ffffff', panel: '#1b1b22' };
const TEXTPLANE_PX_PER_M = 256;   // canvas pixels per FFXI world metre — sets the plane's size

const gltfExporter = new GLTFExporter();

/**
 * Wire up text-plane dependencies. Call once during startup.
 */
export function initTextPlanes({
  getZoneRoot, getSelected, placements, placementSet, addedEntries,
  pushCommand, markChange, updateChangesUI, buildObjectList,
  setActiveTab, select, focusSelected, setStatus, getEditMode,
  inFrontOfCamera, trsMatrix, uniquePlacementName, newXiId, xiName,
  disposeSubtree, rebuildSelectionOutline, updateSelectionOutline, loadGlbWrap,
}) {
  _getZoneRoot            = getZoneRoot;
  _getSelected            = getSelected;
  _placements             = placements;
  _placementSet           = placementSet;
  _addedEntries           = addedEntries;
  _pushCommand            = pushCommand;
  _markChange             = markChange;
  _updateChangesUI        = updateChangesUI;
  _buildObjectList        = buildObjectList;
  _setActiveTab           = setActiveTab;
  _select                 = select;
  _focusSelected          = focusSelected;
  _setStatus              = setStatus;
  _editMode               = getEditMode;
  _inFrontOfCamera        = inFrontOfCamera;
  _trsMatrix              = trsMatrix;
  _uniquePlacementName    = uniquePlacementName;
  _newXiId              = newXiId;
  _xiName                 = xiName;
  _disposeSubtree         = disposeSubtree;
  _rebuildSelectionOutline   = rebuildSelectionOutline;
  _updateSelectionOutline    = updateSelectionOutline;
  _loadGlbWrap            = loadGlbWrap;

  // Wire inspector DOM events
  if (tpText)  tpText.oninput  = () => _tpApply({ text: tpText.value });
  if (tpSize)  tpSize.oninput  = () => { if (tpSizeVal) tpSizeVal.textContent = tpSize.value; _tpApply({ fontSize: parseInt(tpSize.value, 10) || 64 }, true); };
  if (tpColor) tpColor.oninput = () => _tpApply({ color: tpColor.value }, true);
  if (tpPanel) tpPanel.oninput = () => _tpApply({ panel: tpPanel.value }, true);
}

// ── canvas rendering ──────────────────────────────────────────────────────────

// Smallest power-of-two (>=4, <=1024) that fits n — FFXI textures want POT dimensions.
function _pot(n) { let p = 4; while (p < n) p <<= 1; return Math.min(p, 1024); }

// Render the sign onto a POT canvas (panel fill + centred multi-line text). Returns the
// canvas plus the plane's world size (metres) derived from the canvas aspect.
export function renderTextPlaneCanvas(params) {
  const p = { ...TEXTPLANE_DEFAULTS, ...params };
  const font = `bold ${p.fontSize}px Arial, "Helvetica Neue", sans-serif`;
  const lines = String(p.text ?? '').split('\n');
  const pad = Math.round(p.fontSize * 0.5);
  const lineH = Math.round(p.fontSize * 1.3);
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = font;
  let textW = 1;
  for (const ln of lines) textW = Math.max(textW, meas.measureText(ln || ' ').width);
  const w = _pot(Math.ceil(textW + pad * 2));
  const h = _pot(Math.ceil(lineH * lines.length + pad * 2));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = p.panel; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = p.color;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const blockH = lineH * lines.length;
  lines.forEach((ln, i) => ctx.fillText(ln, w / 2, (h - blockH) / 2 + lineH * i + lineH / 2));
  return { canvas, worldW: w / TEXTPLANE_PX_PER_M, worldH: h / TEXTPLANE_PX_PER_M };
}

// Bake a text plane to GLB bytes (plane geometry + canvas PNG texture, unlit + double-sided).
// `matName` names the material so the backend's `zone object import` can match texture → mesh.
export async function buildTextPlaneGlb(params, matName) {
  const { canvas, worldW, worldH } = renderTextPlaneCanvas(params);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
  mat.name = matName;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldH), mat);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const out = await gltfExporter.parseAsync(scene, { binary: true });
  mesh.geometry.dispose(); mat.dispose(); tex.dispose();
  return out instanceof ArrayBuffer ? out : new TextEncoder().encode(JSON.stringify(out)).buffer;
}

// Build the live editor mesh for a sign: a canvas-textured plane wrapped so it sits in
// FFXI space (same wrap loadGlbWrap uses), matching the baked GLB's position.
export function buildTextPlaneMesh(params) {
  const { canvas, worldW, worldH } = renderTextPlaneCanvas(params);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldH), mat);
  const wrap = new THREE.Group();
  const zoneRoot = _getZoneRoot();
  wrap.quaternion.copy(zoneRoot.quaternion);
  wrap.scale.copy(zoneRoot.scale);
  wrap.add(mesh);
  return wrap;
}

// A stable per-plane file/material stem (text_xxxxxx) reused for the baked GLB every
// Publish. Allocated once, then carried on the node.
function _textStem(node) {
  if (!node.userData.textStem) node.userData.textStem = `text_${_randTail(6)}`;
  return node.userData.textStem;
}

function _randTail(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Build an editable text-plane node (Group → wrap → plane) from params + optional identity/TRS.
export function buildTextPlaneNode(params, { pos, rot, scale, name, xiId, stem } = {}) {
  const pnode = new THREE.Group();
  pnode.rotation.order = 'ZYX';
  pnode.add(buildTextPlaneMesh(params));
  if (pos || rot || scale) {
    _trsMatrix(pos || [0, 0, 0], rot || [0, 0, 0], scale || [1, 1, 1])
      .decompose(pnode.position, pnode.quaternion, pnode.scale);
  } else {
    pnode.position.copy(_inFrontOfCamera());
  }
  pnode.updateMatrix();
  pnode.name = _uniquePlacementName(name || stem || 'text');
  pnode.userData = {
    xiId: xiId || _newXiId(),
    textPlane: params,
    textStem: stem || null,
    original: { p: pnode.position.clone(), q: pnode.quaternion.clone(), s: pnode.scale.clone() },
  };
  return pnode;
}

// "Add Text Plane" — drop a new editable sign in front of the camera, list it in the
// TEXT tab, open the inspector. No GLB is baked until Publish. Mirrors addMarker.
export function addTextPlane() {
  if (!_editMode()) { _setStatus('Switch to Edit mode to add text planes', true); return; }
  const zoneRoot = _getZoneRoot();
  if (!zoneRoot) { _setStatus('load a zone first', true); return; }
  const node = buildTextPlaneNode({ ...TEXTPLANE_DEFAULTS });
  zoneRoot.add(node);
  _placementSet.add(node);
  const entry = { node, name: node.name, isTextPlane: true };
  _placements.push(entry);
  _markChange(node);
  _buildObjectList();
  _setActiveTab('text');
  _select(entry);
  _focusSelected();
  _updateChangesUI();
  _setStatus('text plane added — edit the text in the panel');
  tpText?.focus();
}

// Rebuild an editable text plane from a saved textPlanes[] record (Load / migration).
// Adds directly to the scene + list, no ops/undo wrapper. Mirrors addMarkerFromRec.
export function addTextPlaneFromRec(tp) {
  const zoneRoot = _getZoneRoot();
  if (!zoneRoot) return null;
  const params = {
    text: tp.text ?? TEXTPLANE_DEFAULTS.text, fontSize: tp.fontSize ?? TEXTPLANE_DEFAULTS.fontSize,
    color: tp.color || TEXTPLANE_DEFAULTS.color, panel: tp.panel || TEXTPLANE_DEFAULTS.panel,
  };
  const node = buildTextPlaneNode(params, { pos: tp.pos, rot: tp.rot, scale: tp.scale, name: tp.name, xiId: tp.xiId, stem: tp.stem });
  zoneRoot.add(node);
  _placementSet.add(node);
  const entry = { node, name: node.name, isTextPlane: true };
  _placements.push(entry);
  return entry;
}

// Re-render an editable plane in place after its text/size/colours change — cheap
// canvas swap, NO GLB (that happens at Publish). Plane geometry resizes to fit new text.
export function regenerateTextPlane(p) {
  const node = p?.node;
  const params = node?.userData?.textPlane;
  if (!params) return;
  for (const c of [...node.children]) { _disposeSubtree(c); node.remove(c); }
  node.add(buildTextPlaneMesh(params));
  const selected = _getSelected();
  if (selected === p) { _rebuildSelectionOutline(); _updateSelectionOutline(); }
  _markChange(node);
  _updateChangesUI();
}

// Serialize the editable text planes for the change-set (own array, like markers).
export function collectTextPlanes() {
  const trs = (v) => [+v.x.toFixed(6), +v.y.toFixed(6), +v.z.toFixed(6)];
  return _placements.filter((p) => p.isTextPlane).map((p) => {
    const n = p.node, tp = n.userData.textPlane || {};
    return {
      name: p.name, stem: n.userData.textStem || null, xiId: n.userData.xiId || null,
      text: tp.text, fontSize: tp.fontSize, color: tp.color, panel: tp.panel,
      pos: trs(n.position), rot: trs(n.rotation), scale: trs(n.scale),
    };
  });
}

// Bulk show/hide all editable text planes (TEXT tab Show/Hide).
export function setTextVisibility(visible) {
  for (const p of _placements) {
    if (!p.isTextPlane) continue;
    p.node.visible = visible;
    const cb = p.li?.querySelector('input.vis');
    if (cb) cb.checked = visible;
  }
}

// Publish-time: discard any previously-baked text GLBs and re-bake one per editable
// plane at its live transform, injected through the glbImport add path.
export async function rebuildTextBakes() {
  const zoneRoot = _getZoneRoot();
  for (const p of _placements.filter((q) => q.isTextBaked)) {
    p.node.parent?.remove(p.node);
    _disposeSubtree(p.node);
    const i = _placements.indexOf(p); if (i >= 0) _placements.splice(i, 1);
    _placementSet.delete(p.node);
    _addedEntries.delete(p);
  }
  for (const p of _placements.filter((q) => q.isTextPlane)) {
    const params = p.node.userData.textPlane;
    const stem = _textStem(p.node);
    let buf, wrap;
    try { buf = await buildTextPlaneGlb(params, stem); wrap = await _loadGlbWrap(buf); }
    catch (e) { console.error('[text bake]', e); continue; }
    const file = new File([buf], `${stem}.glb`);
    const node = new THREE.Group();
    node.rotation.order = 'ZYX';
    node.add(wrap);
    node.position.copy(p.node.position);
    node.quaternion.copy(p.node.quaternion);
    node.scale.copy(p.node.scale);
    node.updateMatrix();
    node.visible = false;   // auto-hidden — the editable plane already renders at this spot
    const meshId = _xiName(stem);
    node.name = _uniquePlacementName(meshId);
    node.userData = {
      xiId: _newXiId(),
      placement: { meshId },
      addName: meshId,
      glbImport: { fileName: file.name, sourcePath: null, file, lit: false, shade: 1.0, opaque: true, doubleSided: true },
      textBakeOf: p.node.userData.xiId || null,
      original: { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() },
    };
    const entry = { node, name: node.name, isTextBaked: true };
    zoneRoot.add(node);
    _placementSet.add(node);
    _placements.push(entry);
    _addedEntries.add(entry);
    _markChange(node);
  }
  _buildObjectList();
}

// Update the text-plane detail panel to reflect the currently selected sign.
export function updateTextPlaneDetailsPanel() {
  if (!textPlanePanel) return;
  const tp = _getSelected()?.node?.userData?.textPlane;
  if (!tp) { textPlanePanel.classList.remove('open'); return; }
  textPlanePanel.classList.add('open');
  if (tpText)    tpText.value              = tp.text ?? '';
  if (tpSize)    tpSize.value              = String(tp.fontSize ?? 64);
  if (tpSizeVal) tpSizeVal.textContent     = String(tp.fontSize ?? 64);
  if (tpColor)   tpColor.value             = tp.color || '#ffffff';
  if (tpPanel)   tpPanel.value             = tp.panel || '#1b1b22';
}

// Edit a text-plane field, then re-bake. Text re-bakes are debounced (typing);
// colour/size re-bake promptly.
let _tpRegenTimer = null;
function _tpApply(partial, immediate = false) {
  const p = _getSelected();
  const tp = p?.node?.userData?.textPlane; if (!tp) return;
  Object.assign(tp, partial);
  clearTimeout(_tpRegenTimer);
  const run = () => { if (_getSelected() === p && p.node.userData.textPlane === tp) regenerateTextPlane(p); };
  if (immediate) run(); else _tpRegenTimer = setTimeout(run, 250);
}
