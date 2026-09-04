import * as THREE from 'three';
import { rebindZoneAnim } from '../core/zone-animations.js';

// Generator-bound object animation carried by a copied placement (see core/zone-animations.js).
// Node side: { sourceId, sourceDat, sourceOffset, newId, rotation, rotVelocity, rotationOrder }.
// Change-set side (`anim` on a placements op:add — what xi zone import-json reads):
//   { source_id, source_dat, source_offset, new_id?, rotation, rot_velocity, rotation_order }
// new_id is the generator FourCC the backend allocated at the first Publish, pinned so later
// publishes re-create the copy under the same id and the record's BlockID keeps matching.
const animToRec = (a) => ({
  source_id: a.sourceId, source_dat: a.sourceDat || null, source_offset: a.sourceOffset ?? null,
  ...(a.newId ? { new_id: a.newId } : {}),
  rotation: a.rotation || [0, 0, 0], rot_velocity: a.rotVelocity || [0, 0, 0], rotation_order: a.rotationOrder || 'XYZ',
});
const animFromRec = (r) => (r && r.source_id) ? ({
  sourceId: r.source_id, sourceDat: r.source_dat || null, sourceOffset: r.source_offset ?? null, newId: r.new_id || null,
  rotation: r.rotation || [0, 0, 0], rotVelocity: r.rot_velocity || [0, 0, 0], rotationOrder: r.rotation_order || 'XYZ',
}) : null;

// Changes Tracker - extracted from main.js.
// Tracks added/deleted/modified scene objects for the change-set.
// All scene-state deps are injected via initChangesTracker({ ... }).

let _deps = null;

// Own state (live exported objects — imported by reference so main.js sees mutations)
export const deletedEntries = new Set();
export const addedEntries = new Set();
export let changeSeq = 0;

// Signature tracking
export let lastSavedSig = '';
export let lastSavedHadContent = false;
export const _changeSig = (snap) => JSON.stringify([snap.placements, snap.vfx, snap.markers, snap.textPlanes, snap.collisions, snap.visibility, snap.locks, snap.categorySets, snap.categories, snap.stripInteractions, snap.footsteps]);
export function setLastSavedSig(s, hadContent = false) { lastSavedSig = s; lastSavedHadContent = hadContent; }
export function markSaved(snap) { const s = snap || snapshotChanges(); lastSavedSig = _changeSig(s); lastSavedHadContent = snapshotHasContent(s); }

// ── changes tracker ──────────────────────────────────────────────────────────
// Records the *final* state of each edited object (deduped: many edits → one entry),
// for export. Recomputed from live scene state vs each node's stored baseline, so it
// stays correct through undo/redo and self-clears when an object returns to original.

export function markChange(target, ts) {
  if (!ts) ts = Date.now();
  if (target.userData) { target.userData.changeSeq = ++changeSeq; target.userData.changeTs = ts; }
  else { target.changeSeq = ++changeSeq; target.changeTs = ts; }
}

export function trsChanged(node) {
  const o = node.userData.original;
  if (!o) return false;
  return node.position.distanceToSquared(o.p) > 1e-6 ||
         node.scale.distanceToSquared(o.s) > 1e-6 ||
         node.quaternion.angleTo(o.q) > 1e-4;
}

// Returns { placements: [...], vfx: [...] } — the two lists for apply-changes.
// Placement changes use the name (mesh_id string the engine sees).
// VFX changes use the generator's 4-char FourCC sectionId.
export function getChanges() {
  const all = collectChanges();
  const placements = all.filter((c) => !c.isEffect && !c.isCollisionPrimitive && !c.isSound && !c.isMob).map((c) => {
    if (c.op === 'delete') return { op: 'delete', name: c.meshId, index: c.index, pos: c.pos, ts: c.ts || 0 };
    if (c.op === 'add') {
      // Use the stable source name (not the drifting published xi_ meshId) so reload keys
      // off a fixed identity. Python re-derives the xi_ prefix itself via _xi_prefixed.
      const r = { op: 'add', name: c.addName || c.meshId, pos: c.pos, rot: c.rot, scale: c.scale };
      if (c.xiId) r.xiId = c.xiId;   // identity group — backend owns the final mesh name
      if (c.uid) r.uid = c.uid;            // per-instance id — keeps overlapping copies distinct across reload
      if (c.ts) r.ts = c.ts;
      if (c.sourceZone) { r.sourceZone = c.sourceZone; if (c.sourceName) r.sourceName = c.sourceName; }
      if (c.anim) r.anim = animToRec(c.anim);   // generator-bound object: clone its generator + bind the record
      if (c.glb) {
        r.glb = c.glb;
        if (c.glbName) r.glbName = c.glbName;
        if (c.glbOrigin) r.glbOrigin = c.glbOrigin;   // full source path (machine-local) for Refresh re-copy
        if (c.opaque) r.opaque = true;
        if (c.doubleSided) r.doubleSided = true;
        // Only bake a brightness override when the toggle is on; off = native neutral.
        if (c.lit && c.shade != null && c.shade !== 1) r.shade = c.shade;
        // Auto-baked text GLB — regenerated from the editable plane every Publish, so a reload
        // must SKIP this record (the editable plane in textPlanes[] re-bakes it). See rebuildTextBakes.
        if (c.entry?.isTextBaked) r.textBaked = true;
      }
      return r;
    }
    return { op: 'modify', name: c.meshId, instanceName: c.name, pos: c.pos, rot: c.rot, scale: c.scale, ts: c.ts || 0,
      ...(c.from ? { from: c.from } : {}),
      // Sub-area routing: present only for building-interior objects → backend applies to that DAT.
      ...(c.subAreaId != null ? { subAreaId: c.subAreaId, subAreaDat: c.subAreaDat, index: c.index } : {}) };
  });
  const vfx = all.filter((c) => c.isEffect && (!c.isSound || c.sourceDat)).map((c) => {
    if (c.op === 'add' && c.sourceDat) return { op: 'add', source_id: c.sourceId, source_offset: c.sourceOffset ?? null, source_dat: c.sourceDat, mesh: c.mesh ?? null, sound: !!c.isSound, pos: c.pos, name: c.name, ts: c.ts || 0,
      // Id the backend gave this copy at its first Publish (auto-named, e.g. 'l_00'). Pinned so every
      // later Publish re-creates it under the same id and reload can adopt the baked copy by id.
      ...(c.newId ? { new_id: c.newId } : {}) };
    const sid = c.node.userData.effect?.sectionId;
    if (c.op === 'delete') return { op: 'remove', id: sid, name: c.name, ts: c.ts || 0 };
    return { op: 'modify', id: sid, name: c.name, pos: c.pos, scale: c.scale, ts: c.ts || 0 };
  });
  // Newly placed sound emitters (Phase 1: editor-only — the backend ignores this list for now).
  const sounds = all.filter((c) => c.isSound).map((c) => ({
    op: 'add', soundId: c.soundId, soundFile: c.soundFile, repeat: !!c.repeat, pos: c.pos, name: c.name, ts: c.ts || 0,
  }));
  // Placed mobs → real server spawns on Publish (mob_groups + mob_spawn_points).
  const mobs = all.filter((c) => c.isMob && c.op === 'add').map((c) => ({
    op: 'add', poolid: c.poolid, modelid: c.modelid, name: c.mobName || c.name, pos: c.pos, rot: c.rot,
    mobid: c.mobid ?? null, groupid: c.groupid ?? null, ts: c.ts || 0,
  }));
  return { placements, vfx, sounds, mobs };
}

export function collectChanges() {
  const out = [];
  // Always emit the FULL pos/rot/scale (not just the component that changed), at
  // float32-lossless precision (6 decimals covers every realistic zone coordinate),
  // so apply-changes reproduces the exact transform. The node's local TRS already
  // equals the raw FFXI placement (the root correction lives on the parent).
  const trs = (v) => [+v.x.toFixed(6), +v.y.toFixed(6), +v.z.toFixed(6)];
  for (const p of _deps.getPlacements()) {
    if (p.isMarker || p.isSky) continue;   // sky elements are view-only, never exported
    if (p.isTextPlane) continue;           // editor-only source — published via its baked GLB (rebuildTextBakes), saved via textPlanes[]
    const n = p.node;
    if (addedEntries.has(p)) {
      // Cross-zone VFX / sound-emitter copy — goes into the vfx change array with source_dat.
      if (p.isEffect && p.sourceDat) {
        out.push({ op: 'add', isEffect: true, isSound: !!p.isSound, entry: p, node: n, name: p.name,
          sourceDat: p.sourceDat, sourceId: p.sourceId, sourceOffset: p.sourceOffset ?? n.userData.effect?.sourceOffset ?? null,
          mesh: n.userData.effect?.mesh ?? null,   // VFX type key — lets reload match a published copy back
          newId: p.newId || null,                  // backend-pinned id of the baked copy (see toChangeSet)
          pos: trs(n.position), seq: n.userData.changeSeq || 0, ts: n.userData.changeTs || 0 });
        continue;
      }
      // Newly placed sound emitter (dragged from the asset browser) — its own record shape,
      // routed to the change-set's `sounds` list (not placements/vfx). Phase 1: tracked +
      // exported, ignored by the current backend write-back.
      if (p.isSound) {
        const fx = n.userData.effect || {};
        out.push({ op: 'add', isSound: true, entry: p, node: n, name: p.name,
          soundId: fx.soundId, soundFile: fx.soundFile, repeat: !!fx.repeat,
          pos: trs(n.position), seq: n.userData.changeSeq || 0, ts: n.userData.changeTs || 0 });
        continue;
      }
      // Placed mob — its own record shape, routed to the change-set's `mobs` list (not
      // placements/vfx). Publish writes a real spawn (mob_groups + mob_spawn_points) to the DB.
      if (p.isMob) {
        const mob = n.userData.mob || {};
        out.push({ op: 'add', isMob: true, entry: p, node: n, name: p.name,
          poolid: mob.poolid, modelid: mob.modelid, mobName: mob.name,
          mobid: mob.mobid ?? null, groupid: mob.groupid ?? null,   // stamped after first Publish → upsert
          pos: trs(n.position), rot: trs(n.rotation), seq: n.userData.changeSeq || 0, ts: n.userData.changeTs || 0 });
        continue;
      }
      // Pasted duplicate — always an 'add', regardless of any further nudging.
      const rec = { op: 'add', entry: p, node: n, name: p.name, meshId: n.userData.placement?.meshId ?? p.name,
        addName: n.userData.addName,   // stable source identity for the exported change-set name
        xiId: n.userData.xiId,     // group key — backend places every copy under one resolved mesh name
        uid: n.userData.uid,           // per-instance key — distinguishes overlapping copies from a true double-record
        isEffect: false, isCollisionPrimitive: !!p.isCollisionPrimitive,
        pos: trs(n.position), rot: trs(n.rotation), scale: trs(n.scale), seq: n.userData.changeSeq || 0, ts: n.userData.changeTs || 0 };
      // Cross-zone provenance: record source zone + original name for exportCommands().
      if (n.userData.sourceZone) { rec.sourceZone = n.userData.sourceZone; rec.sourceName = n.userData.sourceName || null; }
      if (n.userData.animSource?.sourceId) rec.anim = n.userData.animSource;
      // GLB model inject: brand-new mesh imported from a GLB file on disk.
      if (n.userData.glbImport) {
        const gi = n.userData.glbImport;
        rec.glb = gi.fileName;   // bare filename only — workspace copy is the publish source
        rec.glbName = gi.fileName;
        const _origin = _deps.glbOriginOf(gi);   // full source path the import links to (machine-local)
        if (_origin) rec.glbOrigin = _origin;
        rec.opaque = !!gi.opaque;
        rec.doubleSided = !!gi.doubleSided;
        rec.lit = !!gi.lit;
        rec.shade = gi.shade ?? 1.0;
        // Text planes carry their authored text so Load can re-open them as editable signs.
        if (n.userData.textPlane) rec.textPlane = n.userData.textPlane;
      }
      out.push(rec);
      continue;
    }
    if (!trsChanged(n)) continue;
    // Capture the PRISTINE baseline (userData.original) alongside the new pose. In-place publish
    // bakes the move into the DAT, so on the next load the node already sits at the modified pose
    // and its rebuilt baseline equals it → trsChanged would be false and the modify would silently
    // vanish from the change-set (and get wiped by the next save). Persisting `from` lets the reload
    // re-anchor the baseline to the original, keeping the published move tracked. See makeTransformOp.
    const o0 = n.userData.original;
    const fromRec = o0 ? { pos: trs(o0.p), rot: trs(new THREE.Euler().setFromQuaternion(o0.q, n.rotation.order)), scale: trs(o0.s) } : null;
    out.push({ op: 'modify', entry: p, node: n, name: p.name, meshId: n.userData.placement?.meshId ?? p.name,
      isEffect: !!p.isEffect, isMob: !!p.isMob,
      // Building-interior identity: routes this edit to the interior DAT (not the main zone) and
      // matches the exact placement there by DAT-local index. Undefined for normal zone objects.
      subAreaId: n.userData.placement?.subAreaId, subAreaDat: n.userData.placement?.subAreaDat, index: n.userData.placement?.index,
      pos: trs(n.position), rot: trs(n.rotation), scale: trs(n.scale), from: fromRec, seq: n.userData.changeSeq || 0, ts: n.userData.changeTs || 0 });
  }
  for (const entry of deletedEntries) {
    out.push({ op: 'delete', entry, node: entry.node, name: entry.name, meshId: entry.node.userData.placement?.meshId ?? entry.name,
      index: entry.node.userData.placement?.index,   // exact DAT object index (primary key for the importer)
      pos: trs(entry.node.position),                  // position fallback if no index
      isEffect: !!entry.isEffect, isMob: !!entry.isMob, seq: entry.changeSeq || 0, ts: entry.changeTs || 0 });
  }
  return out;
}

export function hasUnsavedChanges() {
  // "Dirty since last save", NOT "any change-set exists". A loaded zone with previously
  // saved edits has a non-empty change-set but isn't unsaved — comparing the current
  // signature against lastSavedSig (the same gate doAutoSave uses, refreshed on every
  // load/save/replay) means the prompt only fires when something actually changed.
  return _changeSig(snapshotChanges()) !== lastSavedSig;
}

// Dedup utility (pure)
export function dedupePlacementAdds(records) {
  const seen = new Set();
  const out = [];
  let dropped = 0;
  const q = (a) => (Array.isArray(a) ? a.map((n) => Math.round((n || 0) * 1000)).join(',') : '');
  for (const r of records) {
    if (r.op !== 'add' || !r.uid) { out.push(r); continue; }
    const key = `${r.uid}|${q(r.pos)}|${q(r.rot)}|${q(r.scale)}`;
    if (seen.has(key)) { dropped++; continue; }
    seen.add(key);
    out.push(r);
  }
  if (dropped) console.warn(`[changeset] collapsed ${dropped} same-instance duplicate placement add(s)`);
  return out;
}

// snapshotChanges + snapshotHasContent
export function snapshotChanges() {
  const { placements: plc, vfx, sounds, mobs } = getChanges();
  const markerRecs = _deps.collectMarkerChanges().map((m) => ({
    name: m.name, icon: m.icon, csIcon: m.csIcon, color: m.color, desc: m.desc,
    type: m.type, pos: m.pos, rot: m.rot, scale: m.scale,
  }));
  const collisionRecs = collectChanges().filter((c) => c.isCollisionPrimitive).map((c) => {
    const rec = { name: c.name, collisionType: c.entry?.collisionType || 'box', pos: c.pos, rot: c.rot, scale: c.scale };
    if (c.node.userData.xiId) rec.xiId = c.node.userData.xiId;   // stable identity (display name may drift)
    if (Array.isArray(c.node.userData.sourceXiIds) && c.node.userData.sourceXiIds.length) rec.sourceXiIds = c.node.userData.sourceXiIds;
    const cm = c.node.userData.collisionMat;
    rec.wall = cm ? !!cm.wall : (rec.collisionType !== 'plane');
    rec.terrain = cm ? (cm.terrain | 0) : 0;
    if (c.entry?.subdivSegs) rec.subdivSegs = c.entry.subdivSegs;
    if (rec.collisionType === 'mesh') {
      // Persist the ORIGINAL (un-subdivided) source verts, NOT the live geometry. The live
      // geometry is already subdivided by subdivSegs, and _buildCollisionPrimFromRec re-subdivides
      // rec.vertices again on load — so writing the subdivided verts compounds the subdivision
      // every save/load (×level² per cycle) until the baked collision overflows the DAT's u16
      // per-mesh triangle count and Publish crashes ('H' format requires 0 <= number <= 65535).
      const orig = c.node.userData?.originalVertices;
      const posAttr = c.node.geometry?.attributes?.position;
      if (orig && orig.length) rec.vertices = Array.from(orig);
      else if (posAttr) rec.vertices = Array.from(posAttr.array);
    }
    rec.tris = _deps.bakeCollisionPrimTris(c.node);   // world-space soup the backend bakes into 0x1C
    if (c.ts) rec.ts = c.ts;
    return rec;
  });
  const visibility = {};
  for (const p of _deps.getPlacements()) {
    // Text planes are editor-only (their baked GLB carries the in-game mesh); the bakes are
    // hidden in the EDITOR by design but must stay visible in-game — keep both out of the map.
    if (p.isTextPlane || p.isTextBaked) continue;
    const key = _deps.visibilityKeyFor(p);
    const vis = p.isSound ? _deps.iconVisible(p.node) : p.node.visible;
    if (vis !== _deps.defaultVisibilityFor(p)) visibility[key] = vis;
  }
  // locks + categorySets are per-user editor view-state, NOT content — they persist
  // separately in editor.json (via saveZoneSetting), and restore from there on load.
  // Keeping them out of the change-set keeps the project's zone-changes.json clean.
  const out = { zone: _deps.getCurrentZoneUrl(), placements: dedupePlacementAdds(plc.filter((c) => c.name)), vfx: vfx.filter((c) => c.id || c.source_id), markers: markerRecs, textPlanes: _deps.collectTextPlanes(), collisions: collisionRecs, sounds: (sounds || []).filter((c) => c.soundId), mobs: (mobs || []).filter((c) => c.poolid || c.modelid), visibility };
  if (Object.keys(_deps.getMusicChanges()).length) out.music = { ..._deps.getMusicChanges() };   // zone BGM slot changes (DB-bound)
  if (_deps.getStripInteractions().length) out.stripInteractions = [..._deps.getStripInteractions()];   // remove 0x36 sub-areas/zone-lines on Publish
  if (_deps.getFootstepSourceZone()) out.footsteps = { sourceZone: _deps.getFootstepSourceZone() };
  return out;
}
export const snapshotHasContent = (s) =>
  !!(s && ((s.placements && s.placements.length) || (s.vfx && s.vfx.length) || (s.markers && s.markers.length) || (s.textPlanes && s.textPlanes.length) || (s.collisions && s.collisions.length) || (s.sounds && s.sounds.length) || (s.mobs && s.mobs.length) || (s.music && Object.keys(s.music).length) || (s.stripInteractions && s.stripInteractions.length) || s.footsteps?.sourceZone));


// loadChangesFromJson
export async function loadChangesFromJson(data, label, { recordHistory = true } = {}) {
  if (!_deps.getZoneRoot()) { _deps.setStatus('load a zone first', true); return; }
  // Music slot changes ride along the change-set (DB-bound, applied on Publish in Phase B).
  _deps.setMusicChanges((data && data.music && typeof data.music === 'object') ? { ...data.music } : {});
  _deps.clearZoneBgmKey(); _deps.renderZoneMusic();
  _deps.setFootstepSourceZone((data && data.footsteps && typeof data.footsteps === 'object') ? (data.footsteps.sourceZone || '') : '');
  _deps.syncFootstepSourceUI();
  // "Remove sub-areas + zone lines" is a zone-level flag (restored even if it's the only change,
  // hence before the early-out below). syncStripVisual re-hides interiors once they finish loading.
  _deps.setStripInteractions(data?.stripInteractions);
  _deps.syncStripVisual();
  const fxIn = Array.isArray(data?.vfx) ? data.vfx : [];
  const markersIn = Array.isArray(data?.markers) ? data.markers : [];
  const collisionsIn = Array.isArray(data?.collisions) ? data.collisions : [];
  // Text planes round-trip via their OWN array (like markers). Also MIGRATE old change-sets where
  // a text plane was a glb-add carrying `textPlane` → an editable plane; and DROP auto-baked GLB
  // records (op:add + textBaked) entirely, since rebuildTextBakes regenerates them every Publish.
  const textPlanesIn = Array.isArray(data?.textPlanes) ? [...data.textPlanes] : [];
  const plIn = (Array.isArray(data?.placements) ? data.placements : []).filter((rec) => {
    if (rec.op === 'add' && rec.textBaked) return false;
    if (rec.op === 'add' && rec.textPlane && rec.glb) {
      const tp = rec.textPlane;
      textPlanesIn.push({ name: (rec.glbName || rec.name || '').replace(/\.(glb|gltf)$/i, ''),
        stem: (rec.glbName || '').replace(/\.(glb|gltf)$/i, '') || null, xiId: rec.xiId || null,
        text: tp.text, fontSize: tp.fontSize, color: tp.color, panel: tp.panel,
        pos: rec.pos, rot: rec.rot, scale: rec.scale });
      return false;
    }
    return true;
  });
  // Drop only literal same-instance double-records (same uid + TRS); distinct overlapping copies
  // (same xiId group, own uid) are real objects and survive. See dedupePlacementAdds.
  const plRecs = dedupePlacementAdds(plIn);
  if (!plRecs.length && !fxIn.length && !markersIn.length && !collisionsIn.length && !textPlanesIn.length && !_deps.getFootstepSourceZone()) { _deps.setStatus(`load: no changes in ${label}`, true); return; }

  const jsonZone = (data?.zone || '').replace(/^game\//, '');
  const curZone = (_deps.getCurrentZoneUrl() || '').replace(/^game\//, '');
  if (jsonZone && curZone && jsonZone !== curZone &&
      !await _deps.xi_confirm('Zone Mismatch', `This change-set targets ${jsonZone}, but the loaded zone is ${curZone}.\n\nApply anyway?`, 'Apply')) return;

  // Index the current scene. Objects by meshId (first occurrence — for modify).
  // deleteQueues holds ALL instances per meshId so multiple deletes of a shared
  // mesh name each target a distinct instance (mirrors the CLI's delete_queues fix).
  // Effects by their UNIQUE display name first (several effect instances share one
  // sectionId, e.g. "bubbles [awa1]" and "bubbles [awa1].002"), with sectionId as a
  // fallback for older change-sets that didn't record names.
  const objByMesh = new Map(), objByName = new Map(), deleteQueues = new Map(), fxByName = new Map(), fxById = new Map();
  // Building-interior objects share meshIds/names with the main zone, so they get their own
  // index keyed by (subAreaId, DAT-local index) — a sub-area modify never binds a main-zone object.
  const subByKey = new Map();
  for (const p of _deps.getPlacements()) {
    if (p.isEffect) {
      if (p.name && !fxByName.has(p.name)) fxByName.set(p.name, p);
      const sid = p.node.userData.effect?.sectionId; if (sid && !fxById.has(sid)) fxById.set(sid, p);
    } else {
      const sub = p.node.userData.placement?.subAreaId;
      if (sub != null) {
        const idx = p.node.userData.placement?.index;
        if (idx != null) subByKey.set(`${sub}::${idx}`, p);
        continue;   // keep interior objects out of the main-zone lookup maps
      }
      // Placement records carry meshId in userData.placement; unplaced geometry
      // (zone meshes with no placement record) has no userData.placement, so use
      // the node name directly — it equals the mesh name for those entries.
      const mid = p.node.userData.placement?.meshId ?? p.name;
      if (mid) {
        if (!objByMesh.has(mid)) objByMesh.set(mid, p);
        if (!deleteQueues.has(mid)) deleteQueues.set(mid, []);
        deleteQueues.get(mid).push(p);
      }
      if (p.name) objByName.set(p.name, p);  // exact instance lookup (e.g. gaitou01.002)
    }
  }
  const usedFx = new Set();
  const resolveFx = (rec) => {
    let e = rec.name ? fxByName.get(rec.name) : null;     // exact instance match
    if ((!e || usedFx.has(e)) && rec.id) e = fxById.get(rec.id);   // fallback by sectionId
    if (!e || usedFx.has(e)) return null;
    usedFx.add(e);
    return e;
  };

  const ops = [];          // {do, undo}
  const skipped = [];
  // Display names ('.NNN' suffixes) minted during THIS replay. Every add node is built up
  // front (before any op's do() pushes it into `_deps.getPlacements()`), so without a shared reservation
  // set all sibling copies of one mesh would resolve to the same suffix on reload.
  const reserved = new Set();
  const applyTRS = (node, rec) => {
    _deps.trsMatrix(rec.pos || [0, 0, 0], rec.rot || [0, 0, 0], rec.scale || [1, 1, 1])
      .decompose(node.position, node.quaternion, node.scale);
    node.updateMatrix();
  };
  const makeRemoveOp = (entry, ts) => {
    const node = entry.node, parent = node.parent, idx = _deps.getPlacements().indexOf(entry), wasAdded = addedEntries.has(entry);
    // VFX/SFX/sky icons live in _deps.getVfxIconGroup() keyed by userData.vfxNode — NOT as children of
    // the node — so removing the node alone orphans the icon sprite: animate() keeps syncing
    // it to the (detached) node, and sound icons are force-visible, so a deleted SFX icon
    // lingers after this reload-replay. Capture + drop it here (restore on undo), mirroring
    // deleteSelected(). Ghosts have no sprite (their node was never iconified) → null → no-op.
    const sprite = _deps.getVfxIconGroup() ? (_deps.getVfxIconGroup().children.find(sp => sp.userData.vfxNode === node) || null) : null;
    return {
      do: () => {
        node.parent?.remove(node);
        if (sprite) _deps.getVfxIconGroup().remove(sprite);
        const i = _deps.getPlacements().indexOf(entry); if (i >= 0) _deps.getPlacements().splice(i, 1);
        _deps.getPlacementSet().delete(node); markChange(entry, ts);
        if (wasAdded) addedEntries.delete(entry); else deletedEntries.add(entry);
      },
      undo: () => {
        (parent || _deps.getZoneRoot()).add(node);
        if (sprite && _deps.getVfxIconGroup()) _deps.getVfxIconGroup().add(sprite);
        if (!_deps.getPlacements().includes(entry)) _deps.getPlacements().splice(Math.min(idx, _deps.getPlacements().length), 0, entry);
        _deps.getPlacementSet().add(node);
        if (wasAdded) addedEntries.add(entry); else deletedEntries.delete(entry);
      },
    };
  };
  // A delete/remove whose target is NOT in the current scene (e.g. in-place mode where the
  // editor re-reads the post-publish DAT, so the deleted VFX/SFX/object is already gone from
  // the bytes). Silently dropping it loses the delete from the change-set, so the next Publish
  // — which resets from pristine first — brings it back. Instead, keep a lightweight "ghost"
  // entry carrying the original record (sectionId / meshId / index / pos) so the change-set
  // remembers the delete and re-applies it on every Publish. The ghost lives only in
  // deletedEntries (never the scene / _deps.getPlacements() / object list); it round-trips through
  // collectChanges → snapshot → save exactly like a real delete.
  const makeGhostDeletedEntry = (rec, isEffect) => {
    // SFX deletes share the vfx array and aren't flagged; infer from the "sound …" label so
    // the Changes panel still classifies them as SFX (cosmetic — the delete works either way).
    const isSound = !!(isEffect && (rec.sound || /^sound /.test(rec.name || '')));
    const node = new THREE.Group();
    node.name = rec.name || rec.id || '(deleted)';
    node.visible = false;
    if (isEffect) node.userData.effect = { sectionId: rec.id, sound: isSound };
    else {
      node.userData.placement = { meshId: rec.name, index: rec.index };
      if (Array.isArray(rec.pos)) node.position.set(rec.pos[0] || 0, rec.pos[1] || 0, rec.pos[2] || 0);
    }
    return { node, name: node.name, isEffect, isSound, ghost: true };
  };
  const makeTransformOp = (node, rec) => {  // full pos/rot/scale (placement modify)
    const before = { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() };
    return {
      do: () => {
        applyTRS(node, rec);
        // Re-anchor the baseline to the modify's PRISTINE origin (built through the same
        // trsMatrix path as the node pose, so trsChanged compares like-for-like). Without this,
        // an in-place reload of a baked DAT leaves baseline == current pose, so the published move
        // reads as "no change" and is dropped on the next save. Legacy records (no `from`) are
        // left as-is. This also makes Revert restore the true original rather than the baked pose.
        if (rec.from) {
          const fm = _deps.trsMatrix(rec.from.pos || [0, 0, 0], rec.from.rot || [0, 0, 0], rec.from.scale || [1, 1, 1]);
          const fp = new THREE.Vector3(), fq = new THREE.Quaternion(), fs = new THREE.Vector3();
          fm.decompose(fp, fq, fs);
          node.userData.original = { p: fp, q: fq, s: fs };
        }
        // Keep the interior-routing identity on the node so this modify re-collects + re-routes on
        // the next Publish (the resolved node already carries it, but legacy/rebuilt nodes may not).
        if (rec.subAreaId != null && node.userData.placement) {
          node.userData.placement.subAreaId = rec.subAreaId;
          node.userData.placement.subAreaDat = rec.subAreaDat;
          if (rec.index != null) node.userData.placement.index = rec.index;
        }
        markChange(node, rec.ts);
      },
      undo: () => { node.position.copy(before.p); node.quaternion.copy(before.q); node.scale.copy(before.s); node.updateMatrix(); markChange(node); },
    };
  };
  const makeVfxModifyOp = (node, rec) => {  // pos (+ optional scale) only — keep rotation
    const before = { p: node.position.clone(), s: node.scale.clone() };
    const after = {
      p: rec.pos ? new THREE.Vector3(...rec.pos) : before.p.clone(),
      s: rec.scale ? new THREE.Vector3(...rec.scale) : before.s.clone(),
    };
    return {
      do: () => { node.position.copy(after.p); node.scale.copy(after.s); node.updateMatrix(); markChange(node, rec.ts); },
      undo: () => { node.position.copy(before.p); node.scale.copy(before.s); node.updateMatrix(); markChange(node); },
    };
  };
  const makeAddOp = (node, ts) => {
    const entry = { node, name: node.name, isEffect: false };
    return {
      do: () => { _deps.getZoneRoot().add(node); if (!_deps.getPlacements().includes(entry)) _deps.getPlacements().push(entry); _deps.getPlacementSet().add(node); addedEntries.add(entry); markChange(node, ts); },
      undo: () => { node.parent?.remove(node); const i = _deps.getPlacements().indexOf(entry); if (i >= 0) _deps.getPlacements().splice(i, 1); _deps.getPlacementSet().delete(node); addedEntries.delete(entry); },
    };
  };
  // The mesh-name a baked add carries in the loaded DAT — the published name via _deps.xiName().
  // Strips the editor's '.NNN' suffix and legacy 'xi_' display prefix first, then keys off
  // the SOURCE name. Mirrors Python _xi_prefixed (preserves a leading '_'/'#' for alpha-test).
  const _xiTarget = (raw) => {
    let s = (raw || '').replace(/\.\d+$/, '');
    if (s.startsWith('xi_')) s = s.slice(5);   // legacy display prefix from older change-sets
    return _deps.xiName(s);
  };
  // Reconcile an op:add against a placement ALREADY baked into the loaded DAT (same mesh
  // at the same position). Adopting it (vs instantiating a 2nd copy) is what stops the
  // "publish then reload duplicates" bug while keeping the add tracked/undoable.
  const makeAdoptOp = (entry, rec) => ({
    do: () => {
      addedEntries.add(entry);
      const ud = entry.node.userData;
      // Pin a STABLE source identity so the next collectChanges re-emits the ORIGINAL
      // (pre-prefix) name, not the published xi_ name — this stops the change-set name
      // drifting (e.g. _jag_w02_m -> xi__jag_w02_m) every reconcile cycle.
      ud.addName = ((rec.sourceName || rec.name || '') + '').replace(/\.\d+$/, '') || ud.addName;
      if (rec.xiId) ud.xiId = rec.xiId;   // keep the identity group across reload→republish
      if (rec.uid) ud.uid = rec.uid;            // keep the per-instance id so re-save stays dedup-stable
      if (rec.sourceZone) { ud.sourceZone = rec.sourceZone; ud.sourceName = rec.sourceName || null; }
      // Keep the animation on the adopted (baked) node so the re-emitted add still asks for its
      // generator clone; the baked record's own BlockID binding wins for the editor preview.
      const anim = animFromRec(rec.anim);
      if (anim) { ud.animSource = anim; rebindZoneAnim(entry.node); }
      // Carry GLB provenance onto the adopted (baked) node so a later reset+republish can
      // re-import it — the baked node has no glbImport of its own.
      if (rec.glb) ud.glbImport = { sourcePath: rec.glb_source || rec.glb, origin: rec.glbOrigin || rec.glb_source || null, fileName: rec.glbName || rec.glb, opaque: !!rec.opaque, doubleSided: !!rec.doubleSided, lit: rec.shade != null, shade: rec.shade ?? 1.0 };
      markChange(entry.node, rec.ts);
    },
    undo: () => { addedEntries.delete(entry); },
  });
  // Re-instantiate a cross-zone effect paste (op:'add' with source_dat) when no published copy
  // is in the loaded DAT yet — i.e. the paste hasn't been Published. Prefer rebuilding the real
  // source-DAT preview node so refresh shows the effect again; fall back to the placeholder icon
  // only when the preview build fails.
  const makeXZoneEffectAddOp = async (eff, isSoundGen, sourceDat, pos, displayName, ts) => {
    let node = null;
    try {
      node = await _deps.buildSourceEffectPreviewNode(sourceDat, eff.id, eff.sourceOffset ?? null);
      if (node) {
        node.name = displayName || _deps.pastedEffectName(eff.label, eff.id, sourceDat);
        node.position.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
      }
    } catch (e) {
      console.warn('[vfx reload] source preview failed:', sourceDat, eff.id, e);
    }
    if (!node) node = _deps.buildXZoneEffectNode(eff, isSoundGen, pos, displayName);
    const entry = { node, name: node.name, isEffect: true, isSound: !!isSoundGen, sourceDat, sourceId: eff.id, sourceOffset: eff.sourceOffset ?? null,
      ...(eff.newId ? { newId: eff.newId } : {}) };
    return {
      do: () => {
        node.visible = true;
        _deps.getZoneRoot().add(node);
        if (!_deps.getPlacements().includes(entry)) _deps.getPlacements().push(entry);
        _deps.getPlacementSet().add(node);
        addedEntries.add(entry);
        _deps.addVfxIcon(node);
        _deps.setIconVisible(node, true);
        markChange(node, ts);
      },
      undo: () => {
        node.parent?.remove(node);
        const i = _deps.getPlacements().indexOf(entry); if (i >= 0) _deps.getPlacements().splice(i, 1);
        _deps.getPlacementSet().delete(node);
        addedEntries.delete(entry);
        const sp = _deps.getVfxIconGroup() ? _deps.getVfxIconGroup().children.find(s => s.userData.vfxNode === node) : null;
        if (sp && _deps.getVfxIconGroup()) _deps.getVfxIconGroup().remove(sp);
      },
    };
  };
  // Adopt an ALREADY-baked effect (published copy in the loaded DAT) as the tracked cross-zone
  // add, instead of instantiating a duplicate. Pins sourceDat/sourceId so the next collectChanges
  // re-emits the add and the next Publish (which resets from pristine) re-copies it.
  const makeFxAdoptOp = (entry, rec) => ({
    do: () => {
      addedEntries.add(entry);
      entry.sourceDat = rec.source_dat;
      entry.sourceId = rec.source_id;
      entry.sourceOffset = rec.source_offset ?? null;
      // The baked copy's FourCC is the id the next Publish must reuse — pin it (a legacy
      // position-matched adoption pins the generator's own id the same way).
      entry.newId = rec.new_id || entry.node.userData.effect?.sectionId || undefined;
      const fx = entry.node.userData.effect;
      if (fx && rec.mesh && !fx.mesh) fx.mesh = rec.mesh;
      markChange(entry.node, rec.ts);
    },
    undo: () => { addedEntries.delete(entry); entry.sourceDat = undefined; entry.sourceId = undefined; entry.sourceOffset = undefined; entry.newId = undefined; },
  });
  const buildAddNode = (tmplMap, resolvedName, rec, sourceZoneRel, sourceName) => {
    const node = _deps.instantiate(tmplMap, resolvedName);
    node.rotation.order = 'ZYX';
    applyTRS(node, rec);
    const meshId = rec.name;
    const base = _deps.xiName(meshId);
    node.name = _deps.uniquePlacementName(base, reserved);
    reserved.add(node.name);
    node.userData = { placement: { meshId } };
    node.userData.addName = ((sourceName || meshId) + '').replace(/\.\d+$/, '');
    if (rec.xiId) node.userData.xiId = rec.xiId;
    if (rec.uid) node.userData.uid = rec.uid;
    if (sourceZoneRel) { node.userData.sourceZone = sourceZoneRel; node.userData.sourceName = sourceName || null; }
    const anim = animFromRec(rec.anim);
    if (anim) node.userData.animSource = anim;
    node.userData.original = { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() };
    return node;
  };

  // Cache fetched+_deps.getParsed() source zones (for cross-zone adds), keyed by rel path.
  const srcCache = new Map();
  async function getSourceTemplates(rel) {
    if (srcCache.has(rel)) return srcCache.get(rel);
    const url = `game/${rel}`;
    const [buf, kt] = await Promise.all([
      fetch(_deps.datUrl(url)).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }),
      _deps.getKeyTables(),
    ]);
    const sp = _deps.parseZone(buf, kt);
    const out = { meshes: sp.meshes, templates: _deps.buildMeshTemplates(sp.meshes, _deps.buildTextures(sp.textures)) };
    srcCache.set(rel, out);
    return out;
  }

  _deps.setStatus(`loading ${label}…`);
  const pendingGlbAdds = [];
  const adopted = new Set();   // baked _deps.getPlacements() already claimed by an op:add this pass
  const adoptedFx = new Set(); // baked effects already claimed by a cross-zone vfx op:add this pass
  // ---- _deps.getPlacements() ----
  for (const rec of plRecs) {
    try {
      if (rec.op === 'modify') {
        // Sub-area modify → resolve within its interior by (subAreaId, DAT index); never fall back
        // to the main-zone maps (a same-named main object must not absorb an interior edit).
        const e = rec.subAreaId != null
          ? subByKey.get(`${rec.subAreaId}::${rec.index}`)
          : ((rec.instanceName && objByName.get(rec.instanceName)) || objByMesh.get(rec.name));
        if (!e) { skipped.push(`modify ${rec.name}${rec.subAreaId != null ? ` (SubRoom 0x${Number(rec.subAreaId).toString(16)})` : ''} (not in zone)`); continue; }
        ops.push(makeTransformOp(e.node, rec));
      } else if (rec.op === 'delete') {
        const queue = deleteQueues.get(rec.name);
        const e = queue?.length ? queue.shift() : null;
        // Missing target → ghost the delete (mirrors the vfx path) so an in-place reload of the
        // post-publish DAT (object already gone) doesn't drop the delete from the change-set.
        ops.push(makeRemoveOp(e || makeGhostDeletedEntry(rec, false), rec.ts));
      } else if (rec.op === 'add') {
        // Reconcile: if a copy of this add is ALREADY baked into the loaded DAT (same xi_
        // mesh at the same position), adopt that placement as the tracked add instead of
        // instantiating a duplicate. This is the "recognize it on reload" fix — it stops
        // publish→reload doubling while keeping undo/track intact.
        // Key on the PUBLISHED mesh name derived from the SOURCE name (mirrors Python),
        // not the mutable display name. Adopt the NEAREST un-adopted placement of that mesh
        // — NOT a hard position gate. The old ±0.5-per-axis gate missed once the baked pos
        // drifted from the change-set pos (post-publish nudge / reset-off), re-instantiating
        // a duplicate. meshId may carry a custom-import suffix (GLB 'xi_new_floor0001' vs
        // target 'xi_new_floor'), so match exact-or-startsWith. Only fall through to
        // (re-instantiate / GLB re-import) when NO un-adopted placement of this mesh remains.
        {
          const tgt = _xiTarget(rec.sourceName || rec.name);
          const cands = _deps.getPlacements().filter((p) => {
            if (p.isEffect || adopted.has(p) || addedEntries.has(p)) return false;
            const m = p.node.userData.placement?.meshId;
            return m === tgt || (m && m.startsWith(tgt));
          });
          if (cands.length) {
            let twin = cands[0];
            if (rec.pos && cands.length > 1) {
              const d2 = (p) => { const q = p.node.position; return (q.x - rec.pos[0]) ** 2 + (q.y - rec.pos[1]) ** 2 + (q.z - rec.pos[2]) ** 2; };
              twin = cands.reduce((a, b) => (d2(b) < d2(a) ? b : a));
            }
            adopted.add(twin); ops.push(makeAdoptOp(twin, rec)); continue;
          }
        }
        if (rec.glb) {
          // If the mesh is already baked into the zone (prior publish), clone from the
          // existing template instead of re-importing the GLB file. Handles Restore when
          // all published instances are adopted but one more is still needed — the GLB
          // path can also fail if the source file has moved since the original import.
          const resolvedFromZone = _deps.getParsed()?.meshes ? _deps.resolveMeshName(rec.name, _deps.getParsed().meshes) : null;
          if (resolvedFromZone) {
            ops.push(makeAddOp(buildAddNode(_deps.getTemplates(), resolvedFromZone, rec, null, null), rec.ts));
          } else {
            pendingGlbAdds.push(rec);
          }
          continue;
        }
        if (rec.sourceZone) {
          // Prefer the current zone if the mesh already exists locally; else fetch the source DAT.
          let tmplMap, meshesMap;
          if (_deps.getParsed()?.meshes && _deps.resolveMeshName(rec.name, _deps.getParsed().meshes)) { tmplMap = _deps.getTemplates(); meshesMap = _deps.getParsed().meshes; }
          else { const src = await getSourceTemplates(rec.sourceZone); tmplMap = src.templates; meshesMap = src.meshes; }
          const resolved = _deps.resolveMeshName(rec.name, meshesMap);
          if (!resolved) { skipped.push(`add ${rec.name} (mesh not found in ${rec.sourceZone})`); continue; }
          ops.push(makeAddOp(buildAddNode(tmplMap, resolved, rec, rec.sourceZone, rec.sourceName), rec.ts));
        } else {
          // Same-zone duplicate: the mesh must already exist in this zone.
          const resolved = _deps.getParsed()?.meshes ? _deps.resolveMeshName(rec.name, _deps.getParsed().meshes) : null;
          if (!resolved) { skipped.push(`add ${rec.name} (mesh not in zone)`); continue; }
          ops.push(makeAddOp(buildAddNode(_deps.getTemplates(), resolved, rec, null, null), rec.ts));
        }
      } else {
        skipped.push(`${rec.op || '?'} ${rec.name || ''} (unknown placement op)`);
      }
    } catch (err) {
      console.error('[load]', rec, err);
      skipped.push(`${rec.op} ${rec.name || ''} (${err.message})`);
    }
  }
  // ---- vfx ----
  // Ids the backend pinned to this change-set's pasted effects at an earlier Publish (`new_id`).
  // A baked generator with that id IS the paste: adopt it by id (position may have moved since),
  // and treat modify/remove ops recorded against that id — the editor emitted them while the
  // copy was still an unmatched duplicate — as edits of the add itself: a modify moves the adopted
  // node (the re-emitted add then carries that position), a remove cancels the add.
  const pinnedIds = new Set(fxIn.filter(r => r.op === 'add' && r.source_dat && r.new_id).map(r => r.new_id));
  const removedPinned = new Set(fxIn.filter(r => r.op === 'remove' && r.id && pinnedIds.has(r.id)).map(r => r.id));
  for (const rec of fxIn) {
    if (rec.op !== 'add' && rec.id && pinnedIds.has(rec.id)) {
      const tw = fxById.get(rec.id);
      if (tw) {
        if (rec.op === 'modify') ops.push(makeVfxModifyOp(tw.node, rec));
        else if (rec.op === 'remove') ops.push(makeRemoveOp(tw, rec.ts));
      }
      continue;
    }
    // Cross-zone VFX/SFX paste (op:'add' carrying source_dat). After Publish the copy is baked
    // into the loaded DAT, so ADOPT the matching baked effect — by its pinned id when the
    // change-set has one, else same type at the recorded position — to avoid a duplicate. Before
    // Publish there's nothing baked → re-instantiate the placeholder so the paste survives the
    // reload and re-applies on the next Publish.
    if (rec.op === 'add' && rec.source_dat) {
      if (rec.new_id && removedPinned.has(rec.new_id)) continue;   // the user deleted the baked copy
      const isSound = !!(rec.sound || /^sound /.test(rec.name || ''));
      const cands = _deps.getPlacements().filter(p => {
        if (!p.isEffect || adoptedFx.has(p) || addedEntries.has(p) || usedFx.has(p)) return false;
        if (isSound) return !!p.isSound;
        if (p.isSound) return false;
        const m = p.node.userData.effect?.mesh;
        return rec.mesh ? m === rec.mesh : true;
      });
      let twin = null;
      if (rec.new_id) {
        const byId = fxById.get(rec.new_id);
        if (byId && !adoptedFx.has(byId) && !addedEntries.has(byId) && !usedFx.has(byId)) twin = byId;
      }
      if (!twin && cands.length && Array.isArray(rec.pos)) {
        const d2 = (p) => { const q = p.node.position; return (q.x - rec.pos[0]) ** 2 + (q.y - rec.pos[1]) ** 2 + (q.z - rec.pos[2]) ** 2; };
        const nearest = cands.reduce((a, b) => (d2(b) < d2(a) ? b : a));
        // Tight gate: the backend patches the baked copy's position to rec.pos, so the real
        // twin sits ON it. A pre-existing same-type effect elsewhere must NOT be adopted.
        if (d2(nearest) <= 4.0) twin = nearest;
      }
      if (twin) {
        adoptedFx.add(twin); usedFx.add(twin);
        ops.push(makeFxAdoptOp(twin, rec));
      } else {
        const label = (rec.name || '').replace(/\s*\[[^\]]*\](\.\d+)?$/, '').trim() || 'effect';
        const eff = { id: rec.source_id, sourceOffset: rec.source_offset ?? null, label, mesh: rec.mesh ?? null, newId: rec.new_id || null };
        ops.push(await makeXZoneEffectAddOp(eff, isSound, rec.source_dat, rec.pos || [0, 0, 0], rec.name, rec.ts));
      }
      continue;
    }
    const e = resolveFx(rec);
    if (!e) {
      // Not in the loaded scene. For a remove that's expected in in-place mode (the published
      // DAT no longer contains the deleted generator) — keep a ghost so the delete survives the
      // reload and re-applies on the next Publish. A modify of a missing target is dropped.
      if (rec.op === 'remove') ops.push(makeRemoveOp(makeGhostDeletedEntry(rec, true), rec.ts));
      else skipped.push(`vfx ${rec.op} ${rec.name || rec.id} (not in zone / already matched)`);
      continue;
    }
    if (rec.op === 'remove') ops.push(makeRemoveOp(e, rec.ts));
    else if (rec.op === 'modify') ops.push(makeVfxModifyOp(e.node, rec));
    else skipped.push(`vfx ${rec.op} ${rec.id} (unsupported)`);
  }
  // ---- GLB re-imports ----
  // Try custom/<glb> first (zone-custom junction); fall back to a file picker.
  for (const rec of pendingGlbAdds) {
    // rec.glb may be an absolute source path now — match assets by the bare basename.
    const bare = rec.glbName || (rec.glb || '').split(/[\\/]/).pop();
    const url = `custom/${bare}`;
    let buf = null;
    try {
      const r = await fetch(_deps.datUrl(url));
      if (r.ok) buf = await r.arrayBuffer();
    } catch { /* network error — fall through to picker */ }

    if (buf) {
      try {
        ops.push(makeAddOp(await _deps.buildGlbNode(new File([buf], bare), rec, reserved), rec.ts));
      } catch (err) {
        console.error('[load glb]', rec, err);
        skipped.push(`add ${rec.name} (custom/${bare}: ${err.message})`);
      }
      continue;
    }

    // Not in custom/ — ask the backend for the bytes (workspace copy, else the stored
    // absolute source path) so we don't have to prompt for GLBs we already persisted.
    if (bridgeOnline()) {
      try {
        const a = await bridgeCall('zone.getAsset', { zone: _deps.getCurrentZoneUrl(), name: bare, glb: rec.glb });
        if (a && a.ok && a.bytesBase64) {
          const bin = atob(a.bytesBase64), u = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
          try { ops.push(makeAddOp(await _deps.buildGlbNode(new File([u.buffer], bare), rec, reserved), rec.ts)); }
          catch (err) { console.error('[load glb]', rec, err); skipped.push(`add ${rec.name} (${bare}: ${err.message})`); }
          continue;
        }
      } catch { /* fall through to the manual picker */ }
    }

    // Not found anywhere — prompt for the file.
    _deps.setStatus(`${bare} not found — pick it manually…`);
    const src = await pickGlbSource([bare]);
    if (!src) { skipped.push(`add ${rec.name} (cancelled)`); continue; }
    try {
      let file;
      if (src.kind === 'dir') {
        file = await src.handle.getFileHandle(bare).then(fh => fh.getFile());
      } else {
        file = [...src.files].find(f => f.name === bare);
        if (!file) { skipped.push(`add ${rec.name} (${bare} not picked)`); continue; }
      }
      ops.push(makeAddOp(await _deps.buildGlbNode(file, rec, reserved), rec.ts));
    } catch (err) {
      console.error('[load glb]', rec, err);
      skipped.push(`add ${rec.name} (${bare}: ${err.message})`);
    }
  }

  if (!ops.length && !markersIn.length && !collisionsIn.length && !textPlanesIn.length) {
    if (_deps.getFootstepSourceZone()) {
      _deps.updateChangesUI();
      _deps.setStatus(`load: footstep source restored from ${label}`);
      return;
    }
    _deps.setStatus(`load: nothing applied${skipped.length ? ` — ${skipped.length} skipped` : ''}`, true);
    if (skipped.length) console.warn('[load] skipped:\n' + skipped.join('\n'));
    return;
  }

  if (ops.length) {
    const finalize = () => {
      _deps.getSelectionEl().textContent = 'nothing selected';
      _deps.clearSelectionOutline(); _deps.updateSelectionOutline(); _deps.updateSelectionReadout();
      _deps.buildObjectList();
    };
    const runAll = () => { _deps.select(null); _deps.getTransform().detach(); for (const o of ops) o.do(); finalize(); };
    const undoAll = () => { for (let i = ops.length - 1; i >= 0; i--) ops[i].undo(); finalize(); };
    runAll();
    if (recordHistory) _deps.pushCommand({ undo: undoAll, redo: runAll });
  }

  for (const rec of markersIn) await _deps.addMarkerFromRec(rec);
  if (markersIn.length) { _deps.buildObjectList(); _deps.updateChangesUI(); }

  for (const rec of collisionsIn) _deps._buildCollisionPrimFromRec(rec);
  if (collisionsIn.length) { _deps.buildObjectList(); _deps.updateChangesUI(); _deps.applyIsolateCollision(); }

  for (const rec of textPlanesIn) _deps.addTextPlaneFromRec(rec);
  if (textPlanesIn.length) { _deps.buildObjectList(); _deps.updateChangesUI(); }

  const parts = [];
  if (ops.length) parts.push(`${ops.length} change(s)`);
  if (markersIn.length) parts.push(`${markersIn.length} marker(s)`);
  if (textPlanesIn.length) parts.push(`${textPlanesIn.length} text plane(s)`);
  if (collisionsIn.length) parts.push(`${collisionsIn.length} collision prim(s)`);
  const msg = (parts.length ? parts.join(' + ') : 'no changes') +
    ` from ${label}` + (skipped.length ? ` — ${skipped.length} skipped (see console)` : '');
  _deps.setStatus(msg);
  if (skipped.length) console.warn('[load] skipped:\n' + skipped.join('\n'));

  // Added objects (GLB imports, copies, markers, collision prims, text planes) only come into
  // existence HERE — after loadZone's initial restoreLockOverrides/restoreVisibilityOverrides ran
  // over the zone-native _deps.getPlacements() alone. Re-apply the per-object lock + visibility overrides
  // (keyed by name in localStorage) so a locked/hidden added object STAYS that way across a reload,
  // e.g. switching projects and coming back. Without this, added-object locks silently reset.
  if (ops.length || markersIn.length || collisionsIn.length || textPlanesIn.length) {
    _deps.restoreLockOverrides(_deps.getCurrentZoneUrl());
    _deps.restoreVisibilityOverrides(_deps.getCurrentZoneUrl());
    _deps.autoGroupXiEffects();
    _deps.buildObjectList();
  }
  _deps.updateChangesUI();
}


// Init
export function initChangesTracker(deps) {
  _deps = deps;
}
