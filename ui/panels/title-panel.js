// Title screen shots for the open zone.
//
// The login screen flies real zones as a live background. A zone that appears there owns
// a family of camera routes in ROM/0/23.DAT, stored in the same format as the cutscene
// camera routes this editor already edits: eye, look-at and a focal length per keyframe.
//
// Zones that never appear on the title screen return no sections, and the Events panel
// leaves the Title block out entirely rather than showing an empty one.

import { bridgeOnline, bridgeCall } from '../ffxi/bridge.js';
// Line2 rather than THREE.Line: WebGL ignores linewidth on most drivers, so a plain line
// is always one pixel however thick you ask for. Line2 draws screen-space quads, which is
// what makes a camera path readable against zone geometry.
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

let _scene = null;          // THREE, injected so this module carries no renderer import
let _THREE = null;
let _getZoneRoot = null;    // zoneRoot holds the FFXI->display correction (scale -1,1,-1),
                            // so path geometry parented to it uses raw FFXI coordinates
let _getCamera = null;
let _getZoneId = null;
let _onChanged = null;      // ask the Events panel to re-render

const titleState = {
  loadedFor: null, loading: false, data: null, error: null,
  open: true, selected: null, showPaths: true,
  // Playback: walks the segment's shots in order, flying each route.
  playing: false, shotIndex: 0, shotTime: 0, shotSecs: 5,
};

let _pathGroup = null;
let _materials = [];        // Line2 materials need their resolution kept in sync

export function initTitlePanel({ THREE, getZoneRoot, getCamera, getZoneId, onChanged }) {
  _THREE = THREE;
  _getZoneRoot = getZoneRoot;
  _getCamera = getCamera;
  _getZoneId = getZoneId;
  _onChanged = onChanged;
}

export function titleHasShots() {
  return !!(titleState.data && titleState.data.sections && titleState.data.sections.length);
}

/** True when the lookup itself failed, as opposed to the zone simply not being on the
 *  title screen. Worth showing: an unreachable or outdated bridge looks identical to a
 *  zone with no shots, and silently rendering nothing gives no way to tell them apart. */
export function titleUnavailable() {
  return !!titleState.error;
}

export function titleInvalidate() {
  titleState.loadedFor = null;
  titleState.data = null;
  titleState.error = null;
  titleState.selected = null;
  _clearPaths();
}

/** Fetch the title segments for the open zone. No-op when the zone has not changed. */
export async function ensureTitleLoaded() {
  const zoneId = _getZoneId ? _getZoneId() : null;
  if (zoneId == null) return;
  if (titleState.loading || titleState.loadedFor === zoneId) return;
  if (!bridgeOnline()) {
    titleState.error = 'bridge offline';
    titleState.loadedFor = zoneId;
    return;
  }

  titleState.loading = true;
  let r = null, err = null;
  try {
    r = await bridgeCall('title.timeline', { zoneId });
  } catch (e) {
    err = (e && e.message) || String(e);
  }
  titleState.loading = false;

  if (zoneId !== (_getZoneId ? _getZoneId() : null)) return;   // zone changed mid-fetch
  titleState.data = err ? null : r;
  titleState.error = err;
  titleState.loadedFor = zoneId;
  if (titleHasShots() && titleState.showPaths) drawTitlePaths();
  if (_onChanged) _onChanged();
}

// ── viewport paths ───────────────────────────────────────────────────────────

function _clearPaths() {
  _materials = [];
  if (!_pathGroup) return;
  _pathGroup.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  if (_pathGroup.parent) _pathGroup.parent.remove(_pathGroup);
  _pathGroup = null;
}

/** Draw every shot in the open zone's segment as a line in the viewport.
 *
 * Point count decides the shape, the same rule the client uses for camera routes: two
 * keyframes is a straight line, three or more is a spline, so a 3-point route is sampled
 * through a Catmull-Rom curve rather than drawn as two segments.
 */
export function drawTitlePaths() {
  _clearPaths();
  if (!_THREE || !titleHasShots()) return;
  const root = _getZoneRoot && _getZoneRoot();
  if (!root) return;

  const THREE = _THREE;
  _pathGroup = new THREE.Group();
  _pathGroup.name = 'title-camera-paths';

  for (const sec of titleState.data.sections) {
    for (const cam of sec.cameras) {
      const pts = _shotPoints(cam);
      if (!pts.length) continue;
      const sel = titleState.selected === cam.name;

      const geom = new LineGeometry();
      geom.setPositions(pts.flatMap((v) => [v.x, v.y, v.z]));
      const mat = new LineMaterial({
        color: sel ? 0xffd479 : (cam.weatherChange ? 0x7fd88f : 0x82aaff),
        linewidth: sel ? 5 : 3,          // pixels, thanks to Line2
        transparent: true, opacity: sel ? 1 : 0.75,
        depthTest: false, dashed: false,
      });
      mat.resolution.set(window.innerWidth, window.innerHeight);
      _materials.push(mat);
      const line = new Line2(geom, mat);
      line.computeLineDistances();
      line.renderOrder = 998;
      line.userData.titleTrack = cam.name;
      _pathGroup.add(line);

      // A spur from each eye toward what it is looking at: the path alone does not show
      // which way a shot faces, and these routes often move and turn separately.
      for (const k of cam.keyframes) {
        const eye = new THREE.Vector3(k.eye[0], k.eye[1], k.eye[2]);
        const look = new THREE.Vector3(k.look[0], k.look[1], k.look[2]);
        const dir = look.clone().sub(eye);
        const len = dir.length() || 1;
        dir.multiplyScalar(Math.min(8, len) / len);
        const tip = eye.clone().add(dir);
        const sg = new LineGeometry();
        sg.setPositions([eye.x, eye.y, eye.z, tip.x, tip.y, tip.z]);
        const sm = new LineMaterial({
          color: sel ? 0xffd479 : 0xf7c873,
          linewidth: sel ? 3 : 2,
          transparent: true, opacity: sel ? 0.95 : 0.5, depthTest: false,
        });
        sm.resolution.set(window.innerWidth, window.innerHeight);
        _materials.push(sm);
        const spur = new Line2(sg, sm);
        spur.computeLineDistances();
        spur.renderOrder = 999;
        _pathGroup.add(spur);
      }
    }
  }
  root.add(_pathGroup);
}

/** Sampled points for a shot: a spline when it has 3+ keyframes, a straight line at 2 —
 *  the same rule the client uses to decide a camera route's shape. */
function _shotPoints(cam) {
  const kf = cam.keyframes || [];
  if (kf.length < 2) return [];
  const eyes = kf.map((k) => new _THREE.Vector3(k.eye[0], k.eye[1], k.eye[2]));
  if (eyes.length > 2) {
    try { return new _THREE.CatmullRomCurve3(eyes).getPoints(kf.length * 16); } catch (e) {}
  }
  return eyes;
}

function _allShots() {
  if (!titleHasShots()) return [];
  const out = [];
  for (const sec of titleState.data.sections) for (const c of sec.cameras) out.push(c);
  return out;
}

/** Sample a shot at normalised time: eye along the path, look-at and FOV interpolated
 *  between the surrounding keyframes. */
function _sampleShot(cam, t) {
  const kf = cam.keyframes || [];
  if (!kf.length) return null;
  const THREE = _THREE;
  const clamped = Math.max(0, Math.min(1, t));

  const eyes = kf.map((k) => new THREE.Vector3(k.eye[0], k.eye[1], k.eye[2]));
  let eye;
  if (eyes.length > 2) {
    try { eye = new THREE.CatmullRomCurve3(eyes).getPoint(clamped); }
    catch (e) { eye = eyes[0].clone(); }
  } else if (eyes.length === 2) {
    eye = eyes[0].clone().lerp(eyes[1], clamped);
  } else {
    eye = eyes[0].clone();
  }

  // look-at and FOV walk the keyframe list by their own t values, which are not evenly
  // spaced (a 3-point route sits at 0, 0.667, 1).
  let a = kf[0], b = kf[kf.length - 1];
  for (let i = 0; i < kf.length - 1; i++) {
    if (clamped >= kf[i].t && clamped <= kf[i + 1].t) { a = kf[i]; b = kf[i + 1]; break; }
  }
  const span = (b.t - a.t) || 1;
  const u = Math.max(0, Math.min(1, (clamped - a.t) / span));
  const look = new THREE.Vector3(a.look[0], a.look[1], a.look[2])
    .lerp(new THREE.Vector3(b.look[0], b.look[1], b.look[2]), u);
  const fov = (a.fovDeg || 57) + ((b.fovDeg || 57) - (a.fovDeg || 57)) * u;
  return { eye, look, fov };
}

/** Start playing the open zone's shots in order. */
export function titlePlay(fromIndex = 0) {
  if (!titleHasShots()) return;
  titleState.playing = true;
  titleState.shotIndex = Math.max(0, Math.min(fromIndex, _allShots().length - 1));
  titleState.shotTime = 0;
  if (_onChanged) _onChanged();
}

export function titleStop() {
  titleState.playing = false;
  if (_onChanged) _onChanged();
}

export function titleIsPlaying() { return titleState.playing; }

/** Drive playback and keep Line2 resolution in sync. Called from the render loop. */
export function titleRenderTick(dt, camera, renderer) {
  if (_materials.length && renderer) {
    const w = renderer.domElement ? renderer.domElement.clientWidth : window.innerWidth;
    const h = renderer.domElement ? renderer.domElement.clientHeight : window.innerHeight;
    for (const m of _materials) m.resolution.set(w || 1, h || 1);
  }
  if (!titleState.playing || !camera) return;

  const shots = _allShots();
  if (!shots.length) { titleState.playing = false; return; }

  titleState.shotTime += Math.max(0, dt || 0);
  const secs = titleState.shotSecs || 5;
  if (titleState.shotTime >= secs) {
    titleState.shotTime = 0;
    titleState.shotIndex += 1;
    if (titleState.shotIndex >= shots.length) {   // loop, as the title screen does
      titleState.shotIndex = 0;
    }
    titleState.selected = shots[titleState.shotIndex].name;
    if (titleState.showPaths) drawTitlePaths();
    if (_onChanged) _onChanged();
  }

  const cam = shots[titleState.shotIndex];
  const s = _sampleShot(cam, titleState.shotTime / secs);
  if (!s) return;
  // zoneRoot mirrors X and Z, so a world-space camera mirrors them back.
  camera.position.set(-s.eye.x, s.eye.y, -s.eye.z);
  camera.lookAt(-s.look.x, s.look.y, -s.look.z);
  if (camera.fov !== s.fov) { camera.fov = s.fov; camera.updateProjectionMatrix(); }
}

export function setTitlePathsVisible(on) {
  titleState.showPaths = !!on;
  if (titleState.showPaths) drawTitlePaths(); else _clearPaths();
}

/** Put the viewport camera where a shot's keyframe sits, looking where it looks. */
export function titleFlyTo(trackName, kfIndex = 0) {
  if (!titleHasShots() || !_getCamera) return;
  const cam = _getCamera();
  if (!cam) return;
  for (const sec of titleState.data.sections) {
    const track = sec.cameras.find((c) => c.name === trackName);
    if (!track) continue;
    const k = track.keyframes[Math.min(kfIndex, track.keyframes.length - 1)];
    if (!k) return;
    // zoneRoot mirrors X and Z, so a world-space camera has to mirror them back.
    cam.position.set(-k.eye[0], k.eye[1], -k.eye[2]);
    cam.lookAt(-k.look[0], k.look[1], -k.look[2]);
    if (k.fovDeg) { cam.fov = k.fovDeg; cam.updateProjectionMatrix(); }
    titleState.selected = trackName;
    if (titleState.showPaths) drawTitlePaths();
    if (_onChanged) _onChanged();
    return;
  }
}

// ── markup ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** HTML for the Title block, '' when this zone is not on the title screen. */
export function titleSectionHtml() {
  if (titleState.error) {
    // Distinguish "not on the title screen" from "could not ask". The usual cause is a
    // bridge running an xi-tools build without the title.* methods, which otherwise
    // looks exactly like a zone that has no shots.
    const hint = /unknown method|not found|no such method/i.test(titleState.error)
      ? 'bridge has no title.* methods — point it at an xi-tools checkout with them'
      : esc(titleState.error);
    return `<div class="ttl-block"><div class="ttl-head">
      <span class="ttl-title">Title Screen</span>
      <span class="ttl-count ttl-warn">unavailable — ${hint}</span>
    </div></div>`;
  }
  if (!titleHasShots()) return '';
  const secs = titleState.data.sections;
  const shots = secs.reduce((n, s) => n + s.cameras.length, 0);
  const caret = titleState.open ? '▾' : '▸';

  let rows = '';
  if (titleState.open) {
    for (const sec of secs) {
      const weatherBy = {};
      for (const w of sec.weather) if (w.camera) weatherBy[w.camera] = w;
      rows += `<div class="ttl-seg">segment ${sec.section} · ${esc(sec.zoneName)} ·
        ${sec.cameras.length} shots · ${sec.weather.length} weather</div>`;
      sec.cameras.forEach((cam, i) => {
        const w = weatherBy[cam.name];
        const kf = cam.keyframes || [];
        const fov = kf.length ? Math.round(kf[0].fovDeg) : '';
        const sel = titleState.selected === cam.name ? ' ttl-row-sel' : '';
        rows += `<div class="ttl-row${sel}" data-title-track="${esc(cam.name)}">
          <span class="ttl-idx">${i + 1}</span>
          <span class="ttl-name">${esc(cam.name)}</span>
          <span class="ttl-shape ttl-${cam.shape}">${cam.shape}</span>
          <span class="ttl-kf">${kf.length} kf</span>
          <span class="ttl-fov">${fov}&deg;</span>
          ${w ? `<span class="ttl-weather" title="weather changes as this shot begins">${esc(w.tag)}</span>` : ''}
        </div>`;
      });
    }
  }

  return `<div class="ttl-block">
    <div class="ttl-head" data-title-toggle="1">
      <span class="ttl-caret">${caret}</span>
      <span class="ttl-title">Title Screen</span>
      <span class="ttl-count">(${shots} shots)</span>
      <button class="ttl-play" data-title-play="1"
        title="Fly the shots in order, looping">${titleState.playing ? '&#9632; stop' : '&#9654; play'}</button>
      <label class="ttl-paths"><input type="checkbox" data-title-paths="1"
        ${titleState.showPaths ? 'checked' : ''}> paths</label>
    </div>
    ${rows}
  </div>`;
}

/** Wire clicks for the Title block. Call after the Events panel writes its HTML. */
export function wireTitleSection(rootEl) {
  if (!rootEl) return;
  const play = rootEl.querySelector('[data-title-play]');
  if (play) play.addEventListener('click', (e) => {
    e.stopPropagation();
    titleState.playing ? titleStop() : titlePlay(0);
  });
  const head = rootEl.querySelector('[data-title-toggle]');
  if (head) head.addEventListener('click', (e) => {
    if (e.target && e.target.closest('[data-title-paths], [data-title-play]')) return;
    titleState.open = !titleState.open;
    if (_onChanged) _onChanged();
  });
  const paths = rootEl.querySelector('[data-title-paths]');
  if (paths) paths.addEventListener('change', (e) => setTitlePathsVisible(e.target.checked));
  rootEl.querySelectorAll('[data-title-track]').forEach((el) => {
    const name = el.getAttribute('data-title-track');
    el.addEventListener('click', () => titleFlyTo(name, 0));
    el.addEventListener('dblclick', () => {
      const idx = _allShots().findIndex((c) => c.name === name);
      if (idx >= 0) titlePlay(idx);
    });
  });
}
