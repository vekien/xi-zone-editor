// markers.js — editor-only billboard marker pins (not published to the zone DAT).
// All markers use the same Material Symbols pin style as cutscene position markers.
// Init via initMarkers({ getZoneRoot, getPlacementSet, getPlacements,
//   getSurfacePointAhead, buildObjectList, select, pushCommand, setStatus,
//   getEditMode }).

import * as THREE from 'three';

export const MARKER_SCALE = 0.75;
export const CS_MARKER_SCALE = 0.75;
export const CS_MARKER_COLOR = '#42d9c8';
export const DEFAULT_MARKER_GLYPH = 'flag';

// Old ui/markers/N.png ids → Material Symbols glyphs (workspace loads).
const LEGACY_ICON_TO_GLYPH = {
  1: 'flag',
  2: 'person',
  3: 'swords',
  4: 'deployed_code',
  5: 'sensor_door',
  6: 'star',
  7: 'location_on',
  8: 'route',
  9: 'pets',
  10: 'volume_up',
};

export function resolveMarkerGlyph(iconOrRec) {
  if (iconOrRec == null) return DEFAULT_MARKER_GLYPH;
  if (typeof iconOrRec === 'object') {
    if (iconOrRec.csIcon) return iconOrRec.csIcon;
    return resolveMarkerGlyph(iconOrRec.icon);
  }
  if (typeof iconOrRec === 'string' && !/^\d+$/.test(iconOrRec)) return iconOrRec;
  const n = Number(iconOrRec);
  return LEGACY_ICON_TO_GLYPH[n] || DEFAULT_MARKER_GLYPH;
}

const _pinTexCache = new Map();

// A map-pin (teardrop + white disc) rendered to a canvas, tinted `color`, with a
// chosen Material Symbols glyph (ligature name, e.g. "person") in the disc.
// Cached per colour+glyph. Tip sits at center 0.5,0.
export function getPinTexture(color = CS_MARKER_COLOR, glyph = 'location_on') {
  const key = color + '|' + glyph;
  if (_pinTexCache.has(key)) return _pinTexCache.get(key);
  const S = 128, c = Object.assign(document.createElement('canvas'), { width: S, height: S }).getContext('2d');
  const cx = S / 2, cy = S * 0.40, r = S * 0.30;
  c.beginPath();
  c.moveTo(cx, S * 0.96);
  c.bezierCurveTo(cx - r * 1.12, cy + r * 1.05, cx - r, cy - r * 0.2, cx - r, cy);
  c.arc(cx, cy, r, Math.PI, 0, false);
  c.bezierCurveTo(cx + r, cy - r * 0.2, cx + r * 1.12, cy + r * 1.05, cx, S * 0.96);
  c.closePath();
  c.fillStyle = color; c.fill();
  c.lineWidth = 5; c.strokeStyle = 'rgba(0,0,0,0.45)'; c.stroke();
  c.beginPath(); c.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
  c.fillStyle = '#ffffff'; c.fill();
  c.fillStyle = '#12222c';
  c.font = `${Math.round(r * 1.15)}px "Material Symbols Outlined"`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(glyph, cx, cy + 1);
  const tex = new THREE.CanvasTexture(c.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  _pinTexCache.set(key, tex);
  return tex;
}

// Glyphs need the icon font rasterised; if a pin was drawn before the font loaded,
// re-render once fonts are ready.
if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    _pinTexCache.clear();
    for (const p of (_getPlacements ? _getPlacements() : [])) {
      const ud = p.node && p.node.userData;
      if (ud && ud.markerCsIcon && p.node.material) {
        p.node.material.map = getPinTexture(ud.markerColor || CS_MARKER_COLOR, ud.markerCsIcon);
        p.node.material.needsUpdate = true;
      }
    }
  });
}

function _makePinSprite({ glyph, color, type, desc, name, pos, rot, scale }) {
  const g = resolveMarkerGlyph(glyph);
  const col = color || CS_MARKER_COLOR;
  const mat = new THREE.SpriteMaterial({
    map: getPinTexture(col, g),
    depthWrite: false,
    transparent: true,
    sizeAttenuation: true,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.center.set(0.5, 0);
  const sc = scale || MARKER_SCALE;
  if (Array.isArray(sc)) sprite.scale.set(...sc);
  else sprite.scale.set(sc, sc, 1);
  sprite.userData.markerCsIcon = g;
  sprite.userData.markerColor = col;
  sprite.userData.markerDesc = desc || '';
  sprite.userData.markerType = type || 'Spawn';
  delete sprite.userData.markerIcon;
  if (pos) sprite.position.set(pos[0], pos[1], pos[2]);
  if (rot) sprite.rotation.set(rot[0], rot[1], rot[2]);
  return sprite;
}

function _ensureMarkerGroup(zoneRoot) {
  if (!markerGroup) {
    markerGroup = new THREE.Group();
    markerGroup.name = '__markers';
    zoneRoot.add(markerGroup);
  }
  return markerGroup;
}

// Add a cutscene position marker (vector pin) at a zone-local position (or the
// surface ahead if omitted). Returns the placement entry.
export function addCsMarker({ pos = null, color = CS_MARKER_COLOR, name = null, desc = '', icon = 'location_on' } = {}) {
  const zoneRoot = _getZoneRoot();
  if (!zoneRoot) { _setStatus('load a zone first'); return null; }
  const sprite = _makePinSprite({
    glyph: icon,
    color,
    type: 'Sequencer Actor Position',
    desc,
    name,
  });
  if (pos) sprite.position.set(pos[0], pos[1], pos[2]);
  else sprite.position.copy(zoneRoot.worldToLocal(_getSurface(10)));
  _ensureMarkerGroup(zoneRoot).add(sprite);
  _getPlacementSet().add(sprite);
  const placements = _getPlacements();
  sprite.name = name || `pos_marker_${placements.filter((p) => p.isMarker).length + 1}`;
  const entry = { node: sprite, name: sprite.name, isMarker: true };
  placements.push(entry);
  _buildObjectList();
  _select(entry);
  return entry;
}

let _getZoneRoot       = null;
let _getPlacementSet   = null;
let _getPlacements     = null;
let _getSurface        = null;
let _buildObjectList   = null;
let _select            = null;
let _pushCommand       = null;
let _setStatus         = null;
let _getEditMode       = null;

let markerGroup = null;
export function getMarkerGroup() { return markerGroup; }
export function setMarkerGroup(g) { markerGroup = g; }

export function initMarkers({ getZoneRoot, getPlacementSet, getPlacements, getSurfacePointAhead,
    buildObjectList, select, pushCommand, setStatus, getEditMode }) {
  _getZoneRoot     = getZoneRoot;
  _getPlacementSet = getPlacementSet;
  _getPlacements   = getPlacements;
  _getSurface      = getSurfacePointAhead;
  _buildObjectList = buildObjectList;
  _select          = select;
  _pushCommand     = pushCommand;
  _setStatus       = setStatus;
  _getEditMode     = getEditMode;
}

export function resetMarkerGroup() { markerGroup = null; }

// Kept for callers that still import it; returns a pin texture (glyph or legacy id).
export function getMarkerTexture(icon = DEFAULT_MARKER_GLYPH) {
  return Promise.resolve(getPinTexture(CS_MARKER_COLOR, resolveMarkerGlyph(icon)));
}

export async function addMarker(icon = DEFAULT_MARKER_GLYPH) {
  if (!_getEditMode()) { _setStatus('Switch to Edit mode to add markers', true); return; }
  const zoneRoot = _getZoneRoot();
  if (!zoneRoot) { _setStatus('load a zone first'); return; }
  const glyph = resolveMarkerGlyph(icon);
  const sprite = _makePinSprite({ glyph, type: 'Spawn' });
  sprite.position.copy(zoneRoot.worldToLocal(_getSurface(10)));
  _ensureMarkerGroup(zoneRoot).add(sprite);
  _getPlacementSet().add(sprite);
  const placements = _getPlacements();
  let markerIdx = placements.filter((p) => p.isMarker).length + 1;
  const name = `marker_${glyph}_${markerIdx}`;
  sprite.name = name;
  const entry = { node: sprite, name, isMarker: true };
  placements.push(entry);
  _buildObjectList();
  _select(entry);
  return entry;
}

export async function addMarkerFromRec(rec) {
  const zoneRoot = _getZoneRoot();
  if (!zoneRoot) return null;
  const glyph = resolveMarkerGlyph(rec);
  const sprite = _makePinSprite({
    glyph,
    color: rec.color || CS_MARKER_COLOR,
    type: rec.type || 'Spawn',
    desc: rec.desc || '',
    pos: rec.pos,
    rot: rec.rot,
    scale: rec.scale,
  });
  const placements = _getPlacements();
  sprite.name = rec.name || `marker_${glyph}_${placements.filter(p => p.isMarker).length + 1}`;
  _ensureMarkerGroup(zoneRoot).add(sprite);
  _getPlacementSet().add(sprite);
  const entry = { node: sprite, name: sprite.name, isMarker: true };
  placements.push(entry);
  return entry;
}

// Drop a marker onto the zone floor beneath it.
export function pinMarkerToFloor(entry) {
  const zoneRoot = _getZoneRoot();
  if (!zoneRoot || !entry?.node) return null;
  const world = entry.node.getWorldPosition(new THREE.Vector3());
  const origin = world.clone(); origin.y += 1.5;
  const ray = new THREE.Raycaster(origin, new THREE.Vector3(0, -1, 0), 0, 200);
  const meshes = [];
  (function walk(o) {
    if (o === markerGroup || o.name === '__cutscene_actors' || o.visible === false) return;
    if (o.isMesh) meshes.push(o);
    for (const c of o.children) walk(c);
  })(zoneRoot);
  const hit = ray.intersectObjects(meshes, false)[0];
  if (!hit) return null;
  const local = zoneRoot.worldToLocal(hit.point.clone());
  entry.node.position.y = local.y;
  return local.y;
}

export function collectMarkerChanges() {
  const trs = (v) => [+v.x.toFixed(6), +v.y.toFixed(6), +v.z.toFixed(6)];
  return _getPlacements().filter(p => p.isMarker).map(p => ({
    entry: p, node: p.node, name: p.name,
    csIcon: p.node.userData.markerCsIcon || DEFAULT_MARKER_GLYPH,
    color: p.node.userData.markerColor || CS_MARKER_COLOR,
    desc: p.node.userData.markerDesc || '',
    type: p.node.userData.markerType || 'Spawn',
    pos: trs(p.node.position), rot: trs(p.node.rotation), scale: trs(p.node.scale),
  }));
}

export function updateMarkerDetailsPanel(markerDetailsPanel, mdetType, mdetName, mdetIcon, selected, mdetColor, mdetDesc, mdetCsIcon) {
  if (!markerDetailsPanel) return;
  if (!selected?.isMarker) { markerDetailsPanel.classList.remove('open'); return; }
  markerDetailsPanel.classList.add('open');
  const ud = selected.node.userData;
  const glyph = ud.markerCsIcon || resolveMarkerGlyph(ud.markerIcon);
  markerDetailsPanel.classList.add('is-cs-marker');
  if (mdetType) mdetType.value = ud.markerType || 'Spawn';
  if (mdetName) mdetName.value = selected.name;
  if (mdetCsIcon) mdetCsIcon.value = glyph;
  if (mdetColor) mdetColor.value = ud.markerColor || CS_MARKER_COLOR;
  if (mdetDesc) mdetDesc.value = ud.markerDesc || '';
}

export function setMarkerVisibility(visible, placements) {
  for (const p of placements) {
    if (!p.isMarker) continue;
    p.node.visible = visible;
    const cb = p.li?.querySelector('input.vis');
    if (cb) cb.checked = visible;
  }
}
