// ── core/zone-animations.js ──────────────────────────────────────────────────
// Generator-driven object animation ("zone animations").
//
// The client never draws a 0x1C placement whose BlockID (+0x34) names a 0x05 generator
// (ZoneRenderer::SetRenderTypes → RenderType 0). The generator draws the linked 0x2E mesh
// itself: StandardSetup carries the object's position, sec2 0x09 its rotation, and the
// motion opcodes animate it — Rabao's windmill blades (de_fusya02 ← f001/f002) spin from a
// RotationVelocity (0x0B) integrated by the sec3 RotationUpdater (0x05), 0.0122 rad per
// 60 Hz effect frame. Every non-door BlockID across the 597 retail zone DATs resolves to a
// generator in the same DAT (1,938 records); the '_'/'@' groups are the client's door
// UnderscoreAtStructs and are not handled here.
//
// The editor keeps the placement node as THE editable object (gizmo, selection, publish)
// and plays the generator's motion on the node's child meshes as a rotation relative to the
// generator's own base rotation — so a user-yawed windmill still spins about its own axle.
// View → Play Animations toggles playback; off restores the static DAT pose.
//
// Bindings resolve lazily per node (WeakMap), so pasted copies pick up their motion too:
//   • native records: userData.placement.blockId → a generator of the loaded zone
//   • pasted copies:  userData.animSource — carried by the clipboard / change-set with the
//     motion parameters inline, so a cross-zone paste previews without a source-DAT fetch.
//     Publish clones the generator and stamps the new record's BlockID (import-json `anim`).
import * as THREE from 'three';
import { parseEffects, describeObjectAnimation } from '../ffxi/effects.js';

let _R = {};   // { getPlacements, loadSetting, saveSetting }
export function initZoneAnimations(refs) {
  _R = refs;
  playing = !!(_R.loadSetting ? _R.loadSetting('playAnimations', true) : true);
}

const FX_FPS = 60;              // the effect clock: opcode velocities are per 1/60 s frame
let playing = true;
let clips = new Map();          // generator id → describeObjectAnimation() for the loaded zone
let bindings = new WeakMap();   // node → binding | null (null = evaluated, not animated)
let clock = 0;                  // effect frames since the zone loaded (one clock for all objects)

export function isPlayingAnimations() { return playing; }

export function setPlayAnimations(on) {
  playing = !!on;
  _R.saveSetting?.('playAnimations', playing);
  if (!playing) restoreStaticPose();
}

/** loadZone hook, right after the DAT is parsed: index every generator that animates an object. */
export function loadZoneAnimations(datBuf) {
  clearZoneAnimations();
  if (!datBuf) return;
  let effects;
  try { effects = parseEffects(datBuf); } catch (e) { console.warn('[zone-anim] effects parse failed', e); return; }
  for (const gen of effects.generators) {
    const clip = describeObjectAnimation(gen);
    if (!clip) continue;
    const key = clip.sectionId.trim();
    const prev = clips.get(key);
    // A FourCC can repeat across weather/sub-directories; prefer the autoRun (world) copy.
    if (!prev || (clip.autoRun && !prev.autoRun)) clips.set(key, clip);
  }
}

export function clearZoneAnimations() { clips = new Map(); bindings = new WeakMap(); clock = 0; }

/** Forget a node's cached binding (call after changing its placement.blockId / animSource). */
export function rebindZoneAnim(node) {
  if (!node) return;
  bindings.delete(node);
  if (node.userData) delete node.userData.zoneAnim;
}

function isObjectEntry(p) {
  return !!p?.node && !p.isEffect && !p.isSky && !p.isMarker && !p.isSound && !p.isMob
    && !p.isCollisionPrimitive && !p.isTextPlane && !p.isTextBaked;
}

function makeBinding(node, clip, native) {
  const order = clip.rotationOrder === 'ZYX' ? 'ZYX' : 'XYZ';
  const rotation = (clip.rotation || [0, 0, 0]).map(Number);
  const rotVelocity = (clip.rotVelocity || [0, 0, 0]).map(Number);
  // The generator's transform is T(base) · R(rotation, order); the placement node already
  // carries the same pose, so the animated pose relative to the node is R(base)⁻¹ · R(t).
  const qBaseInv = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2], order)).invert();
  const genId = String(clip.sectionId ?? clip.sourceId ?? '').trim();
  return {
    node, order, rotation, rotVelocity, qBaseInv,
    qRel: new THREE.Quaternion(), euler: new THREE.Euler(0, 0, 0, order), posed: false,
    info: { genId, sourceOffset: clip.sourceOffset ?? null, sourceDat: clip.sourceDat ?? null,
      rotation, rotVelocity, rotationOrder: order, native },
  };
}

/**
 * The animation bound to a placement node, or null. Resolved once per node and cached;
 * a native BlockID wins over a paste-carried animSource (after Publish the baked record has
 * both, and the baked generator holds the object's real pose).
 */
export function zoneAnimFor(node) {
  if (!node) return null;
  if (bindings.has(node)) return bindings.get(node)?.info ?? null;
  let b = null;
  const id = node.userData?.placement?.blockId;
  const clip = id ? clips.get(String(id).trim()) : null;
  if (clip?.spins) b = makeBinding(node, clip, true);
  else if (node.userData?.animSource?.rotVelocity) b = makeBinding(node, node.userData.animSource, false);
  bindings.set(node, b);
  if (node.userData) {
    if (b) node.userData.zoneAnim = b.info; else delete node.userData.zoneAnim;
  }
  return b?.info ?? null;
}

/**
 * The serializable motion record a copy of `node` carries (clipboard item / change-set add):
 * which generator to clone (id, DAT, offset) plus the motion itself for the editor preview.
 */
export function animSourceFor(node, zoneRel) {
  const src = node?.userData?.animSource;
  if (src?.rotVelocity) return { ...src, rotation: [...(src.rotation || [0, 0, 0])], rotVelocity: [...src.rotVelocity] };
  const info = zoneAnimFor(node);
  if (!info) return null;
  return {
    sourceId: info.genId, sourceDat: info.sourceDat || zoneRel || null, sourceOffset: info.sourceOffset,
    rotation: [...info.rotation], rotVelocity: [...info.rotVelocity], rotationOrder: info.rotationOrder,
  };
}

/** Human label for the readout / list badge, e.g. "spins Z +42°/s". */
export function describeZoneAnim(info) {
  if (!info) return '';
  const v = info.rotVelocity || [0, 0, 0];
  let axis = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(v[i]) > Math.abs(v[axis])) axis = i;
  const degPerSec = v[axis] * FX_FPS * 180 / Math.PI;
  if (!degPerSec) return 'static';
  return `spins ${'XYZ'[axis]} ${degPerSec > 0 ? '+' : ''}${Math.round(degPerSec)}°/s`;
}

/** Evaluate every current placement's binding (so list badges show before the first frame). */
export function bindPlacements() {
  for (const p of _R.getPlacements?.() || []) if (isObjectEntry(p)) zoneAnimFor(p.node);
}

/** Render-loop tick: pose every bound object at the shared effect clock. */
export function updateZoneAnimations(dt) {
  if (!playing) return;
  const placements = _R.getPlacements?.();
  if (!placements?.length) return;
  clock += Math.min(Math.max(dt || 0, 0), 0.25) * FX_FPS;
  for (const p of placements) {
    if (!isObjectEntry(p)) continue;
    const node = p.node;
    if (!bindings.has(node)) zoneAnimFor(node);
    const b = bindings.get(node);
    if (!b || !node.visible) continue;
    const [rx, ry, rz] = b.rotation, [vx, vy, vz] = b.rotVelocity;
    b.euler.set(rx + vx * clock, ry + vy * clock, rz + vz * clock);
    b.qRel.setFromEuler(b.euler).premultiply(b.qBaseInv);
    for (const c of node.children) if (c.isMesh) c.quaternion.copy(b.qRel);
    b.posed = true;
  }
}

function restoreStaticPose() {
  for (const p of _R.getPlacements?.() || []) {
    if (!isObjectEntry(p)) continue;
    const b = bindings.get(p.node);
    if (!b?.posed) continue;
    for (const c of p.node.children) if (c.isMesh) c.quaternion.identity();
    b.posed = false;
  }
}
