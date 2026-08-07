// ── core/player-marker.js ────────────────────────────────────────────────────
// Player spawn marker, spawn-warning heuristic, detail panels for markers /
// collision / sounds, footstep source UI, and mob-spawn DB writer.
// Extracted from main.js. Call initPlayerMarker(refs) once at startup.

import * as THREE from 'three';
import { loadSetting } from '../editor/settings.js';
import { bridgeOnline, bridgeCall } from '../ffxi/bridge.js';

let _R = {};
export function initPlayerMarker(refs) { _R = refs; }

// ── Detail panels ─────────────────────────────────────────────────────────────
export function updateMarkerDetailsPanel() {
  _R.updateMarkerDetailsPanelImpl(
    _R.getEl('marker-details'),
    _R.getEl('mdet-type'),
    _R.getEl('mdet-name'),
    _R.getEl('mdet-icon'),
    _R.getSelected(),
    _R.getEl('mdet-color'),
    _R.getEl('mdet-desc'),
    _R.getEl('mdet-cs-icon')
  );
}

export function updateCollisionDetailsPanel() {
  const collisionDetailsPanel = _R.getEl('collision-details');
  if (!collisionDetailsPanel) return;
  const selected = _R.getSelected();
  if (!selected?.isCollisionPrimitive) { collisionDetailsPanel.classList.remove('open'); return; }
  collisionDetailsPanel.classList.add('open');
  const m = selected.node.userData.collisionMat || _R.defaultCollisionMat(selected.collisionType || 'box');
  const cdetBlockCamera = _R.getEl('cdet-block-camera');
  const cdetTerrain = _R.getEl('cdet-terrain');
  const cdetSegsRow = _R.getEl('cdet-segs-row');
  const cdetSegX = _R.getEl('cdet-seg-x');
  const cdetSegY = _R.getEl('cdet-seg-y');
  const cdetSegZ = _R.getEl('cdet-seg-z');
  const cdetSegXText  = _R.getEl('cdet-seg-x-text');
  const cdetSegYLabel = _R.getEl('cdet-seg-y-label');
  const cdetSegZLabel = _R.getEl('cdet-seg-z-label');
  if (cdetBlockCamera) cdetBlockCamera.checked = !m.wall;
  if (cdetTerrain) cdetTerrain.value = String(m.terrain | 0);
  const type = selected.collisionType;
  const showSegs = type === 'box' || type === 'plane' || type === 'mesh';
  if (cdetSegsRow) cdetSegsRow.style.display = showSegs ? '' : 'none';
  if (showSegs) {
    const segs = selected.subdivSegs || _R.collisionPrimSegs(type, selected.node.scale);
    if (cdetSegX) cdetSegX.value = segs.x;
    if (cdetSegY) cdetSegY.value = segs.y;
    if (cdetSegZ) cdetSegZ.value = segs.z;
    if (cdetSegXText)  cdetSegXText.style.display  = type === 'mesh' ? 'none' : '';
    if (cdetSegYLabel) cdetSegYLabel.style.display = (type === 'plane' || type === 'mesh') ? 'none' : '';
    if (cdetSegZLabel) cdetSegZLabel.style.display = type === 'mesh' ? 'none' : '';
  }
}

export function updateSoundDetailsPanel() {
  const soundDetailsPanel = _R.getEl('sound-details');
  if (!soundDetailsPanel) return;
  const selected = _R.getSelected();
  if (!selected?.isSound) { soundDetailsPanel.classList.remove('open'); return; }
  soundDetailsPanel.classList.add('open');
  const fx = selected.node.userData.effect || {};
  const added = _R.getAddedEntries().has(selected);
  const sdetId = _R.getEl('sdet-id');
  const sdetRepeat = _R.getEl('sdet-repeat');
  const sdetNote = _R.getEl('sdet-note');
  if (sdetId) sdetId.textContent = fx.soundFile || ('se' + String(fx.soundId ?? 0).padStart(6, '0'));
  if (sdetRepeat) { sdetRepeat.checked = !!fx.repeat; sdetRepeat.disabled = !added; }
  if (sdetNote) sdetNote.style.display = added ? '' : 'none';
}

// ── Footstep source UI ────────────────────────────────────────────────────────
export function populateFootstepSourceZones() {
  const footstepSourceZoneEl = _R.getEl('footstep-source-zone');
  if (!footstepSourceZoneEl) return;
  const footstepSourceZone = _R.getFootstepSourceZone();
  const zonesData = _R.getZonesData();
  const customZonesData = _R.getCustomZonesData();
  const current = footstepSourceZoneEl.value || footstepSourceZone || '';
  footstepSourceZoneEl.innerHTML = '';
  footstepSourceZoneEl.add(new Option('Keep DAT as-is', ''));

  const seen = new Set();
  const optionText = (z) => {
    const rel = (z.path || '').replace(/^game(-hd)?\//, '');
    return z.name ? `${z.name} — ${rel}` : rel;
  };
  const addGroup = (label, entries) => {
    const filtered = entries.filter((z) => z?.path && !seen.has(z.path))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (!filtered.length) return null;
    const og = document.createElement('optgroup');
    og.label = label;
    for (const z of filtered) {
      seen.add(z.path);
      og.appendChild(new Option(optionText(z), z.path));
    }
    footstepSourceZoneEl.appendChild(og);
    return og;
  };

  addGroup('Custom', customZonesData);

  const romOf = (z) => (z.path.match(/game\/(ROM\d*)\//i)?.[1] || 'ROM').toUpperCase();
  const groupOf = (z) => z.group || romOf(z);
  const groupLabel = (g) => g === 'ROM' ? 'ROM (base)' : g;
  const groups = [...new Set(zonesData.map(groupOf))].sort((a, b) => {
    if (a === 'Rooms') return 1; if (b === 'Rooms') return -1;
    return (+a.slice(3) || 1) - (+b.slice(3) || 1);
  });
  let roomsGroup = null;
  for (const grp of groups) {
    const og = addGroup(groupLabel(grp), zonesData.filter((z) => groupOf(z) === grp));
    if (grp === 'Rooms') roomsGroup = og;
  }

  footstepSourceZoneEl.value = current;
  if (current && footstepSourceZoneEl.value !== current) {
    if (!roomsGroup) {
      roomsGroup = document.createElement('optgroup');
      roomsGroup.label = 'Rooms';
      footstepSourceZoneEl.appendChild(roomsGroup);
    }
    roomsGroup.appendChild(new Option(`${current.replace(/^game(-hd)?\//, '')} (not in zone list)`, current));
    footstepSourceZoneEl.value = current;
  }
}

export function syncFootstepSourceUI() {
  populateFootstepSourceZones();
  const footstepSourceZoneEl = _R.getEl('footstep-source-zone');
  if (footstepSourceZoneEl) footstepSourceZoneEl.value = _R.getFootstepSourceZone() || '';
}

// ── Mob spawn DB writer ───────────────────────────────────────────────────────
// Database credentials are resolved entirely on the backend now
// (settings/network.lua, then the XI_DB_* values the Setup panel writes to .env), so
// nothing is sent from here. Passing locally-stored creds meant this path defaulted to
// password 'xi' and failed independently of everything else that talks to the DB.

export async function writeMobSpawns(snap, con) {
  const mobs = (snap && snap.mobs) || [];
  if (!mobs.length) return;
  const zoneId = _R.currentZoneId();
  if (zoneId == null) { con?.log?.('⚠ mobs: no server zone id — skipped spawn write.\n'); return; }
  try {
    const r = await bridgeCall('zone.writeMobSpawns', { zoneId, mobs });
    if (!r || !r.ok) { con?.log?.(`⚠ mob spawns: ${r?.error || 'write failed'}\n`); return; }
    const byName = new Map((r.spawns || []).map((s) => [s.name, s]));
    for (const p of _R.getPlacements()) {
      if (!p.isMob) continue;
      const s = byName.get(p.name);
      if (s) { p.node.userData.mob = { ...(p.node.userData.mob || {}), mobid: s.mobid, groupid: s.groupid, poolid: s.poolid }; }
    }
    const errLine = (r.errors && r.errors.length) ? `\n  ${r.errors.slice(0, 8).join('\n  ')}` : '';
    con?.log?.(`✓ mob spawns: ${r.written} written, ${r.skipped} skipped (server reload needed to spawn them)${errLine}\n`);
  } catch (e) {
    con?.log?.(`⚠ mob spawns: ${e.message}\n`);
  }
}

// ── Player sprite ─────────────────────────────────────────────────────────────
function makePlayerSprite(label) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  g.textAlign = 'center'; g.textBaseline = 'middle';

  if (document.fonts && document.fonts.check('140px "Material Symbols Outlined"')) {
    g.font = '140px "Material Symbols Outlined"';
    g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.strokeText('accessibility_new', 128, 88);
    g.fillStyle = 'rgba(150,235,255,0.98)';
    g.fillText('accessibility_new', 128, 88);
  } else {
    g.beginPath(); g.arc(128, 88, 70, 0, Math.PI * 2);
    g.fillStyle = 'rgba(40,200,255,0.28)'; g.fill();
    g.lineWidth = 8; g.strokeStyle = 'rgba(130,235,255,0.95)'; g.stroke();
  }

  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.font = 'bold 26px sans-serif';
  g.strokeText('PLAYER', 128, 190); g.fillStyle = '#cfeaff'; g.fillText('PLAYER', 128, 190);
  if (label) {
    let fs = 46; g.font = `bold ${fs}px sans-serif`;
    while (g.measureText(label).width > 236 && fs > 16) { fs -= 2; g.font = `bold ${fs}px sans-serif`; }
    g.lineWidth = 7; g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.strokeText(label, 128, 226); g.fillStyle = '#ffffff'; g.fillText(label, 128, 226);
  }

  const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: true });
  const s = new THREE.Sprite(mat);
  s.scale.set(2.5, 2.5, 1);
  s.renderOrder = 9999;
  s.raycast = () => {};
  return s;
}

function ensurePlayerGroup() {
  const zoneRoot = _R.getZoneRoot();
  let grp = _R.getPlayerMarkerGroup();
  if (!grp) {
    grp = new THREE.Group();
    grp.name = '__player';
    _R.setPlayerMarkerGroup(grp);
  }
  if (zoneRoot && grp.parent !== zoneRoot) zoneRoot.add(grp);
  return grp;
}

// ── Refresh player marker ─────────────────────────────────────────────────────
export async function refreshPlayerMarker() {
  const zoneRoot = _R.getZoneRoot();
  if (!zoneRoot) return;
  const grp = ensurePlayerGroup();
  while (grp.children.length) {
    const c = grp.children.pop();
    c.geometry?.dispose?.(); c.material?.map?.dispose?.(); c.material?.dispose?.();
  }
  _R.setPlayerSpawn(null);
  if (!_R.getShowPlayerMarker() || !bridgeOnline()) { grp.visible = false; return; }
  const id = parseInt(document.getElementById('db-spawn-id')?.value, 10) || 1;
  let cols, row;
  try {
    const r = await bridgeCall('db.exec', {
      sql: `SELECT charname, pos_x, pos_y, pos_z, pos_zone FROM chars WHERE charid = ${id}` });
    cols = r?.columns || []; row = (r?.rows || [])[0];
  } catch { grp.visible = false; return; }
  if (!row) { grp.visible = false; return; }
  const ci = (n) => cols.indexOf(n);
  const x = parseFloat(row[ci('pos_x')]) || 0, y = parseFloat(row[ci('pos_y')]) || 0, z = parseFloat(row[ci('pos_z')]) || 0;
  const zone = parseInt(row[ci('pos_zone')], 10), name = row[ci('charname')] || `char ${id}`;
  _R.setPlayerSpawn({ x, y, z, zone, name, charid: id });
  const zid = _R.currentZoneId();
  if (zid != null && zone !== zid) { grp.visible = false; return; }
  try { await document.fonts.load('140px "Material Symbols Outlined"'); } catch {}
  const LIFT = 3;
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x9bf0ff, depthTest: false, transparent: true }));
  dot.position.set(x, y, z); dot.renderOrder = 9998; dot.raycast = () => {};
  dot.userData.spawnCue = true;
  grp.add(dot);
  const stem = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, y, z), new THREE.Vector3(x, y - LIFT, z)]),
    new THREE.LineBasicMaterial({ color: 0x9bf0ff, transparent: true, opacity: 0.65, depthTest: false }));
  stem.renderOrder = 9997; stem.raycast = () => {};
  stem.userData.spawnCue = true;
  grp.add(stem);
  const s = makePlayerSprite(name);
  s.position.set(x, y - LIFT, z);
  grp.add(s);
  grp.visible = true;
  grp.userData.warnStatus = undefined;
  updateSpawnWarning();
}

// ── Spawn info / warning ──────────────────────────────────────────────────────
const SPAWN_SNAP = 0.5;
const SPAWN_FLOAT_MAX = 3.0;

export function playerSpawnInfo() {
  const playerSpawn = _R.getPlayerSpawn();
  const zoneRoot = _R.getZoneRoot();
  if (!playerSpawn || !zoneRoot) return { applicable: false };
  const zid = _R.currentZoneId();
  if (zid != null && playerSpawn.zone !== zid) return { applicable: false };
  const meshes = [];
  for (const grp of [_R.getCollisionPrimGroup(), _R.getCollisionGroup()]) {
    if (grp) grp.traverse((o) => { if (o.isMesh && o.geometry) meshes.push(o); });
  }
  if (!meshes.length) return { applicable: false };
  const sp = zoneRoot.localToWorld(new THREE.Vector3(playerSpawn.x, playerSpawn.y, playerSpawn.z));

  const worldBox = new THREE.Box3(), tmp = new THREE.Box3();
  let nearestXZ = Infinity;
  for (const m of meshes) {
    tmp.setFromObject(m);
    if (tmp.isEmpty()) continue;
    worldBox.union(tmp);
    const dx = Math.max(tmp.min.x - sp.x, 0, sp.x - tmp.max.x);
    const dz = Math.max(tmp.min.z - sp.z, 0, sp.z - tmp.max.z);
    nearestXZ = Math.min(nearestXZ, Math.hypot(dx, dz));
  }
  if (worldBox.isEmpty()) return { applicable: true, status: 'void', nearestXZ };

  const ray = new THREE.Raycaster(
    new THREE.Vector3(sp.x, Math.max(worldBox.max.y, sp.y) + 10, sp.z),
    new THREE.Vector3(0, -1, 0));
  const hits = [];
  for (const m of meshes) THREE.Mesh.prototype.raycast.call(m, ray, hits);

  let floorTop = -Infinity, ceilingBottom = Infinity;
  for (const h of hits) {
    const y = h.point.y;
    if (y <= sp.y + SPAWN_SNAP) { if (y > floorTop) floorTop = y; }
    else if (y < ceilingBottom) ceilingBottom = y;
  }
  if (floorTop !== -Infinity) {
    const gap = sp.y - floorTop;
    if (gap > SPAWN_FLOAT_MAX) return { applicable: true, status: 'floating', gap };
    return { applicable: true, status: 'ok', gap };
  }
  if (ceilingBottom !== Infinity)
    return { applicable: true, status: 'buried', gap: sp.y - ceilingBottom };
  return { applicable: true, status: 'void', nearestXZ };
}

export function spawnWarningMessage(info) {
  const playerSpawn = _R.getPlayerSpawn();
  if (!info || !info.applicable || info.status === 'ok') return null;
  const nm = (playerSpawn && playerSpawn.name) || 'Player';
  if (info.status === 'void')
    return `${nm} has no collision under the spawn point` +
           (isFinite(info.nearestXZ) ? ` (nearest collision ~${Math.round(info.nearestXZ)}y away)` : '') +
           ` — will fall through / crash.`;
  if (info.status === 'buried')
    return `${nm} spawns ~${Math.abs(info.gap ?? 0).toFixed(2)}y below the collision surface — may crash. Raise the player slightly above the floor.`;
  if (info.status === 'floating')
    return `${nm} spawns ~${info.gap.toFixed(1)}y above the floor — may be stuck in mid-air. Keep a small gap (≈${SPAWN_FLOAT_MAX.toFixed(1)}y or less).`;
  return null;
}

export function updateSpawnWarning() {
  const playerMarkerGroup = _R.getPlayerMarkerGroup();
  if (!playerMarkerGroup) return undefined;
  const info = playerSpawnInfo();
  const bad = !!(info.applicable && info.status !== 'ok');
  const col = new THREE.Color(bad ? 0xff3b30 : 0x9bf0ff);
  playerMarkerGroup.traverse((o) => { if (o.userData && o.userData.spawnCue && o.material && o.material.color) o.material.color.copy(col); });
  const status = info.applicable ? info.status : 'n/a';
  if (status !== playerMarkerGroup.userData.warnStatus) {
    playerMarkerGroup.userData.warnStatus = status;
    const msg = spawnWarningMessage(info);
    if (msg) _R.setStatus('⚠ ' + msg, true);
    else if (info.applicable) _R.setStatus('Player spawn looks OK (sits on the floor).');
  }
  return info;
}
