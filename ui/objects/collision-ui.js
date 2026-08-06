// collision-ui.js — collision primitive creation, material management, and overlay state.
// Handles user-authored collision primitives (box / plane / mesh) placed in the editor.
// Init via initCollisionUI({ ... }) before calling any exported function.
//
// Exports: initCollisionUI, addCollisionPrimitive, createCollisionFromMesh,
//   bakeCollisionPrimTris, setCollisionMat, defaultCollisionMat,
//   getCollisionGroup, setCollisionGroup, getCollisionMaterial, setCollisionMaterial,
//   getCollisionPrimGroup, setCollisionPrimGroup, getCollisionPrimMaterials,
//   COLLISION_TERRAIN_RGB

import * as THREE from 'three';

// ── module-level state ────────────────────────────────────────────────────────
export const COLLISION_TERRAIN_RGB = [
  [0.30, 0.30, 0.30], [0.25, 0.50, 0.25], [0.10, 0.55, 0.10], [0.65, 0.62, 0.20],
  [0.85, 0.85, 0.88], [0.45, 0.45, 0.45], [0.55, 0.35, 0.30], [0.55, 0.40, 0.22],
  [0.25, 0.55, 0.80], [0.10, 0.20, 0.70], [0.55, 0.10, 0.55],
];

// collisionGroup: DAT-baked MZB overlay (read from zone DAT, not user-authored)
let collisionGroup = null;
export function getCollisionGroup() { return collisionGroup; }
export function setCollisionGroup(g) { collisionGroup = g; }

// collisionMaterial: the overlay material — kept so the opacity slider can update it live
let collisionMaterial = null;
export function getCollisionMaterial() { return collisionMaterial; }
export function setCollisionMaterial(m) { collisionMaterial = m; }

// collisionPrimGroup: user-authored collision primitives (box / plane / mesh)
let collisionPrimGroup = null;
export function getCollisionPrimGroup() { return collisionPrimGroup; }
export function setCollisionPrimGroup(g) { collisionPrimGroup = g; }

// collisionPrimMaterials: tracked so the opacity slider can update them live
const collisionPrimMaterials = [];
export function getCollisionPrimMaterials() { return collisionPrimMaterials; }

// ── lazy-injected callbacks ───────────────────────────────────────────────────
let _getZoneRoot        = null;
let _getEditMode        = null;
let _getShowCollision   = null;
let _getCollisionOpacity = null;
let _getPlacements      = null;
let _getPlacementSet    = null;
let _getAddedEntries    = null;
let _getSelected        = null;
let _getRaycaster       = null;
let _getCamera          = null;
let _newXiId          = null;
let _markChange         = null;
let _setStatus          = null;
let _buildObjectList    = null;
let _updateChangesUI    = null;
let _select             = null;
let _updateCollisionDetailsPanel = null;
let _setActiveTab       = null;
let _tabForEntry        = null;

export function initCollisionUI({
  getZoneRoot, getEditMode, getShowCollision, getCollisionOpacity,
  getPlacements, getPlacementSet, getAddedEntries, getSelected,
  getRaycaster, getCamera, newXiId, markChange,
  setStatus, buildObjectList, updateChangesUI, select,
  updateCollisionDetailsPanel, setActiveTab, tabForEntry,
}) {
  _getZoneRoot         = getZoneRoot;
  _getEditMode         = getEditMode;
  _getShowCollision    = getShowCollision;
  _getCollisionOpacity = getCollisionOpacity;
  _getPlacements       = getPlacements;
  _getPlacementSet     = getPlacementSet;
  _getAddedEntries     = getAddedEntries;
  _getSelected         = getSelected;
  _getRaycaster        = getRaycaster;
  _getCamera           = getCamera;
  _newXiId           = newXiId;
  _markChange          = markChange;
  _setStatus           = setStatus;
  _buildObjectList     = buildObjectList;
  _updateChangesUI     = updateChangesUI;
  _select              = select;
  _updateCollisionDetailsPanel = updateCollisionDetailsPanel;
  _setActiveTab        = setActiveTab;
  _tabForEntry         = tabForEntry;
}

// Reset group references when a new zone loads (old groups are disposed).
export function resetCollisionPrimGroup() { collisionPrimGroup = null; }
export function resetCollisionGroup() { collisionGroup = null; collisionMaterial = null; }

// ── material helpers ──────────────────────────────────────────────────────────

// Planes spawn floor-facing, so default them to camera-blocking (wall:false); boxes and
// extracted meshes default to camera-passthrough (wall:true) — the common "invisible wall"
// case where you want the camera to glide through rather than snag.
export function defaultCollisionMat(type) {
  return { wall: type !== 'plane', terrain: 0 };
}

function collisionMatColor(m) {
  const rgb = COLLISION_TERRAIN_RGB[m.terrain] || COLLISION_TERRAIN_RGB[0];
  return new THREE.Color(rgb[0], rgb[1], rgb[2]);
}

// Store the {wall, terrain} model on a prim and tint its fill to match. Normalises
// loose input (saved recs, clipboard) so callers can pass partial objects.
export function setCollisionMat(node, m) {
  const wall = !!(m && m.wall);
  const t = (m && Number.isFinite(m.terrain)) ? (m.terrain | 0) : 0;
  const mat = { wall, terrain: Math.min(10, Math.max(0, t)) };
  node.userData.collisionMat = mat;
  if (node.material && node.material.color) node.material.color.copy(collisionMatColor(mat));
  return mat;
}

// ── geometry helpers ──────────────────────────────────────────────────────────

// Wireframe outline for a collision prim — always non-subdivided so only the outer
// edges show (subdivided EdgesGeometry leaks internal triangle diagonals).
function _collisionOutlineGeo(type) {
  const base = type === 'plane' ? new THREE.PlaneGeometry(1, 1) : new THREE.BoxGeometry(1, 1, 1);
  const edges = new THREE.EdgesGeometry(base, 1);
  base.dispose();
  return edges;
}

// Compute subdivision segments: minimal by default; devs can raise per-prim for denser terrain.
function _collisionPrimSegs(type, scaleVec) {
  if (type === 'mesh') return { x: 1, y: 1, z: 1 };
  return type === 'box'
    ? { x: 1, y: 1, z: 1 }
    : { x: 1, z: 1 };
}

// Subdivide a flat position array (9 floats per triangle) into level² smaller triangles
// per original triangle using barycentric subdivision. level=1 returns the original array.
function _subdivideTriangles(positions, level) {
  if (level <= 1) return positions;
  const n = level;
  const bary = (v0, v1, v2, u, v) => {
    const w = 1 - u - v;
    return [w * v0[0] + u * v1[0] + v * v2[0],
            w * v0[1] + u * v1[1] + v * v2[1],
            w * v0[2] + u * v1[2] + v * v2[2]];
  };
  const out = [];
  for (let i = 0; i < positions.length; i += 9) {
    const v0 = [positions[i],     positions[i + 1], positions[i + 2]];
    const v1 = [positions[i + 3], positions[i + 4], positions[i + 5]];
    const v2 = [positions[i + 6], positions[i + 7], positions[i + 8]];
    for (let u = 0; u < n; u++) {
      for (let v = 0; v < n - u; v++) {
        const a = bary(v0, v1, v2, u / n, v / n);
        const b = bary(v0, v1, v2, (u + 1) / n, v / n);
        const c = bary(v0, v1, v2, u / n, (v + 1) / n);
        out.push(...a, ...b, ...c);
        if (u + v + 2 <= n) {
          const d = bary(v0, v1, v2, (u + 1) / n, (v + 1) / n);
          out.push(...b, ...d, ...c);
        }
      }
    }
  }
  return new Float32Array(out);
}

export function _rebuildCollisionPrimGeo(entry) {
  if (!entry?.isCollisionPrimitive) return;
  const type = entry.collisionType;
  const mesh = entry.node;
  let newGeo;
  if (type === 'mesh') {
    const orig = mesh.userData.originalVertices;
    if (!orig) return;
    const level = entry.subdivSegs?.x || 1;
    const verts = level > 1 ? _subdivideTriangles(orig, level) : orig;
    newGeo = new THREE.BufferGeometry();
    newGeo.setAttribute('position', new THREE.BufferAttribute(verts.slice(), 3));
  } else if (type === 'box' || type === 'plane') {
    const segs = entry.subdivSegs || _collisionPrimSegs(type, mesh.scale);
    newGeo = type === 'box'
      ? new THREE.BoxGeometry(1, 1, 1, segs.x, segs.y, segs.z)
      : new THREE.PlaneGeometry(1, 1, segs.x, segs.z);
  } else {
    return;
  }
  mesh.geometry.dispose();
  mesh.geometry = newGeo;
  const wire = mesh.children.find((c) => c.isLineSegments);
  if (wire) {
    wire.geometry.dispose();
    wire.geometry = type === 'mesh'
      ? new THREE.EdgesGeometry(newGeo, 1)
      : _collisionOutlineGeo(type);
  }
  if (_getSelected && _getSelected() === entry && _updateCollisionDetailsPanel) {
    _updateCollisionDetailsPanel();
  }
}

// ── prim group helpers ────────────────────────────────────────────────────────

function _ensurePrimGroup(zoneRoot) {
  if (!collisionPrimGroup) {
    collisionPrimGroup = new THREE.Group();
    collisionPrimGroup.name = '__collisionPrims';
    collisionPrimGroup.visible = _getShowCollision();
    zoneRoot.add(collisionPrimGroup);
  }
  return collisionPrimGroup;
}

function _makePrimMaterial() {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xcc2222,
    transparent: true,
    opacity: _getCollisionOpacity(),
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  collisionPrimMaterials.push(mat);
  return mat;
}

// ── public API ────────────────────────────────────────────────────────────────

export function addCollisionPrimitive(type) {
  if (!_getEditMode()) { _setStatus('Switch to Edit mode to add collision primitives', true); return; }
  const zoneRoot = _getZoneRoot();
  if (!zoneRoot) { _setStatus('Load a zone first', true); return; }

  const geo = type === 'box'
    ? new THREE.BoxGeometry(1, 1, 1, 1, 1, 1)
    : new THREE.PlaneGeometry(1, 1, 1, 1);

  const mat = _makePrimMaterial();
  const mesh = new THREE.Mesh(geo, mat);

  // Place at the scene surface under the screen centre; fall back to 200 units ahead.
  const raycaster = _getRaycaster();
  const camera = _getCamera();
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = raycaster.intersectObject(zoneRoot, true).filter((h) => h.object !== mesh);
  let worldPos;
  if (hits.length > 0) {
    worldPos = hits[0].point.clone();
  } else {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    worldPos = camera.position.clone().add(dir.multiplyScalar(200));
  }
  mesh.position.copy(zoneRoot.worldToLocal(worldPos));

  // Planes default flat (floor-facing); boxes stay axis-aligned.
  if (type === 'plane') mesh.rotation.x = -Math.PI / 2;

  const placements = _getPlacements();
  mesh.name = `xi_col_${type}_${placements.filter((p) => p.isCollisionPrimitive).length + 1}`;
  mesh.userData.original = { p: mesh.position.clone(), q: mesh.quaternion.clone(), s: mesh.scale.clone() };
  mesh.userData.xiId = _newXiId();

  const cwire = new THREE.LineSegments(
    _collisionOutlineGeo(type),
    new THREE.LineBasicMaterial({ color: 0x0a0a0e, opacity: 0.6, transparent: true }),
  );
  cwire.raycast = () => {};
  mesh.add(cwire);

  _ensurePrimGroup(zoneRoot).add(mesh);
  _getPlacementSet().add(mesh);

  const entry = { node: mesh, name: mesh.name, isCollisionPrimitive: true, collisionType: type,
                  subdivSegs: _collisionPrimSegs(type, mesh.scale) };
  setCollisionMat(mesh, defaultCollisionMat(type));
  placements.push(entry);
  _getAddedEntries().add(entry);
  _buildObjectList();
  _updateChangesUI();
  _select(entry);
}

export function buildCollisionPrimFromRec(rec) {
  const zoneRoot = _getZoneRoot();
  if (!zoneRoot) return null;
  let geo;
  if (rec.collisionType === 'mesh' && rec.vertices?.length) {
    const origVerts = new Float32Array(rec.vertices);
    const level = rec.subdivSegs?.x || 1;
    const verts = level > 1 ? _subdivideTriangles(origVerts, level) : origVerts;
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  } else if (rec.collisionType === 'plane') {
    const sv = rec.scale ? new THREE.Vector3(...rec.scale) : new THREE.Vector3(1, 1, 1);
    const segs = rec.subdivSegs || _collisionPrimSegs('plane', sv);
    geo = new THREE.PlaneGeometry(1, 1, segs.x, segs.z);
  } else {
    const sv = rec.scale ? new THREE.Vector3(...rec.scale) : new THREE.Vector3(1, 1, 1);
    const segs = rec.subdivSegs || _collisionPrimSegs('box', sv);
    geo = new THREE.BoxGeometry(1, 1, 1, segs.x, segs.y, segs.z);
  }
  const mat = _makePrimMaterial();
  const mesh = new THREE.Mesh(geo, mat);
  if (rec.pos) mesh.position.set(...rec.pos);
  if (rec.rot) mesh.rotation.set(...rec.rot);
  if (rec.scale) mesh.scale.set(...rec.scale);
  mesh.updateMatrix();
  mesh.name = rec.name || `xi_col_${rec.collisionType || 'box'}_restored`;
  mesh.userData.original = { p: mesh.position.clone(), q: mesh.quaternion.clone(), s: mesh.scale.clone() };
  mesh.userData.xiId = rec.xiId || _newXiId();
  if (Array.isArray(rec.sourceXiIds)) mesh.userData.sourceXiIds = rec.sourceXiIds;
  if (rec.collisionType === 'mesh' && rec.vertices?.length) {
    mesh.userData.originalVertices = new Float32Array(rec.vertices);
  }
  const cwire = new THREE.LineSegments(
    rec.collisionType === 'mesh' ? new THREE.EdgesGeometry(geo, 1) : _collisionOutlineGeo(rec.collisionType),
    new THREE.LineBasicMaterial({ color: 0x0a0a0e, opacity: 0.6, transparent: true }),
  );
  cwire.raycast = () => {};
  mesh.add(cwire);
  _ensurePrimGroup(zoneRoot).add(mesh);
  _getPlacementSet().add(mesh);
  const hasMat = rec.wall !== undefined || rec.terrain !== undefined || rec.collisionMat !== undefined;
  setCollisionMat(mesh, hasMat ? (rec.collisionMat || { wall: rec.wall, terrain: rec.terrain })
                               : defaultCollisionMat(rec.collisionType || 'box'));
  const rtype = rec.collisionType || 'box';
  const sv = rec.scale ? new THREE.Vector3(...rec.scale) : new THREE.Vector3(1, 1, 1);
  const entry = { node: mesh, name: mesh.name, isCollisionPrimitive: true, collisionType: rtype,
                  subdivSegs: rec.subdivSegs || _collisionPrimSegs(rtype, sv) };
  _getPlacements().push(entry);
  _getAddedEntries().add(entry);
  _markChange(mesh, rec.ts || 0);
  return entry;
}

// entries: single entry or array of entries — geometry from all is merged into one collision prim.
export function createCollisionFromMesh(entries) {
  if (!_getEditMode()) { _setStatus('Switch to Edit mode to create collision', true); return; }
  const zoneRoot = _getZoneRoot();
  if (!zoneRoot) return;
  const sources = (Array.isArray(entries) ? entries : [entries])
    .filter((e) => !e.isCollisionPrimitive && !e.isEffect && !e.isMarker && !e.isSky);
  if (!sources.length) return;

  const positions = [];
  const zoneInvMatrix = new THREE.Matrix4().copy(zoneRoot.matrixWorld).invert();

  for (const p of sources) {
    p.node.updateWorldMatrix(true, true);
    p.node.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const geo = child.geometry;
      if (!geo?.attributes?.position) return;
      child.updateWorldMatrix(true, false);
      const toLocal = new THREE.Matrix4().multiplyMatrices(zoneInvMatrix, child.matrixWorld);
      const pos = geo.attributes.position;
      const idx = geo.index;
      const v = new THREE.Vector3();
      if (idx) {
        for (let i = 0; i < idx.count; i++) {
          v.fromBufferAttribute(pos, idx.getX(i)).applyMatrix4(toLocal);
          positions.push(v.x, v.y, v.z);
        }
      } else {
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(toLocal);
          positions.push(v.x, v.y, v.z);
        }
      }
    });
  }

  if (positions.length === 0) { _setStatus('No mesh geometry found on selected object(s)', true); return; }

  const vtxCount = positions.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < positions.length; i += 3) { cx += positions[i]; cy += positions[i + 1]; cz += positions[i + 2]; }
  cx /= vtxCount; cy /= vtxCount; cz /= vtxCount;
  for (let i = 0; i < positions.length; i += 3) { positions[i] -= cx; positions[i + 1] -= cy; positions[i + 2] -= cz; }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));

  const mat = _makePrimMaterial();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(cx, cy, cz);
  const placements = _getPlacements();
  const baseName = sources.length === 1 ? sources[0].name : `selection_${sources.length}`;
  mesh.name = `xi_col_mesh_${baseName}_${placements.filter((q) => q.isCollisionPrimitive).length + 1}`;
  mesh.userData.original = { p: mesh.position.clone(), q: mesh.quaternion.clone(), s: mesh.scale.clone() };
  mesh.userData.xiId = _newXiId();
  mesh.userData.originalVertices = new Float32Array(positions);
  mesh.userData.sourceEntry = sources.map((e) => e.name).join(', ');
  mesh.userData.sourceXiIds = sources.map((e) => e.node.userData.xiId).filter(Boolean);

  const cwire = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo, 1),
    new THREE.LineBasicMaterial({ color: 0x0a0a0e, opacity: 0.6, transparent: true }),
  );
  cwire.raycast = () => {};
  mesh.add(cwire);

  _ensurePrimGroup(zoneRoot).add(mesh);
  _getPlacementSet().add(mesh);

  const entry = { node: mesh, name: mesh.name, isCollisionPrimitive: true, collisionType: 'mesh',
                  subdivSegs: { x: 1, y: 1, z: 1 } };
  _rebuildCollisionPrimGeo(entry);
  setCollisionMat(mesh, defaultCollisionMat('mesh'));
  placements.push(entry);
  _getAddedEntries().add(entry);
  _buildObjectList();
  _updateChangesUI();
  _select(entry);
  if (_setActiveTab && _tabForEntry) _setActiveTab(_tabForEntry(entry));
  const triCount = positions.length / 3;
  const srcLabel = sources.length === 1 ? `"${sources[0].name}"` : `${sources.length} objects`;
  _setStatus(`Collision mesh created from ${srcLabel} — ${triCount} triangles`);
}

// Bake a collision prim to a flat world-space triangle soup in zoneRoot-local coords.
export function bakeCollisionPrimTris(node) {
  const out = [];
  const zoneRoot = _getZoneRoot();
  if (!node || !zoneRoot) return out;
  const geo = node.geometry;
  if (!geo?.attributes?.position) return out;
  node.updateWorldMatrix(true, false);
  const toLocal = new THREE.Matrix4()
    .copy(zoneRoot.matrixWorld).invert().multiply(node.matrixWorld);
  const pos = geo.attributes.position;
  const idx = geo.index;
  const v = new THREE.Vector3();
  const push = (i) => {
    v.fromBufferAttribute(pos, i).applyMatrix4(toLocal);
    out.push(+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3));
  };
  if (idx) for (let i = 0; i < idx.count; i++) push(idx.getX(i));
  else for (let i = 0; i < pos.count; i++) push(i);
  return out;
}
