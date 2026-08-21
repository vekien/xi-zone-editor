// Title screen shots for the open zone.
//
// The login screen flies real zones as a live background. A zone that appears there owns
// a family of camera routes in ROM/0/23.DAT, stored in the same format as the cutscene
// camera routes this editor already edits: eye, look-at and a focal length per keyframe.
//
// Zones that never appear on the title screen return no sections, and the Events panel
// leaves the Title block out entirely rather than showing an empty one.

import { bridgeOnline, bridgeCall } from '../ffxi/bridge.js';

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
};

let _pathGroup = null;

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
      const kf = cam.keyframes || [];
      if (kf.length < 2) continue;
      const eyes = kf.map((k) => new THREE.Vector3(k.eye[0], k.eye[1], k.eye[2]));
      let pts = eyes;
      if (eyes.length > 2) {
        try { pts = new THREE.CatmullRomCurve3(eyes).getPoints(kf.length * 12); } catch (e) { pts = eyes; }
      }
      const sel = titleState.selected === cam.name;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
          color: sel ? 0xffd479 : (cam.weatherChange ? 0x7fd88f : 0x82aaff),
          transparent: true, opacity: sel ? 1 : 0.55, depthTest: false,
        }));
      line.renderOrder = 998;
      line.userData.titleTrack = cam.name;
      _pathGroup.add(line);

      // A short spur from each eye toward what it is looking at: a path alone does not
      // show which way the shot faces, and these routes often move and turn separately.
      for (const k of kf) {
        const eye = new THREE.Vector3(k.eye[0], k.eye[1], k.eye[2]);
        const look = new THREE.Vector3(k.look[0], k.look[1], k.look[2]);
        const dir = look.clone().sub(eye);
        const len = dir.length() || 1;
        dir.multiplyScalar(Math.min(6, len) / len);
        const spur = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([eye, eye.clone().add(dir)]),
          new THREE.LineBasicMaterial({
            color: sel ? 0xffd479 : 0xf7c873,
            transparent: true, opacity: sel ? 0.95 : 0.4, depthTest: false,
          }));
        spur.renderOrder = 999;
        _pathGroup.add(spur);
      }
    }
  }
  root.add(_pathGroup);
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
      <label class="ttl-paths"><input type="checkbox" data-title-paths="1"
        ${titleState.showPaths ? 'checked' : ''}> paths</label>
    </div>
    ${rows}
  </div>`;
}

/** Wire clicks for the Title block. Call after the Events panel writes its HTML. */
export function wireTitleSection(rootEl) {
  if (!rootEl) return;
  const head = rootEl.querySelector('[data-title-toggle]');
  if (head) head.addEventListener('click', (e) => {
    if (e.target && e.target.matches('[data-title-paths]')) return;
    titleState.open = !titleState.open;
    if (_onChanged) _onChanged();
  });
  const paths = rootEl.querySelector('[data-title-paths]');
  if (paths) paths.addEventListener('change', (e) => setTitlePathsVisible(e.target.checked));
  rootEl.querySelectorAll('[data-title-track]').forEach((el) => {
    el.addEventListener('click', () => titleFlyTo(el.getAttribute('data-title-track'), 0));
  });
}
