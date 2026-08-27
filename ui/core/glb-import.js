// glb-import.js — GLB import pipeline, mesh naming helpers, and paste commit wiring.
// Extracted from main.js.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { trsMatrix, fileToBase64 } from '../editor/utils.js';
import { bridgeCall, bridgeOnline } from '../ffxi/bridge.js';
import { pushCommand } from '../editor/undo-redo.js';
import { addedEntries, markChange } from '../editor/changes-tracker.js';
import { saveGlbSrcPath, lookupGlbSrcPath } from '../editor/settings.js';
import { workspacePath } from '../panels/projects-launcher.js';
import {
  parseZone, isSkyName,
} from '../ffxi/zone.js';
import {
  parseEffects, describeSurface, describeEmitter, describePointLight, decodeBlend,
} from '../ffxi/effects.js';
import { ParticleEmitter } from '../ffxi/particle_runtime.js';
import { parseAllEffects } from '../ffxi/particle_effects.js';

// ── deps (injected by initGlbImport) ─────────────────────────────────────────
let _deps = {};

export function initGlbImport(deps) {
  _deps = deps;
}

// Shorthand accessors
const _scene           = () => _deps.getScene();
const _camera          = () => _deps.getCamera();
const _zoneRoot        = () => _deps.getZoneRoot();
const _placements      = () => _deps.getPlacements();
const _placementSet    = () => _deps.getPlacementSet();
const _selectedSet     = () => _deps.getSelectedSet();
const _transform       = () => _deps.getTransform();
const _currentZoneUrl  = () => _deps.getCurrentZoneUrl();
const _launcherState   = () => _deps.getLauncherState();
const _selected        = () => _deps.getSelected();

// ── ID generators ─────────────────────────────────────────────────────────────

export function newXiId() {
  try { return 'cx' + crypto.randomUUID().replace(/-/g, '').slice(0, 12); } catch {}
  return 'cx' + Math.random().toString(16).slice(2, 10) + _placements().length.toString(16);
}

// Per-INSTANCE identity, distinct from xiId. xiId is a GROUP key shared across copies
// (the backend places every copy under one resolved mesh name); a uid is unique to one node.
export function newUid() {
  try { return 'ix' + crypto.randomUUID().replace(/-/g, '').slice(0, 12); } catch {}
  return 'ix' + Math.random().toString(16).slice(2, 10) + _placements().length.toString(16);
}

// A lightweight, clone-safe GLB reference (no File/handle — those don't survive a structured
// clone). Every instance of an imported mesh carries one so ANY instance can serve as the
// inject source on publish — deleting the original import node no longer orphans its copies.
export function lightGlbRef(src) {
  const g = src?.userData?.glbImport;
  if (!g) return undefined;
  return { fileName: g.fileName, sourcePath: g.sourcePath, origin: g.origin, opaque: !!g.opaque, lit: !!g.lit, shade: g.shade ?? 1.0 };
}

// The xi-namespaced mesh name an editor-added object will be PUBLISHED as — mirrors Python
// _xi_prefixed (xi_apply_changes.py). Namespaces with xi but PRESERVES a leading '_'/'#'
// (the retail client enables alpha-test / foliage cutout only when byte[0] is '_'), so
// '_jag_w02_m' -> '_xi_jag_w02_m', 'foo' -> 'xi_foo'. Idempotent; truncates to 16 bytes.
export function xiName(name) {
  const s = (name || '');
  if (s.startsWith('xi_') || s.startsWith('_xi_') || s.startsWith('#xi_')) return s.slice(0, 16);
  const c = s[0];
  if (c === '_' || c === '#') return (c + 'xi_' + s.slice(1)).slice(0, 16);
  return ('xi_' + s).slice(0, 16);
}

// The xi-namespaced name BEFORE the 16-byte clamp — used only to detect whether xiName()
// would have to truncate (the source of the byakko_statue_base / _pillar collision).
function xiNameFull(name) {
  const s = (name || '');
  if (s.startsWith('xi_') || s.startsWith('_xi_') || s.startsWith('#xi_')) return s;
  const c = s[0];
  if (c === '_' || c === '#') return c + 'xi_' + s.slice(1);
  return 'xi_' + s;
}

function _randTail(n) {
  const A = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

// Allocate the <=16-byte stored mesh name for a FRESH GLB import. Returns { name, renamed }.
export function importMeshName(base, takenIds = new Set()) {
  const full = xiNameFull(base);
  if (full.length <= 16) return { name: xiName(base), renamed: false };
  const c = base[0];
  const pfx = (c === '_' || c === '#') ? c + 'xi_' : 'xi_';
  const src = (c === '_' || c === '#') ? base.slice(1) : base;
  const stemBudget = Math.max(1, 16 - pfx.length - 1 - 5);
  const stem = (src.slice(0, stemBudget).replace(/_+$/, '') || src.slice(0, 1));
  let name;
  do { name = `${pfx}${stem}_${_randTail(5)}`.slice(0, 16); } while (takenIds.has(name));
  return { name, renamed: true };
}

// ── GLB loader (module-level singleton) ───────────────────────────────────────
export const gltfLoader = new GLTFLoader();

// ── GLB helpers ───────────────────────────────────────────────────────────────

// Live preview of a GLB import's shade (brightness) + opaque (alpha) on its editor material.
export function applyGlbPreview(node) {
  const g = node.userData.glbImport; if (!g) return;
  const shade = g.lit ? (g.shade ?? 1.0) : 1.0;
  node.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if (o.material.color?.setScalar) o.material.color.setScalar(shade);
    o.material.transparent = !g.opaque;
    o.material.needsUpdate = true;
  });
}

// Resolve a GLB import's absolute Origin path.
export function glbOriginOf(g) {
  if (!g) return '';
  const currentZoneUrl = _currentZoneUrl();
  return g.origin || g.sourcePath
    || (currentZoneUrl && g.fileName ? lookupGlbSrcPath(currentZoneUrl, g.fileName) : '')
    || '';
}

// Filesystem-safe workspace folder name for a zone.
export function glbWorkspaceKey(url) {
  const rel = (url || '').replace(/^game(?:-hd)?\//, '');
  const last = rel.split('/').pop() || '';
  const stem = last.includes('.') ? rel.slice(0, rel.lastIndexOf('.')) : rel;
  return stem.replace(/[\\/]/g, '_');
}

// Absolute path of a GLB import's project-folder copy.
export function glbFilePathOf(fileName) {
  if (!fileName) return '';
  const launcherState = _launcherState();
  const base = (launcherState.currentProject && !launcherState.browseOnly) ? workspacePath().replace(/[\\/]+$/, '') : '';
  const currentZoneUrl = _currentZoneUrl();
  const key = glbWorkspaceKey(currentZoneUrl);
  if (!base || !launcherState.currentProject?.id || !key) return fileName;
  const sep = base.includes('\\') ? '\\' : '/';
  return [base, launcherState.currentProject.id, key, fileName].join(sep);
}

export function updateGlbDetailsPanel() {
  if (typeof _deps.updateTextPlaneDetailsPanel === 'function') _deps.updateTextPlaneDetailsPanel();
  const glbDetailsPanel = document.getElementById('glb-details');
  if (!glbDetailsPanel) return;
  const sel = _selected();
  if (sel?.node?.userData?.textPlane) { glbDetailsPanel.classList.remove('open'); return; }
  const g = sel?.node?.userData?.glbImport;
  if (!g) { glbDetailsPanel.classList.remove('open'); return; }
  glbDetailsPanel.classList.add('open');
  const glbUuid      = document.getElementById('glb-uuid');
  const glbName      = document.getElementById('glb-name');
  const glbFile      = document.getElementById('glb-file');
  const glbOriginEl  = document.getElementById('glb-origin');
  const glbAdded     = document.getElementById('glb-added');
  const glbShade     = document.getElementById('glb-shade');
  const glbShadeVal  = document.getElementById('glb-shade-val');
  const glbShadeRow  = document.getElementById('glb-shade-row');
  const glbLit       = document.getElementById('glb-lit');
  const glbOpaque    = document.getElementById('glb-opaque');
  const glbTwoSided  = document.getElementById('glb-two-sided');
  if (glbUuid) glbUuid.textContent = sel.node.userData.xiId || '—';
  const fileName = g.fileName || (g.sourcePath || '').split(/[\\/]/).pop() || '';
  if (glbName) glbName.textContent = fileName || '—';
  if (glbFile) {
    const filePath = glbFilePathOf(fileName);
    glbFile.textContent = filePath || '—';
    glbFile.dataset.path = filePath;
    glbFile.title = filePath
      ? `GLB copied into the project folder — the publish source; click to copy\n${filePath}`
      : '';
  }
  if (glbOriginEl) {
    const origin = glbOriginOf(g);
    glbOriginEl.textContent = origin || '— not linked';
    glbOriginEl.dataset.path = origin;
    glbOriginEl.title = origin
      ? `source GLB this links to — Refresh copies it back over the project file; click to copy\n${origin}`
      : 'no Origin linked — use "Link to new Origin" to point at a GLB on disk';
  }
  if (glbAdded) {
    const ts = sel.node.userData.changeTs;
    glbAdded.textContent = ts ? new Date(ts).toLocaleString() : '—';
  }
  const shade = g.shade ?? 1.0;
  if (glbLit) glbLit.checked = !!g.lit;
  if (glbShadeRow) glbShadeRow.style.display = g.lit ? '' : 'none';
  if (glbShade) glbShade.value = String(shade);
  if (glbShadeVal) glbShadeVal.textContent = shade.toFixed(2);
  if (glbOpaque) glbOpaque.checked = !!g.opaque;
  if (glbTwoSided) glbTwoSided.checked = !!g.doubleSided;
}

// Display name for a placement: bare <meshId> for the first instance, then <meshId>.NNN.
export function uniquePlacementName(meshId, taken = null) {
  const existing = new Set(_placements().map((p) => p.node.name));
  if (taken) for (const n of taken) existing.add(n);
  if (!existing.has(meshId)) return meshId;
  let c = 1, name;
  do { name = `${meshId}.${String(c).padStart(3, '0')}`; c++; } while (existing.has(name));
  return name;
}

export function effectSourcePrefix(sourceDatRel) {
  const rel = (sourceDatRel || '').replace(/\\/g, '/').replace(/^game(-hd)?\//i, '').trim();
  if (!rel) return 'copied';
  return rel.replace(/\.dat$/i, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

export function pastedEffectName(label, id, sourceDatRel) {
  const base = (label || 'effect').replace(/^XI\s+/i, '').trim();
  const prefix = effectSourcePrefix(sourceDatRel);
  return uniquePlacementName(`${prefix} ${base}${id ? ` [${id}]` : ''}`);
}

export async function buildSourceEffectPreviewNode(sourceDatRel, effectId, sourceOffset = null) {
  const scene  = _scene();
  const camera = _camera();
  const datUrl = _deps.datUrl;
  const [srcBuf, srcKt] = await Promise.all([
    fetch(datUrl(`game/${sourceDatRel}`)).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }),
    _deps.getKeyTables(),
  ]);
  const srcParsed = parseZone(srcBuf, srcKt);
  const srcTexMap = _deps.buildTextures(srcParsed.textures);
  const srcTemplates = _deps.buildMeshTemplates(srcParsed.meshes, srcTexMap);
  const effects = parseEffects(srcBuf);
  const runtimeEffects = parseAllEffects(srcBuf);
  let gen = null;
  if (sourceOffset != null) {
    const off = Number(sourceOffset);
    if (Number.isFinite(off)) gen = runtimeEffects.generators.find((g) => g.id === effectId && g.start === off) || null;
  }
  if (!gen) {
    const matches = runtimeEffects.generators.filter((g) => g.id === effectId);
    gen = matches[0] || null;
  }
  if (!gen) return null;

  let node = null;
  const simpleGen = effects.generators.find((g) => g.id === effectId && (sourceOffset == null || g.sourceOffset === Number(sourceOffset))) || effects.generators.find((g) => g.id === effectId) || null;
  const light = simpleGen ? describePointLight(simpleGen) : null;
  if (light) {
    node = new THREE.Group();
    node.renderOrder = 12000;
    trsMatrix(light.position, [0, 0, 0], [1, 1, 1]).decompose(node.position, node.quaternion, node.scale);
    node.userData.effect = { mesh: 'point light', sectionId: effectId, sourceOffset: light.sourceOffset, lighting: true, fog: false };
    _deps.addPointLightEffect(node, light);
    node.rotation.order = 'ZYX';
    return node;
  }

  const surf = simpleGen ? describeSurface(simpleGen) : null;
  const emitter = simpleGen ? describeEmitter(simpleGen) : null;
  const desc = (surf && !surf.hasEmission) ? { type: 'StaticMesh', meshLink: surf.meshLink, position: surf.position, sectionId: surf.sectionId, sourceOffset: surf.sourceOffset }
    : emitter;
  const meshName = desc ? (desc.type === 'StaticMesh' ? srcParsed.meshIdToName.get(desc.meshLink) : desc.meshLink) : null;
  if (meshName && (isSkyName(meshName) || _deps.isLegacyZoneEnvMesh(meshName))) {
    if (surf && !surf.hasEmission && desc.type === 'StaticMesh' && srcTemplates.has(meshName)) {
      const b = decodeBlend(surf.blend);
      const tuned = _deps.tuneSurfaceForEditor(meshName, surf, b.blendFunc);
      const discard = tuned.blendFunc === 'One_Zero' ? 0 : (meshName.startsWith('_') ? 0.375 : (tuned.depthMask ? 0.01 : 0));
      const opts = { blendFunc: tuned.blendFunc, depthMask: tuned.depthMask,
        ignoreAlpha: surf.ignoreTextureAlpha, discard, lightingEnabled: surf.lightingEnabled, fogEnabled: tuned.fogEnabled };
      node = new THREE.Group();
      node.renderOrder = 10000 + tuned.renderBias;
      for (const { geometry, texKey } of srcTemplates.get(meshName)) {
        const mat = _deps.makeParticleMaterial(texKey ? srcTexMap.get(texKey) : null, tuned.color, opts);
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.renderOrder = node.renderOrder;
        node.add(mesh);
      }
      trsMatrix(surf.position, surf.rotation, surf.scale).decompose(node.position, node.quaternion, node.scale);
      node.userData.effect = { mesh: meshName, sectionId: effectId, sourceOffset: surf.sourceOffset, specular: surf.specular, lighting: surf.lightingEnabled, fog: surf.fogEnabled };
      node.rotation.order = 'ZYX';
      return node;
    }
    return null;
  }

  const root = new THREE.Group();
  root.rotation.order = 'ZYX';
  const basePos = desc?.position || [0, 0, 0];
  root.position.set(basePos[0] || 0, basePos[1] || 0, basePos[2] || 0);
  const effectMesh = meshName || effectId;
  root.userData.effect = { mesh: effectMesh, sectionId: effectId, sourceOffset: gen.start };
  const em = new ParticleEmitter(gen, runtimeEffects, scene, camera, root);
  em.meshGroup.position.set(-(basePos[0] || 0), -(basePos[1] || 0), -(basePos[2] || 0));
  root.userData.vfxEmitter = em;
  node = root;
  node.rotation.order = 'ZYX';
  return node;
}

// Shared undo/redo wiring for paste paths (and GLB drop / mob place / asset-browser place).
export function commitPastedItems(items, statusMsg) {
  if (!items.length) return;
  const selectionEl = document.getElementById('selection');
  const add = () => {
    _deps.select(null);
    for (const { node, entry, parent } of items) {
      parent.add(node);
      if (!_placements().includes(entry)) _placements().push(entry);
      _placementSet().add(node);
      addedEntries.add(entry);
      markChange(node);
    }
    _deps.buildObjectList();
    for (const { entry } of items) _deps.select(entry, true);
    _deps.updateChangesUI?.();
  };
  const remove = () => {
    for (const { node, entry } of items) {
      if (_transform().object === node) _transform().detach();
      node.parent?.remove(node);
      const i = _placements().indexOf(entry); if (i >= 0) _placements().splice(i, 1);
      _placementSet().delete(node);
      addedEntries.delete(entry);
      _selectedSet().delete(entry);
    }
    const sel = _deps.lastSelectedEntry();
    if (sel && !_deps.isLocked(sel)) _transform().attach(sel.node);
    else {
      _transform().detach();
      if (!sel) {
        if (selectionEl) selectionEl.textContent = 'nothing selected';
        _deps.clearSelectionOutline();
        _deps.updateSelectionOutline();
      }
    }
    _deps.rebuildSelectionOutline(); _deps.updateSelectionReadout(); _deps.updateSelectionOutline();
    _deps.buildObjectList();
    _deps.updateChangesUI?.();
  };
  add();
  pushCommand({ undo: remove, redo: add });
  _deps.setStatus(statusMsg);
}

// ── GLB node builders ─────────────────────────────────────────────────────────

// Build a Three.js placement node from a GLB file + a JSON change record's TRS.
// Used by loadChangesFromJson to replay GLB adds without placing at camera position.
export async function buildGlbNode(file, rec, reserved = null) {
  const zoneRoot = _zoneRoot();
  const currentZoneUrl = _currentZoneUrl();
  const gltf = await gltfLoader.parseAsync(await file.arrayBuffer(), '');
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const src = Array.isArray(o.material) ? o.material[0] : o.material;
    o.material = new THREE.MeshBasicMaterial({
      map: src.map || null,
      color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
      transparent: !!src.transparent, opacity: src.opacity ?? 1,
      alphaTest: src.alphaTest || 0, side: THREE.DoubleSide,
    });
  });
  const wrap = new THREE.Group();
  wrap.quaternion.copy(zoneRoot.quaternion);
  wrap.scale.copy(zoneRoot.scale);
  wrap.add(gltf.scene);
  const pnode = new THREE.Group();
  pnode.rotation.order = 'ZYX';
  pnode.add(wrap);
  trsMatrix(rec.pos || [0, 0, 0], rec.rot || [0, 0, 0], rec.scale || [1, 1, 1])
    .decompose(pnode.position, pnode.quaternion, pnode.scale);
  pnode.updateMatrix();
  pnode.name = uniquePlacementName(xiName(rec.name), reserved);
  if (reserved) reserved.add(pnode.name);
  pnode.userData = {
    xiId: rec.xiId,
    placement: { meshId: rec.name },
    addName: rec.name,
    glbImport: { fileName: file.name, sourcePath: lookupGlbSrcPath(currentZoneUrl, file.name), origin: rec.glbOrigin || lookupGlbSrcPath(currentZoneUrl, file.name) || null, lit: !!rec.lit, shade: rec.shade ?? 1.0, opaque: !!rec.opaque, doubleSided: !!rec.doubleSided },
    original: { p: pnode.position.clone(), q: pnode.quaternion.clone(), s: pnode.scale.clone() },
  };
  if (rec.textPlane) pnode.userData.textPlane = rec.textPlane;
  applyGlbPreview(pnode);
  return pnode;
}

// Ask the user to select GLB files via system picker.
export async function pickGlbSource(needed) {
  if (window.showDirectoryPicker) {
    try {
      return { kind: 'dir', handle: await window.showDirectoryPicker({ mode: 'read' }) };
    } catch { return null; }
  }
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.glb,.gltf'; inp.multiple = true;
    inp.addEventListener('change', () => resolve({ kind: 'files', files: inp.files }));
    inp.addEventListener('cancel', () => resolve(null));
    inp.click();
  });
}

// Build the display wrap for a GLB's bytes: unlit, double-sided materials.
export async function loadGlbWrap(arrayBuffer) {
  const zoneRoot = _zoneRoot();
  const gltf = await gltfLoader.parseAsync(arrayBuffer, '');
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const src = Array.isArray(o.material) ? o.material[0] : o.material;
    o.material = new THREE.MeshBasicMaterial({
      map: src.map || null,
      color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
      transparent: !!src.transparent,
      opacity: src.opacity ?? 1,
      alphaTest: src.alphaTest || 0,
      side: THREE.DoubleSide,
    });
  });
  const wrap = new THREE.Group();
  wrap.quaternion.copy(zoneRoot.quaternion);
  wrap.scale.copy(zoneRoot.scale);
  wrap.add(gltf.scene);
  return wrap;
}

// Dispose the geometry/material/textures of a subtree (avoid GPU leaks on mesh swap).
export function disposeSubtree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose?.();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.map?.dispose?.(); m.dispose?.(); });
  });
}

// Pick a GLB on disk and set it as the selected import's Origin.
export async function linkGlbOrigin() {
  const sel = _selected();
  const g = sel?.node?.userData?.glbImport;
  if (!g) { _deps.setStatus('select a GLB import first', true); return; }
  if (!bridgeOnline()) { _deps.setStatus('Link to Origin needs the backend online.', true); return; }
  let res;
  try { res = await bridgeCall('zone.pickGlb', {}); }
  catch (e) { _deps.setStatus(`pick failed: ${e.message}`, true); return; }
  if (!res || res.cancelled) { _deps.setStatus(''); return; }
  if (!res.ok || !res.path) { _deps.setStatus('no file path returned from the picker', true); return; }
  g.origin = res.path;
  const currentZoneUrl = _currentZoneUrl();
  if (currentZoneUrl && g.fileName) saveGlbSrcPath(currentZoneUrl, g.fileName, res.path);
  updateGlbDetailsPanel();
  _deps.updateChangesUI();
  _deps.setStatus(`linked origin: ${res.path}`);
}

export async function refreshGlbModel(p) {
  const node = p?.node;
  const g = node?.userData?.glbImport;
  if (!g) { _deps.setStatus('not a GLB import', true); return; }
  const origin = glbOriginOf(g);
  if (!origin) { _deps.setStatus('No Origin linked — use "Link to new Origin" first.', true); return; }
  if (!bridgeOnline()) { _deps.setStatus('Refresh needs the backend online.', true); return; }
  _deps.setStatus(`refreshing ${node.name} from origin…`);

  let bytes = null;
  try {
    const a = await bridgeCall('zone.getAsset', { glb: origin });
    if (a && a.ok && a.bytesBase64) {
      const bin = atob(a.bytesBase64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      bytes = u.buffer;
    }
  } catch (e) { console.warn('[refresh glb] origin read failed', e); }
  if (!bytes) { _deps.setStatus(`Origin file missing: ${origin}`, true); return; }

  const bare = g.fileName || origin.split(/[\\/]/).pop();
  const currentZoneUrl = _currentZoneUrl();
  if (currentZoneUrl && bare) {
    try {
      const b64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
      await bridgeCall('zone.putAsset', { zone: currentZoneUrl, name: bare, bytesBase64: b64 });
    } catch (e) { console.warn('[refresh glb] workspace copy failed', e); }
  }

  let wrap;
  try { wrap = await loadGlbWrap(bytes); }
  catch (e) { console.error('[refresh glb]', e); _deps.setStatus(`Refresh failed: ${e.message}`, true); return; }
  for (const c of [...node.children]) { disposeSubtree(c); node.remove(c); }
  node.add(wrap);
  applyGlbPreview(node);
  const sel = _selected();
  if (sel === p) { _deps.rebuildSelectionOutline(); _deps.updateSelectionOutline(); }

  _deps.setStatus(`refreshed ${node.name} from ${origin}`);
}

// Import via the File System Access API (keeps re-readable handle for Refresh).
export async function importGlbViaPicker() {
  if (bridgeOnline()) {
    try {
      const res = await bridgeCall('zone.pickGlb', {});
      if (res && res.cancelled) return;
      if (res && res.ok) {
        let bytesBase64 = res.bytesBase64 || null;
        if (!bytesBase64 && res.path) {
          const asset = await bridgeCall('zone.getAsset', { glb: res.path });
          if (asset?.ok && asset.bytesBase64) bytesBase64 = asset.bytesBase64;
        }
        if (!bytesBase64) {
          _deps.setStatus(`Could not read selected GLB${res.path ? `: ${res.path}` : ''}`, true);
          return;
        }
        const bin = atob(bytesBase64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await importGlbModel(new File([bytes], res.name || 'model.glb'), null, res.path || null);
        return;
      }
    } catch (e) { console.warn('[import glb] native dialog unavailable — using browser picker', e); }
  }
  if (!window.showOpenFilePicker) { document.getElementById('glb-file-input')?.click(); return; }
  let handles;
  try {
    handles = await window.showOpenFilePicker({ multiple: true,
      types: [{ description: 'glTF model', accept: { 'model/gltf-binary': ['.glb'], 'model/gltf+json': ['.gltf'] } }] });
  } catch { return; }
  for (const h of handles) { try { await importGlbModel(await h.getFile(), h); } catch (e) { console.error('[import glb]', e); } }
}

// FFXI-space point ~10 units in front of the camera (where fresh imports/pastes land).
export function inFrontOfCamera() {
  const camera = _camera();
  const zoneRoot = _zoneRoot();
  const p = camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(10));
  zoneRoot.worldToLocal(p);
  return p;
}

export async function importGlbModel(file, handle = null, sourcePath = null) {
  const zoneRoot = _zoneRoot();
  const currentZoneUrl = _currentZoneUrl();
  if (!zoneRoot) { _deps.setStatus('load a zone first', true); return; }

  const base = file.name.replace(/\.(glb|gltf)$/i, '').replace(/[^A-Za-z0-9_]/g, '_');
  const takenIds = new Set(_placements().map((p) => p.node?.userData?.placement?.meshId).filter(Boolean));
  const { name: meshId, renamed } = importMeshName(base, takenIds);

  const _samePath = (a, b) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
  const _sameSource = (gi) => !!gi
    && ((sourcePath && gi.sourcePath) ? _samePath(sourcePath, gi.sourcePath)
                                      : (gi.fileName || '') === (file.name || ''));
  const prior = _placements().find((p) => !p.isMarker && !p.isSky && _sameSource(p.node.userData?.glbImport));
  if (prior) {
    const priorMeshId = prior.node.userData?.placement?.meshId || meshId;
    const node = prior.node.clone(true);
    node.rotation.order = 'ZYX';
    node.position.copy(inFrontOfCamera());
    node.quaternion.copy(prior.node.quaternion);
    node.scale.copy(prior.node.scale);
    node.updateMatrix();
    node.name = uniquePlacementName(priorMeshId);
    node.userData = { placement: { meshId: priorMeshId }, addName: priorMeshId, xiId: prior.node.userData.xiId,
      original: { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() } };
    const glbRef = lightGlbRef(prior.node);
    if (glbRef) node.userData.glbImport = glbRef;
    const entry = { node, name: node.name, isEffect: false };
    commitPastedItems([{ node, entry, parent: zoneRoot }], `placed ${node.name} (mesh already imported)`);
    _deps.setActiveTab('objs');
    _deps.focusSelected();
    return;
  }

  _deps.setStatus(`loading ${file.name}…`);
  let wrap;
  try { wrap = await loadGlbWrap(await file.arrayBuffer()); }
  catch (err) { console.error('[import glb]', err); _deps.setStatus(`GLB load failed: ${err.message}`, true); return; }

  const pnode = new THREE.Group();
  pnode.rotation.order = 'ZYX';
  pnode.add(wrap);
  pnode.position.copy(inFrontOfCamera());
  pnode.updateMatrix();

  pnode.name = uniquePlacementName(meshId);
  pnode.userData = {
    xiId: newXiId(),
    placement: { meshId },
    addName: meshId,
    glbImport: { fileName: file.name, sourcePath, origin: sourcePath || null, handle, file, lit: false, shade: 1.0, opaque: false, doubleSided: false },
    original: { p: pnode.position.clone(), q: pnode.quaternion.clone(), s: pnode.scale.clone() },
  };
  if (sourcePath && currentZoneUrl) saveGlbSrcPath(currentZoneUrl, file.name, sourcePath);

  const entry = { node: pnode, name: pnode.name, isEffect: false };
  commitPastedItems([{ node: pnode, entry, parent: zoneRoot }], `imported ${file.name} as ${pnode.name}`);
  _deps.setActiveTab('objs');
  _deps.focusSelected();
  _deps.setStatus(`imported ${pnode.name}`);
  if (renamed) {
    await _deps.xi_alert('Filename too long',
      `"${file.name}" is longer than FFXI's 16-byte mesh-name limit, so it was stored as:\n\n` +
      `    ${meshId}\n\n` +
      `(readable stem + a random tail, so it stays unique instead of colliding with other long ` +
      `names). The editor adds an "xi_" prefix, which leaves 13 characters — keep GLB filenames ` +
      `to 13 characters or fewer to keep mesh names readable and predictable.`);
  }
  if (bridgeOnline()) {
    try {
      await bridgeCall('zone.putAsset', { zone: currentZoneUrl, name: file.name, bytesBase64: await fileToBase64(file) });
    } catch (e) { console.warn('[import glb] workspace persist failed', e); }
  }
}
