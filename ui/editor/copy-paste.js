// copy-paste.js — copy/paste of placed objects, VFX, sounds, markers and mobs.
// The in-memory `clipboard` survives zone switches within the same tab; the localStorage
// XZONE_CLIP_KEY clipboard persists across zone changes and tabs.
//
// Call initCopyPaste(callbacks) once from main.js before any paste can occur.
// The callbacks parameter is a single object — see initCopyPaste for the full list.

import * as THREE from 'three';

export const XZONE_CLIP_KEY = 'xi_xzone_clip';   // cross-zone / cross-tab clipboard (localStorage)

export let clipboard   = null;  // entry snapshot for fast same-zone object paste
export let clipboardTs = 0;     // when this tab's in-memory clipboard was last set (ms).
                                // Compared against the localStorage clip's `ts` on paste so a
                                // FRESHER copy made in another tab wins.

// ── injected callbacks ────────────────────────────────────────────────────────
let _cb = null;   // set by initCopyPaste

export function initCopyPaste(callbacks) {
  // callbacks expected:
  //   getSelected()                 → current selected entry
  //   getSelectedSet()              → Set of selected entries
  //   getPlacements()               → placements array
  //   getZoneRoot()                 → THREE.Group for the zone
  //   getAddedEntries()             → Set<entry> of added (unpublished) entries
  //   getPlacementSet()             → Set<THREE.Object3D>
  //   getCollisionPrimGroup()       → the __collisionPrims group (may be null)
  //   setCollisionPrimGroup(g)      → sets it when first created
  //   getCollisionPrimMaterials()   → [] — push new prim materials into this
  //   getTemplates()                → current zone mesh templates Map
  //   getParsed()                   → parseZone result for current zone
  //   getCurrentZoneUrl()           → e.g. "game/ROM10/2/0.DAT"
  //   getMode()                     → 'edit' | 'view'
  //   getPasteOffset()              → bool (Settings → offset-on-paste)
  //   getShowCollision()            → bool
  //   getLastCanvasPointerClient()  → {x,y} | null
  //   getCanvas()                   → <canvas>
  //   getCamera()                   → THREE.PerspectiveCamera
  //   getRaycaster()                → THREE.Raycaster
  //   pushCommand({ undo, redo })
  //   markChange(node, ts?)
  //   setStatus(msg, isErr?)
  //   buildObjectList()
  //   select(entry, addToSet?)
  //   selectNull()
  //   lastSelectedEntry()
  //   isLocked(entry)
  //   getTransform()                → TransformControls instance
  //   getSelectionEl()              → #selection DOM element
  //   clearSelectionOutline()
  //   rebuildSelectionOutline()
  //   updateSelectionOutline()
  //   updateSelectionReadout()
  //   setActiveTab(name)
  //   updateChangesUI()
  //   autoGroupXiEffects()
  //   uniquePlacementName(meshId, taken?)
  //   xiName(meshId)
  //   lightGlbRef(node)
  //   newXiId()
  //   newUid()
  //   instantiate(tmplMap, meshId)
  //   buildMeshTemplates(meshes, texMap)
  //   buildTextures(textures)
  //   parseZone(buf, kt)
  //   getKeyTables()
  //   datUrl(url)
  //   resolveMeshName(meshId, meshes)
  //   groundPointAhead()
  //   // collision prim helpers:
  //   setCollisionMat(node, mat)
  //   defaultCollisionMat(type)
  //   // effect / sound helpers:
  //   buildSourceEffectPreviewNode(srcDatRel, effectId, sourceOffset?)
  //   pastedEffectName(label, id, srcDatRel)
  //   effectSourcePrefix(srcDatRel)
  //   registerPlacement(node, isEffect)
  //   setIconVisible(node, visible)
  //   addXZoneEffect(opts, isSoundGen, srcDatRel, pastePos)
  //   commitAddedSound(node, entry, statusMsg)
  //   buildMobNode(mob, pos)
  _cb = callbacks;
}

// ── copy ─────────────────────────────────────────────────────────────────────

function meshIdForEntry(e) {
  const placedMeshId = e?.node?.userData?.placement?.meshId;
  if (placedMeshId) return placedMeshId;
  if (!e || e.isEffect || e.isMarker || e.isMob || e.isSound || e.isSky || e.isTextPlane || e.isTextBaked || e.isCollisionPrimitive) return null;
  const name = e.node?.name || e.name || '';
  if (!name) return null;
  const templates = _cb.getTemplates?.();
  const meshes = _cb.getParsed?.()?.meshes;
  return (templates?.has(name) || meshes?.has(name)) ? name : null;
}

function isCopyableObject(e) {
  if (!e || e.isEffect || e.isMarker || e.isMob || e.isSound || e.isSky || e.isTextPlane || e.isTextBaked) return false;
  return !!(e.isCollisionPrimitive || meshIdForEntry(e));
}

function clearClipboard() {
  clipboard = null;
  clipboardTs = Date.now();
  try { localStorage.removeItem(XZONE_CLIP_KEY); } catch {}
}

// The in-memory clipboard holds LIVE scene nodes, so it is only usable while those nodes
// are still under the current zoneRoot. Loading another zone (or reloading this one)
// detaches + disposes the old root but leaves its children parented to it, so a stale
// entry still has a non-null `parent`: cloning it "succeeds", the clone is add()ed to that
// detached root, and the result is an object-list row with a gizmo and no visible mesh.
// When any entry is stale, paste must use the serialized cross-zone clip instead.
function clipboardIsLive() {
  const zoneRoot = _cb.getZoneRoot();
  if (!clipboard?.length || !zoneRoot) return false;
  return clipboard.every((e) => {
    for (let n = e.node; n; n = n.parent) if (n === zoneRoot) return true;
    return false;
  });
}

export function copySelected(entries = null) {
  // `entries` lets the right-click "Copy Mesh" copy the EXACT clicked object(s), independent of
  // selectedSet. Ctrl+C passes nothing and copies the live selection. Either way we overwrite the
  // clipboard, so paste can never silently fall back to a stale cross-zone clip.
  const src = entries || [..._cb.getSelectedSet()];
  const validObjs    = src.filter(isCopyableObject);
  const validFx      = src.filter(e => e.isEffect && !e.isSound && e.node.userData.effect?.sectionId);
  const validSounds  = src.filter(e => e.isSound);   // sound emitters paste as new added sounds
  const validMarkers = src.filter(e => e.isMarker);  // billboards paste from their own clip record
  const validMobs    = src.filter(e => e.isMob);     // mobs re-fetch their model + paste as new spawns
  if (!validObjs.length && !validFx.length && !validSounds.length && !validMarkers.length && !validMobs.length) {
    clearClipboard();
    _cb.setStatus('copy: select object(s), effect(s), sound(s), marker(s) or mob(s) first'); return;
  }
  clipboard = validObjs;  // in-memory copy for fast same-zone object paste
  clipboardTs = Date.now();   // stamp so a later copy in ANOTHER tab can out-rank this one on paste
  // Persist to localStorage: survives zone change + works across browser tabs.
  // Effects (VFX / sound emitters) are always pasted via this cross-zone path since
  // they need a source DAT + FourCC; the backend resolves the destination FourCC.
  try {
    const currentZoneUrl = _cb.getCurrentZoneUrl();
    const zoneName = document.getElementById('zone').selectedOptions?.[0]?.text || currentZoneUrl;
    const objItems = validObjs.map(e => {
      const n = e.node;
      return { meshId: meshIdForEntry(e), name: e.name, xiId: n.userData.xiId,
        pos: [n.position.x, n.position.y, n.position.z],
        rot: [n.rotation.x, n.rotation.y, n.rotation.z],
        scale: [n.scale.x, n.scale.y, n.scale.z] };
    }).filter(i => i.meshId);
    const fxItems = validFx.map(e => {
      const fx = e.node.userData.effect || {};
      const hasSourceTriplet = !!(e.sourceDat && e.sourceId && e.sourceOffset != null);
      return {
        isEffect: true, isSoundGen: !!e.isSound,
        // Preserve original provenance only for a fully-specified pasted clone. Otherwise,
        // derive from the native selected node so id/offset stay coherent.
        effectId: hasSourceTriplet ? e.sourceId : fx.sectionId,
        localEffectId: fx.sectionId,
        sourceDat: hasSourceTriplet ? e.sourceDat : currentZoneUrl.replace(/^game(-hd)?\//i, ''),
        sourceOffset: hasSourceTriplet ? e.sourceOffset : (fx.sourceOffset ?? null),
        effectMesh: fx.mesh ?? null,
      // Strip " [id]" and optional ".001" suffix baked into node.name — addXZoneEffect
      // re-appends the id bracket, so we must store only the label portion.
        name: e.name.replace(/\s*\[[^\]]*\](\.\d+)?$/, '').trim(),
        pos: [e.node.position.x, e.node.position.y, e.node.position.z],
      };
    });
    // Sound emitters: self-contained (soundId + position). A copied existing-zone sound pastes
    // as a brand-new added sound, which Publish writes to the zone like any dragged-in emitter.
    const soundItems = validSounds.map(e => {
      const fx = e.node.userData.effect || {};
      return { isSound: true, soundId: fx.soundId, soundFile: fx.soundFile, repeat: !!fx.repeat,
        name: e.name, pos: [e.node.position.x, e.node.position.y, e.node.position.z] };
    }).filter(i => i.soundId);
    // Markers: self-contained billboards (icon/type + full transform).
    const markerItems = validMarkers.map(e => {
      const n = e.node;
      return {
        isMarker: true,
        csIcon: n.userData.markerCsIcon || n.userData.markerIcon || 'flag',
        color: n.userData.markerColor || null,
        desc: n.userData.markerDesc || '',
        type: n.userData.markerType || 'Spawn',
        name: e.name,
        pos: [n.position.x, n.position.y, n.position.z],
        rot: [n.rotation.x, n.rotation.y, n.rotation.z],
        scale: [n.scale.x, n.scale.y, n.scale.z],
      };
    });
    // Mobs: identity (poolid/modelid) + transform; paste re-fetches the model by look.
    const mobItems = validMobs.map(e => {
      const n = e.node; const mob = n.userData.mob || {};
      return { isMob: true, poolid: mob.poolid, modelid: mob.modelid, name: mob.name || e.name,
        pos: [n.position.x, n.position.y, n.position.z],
        rot: [n.rotation.x, n.rotation.y, n.rotation.z] };
    }).filter(i => i.modelid || i.poolid);
    localStorage.setItem(XZONE_CLIP_KEY, JSON.stringify({
      sourceZoneUrl: currentZoneUrl,
      sourceZoneName: zoneName,
      ts: clipboardTs,   // same stamp as the in-memory clip — lets another tab detect a newer copy
      items: [...objItems, ...fxItems, ...soundItems, ...markerItems, ...mobItems],
    }));
  } catch {}
  const total = validObjs.length + validFx.length + validSounds.length + validMarkers.length + validMobs.length;
  _cb.setStatus(`copied ${total} item${total > 1 ? 's' : ''}`);
}

// ── clipboard summary (label for the Paste menu item) ────────────────────────

export function clipboardSummary() {
  const _sum = (names) => {
    names = (names || []).filter(Boolean);
    if (!names.length) return '';
    return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
  };
  // Mirror pasteClipboard's freshness rule: a cross-zone clip newer than this tab's in-memory
  // copy (another tab copied more recently) is what Paste will actually use, so show that.
  let clip = null;
  try { clip = JSON.parse(localStorage.getItem(XZONE_CLIP_KEY) || 'null'); } catch {}
  const xzoneNewer = clip?.items?.length && (clip.ts || 0) > clipboardTs;
  if (clipboardIsLive() && !xzoneNewer) return _sum(clipboard.map(e => e.name || e.node?.userData?.placement?.meshId));
  if (clip?.items?.length) {
    const s = _sum(clip.items.map(i => i.name || i.meshId));
    return s && clip.sourceZoneName ? `${s} — from ${clip.sourceZoneName}` : s;
  }
  return '';
}

// ── internal paste helpers ────────────────────────────────────────────────────

// Shared undo/redo wiring for both paste paths.
function commitPastedItems(items, statusMsg) {
  if (!items.length) return;
  const placements   = _cb.getPlacements();
  const placementSet = _cb.getPlacementSet();
  const addedEntries = _cb.getAddedEntries();
  const add = () => {
    _cb.selectNull();
    for (const { node, entry, parent } of items) {
      parent.add(node);
      if (!placements.includes(entry)) placements.push(entry);
      placementSet.add(node);
      addedEntries.add(entry);
      _cb.markChange(node);
    }
    _cb.buildObjectList();
    for (const { entry } of items) _cb.select(entry, true);
    _cb.updateChangesUI();
  };
  const remove = () => {
    for (const { node, entry } of items) {
      const transform = _cb.getTransform();
      if (transform.object === node) transform.detach();
      node.parent?.remove(node);
      const i = placements.indexOf(entry); if (i >= 0) placements.splice(i, 1);
      placementSet.delete(node);
      addedEntries.delete(entry);
      _cb.getSelectedSet().delete(entry);
    }
    const sel = _cb.lastSelectedEntry();
    const transform = _cb.getTransform();
    if (sel && !_cb.isLocked(sel)) transform.attach(sel.node);
    else {
      transform.detach();
      if (!sel) { _cb.getSelectionEl().textContent = 'nothing selected'; _cb.clearSelectionOutline(); _cb.updateSelectionOutline(); }
    }
    _cb.rebuildSelectionOutline(); _cb.updateSelectionReadout(); _cb.updateSelectionOutline();
    _cb.buildObjectList();
    _cb.updateChangesUI();
  };
  add();
  _cb.pushCommand({ undo: remove, redo: add });
  _cb.setStatus(statusMsg);
}

// Paste the effect (VFX/SFX) items from a clip at the cursor (or their source position).
// Effects live only in localStorage (never the in-memory clipboard) and are always pasted via
// addXZoneEffect, which records source_dat/source_id so Publish does the proven cross-DAT copy.
// Returns the number pasted. Shared by the same-zone (pasteClipboard) and cross-zone paths.
async function _pasteEffectItems(effectItems, srcDatRel, cursorLocal) {
  const zoneRoot = _cb.getZoneRoot();
  if (!effectItems?.length || !zoneRoot) return 0;
  const pastePos = cursorLocal ? [cursorLocal.x, cursorLocal.y, cursorLocal.z] : null;
  const currentRel = (_cb.getCurrentZoneUrl() || '').replace(/^game(-hd)?\//i, '');
  const sameZoneSrc = srcDatRel === currentRel;
  const nudge = new THREE.Vector3(1, 0, 1);
  const pastedEntries = [];
  const placements = _cb.getPlacements();
  const addedEntries = _cb.getAddedEntries();
  for (const fx of effectItems) {
    const publishSourceDat = fx.sourceDat || srcDatRel;
    const publishSourceId = fx.effectId;
    const publishSourceOffset = fx.sourceOffset ?? null;
    const localEffectId = fx.localEffectId || fx.effectId;
    const srcEntry = sameZoneSrc
      ? placements.find((p) => p.isEffect && p.node.userData.effect?.sectionId === localEffectId)
      : null;
    if (srcEntry) {
      const src = srcEntry.node;
      const node = src.clone(true);
      node.rotation.order = 'ZYX';
      node.position.copy(pastePos ? new THREE.Vector3(...pastePos) : src.position.clone().add(nudge));
      node.quaternion.copy(src.quaternion);
      node.scale.copy(src.scale);
      node.name = _cb.pastedEffectName(fx.name, fx.effectId, publishSourceDat);
      node.userData = { ...src.userData, effect: { ...src.userData.effect } };
      zoneRoot.add(node);
      _cb.registerPlacement(node, true);
      node.visible = true;
      _cb.setIconVisible(node, true);
      const entry = placements[placements.length - 1];
      entry.name = node.name;
      entry.sourceDat = publishSourceDat;
      entry.sourceId = publishSourceId;
      entry.sourceOffset = publishSourceOffset;
      addedEntries.add(entry);
      _cb.markChange(node);
      pastedEntries.push(entry);
      continue;
    }
    const cleanName = (fx.name || 'effect').replace(/^XI\s+/i, '').trim();
    let entry = null;
    try {
      const node = await _cb.buildSourceEffectPreviewNode(publishSourceDat, publishSourceId, publishSourceOffset);
      if (node) {
        node.name = _cb.pastedEffectName(cleanName, publishSourceId, publishSourceDat);
        if (pastePos) node.position.set(pastePos[0], pastePos[1], pastePos[2]);
        else if (Array.isArray(fx.pos)) node.position.set(fx.pos[0], fx.pos[1], fx.pos[2]);
        zoneRoot.add(node);
        _cb.registerPlacement(node, true);
        node.visible = true;
        _cb.setIconVisible(node, true);
        entry = placements[placements.length - 1];
        entry.name = node.name;
        entry.sourceDat = publishSourceDat;
        entry.sourceId = publishSourceId;
        entry.sourceOffset = publishSourceOffset;
        addedEntries.add(entry);
        _cb.markChange(node);
      }
    } catch (e) {
      console.warn('[vfx paste] source preview failed:', publishSourceDat, publishSourceId, e);
      _cb.setStatus(`VFX preview failed for ${publishSourceId} from ${publishSourceDat}: ${e.message}`, true);
    }
    if (!entry) entry = _cb.addXZoneEffect({ id: publishSourceId, sourceOffset: publishSourceOffset, label: `${_cb.effectSourcePrefix(publishSourceDat)} ${cleanName}`, mesh: fx.effectMesh, pos: fx.pos }, fx.isSoundGen, publishSourceDat, pastePos || fx.pos);
    if (entry) pastedEntries.push(entry);
  }
  _cb.buildObjectList();
  if (pastedEntries.length) {
    _cb.setActiveTab('vfx');
    _cb.selectNull();
    for (const entry of pastedEntries) _cb.select(entry, pastedEntries.length > 1);
    _cb.updateSelectionReadout();
    _cb.updateSelectionOutline();
    const last = pastedEntries[pastedEntries.length - 1];
    if (last?.li) last.li.scrollIntoView({ block: 'nearest' });
  }
  if (_cb.autoGroupXiEffects()) _cb.buildObjectList();
  _cb.updateChangesUI();
  return effectItems.length;
}

// Markers and sound emitters are fully self-describing (icon/soundId + transform), so they paste
// straight from the clip — no source DAT or FourCC resolution needed. Shared by both paste paths.
// Returns the number pasted. Each lands at the cursor (fanned out so multi-paste doesn't overlap),
// or at its original position + nudge when there's no cursor point.
async function _pasteSelfContainedItems(clipItems, cursorLocal) {
  const zoneRoot = _cb.getZoneRoot();
  const markerClips = (clipItems || []).filter(i => i.isMarker);
  const soundClips  = (clipItems || []).filter(i => i.isSound);
  const mobClips    = (clipItems || []).filter(i => i.isMob);
  if (!zoneRoot || (!markerClips.length && !soundClips.length && !mobClips.length)) return 0;
  const base = cursorLocal ? new THREE.Vector3(cursorLocal.x, cursorLocal.y, cursorLocal.z) : null;
  const nudge = new THREE.Vector3(1, 0, 1);
  const placePos = (clipPos, i) => base
    ? base.clone().addScaledVector(nudge, i)
    : new THREE.Vector3(...(clipPos || [0, 0, 0])).add(nudge);
  let n = 0;

  // Markers — exported wholesale (collectMarkerChanges), so commit as one undoable batch.
  if (markerClips.length) {
    let mg = _cb.getMarkerGroup();
    if (!mg) {
      mg = new THREE.Group();
      mg.name = '__markers';
      zoneRoot.add(mg);
      _cb.setMarkerGroup(mg);
    }
    const items = [];
    for (let i = 0; i < markerClips.length; i++) {
      const m = markerClips[i];
      const glyph = m.csIcon || (typeof m.icon === 'string' && !/^\d+$/.test(String(m.icon)) ? m.icon
        : ({ 1: 'flag', 2: 'person', 3: 'swords', 4: 'deployed_code', 5: 'sensor_door',
             6: 'star', 7: 'location_on', 8: 'route', 9: 'pets', 10: 'volume_up' }[Number(m.icon)] || 'flag'));
      const col = m.color || '#42d9c8';
      const tex = _cb.getPinTexture ? _cb.getPinTexture(col, glyph) : await _cb.getMarkerTexture(glyph);
      const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true, sizeAttenuation: true });
      const sprite = new THREE.Sprite(mat);
      sprite.center.set(0.5, 0);
      sprite.userData.markerCsIcon = glyph;
      sprite.userData.markerColor = col;
      sprite.userData.markerDesc = m.desc || '';
      sprite.userData.markerType = m.type || 'Spawn';
      sprite.position.copy(placePos(m.pos, i));
      if (Array.isArray(m.rot)) sprite.rotation.set(...m.rot);
      sprite.scale.set(...(Array.isArray(m.scale) && m.scale.length === 3 ? m.scale : [_cb.MARKER_SCALE, _cb.MARKER_SCALE, 1]));
      sprite.name = _cb.uniquePlacementName(m.name || `marker_${glyph}`);
      items.push({ node: sprite, entry: { node: sprite, name: sprite.name, isMarker: true }, parent: mg });
      n++;
    }
    if (items.length) commitPastedItems(items, `pasted ${items.length} marker${items.length > 1 ? 's' : ''}`);
  }

  // Sound emitters — re-create as added sounds (soundId + pos); commitAddedSound also makes the
  // SFX icon and its own undo entry.
  for (let i = 0; i < soundClips.length; i++) {
    const s = soundClips[i];
    const soundId = s.soundId | 0;
    if (!soundId) continue;
    const folder = String(Math.floor(soundId / 1000)).padStart(3, '0');
    const file = s.soundFile || `se${folder}/se${String(soundId).padStart(6, '0')}.spw`;
    const node = new THREE.Group();
    node.rotation.order = 'ZYX';
    node.position.copy(placePos(s.pos, i));
    node.quaternion.identity(); node.scale.set(1, 1, 1); node.updateMatrix();
    node.visible = false;   // no mesh — the SFX icon is its handle
    node.userData.effect = { sound: true, added: true, soundId, soundFile: file, repeat: !!s.repeat };
    node.name = _cb.uniquePlacementName(s.name || `sound se${String(soundId).padStart(6, '0')}`);
    node.userData.original = { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() };
    _cb.commitAddedSound(node, { node, name: node.name, isEffect: true, isSound: true }, `pasted sound ${file}`);
    n++;
  }

  // Mobs — re-fetch the model by look and instantiate (skinned meshes don't clone safely).
  if (mobClips.length) {
    if (!_cb.bridgeOnline()) { _cb.setStatus('Pasting mobs needs the backend — run via `xi gui zone`', true); }
    else {
      const items = [];
      for (let i = 0; i < mobClips.length; i++) {
        const m = mobClips[i];
        try {
          const it = await _cb.buildMobNode({ poolid: m.poolid, modelid: m.modelid, name: m.name }, placePos(m.pos, i));
          if (Array.isArray(m.rot)) it.node.rotation.set(...m.rot);
          items.push(it); n++;
        } catch (e) { console.warn('[mob paste]', e); }
      }
      if (items.length) commitPastedItems(items, `pasted ${items.length} mob${items.length > 1 ? 's' : ''}`);
    }
  }
  return n;
}

// ── paste (same-zone) ─────────────────────────────────────────────────────────

export async function pasteFromClipboard() {
  // View / browse is read-only — copy is allowed, paste is not (no project to edit).
  if (_cb.getMode() !== 'edit') { _cb.setStatus('Paste is disabled in View mode — open a project to edit.'); return; }
  // Prefer the cross-zone clip (localStorage) when it is NEWER than this tab's in-memory
  // clipboard — i.e. another tab copied something more recently. Without this, a tab's own
  // non-empty in-memory clipboard permanently shadows fresher cross-tab copies.
  // Likewise when the in-memory clipboard is empty OR stale (copied in a zone that has since
  // been unloaded — see clipboardIsLive): copySelected always wrote the matching serialized
  // clip, and pasteCrossZone fetches the source zone's mesh + textures from there.
  if (!clipboardIsLive()) { return pasteCrossZone(); }
  try {
    const xclip = JSON.parse(localStorage.getItem(XZONE_CLIP_KEY) || 'null');
    if (xclip?.items?.length && (xclip.ts || 0) > clipboardTs) { return pasteCrossZone(); }
  } catch {}
  const zoneRoot = _cb.getZoneRoot();
  if (!zoneRoot) { _cb.setStatus('paste: no zone loaded'); return; }

  // Paste at the SAME position as the original(s) by default; nudge slightly when
  // "Offset on Copy & Paste" (Settings → Selection) is on, so the copy isn't perfectly hidden.
  // Relative offsets between multi-selected items are preserved either way.
  const centroid = new THREE.Vector3();
  for (const e of clipboard) centroid.add(e.node.position);
  centroid.divideScalar(clipboard.length);
  const offset = _cb.getPasteOffset() ? new THREE.Vector3(1, 0, 1) : new THREE.Vector3(0, 0, 0);
  const cursorLocal = centroid.clone().add(offset);

  const items = [];
  const placements   = _cb.getPlacements();
  const placementSet = _cb.getPlacementSet();
  const addedEntries = _cb.getAddedEntries();
  let cpg = _cb.getCollisionPrimGroup();

  for (const srcEntry of clipboard) {
    const src = srcEntry.node;
    if (!src.parent) continue;

    if (srcEntry.isCollisionPrimitive) {
      if (!cpg) {
        cpg = new THREE.Group();
        cpg.name = '__collisionPrims';
        cpg.visible = _cb.getShowCollision();
        zoneRoot.add(cpg);
        _cb.setCollisionPrimGroup(cpg);
      }
      const node = src.clone(true);
      // Clone material so opacity slider stays in sync and each prim is independent.
      node.material = src.material.clone();
      _cb.getCollisionPrimMaterials().push(node.material);
      node.position.copy(src.position);
      node.position.add(offset);   // paste offset (zero = on top of the original)
      node.quaternion.copy(src.quaternion);
      node.scale.copy(src.scale);
      node.updateMatrix();
      const typeStr = srcEntry.collisionType || 'col';
      const n = placements.filter((p) => p.isCollisionPrimitive).length + items.filter((i) => i.entry.isCollisionPrimitive).length + 1;
      node.name = `xi_col_${typeStr}_${n}`;
      node.userData.original = { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() };
      node.userData.xiId = _cb.newXiId();   // each pasted prim gets its own stable identity
      _cb.setCollisionMat(node, src.userData.collisionMat || _cb.defaultCollisionMat(srcEntry.collisionType));
      const entry = { node, name: node.name, isCollisionPrimitive: true, collisionType: srcEntry.collisionType };
      items.push({ node, entry, parent: cpg });
      continue;
    }

    const meshId = meshIdForEntry(srcEntry);
    if (!meshId) continue;

    const node = src.clone(true);
    node.rotation.order = 'ZYX';
    node.position.copy(src.position);
    node.position.add(offset);   // paste offset (zero = on top of the original)
    node.quaternion.copy(src.quaternion);
    node.scale.copy(src.scale);
    node.updateMatrix();

    const displayBase = _cb.xiName(meshId);   // preserve leading '_' for foliage
    node.name = _cb.uniquePlacementName(displayBase);
    // A copy of a building-interior object becomes a normal main-zone add — drop the sub-area
    // routing identity (subAreaId/subAreaDat/index) so the paste doesn't try to bind an interior DAT.
    const { subAreaId: _saId, subAreaDat: _saDat, index: _saIdx, ...basePlacement } = src.userData.placement || {};
    node.userData = { placement: { ...basePlacement, meshId }, addName: src.userData.addName ?? meshId,
      xiId: src.userData.xiId || _cb.newXiId(),
      uid: _cb.newUid() };
    const glbRef = _cb.lightGlbRef(src);
    if (glbRef) node.userData.glbImport = glbRef;
    // Preserve cross-zone provenance when cloning a previously cross-zone-pasted node.
    if (src.userData.sourceZone) {
      node.userData.sourceZone = src.userData.sourceZone;
      node.userData.sourceName = src.userData.sourceName;
    }
    node.userData.original = { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() };

    const entry = { node, name: node.name, isEffect: false };
    items.push({ node, entry, parent: src.parent });
  }

  // Same-zone copy may also include effects, sounds and markers (only ever in localStorage) —
  // paste them too. Each helper commits + sets its own status, so we only guard the empty case.
  let fxN = 0, scN = 0;
  try {
    const clip = JSON.parse(localStorage.getItem(XZONE_CLIP_KEY) || 'null');
    const fxItems = clip?.items?.filter(i => i.isEffect) || [];
    if (fxItems.length) fxN = await _pasteEffectItems(fxItems, (clip.sourceZoneUrl || '').replace(/^game(-hd)?\//i, ''), cursorLocal);
    const scItems = clip?.items?.filter(i => i.isMarker || i.isSound || i.isMob) || [];
    if (scItems.length) scN = await _pasteSelfContainedItems(scItems, cursorLocal);
  } catch {}

  if (!items.length) {
    if (!fxN && !scN) _cb.setStatus('paste: source(s) no longer valid');
    else if (fxN && !scN) _cb.setStatus(`pasted ${fxN} effect${fxN > 1 ? 's' : ''}`);
    return;
  }
  commitPastedItems(items, `pasted ${items.length} object${items.length > 1 ? 's' : ''}${fxN ? ` + ${fxN} effect${fxN > 1 ? 's' : ''}` : ''}`);
}

// ── paste (cross-zone / localStorage) ────────────────────────────────────────

// Paste from localStorage: works after a zone switch or in a separate tab.
// Meshes present in the current zone are instantiated directly.  Any mesh
// not found locally triggers a fetch+parse of the source zone DAT so the
// geometry is pulled across without a manual import step.
export async function pasteCrossZone() {
  let clip = null;
  try {
    const raw = localStorage.getItem(XZONE_CLIP_KEY);
    if (raw) clip = JSON.parse(raw);
  } catch (e) { console.warn('[xzone paste] localStorage read failed:', e); }
  if (!clip?.items?.length) { _cb.setStatus('paste: nothing copied (no cross-zone clipboard)'); return; }
  const parsed  = _cb.getParsed();
  const zoneRoot = _cb.getZoneRoot();
  if (!parsed?.meshes || !zoneRoot) { _cb.setStatus('paste: no zone loaded'); return; }

  // Effects (VFX) and the self-contained types (markers / sound emitters) are handled
  // separately — they have no meshId — so only true mesh items go through the mesh path.
  const effectClipItems = clip.items.filter(i => i.isEffect);
  const meshClipItems   = clip.items.filter(i => !i.isEffect && !i.isMarker && !i.isSound && !i.isMob);

  const sameSourceZone = clip.sourceZoneUrl === _cb.getCurrentZoneUrl();

  // Same-zone pastes can instantiate local templates. Cross-zone pastes must fetch
  // from the source DAT even when the destination has a same-named mesh, otherwise
  // we duplicate the destination mesh/texture instead of the copied source asset.
  const localItems  = [], remoteItems = [];
  for (const item of meshClipItems) {
    if (sameSourceZone && parsed.meshes.has(item.meshId)) localItems.push(item);
    else remoteItems.push(item);
  }

  // For any mesh not found locally: fetch + parse the source zone DAT once.
  let srcMeshes = null, srcTemplates = null;
  if (remoteItems.length > 0) {
    _cb.setStatus(`fetching mesh geometry from ${clip.sourceZoneName || clip.sourceZoneUrl}…`);
    try {
      const [srcBuf, srcKt] = await Promise.all([
        fetch(_cb.datUrl(clip.sourceZoneUrl)).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }),
        _cb.getKeyTables(),
      ]);
      const srcParsed = _cb.parseZone(srcBuf, srcKt);
      srcMeshes = srcParsed.meshes;
      srcTemplates = _cb.buildMeshTemplates(srcMeshes, _cb.buildTextures(srcParsed.textures));
    } catch (e) {
      console.error('[xzone paste] source zone fetch failed:', e);
      _cb.setStatus(`paste: could not fetch source zone — ${e.message}`, true);
      if (!localItems.length && !effectClipItems.length) return;
      // Fall through and paste what we can from localItems + effects.
    }
  }

  // Drop in front of the camera at ground/collision level — same point the hotkey-spawn uses,
  // so a cross-zone paste lands where you're looking (its original far-away position is
  // meaningless here). pastePointInFront stays as a last resort for a geometry-less zone.
  const hitPoint = _cb.groundPointAhead() || _pastePointInFront();
  // Cursor in FFXI local space — used both for mesh offset and effect placement.
  let cursorLocal = null;
  if (hitPoint) {
    const loc = hitPoint.clone();
    zoneRoot.worldToLocal(loc);
    cursorLocal = new THREE.Vector3(loc.x, loc.y, loc.z);
  }
  let offset = null;
  if (cursorLocal && meshClipItems.length) {
    const centroid = meshClipItems.reduce(
      (acc, it) => acc.add(new THREE.Vector3(...it.pos)), new THREE.Vector3()
    ).divideScalar(meshClipItems.length);
    offset = cursorLocal.clone().sub(centroid);
  }

  const templates = _cb.getTemplates();
  function makeNode(tmplMap, meshId, item) {
    const node = _cb.instantiate(tmplMap, meshId);
    node.rotation.order = 'ZYX';
    const pos = offset
      ? [item.pos[0] + offset.x, item.pos[1] + offset.y, item.pos[2] + offset.z]
      : item.pos;
    _cb.trsMatrix(pos, item.rot, item.scale).decompose(node.position, node.quaternion, node.scale);
    node.updateMatrix();
    const displayBase = _cb.xiName(item.meshId);
    node.name = _cb.uniquePlacementName(displayBase);
    node.userData = {
      placement: { meshId: item.meshId },
      addName: item.meshId,
    };
    if (!sameSourceZone) {
      node.userData.sourceZone = clip.sourceZoneUrl.replace(/^game(-hd)?\//i, '');
      node.userData.sourceName = item.meshId;
    }
    node.userData.original = { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() };
    return node;
  }

  const items = [], missing = [];

  for (const item of localItems) {
    const node = makeNode(templates, item.meshId, item);
    items.push({ node, entry: { node, name: node.name, isEffect: false }, parent: zoneRoot });
  }
  for (const item of remoteItems) {
    const resolved = srcMeshes ? _cb.resolveMeshName(item.meshId, srcMeshes) : null;
    if (!resolved) { missing.push(item.meshId); continue; }
    const node = makeNode(srcTemplates, resolved, item);
    items.push({ node, entry: { node, name: node.name, isEffect: false }, parent: zoneRoot });
  }

  if (missing.length) {
    _cb.setStatus(`paste: mesh(es) not found in source zone either — ${missing.join(', ')}`, true);
    if (!items.length && !effectClipItems.length) return;
  }
  const fromZone = clip.sourceZoneName || clip.sourceZoneUrl;
  const suffix = clip.sourceZoneUrl === _cb.getCurrentZoneUrl() ? '' : ` from ${fromZone}`;
  if (items.length) {
    commitPastedItems(items, `pasted ${items.length} object${items.length > 1 ? 's' : ''}${suffix}`);
  }

  // Paste effects: place each at the cursor (falling back to source pos).
  if (effectClipItems.length) {
    const srcDatRel = clip.sourceZoneUrl.replace(/^game(-hd)?\//i, '');
    const fxN = await _pasteEffectItems(effectClipItems, srcDatRel, cursorLocal);
    if (!items.length && fxN) _cb.setStatus(`pasted ${fxN} effect${fxN > 1 ? 's' : ''}${suffix}`);
  }

  // Paste markers + sound emitters + mobs — self-contained, straight from the clip.
  const scItems = clip.items.filter(i => i.isMarker || i.isSound || i.isMob);
  if (scItems.length) {
    const scN = await _pasteSelfContainedItems(scItems, cursorLocal);
    if (!items.length && !effectClipItems.length && scN) _cb.setStatus(`pasted ${scN} item${scN > 1 ? 's' : ''}${suffix}`);
  }
}

// ── internal: fallback drop point ─────────────────────────────────────────────

function _pastePointInFront() {
  const zoneRoot = _cb.getZoneRoot();
  if (!zoneRoot) return null;
  const canvas = _cb.getCanvas();
  const camera = _cb.getCamera();
  const raycaster = _cb.getRaycaster();
  const last = _cb.getLastCanvasPointerClient();
  let nx = 0, ny = 0;
  if (last) {
    const r = canvas.getBoundingClientRect();
    nx = Math.max(-1, Math.min(1, ((last.x - r.left) / r.width) * 2 - 1));
    ny = Math.max(-1, Math.min(1, -((last.y - r.top) / r.height) * 2 + 1));
  }
  raycaster.setFromCamera({ x: nx, y: ny }, camera);
  const originW = zoneRoot.localToWorld(new THREE.Vector3());
  const dist = Math.min(Math.max(camera.position.distanceTo(originW), 10), 500);
  return raycaster.ray.at(dist, new THREE.Vector3());
}
