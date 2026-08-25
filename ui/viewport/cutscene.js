// cutscene.js — FFXI cutscene playback system for the level editor.
// Extracted from main.js. Manages the bottom sequencer panel, the cutscene
// camera, NPC actors, particle VFX, and the 30fps playback clock.

import * as THREE from 'three';
import { ParticleSystem, ParticleEmitter } from '../ffxi/particle_runtime.js';
import { parseAllEffects } from '../ffxi/particle_effects.js';
import { decodeBgmWithExportFallback, decodeSfxWithExportFallback } from '../ffxi/audio-helper.js';

// ── Injected dependencies (set by initCutscene) ───────────────────────────────
let _scene, _camera, _renderer, _gltfLoader;
let _getZoneRoot;          // () => zoneRoot (changes per zone load)
let _getCurrentZoneUrl;    // () => currentZoneUrl
let _currentZoneId;        // () => currentZoneId()
let _bridgeCall, _bridgeOnline;
let _disposeSubtree, _clearOutline, _rebuildOutline, _updateOutline;
let _hoverOutlineMat;
let _setStatus;
let _saveSetting, _loadSetting;
let _evtEsc;
let _eventsCutscene;       // Map shared with the events system

export function initCutscene(deps) {
  _scene           = deps.scene;
  _camera          = deps.camera;
  _renderer        = deps.renderer;
  _gltfLoader      = deps.gltfLoader;
  _getZoneRoot     = deps.getZoneRoot;
  _getCurrentZoneUrl = deps.getCurrentZoneUrl;
  _currentZoneId   = deps.currentZoneId;
  _bridgeCall      = deps.bridgeCall;
  _bridgeOnline    = deps.bridgeOnline;
  _disposeSubtree  = deps.disposeSubtree;
  _clearOutline    = deps.clearOutline;
  _rebuildOutline  = deps.rebuildOutline;
  _updateOutline   = deps.updateOutline;
  _hoverOutlineMat = deps.hoverOutlineMat;
  _setStatus       = deps.setStatus;
  _saveSetting     = deps.saveSetting;
  _loadSetting     = deps.loadSetting;
  _evtEsc          = deps.evtEsc;
  _eventsCutscene  = deps.eventsCutscene;
  _getMarkers      = deps.getMarkers || (() => []);
  _selectMarkerByName = deps.selectMarkerByName || null;
  _resumeAuthor    = deps.resumeAuthor || null;
  _openAuthorFrom  = deps.openAuthorFrom || null;
  _pushCommand     = deps.pushCommand || null;
}
let _selectMarkerByName = null;   // select a placed marker in the viewport by its name

// Edit-Cutscene entry points (from cutscene-author.js, injected to avoid a circular import).
let _resumeAuthor = null;       // reopen the author modal on the in-memory state (author mode)
let _openAuthorFrom = null;     // seed + open the author from a loaded cutscene (load mode)
let _pushCommand = null;        // undo-redo.pushCommand — keyframe edits join the global history

// Placed markers for the Position track dropdown: [{name, pos:[FFXI x,y,z]}].
let _getMarkers = () => [];
export function csGetMarkers() { return _getMarkers(); }

// ── Beat / lane metadata ──────────────────────────────────────────────────────
export const CS_BEAT_META = {
  dialogue: ['Dialogue', '#7fd88f'],
  shot:     ['Shot',     '#c792ea'],
  fade:     ['Fade',     '#82aaff'],
  wait:     ['Wait',     '#7e8698'],
  camera:   ['Camera',   '#f7c873'],
  music:    ['Music',    '#ff8fcf'],
  task:     ['Task',     '#9aa3b2'],
  taskEnd:  ['End',      '#5b6270'],
  end:      ['End',      '#e06c75'],
  npc:      ['NPC',      '#6fd3e0'],   // entity show/hide (0x4E)
  emote:    ['Emote',    '#d6a4ff'],   // emote animation (0x6E)
  anim:     ['Anim',     '#b48ead'],   // play-anim / look+talk (0x63/0x1E)
  vfx:      ['VFX',      '#ff7b72'],   // cast-magic + scene effects
};

// Plain-text detail for a beat — used by the now-playing box, dot tooltips, info chips.
export function csBeatDetail(b, fps) {
  const who = (b.actors && b.actors.length) ? ' · ' + b.actors.join(', ') : '';
  if (b.type === 'dialogue') {
    const t = b.text ? b.text.replace(/\n/g, ' ') : `msg ${b.msgId ?? '?'}`;
    return b.speaker ? `${b.speaker}: ${t}` : t;
  }
  if (b.type === 'shot' || b.type === 'fade' || b.type === 'task') {
    const fx = [];
    if (b.vfx) fx.push('vfx ' + b.vfx.join(','));
    if (b.playAnim) fx.push('anim ' + b.playAnim.join(','));
    if (b.sound) fx.push('sound ' + b.sound.join(','));
    return (b.tag || b.op || '') + who + (fx.length ? ' · ' + fx.join(' · ') : '');
  }
  if (b.type === 'taskEnd') return b.tag ? `end ${b.tag}` : 'end task';
  if (b.type === 'wait') return `${b.frames}f · ${(b.frames / fps).toFixed(1)}s`;
  if (b.type === 'camera' || b.type === 'music') return b.name || b.op || '';
  if (b.type === 'npc') return `${b.actor || 'entity'} — ${b.action || 'toggle'}`;
  if (b.type === 'emote') return `emote · ${b.actor || 'entity'}`;
  if (b.type === 'anim') return `${b.name || 'anim'} · ${b.actor || 'entity'}`;
  if (b.type === 'vfx') {
    if (b.effect) return `${b.effect}${b.caster ? ' · ' + b.caster : ''}`;
    return `cast${b.caster ? ' · ' + b.caster : ''}${b.target ? ' → ' + b.target : ''}`;
  }
  return '';
}
export function csBeatSpan(b) { return Number(b.dur) || Number(b.frames) || 0; }   // duration in frames (0 = instant marker)

// Sequencer lanes — beat types collapsed into a fixed set of stacked tracks.
export const CS_LANE_OF = { camera: 'camera', shot: 'shot', vfx: 'vfx', emote: 'anim', anim: 'anim', npc: 'npc', dialogue: 'dialogue', music: 'music', fade: 'fade', wait: 'wait', task: 'task', taskEnd: 'task', end: 'end' };
export const CS_LANE_ORDER = ['camera', 'shot', 'vfx', 'anim', 'npc', 'dialogue', 'music', 'fade', 'wait', 'task', 'end'];
export const CS_LANE_LABEL = { camera: 'Camera', shot: 'Shot', vfx: 'VFX', anim: 'Anim', npc: 'NPCs', dialogue: 'Dialogue', music: 'Music', fade: 'Fade', wait: 'Wait', task: 'Task', end: 'End' };
export const csLaneOf = (t) => CS_LANE_OF[t] || 'end';

// ── Cutscene camera ───────────────────────────────────────────────────────────
// Positioned from a decoded cNNN camera route. The render loop switches to it
// while `cutsceneCamActive` is set (exported so the render loop can read it).
export const csCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 20000);
export let cutsceneCamActive = false;

// ── Author camera ───────────────────────────────────────────────────────────
// A camera you position + keyframe. `csAuthorCamRig` is the VISIBLE body (+ gizmo
// target); `csCamera` is the real THREE.Camera that renders + is flown. They mirror
// each other every frame — while PILOTING the fly controls drive csCamera (a real
// Camera, whose getWorldDirection is -Z, so WASD/look aren't inverted) and the rig
// follows; otherwise the gizmo drives the rig and csCamera follows. Pose is captured
// to keyframes from csCamera in FFXI world coords (zoneRoot local space) + FOV°.
let csAuthorCamRig = null;      // THREE.Group — visible camera body, gizmo target
let csAuthorFov = 57;           // vertical FOV degrees (route stores a focal length; convert via 2·atan2(192,focal))
let csAuthorCamHelper = null;   // THREE.CameraHelper(csCamera) frustum viz
let csCameraPiloting = false;   // flying + rendering through the author camera
let _csSetFlyTarget = null;     // fly-camera.setFlyTarget, injected from main.js
let _csOnCameraSelect = null;   // main.js hook: attach the gizmo to the rig

export function csInitCameraDeps(deps = {}) {
  _csSetFlyTarget = deps.setFlyTarget || null;
  _csOnCameraSelect = deps.onCameraSelect || null;
}

export function csGetAuthorCamRig() { return csAuthorCamRig; }
export function csIsCameraPiloting() { return csCameraPiloting; }
export function csGetAuthorFov() { return csAuthorFov; }
export function csSetAuthorFov(deg) {
  csAuthorFov = Math.max(5, Math.min(140, +deg || 60));
  csSyncAuthorCamera();
}
// FFXI's cutscene "FOV" field is really a ZOOM level — verified in-game a LARGER value zooms IN,
// the inverse of a three.js FOV angle. Map the stored zoom (~20–120) into the client's ~25–75°
// FOV band, INVERTED, for the preview camera; and back the other way when capturing a keyframe.
// FFXI stores camera zoom as a FOCAL LENGTH (SplineControlPoint.FovCalculationParameter in the
// route resource, default 350), NOT an FOV angle or decidegrees. The client derives the vertical
// FOV as 2·atan2(192, focal) (xiclient GameManager::UpdateProjectionMatrix:2102). Larger focal ⇒
// narrower FOV ⇒ zoomed IN. three.js camera.fov is vertical degrees, so convert at the DAT
// boundary. focal 350→57°, 250→75°, 480→43°, 650→33°.
function _csFocalToFov(focal) { return Math.max(5, Math.min(120, 2 * Math.atan2(192, +focal || 350) * 180 / Math.PI)); }
function _csFovToFocal(deg)   { return 192 / Math.tan((Math.max(5, Math.min(120, +deg || 57)) * Math.PI / 180) / 2); }

// USER-FACING ZOOM: FFXI treats the camera like a ZOOM, not a traditional FOV — HIGHER = zoomed IN
// (narrower angle). So the Zoom track/slider shows a 0–100 zoom where up = in, mapped from the
// internal FOV degrees over the practical 20–80° band (kf.fov stays degrees for compile/preview).
function _csZoomFromFov(fovDeg) { return Math.max(0, Math.min(100, Math.round((80 - (+fovDeg || 57)) * 100 / 60))); }
function _csFovFromZoom(zoom)   { return 80 - Math.max(0, Math.min(100, +zoom || 0)) * 60 / 100; }

// Camera route SmoothingType easing, applied to normalized shot time BEFORE sampling the path
// (xiclient CameraTask::Smooth / EvaluateProgressionCurve). This is a SEPARATE axis from the path
// shape (straight vs spline, decided by point count) — it shapes the *pacing* along the path.
//   0 Linear · 1 Decelerate (fast→slow) · 2 Accelerate (slow→fast) · 3 Decel→mid→Accel · 4 S-curve
function _csEase(t, smooth) {
  const x = Math.max(0, Math.min(1, t));
  switch (smooth | 0) {
    case 1: return Math.sin(x * Math.PI / 2);                       // sin — ease-out
    case 2: return 1 - Math.cos(x * Math.PI / 2);                   // 1-cos — ease-in
    case 3: { const s = 0.5 * Math.sin(Math.PI * x); return x <= 0.5 ? s : 1 - s; }
    case 4: return 0.5 * (1 - Math.cos(Math.PI * x));               // ½(1-cos) — S-curve ease-in-out
    default: return x;                                              // 0 — Linear
  }
}

function csEnsureAuthorCamera() {
  if (csAuthorCamRig) return csAuthorCamRig;
  const rig = new THREE.Group();
  rig.name = 'cs-author-camera';
  rig.userData.csAuthorCamera = true;
  // ~1/3 the original size — a small, unobtrusive marker.
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.75, 0.55, 1.0),
    new THREE.MeshBasicMaterial({ color: 0x66d9e8 }));
  const lens = new THREE.Mesh(
    new THREE.ConeGeometry(0.34, 0.6, 16),
    new THREE.MeshBasicMaterial({ color: 0x1c2b30 }));
  lens.rotation.x = -Math.PI / 2;    // point the lens down local -Z (camera forward)
  lens.position.set(0, 0, -0.66);
  for (const m of [body, lens]) { m.userData.csAuthorCamera = true; m.renderOrder = 999; }
  rig.add(body, lens);
  csAuthorCamRig = rig;
  csAuthorCamHelper = new THREE.CameraHelper(csCamera);
  return rig;
}

export function csShowAuthorCamera() {
  csEnsureAuthorCamera();
  if (_scene && !csAuthorCamRig.parent) _scene.add(csAuthorCamRig);
  if (_scene && csAuthorCamHelper && !csAuthorCamHelper.parent) _scene.add(csAuthorCamHelper);
  if (!csAuthorCamRig.userData.placed) {     // first open → sit at the viewport camera
    csResetCameraToViewport();
    csAuthorCamRig.userData.placed = true;
  }
  csSyncAuthorCamera();
}

export function csHideAuthorCamera() {
  csExitCameraPilot();
  if (csAuthorCamRig && csAuthorCamRig.parent) _scene.remove(csAuthorCamRig);
  if (csAuthorCamHelper && csAuthorCamHelper.parent) _scene.remove(csAuthorCamHelper);
}

// Keep the rig (visible body) and csCamera (real render camera) mirrored. While
// piloting, csCamera is the source (fly drives it) → copy onto the rig; otherwise
// the rig is the source (gizmo drives it) → copy onto csCamera. Runs every
// author-mode frame from csRenderTick.
export function csSyncAuthorCamera() {
  if (!csAuthorCamRig) return;
  if (csCameraPiloting) {
    csCamera.updateMatrixWorld(true);
    csAuthorCamRig.position.copy(csCamera.position);
    csAuthorCamRig.quaternion.copy(csCamera.quaternion);
  } else {
    csAuthorCamRig.updateWorldMatrix(true, false);
    csAuthorCamRig.getWorldPosition(csCamera.position);
    csAuthorCamRig.getWorldQuaternion(csCamera.quaternion);
  }
  if (Math.abs(csCamera.fov - csAuthorFov) > 1e-3) { csCamera.fov = csAuthorFov; csCamera.updateProjectionMatrix(); }
  csCamera.updateMatrixWorld(true);                              // frustum helper tracks it even when not rendering through csCamera
  csAuthorCamRig.visible = !csCameraPiloting;                    // don't draw the body from inside itself
  if (csAuthorCamHelper) { csAuthorCamHelper.visible = !csCameraPiloting; csAuthorCamHelper.update(); }
}

export function csToggleCameraPilot() {
  if (csCameraPiloting) csExitCameraPilot(); else csEnterCameraPilot();
  return csCameraPiloting;
}

function csEnterCameraPilot() {
  csShowAuthorCamera();
  // Seed csCamera from the rig, then hand the fly controls the REAL camera so
  // getWorldDirection() = -Z (WASD forward / look are NOT inverted).
  csAuthorCamRig.updateWorldMatrix(true, false);
  csAuthorCamRig.getWorldPosition(csCamera.position);
  csAuthorCamRig.getWorldQuaternion(csCamera.quaternion);
  csCamera.updateMatrixWorld(true);
  csCameraPiloting = true;
  cutsceneCamActive = true;                          // render loop → csCamera
  if (_csSetFlyTarget) _csSetFlyTarget(csCamera);
  csSyncAuthorCamera();
}

function csExitCameraPilot() {
  if (!csCameraPiloting) return;
  csCameraPiloting = false;
  cutsceneCamActive = false;                         // back to the editor free camera
  if (_csSetFlyTarget) _csSetFlyTarget(null);
  csSyncAuthorCamera();                              // rig already mirrors csCamera → flown pose persists
  document.getElementById('cs-seq-cam')?.classList.remove('active');
}

// Snap the author camera to the editor viewport camera's current pose + FOV.
export function csResetCameraToViewport() {
  csEnsureAuthorCamera();
  if (!_camera) return;
  _camera.updateWorldMatrix(true, false);
  csAuthorCamRig.position.copy(_camera.position);
  csAuthorCamRig.quaternion.copy(_camera.quaternion);
  csAuthorFov = _camera.fov;
  if (csCameraPiloting) {                            // keep csCamera in step if we're flying
    csCamera.position.copy(_camera.position);
    csCamera.quaternion.copy(_camera.quaternion);
  }
  csSyncAuthorCamera();
}

// The author camera's pose as route keyframe fields, in FFXI world coords (zoneRoot
// local space) + FOV°. Reads csCamera (a real Camera → getWorldDirection is the -Z
// LOOK direction, so the recorded look-at points where the camera actually faces).
export function csCaptureCameraPose() {
  csEnsureAuthorCamera();
  csSyncAuthorCamera();                               // make csCamera reflect the current pose
  const zr = _getZoneRoot && _getZoneRoot();
  csCamera.updateMatrixWorld(true);
  const eyeW = new THREE.Vector3(); csCamera.getWorldPosition(eyeW);
  const fwd = new THREE.Vector3(); csCamera.getWorldDirection(fwd);   // -Z look direction
  // ★ CRITICAL (docs/events/camera_scene_ids.md): retail look-at is ~2m from eye.
  // eye+forward*100 (~100m) crashes the client in custom scene DATs. Keep 2.5.
  const lookW = eyeW.clone().addScaledVector(fwd, 2.5);
  const eye = zr ? zr.worldToLocal(eyeW.clone()) : eyeW;   // display world → FFXI world
  const look = zr ? zr.worldToLocal(lookW.clone()) : lookW;
  return {
    eye: [+eye.x.toFixed(3), +eye.y.toFixed(3), +eye.z.toFixed(3)],
    look: [+look.x.toFixed(3), +look.y.toFixed(3), +look.z.toFixed(3)],
    fov: Math.round(csAuthorFov),                 // FOV in degrees (converted to focal length at compile)
  };
}

// Drive the author camera along the authored path to a given frame (scrub preview).
// Samples the camera track's shots at `frame` and positions csCamera + the rig so the
// body glides along the spline as you drag the playhead — through the piloted view
// too. If the camera track has NO keyframes there's nothing to play, so it's a no-op
// (the camera stays exactly where you flew it — never reset to the viewport).
export function csDriveCameraToFrame(frame) {
  if (!_authorState || !csAuthorCamRig) return false;
  const shots = _authorCameraShots();
  if (!shots.length) return false;
  let shot = shots[0];                                        // active shot = last one started by `frame`
  for (const s of shots) { if (s.frame <= frame) shot = s; }
  const lt = shot.dur > 0 ? Math.max(0, Math.min(1, (frame - shot.frame) / shot.dur)) : 0;
  const s = csSampleShot(shot.camera, _csEase(lt, shot.smooth));   // route SmoothingType easing
  const zr = _getZoneRoot && _getZoneRoot();
  const eye = new THREE.Vector3(s.eye[0], s.eye[1], s.eye[2]);
  const look = new THREE.Vector3(...(s.look || s.eye));
  if (zr) { zr.localToWorld(eye); zr.localToWorld(look); }   // FFXI → display world
  // Drive the REAL camera (lookAt on a Camera aims its -Z at the target), then mirror
  // it onto the rig — csCamera.lookAt on a Group would aim +Z (backwards).
  csCamera.position.copy(eye);
  csCamera.up.set(0, 1, 0);
  csCamera.lookAt(look);
  if (s.roll) csCamera.rotateZ(s.roll);        // camera roll — tilt around the view axis (radians)
  if (s.fov) { csAuthorFov = _csFocalToFov(s.fov); csCamera.fov = csAuthorFov; csCamera.updateProjectionMatrix(); }  // focal length → FOV°
  csCamera.updateMatrixWorld(true);
  csAuthorCamRig.position.copy(csCamera.position);
  csAuthorCamRig.quaternion.copy(csCamera.quaternion);
  csAuthorCamRig.visible = !csCameraPiloting;
  if (csAuthorCamHelper) csAuthorCamHelper.update();
  return true;
}

// ── Song / SFX catalogs + preview playback ──────────────────────────────────
// Lazily fetched once per session so the Music/SFX keyframe popovers can offer a
// real dropdown of every song / sound (SFX grouped by the game's own categories),
// with a Play/Stop button that decodes + auditions the audio in-browser.
let csMusicCatalog = null;   // [{id, title, playable}]
let csSfxCatalog = null;     // [{key, label, sounds:[{id, title}]}]
let csPreviewAudio = null;

export async function csEnsureAudioCatalogs() {
  if (!_bridgeOnline || !_bridgeOnline() || !_bridgeCall) return;
  try {
    if (!csMusicCatalog) {
      const r = await _bridgeCall('audio.musicCatalog', {});
      if (r && r.ok) { csMusicCatalog = (r.rows || []).filter((x) => x.playable && x.id != null); if (csAuthorMode) _renderAuthorDetailRefresh(); }
    }
    if (!csSfxCatalog) {
      const r = await _bridgeCall('audio.sfxCatalog', {});
      if (r && r.ok) { csSfxCatalog = r.groups || []; if (csAuthorMode) _renderAuthorDetailRefresh(); }
    }
  } catch {}
}

export function csStopPreviewAudio() {
  if (csPreviewAudio) { try { csPreviewAudio.pause(); } catch {} csPreviewAudio = null; }
  document.querySelectorAll('.cs-audio-play.playing').forEach((b) => {
    b.classList.remove('playing');
    const ic = b.querySelector('.material-symbols-outlined'); if (ic) ic.textContent = 'play_arrow';
  });
}

async function csPlayPreviewAudio(kind, id, btn) {
  const wasPlaying = btn && btn.classList.contains('playing');
  csStopPreviewAudio();
  if (wasPlaying || id == null || id === '' || +id <= 0) return;    // toggle off / no song
  const ic = btn && btn.querySelector('.material-symbols-outlined');
  try {
    if (ic) ic.textContent = 'hourglass_top';
    const r = kind === 'music'
      ? await decodeBgmWithExportFallback(+id)
      : await decodeSfxWithExportFallback(+id);
    if (!r || !r.ok || !r.wavBase64) { _setStatus?.(r?.error || 'Could not decode audio', true); if (ic) ic.textContent = 'play_arrow'; return; }
    const audio = new Audio('data:audio/wav;base64,' + r.wavBase64);
    csPreviewAudio = audio;
    audio.onended = () => csStopPreviewAudio();
    await audio.play();
    if (btn) { btn.classList.add('playing'); if (ic) ic.textContent = 'stop'; }
  } catch (e) {
    _setStatus?.('Audio playback failed', true);
    if (ic) ic.textContent = 'play_arrow';
  }
}

// Re-render the open keyframe popover (used after a catalog finishes loading).
function _renderAuthorDetailRefresh() {
  if (document.getElementById('cs-seq-modal')) _renderSeqModal();   // re-render the open modal
}

// A Play/Stop button for a Song/SFX dropdown (auditions the selected id).
function _audioPlayBtn(kind) {
  return `<button class="cs-audio-play" data-audio-kind="${kind}" title="Play / stop the selected ${kind === 'music' ? 'song' : 'sound'}" style="flex:0 0 auto; background:#2a2f3d; border:none; border-radius:4px; color:#a5ecf5; cursor:pointer; width:26px; height:24px; display:flex; align-items:center; justify-content:center;"><span class="material-symbols-outlined" style="font-size:16px;">play_arrow</span></button>`;
}

// Capture the author camera → a keyframe on the mandatory camera track. kind:
// 'still' (cut) | 'spline' (glide from previous kf). Defaults to the playhead
// frame; the right-click menu passes the clicked frame instead.
// `channel`: 'all' (whole-camera capture → all 3 channels) | 'campos' | 'camrot' | 'camzoom'
// (record ONLY that channel from the live pose, for refining one axis without touching the rest).
export function csRecordCameraKeyframe(kind = 'still', frameArg = null, channel = 'all') {
  if (!_authorState) return null;
  const st = _authorState;
  const sub = (k) => { let t = st.tracks.find((x) => x.kind === k); if (!t) { t = { kind: k, keyframes: [] }; st.tracks.push(t); } return t; };
  const frame = frameArg == null ? (csFrame | 0) : Math.max(0, frameArg | 0);
  const p = csCaptureCameraPose();     // { eye, look, fov(degrees) }
  const put = (t, kf) => { const at = t.keyframes.findIndex((k) => (k.frame | 0) === frame); if (at >= 0) t.keyframes[at] = { ...t.keyframes[at], ...kf }; else t.keyframes.push(kf); t.keyframes.sort((a, b) => (a.frame | 0) - (b.frame | 0)); };
  const want = (c) => channel === 'all' || channel === c;
  if (want('campos'))  put(sub('campos'),  { frame, eye: p.eye, camKind: kind, smooth: 4 });
  if (want('camrot'))  put(sub('camrot'),  { frame, look: p.look });
  if (want('camzoom')) put(sub('camzoom'), { frame, fov: p.fov });
  csFrame = frame;                     // park the playhead on the new keyframe (preview lands on it)
  _authorEdited();
  csBuildSequencer();
  csUpdatePlayhead();
  return { frame, camKind: kind };
}

// Bulk-convert EVERY camera keyframe's interpolation (Convert ALL → Curved / Linear). The very
// first key stays a 'still' cut to the opening pose; the rest take the chosen kind. Curved keys
// then chain into one smooth arc; linear = straight point-to-point glides.
function _authorSetAllCamKind(kind) {
  const st = _authorState; if (!st) return;
  const cam = st.tracks.find((t) => t.kind === 'campos');
  if (!cam || !cam.keyframes.length) return;
  cam.keyframes.sort((a, b) => (a.frame | 0) - (b.frame | 0));
  cam.keyframes.forEach((kf, i) => { kf.camKind = (i === 0) ? 'still' : kind; });
  _authorEdited(); csAuthorRefresh();
}

// ── Timeline playback state ───────────────────────────────────────────────────
export let csData = null;
let csFrame = 0, csPlaying = false, csRaf = null, csLastT = 0;
let csCamEnabled = true;    // auto-drive the viewport's cutscene camera from the active shot
let csActorsEnabled = true; // spawn the cutscene's NPC models into the viewport
const _csEye = new THREE.Vector3(), _csLook = new THREE.Vector3();

// Expose frame for the render loop (mixer.update, actor tag projection).
export function getCsFrame() { return csFrame; }

// ── Sequencer UI state ────────────────────────────────────────────────────────
const csSeqEl = document.getElementById('cs-seq');
let csTitle = 'Cutscene';

// ── Author-mode state ─────────────────────────────────────────────────────────
// When set, the sequencer shows an edit toolbar (Add Track / Length / Fade in-out)
// and clicking a keyframe opens a details popover instead of just seeking. Beats
// are derived from _authorState.tracks each rebuild; edits mutate _authorState
// and re-render.
let csAuthorMode = false;
let _authorState = null;           // reference to author state (from cutscene-author.js)
let _authorOnChange = null;         // callback to notify when state changes
let _authorSelected = null;         // {trackIdx, kfIdx} for the keyframe view of the sequencer modal
let _authorMultiSel = new Set();    // "ti:ki" of marquee-selected keyframes (shift+drag box)
let _authorAnchor = null;           // (legacy) kept for callers that still clear it; placement is now CSS
let _seqModalView = null;           // sequencer-modal view: 'keyframe' | 'length' | 'track' | null
let csDots = [];           // [{ el, frame, span }] cached for cheap per-frame active toggling
let csDragging = false;
let csZoom = 1;            // horizontal timeline zoom (1 = fit; body width = csZoom × viewport)
let csCurvesOpen = false;  // Load-view camera lane expanded → shot X/Y/Z eye curves
const csCurveOpen = { campos: false, camrot: false, camzoom: false };  // author: per-channel curve expand
let csSnap = true;         // author mode: snap a dragged keyframe to other keyframes' frames
const CS_SNAP_PX = 8;      // snap radius in screen pixels
let csFrameSnap = 0;       // playhead scrub snapping: 0 = free, else snap to N-frame increments (5/15)

// ── Cutscene 3D actors ────────────────────────────────────────────────────────
let csActorGroup = null;     // identity THREE.Group under zoneRoot holding actor nodes
let csActors = [];           // [{actorId, name, node, showFrame, hideFrame, loaded}]
let csSelectedActor = null;  // csActors record the user clicked

// csActorOutline is added to scene in initCutsceneScene() after initCutscene() provides _scene.
let csActorOutline = null;

let csActorTagEl = null;
function getCsActorTag() {
  if (!csActorTagEl) {
    csActorTagEl = document.createElement('div');
    csActorTagEl.id = 'cs-actor-tag';
    document.body.appendChild(csActorTagEl);
  }
  return csActorTagEl;
}

// Call once after initCutscene() to wire the outline group to the scene and
// register static DOM event listeners. Returns the csActorOutline group so
// the render loop can pass it to updateOutline().
export function initCutsceneScene() {
  csActorOutline = new THREE.Group();
  _scene.add(csActorOutline);

  // Sequencer controls — wired once; the panel + buttons are static in index.html.
  document.getElementById('cs-seq-play')?.addEventListener('click', csTogglePlay);
  document.getElementById('cs-seq-stop')?.addEventListener('click', () => { csStop(); csFrame = 0; csUpdatePlayhead(); });
  document.getElementById('cs-seq-close')?.addEventListener('click', csCloseSequencer);
  document.getElementById('cs-seq-cam')?.addEventListener('click', (e) => {
    if (csAuthorMode) {
      // Author mode: pilot the positionable cutscene camera (WASD/look flies it).
      const on = csToggleCameraPilot();
      e.currentTarget.classList.toggle('active', on);
      e.currentTarget.title = on
        ? 'Piloting the cutscene camera — WASD/drag to fly, click again to release'
        : 'Pilot the cutscene camera';
      if (on && _csOnCameraSelect) _csOnCameraSelect(null);   // drop the gizmo while flying
      return;
    }
    csCamEnabled = !csCamEnabled;
    e.currentTarget.classList.toggle('active', csCamEnabled);
    if (!csCamEnabled) cutsceneCamActive = false;
    csApplyCamera();
  });
  document.getElementById('cs-seq-zoom-in')?.addEventListener('click', () => csZoomBy(1.5));
  document.getElementById('cs-seq-zoom-out')?.addEventListener('click', () => csZoomBy(1 / 1.5));
  document.getElementById('cs-seq-frame-prev')?.addEventListener('click', () => csStepFrame(-1));
  document.getElementById('cs-seq-frame-next')?.addEventListener('click', () => csStepFrame(1));
  const snapBtn = document.getElementById('cs-seq-snap');
  if (snapBtn) {
    if (_loadSetting) csSnap = _loadSetting('csSnap', csSnap);   // restore last session's choice
    const snapApply = () => {
      snapBtn.classList.toggle('active', csSnap);
      snapBtn.title = csSnap ? 'Snapping ON — drag snaps to other keyframes' : 'Snapping OFF';
    };
    snapApply();
    snapBtn.addEventListener('click', () => {
      csSnap = !csSnap;
      snapApply();
      if (_saveSetting) _saveSetting('csSnap', csSnap);
    });
  }
  // Playhead frame snapping — triple toggle: off → 5-frame → 15-frame → off.
  const fsnapBtn = document.getElementById('cs-seq-framesnap');
  if (fsnapBtn) {
    if (_loadSetting) csFrameSnap = _loadSetting('csFrameSnap', csFrameSnap);   // restore 0/5/15
    const fsnapApply = () => {
      fsnapBtn.classList.toggle('active', csFrameSnap > 0);
      fsnapBtn.querySelector('.material-symbols-outlined').textContent =
        csFrameSnap === 15 ? 'text_select_move_forward_word' : 'text_select_move_forward_character';
      fsnapBtn.title = csFrameSnap
        ? `Playhead snapping — ${csFrameSnap}-frame increments`
        : 'Playhead snapping OFF — scrub is free';
    };
    fsnapApply();
    fsnapBtn.addEventListener('click', () => {
      csFrameSnap = csFrameSnap === 0 ? 5 : (csFrameSnap === 5 ? 15 : 0);
      fsnapApply();
      if (_saveSetting) _saveSetting('csFrameSnap', csFrameSnap);
    });
  }
  document.getElementById('cs-seq-hideui')?.addEventListener('click', () => csSetCinematic('hideUi'));
  document.getElementById('cs-seq-ratio')?.addEventListener('click', () => csSetCinematic('fixedRatio'));
  document.getElementById('cs-seq-crosshair')?.addEventListener('click', () => csSetCinematic('crosshair'));
  window.addEventListener('resize', () => {
    // Re-clamp a custom height to the (possibly smaller) window, then re-letterbox.
    if (csSeqEl?.classList.contains('cs-seq-resized')) _applySeqHeight(csSeqEl.getBoundingClientRect().height);
    csUpdateLetterbox();
  });
  // The sequencer height changes as tracks are added/removed OR via the drag grip → recompute
  // the 16:9 bars (they're sized to the viewport MINUS the sequencer, so they must follow it).
  if (csSeqEl && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => csUpdateLetterbox()).observe(csSeqEl);
  }
  _csInitSeqResizeGrip();
  // Author-only toolbar buttons: open the sequencer modal on the length or add-track view.
  document.getElementById('cs-seq-length')?.addEventListener('click', () => _toggleSeqModal('length'));
  document.getElementById('cs-seq-tracks')?.addEventListener('click', () => _toggleSeqModal('track'));
  // Quick camera keyframe at the playhead — captures the current pose (still for the first
  // keyframe, spline thereafter so subsequent shots glide from the previous).
  document.getElementById('cs-seq-addcam')?.addEventListener('click', () => {
    if (!csAuthorMode) return;
    const cam = _authorState?.tracks.find((t) => t.kind === 'campos');
    // Default new shots to CURVED (smooth arc, like retail) — the first key is a cut to the
    // opening pose, the rest chain into a curve. Pick Snap/Linear from the ⋮ menu for cuts/glides.
    csRecordCameraKeyframe(cam && cam.keyframes.length ? 'curved' : 'still', csFrame | 0);
  });
  // Edit Cutscene — reopen the author modal (author mode) or start editing the loaded cutscene.
  document.getElementById('cs-seq-editcut')?.addEventListener('click', () => {
    if (csAuthorMode) { if (_resumeAuthor) _resumeAuthor(); return; }
    if (csData && _openAuthorFrom) {
      const aid = csData.actorId >>> 0;
      _openAuthorFrom(csData, '0x' + aid.toString(16).padStart(8, '0').toUpperCase(), csData.actorName || null);
    }
  });

  // Alt + wheel over the track zooms in/out, anchored at the cursor.
  document.getElementById('cs-seq-graph')?.addEventListener('wheel', (e) => {
    if (!e.altKey) return;
    e.preventDefault();
    csZoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX);
  }, { passive: false });
  // Click the Camera (or Shot) lane label to toggle the shot X/Y/Z eye curves.
  document.getElementById('cs-seq-graph')?.addEventListener('click', (e) => {
    // Author mode: delete-track button on a lane label.
    const delBtn = e.target.closest('.cs-auth-del-track');
    if (delBtn) {
      e.stopPropagation();
      const st = _authorState; if (!st) return;
      const track = st.tracks[+delBtn.dataset.ti];
      if (!track || AUTHOR_TRACK_KINDS[track.kind]?.mandatory || track.locked) return;   // camera / locked Player group — never deletable
      if (track.kind === 'actor') {
        // Deleting an actor removes the group + all its sub-tracks.
        const cid = track.castId;
        const subs = st.tracks.filter((t) => t !== track && t.castId === cid && ACTOR_SUB_KINDS.includes(t.kind));
        const nm = st.cast.find((c) => c.id === cid)?.name || cid;
        if ((!track.keyframes?.length && !subs.length) || confirm(`Remove ${nm} and its ${subs.length} track(s)?`)) {
          const drop = new Set([track, ...subs]);
          st.tracks = st.tracks.filter((t) => !drop.has(t));
          _authorSelected = null; _seqModalView = null; _authorEdited(); csAuthorRefresh();
        }
        return;
      }
      if (!track.keyframes?.length || confirm('Remove this track and its keyframes?')) {
        st.tracks.splice(st.tracks.indexOf(track), 1);
        _authorSelected = null; _seqModalView = null; _authorEdited(); csAuthorRefresh();
      }
      return;
    }
    // In author mode, route to a keyframe selection.
    if (_authorHandleClick(e)) return;
    // Actor group header → toggle collapse.
    const groupLabel = e.target.closest('.cs-actor-group-label');
    if (groupLabel) {
      const gt = _authorState?.tracks[+groupLabel.dataset.groupTi];
      if (gt && (gt.kind === 'actor' || gt.kind === 'camera')) { gt.collapsed = !gt.collapsed; csBuildSequencer(); csUpdatePlayhead(); }
      return;
    }
    // Camera sub-track header → toggle THAT channel's curve (Position → X/Y/Z, Rotation → pitch/yaw,
    // Zoom → zoom). Load mode keeps its single csCurvesOpen toggle.
    const camLabel = e.target.closest('.cs-cam-lane-label');
    if (!camLabel) return;
    const ct = _authorState?.tracks[+camLabel.dataset.hiTi];
    if (ct && CAMERA_SUB_KINDS.includes(ct.kind)) csCurveOpen[ct.kind] = !csCurveOpen[ct.kind];
    else csCurvesOpen = !csCurvesOpen;
    csBuildSequencer();
    csUpdatePlayhead();
  });
  // Right-click the track body (author mode) → context menu to add a keyframe.
  // If right-clicking ON a specific track's lane, offer to add to THAT track first.
  document.getElementById('cs-seq-graph')?.addEventListener('contextmenu', (e) => {
    if (!csAuthorMode) return;
    // Right-click a track LABEL (Camera / Actor / Wait / …) → "Add Track" + a separator +
    // that track's usual row actions, at the current playhead frame.
    const labelEl = e.target.closest('.cs-auth-lane-label');
    if (labelEl) {
      e.preventDefault();
      const lti = labelEl.dataset.hiTi != null ? +labelEl.dataset.hiTi
                : (labelEl.dataset.groupTi != null ? +labelEl.dataset.groupTi : null);
      _authorShowContextMenu(e.clientX, e.clientY, csFrame | 0, lti, null, { addTrack: true });
      return;
    }
    const body = document.getElementById('cs-seq-body');
    if (!body || !body.contains(e.target)) return;
    e.preventDefault();
    const lane = e.target.closest('.cs-auth-lane');
    let laneTi = lane && lane.dataset.ti != null ? +lane.dataset.ti : null;
    // Right-clicking the expanded camera CURVE area (not a lane row) → treat it as the Position
    // lane so you get the camera keyframe options, not the generic "add anything" menu.
    if (laneTi == null && e.target.closest('.cs-seq-curves')) {
      const ci = _authorState?.tracks.findIndex((t) => t.kind === 'campos');
      if (ci != null && ci >= 0) laneTi = ci;
    }
    // Right-clicking ON an author keyframe dot → offer Edit / Delete for that keyframe.
    const dot = e.target.closest('.cs-seq-dot');
    const kfRef = (dot && dot.dataset.authorTi != null)
      ? { ti: +dot.dataset.authorTi, ki: +dot.dataset.authorKi } : null;
    _authorShowContextMenu(e.clientX, e.clientY, _frameFromClientX(e.clientX), laneTi, kfRef);
  });
  // Drag a song from the Asset Browser's Music tab anywhere onto the sequencer →
  // key it as the Music track at frame 0 (creating the track if needed).
  csSeqEl?.addEventListener('dragover', (e) => {
    if (!csAuthorMode || !_authorState || !e.dataTransfer.types.includes('application/x-xi-music')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    csSeqEl.classList.add('cs-seq-droptarget');
  });
  csSeqEl?.addEventListener('dragleave', () => csSeqEl.classList.remove('cs-seq-droptarget'));
  csSeqEl?.addEventListener('drop', (e) => {
    csSeqEl.classList.remove('cs-seq-droptarget');
    const raw = e.dataTransfer.getData('application/x-xi-music');
    if (!raw || !csAuthorMode || !_authorState) return;
    e.preventDefault();
    let song; try { song = JSON.parse(raw); } catch { return; }
    _authorDropMusic(song);
  });
  // Hover-highlight the track row (label + body) under the cursor in author mode.
  const graphEl = document.getElementById('cs-seq-graph');
  graphEl?.addEventListener('mousemove', (e) => {
    if (!csAuthorMode) { _authorHighlightTrack(null); return; }
    const row = e.target.closest('.cs-auth-lane, .cs-auth-lane-label');
    const ti = row ? (row.dataset.ti != null ? row.dataset.ti : row.dataset.hiTi) : null;
    _authorHighlightTrack(ti != null ? +ti : null);
  });
  graphEl?.addEventListener('mouseleave', () => _authorHighlightTrack(null));
  // Click / drag the track body to scrub.
  document.getElementById('cs-seq-graph')?.addEventListener('mousedown', (e) => {
    const body = document.getElementById('cs-seq-body');
    if (!body || !body.contains(e.target)) return;
    if (e.button !== 0) return;                 // ignore right-click (handled above)
    _authorCloseContextMenu();
    const dot = e.target.closest('.cs-seq-dot');
    // Author mode: Shift+drag over empty timeline → marquee-select keyframes.
    if (csAuthorMode && e.shiftKey && !dot) {
      _authorStartMarquee(e);
      e.preventDefault();
      return;
    }
    // Author mode: click-drag an author keyframe dot to move its frame (or its whole group).
    if (csAuthorMode && dot && dot.dataset.authorTi != null) {
      _authorStartKeyframeDrag(e, dot);
      e.preventDefault();
      return;
    }
    // A plain click on empty timeline clears any marquee selection.
    if (csAuthorMode && !dot && _authorMultiSel.size) _authorClearMultiSel();
    csStop();
    if (dot && dot.dataset.frame != null) {
      csFrame = Number(dot.dataset.frame); csUpdatePlayhead();
      // Load (retail) view: clicking a beat shows read-only details.
      if (!csAuthorMode && dot.dataset.beatIdx != null && csData) {
        _showLoadBeatDetail(dot, csData.beats[+dot.dataset.beatIdx]);
      }
    } else {
      // Clicking empty timeline (scrub) closes any open keyframe detail popover.
      csDragging = true; csSeekToClientX(e.clientX);
      _closeLoadBeatDetail(); _closeAuthorDetail();
    }
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => { if (csDragging) csSeekToClientX(e.clientX); });
  window.addEventListener('mouseup', () => {
    csDragging = false;
    const tip = document.getElementById('cs-seq-ph-tip'); if (tip) tip.style.display = 'none';   // hide the scrub readout
  });
  // Spacebar toggles play/pause while the sequencer is open.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (!csSeqEl || csSeqEl.hidden) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    csTogglePlay();
  });
  // Delete / Backspace removes the selected keyframe(s) — the marquee group or the open one.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (!csAuthorMode || !csSeqEl || csSeqEl.hidden) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (_authorDeleteSelectedKeyframes()) e.preventDefault();
  });

  return csActorOutline;
}

// ── Open / close the bottom sequencer ────────────────────────────────────────
// (The old read-only "Load Cutscene" playback view was removed — the sequencer now only
// opens in AUTHOR mode, so what you see always matches what you built, not a decode of the
// published DAT.)
//
// Open the sequencer in AUTHOR mode. Beats derive from state.tracks; edit
// toolbar shown; keyframe clicks open a details popover; `onChange` is invoked
// after every mutation so the caller can trigger auto-preview or save.
export function csOpenAuthor(state, opts = {}) {
  csStop();
  // Always enter Edit on the FREE viewport camera — never inherit a stale "sequencer
  // camera active" / piloting state from a previously-viewed cutscene. (In author mode
  // csApplyCamera early-returns, so nothing else would clear it → stuck view.)
  cutsceneCamActive = false;
  csCameraPiloting = false;
  if (_csSetFlyTarget) _csSetFlyTarget(null);
  csAuthorMode = true;
  _authorState = state;
  _authorUndoBaseline = _authorSnapshot();      // baseline for keyframe undo/redo
  _authorOnChange = opts.onChange || null;
  _authorSelected = null; _authorAnchor = null; _seqModalView = null; _authorMultiSel.clear();
  csTitle = opts.title || 'Cutscene (editing)';
  // Preserve position/zoom when transitioning view→edit while the sequencer is already open.
  const _seqAlreadyOpen = csSeqEl && !csSeqEl.hidden;
  if (!_seqAlreadyOpen) { csZoom = 1; csFrame = 0; }
  csCurvesOpen = false;
  csData = _authorBeats();
  csBuildSequencer();
  if (csSeqEl) csSeqEl.hidden = false;
  csReflectPlayBtn();
  csUpdatePlayhead();
  csShowAuthorCamera();                        // a positionable camera lives in the scene
  document.getElementById('cs-seq-cam')?.classList.toggle('active', csCameraPiloting);
  csEnsureAudioCatalogs();                      // preload song/SFX lists for the keyframe dropdowns
  _authorFramedCast = false;
  csLoadAuthorActors();                         // show the cast NPCs at their default positions
  if (opts.pilot !== false) {                   // auto-enter the cutscene camera by default (opt out with pilot:false)
    csEnterCameraPilot();
    document.getElementById('cs-seq-cam')?.classList.add('active');
    if (_csOnCameraSelect) _csOnCameraSelect(null);   // drop the gizmo while flying, like the toggle does
  }
}

export function csCloseSequencer() {
  csStop();
  csStopPreviewAudio();                        // stop any auditioning song/SFX
  csHideAuthorCamera();                        // remove the author camera + stop piloting
  cutsceneCamActive = false;                  // hand the viewport back to the free camera
  csClearActors();
  csClearVfx();
  _authorCloseContextMenu();
  _closeLoadBeatDetail();
  document.getElementById('cs-seq-modal')?.remove();
  csAuthorMode = false; _authorState = null; _authorSelected = null; _seqModalView = null;
  if (csSeqEl) csSeqEl.hidden = true;
  csUpdateLetterbox();                        // hide the letterbox
}

// Convert the author state's tracks into a csData beats structure so the same
// renderer draws both retail cutscenes and in-progress ones.
function _authorBeats() {
  if (!_authorState) return { fps: 30, totalFrames: 200, beats: [] };
  const beats = [];
  const castName = (id) => {
    const c = _authorState.cast.find((x) => x.id === id);
    return c ? (c.name || c.id) : id;
  };
  const lineText = (id) => {
    const l = _authorState.lines.find((x) => x.id === id);
    return l ? l.text : '';
  };
  _authorState.tracks.forEach((t, ti) => {
    (t.keyframes || []).forEach((kf, ki) => {
      const ref = { _authorRef: { ti, ki } };
      const frame = kf.frame | 0;
      if (t.kind === 'dialog') {
        beats.push({ type: 'dialogue', frame,
          speaker: castName(kf.speaker || t.castId), text: lineText(kf.line) || `(${kf.line || '?'})`,
          ...ref });
      } else if (t.kind === 'face') {
        beats.push({ type: 'anim', frame, name: 'face',
          actor: castName(kf.actor || t.castId), ...ref });
      } else if (t.kind === 'npc') {
        beats.push({ type: 'npc', frame,
          actor: castName(t.castId), action: kf.action || 'show', ...ref });
      } else if (t.kind === 'position') {
        beats.push({ type: 'npc', frame,
          actor: `${castName(kf.actor)} → ${kf.marker || 'pos'}`, action: 'move', ...ref });
      } else if (t.kind === 'music') {
        beats.push({ type: 'music', frame,
          name: kf.name || `song ${kf.song ?? 0} (slot ${kf.slot ?? 0})`, ...ref });
      } else if (t.kind === 'fade') {
        // dur → the sequencer renders a span bar of this many frames (csBeatSpan).
        beats.push({ type: 'fade', frame, dur: kf.dur || 30,
          tag: kf.tag || (kf.kind === 'out' ? 'fdo1' : 'fdi1'), ...ref });
      } else if (t.kind === 'camera' || t.kind === 'shot') {
        beats.push({ type: t.kind, frame, tag: kf.tag, dur: kf.dur, ...ref });
      } else if (t.kind === 'task') {
        beats.push({ type: 'task', frame, tag: kf.tag, dur: kf.dur, ...ref });
      } else if (t.kind === 'taskEnd') {
        beats.push({ type: 'taskEnd', frame, tag: kf.tag, ...ref });
      } else if (t.kind === 'wait') {
        beats.push({ type: 'wait', frame, frames: kf.frames, ...ref });
      } else if (t.kind === 'anim') {
        beats.push({ type: 'anim', frame, name: kf.anim || 'anim',
          actor: kf.actor || castName(t.castId), ...ref });
      } else if (t.kind === 'vfx') {
        beats.push({ type: 'vfx', frame, effect: kf.effect,
          caster: kf.caster, target: kf.target, ...ref });
      } else if (t.kind === 'end') {
        beats.push({ type: 'end', frame, ...ref });
      } else {
        beats.push({ type: 'task', frame, tag: t.kind, ...ref });
      }
    });
  });
  beats.sort((a, b) => a.frame - b.frame);
  return { fps: 30, totalFrames: Math.max(30, _authorState.totalFrames | 0), beats };
}

// Called by cutscene-author whenever state.tracks / totalFrames / lines change,
// so the sequencer re-renders without a full re-open.
export function csAuthorRefresh() {
  if (!csAuthorMode) return;
  csData = _authorBeats();
  csRebuildAuthorAnimTracks();   // keep the staged NPCs' gesture timelines in sync with the tracks
  csBuildSequencer();
  csUpdatePlayhead();
}

// True when the sequencer modal is showing a Position-track keyframe — lets the
// viewport offer a right-click "Add Position Marker" that binds to this keyframe.
export function csPositionKeyframeOpen() {
  if (!csAuthorMode || !_authorSelected) return false;
  const t = _authorState?.tracks?.[_authorSelected.trackIdx];
  return !!(t && t.kind === 'position');
}

// Bind a just-placed marker (name + zone-local FFXI pos) to the open Position keyframe.
export function csAssignMarkerToOpenPositionKf(name, pos) {
  if (!csPositionKeyframeOpen()) return;
  const kf = _authorState.tracks[_authorSelected.trackIdx].keyframes[_authorSelected.kfIdx];
  if (!kf) return;
  kf.marker = name;
  if (pos) kf.pos = pos;
  _authorEdited(); csAuthorRefresh(); csLoadAuthorActors();
}

// True when the open Position keyframe already points at a marker — so adding a NEW marker
// doesn't hijack an actor that's already assigned one.
export function csOpenPositionKfHasMarker() {
  if (!csPositionKeyframeOpen()) return false;
  const kf = _authorState.tracks[_authorSelected.trackIdx].keyframes[_authorSelected.kfIdx];
  return !!(kf && kf.marker);
}

// Re-render the open keyframe modal in place — e.g. after adding a marker so the
// "To marker" dropdown picks up the new option without closing/reopening the panel.
export function csRefreshOpenKeyframe() {
  if (csAuthorMode && _authorSelected && document.getElementById('cs-seq-modal')) _renderSeqModal();
}

// ── Cutscene 3D actors ────────────────────────────────────────────────────────

// NPC name/look/position come from the server's npc_list table. With no local server
// running, the backend falls back to a snapshot bundled inside xi-tools — the cast still
// renders, but it reflects the upstream table rather than your database, so anything you
// changed server-side (renames, moves, custom NPCs) won't be shown. Say so once per
// session: silently rendering stale placement is how this went unnoticed before.
let _npcFallbackNoted = false;
function _noteNpcSource(r) {
  if (_npcFallbackNoted || !r) return;
  if (r.dbReachable !== false) return;
  if (!(r.npcSources && r.npcSources.bundled)) return;
  _npcFallbackNoted = true;
  console.info('[cs actors] server DB unreachable — NPC data came from the bundled '
    + 'npc_list snapshot', r.npcSources);
  _setStatus?.('NPCs loaded from the bundled snapshot (server database unreachable)');
}

function csClearActorSelection() {
  csSelectedActor = null;
  _clearOutline(csActorOutline);
  csActorOutline.visible = false;
  const tag = getCsActorTag();
  tag.style.display = 'none';
}

function csToggleActorSelection(rec) {
  if (csSelectedActor === rec) { csClearActorSelection(); return; }
  csSelectedActor = rec;
  _rebuildOutline(csActorOutline, _hoverOutlineMat, rec.node);
}

export function csClearActors() {
  csClearActorSelection();
  for (const rec of csActors) if (rec.mixer) rec.mixer.stopAllAction();
  if (csActorGroup) { _disposeSubtree(csActorGroup); csActorGroup.parent?.remove(csActorGroup); }
  csActorGroup = null;
  csActors = [];
}

async function csLoadActors(key) {
  csClearActors();
  const zoneRoot = _getZoneRoot();
  if (!_bridgeOnline() || !zoneRoot || !csActorsEnabled) return;
  const [actorId, eventId] = key.split(':').map(Number);
  const zoneUrl = _getCurrentZoneUrl();
  let r;
  try { r = await _bridgeCall('zone.cutsceneActors', { zone: zoneUrl, zoneId: _currentZoneId(), actorId, eventId }); }
  catch (e) { console.warn('[cs actors] fetch failed', e); return; }
  if (zoneUrl !== _getCurrentZoneUrl() || csData !== _eventsCutscene.get(key)?.data) return;  // stale
  if (!r || !r.ok || !Array.isArray(r.actors)) return;
  _noteNpcSource(r);
  csActorGroup = new THREE.Group(); csActorGroup.name = '__cutscene_actors';
  zoneRoot.add(csActorGroup);
  // entityId → the cast member's chosen Default idle, so the preview rests in the
  // pose the author picked (not the model's built-in idl0).
  const idleByEnt = {};
  for (const c of _authorState.cast || []) {
    if (c.entity && c.entity !== 'player' && c.idleAnim) {
      idleByEnt[parseInt(String(c.entity).replace(/^0x/i, ''), 16)] = c.idleAnim;
    }
  }
  let runtimeIdx = 0;
  for (const a of r.actors) {
    if (!a.hasModel) continue;
    const node = new THREE.Group(); node.rotation.order = 'ZYX';
    let pos = a.pos || [0, 0, 0];
    // Event-positioned NPCs (npc_list pos 0,0,0 — set by set_pos at runtime) aren't placed
    // yet: fan them in a small row near origin so they're visible, flagged approximate.
    if (a.runtimePos || (!pos[0] && !pos[1] && !pos[2])) { pos = [runtimeIdx * 2 - 4, 0, 0]; runtimeIdx++; node.userData.approxPos = true; }
    node.position.set(pos[0], pos[1], pos[2]);
    // FFXI heading angle → three.js rotation.y = φ DIRECTLY. The earlier φ−π/2 "derivation"
    // was wrong by 90° (never ground-truthed; user-calibrated against the game 2026-07-20:
    // in-game facing sat 90° to the actor's LEFT of the preview, so the preview needed +π/2).
    const dirRad = (typeof a.dir === 'number') ? a.dir
                 : (a.rot ? (a.rot / 256) * Math.PI * 2 : 0);
    node.rotation.y = dirRad - Math.PI;   /* yaw = heading − 180° (two-step user calibration 2026-07-20: −π/2 was 90° off one way, bare dir 180° off → −π) */
    node.visible = false;
    node.userData.actorName = a.name;
    csActorGroup.add(node);
    const rec = { actorId: a.actorId, name: a.name, node, loaded: false, dirRad,
                  showFrame: a.showFrame ?? 0, hideFrame: a.hideFrame ?? Infinity,
                  animTrack: a.animTrack || [], actions: null, idleName: null, curAnim: null,
                  preferredIdle: idleByEnt[a.actorId >>> 0] || null,   // author's Default idle
                  motionClips: a.motionClips || {},   // {tag:{file_id,clip}} → embedded GLB anims, named by tag
                  motion: a.motion || [], homePos: node.position.clone() };
    csActors.push(rec);
    csLoadActorData(rec, zoneUrl);
  }
  const rt = csActors.filter((a) => a.node.userData.approxPos).length;
  console.info(`[cs actors] ${csActors.length} NPC(s) to load (${rt} runtime-positioned at origin):`,
    csActors.map((a) => `${a.name}@${a.node.getWorldPosition(new THREE.Vector3()).toArray().map((n) => n.toFixed(1)).join(',')} world [${a.showFrame}-${a.hideFrame}]`));
  csUpdateActorVisibility();
  // The cast stands at the staged spot (often far from where the free camera is). If the
  // cutscene camera isn't already framing the scene, point the free camera at the cast.
  if (!cutsceneCamActive) csFrameCast();
}

// Author mode: spawn the cutscene's CAST NPCs at their default npc_list positions so
// you can SEE them (e.g. Maat) while framing the camera. Driven by state.cast — works
// for a brand-new cutscene too (unlike csLoadActors, which needs npc show/hide beats).
let _authorFramedCast = false;   // one-time free-camera aim at the cast per author session
export async function csLoadAuthorActors() {
  csClearActors();
  const zoneRoot = _getZoneRoot();
  if (!_bridgeOnline || !_bridgeOnline() || !zoneRoot || !_authorState) return;
  // Dedupe by entity id — cast can hold the trigger twice (owner + extra), and the
  // zone DB has two "Maat" rows at the same pos (0x010F3031 / 0x010F3032). Spawning
  // both stacks two models on top of each other.
  const ids = [...new Set((_authorState.cast || [])
    .filter((c) => c.id !== 'player' && c.entity && c.entity !== 'player')
    .map((c) => parseInt(String(c.entity).replace(/^0x/i, ''), 16))
    .filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return;
  const zoneUrl = _getCurrentZoneUrl();
  let r;
  try { r = await _bridgeCall('zone.npcDefaults', { zone: zoneUrl, zoneId: _currentZoneId(), ids }); }
  catch (e) { return; }
  if (!csAuthorMode || zoneUrl !== _getCurrentZoneUrl()) return;      // stale (closed / zone switched)
  if (!r || !r.ok || !Array.isArray(r.actors)) return;
  _noteNpcSource(r);
  // Dedupe response by actorId ONLY. (The old name+pos "slot" dedup dropped any cast
  // member sharing a display name + default spawn spot with another — which silently
  // ate Maat·3032, the status-6 cutscene copy that sits at the SAME npc_list pos as
  // the trigger Maat·3031. Distinct ids the author explicitly cast must all spawn;
  // their Position keyframes place them apart anyway.)
  const seenId = new Set();
  r.actors = r.actors.filter((a) => {
    if (!a || !a.hasModel) return false;
    const id = a.actorId >>> 0;
    if (seenId.has(id)) return false;
    seenId.add(id);
    return true;
  });
  if (!csActorGroup) { csActorGroup = new THREE.Group(); csActorGroup.name = '__cutscene_actors'; zoneRoot.add(csActorGroup); }
  // entityId → the author's picked Default idle (NPCs tab), so the staged NPC rests in
  // that pose — same mapping the retail-playback path builds in csLoadActors. Also
  // entityId → castId, so each rec can read the live routine→clip preview map.
  const idleByEnt = {}, castByEnt = {};
  for (const c of _authorState.cast || []) {
    if (!c.entity || c.entity === 'player') continue;
    const eid = parseInt(String(c.entity).replace(/^0x/i, ''), 16) >>> 0;
    if (c.idleAnim) idleByEnt[eid] = c.idleAnim;
    if (!(eid in castByEnt)) castByEnt[eid] = c.id;
  }
  // Position-track keyframes override the default spawn spot, so you frame the camera
  // around where the NPC actually STANDS in the cutscene (first placement wins).
  const posOverride = {};   // entityId -> [x,y,z]
  const dirOverride = {};   // entityId -> heading (radians) from a Position keyframe
  const posTracks = (_authorState.tracks || []).filter((t) => t.kind === 'position');
  if (posTracks.length) {
    const castEnt = {};
    for (const c of _authorState.cast || []) {
      if (c.entity && c.entity !== 'player') castEnt[c.id] = parseInt(String(c.entity).replace(/^0x/i, ''), 16);
    }
    // Collect keyframes from EVERY position sub-track (one per actor now), stamping the actor
    // from the keyframe or its track's castId. First placement per entity wins.
    // A position sub-track's castId is authoritative (one track per actor); the keyframe's own
    // `actor` is a denormalised copy that can go stale (copy/paste, migration) → prefer castId.
    const allKfs = posTracks.flatMap((t) => (t.keyframes || []).map((kf) => ({ ...kf, actor: t.castId || kf.actor })));
    for (const kf of allKfs.sort((a, b) => (a.frame | 0) - (b.frame | 0))) {
      const eid = castEnt[kf.actor];
      if (eid && kf.pos && !(eid in posOverride)) posOverride[eid] = kf.pos;
      if (eid && typeof kf.dir === 'number' && !(eid in dirOverride)) dirOverride[eid] = kf.dir;
    }
  }
  let runtimeIdx = 0;
  for (const a of r.actors) {
    if (!a.hasModel) continue;
    const node = new THREE.Group(); node.rotation.order = 'ZYX';
    let pos = posOverride[a.actorId] || a.pos || [0, 0, 0];
    // npc_list pos 0,0,0 = positioned at runtime — fan them near origin, flag approximate.
    if (!posOverride[a.actorId] && (a.runtimePos || (!pos[0] && !pos[1] && !pos[2]))) { pos = [runtimeIdx * 2 - 4, 0, 0]; runtimeIdx++; node.userData.approxPos = true; }
    // ★ Ground marker placements like the GAME does: the client stands cutscene-placed
    // actors on the floor, so a Position marker floating above it (Maat's marker at
    // y 2.899 over a 3.1 floor) rendered the preview actor ~0.2u too HIGH — near-actor
    // parallax made shots look "not lining up" while the background matched perfectly.
    if (posOverride[a.actorId]) pos = _csGroundLocalPos(pos);
    node.position.set(pos[0], pos[1], pos[2]);
    const dirRad = (a.actorId in dirOverride) ? dirOverride[a.actorId]
                 : (typeof a.dir === 'number') ? a.dir
                 : (a.rot ? (a.rot / 256) * Math.PI * 2 : 0);
    node.rotation.y = dirRad - Math.PI;
    node.visible = false;
    node.userData.actorName = a.name;
    csActorGroup.add(node);
    // motionClips (resolved external gesture clips) still come from the retail stash;
    // the gesture TIMELINE is derived from the author tracks below — _seedFromCutscene
    // migrated every decoded retail gesture into those tracks, so they are the single
    // source of truth and sequencer edits play in the preview.
    const _src = _authorState.sourceAnim || null;
    const _ek = String(a.actorId);
    const rec = { actorId: a.actorId, name: a.name, node, loaded: false, dirRad,
                  showFrame: 0, hideFrame: Infinity,
                  animTrack: [], actions: null, idleName: null,
                  preferredIdle: idleByEnt[a.actorId >>> 0] || null,   // author's Default idle
                  castId: castByEnt[a.actorId >>> 0] || null,          // → live routine→clip map
                  curAnim: null, motionClips: (_src && _src.motionClips[_ek]) || {},
                  motion: [], homePos: node.position.clone() };
    csActors.push(rec);
    csLoadActorData(rec, zoneUrl);
  }
  csRebuildAuthorAnimTracks();   // sequencer Anim/Dialog keyframes → per-NPC gesture timelines
  csUpdateActorVisibility();
  // NOTE: deliberately DON'T move the viewport camera when entering Edit — the user
  // keeps whatever view they had. (Old behaviour auto-framed the cast, which yanked
  // the free camera to a far spot. Pilot the sequencer camera to compose shots.)
}

// Snap a zone-local FFXI position onto the zone floor beneath it — the editor twin of
// the client's cutscene-actor grounding. Raycasts the zone meshes straight down from
// just above the point; keeps the authored y when nothing is hit or the delta is large
// (deliberate mid-air placement / ray found a lower storey through a hole).
function _csGroundLocalPos(pos) {
  const zr = _getZoneRoot ? _getZoneRoot() : null;
  if (!zr) return pos;
  try {
    const world = zr.localToWorld(new THREE.Vector3(pos[0], pos[1], pos[2]));
    const origin = world.clone(); origin.y += 1.5;                   // start above head height
    const ray = new THREE.Raycaster(origin, new THREE.Vector3(0, -1, 0), 0, 60);
    // Collect candidate MESHES ourselves: a recursive intersectObjects walks into the
    // marker-pin / VFX-icon Sprites, and Sprite.raycast THROWS without raycaster.camera —
    // the exception aborted the whole cast and the snap silently never happened.
    const meshes = [];
    (function walk(o) {
      if (o === csActorGroup || o.visible === false) return;
      if (o.isMesh) meshes.push(o);
      for (const c of o.children) walk(c);
    })(zr);
    const hit = ray.intersectObjects(meshes, false)[0];
    if (!hit) { console.warn('[cs ground] no floor under marker', pos); return pos; }
    const local = zr.worldToLocal(hit.point.clone());
    if (Math.abs(local.y - pos[1]) > 1.2) {                          // trust only near-floor markers
      console.warn('[cs ground] floor y', +local.y.toFixed(3), 'too far from marker y', pos[1], '— keeping authored');
      return pos;
    }
    if (Math.abs(local.y - pos[1]) > 1e-3) console.log('[cs ground] marker y', pos[1], '→ floor', +local.y.toFixed(3));
    return [pos[0], local.y, pos[2]];
  } catch (e) { console.warn('[cs ground]', e); return pos; }
}

// Aim the free camera at the centroid of the placed (non-origin) cast.
function csFrameCast() {
  const placed = csActors.filter((r) => r.node && !r.node.userData.approxPos);
  if (!placed.length) return;
  const c = new THREE.Vector3(), tmp = new THREE.Vector3();
  for (const r of placed) c.add(r.node.getWorldPosition(tmp));
  c.multiplyScalar(1 / placed.length);
  const radius = 16;
  const back = _camera.getWorldDirection(new THREE.Vector3()).negate();
  _camera.position.copy(c).addScaledVector(back, radius * 2.2);
  _camera.lookAt(c);
  _camera.near = 0.1; _camera.far = Math.max(_camera.far, 5000);
  _camera.updateProjectionMatrix();
  _setStatus?.(`framed ${placed.length} cutscene NPC(s)`);
}

function _csB64ToF32(b64) {
  const bin = atob(b64), buf = new ArrayBuffer(bin.length), u8 = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(buf);
}

function _csB64ToU16(b64) {
  const bin = atob(b64), buf = new ArrayBuffer(bin.length), u8 = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Uint16Array(buf);
}

async function csLoadActorData(rec, zoneUrl) {
  let d;
  try { d = await _bridgeCall('zone.characterData', { actorId: rec.actorId, motionClips: rec.motionClips }); }
  catch (e) { console.warn('[cs actor]', rec.name, e); return; }
  const zoneRoot = _getZoneRoot();
  if (zoneUrl !== _getCurrentZoneUrl() || !csActorGroup || !rec.node.parent) return;
  if (!d || !d.ok) { console.warn('[cs actor]', rec.name, d && d.error); return; }
  try {
    // Build bone hierarchy from skeleton data
    const bones = d.skeleton.map((j) => {
      const b = new THREE.Bone();
      b.name = `bone${String(j.index).padStart(4, '0')}`;
      b.quaternion.set(j.rot[0], j.rot[1], j.rot[2], j.rot[3]);
      b.position.set(j.trans[0], j.trans[1], j.trans[2]);
      return b;
    });
    d.skeleton.forEach((j, i) => { if (j.parent >= 0) bones[j.parent].add(bones[i]); });
    const rootBoneIdx = d.skeleton.findIndex((j) => j.parent < 0);

    // Build skeleton with pre-computed inverse bind matrices from Python
    const ibmData = _csB64ToF32(d.inverseBindMatrices);
    const boneInverses = bones.map((_, i) => new THREE.Matrix4().fromArray(ibmData, i * 16));
    const skeleton = new THREE.Skeleton(bones, boneInverses);

    // Load textures — sRGB color space so colours match the game; flipY=false since UVs are FFXI-origin
    const texLoader = new THREE.TextureLoader();
    const texMap = {};
    for (const [name, uri] of Object.entries(d.textures || {})) {
      const t = texLoader.load(uri);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.flipY = false;
      // Match the zone-mesh path (main.js buildTextures): no mipmaps. Mipmapping a cutout
      // texture averages the transparent background colour into distant mip levels and
      // bloats the alpha-tested silhouette — the same white-halo artifact, at range.
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
      texMap[name] = t;
    }

    // Build SkinnedMeshes — one per material group
    const meshGroup = new THREE.Group();
    for (const m of d.meshes) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(_csB64ToF32(m.positions), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(_csB64ToF32(m.normals), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(_csB64ToF32(m.uvs), 2));
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(_csB64ToU16(m.skinIndices), 4));
      geo.setAttribute('skinWeight', new THREE.BufferAttribute(_csB64ToF32(m.skinWeights), 4));
      const mat = new THREE.MeshBasicMaterial({
        map: texMap[m.material] || null,
        transparent: false,   // solid by default; FFXI alpha was already expanded to full range in Python
        alphaTest: 1 / 255,   // discard texels that are truly zero-alpha (hair fringe, foliage cutouts)
        side: THREE.DoubleSide,
      });
      const sm = new THREE.SkinnedMesh(geo, mat);
      sm.frustumCulled = false;
      sm.bind(skeleton, new THREE.Matrix4());   // identity bind — vertices are in FFXI world/bone space
      meshGroup.add(sm);
    }
    // Root bone must be in the same group as the SkinnedMeshes for matrixWorld to be consistent
    if (rootBoneIdx >= 0) meshGroup.add(bones[rootBoneIdx]);

    // Apply the same root correction + zone transform as the GLB path
    // (ROOT_CORRECTION_ROTATION = 180° X = quaternion [x=1,y=0,z=0,w=0])
    meshGroup.quaternion.set(1, 0, 0, 0);
    // ★ Client render scale — the model DAT's info-section 'scale' byte (percent), which
    // the game applies to every character actor (retail humanoid NPCs ≈95, Byakko 85).
    // Without it the editor rendered every NPC at 1.0 → visibly LARGER than in game
    // ("face off the crosshair while the background lines up perfectly"). Scales about
    // the model origin (ground), so feet stay planted; bones live under meshGroup, so
    // clips + skinning inherit it exactly once (attached bind mode).
    const npcScale = (typeof d.npcScale === 'number' && d.npcScale > 0) ? d.npcScale : 1;
    if (npcScale !== 1) meshGroup.scale.multiplyScalar(npcScale);
    const wrap = new THREE.Group();
    wrap.quaternion.copy(zoneRoot.quaternion);
    wrap.scale.copy(zoneRoot.scale);
    wrap.add(meshGroup);
    rec.node.add(wrap);

    // Build AnimationClips from per-joint sampled tracks
    const animNames = Object.keys(d.animations || {});
    if (animNames.length) {
      const faceTags = new Set(Object.entries(rec.motionClips || {})
        .filter(([, info]) => info && info.layer === 'face').map(([t]) => t));
      const clips = animNames.map((name) => {
        const anim = d.animations[name];
        const times = Float32Array.from({ length: anim.numFrames }, (_, i) => i / anim.fps);
        const tracks = [];
        for (const tr of anim.tracks) {
          const boneName = `bone${String(tr.joint).padStart(4, '0')}`;
          tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, _csB64ToF32(tr.rots)));
          tracks.push(new THREE.VectorKeyframeTrack(`${boneName}.position`, times, _csB64ToF32(tr.trans)));
        }
        return new THREE.AnimationClip(name, anim.numFrames / anim.fps, tracks);
      });
      const mixer = new THREE.AnimationMixer(meshGroup);
      const actions = {};
      for (const clip of clips) {
        if (faceTags.has(clip.name)) {
          THREE.AnimationUtils.makeClipAdditive(clip);
          actions[clip.name] = mixer.clipAction(clip, undefined, THREE.AdditiveAnimationBlendMode);
        } else {
          actions[clip.name] = mixer.clipAction(clip);
        }
      }
      // Prefer the author's Default idle (from the NPCs tab dropdown), resolved the
      // same way keyframe tags are (exact → 3-char motion prefix → alias); else the
      // model's own idle; else the first clip.
      const prefIdle = rec.preferredIdle ? csResolveClip(rec.preferredIdle, actions, null, _csRecTagMap(rec)) : null;
      const idleName = (prefIdle && actions[prefIdle]) ? prefIdle
                     : (d.idle && actions[d.idle]) ? d.idle
                     : clips[0].name;
      rec.mixer = mixer;
      rec.actions = actions;
      rec.idleName = idleName;
      actions[idleName].reset().setEffectiveWeight(1).play();   // base idle layer
      rec.curAnim = idleName;
      rec.curOverlay = null;
    }

    rec.node.rotation.y = (rec.dirRad || 0) - Math.PI;
    rec.loaded = true;
    csUpdateActorVisibility();
    csUpdateActorAnims();
  } catch (e) { console.warn('[cs actor] load', rec.name, e); }
}

// Author-only: the actorId of the trigger/owner NPC to keep hidden while framing, or
// null. Driven by the "Hide Trigger NPC in Level Editor" checkbox (state.hideOwnerInEditor)
// — a pure viewport convenience so the trigger's model doesn't block the shot you compose.
function _ownerActorIdToHide() {
  if (!csAuthorMode || !_authorState || !_authorState.hideOwnerInEditor) return null;
  const owner = (_authorState.cast || []).find((c) => c.id === _authorState.owner);
  if (!owner || !owner.entity || owner.entity === 'player') return null;
  const eid = parseInt(String(owner.entity).replace(/^0x/i, ''), 16) >>> 0;
  return (Number.isFinite(eid) && eid > 0) ? eid : null;
}

function csUpdateActorVisibility() {
  if (!csActors.length) return;
  const f = csFrame;
  const hideOwnerId = _ownerActorIdToHide();
  for (const rec of csActors) {
    let vis = rec.loaded && f >= rec.showFrame && f < rec.hideFrame;
    if (vis && hideOwnerId != null && (rec.actorId >>> 0) === hideOwnerId) vis = false;
    rec.node.visible = vis;
  }
}

// Re-apply staged-actor visibility (e.g. after toggling "Hide Trigger NPC in Level Editor").
// Lighter than csLoadAuthorActors — no bridge round-trip, just flips node.visible.
export function csRefreshActorVisibility() { csUpdateActorVisibility(); }

// Resolve an event animation TAG (ids0, fg00, dead…) to one of the GLB's embedded clip names.
// `tagMap` (optional) maps ROUTINE tags → the clip they drive (ati0 → at00): the author
// dropdowns now hold the model's schedulable 0x07 routines, whose names don't prefix-match
// their clips — the map (state.animTagClips, built from the anim cache) bridges that.
const CS_ANIM_ALIASES = { ids0: 'idl0', idls: 'idl0', idl: 'idl0', stnd: 'idl0', mov0: 'wlk0', walk: 'wlk0', run: 'run0', dead: 'ded0', ded: 'ded0' };
function csResolveClip(tag, actions, idleName, tagMap) {
  if (!tag) return idleName;
  if (tagMap && tagMap[tag] && actions[tagMap[tag]]) return tagMap[tag];
  if (actions[tag]) return tag;
  const norm = tag.replace(/[0-9]+$/, '');
  for (const n of Object.keys(actions)) if (n.replace(/[0-9]+$/, '') === norm) return n;
  const alias = CS_ANIM_ALIASES[tag.toLowerCase()];
  if (alias && actions[alias]) return alias;
  return idleName;   // unresolved → stay idle
}

// The live routine→clip map for a staged author actor (null on retail-playback actors —
// their motionClips already name embedded clips by tag).
function _csRecTagMap(rec) {
  return (rec && rec.castId && _authorState && _authorState.animTagClips)
    ? _authorState.animTagClips[rec.castId] || null : null;
}

// Per playhead frame: move each NPC along its active 0x27 FollowPoints spline.
function csUpdateActorMotion() {
  if (!csActors.length) return;
  const f = csFrame;
  for (const rec of csActors) {
    if (!rec.motion || !rec.motion.length || !rec.node) continue;
    let active = null;
    for (const m of rec.motion) if (m.points && m.points.length > 1 && f >= m.frame && f < m.frame + (m.duration || 1)) active = m;
    if (!active) { if (rec._moving) { rec.node.position.copy(rec.homePos); rec._moving = false; } continue; }
    if (!active._curve) {
      let pts = active.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
      if (active.reversed) pts.reverse();
      try { active._curve = new THREE.CatmullRomCurve3(pts); } catch (e) { active._curve = null; continue; }
    }
    const t = Math.min(1, Math.max(0, (f - active.frame) / Math.max(1, active.duration || 1)));
    try { rec.node.position.copy(active._curve.getPoint(t)); rec._moving = true; } catch (e) {}
  }
}

// Loop mode for an AnimationAction from a gesture's maxLoops.
function csApplyLoop(action, loops) {
  const finite = typeof loops === 'number' && loops >= 1;
  action.setLoop(THREE.LoopRepeat, finite ? loops : Infinity);
  action.clampWhenFinished = finite;
}

// Per playhead frame: drive each NPC on TWO tracks — body motion (base) and facial
// expression (additive, layered on top).
function csUpdateActorAnims() {
  if (!csActors.length) return;
  const f = csFrame;
  for (const rec of csActors) {
    if (!rec.mixer || !rec.actions) continue;
    let bodyTag = null, faceTag = null;
    for (const e of rec.animTrack) {
      if (e.frame > f) break;
      const layer = (rec.motionClips && rec.motionClips[e.tag]) ? rec.motionClips[e.tag].layer : 'body';
      if (layer === 'face') faceTag = e.tag; else bodyTag = e.tag;
    }
    // Velocity-derived locomotion (cutscene mode, per UE5 FFXIEngine docs).
    let moveSpeed = 0;
    if (rec._lastAnimPos) {
      const df = Math.abs(f - (rec._lastAnimFrame ?? f));
      if (df > 0 && df < 60) moveSpeed = rec.node.position.distanceTo(rec._lastAnimPos) / df;
    }
    rec._lastAnimPos = rec.node.position.clone(); rec._lastAnimFrame = f;
    let want;
    if (bodyTag) want = csResolveClip(bodyTag, rec.actions, rec.idleName, _csRecTagMap(rec));
    else if (moveSpeed > 0.30 && rec.actions.run0) want = 'run0';
    else if (moveSpeed > 0.05 && rec.actions.wlk0) want = 'wlk0';
    else want = rec.idleName;
    // ★ Layered playback (matches the client): the idle ALWAYS runs as a low base layer;
    // a body motion plays ON TOP at a dominant weight. FFXI mob motions are partial —
    // at0/ma0 drive only ~half the joints — so crossfading the idle to zero (the old
    // behaviour) froze the rest and looked like "nothing happens". With the idle kept
    // alive, its joints keep posing while the overlay drives the ones it owns.
    if (rec.idleName && rec.actions[rec.idleName]) {
      const idleAct = rec.actions[rec.idleName];
      if (!idleAct.isRunning()) { idleAct.reset().setEffectiveWeight(1).play(); }
    }
    const overlay = (want && want !== rec.idleName && rec.actions[want]) ? want : null;
    if (overlay !== rec.curOverlay) {
      if (rec.curOverlay && rec.actions[rec.curOverlay]) rec.actions[rec.curOverlay].fadeOut(0.2);
      if (overlay) {
        const ov = rec.actions[overlay];
        csApplyLoop(ov, (bodyTag && rec.motionClips && rec.motionClips[bodyTag]) ? rec.motionClips[bodyTag].loops : null);
        ov.reset().setEffectiveWeight(8).fadeIn(0.2).play();   // 8 ≫ idle(1) → dominates shared joints
      }
      rec.curOverlay = overlay;
      rec.curAnim = overlay || rec.idleName;
    }
    // Facial track (additive overlay).
    if (faceTag !== rec.curFace) {
      if (rec.curFace && rec.actions[rec.curFace]) rec.actions[rec.curFace].fadeOut(0.2);
      if (faceTag && rec.actions[faceTag]) {
        const fa = rec.actions[faceTag];
        csApplyLoop(fa, (rec.motionClips[faceTag] || {}).loops);
        fa.reset().setEffectiveWeight(1).fadeIn(0.2).play();
      }
      rec.curFace = faceTag;
    }
  }
}

// Author mode: derive each staged NPC's gesture timeline from the CURRENT author
// tracks — Anim sub-track keyframes plus per-line Dialog gestures (kf.anim). This is
// what makes sequencer animation keyframes actually PLAY in the 3D preview. Retail
// cutscenes migrated their decoded gestures into these same tracks on load, so the
// tracks are the only timeline source (sourceAnim just supplies motionClips).
function csRebuildAuthorAnimTracks() {
  if (!csAuthorMode || !_authorState || !csActors.length) return;
  const entOf = {};
  for (const c of _authorState.cast || []) {
    if (c.entity && c.entity !== 'player') entOf[c.id] = parseInt(String(c.entity).replace(/^0x/i, ''), 16) >>> 0;
  }
  const byEnt = new Map();
  const push = (castId, kf, tag) => {
    const eid = entOf[castId];
    if (!eid || !tag) return;
    if (!byEnt.has(eid)) byEnt.set(eid, []);
    byEnt.get(eid).push({ frame: kf.frame | 0, tag });
  };
  for (const t of _authorState.tracks || []) {
    if (t.kind === 'anim') { for (const kf of t.keyframes || []) push(t.castId || kf.actor, kf, kf.anim); }
    else if (t.kind === 'dialog') { for (const kf of t.keyframes || []) push(t.castId || kf.speaker, kf, kf.anim); }
  }
  for (const rec of csActors) {
    rec.animTrack = (byEnt.get(rec.actorId >>> 0) || []).sort((a, b) => a.frame - b.frame);
  }
  csUpdateActorAnims();
}

// Swap a staged NPC's BASE idle live (NPCs-tab "Default idle" change) — no respawn.
export function csSetActorIdle(entityHex, tag) {
  if (!entityHex || entityHex === 'player' || !tag) return;
  const eid = parseInt(String(entityHex).replace(/^0x/i, ''), 16) >>> 0;
  const rec = csActors.find((r) => (r.actorId >>> 0) === eid);
  if (!rec) return;
  rec.preferredIdle = tag;              // applies on load if the model is still fetching
  if (!rec.actions) return;
  const clip = csResolveClip(tag, rec.actions, rec.idleName, _csRecTagMap(rec));
  if (!clip || !rec.actions[clip] || clip === rec.idleName) return;
  const old = rec.idleName;
  if (old && rec.actions[old]) rec.actions[old].fadeOut(0.25);
  rec.idleName = clip;
  rec.actions[clip].reset().setEffectiveWeight(1).fadeIn(0.25).play();
  if (!rec.curOverlay) rec.curAnim = clip;
}

// Play a just-picked keyframe animation on its actor IMMEDIATELY (audition) — the Anim
// dropdown must never feel dead while the playhead sits before the keyframe. The next
// playhead move reconciles back to whatever the timeline says.
function csAuditionAnim(castId, tag) {
  if (!_authorState || !tag) return;
  const c = (_authorState.cast || []).find((x) => x.id === castId);
  if (!c || !c.entity || c.entity === 'player') return;
  const eid = parseInt(String(c.entity).replace(/^0x/i, ''), 16) >>> 0;
  const rec = csActors.find((r) => (r.actorId >>> 0) === eid);
  if (!rec || !rec.actions) return;
  if (tag === '@idle') {   // "return to idle" (IDLE_STOP in cutscene-author.js): drop the overlay
    if (rec.curOverlay && rec.actions[rec.curOverlay]) rec.actions[rec.curOverlay].fadeOut(0.2);
    rec.curOverlay = null; rec.curAnim = rec.idleName;
    return;
  }
  const clip = csResolveClip(tag, rec.actions, rec.idleName, _csRecTagMap(rec));
  if (!clip || clip === rec.idleName || !rec.actions[clip]) return;
  if (rec.curOverlay && rec.curOverlay !== clip && rec.actions[rec.curOverlay]) rec.actions[rec.curOverlay].fadeOut(0.2);
  const ov = rec.actions[clip];
  csApplyLoop(ov, (rec.motionClips && rec.motionClips[tag]) ? rec.motionClips[tag].loops : null);
  ov.reset().setEffectiveWeight(8).fadeIn(0.2).play();   // 8 ≫ idle(1) → dominates shared joints
  rec.curOverlay = clip; rec.curAnim = clip;
}

// ── Cutscene VFX ──────────────────────────────────────────────────────────────
let csVfxSystem = null;          // ParticleSystem
const csVfxRes = new Map();      // res file id → parseAllEffects()
let csVfxBeats = [];             // [{frame, dur, vfx:[ids], res, actors}]
const csVfxLive = new Map();     // beat index → [live ParticleEmitter]

function csClearVfx() {
  if (csVfxSystem) { try { csVfxSystem.clear(); } catch (e) {} }
  csVfxSystem = null;
  csVfxRes.clear();
  csVfxBeats = [];
  csVfxLive.clear();
}

async function csLoadVfx(key) {
  csClearVfx();
  if (!_bridgeOnline() || !csData) return;
  // (1) generators a shot/task routine explicitly references (b.vfx).
  csVfxBeats = (csData.beats || [])
    .filter((b) => b.vfx && b.vfx.length && b.res)
    .map((b) => ({ frame: b.frame, dur: b.dur || 60, vfx: b.vfx, res: b.res, actors: b.actors }));
  // (2) EVERY scene resource the cutscene loads can also hold AUTO-RUN 0x05 generators.
  const resWindows = new Map();
  for (const b of (csData.beats || [])) {
    if (!b.res) continue;
    const w = resWindows.get(b.res) || [Infinity, 0];
    w[0] = Math.min(w[0], b.frame); w[1] = Math.max(w[1], b.frame + (b.dur || 60));
    resWindows.set(b.res, w);
  }
  const allRes = [...new Set([...csVfxBeats.map((b) => b.res), ...resWindows.keys()])];
  if (!allRes.length) return;
  csVfxSystem = new ParticleSystem(_scene, _camera);
  const zoneUrl = _getCurrentZoneUrl();
  const castNames = [...new Set((csData.beats || []).filter((b) => b.type === 'npc' && b.actor).map((b) => b.actor))];
  let autoCount = 0;
  for (const res of allRes) {
    try {
      const r = await _bridgeCall('zone.sceneResource', { res });
      if (zoneUrl !== _getCurrentZoneUrl() || !csVfxSystem) return;   // closed / zone changed
      if (!r || !r.ok || !r.bytesBase64) continue;
      const bin = atob(r.bytesBase64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const eff = parseAllEffects(u.buffer);
      csVfxRes.set(res, eff);
      const gens = (eff.generators || []).map((g) => g.id);
      if (gens.length) {
        const w = resWindows.get(res) || [0, csData.totalFrames || 1];
        csVfxBeats.push({ frame: w[0] || 0, dur: Math.max(60, w[1] - (w[0] || 0)), vfx: gens, res, actors: castNames, autoRun: true });
        autoCount += gens.length;
      }
    } catch (e) { console.warn('[cs vfx] resource', res, e); }
  }
  console.info(`[cs vfx] ${csVfxBeats.length} vfx beat(s) (${autoCount} auto-run generators across ${allRes.length} scene resources)`);
  csUpdateVfx();
}

function _csActorWorldPos(labels) {
  if (!labels || !labels.length) return null;
  const rec = csActors.find((r) => labels.includes(r.name));
  return rec ? rec.node.getWorldPosition(new THREE.Vector3()) : null;
}
// Returns the actor's position in zoneRoot-local (= FFXI world) space.
function _csActorLocalPos(labels) {
  if (!labels || !labels.length) return null;
  const rec = csActors.find((r) => labels.includes(r.name));
  return rec ? rec.node.position.clone() : null;
}

// Spawn/stop the generators of each vfx beat as the playhead enters/leaves its window.
function csUpdateVfx() {
  const zoneRoot = _getZoneRoot();
  if (!csVfxSystem || !csVfxBeats.length || !zoneRoot) return;
  const f = csFrame;
  const cam = cutsceneCamActive ? csCamera : _camera;   // billboards face whichever camera is live
  csVfxSystem.camera = cam;
  for (const ems of csVfxLive.values()) for (const em of ems) em._camera = cam;
  csVfxBeats.forEach((b, i) => {
    const active = f >= b.frame && f < b.frame + (b.dur || 60);
    const live = csVfxLive.has(i);
    if (active && !live) {
      const eff = csVfxRes.get(b.res);
      if (!eff) { csVfxLive.set(i, []); return; }
      const localPos = _csActorLocalPos(b.actors);
      const ems = [];
      for (const id of b.vfx) {
        const gen = (eff.generators || []).find((g) => g.id === id);
        if (!gen) continue;
        try {
          const em = new ParticleEmitter(gen, eff, _scene, csVfxSystem.camera, zoneRoot);
          if (localPos) em.meshGroup.position.copy(localPos);
          csVfxSystem.emitters.push(em);
          ems.push(em);
        } catch (e) { console.warn('[cs vfx] emit', id, e); }
      }
      csVfxLive.set(i, ems);
    } else if (!active && live) {
      for (const em of csVfxLive.get(i)) {
        const ix = csVfxSystem.emitters.indexOf(em);
        if (ix >= 0) csVfxSystem.emitters.splice(ix, 1);
        try { em.dispose(); } catch (e) {}
      }
      csVfxLive.delete(i);
    }
  });
}

// ── Sequencer DOM ─────────────────────────────────────────────────────────────
function csBuildSequencer() {
  if (!csSeqEl || !csData) return;
  const fps = csData.fps || 30, total = Math.max(1, csData.totalFrames || 1);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('cs-seq-title', csTitle);
  set('cs-seq-fps', fps);
  const camBtn = document.getElementById('cs-seq-cam');
  if (camBtn) {
    // Author mode: lit only while actually piloting. Playback: lit when auto-drive is on.
    camBtn.classList.toggle('active', csAuthorMode ? csCameraPiloting : csCamEnabled);
    camBtn.title = 'Toggle Sequencer Camera';
    // In author mode ALWAYS toggleable — you need to enter the camera to place the FIRST keyframe,
    // and you must be able to exit even after deleting them all. Playback needs shots to drive.
    camBtn.disabled = csAuthorMode ? false : !((csData.cameraShots || 0) > 0);
  }
  document.getElementById('cs-seq-hideui')?.classList.toggle('active', csHideUi);
  document.getElementById('cs-seq-ratio')?.classList.toggle('active', csFixedRatio);
  document.getElementById('cs-seq-crosshair')?.classList.toggle('active', csCrosshair);
  // Show / hide the edit toolbar depending on author mode.
  _renderAuthorToolbar();

  let labelHtml, trackHtml;
  if (csAuthorMode && _authorState) {
    // AUTHOR MODE — one lane PER TRACK (including empty tracks, so you can add
    // keyframes to a fresh track). Standard sequencer behavior.
    ({ labelHtml, trackHtml } = _buildAuthorLanes(total, fps));
  } else {
    // LOAD MODE — lanes derived from the decoded beats (retail cutscene view).
    const lanes = CS_LANE_ORDER.filter((l) => csData.beats.some((b) => csLaneOf(b.type) === l));
    const hasCamShots = csData.beats.some((b) => b.camera && b.camera.length);
    const curveLane = hasCamShots ? (['camera', 'shot', 'task'].find((l) => lanes.includes(l)) || null) : null;
    const showCurves = csCurvesOpen && !!curveLane;
    labelHtml = []; trackHtml = [];
    for (const l of lanes) {
      const click = l === curveLane ? ' clickable' : '';
      const tip = l === curveLane ? ' title="Show / hide the shot X·Y·Z camera curves"' : '';
      labelHtml.push(`<div class="cs-seq-lane-label${click}" data-lane="${l}"${tip}>${_evtEsc(CS_LANE_LABEL[l] || l)}</div>`);
      const cells = csData.beats.map((b, bi) => ({ b, bi }))
        .filter(({ b }) => csLaneOf(b.type) === l).map(({ b, bi }) => {
        const x = (b.frame / total) * 100, span = csBeatSpan(b);
        const [lab, color] = CS_BEAT_META[b.type] || [b.type, '#888'];
        const det = csBeatDetail(b, fps);
        const tip2 = _evtEsc(`${lab} @ ${(b.frame / fps).toFixed(1)}s${det ? ' — ' + det : ''}`);
        const bar = span > 0 ? `<span class="cs-seq-span" style="--cc:${color};left:${x}%;width:${Math.max(0.4, (span / total) * 100)}%"></span>` : '';
        return bar + `<span class="cs-seq-dot" data-frame="${b.frame}" data-span="${span}" data-beat-idx="${bi}" style="--cc:${color};left:${x}%" title="${tip2}"></span>`;
      }).join('');
      trackHtml.push(`<div class="cs-seq-lane-track">${cells}</div>`);
      if (showCurves && l === curveLane) {
        labelHtml.push(csCurveLabelHtml()); trackHtml.push(csCurvesSvg());
        labelHtml.push(csFovLabelHtml()); trackHtml.push(csFovSvg());
      }
    }
  }
  const graph = document.getElementById('cs-seq-graph');
  if (graph) {
    // Preserve the scroll position across the rebuild (adding/moving a keyframe while zoomed in
    // recreates #cs-seq-scrollx, which would otherwise snap back to the start).
    const _oldSx = document.getElementById('cs-seq-scrollx');
    const _prevLeft = _oldSx ? _oldSx.scrollLeft : 0;
    const _prevTop = _oldSx ? _oldSx.scrollTop : 0;
    // Bookend gutters: fixed-width columns OUTSIDE the 0..total frame domain — the
    // cinematic prologue (fade to black + 2s hold before frame 0) and epilogue (fade
    // to black + 2s hold after the last frame). Purely visual: keyframes can't land
    // there and every frame↔x mapping stays scoped to #cs-seq-body.
    const bkTitleL = 'Trigger fade-out — before frame 0: the screen fades to black and holds ~2.0s while actors are placed. Frame 0 starts already black.';
    const bkTitleR = 'Cutscene fade-out — after the last frame: fade to black, ~2.0s hold, camera released, fade back to gameplay.';
    graph.innerHTML =
      `<div class="cs-seq-labels"><div class="cs-seq-ruler-spacer"></div>${labelHtml.join('')}</div>`
      + `<div id="cs-seq-scrollx" class="cs-seq-scrollx">`
      // Inner flex ROW sizes to CONTENT (min-height:min-content) — so align-items:stretch
      // resolves the bookend gutters against the tall body height, not the clipped scroll
      // viewport. Its width carries the zoom so the body (flex:1) fills between the gutters.
      +   `<div class="cs-seq-scrollrow" style="width:${csZoom * 100}%">`
      +     `<div class="cs-seq-bookend-col cs-seq-bookend-col-l" title="${bkTitleL}">`
      +       `<span class="cs-seq-bookend-time">−2.0s</span><span class="cs-seq-bookend-tag">FADE<br>OUT</span>`
      +     `</div>`
      +     `<div id="cs-seq-body" class="cs-seq-body">`
      +       `<div class="cs-seq-ruler">${csRulerTicks(total, fps)}</div>`
      +       trackHtml.join('')
      +       `<div id="cs-seq-playhead" class="cs-seq-playhead"></div>`
      +     `</div>`
      +     `<div class="cs-seq-bookend-col cs-seq-bookend-col-r" title="${bkTitleR}">`
      +       `<span class="cs-seq-bookend-time">+2.0s</span><span class="cs-seq-bookend-tag">FADE<br>OUT</span>`
      +     `</div>`
      +   `</div>`
      + `</div>`;
    csDots = [...graph.querySelectorAll('.cs-seq-dot')].map((el) => ({ el, frame: Number(el.dataset.frame), span: Number(el.dataset.span) || 0 }));
    // The tracks column owns both scrollbars now — keep the labels column vertically in sync.
    const _sx = document.getElementById('cs-seq-scrollx');
    const _lbl = graph.querySelector('.cs-seq-labels');
    if (_sx) { _sx.scrollLeft = _prevLeft; _sx.scrollTop = _prevTop; }   // restore scroll after rebuild
    if (_lbl) _lbl.scrollTop = _prevTop;
    if (_sx && _lbl) _sx.addEventListener('scroll', () => { _lbl.scrollTop = _sx.scrollTop; });
    if (csAuthorMode && _authorMultiSel.size) _applyMultiSelHighlight();   // re-mark selected dots after rebuild
  }
}

// Evenly spaced time ticks (~8 across the track), snapped to a "nice" second interval.
function csRulerTicks(total, fps) {
  const dur = total / fps, steps = [0.5, 1, 2, 5, 10, 15, 30, 60];
  // Density is constant in SCREEN space: the body is csZoom× wide, so the visible window shows
  // dur/csZoom seconds → aim for ~8 ticks across it. Zooming in shrinks the step (30s→15s→5s…).
  const step = steps.find((s) => s >= dur / (8 * Math.max(1, csZoom))) || 60;
  let html = '';
  for (let t = 0; t <= dur + 1e-3; t += step) {
    const x = (t * fps / total) * 100;
    html += `<span class="cs-seq-tick" style="left:${x}%"><i></i><span>${t.toFixed(t < 10 ? 1 : 0)}s</span></span>`;
  }
  return html;
}

// Build one sequencer lane PER author track (empty tracks render an empty lane
// so you can drop keyframes into them). Returns {labelHtml, trackHtml} arrays.
function _buildAuthorLanes(total, fps) {
  const st = _authorState;
  const labelHtml = [], trackHtml = [];
  const castName = (id) => {
    const c = st.cast.find((x) => x.id === id);
    return c ? (c.name || c.id) : id;
  };
  const cellsFor = (track, ti, meta, isCam) => (track.keyframes || []).map((kf, ki) => {
    const x = (kf.frame / total) * 100;
    const span = Number(kf.dur) || Number(kf.frames) || 0;
    const bar = span > 0
      ? `<span class="cs-seq-span" style="--cc:${meta.color};left:${x}%;width:${Math.max(0.4, (span / total) * 100)}%"></span>` : '';
    // Actor Show/Hide keyframes get a distinct shape (white ▲ show / ▽ hide); a Position CUT
    // keyframe (new shot) renders as a diamond so shot boundaries are visible at a glance.
    const sh = kf.action === 'show' ? ' cs-kf-show' : kf.action === 'hide' ? ' cs-kf-hide'
      : (track.kind === 'campos' && (kf.camKind || 'still') === 'still') ? ' cs-kf-cut' : '';
    // Joined camera segment: a Move keyframe interpolates FROM the previous keyframe —
    // draw a connector line between the two dots so the motion reads at a glance even
    // with the channel curves collapsed. A Cut starts a new shot: no line.
    let join = '';
    if (track.kind === 'campos' && ki > 0 && (kf.camKind || 'still') !== 'still') {
      const prevFrame = track.keyframes[ki - 1].frame;
      const frameDelta = kf.frame - prevFrame;
      const timeDelta = (frameDelta / fps).toFixed(1);
      const px = (prevFrame / total) * 100;
      join = `<span class="cs-seq-join" data-frames="${frameDelta}" data-time="${timeDelta}" style="--cc:${meta.color};left:${px}%;width:${Math.max(0, x - px)}%"></span>`;
    }
    const tip = _evtEsc(`${kf.action === 'show' ? 'Show · ' : kf.action === 'hide' ? 'Hide · ' : ''}${track.kind === 'campos' && kf.camKind ? (kf.camKind === 'still' ? 'Cut · ' : 'Move · ') : ''}${meta.label} @ ${(kf.frame / fps).toFixed(1)}s`);
    return join + bar + `<span class="cs-seq-dot${sh}" data-frame="${kf.frame}" data-span="${span}" data-author-ti="${ti}" data-author-ki="${ki}" style="--cc:${meta.color};left:${x}%" title="${tip}"></span>`;
  }).join('');
  // Render one lane. opts.group = an Actor header (collapse chevron + show/hide dots);
  // opts.indent = a sub-track under a group. Camera header toggles its X/Y/Z curves.
  const renderTrack = (track, ti, opts = {}) => {
    const meta = AUTHOR_TRACK_KINDS[track.kind] || { label: track.kind, color: '#888' };
    const isCam = CAMERA_SUB_KINDS.includes(track.kind);   // each camera sub-track expands to its own curve
    const isGroup = !!opts.group;
    const label = isGroup ? (track.kind === 'camera' ? 'Camera' : `Actor · ${castName(track.castId)}`) : meta.label;
    const lockTip = meta.mandatory ? 'Mandatory — every cutscene has exactly one Camera group (Position / Rotation / Zoom)'
      : track.kind === 'wait' ? 'Every cutscene keeps a Wait track for pacing — right-click to add Wait keyframes'
      : 'The Player is always available — right-click to add its Position / Face / etc.';
    const delBtn = (meta.mandatory || track.locked || CAMERA_SUB_KINDS.includes(track.kind))
      ? `<span class="material-symbols-outlined" title="${lockTip}" style="font-size:12px;opacity:.5;">lock</span>`
      : `<button class="cs-auth-del-track" data-ti="${ti}" title="${isGroup ? 'Remove this actor and all its tracks' : 'Remove track'}" style="background:none;border:none;color:#7e8698;cursor:pointer;padding:0 2px;font-size:13px;line-height:1;">×</button>`;
    const chevron = isCam
      ? `<span class="material-symbols-outlined" style="font-size:13px;opacity:.6;">${csCurveOpen[track.kind] ? 'expand_less' : 'expand_more'}</span>`
      : isGroup
      ? `<span class="material-symbols-outlined" style="font-size:16px;opacity:.8;flex-shrink:0;">${track.collapsed ? 'chevron_right' : 'expand_more'}</span>`
      : `<span class="material-symbols-outlined" style="font-size:14px;color:${meta.color};flex-shrink:0;">${opts.indent ? 'subdirectory_arrow_right' : 'adjust'}</span>`;
    const cls = 'cs-seq-lane-label cs-auth-lane-label'
      + (isCam ? ' clickable cs-cam-lane-label' : '')
      + (isGroup ? ' clickable cs-actor-group-label' : '')
      + (opts.indent ? ' cs-sub-lane-label' : '');
    labelHtml.push(
      `<div class="${cls}" data-hi-ti="${ti}"${isGroup ? ` data-group-ti="${ti}"` : ''} style="display:flex; align-items:center; gap:5px;${opts.indent ? 'padding-left:18px;' : ''}" title="${isGroup ? 'Click to collapse / expand · right-click to add Face / Dialog / Position / Anim' : (isCam ? 'Click to show / hide this channel\'s curve' : _evtEsc(label))}">
         ${chevron}
         <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;${isGroup ? 'font-weight:600;color:#cdd2e0;' : ''}">${_evtEsc(label)}</span>
         ${isGroup ? `<span class="material-symbols-outlined" style="font-size:13px;color:${meta.color};flex-shrink:0;opacity:.8;">group</span>` : ''}${delBtn}
       </div>`);
    trackHtml.push(`<div class="cs-seq-lane-track cs-auth-lane${opts.indent ? ' cs-sub-lane' : ''}" data-ti="${ti}">${cellsFor(track, ti, meta, isCam)}</div>`);
    if (isCam && csCurveOpen[track.kind]) _pushChannelCurve(track.kind, total, labelHtml, trackHtml);
  };

  // 1. Camera GROUP first (top) with its Position / Rotation / Zoom sub-tracks.
  const camIdx = st.tracks.findIndex((t) => t.kind === 'camera');
  if (camIdx >= 0) {
    renderTrack(st.tracks[camIdx], camIdx, { group: true });
    if (!st.tracks[camIdx].collapsed) {
      st.tracks.forEach((sub, sti) => {
        if (CAMERA_SUB_KINDS.includes(sub.kind)) renderTrack(sub, sti, { indent: true });
      });
    }
  }

  // (The cinematic bookends — fade-out before frame 0, fade-out after the last frame —
  // render as dedicated gutter COLUMNS flanking the timeline body; see the graph build.)

  // 3. Actor groups (header + indented sub-tracks when expanded), then flat tracks.
  st.tracks.forEach((track, ti) => {
    if (ti === camIdx) return;
    if (track.kind === 'actor') {
      renderTrack(track, ti, { group: true });
      if (!track.collapsed) {
        st.tracks.forEach((sub, sti) => {
          if (sub.castId === track.castId && ACTOR_SUB_KINDS.includes(sub.kind)) renderTrack(sub, sti, { indent: true });
        });
      }
    } else if ((ACTOR_SUB_KINDS.includes(track.kind) && track.castId) || CAMERA_SUB_KINDS.includes(track.kind)) {
      // sub-track — already drawn under its Actor / Camera group above; skip
    } else {
      renderTrack(track, ti);   // flat: wait / fade / music / sfx / vfx
    }
  });
  if (!st.tracks.length) {
    labelHtml.push(`<div class="cs-seq-lane-label" style="opacity:.5;">(no tracks)</div>`);
    trackHtml.push(`<div class="cs-seq-lane-track" style="opacity:.4; font-size:10px; padding-left:8px; align-items:center; display:flex;">Add a track from the toolbar, or right-click here</div>`);
  }
  return { labelHtml, trackHtml };
}

// ── Camera 3-track model (Position / Rotation / Zoom) ───────────────────────
// Decompose a shot's route (control points w/ eye+look+fov+roll+time) into three INDEPENDENT
// channels, dropping keyframes that are redundant under linear interpolation (a constant channel
// collapses to ONE keyframe — e.g. a held look-at). Proven lossless vs recompose across retail
// routes. `fov` stays a focal length here; the importer converts it to degrees for the Zoom track.
export function csDecomposeRoute(route) {
  const approx = (a, b, e = 0.05) => Math.abs(a - b) <= e;
  const veq = (a, b) => approx(a[0], b[0]) && approx(a[1], b[1]) && approx(a[2], b[2]);
  const dedup = (arr, valOf, eq) => {
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const v = valOf(arr[i]);
      const prev = out.length ? valOf(out[out.length - 1]) : null;
      const nxt = i + 1 < arr.length ? valOf(arr[i + 1]) : null;
      const sp = prev != null && eq(v, prev), sn = nxt != null && eq(v, nxt);
      if (i === 0 || !sp || (nxt != null && !sn)) out.push(arr[i]);
    }
    return out;
  };
  return {
    pos:  dedup(route.map((k) => ({ t: k.time, eye: k.eye })),                     (x) => x.eye,  veq),
    rot:  dedup(route.map((k) => ({ t: k.time, look: k.look || k.eye, roll: k.roll || 0 })), (x) => x.look, veq),
    zoom: dedup(route.map((k) => ({ t: k.time, fov: k.fov })),                     (x) => x.fov,  (a, b) => approx(a, b, 0.5)),
  };
}

// Linear-sample a sorted channel [{frame, <key>}] at `frame`, holding past the ends. Vec or scalar.
function _csChannelSample(kfs, frame, key, isVec) {
  if (!kfs.length) return isVec ? [0, 0, 0] : 0;
  if (frame <= kfs[0].frame) return kfs[0][key];
  const last = kfs[kfs.length - 1];
  if (frame >= last.frame) return last[key];
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (frame >= a.frame && frame <= b.frame) {
      const u = (frame - a.frame) / ((b.frame - a.frame) || 1);
      if (isVec) return [a[key][0] + (b[key][0] - a[key][0]) * u, a[key][1] + (b[key][1] - a[key][1]) * u, a[key][2] + (b[key][2] - a[key][2]) * u];
      return a[key] + (b[key] - a[key]) * u;
    }
  }
  return last[key];
}

// The Position / Rotation / Zoom sub-tracks → camera SHOTS (recompose). Cuts (shot boundaries)
// come from Position keyframes flagged camKind 'still'. Within each shot the three channels are
// sampled at the union of their keyframe frames → control points {eye,look,fov(focal),roll,time},
// which csSampleShot then interpolates/splines exactly as before. This is the same union-recompose
// the compiler uses, so preview == published (WYSIWYG) and imported routes round-trip byte-faithful.
function _authorCameraShots() {
  const st = _authorState;
  if (!st) return [];
  const byFrame = (a, b) => (a.frame | 0) - (b.frame | 0);
  const pos  = (((st.tracks.find((t) => t.kind === 'campos')  || {}).keyframes) || []).slice().sort(byFrame);
  if (!pos.length) return [];
  const rot  = (((st.tracks.find((t) => t.kind === 'camrot')  || {}).keyframes) || []).slice().sort(byFrame);
  const zoom = (((st.tracks.find((t) => t.kind === 'camzoom') || {}).keyframes) || []).slice().sort(byFrame);

  const cuts = [];
  pos.forEach((k, i) => { if (i === 0 || (k.camKind || 'still') === 'still') cuts.push(i); });
  const shots = [];
  for (let c = 0; c < cuts.length; c++) {
    const iEnd = (c + 1 < cuts.length) ? cuts[c + 1] : pos.length;
    const shotPos = pos.slice(cuts[c], iEnd);
    const startFrame = shotPos[0].frame | 0;
    const nextCut = (c + 1 < cuts.length) ? (pos[cuts[c + 1]].frame | 0) : Infinity;
    const inShot = (k) => (k.frame | 0) >= startFrame && (k.frame | 0) < nextCut;
    // Each channel needs at least one anchor in the shot; if none, hold the last known value.
    const shotRot  = rot.filter(inShot);
    const shotZoom = zoom.filter(inShot);
    const rotKfs  = shotRot.length  ? shotRot  : [{ frame: startFrame, look: _csChannelSample(rot, startFrame, 'look', true), roll: _csChannelSample(rot, startFrame, 'roll', false) }];
    const zoomKfs = shotZoom.length ? shotZoom : [{ frame: startFrame, fov: _csChannelSample(zoom, startFrame, 'fov', false) || 57 }];
    const frames = [...new Set([...shotPos, ...rotKfs, ...zoomKfs].map((k) => k.frame | 0))].sort((a, b) => a - b);
    const dur = Math.max(1, frames[frames.length - 1] - startFrame);
    const camera = frames.map((f) => ({
      eye:  _csChannelSample(shotPos, f, 'eye', true),
      look: _csChannelSample(rotKfs, f, 'look', true),
      fov:  _csFovToFocal(_csChannelSample(zoomKfs, f, 'fov', false)),   // Zoom track is degrees → focal
      roll: _csChannelSample(rotKfs, f, 'roll', false),
      time: (f - startFrame) / dur,
    }));
    shots.push({ type: 'camera', frame: startFrame, dur, camera, smooth: (shotPos[0].smooth != null ? shotPos[0].smooth | 0 : 4) });
  }
  return shots;
}

// Recompose the Position / Rotation / Zoom sub-tracks → the legacy single-track camera keyframe
// shape {frame, camKind, eye, look, fov(degrees), roll, smooth} the compiler still consumes. Uses
// the SAME _authorCameraShots as the preview, so PUBLISHED == PREVIEWED. (Phase 3 will teach the
// backend to read the three tracks directly and drop this bridge.)
export function csCameraCompileKeyframes() {
  const out = [];
  for (const shot of _authorCameraShots()) {
    const n = shot.camera.length;
    shot.camera.forEach((cp, i) => out.push({
      frame: (shot.frame + Math.round(cp.time * shot.dur)) | 0,
      camKind: (i === 0) ? 'still' : (n >= 3 ? 'curved' : 'spline'),
      eye: cp.eye.map((v) => +v.toFixed(3)),
      look: cp.look.map((v) => +v.toFixed(3)),
      fov: Math.round(_csFocalToFov(cp.fov)),          // focal → degrees (compiler converts back)
      ...(cp.roll ? { roll: +cp.roll.toFixed(4) } : {}),
      ...(shot.smooth != null ? { smooth: shot.smooth } : {}),
    }));
  }
  return out.sort((a, b) => a.frame - b.frame);
}

// Expanded X/Y/Z eye + FOV curve lanes for the author camera track — reuses the Load
// view's csCurvesSvg / csFovSvg so Load and Edit look identical.
function _pushAuthorCamCurves(track, total, labelHtml, trackHtml) {
  const shots = _authorCameraShots();
  if (!shots.length) {
    labelHtml.push(`<div class="cs-seq-curve-label" style="height:${CS_CURVE_H}px"><div class="cs-seq-curve-legend" style="opacity:.5;">X·Y·Z</div></div>`);
    trackHtml.push(`<div class="cs-seq-curves" style="height:${CS_CURVE_H}px"><div class="cs-seq-curves-empty">Keyframe the camera (Still / Spline) to see its path</div></div>`);
    return;
  }
  labelHtml.push(csCurveLabelHtml());        trackHtml.push(csCurvesSvg(shots, total));
  labelHtml.push(csFovLabelHtml(shots, total)); trackHtml.push(csFovSvg(shots, total));
}

// Per-channel curve lane: Position → X/Y/Z eye, Rotation → pitch/yaw, Zoom → zoom (0–100, up=in).
const CS_ROT_AXES = [['pitch', '#e06c75'], ['yaw', '#82aaff']];
function _pushChannelCurve(kind, total, labelHtml, trackHtml) {
  const channel = kind === 'campos' ? 'pos' : kind === 'camrot' ? 'rot' : 'zoom';
  const H = channel === 'zoom' ? CS_FOV_H : CS_CURVE_H;
  const S = csCameraSamples(_authorCameraShots(), total);
  if (!S.segs.length) {
    labelHtml.push(`<div class="cs-seq-curve-label" style="height:${H}px"><div class="cs-seq-curve-legend" style="opacity:.5;">—</div></div>`);
    trackHtml.push(`<div class="cs-seq-curves" style="height:${H}px"><div class="cs-seq-curves-empty">Keyframe the camera to see this curve</div></div>`);
    return;
  }
  const pad = channel === 'zoom' ? 8 : 10;
  const mapX = (frame) => (frame / S.total) * CS_CURVE_VW;
  const line = (pts, color, w = 1.5) => `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  let paths = '', legend = '', keyHtml = '';
  if (channel === 'pos' || channel === 'rot') {
    const axes = channel === 'pos' ? CS_AXES : CS_ROT_AXES;
    const key = channel === 'pos' ? 'eye' : 'rot';
    const mn = channel === 'pos' ? S.eMin : S.rMin, mx = channel === 'pos' ? S.eMax : S.rMax;
    const minSpan = channel === 'pos' ? 6 : 45;
    const mid = axes.map((_, a) => (mn[a] + mx[a]) / 2);
    const rng = axes.map((_, a) => Math.max(mx[a] - mn[a], minSpan));
    const mapY = (v, m, r) => H - pad - ((v - (m - r / 2)) / r) * (H - 2 * pad);
    axes.forEach(([, color], a) => {
      for (const seg of S.segs) paths += line(seg.map((p) => `${mapX(p.frame).toFixed(1)},${mapY(p[key][a], mid[a], rng[a]).toFixed(1)}`).join(' '), color);
    });
    legend = axes.map(([lab, c]) => `<span><i style="background:${c}"></i>${lab}</span>`).join('');
  } else {   // zoom (0–100, higher = zoomed in)
    const zs = S.segs.map((seg) => seg.map((p) => _csZoomFromFov(p.fov)));
    let zMin = Infinity, zMax = -Infinity;
    zs.forEach((seg) => seg.forEach((z) => { if (z < zMin) zMin = z; if (z > zMax) zMax = z; }));
    const mid = (zMin + zMax) / 2, rng = Math.max(zMax - zMin, 10);
    const mapY = (v) => H - pad - ((v - (mid - rng / 2)) / rng) * (H - 2 * pad);
    S.segs.forEach((seg, si) => { paths += line(seg.map((p, pi) => `${mapX(p.frame).toFixed(1)},${mapY(zs[si][pi]).toFixed(1)}`).join(' '), '#f2d493'); });
    legend = `<span><i style="background:#f2d493"></i>Zoom</span>`;
    keyHtml = `<div class="cs-seq-curve-key"><span>${Math.round(zMin)}–${Math.round(zMax)}</span></div>`;
  }
  labelHtml.push(`<div class="cs-seq-curve-label" style="height:${H}px"><div class="cs-seq-curve-legend">${legend}</div>${keyHtml}</div>`);
  trackHtml.push(`<div class="cs-seq-curves" style="height:${H}px"><svg viewBox="0 0 ${CS_CURVE_VW} ${H}" preserveAspectRatio="none">${paths}</svg></div>`);
}

// ── Author-mode toolbar + keyframe details ────────────────────────────────────

// Colors MUST match CS_BEAT_META so the Load view (retail) and Edit view (author)
// are visually consistent for the same kind — e.g. Camera is yellow #f7c873 in both.
// Sub-track kinds that live UNDER an Actor group (they inherit the group's castId).
const ACTOR_SUB_KINDS = ['face', 'dialog', 'position', 'anim'];
export const CAMERA_SUB_KINDS = ['campos', 'camrot', 'camzoom'];
const AUTHOR_TRACK_KINDS = {
  // Actor GROUP — pick a cast member. Its OWN keyframes are show/hide; it holds the
  // Face / Dialog / Position / Anim SUB-tracks (added by right-clicking the group).
  actor:   { label: 'Actor', color: '#6fd3e0', castRequired: true, addable: true, group: true },
  // Actor SUB-tracks — added from the group's right-click; inherit the group's castId.
  dialog:  { label: 'Dialog', color: '#7fd88f', sub: true },
  face:    { label: 'Face',   color: '#b48ead', sub: true },
  position:{ label: 'Position', color: '#8fd3ff', sub: true },
  anim:    { label: 'Anim',   color: '#e5b567', sub: true },
  // Standard FLAT tracks (no actor).
  music:   { label: 'Music',  color: '#ff8fcf', addable: true },
  // Bookend fades are AUTOMATIC (see the "Fade (auto)" lane) — this is for EXTRA mid-scene fades.
  fade:    { label: 'Fade (extra)', color: '#82aaff', addable: true, note: 'bookend fades are automatic — this is for mid-scene fades only' },
  wait:    { label: 'Wait',   color: '#7e8698', addable: true },
  sfx:     { label: 'SFX',    color: '#ff9e64', addable: true, note: 'preview any sound; in-game playback coming' },
  vfx:     { label: 'VFX',    color: '#ff7b72', soon: true, readOnly: true, note: 'particle opcodes not wired yet' },
  // Camera is a MANDATORY GROUP (exactly one) holding Position / Rotation / Zoom sub-tracks so
  // each channel keys independently — a zoom-only change no longer drags position/aim with it.
  camera:  { label: 'Camera', color: '#f7c873', mandatory: true, group: true, note: 'Position / Rotation / Zoom key independently' },
  campos:  { label: 'Position', color: '#f7c873', sub: true, note: 'camera eye position — carries the Cut / Move (shot) flag' },
  camrot:  { label: 'Rotation', color: '#d9a441', sub: true, note: 'where the camera aims (look-at point)' },
  camzoom: { label: 'Zoom', color: '#f2d493', sub: true, note: 'camera zoom — higher = zoomed in' },
  // Legacy npc kind (migrated into Actor groups) + retail-only structural kinds.
  npc:     { label: 'NPC',    color: '#6fd3e0' },
  shot:    { label: 'Shot',   color: '#c792ea', readOnly: true },
  task:    { label: 'Task',   color: '#9aa3b2', readOnly: true },
  taskEnd: { label: 'End',    color: '#5b6270', readOnly: true },
  end:     { label: 'End',    color: '#e06c75', readOnly: true },
};

// Called from csBuildSequencer every rebuild: show/hide the author-only toolbar
// buttons (separator + length + tracks), then keep the sequencer modal in sync.
function _renderAuthorToolbar() {
  for (const id of ['cs-seq-sep', 'cs-seq-length', 'cs-seq-tracks', 'cs-seq-addcam']) {
    const el = document.getElementById(id); if (el) el.hidden = !csAuthorMode;
  }
  if (!csAuthorMode) { _seqModalView = null; document.getElementById('cs-seq-modal')?.remove(); return; }
  document.getElementById('cs-seq-length')?.classList.toggle('active', _seqModalView === 'length');
  document.getElementById('cs-seq-tracks')?.classList.toggle('active', _seqModalView === 'track');
  _renderSeqModal();
}

// Toolbar buttons open the length / add-track views. Clicking the active one closes.
function _toggleSeqModal(view) {
  if (!csAuthorMode) return;
  if (_seqModalView === view && !_authorSelected) { _closeSeqModal(); return; }
  _authorSelected = null;             // toolbar views are not keyframe-bound
  _seqModalView = view;
  _renderSeqModal();
  document.getElementById('cs-seq-length')?.classList.toggle('active', view === 'length');
  document.getElementById('cs-seq-tracks')?.classList.toggle('active', view === 'track');
}

// Close the sequencer modal + clear all selection/view state.
function _closeSeqModal() {
  csStopPreviewAudio();
  _authorSelected = null; _authorAnchor = null; _seqModalView = null;
  document.getElementById('cs-seq-modal')?.remove();
  document.getElementById('cs-seq-length')?.classList.remove('active');
  document.getElementById('cs-seq-tracks')?.classList.remove('active');
}

// Length view wiring: type-then-Set (no live clamp) + Clamp-to-last-keyframe.
function _wireLengthView(st) {
  const totalInput = document.getElementById('cs-auth-total');
  const secInput = document.getElementById('cs-auth-total-sec');
  // Frames ↔ seconds mirror live while typing (30 fps); Set/Enter applies. Frames
  // stay the source of truth — the seconds box just converts on the way in/out.
  const syncFromFrames = () => {
    const v = parseInt(String(totalInput.value).trim(), 10);
    if (Number.isFinite(v) && secInput) secInput.value = (v / 30).toFixed(1);
  };
  const syncFromSeconds = () => {
    const s = parseFloat(String(secInput.value).trim().replace(',', '.'));
    if (Number.isFinite(s) && totalInput) totalInput.value = Math.round(s * 30);
  };
  totalInput?.addEventListener('input', syncFromFrames);
  secInput?.addEventListener('input', syncFromSeconds);
  const applyTotal = () => {
    const v = parseInt(String(totalInput.value).trim(), 10);
    if (!Number.isFinite(v) || v < 30) {
      alert('Cutscene length must be at least 30 frames (1 second).');
      totalInput.value = st.totalFrames | 0;   // restore
      syncFromFrames();
      return;
    }
    st.totalFrames = v;
    _authorEdited(); csAuthorRefresh();
  };
  document.getElementById('cs-auth-total-set')?.addEventListener('click', applyTotal);
  totalInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyTotal(); } });
  secInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyTotal(); } });
  document.getElementById('cs-auth-total-clamp')?.addEventListener('click', () => {
    // Fit the length to the last keyframe's end (frame + its dur/frames span),
    // across every track. Adds a small tail so the last beat isn't cut off.
    let last = 0;
    for (const t of st.tracks) for (const kf of (t.keyframes || [])) {
      const end = (kf.frame | 0) + ((kf.dur | 0) || (kf.frames | 0));
      if (end > last) last = end;
    }
    st.totalFrames = Math.max(30, last + 30);   // +1s tail
    _authorEdited(); csAuthorRefresh();
  });
}

// Add-track view wiring: pick a kind (+ cast when required) → append an empty track.
function _wireTrackView(st) {
  const kindSel = document.getElementById('cs-auth-add-track');
  const castWrap = document.getElementById('cs-auth-cast-wrap');
  const castLabel = document.getElementById('cs-auth-cast-label');
  const updateCastVisibility = () => {
    const meta = AUTHOR_TRACK_KINDS[kindSel?.value];
    const need = !!(meta && meta.castRequired);
    if (castWrap) castWrap.hidden = !need;
    if (castLabel) castLabel.hidden = !need;
  };
  kindSel?.addEventListener('change', updateCastVisibility);
  updateCastVisibility();
  document.getElementById('cs-auth-add-btn')?.addEventListener('click', () => {
    const kind = kindSel?.value; if (!kind) return;
    const meta = AUTHOR_TRACK_KINDS[kind];
    // Create the (empty) track — it renders as an empty lane; right-click it or
    // the timeline to drop keyframes in.
    const track = { kind, keyframes: [] };
    if (meta.castRequired) {
      const cid = document.getElementById('cs-auth-add-cast')?.value || st.owner || 'npc';
      if (kind === 'actor' && st.tracks.some((t) => t.kind === 'actor' && t.castId === cid)) return;  // that actor already has a group
      track.castId = cid;
    }
    st.tracks.push(track);
    _seqModalView = null;                    // auto-close the modal after adding
    _authorEdited(); csAuthorRefresh();      // re-render drops the (now view-less) modal
  });
}

// ── Sequencer modal ───────────────────────────────────────────────────────────
// One reusable panel that floats ABOVE the sequencer (CSS .cs-seq-modal — a
// bottom:100% child of #cs-seq, so placement is pure CSS). Three views:
//   'keyframe' — the selected keyframe's data (a selected keyframe always wins)
//   'length'   — sequence length + clamp
//   'track'    — add a track (kind dropdown + cast + add)
// All styling lives in css/events.css; the JS sets nothing inline.
function _renderSeqModal() {
  let panel = document.getElementById('cs-seq-modal');
  if (!csAuthorMode) { panel?.remove(); return; }
  const st = _authorState;
  const view = _authorSelected ? 'keyframe' : _seqModalView;
  if (!view || !st) { panel?.remove(); return; }

  let title = 'Sequencer', bodyHtml = '', wire = null, color = '#7fd6e6';
  if (view === 'length') {
    const totSec = (st.totalFrames / 30).toFixed(1);
    title = 'Sequence length';
    bodyHtml = `
      <div class="cs-kf-grid">
        <label>Frames</label>
        <div class="cs-kf-inline">
          <input id="cs-auth-total" class="cs-kf-num" type="text" inputmode="numeric" value="${st.totalFrames | 0}">
          <span class="cs-kf-hint">frames</span>
        </div>
        <label>Time</label>
        <div class="cs-kf-inline">
          <input id="cs-auth-total-sec" class="cs-kf-num" type="text" inputmode="decimal" value="${totSec}">
          <span class="cs-kf-hint">seconds · 30 fps</span>
        </div>
        <label></label>
        <div class="cs-kf-inline">
          <button id="cs-auth-total-set" title="Apply the length (must be ≥ 30 frames / 1s)">Set</button>
          <button id="cs-auth-total-clamp" title="Auto-fit the length to the last keyframe + its duration">Clamp</button>
        </div>
      </div>`;
    wire = () => _wireLengthView(st);
  } else if (view === 'track') {
    // One Actor track per cast member. Grey out ones that already have a group.
    // Disambiguate same display names (two Maats) with the entity hex tail.
    const hasGroup = (cid) => (st.tracks || []).some((t) => t.kind === 'actor' && t.castId === cid);
    const seenEnt = new Set();
    const castOpts = (st.cast || [])
      .filter((c) => {
        if (c.id === 'player' || c.entity === 'player' || !c.entity) return false;
        const ent = String(c.entity).toLowerCase();
        if (seenEnt.has(ent)) return false;   // duplicate cast row, same entity
        seenEnt.add(ent);
        return true;
      })
      .map((c) => {
        const dis = hasGroup(c.id);
        const hex = String(c.entity).replace(/^0x/i, '').slice(-4).toUpperCase();
        const trig = (c.id === st.owner) ? ' (Trigger NPC)' : '';
        const label = `${(c.name || c.id).replace(/</g, '')} · ${hex}${trig}`;
        return `<option value="${c.id}"${dis ? ' disabled' : ''}>${label}${dis ? ' — already added' : ''}</option>`;
      })
      .join('');
    const kindOpts = Object.entries(AUTHOR_TRACK_KINDS).filter(([, m]) => m.addable)
        .map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('')
      + Object.entries(AUTHOR_TRACK_KINDS).filter(([, m]) => m.soon && !m.sub)   // sub-kinds are added via the Actor group, not here
        .map(([, m]) => `<option value="" disabled>${m.label} (soon)</option>`).join('');
    title = 'Add track';
    bodyHtml = `
      <div class="cs-kf-grid">
        <label>Track</label>
        <div><select id="cs-auth-add-track" class="cs-kf-full"><option value="">— pick kind —</option>${kindOpts}</select></div>
        <label id="cs-auth-cast-label" hidden>For</label>
        <div id="cs-auth-cast-wrap" hidden><select id="cs-auth-add-cast" class="cs-kf-full">${castOpts}</select></div>
      </div>
      <div class="cs-seq-modal-foot"><button id="cs-auth-add-btn">+ Add track</button></div>`;
    wire = () => _wireTrackView(st);
  } else {
    const built = _buildKeyframeBody(st, _authorSelected);
    if (!built) { panel?.remove(); return; }
    title = built.title; bodyHtml = built.html; wire = built.wire; color = built.color;
  }

  const html = `
    <div id="cs-seq-modal" class="cs-seq-modal">
      <div class="cs-seq-modal-head">
        <span class="cs-seq-modal-dot" style="--dot:${color}"></span>
        <span class="cs-seq-modal-title">${title.replace(/</g, '')}</span>
        <span class="cs-seq-modal-grow"></span>
        <button id="cs-seq-modal-close" class="modal-close" title="Close">×</button>
      </div>
      <div class="cs-seq-modal-body">${bodyHtml}</div>
    </div>`;
  if (panel) panel.outerHTML = html;
  else csSeqEl?.insertAdjacentHTML('afterbegin', html);

  document.getElementById('cs-seq-modal-close')?.addEventListener('click', _closeSeqModal);
  if (wire) wire();
}

// Build the keyframe-data body → { title, html, wire } (or null if the selection is stale).
function _buildKeyframeBody(st, sel) {
  const track = st.tracks[sel.trackIdx];
  const kf = track?.keyframes[sel.kfIdx];
  if (!track || !kf) return null;

  const meta = AUTHOR_TRACK_KINDS[track.kind] || { label: track.kind, color: '#888' };
  const readOnly = !!(track.readOnly || meta.readOnly);
  const castName = (id) => {
    const c = st.cast.find((x) => x.id === id);
    return c ? (c.name || c.id) : id;
  };
  const title = track.castId ? `${meta.label} · ${castName(track.castId)}` : meta.label;

  // Editable fields as [label, controlHtml] rows → rendered in a 2-col grid (.cs-kf-grid).
  const rows = [['Frame',
    `<div class="cs-kf-inline"><input id="cs-auth-kf-frame" class="cs-kf-num" type="number" min="0" value="${kf.frame | 0}"${readOnly ? ' disabled' : ''}><span class="cs-kf-hint">${((kf.frame | 0) / 30).toFixed(2)}s</span></div>`]];

  // Cast <option> list for speaker/actor/target dropdowns (all cast incl. Player).
  // Label "Name · CODE" (4-hex entity tail) so two same-name NPCs (Maat·3031 vs 3032)
  // are distinguishable and never conflated.
  const castTag = (c) => {
    const h = String(c.entity || '').replace(/^0x/i, '').toUpperCase();
    return (c.entity && c.entity !== 'player' && h) ? ` · ${h.slice(-4)}` : '';
  };
  const castOpt = (selId) => st.cast.map((c) =>
    `<option value="${c.id}"${c.id === selId ? ' selected' : ''}>${(c.name || c.id).replace(/</g, '')}${castTag(c)}</option>`).join('');

  if (track.kind === 'dialog') {
    // Sub-track: the speaker IS the group's actor. Only offer the picker on a legacy flat track.
    if (!track.castId) rows.push(['Speaker', `<select class="cs-auth-kf-field cs-kf-full" data-k="speaker">${castOpt(kf.speaker || st.owner)}</select>`]);
    // On an actor's Dialog sub-track, only offer THAT actor's lines (speaker === the group's cast
    // id); always keep the currently-picked line so it stays selectable. Legacy flat track → all.
    const speakerId = track.castId || kf.speaker;
    const opts = st.lines
      .filter((l) => !speakerId || l.speaker === speakerId || l.id === kf.line)
      .map((l) => {
        const spk = st.cast.find((c) => c.id === l.speaker);
        const label = `${spk ? (spk.name || spk.id) : '?'}: ${(l.text || '(empty)').slice(0, 40)}`.replace(/</g, '');
        return `<option value="${l.id}"${l.id === kf.line ? ' selected' : ''}>${label}</option>`;
      }).join('') || `<option value="">— no lines for this actor (add one in the Dialog tab) —</option>`;
    rows.push(['Line', `<select class="cs-auth-kf-field cs-kf-full" data-k="line">${opts}</select>`]);
    // Per-actor animation dropdown — the SAME builder as the NPCs-tab idle list
    // (state.animOptionsFor → animOptionsHtml): the speaker's OWN motions, labelled by
    // 3-char motion, valued by real 4-char id. Empty = the default talk gesture.
    const dOpts = (typeof st.animOptionsFor === 'function')
      ? st.animOptionsFor(speakerId, kf.anim || '', { emptyLabel: 'default (talk gesture)' })
      : `<option value="${(kf.anim || '').replace(/"/g, '')}" selected>${(kf.anim || 'default').replace(/</g, '')}</option>`;
    rows.push(['Anim', `<select class="cs-auth-kf-field cs-kf-full" data-k="anim">${dOpts}</select>`]);
  } else if (track.kind === 'face') {
    // Sub-track: the actor who turns IS the group's actor. Only pick WHOM they face.
    if (!track.castId) rows.push(['Who turns', `<select class="cs-auth-kf-field cs-kf-full" data-k="actor">${castOpt(kf.actor || st.owner)}</select>`]);
    rows.push(['Turn to', `<select class="cs-auth-kf-field cs-kf-full" data-k="target">${castOpt(kf.target || 'player')}</select>`]);
    rows.push(['Mouth-move', `<label class="check"><input type="checkbox" class="cs-auth-kf-field cs-auth-kf-cb" data-k="talk" ${kf.talk === true ? 'checked' : ''}> play talk gesture while turning</label>`]);
  } else if (track.kind === 'anim') {
    // Like Dialog but no text — just play an animation on the group's actor.
    if (!track.castId) rows.push(['Actor', `<select class="cs-auth-kf-field cs-kf-full" data-k="actor">${castOpt(kf.actor || st.owner)}</select>`]);
    // Per-actor animation dropdown — SAME builder as the dialog branch / idle list.
    const animActorId = track.castId || kf.actor || st.owner;
    const aOpts = (typeof st.animOptionsFor === 'function')
      ? st.animOptionsFor(animActorId, kf.anim || '', { emptyLabel: '— pick animation —', emptyDisabled: true, idleStop: true })
      : `<option value="${(kf.anim || '').replace(/"/g, '')}" selected>${(kf.anim || '—').replace(/</g, '')}</option>`;
    rows.push(['Anim', `<select class="cs-auth-kf-field cs-kf-full" data-k="anim">${aOpts}</select>`]);
  } else if (track.kind === 'npc' || track.kind === 'actor') {
    // Actor group (or legacy npc) show/hide the actor at this frame.
    rows.push(['Action', `<select class="cs-auth-kf-field cs-kf-full" data-k="action">
      <option value="show" ${(kf.action || 'show') === 'show' ? 'selected' : ''}>show</option>
      <option value="hide" ${kf.action === 'hide' ? 'selected' : ''}>hide</option>
    </select>`]);
  } else if (track.kind === 'position') {
    // Sub-track: the actor to move IS the group's actor. Only pick WHICH marker.
    if (!track.castId) rows.push(['Move Actor', `<select class="cs-auth-kf-field cs-kf-full" data-k="actor">${castOpt(kf.actor || st.owner)}</select>`]);
    const markers = csGetMarkers();
    const mopts = `<option value=""${!kf.marker ? ' selected' : ''}>— none —</option>`
      + markers.map((m) => `<option value="${(m.name || '').replace(/"/g, '')}"${m.name === kf.marker ? ' selected' : ''}>${(m.name || 'marker').replace(/</g, '')}</option>`).join('');
    rows.push(['To marker', markers.length
      ? `<select class="cs-auth-kf-marker cs-kf-full">${mopts}</select>`
      : `<span class="cs-kf-note">No markers placed. Drop a marker in the viewport first, then reopen this.</span>`]);
    if (kf.pos) rows.push(['Spot', `<span class="cs-kf-mono">${kf.pos.map((v) => (+v).toFixed(1)).join(', ')} (FFXI)</span>`]);
    // Rotation = the entity's facing (FFXI NPCs only turn about the vertical axis),
    // stored as kf.dir in RADIANS. Slider mirrors the camera roll: −360…+360° with a
    // reset ⟲ back to 0°. Dragging live-rotates the preview NPC.
    const hasDir = typeof kf.dir === 'number';
    const rotDeg = hasDir ? Math.max(-360, Math.min(360, Math.round(kf.dir * 180 / Math.PI))) : 0;
    rows.push(['Rotation', `<div class="cs-kf-sliderrow"><input class="cs-auth-kf-rotslider" type="range" min="-360" max="360" step="1" value="${rotDeg}"><span class="cs-kf-slidernum" id="cs-kf-rotread">${rotDeg}°</span><button class="cs-kf-rotreset" title="Reset rotation to 0°" style="background:none;border:none;color:#7e8698;cursor:pointer;padding:0 4px;font-size:15px;line-height:1;">⟲</button></div><span class="cs-kf-note">Facing comes from this slider only — rotating the marker pin in the viewport has no effect.</span>`]);
  } else if (track.kind === 'music') {
    csEnsureAudioCatalogs();
    const cur = kf.song | 0;
    // A song outside the previewable catalog (e.g. ATRAC3, dropped from the Asset
    // Browser) still needs an <option>, or the select silently shows the wrong song.
    const stray = (cur > 0 && csMusicCatalog && !csMusicCatalog.some((s) => (s.id | 0) === cur))
      ? `<option value="${cur}" selected>#${cur} (not previewable)</option>` : '';
    const opts = stray + (csMusicCatalog || []).map((s) =>
      `<option value="${s.id}"${s.id === cur ? ' selected' : ''}>${(s.title || ('#' + s.id)).replace(/</g, '')} (#${s.id})</option>`).join('');
    const sel = opts
      ? `<select class="cs-auth-kf-field cs-auth-kf-int cs-kf-grow" data-k="song">${opts}</select>`
      : `<select class="cs-auth-kf-field cs-auth-kf-int cs-kf-grow" data-k="song"><option value="${cur}">${csMusicCatalog ? 'no playable songs' : 'loading songs…'} (#${cur})</option></select>`;
    rows.push(['Song', `<div class="cs-kf-inline">${sel}${_audioPlayBtn('music')}</div>`]);
    rows.push(['Channel', `<select class="cs-auth-kf-field cs-auth-kf-int cs-kf-full" data-k="slot">
      <option value="0" ${(kf.slot | 0) === 0 ? 'selected' : ''}>0 — main BGM (default)</option>
      <option value="1" ${(kf.slot | 0) === 1 ? 'selected' : ''}>1 — secondary layer</option>
    </select>`]);
  } else if (track.kind === 'sfx') {
    csEnsureAudioCatalogs();
    const cur = kf.sound | 0;
    const groups = (csSfxCatalog || []).map((g) =>
      `<optgroup label="${(g.label || g.key).replace(/</g, '')}">${(g.sounds || []).map((s) =>
        `<option value="${s.id}"${s.id === cur ? ' selected' : ''}>${(s.title || ('se' + String(s.id).padStart(6, '0'))).replace(/</g, '')} (#${s.id})</option>`).join('')}</optgroup>`).join('');
    const sel = groups
      ? `<select class="cs-auth-kf-field cs-auth-kf-int cs-kf-grow" data-k="sound">${groups}</select>`
      : `<select class="cs-auth-kf-field cs-auth-kf-int cs-kf-grow" data-k="sound"><option value="${cur}">${csSfxCatalog ? 'no sounds' : 'loading sounds…'} (#${cur})</option></select>`;
    rows.push(['Sound', `<div class="cs-kf-inline">${sel}${_audioPlayBtn('sfx')}</div>`]);
    rows.push(['', `<span class="cs-kf-note">Preview only — in-game SFX playback is coming (needs the scene sound writer).</span>`]);
  } else if (track.kind === 'fade') {
    const durF = kf.dur || 30;
    rows.push(['Direction', `<select class="cs-auth-kf-field cs-kf-full" data-k="kind">
      <option value="in" ${(kf.kind || 'in') === 'in' ? 'selected' : ''}>fade in (fdi1)</option>
      <option value="out" ${kf.kind === 'out' ? 'selected' : ''}>fade out (fdo1)</option>
    </select>`]);
    rows.push(['Length', `<input class="cs-auth-kf-field cs-auth-kf-int cs-kf-num" data-k="dur" type="number" min="1" value="${durF}"> <span class="cs-kf-hint">frames · ${(durF / 30).toFixed(1)}s</span>`]);
  } else if (track.kind === 'wait') {
    const wf = kf.frames || 30;
    rows.push(['Pause', `<input class="cs-auth-kf-field cs-auth-kf-int cs-kf-num" data-k="frames" type="number" min="1" value="${wf}"> <span class="cs-kf-hint">frames · ${(wf / 30).toFixed(1)}s extra hold</span>`]);
  } else if (track.kind === 'campos') {
    // Position sub-track: the eye + the Cut/Move (shot) flag + its easing.
    const ck = kf.camKind || 'still';
    rows.push(['Type', `<select class="cs-auth-kf-field cs-kf-full" data-k="camKind">
      <option value="still" ${ck === 'still' ? 'selected' : ''}>Cut — start a new shot here</option>
      <option value="spline" ${ck === 'spline' ? 'selected' : ''}>Move — straight glide from previous</option>
      <option value="curved" ${ck === 'curved' ? 'selected' : ''}>Move — smooth arc (chain 3+ to curve)</option>
    </select>`]);
    if (ck !== 'still') {
      const sm = (kf.smooth != null) ? (kf.smooth | 0) : 4;
      rows.push(['Easing', `<select class="cs-auth-kf-field cs-auth-kf-int cs-kf-full" data-k="smooth">
        <option value="0" ${sm === 0 ? 'selected' : ''}>Linear — constant speed</option>
        <option value="1" ${sm === 1 ? 'selected' : ''}>Decelerate — fast → slow</option>
        <option value="2" ${sm === 2 ? 'selected' : ''}>Accelerate — slow → fast</option>
        <option value="3" ${sm === 3 ? 'selected' : ''}>Ease to middle — slow at midpoint</option>
        <option value="4" ${sm === 4 ? 'selected' : ''}>Smooth — ease in &amp; out (S-curve)</option>
      </select>`]);
    }
    const e = kf.eye || [0, 0, 0];
    rows.push(['Eye', `<span class="cs-kf-mono">${e.map((v) => (+v).toFixed(1)).join(', ')} (FFXI)</span>`]);
    rows.push(['', `<span class="cs-kf-note">Fly the camera + re-capture to move this point.</span>`]);
  } else if (track.kind === 'camrot') {
    // Rotation sub-track: where the camera aims (look-at point) + optional roll tilt.
    const l = kf.look || [0, 0, 0];
    rows.push(['Aims at', `<span class="cs-kf-mono">${l.map((v) => (+v).toFixed(1)).join(', ')} (FFXI)</span>`]);
    const rollDeg = Math.round((Number(kf.roll) || 0) * 180 / Math.PI);
    rows.push(['Roll', `<div class="cs-kf-sliderrow"><input class="cs-auth-kf-rollslider" type="range" min="-360" max="360" step="1" value="${rollDeg}"><span class="cs-kf-slidernum" id="cs-kf-rollread">${rollDeg}°</span><button class="cs-kf-rollreset" title="Reset roll to 0°" style="background:none;border:none;color:#7e8698;cursor:pointer;padding:0 4px;font-size:15px;line-height:1;">⟲</button></div>`]);
    rows.push(['', `<span class="cs-kf-note">Fly the camera + re-capture to re-aim.</span>`]);
  } else if (track.kind === 'camzoom') {
    // Zoom sub-track: FFXI-style ZOOM (0–100, HIGHER = zoomed IN). Stored internally as FOV degrees.
    const zoomV = _csZoomFromFov(kf.fov);
    rows.push(['Zoom', `<div class="cs-kf-sliderrow"><input class="cs-auth-kf-fovslider" type="range" min="0" max="100" step="1" value="${zoomV}" title="Camera zoom — drag right / higher to zoom IN (FFXI is a zoom, not a wide-angle FOV)"><span class="cs-kf-slidernum" id="cs-kf-fovread">${zoomV}</span></div>`]);
  }

  // Read-only preview tracks: show captured fields as static rows.
  if (readOnly) {
    if (kf.tag) rows.push(['Tag', `<span class="cs-kf-val">${String(kf.tag).replace(/</g, '')}</span>`]);
    if (kf.dur) rows.push(['Duration', `${kf.dur}f · ${(kf.dur / 30).toFixed(2)}s`]);
    if (kf.frames) rows.push(['Length', `${kf.frames}f · ${(kf.frames / 30).toFixed(2)}s`]);
    if (kf.res) rows.push(['Scene res', String(kf.res)]);
    if (kf.name) rows.push(['Name', String(kf.name).replace(/</g, '')]);
    if (kf.actor) rows.push(['Actor', String(kf.actor).replace(/</g, '')]);
    if (kf.effect) rows.push(['Effect', String(kf.effect).replace(/</g, '')]);
  }

  const lockHtml = readOnly
    ? `<div class="cs-kf-lock"><span class="material-symbols-outlined">lock</span> preview only — not written on Publish</div>` : '';
  const renderGrid = (rr) => `<div class="cs-kf-grid">${rr.map(([l, c]) => `<label>${l}</label><div>${c}</div>`).join('')}</div>`;
  // Position keyframes get an "Update" button that snaps the actor to the marker's live spot.
  const updateHtml = (!readOnly && track.kind === 'position')
    ? `<button id="cs-auth-kf-update" class="btn-primary" title="Snap the moved actor to the picked marker's current position">Update</button>` : '';
  let gridHtml, footHtml = '';   // Delete now lives in right-click → Delete, so no footer needed
  if (track.kind === 'camera' && !readOnly) {
    // Camera: two columns — Frame + FOV (left), Type / Rotation / Position (right); wider + shorter.
    // The recapture button (label '') spans full width underneath.
    const col1 = (l) => l === 'Frame' || l === 'FOV';
    const col2 = (l) => l === 'Type' || l === 'Rotation' || l === 'Position';
    const rest = rows.filter(([l]) => !col1(l) && !col2(l));
    gridHtml = `<div class="cs-kf-cols">${renderGrid(rows.filter(([l]) => col1(l)))}${renderGrid(rows.filter(([l]) => col2(l)))}</div>`
      + (rest.length ? renderGrid(rest) : '');
  } else if (track.kind === 'position' && !readOnly) {
    // Position: two columns — the rest on the left, the marker picker + Update on the right.
    const inCol2 = (l) => l === 'To marker';
    const c2 = rows.filter(([l]) => inCol2(l));
    if (updateHtml) c2.push(['', updateHtml]);
    gridHtml = `<div class="cs-kf-cols">${renderGrid(rows.filter(([l]) => !inCol2(l)))}${renderGrid(c2)}</div>`;
  } else {
    gridHtml = renderGrid(rows);
  }

  return { title, color: meta.color || '#7fd6e6', html: lockHtml + gridHtml + footHtml, wire: () => _wireKeyframeView(st, track, kf, sel) };
}

// Wire the keyframe-data body: frame, per-field edits, audio preview, marker, recapture, delete.
function _wireKeyframeView(st, track, kf, sel) {
  document.getElementById('cs-auth-kf-frame')?.addEventListener('change', (e) => {
    kf.frame = Math.max(0, +e.target.value | 0);
    _authorEdited(); csAuthorRefresh();
  });
  document.querySelectorAll('.cs-auth-kf-field').forEach((input) => {
    // Fields fire on 'change' (blur/enter) so the DOM rebuild doesn't steal focus mid-typing.
    input.addEventListener('change', (e) => {
      const k = e.target.dataset.k;
      // A <select> change triggers a pane rebuild below, which drops the element and its
      // focus — capture a selector so we can put focus back and keep arrow-keying options.
      const refocus = e.target.tagName === 'SELECT'
        ? 'select' + [...e.target.classList].filter((c) => c.startsWith('cs-')).map((c) => '.' + c).join('')
          + (k != null ? `[data-k="${k}"]` : '')
        : null;
      kf[k] = e.target.type === 'checkbox' ? e.target.checked
            : e.target.classList.contains('cs-auth-kf-int') ? +e.target.value
            : e.target.value;
      _authorEdited(); csAuthorRefresh();
      // Picking an animation performs it on the actor right away (audition), so the
      // dropdown gives instant feedback even with the playhead before the keyframe.
      if (k === 'anim') csAuditionAnim(track.castId || kf.actor || kf.speaker || st.owner, kf[k]);
      if (refocus) { const s = document.querySelector(refocus); if (s) s.focus(); }
    });
  });
  // Song / SFX Play-Stop buttons audition the currently-selected id.
  document.querySelectorAll('.cs-audio-play').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const sel2 = btn.parentElement.querySelector('select');
      csPlayPreviewAudio(btn.dataset.audioKind, sel2 ? sel2.value : null, btn);
    });
  });
  // Position keyframe: picking a marker captures its FFXI position + re-spawns the cast.
  document.querySelector('.cs-auth-kf-marker')?.addEventListener('change', (e) => {
    const name = e.target.value;
    if (!name) { delete kf.marker; delete kf.pos; }   // "— none —" → unset (won't place on publish)
    else {
      kf.marker = name; const m = csGetMarkers().find((x) => x.name === name); if (m) kf.pos = m.pos;
      if (_selectMarkerByName) _selectMarkerByName(name);   // highlight the picked marker in the viewport
    }
    _authorEdited(); csAuthorRefresh();
    csLoadAuthorActors();
  });
  // Rotation slider: −360…+360° facing; live-rotates the preview NPC. Reset ⟲ → 0°.
  const rotSlider = document.querySelector('.cs-auth-kf-rotslider');
  if (rotSlider) {
    const rotRead = document.getElementById('cs-kf-rotread');
    const applyRot = (deg) => {
      kf.dir = deg * Math.PI / 180;
      if (rotRead) rotRead.textContent = deg + '°';
      csPreviewActorRotation(track.castId || kf.actor, kf.dir);   // live, no rebuild
    };
    rotSlider.addEventListener('input', () => applyRot(+rotSlider.value));
    rotSlider.addEventListener('change', () => { _authorEdited(); });
    document.querySelector('.cs-kf-rotreset')?.addEventListener('click', () => {
      rotSlider.value = 0; applyRot(0); _authorEdited();
    });
  }
  // Zoom slider → live-updates the sequencer camera. The slider value is a ZOOM (higher = zoom in);
  // kf.fov stays in FOV degrees internally (preview uses it directly, compiler → focal length).
  const fovSlider = document.querySelector('.cs-auth-kf-fovslider');
  if (fovSlider) {
    const fovRead = document.getElementById('cs-kf-fovread');
    fovSlider.addEventListener('input', () => {
      const zoom = +fovSlider.value;
      kf.fov = _csFovFromZoom(zoom);
      if (fovRead) fovRead.textContent = `${zoom}`;
      csSetAuthorFov(kf.fov);
      csDriveCameraToFrame(csFrame);            // live preview zooms the right direction
    });
    fovSlider.addEventListener('change', () => { _authorEdited(); });
  }
  // Rotation (roll) slider — deg→rad into kf.roll; re-drives the preview camera so the tilt
  // shows live. Reset button snaps back to 0°.
  const rollSlider = document.querySelector('.cs-auth-kf-rollslider');
  if (rollSlider) {
    const rollRead = document.getElementById('cs-kf-rollread');
    const applyRoll = (deg) => {
      kf.roll = deg * Math.PI / 180;
      if (rollRead) rollRead.textContent = deg + '°';
      csDriveCameraToFrame(csFrame);
    };
    rollSlider.addEventListener('input', () => applyRoll(+rollSlider.value));
    rollSlider.addEventListener('change', () => { _authorEdited(); });
    document.querySelector('.cs-kf-rollreset')?.addEventListener('click', () => {
      rollSlider.value = 0; applyRoll(0); _authorEdited();
    });
  }
  // Update: snap the moved actor to the picked marker's CURRENT position (preview sync;
  // publish already re-resolves markers, this makes the in-editor preview match).
  document.getElementById('cs-auth-kf-update')?.addEventListener('click', () => {
    const m = csGetMarkers().find((x) => x.name === kf.marker);
    if (!m) { alert('Pick a marker first, then press Update.'); return; }
    kf.pos = m.pos;
    _authorEdited(); csAuthorRefresh(); csLoadAuthorActors();
  });
}

// Live-rotate a preview actor (by cast id) without a full re-spawn — for the rotation slider.
function csPreviewActorRotation(castId, dirRad) {
  if (!_authorState) return;
  const c = (_authorState.cast || []).find((x) => x.id === castId);
  if (!c || !c.entity || c.entity === 'player') return;
  const eid = parseInt(String(c.entity).replace(/^0x/i, ''), 16);
  const rec = csActors.find((r) => r.actorId === eid);
  if (rec && rec.node) { rec.node.rotation.y = dirRad - Math.PI; rec.dirRad = dirRad; }
}

// ── Keyframe undo/redo ────────────────────────────────────────────────────────
// The editable timeline (state.tracks) is JSON-snapshotted after each edit; every change
// pushes a { undo, redo } command into the GLOBAL editor history, so Ctrl+Z / Ctrl+Y walk
// keyframe edits alongside placement edits.
let _authorUndoBaseline = null;   // tracks snapshot as of the last committed edit

function _authorSnapshot() { return _authorState ? JSON.stringify(_authorState.tracks) : null; }

function _authorRestore(snap) {
  if (!_authorState || snap == null) return;
  try { _authorState.tracks = JSON.parse(snap); } catch { return; }
  _authorSelected = null; _seqModalView = null;
  // Only rebuild the visible sequencer; if it's closed just restore the data (kept in memory).
  if (csAuthorMode && csSeqEl && !csSeqEl.hidden) {
    document.getElementById('cs-seq-modal')?.remove();
    csData = _authorBeats();
    csBuildSequencer(); csUpdatePlayhead(); csLoadAuthorActors();
  }
  if (typeof _authorOnChange === 'function') _authorOnChange({ type: 'edit' });
}

function _authorEdited() {
  // Record an undo step for this edit (baseline → current), then notify the author.
  if (_pushCommand && _authorUndoBaseline != null) {
    const after = _authorSnapshot();
    if (after != null && after !== _authorUndoBaseline) {
      const before = _authorUndoBaseline;
      const st = _authorState;   // this step only applies while THIS cutscene state is active
      _pushCommand({
        undo() { if (_authorState !== st) return; _authorRestore(before); _authorUndoBaseline = before; },
        redo() { if (_authorState !== st) return; _authorRestore(after);  _authorUndoBaseline = after; },
      });
      _authorUndoBaseline = after;
    }
  }
  if (typeof _authorOnChange === 'function') _authorOnChange({ type: 'edit' });
}

// ── Load-view read-only beat details ─────────────────────────────────────────
function _closeLoadBeatDetail() {
  document.getElementById('cs-load-beat-detail')?.remove();
}

// Close the sequencer modal + clear the selection (kept name — external callers use it).
function _closeAuthorDetail() {
  _closeSeqModal();
}

// Read-only popover for a retail beat (Load view). Shows everything we decoded
// about it — no editing.
function _showLoadBeatDetail(dot, beat) {
  _closeLoadBeatDetail();
  if (!beat) return;
  const [lab, color] = CS_BEAT_META[beat.type] || [beat.type, '#888'];
  const fps = (csData && csData.fps) || 30;

  const rows = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') rows.push([k, v]); };
  add('Type', lab);
  add('Frame', `${beat.frame} · ${(beat.frame / fps).toFixed(2)}s`);
  if (beat.dur) add('Duration', `${beat.dur}f · ${(beat.dur / fps).toFixed(2)}s`);
  if (beat.frames) add('Length', `${beat.frames}f · ${(beat.frames / fps).toFixed(2)}s`);
  add('Tag', beat.tag);
  add('Scene res', beat.res);
  add('Speaker', beat.speaker);
  add('Text', beat.text);
  add('Actor', beat.actor);
  add('Action', beat.action);
  add('Name', beat.name);
  add('Op', beat.op);
  if (beat.actors && beat.actors.length) add('Cast', beat.actors.join(', '));
  if (beat.vfx) add('VFX', beat.vfx.join(', '));
  if (beat.playAnim) add('Anim', beat.playAnim.join(', '));
  if (beat.sound) add('Sound', beat.sound.join(', '));
  if (beat.camera && beat.camera.length) add('Camera keyframes', beat.camera.length);

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const r = dot.getBoundingClientRect();
  const W = 300;
  let left = Math.max(6, Math.min(r.left + r.width / 2 - W / 2, window.innerWidth - W - 6));
  let top = r.top - 12;
  const html = `
    <div id="cs-load-beat-detail" style="position:fixed; left:${left}px; top:${top}px; transform:translateY(-100%); background:#1c1e26; border:1px solid #3a3a44; border-radius:6px; padding:10px 12px; box-shadow:0 4px 18px rgba(0,0,0,.5); width:${W}px; z-index:50; font-size:11px;">
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
        <span style="width:9px;height:9px;background:${color};transform:rotate(45deg);display:inline-block;"></span>
        <span style="font-weight:600; color:${color};">${esc(lab)}</span>
        <span style="flex:1"></span>
        <button id="cs-load-beat-close" style="background:none;border:none;color:#9aa3b2;font-size:18px;line-height:1;cursor:pointer;padding:0 2px;">×</button>
      </div>
      <table style="width:100%; border-collapse:collapse;">
        ${rows.map(([k, v]) => `<tr><td style="opacity:.55; padding:2px 8px 2px 0; vertical-align:top; white-space:nowrap;">${k}</td><td style="padding:2px 0;">${esc(v)}</td></tr>`).join('')}
      </table>
      <div style="opacity:.4; font-size:10px; margin-top:6px;">Read-only — this is a retail cutscene. Use Edit Cutscene to author.</div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  const pop = document.getElementById('cs-load-beat-detail');
  // Flip below if it would go off the top.
  if (pop.getBoundingClientRect().top < 4) { pop.style.top = (r.bottom + 12) + 'px'; pop.style.transform = 'none'; }
  document.getElementById('cs-load-beat-close')?.addEventListener('click', _closeLoadBeatDetail);
}

// Map a clientX over the track body → a frame in [0, totalFrames].
function _frameFromClientX(clientX) {
  const body = document.getElementById('cs-seq-body');
  if (!body || !csData) return 0;
  const r = body.getBoundingClientRect(), total = Math.max(1, csData.totalFrames || 1);
  return Math.round(Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1))) * total);
}

function _authorCloseContextMenu() {
  document.getElementById('cs-seq-ctx')?.remove();
}

// Highlight a whole track row (label + body) so it's clear which track a right-click
// or hover targets. `ti` = track index, or null to clear.
function _authorHighlightTrack(ti) {
  document.querySelectorAll('.cs-track-hi').forEach((el) => el.classList.remove('cs-track-hi'));
  if (ti == null) return;
  document.querySelectorAll(`.cs-auth-lane[data-ti="${ti}"], .cs-auth-lane-label[data-hi-ti="${ti}"]`)
    .forEach((el) => el.classList.add('cs-track-hi'));
}

// Per-kind Material-Symbols icon for the context menu / keyframe rows.
const KIND_ICON = {
  actor: 'group', dialog: 'chat_bubble', face: '3d_rotation', npc: 'person', music: 'music_note',
  fade: 'gradient', wait: 'schedule', camera: 'photo_camera', sfx: 'graphic_eq',
  position: 'my_location', anim: 'directions_run', vfx: 'auto_awesome',
};

// Floating context menu at the right-click position. TRACK-AWARE: when a specific
// lane is right-clicked (`laneTi`), it shows ONLY that track's keyframe action(s)
// — Camera → "Cut Keyframe" + "Spline Keyframe" (auto-capturing the camera pose),
// every other editable track → "<Label> Keyframe". Right-clicking empty space (no
// lane) falls back to the full add-any-kind list.
function _authorShowContextMenu(clientX, clientY, frame, laneTi, kfRef, opts = {}) {
  _authorCloseContextMenu();
  const st = _authorState;
  if (!st) return;

  const item = (icon, color, label, attrs) =>
    `<button class="cs-ctx-item" ${attrs} style="display:flex; align-items:center; gap:9px; width:100%; text-align:left; background:none; border:none; color:#e6e6ec; padding:7px 13px; cursor:pointer; font-size:12px;">
       <span class="material-symbols-outlined" style="font-size:17px; color:${color};">${icon}</span>${label}
     </button>`;

  const sep = `<div style="height:1px; background:#2a2d38; margin:4px 0;"></div>`;
  let bodyHtml;

  const kfTrack = kfRef ? st.tracks[kfRef.ti] : null;
  if (kfRef && _authorMultiSel.size > 1 && _authorMultiSel.has(`${kfRef.ti}:${kfRef.ki}`)) {
    // ── Right-clicked a keyframe inside a marquee selection → group actions. ──
    bodyHtml = item('delete', '#e58787', `Delete ${_authorMultiSel.size} Keyframes`, 'data-del-multi="1"')
      + item('backspace', '#9aa3b2', 'Clear Selection', 'data-clear-multi="1"');
  } else if (kfTrack && kfTrack.keyframes[kfRef.ki]) {
    // ── Right-clicked a KEYFRAME → its OWN actions only. No "add a keyframe on a keyframe". ──
    const kfMeta = AUTHOR_TRACK_KINDS[kfTrack.kind] || {};
    let head = '';
    // Position keyframes also get a Cut/Move switch (a Cut starts a new shot; Moves interpolate).
    if (kfTrack.kind === 'campos') {
      const cur = kfTrack.keyframes[kfRef.ki].camKind || 'still';
      const t = (val, icon, color, label) => item(icon, color,
        `${label}${cur === val ? ' <span style="opacity:.55;font-size:10px;margin-left:auto;">current</span>' : ''}`,
        `data-camkind="${val}" data-ck-ti="${kfRef.ti}" data-ck-ki="${kfRef.ki}"`);
      head = `<div style="padding:4px 13px 3px; font-size:10px; opacity:.55;">Shot</div>`
        + t('still', 'content_cut', '#f7c873', 'Cut — new shot') + t('spline', 'line_end', '#82aaff', 'Move — linear') + t('curved', 'line_curve', '#7fd88f', 'Move — curved') + sep;
    }
    bodyHtml = head
      + item('edit', kfMeta.color || '#9aa3b2', 'Edit Keyframe', `data-edit-ti="${kfRef.ti}" data-edit-ki="${kfRef.ki}"`)
      + item('delete', '#e58787', 'Delete Keyframe', `data-del-ti="${kfRef.ti}" data-del-ki="${kfRef.ki}"`);
  } else {
    // ── Right-clicked a LANE / empty space → add actions (+ optional "Add Track"). ──
    const addTrackRow = opts.addTrack ? item('playlist_add', '#9aa3b2', 'Add Track', 'data-add-track="1"') + sep : '';
    const laneTrack = (laneTi != null) ? st.tracks[laneTi] : null;
    const laneMeta = laneTrack && AUTHOR_TRACK_KINDS[laneTrack.kind];
    // Reorder the right-clicked track/group up or down (locked + mandatory lanes can't move).
    const moveRows = (laneTrack && !laneTrack.mandatory && !laneTrack.locked)
      ? item('arrow_upward', '#9aa3b2', 'Move Track Up', `data-move-track="-1" data-move-ti="${laneTi}"`)
        + item('arrow_downward', '#9aa3b2', 'Move Track Down', `data-move-track="1" data-move-ti="${laneTi}"`) + sep
      : '';
    let rows = '';
    let heading = `Add at frame ${frame} · ${(frame / 30).toFixed(1)}s`;
    if (laneTrack && laneMeta && !laneMeta.readOnly) {
      heading = `${laneMeta.label} · frame ${frame} · ${(frame / 30).toFixed(1)}s`;
      if (laneTrack.kind === 'actor') {
        const nm = st.cast.find((c) => c.id === laneTrack.castId)?.name || laneTrack.castId;
        heading = `Actor · ${nm} · frame ${frame} · ${(frame / 30).toFixed(1)}s`;
        rows = item('visibility', laneMeta.color, 'Show Keyframe', `data-group-show="show" data-group-ti="${laneTi}"`)
             + item('visibility_off', laneMeta.color, 'Hide Keyframe', `data-group-show="hide" data-group-ti="${laneTi}"`)
             + sep
             + ACTOR_SUB_KINDS.map((k) => item(KIND_ICON[k] || 'add', AUTHOR_TRACK_KINDS[k].color,
                 `Add ${AUTHOR_TRACK_KINDS[k].label} Track`, `data-subtrack="${k}" data-group-ti="${laneTi}"`)).join('');
      } else if (laneTrack.kind === 'campos') {
        const tail = (t) => ` <span style="opacity:.5;font-size:10px;margin-left:auto;">${t}</span>`;
        rows = item('content_cut', '#f7c873', 'Cut Keyframe' + tail('new shot'), `data-cam="still" data-camchan="campos"`)
             + item('line_end', '#82aaff', 'Move Keyframe' + tail('straight'), `data-cam="spline" data-camchan="campos"`)
             + item('line_curve', '#7fd88f', 'Move Keyframe' + tail('curved'), `data-cam="curved" data-camchan="campos"`)
             + sep
             + item('line_curve', '#7fd88f', 'Convert ALL moves → Curved', `data-camall="curved"`)
             + item('line_end', '#82aaff', 'Convert ALL moves → Linear', `data-camall="spline"`);
      } else if (laneTrack.kind === 'camrot') {
        rows = item('center_focus_strong', '#d9a441', 'Aim Keyframe' + ` <span style="opacity:.5;font-size:10px;margin-left:auto;">record look-at</span>`, `data-cam="still" data-camchan="camrot"`);
      } else if (laneTrack.kind === 'camzoom') {
        rows = item('zoom_in', '#f2d493', 'Zoom Keyframe' + ` <span style="opacity:.5;font-size:10px;margin-left:auto;">record zoom</span>`, `data-cam="still" data-camchan="camzoom"`);
      } else {
        rows = item(KIND_ICON[laneTrack.kind] || 'add', laneMeta.color, `${laneMeta.label} Keyframe`, `data-lane-ti="${laneTi}"`);
      }
    } else {
      // Empty space → offer every addable kind (each drops a starter keyframe).
      rows = Object.entries(AUTHOR_TRACK_KINDS).filter(([, m]) => m.addable)
        .map(([k, m]) => item(KIND_ICON[k] || 'add', m.color, `${m.label} Keyframe`, `data-kind="${k}"`)).join('');
    }
    bodyHtml = addTrackRow + moveRows
      + `<div style="padding:4px 13px 6px; font-size:10px; opacity:.55; border-bottom:1px solid #2a2d38;">${heading}</div>`
      + rows;
  }

  const menu = document.createElement('div');
  menu.id = 'cs-seq-ctx';
  menu.style.cssText = `position:fixed; z-index:60; background:#20222c; border:1px solid #3a3a44; border-radius:6px; box-shadow:0 6px 22px rgba(0,0,0,.55); padding:4px 0; min-width:210px;`;
  menu.innerHTML = bodyHtml;
  document.body.appendChild(menu);

  // Position, clamped to the viewport.
  const w = 210, h = menu.offsetHeight || 120;
  menu.style.left = Math.min(clientX, window.innerWidth - w - 8) + 'px';
  menu.style.top = Math.min(clientY, window.innerHeight - h - 8) + 'px';

  menu.querySelectorAll('.cs-ctx-item').forEach((btn) => {
    btn.addEventListener('mouseenter', () => { btn.style.background = '#2f3a52'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
    btn.addEventListener('click', () => {
      if (btn.dataset.delMulti) {
        _authorDeleteMultiSel();
      } else if (btn.dataset.clearMulti) {
        _authorClearMultiSel();
      } else if (btn.dataset.addTrack) {
        _toggleSeqModal('track');                 // same as clicking the toolbar New Track
      } else if (btn.dataset.moveTrack != null) {
        _authorMoveTrack(+btn.dataset.moveTi, +btn.dataset.moveTrack);
      } else if (btn.dataset.camkind != null) {
        // Change an existing camera keyframe's interpolation (Snap / Linear / Curved).
        const t = st.tracks[+btn.dataset.ckTi];
        const kf = t && t.keyframes[+btn.dataset.ckKi];
        if (kf) { kf.camKind = btn.dataset.camkind; _authorEdited(); csAuthorRefresh(); }
      } else if (btn.dataset.editTi != null) {
        _authorSelected = { trackIdx: +btn.dataset.editTi, kfIdx: +btn.dataset.editKi };
        _seqModalView = 'keyframe'; _renderSeqModal();
      } else if (btn.dataset.delTi != null) {
        const t = st.tracks[+btn.dataset.delTi];
        if (t) t.keyframes.splice(+btn.dataset.delKi, 1);
        if (_authorSelected && _authorSelected.trackIdx === +btn.dataset.delTi) { _authorSelected = null; _seqModalView = null; }
        _authorEdited(); csAuthorRefresh();
      } else if (btn.dataset.subtrack != null) {
        _authorAddSubTrack(+btn.dataset.groupTi, btn.dataset.subtrack);
      } else if (btn.dataset.groupShow != null) {
        _authorAddGroupKeyframe(+btn.dataset.groupTi, btn.dataset.groupShow, frame);
      } else if (btn.dataset.camall) _authorSetAllCamKind(btn.dataset.camall);
      else if (btn.dataset.cam) csRecordCameraKeyframe(btn.dataset.cam, frame, btn.dataset.camchan || 'all');
      else if (btn.dataset.laneTi != null) _authorAddKeyframeToTrack(+btn.dataset.laneTi, frame);
      else if (btn.dataset.kind) _authorAddKeyframe(btn.dataset.kind, frame);
      _authorCloseContextMenu();
    });
  });

  // Close on any outside click / escape.
  const closer = (ev) => {
    if (!menu.contains(ev.target)) { _authorCloseContextMenu(); cleanup(); }
  };
  const esc = (ev) => { if (ev.key === 'Escape') { _authorCloseContextMenu(); cleanup(); } };
  const cleanup = () => {
    document.removeEventListener('mousedown', closer, true);
    document.removeEventListener('keydown', esc, true);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', closer, true);
    document.addEventListener('keydown', esc, true);
  }, 0);
}

// ── Marquee multi-select (shift+drag a box over keyframes) ────────────────────
function _authorClearMultiSel() {
  _authorMultiSel.clear();
  document.querySelectorAll('.cs-seq-dot.cs-kf-multi').forEach((d) => d.classList.remove('cs-kf-multi'));
}

// Re-apply the selected highlight to the live dots (call after every sequencer rebuild).
function _applyMultiSelHighlight() {
  document.querySelectorAll('.cs-seq-dot.cs-kf-multi').forEach((d) => d.classList.remove('cs-kf-multi'));
  _authorMultiSel.forEach((ref) => {
    const [ti, ki] = ref.split(':');
    document.querySelector(`.cs-seq-dot[data-author-ti="${ti}"][data-author-ki="${ki}"]`)?.classList.add('cs-kf-multi');
  });
}

// Shift+drag on empty timeline → draw a box; on release, select every keyframe dot inside it.
function _authorStartMarquee(e) {
  _authorClearMultiSel();
  const x0 = e.clientX, y0 = e.clientY;
  const box = document.createElement('div');
  box.className = 'cs-seq-marquee';
  document.body.appendChild(box);
  const draw = (ev) => {
    const x = Math.min(x0, ev.clientX), y = Math.min(y0, ev.clientY);
    box.style.left = x + 'px'; box.style.top = y + 'px';
    box.style.width = Math.abs(ev.clientX - x0) + 'px'; box.style.height = Math.abs(ev.clientY - y0) + 'px';
  };
  const onUp = (ev) => {
    document.removeEventListener('mousemove', draw);
    document.removeEventListener('mouseup', onUp);
    const rx0 = Math.min(x0, ev.clientX), ry0 = Math.min(y0, ev.clientY);
    const rx1 = Math.max(x0, ev.clientX), ry1 = Math.max(y0, ev.clientY);
    document.querySelectorAll('.cs-seq-dot[data-author-ti]').forEach((d) => {
      const r = d.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx >= rx0 && cx <= rx1 && cy >= ry0 && cy <= ry1) _authorMultiSel.add(`${d.dataset.authorTi}:${d.dataset.authorKi}`);
    });
    box.remove();
    _applyMultiSelHighlight();
  };
  document.addEventListener('mousemove', draw);
  document.addEventListener('mouseup', onUp);
}

// Delete every keyframe in the marquee selection (highest index first so ki stays valid).
function _authorDeleteMultiSel() {
  const st = _authorState; if (!st || !_authorMultiSel.size) return;
  const byTrack = new Map();
  _authorMultiSel.forEach((ref) => {
    const [ti, ki] = ref.split(':').map(Number);
    if (!byTrack.has(ti)) byTrack.set(ti, []);
    byTrack.get(ti).push(ki);
  });
  for (const [ti, kis] of byTrack) {
    const track = st.tracks[ti]; if (!track || track.readOnly) continue;
    kis.sort((a, b) => b - a).forEach((ki) => track.keyframes.splice(ki, 1));
  }
  _authorClearMultiSel();
  _authorSelected = null; _seqModalView = null;
  _authorEdited(); csAuthorRefresh();
}

// Delete the current keyframe selection — the marquee group if any, else the single open one.
// Returns true if something was deleted (so the caller can preventDefault the Delete key).
function _authorDeleteSelectedKeyframes() {
  if (_authorMultiSel.size) { _authorDeleteMultiSel(); return true; }
  const sel = _authorSelected, st = _authorState;
  if (sel && st) {
    const track = st.tracks[sel.trackIdx], kf = track && track.keyframes[sel.kfIdx];
    if (kf && !track.readOnly) {
      track.keyframes.splice(sel.kfIdx, 1);
      _authorSelected = null; _seqModalView = null;
      document.getElementById('cs-seq-modal')?.remove();
      _authorEdited(); csAuthorRefresh();
      return true;
    }
  }
  return false;
}

// Click-drag an author keyframe dot horizontally to change its frame. A click
// with no drag falls through to selecting it (opens the detail popover). If the dot is part
// of a marquee selection, the whole group moves together.
function _authorStartKeyframeDrag(e, dot) {
  const st = _authorState;
  const ti = +dot.dataset.authorTi, ki = +dot.dataset.authorKi;
  const track = st.tracks[ti];
  const kf = track && track.keyframes[ki];
  const openDetail = () => {
    _authorSelected = { trackIdx: ti, kfIdx: ki };
    _seqModalView = 'keyframe';
    _renderSeqModal();
    // Camera keyframes snap the timeline cursor to their frame so the viewport previews that
    // shot. Only camera — other kinds leave the cursor where it is.
    if (kf && track && CAMERA_SUB_KINDS.includes(track.kind)) { csFrame = kf.frame | 0; csUpdatePlayhead(); }
  };
  if (!kf || track.readOnly) { openDetail(); return; }  // read-only → select only

  const ref = `${ti}:${ki}`;
  const isGroup = _authorMultiSel.size > 1 && _authorMultiSel.has(ref);
  if (!isGroup && _authorMultiSel.size) _authorClearMultiSel();   // drag outside the group → clear it

  const total = Math.max(1, csData.totalFrames || 1);
  const startX = e.clientX;
  let moved = false;
  const tip = _authorMakeDragTip();

  if (isGroup) {
    // Move the WHOLE marquee selection by one shared frame delta.
    const members = [];
    let minOrigin = Infinity;
    _authorMultiSel.forEach((r) => {
      const [gti, gki] = r.split(':').map(Number);
      const gtr = st.tracks[gti], gkf = gtr && gtr.keyframes[gki];
      if (!gkf || gtr.readOnly) return;
      const gdot = document.querySelector(`.cs-seq-dot[data-author-ti="${gti}"][data-author-ki="${gki}"]`);
      const gspan = gdot?.previousElementSibling?.classList.contains('cs-seq-span') ? gdot.previousElementSibling : null;
      members.push({ kf: gkf, dot: gdot, span: gspan, origin: gkf.frame | 0 });
      if ((gkf.frame | 0) < minOrigin) minOrigin = gkf.frame | 0;
    });
    const draggedOrigin = kf.frame | 0;
    const gMove = (ev) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      if (!moved) { _authorSelected = null; _seqModalView = null; document.getElementById('cs-seq-modal')?.remove(); }
      moved = true;
      const delta = Math.max(_frameFromClientX(ev.clientX) - draggedOrigin, -minOrigin);   // keep all ≥ frame 0
      for (const m of members) {
        const f = m.origin + delta; m.kf.frame = f;
        const x = (f / total) * 100;
        if (m.dot) { m.dot.style.left = x + '%'; m.dot.dataset.frame = f; }
        if (m.span) m.span.style.left = x + '%';
      }
      const dr = dot.getBoundingClientRect();
      _authorMoveDragTip(tip, dr.left + dr.width / 2, dr.top, draggedOrigin + delta, false);
    };
    const gUp = () => {
      document.removeEventListener('mousemove', gMove);
      document.removeEventListener('mouseup', gUp);
      tip.remove();
      if (moved) { _authorEdited(); csAuthorRefresh(); }
    };
    document.addEventListener('mousemove', gMove);
    document.addEventListener('mouseup', gUp);
    return;
  }

  const span = (dot.previousElementSibling && dot.previousElementSibling.classList.contains('cs-seq-span'))
    ? dot.previousElementSibling : null;
  // Collect snap targets: every OTHER keyframe's start frame + its end frame
  // (start + dur/frames span), plus frame 0 and totalFrames.
  const snapTargets = _authorSnapTargets(ti, ki);
  const bodyRect = () => document.getElementById('cs-seq-body')?.getBoundingClientRect();

  const onMove = (ev) => {
    if (!moved && Math.abs(ev.clientX - startX) < 3) return;
    if (!moved) {
      // First real movement — close any open keyframe modal (from this or another kf).
      _authorSelected = null; _seqModalView = null;
      document.getElementById('cs-seq-modal')?.remove();
    }
    moved = true;
    let f = _frameFromClientX(ev.clientX);
    // Snap: if a target frame is within CS_SNAP_PX screen pixels, jump to it.
    if (csSnap && snapTargets.length) {
      const r = bodyRect();
      const pxPerFrame = r ? (r.width / total) : 1;
      let best = null, bestPx = CS_SNAP_PX;
      for (const t of snapTargets) {
        const px = Math.abs((t - f) * pxPerFrame);
        if (px <= bestPx) { bestPx = px; best = t; }
      }
      if (best != null) f = best;
    }
    f = Math.max(0, f);
    kf.frame = f;
    const x = (f / total) * 100;
    dot.style.left = x + '%';
    dot.dataset.frame = f;
    if (span) span.style.left = x + '%';
    // Live frame tooltip above the dot.
    const dr = dot.getBoundingClientRect();
    _authorMoveDragTip(tip, dr.left + dr.width / 2, dr.top, f, csSnap && snapTargets.includes(f));
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    tip.remove();
    if (moved) { _authorEdited(); csAuthorRefresh(); }
    else { openDetail(); }
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Frames the dragged keyframe can snap to: every other keyframe's start + end
// (start + span), deduped, sorted.
function _authorSnapTargets(dragTi, dragKi) {
  const st = _authorState;
  const set = new Set([0, Math.max(1, (csData && csData.totalFrames) | 0)]);
  st.tracks.forEach((t, ti) => {
    (t.keyframes || []).forEach((kf, ki) => {
      if (ti === dragTi && ki === dragKi) return;   // don't snap to self
      const f = kf.frame | 0;
      set.add(f);
      const span = (kf.dur | 0) || (kf.frames | 0);
      if (span > 0) set.add(f + span);              // end of a fade/duration bar
    });
  });
  return [...set];
}

// Small floating tooltip that follows the dragged dot, showing its frame.
function _authorMakeDragTip() {
  const el = document.createElement('div');
  el.id = 'cs-drag-tip';
  el.style.cssText = 'position:fixed; z-index:70; background:#0e0f14; color:#fff; border:1px solid #3a3a44; border-radius:4px; padding:2px 6px; font:600 11px/1.2 Roboto,sans-serif; pointer-events:none; transform:translate(-50%,-140%); white-space:nowrap;';
  document.body.appendChild(el);
  return el;
}
function _authorMoveDragTip(el, x, y, frame, snapped) {
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.innerHTML = `frame ${frame} · ${(frame / 30).toFixed(2)}s` +
    (snapped ? ` <span style="color:#7fd88f;">◆ snap</span>` : '');
}

// Add a keyframe of `kind` at `frame` — creating its track if needed, then
// selecting it so the detail popover opens for immediate editing. `castId`
// (optional) picks which cast member for cast-required tracks; defaults to owner.
function _authorAddKeyframe(kind, frame, castId) {
  const st = _authorState;
  const meta = AUTHOR_TRACK_KINDS[kind];
  if (!meta) return;

  // Find (or create) the target track.
  let track;
  if (meta.castRequired) {
    const cid = castId || st.owner || 'npc';
    track = st.tracks.find((t) => t.kind === kind && t.castId === cid && !t.readOnly);
    if (!track) { track = { kind, castId: cid, keyframes: [] }; st.tracks.push(track); }
  } else {
    track = st.tracks.find((t) => t.kind === kind && !t.readOnly);
    if (!track) { track = { kind, keyframes: [] }; st.tracks.push(track); }
  }

  _pushKeyframe(track, kind, frame);
}

// A song dropped from the Asset Browser (drag a Music-tab row onto the sequencer):
// find or create the Music track, key the song at frame 0 — updating an existing
// frame-0 keyframe rather than stacking a duplicate — then select it so the detail
// popover opens with the song already chosen.
function _authorDropMusic(song) {
  const st = _authorState;
  const id = song && song.musicId != null ? song.musicId | 0 : -1;
  if (!st || id < 0) return;
  csEnsureAudioCatalogs();                       // popover's song dropdown needs the catalog
  let track = st.tracks.find((t) => t.kind === 'music' && !t.readOnly);
  if (!track) { track = { kind: 'music', keyframes: [] }; st.tracks.push(track); }
  let ki = track.keyframes.findIndex((k) => (k.frame | 0) === 0);
  if (ki >= 0) {
    track.keyframes[ki] = { ...track.keyframes[ki], song: id };
  } else {
    track.keyframes.push({ frame: 0, song: id, slot: 0 });
    track.keyframes.sort((a, b) => a.frame - b.frame);
    ki = track.keyframes.findIndex((k) => (k.frame | 0) === 0);
  }
  _authorSelected = { trackIdx: st.tracks.indexOf(track), kfIdx: ki };
  _seqModalView = 'keyframe';
  _authorEdited();
  csAuthorRefresh();
}

// Default keyframe fields per kind (compile-ready) + push into a specific track.
function _defaultKfFields(kind) {
  const st = _authorState;
  const owner = st.owner || (st.cast.find((c) => c.id !== 'player')?.id) || 'npc';
  // Dialog/Face keyframes carry their own speaker/actor (consolidated tracks).
  if (kind === 'dialog') return { speaker: owner, line: st.lines[0]?.id || '' };
  if (kind === 'face')   return { actor: owner, target: 'player', talk: false };
  if (kind === 'position') return { actor: owner };   // no marker/pos yet — "— none —" by default; user picks one
  if (kind === 'npc' || kind === 'actor') return { action: 'show' };
  if (kind === 'anim')   return { actor: owner, anim: '' };
  if (kind === 'music')  return { song: 0, slot: 0 };
  if (kind === 'sfx')    return { sound: 0 };
  if (kind === 'fade')   return { kind: 'in', dur: 30 };
  if (kind === 'wait')   return { frames: 30 };
  return {};
}
function _pushKeyframe(track, kind, frame) {
  const st = _authorState;
  const kf = { frame, ..._defaultKfFields(kind) };
  // Sub-track keyframes inherit the group's actor, so the modal drops the picker and
  // the compile reads the right speaker/actor.
  if (track.castId) {
    if (kind === 'dialog') kf.speaker = track.castId;
    else if (kind === 'face' || kind === 'position' || kind === 'anim') kf.actor = track.castId;
  }
  track.keyframes.push(kf);
  track.keyframes.sort((a, b) => a.frame - b.frame);
  _authorSelected = { trackIdx: st.tracks.indexOf(track), kfIdx: track.keyframes.indexOf(kf) };
  _seqModalView = 'keyframe';
  _authorEdited();
  csAuthorRefresh();
}

// Add a keyframe directly into an existing track (by index) at `frame`.
function _authorAddKeyframeToTrack(ti, frame) {
  const track = _authorState && _authorState.tracks[ti];
  if (!track || track.readOnly) return;
  _pushKeyframe(track, track.kind, frame);
}

// Add a Face/Dialog/Position/Anim SUB-track under an Actor group (inherits its castId),
// inserted right after the group's existing sub-tracks. Expands the group.
function _authorAddSubTrack(groupTi, kind) {
  const st = _authorState;
  const group = st && st.tracks[groupTi];
  if (!group || group.kind !== 'actor' || !ACTOR_SUB_KINDS.includes(kind)) return;
  const cid = group.castId;
  if (!st.tracks.some((t) => t.kind === kind && t.castId === cid)) {
    let insertAt = groupTi + 1;
    for (let i = groupTi + 1; i < st.tracks.length; i++) {
      const t = st.tracks[i];
      if (t.castId === cid && ACTOR_SUB_KINDS.includes(t.kind)) insertAt = i + 1; else break;
    }
    st.tracks.splice(insertAt, 0, { kind, castId: cid, keyframes: [] });
  }
  group.collapsed = false;
  _authorEdited(); csAuthorRefresh();
}

// Reorder a track up (dir<0) or down (dir>0) by one "block". A block = an actor group + its
// sub-tracks, or a single flat track. Camera / locked Wait / Player never move and can't be
// jumped over. A sub-track reorders only WITHIN its own group.
function _authorMoveTrack(ti, dir) {
  const st = _authorState; if (!st) return;
  const tracks = st.tracks;
  const t = tracks[ti]; if (!t || t.mandatory || t.locked) return;

  // Sub-track → swap with the adjacent sub-track of the SAME group.
  if (ACTOR_SUB_KINDS.includes(t.kind) && t.castId) {
    const nb = tracks[ti + dir];
    if (nb && ACTOR_SUB_KINDS.includes(nb.kind) && nb.castId === t.castId) {
      [tracks[ti], tracks[ti + dir]] = [tracks[ti + dir], tracks[ti]];
      _authorEdited(); csAuthorRefresh();
    }
    return;
  }

  // Whole-block move: partition tracks into blocks, then swap this block with its neighbour.
  const blocks = [];
  for (let i = 0; i < tracks.length; ) {
    const tr = tracks[i];
    if (tr.kind === 'actor') {
      let j = i + 1;
      while (j < tracks.length && ACTOR_SUB_KINDS.includes(tracks[j].kind) && tracks[j].castId === tr.castId) j++;
      blocks.push({ s: i, e: j, movable: !tr.mandatory && !tr.locked });
      i = j;
    } else {
      blocks.push({ s: i, e: i + 1, movable: !tr.mandatory && !tr.locked });
      i++;
    }
  }
  const bi = blocks.findIndex((b) => ti >= b.s && ti < b.e);
  const b = blocks[bi], nb = blocks[bi + dir];
  if (!b || !b.movable || !nb || !nb.movable) return;
  const A = tracks.slice(b.s, b.e), B = tracks.slice(nb.s, nb.e);
  if (dir < 0) tracks.splice(nb.s, A.length + B.length, ...A, ...B);   // this block jumps above the previous
  else         tracks.splice(b.s, A.length + B.length, ...B, ...A);    // next block jumps above this one
  _authorEdited(); csAuthorRefresh();
}

// Add a show/hide keyframe to an Actor group (its own keyframes are the actor's visibility).
function _authorAddGroupKeyframe(groupTi, action, frame) {
  const st = _authorState;
  const group = st && st.tracks[groupTi];
  if (!group || group.kind !== 'actor') return;
  const kf = { frame, action };
  group.keyframes.push(kf);
  group.keyframes.sort((a, b) => a.frame - b.frame);
  _authorSelected = { trackIdx: groupTi, kfIdx: group.keyframes.indexOf(kf) };
  _seqModalView = 'keyframe';
  _authorEdited(); csAuthorRefresh();
}

// Public getter — events-panel.invalidateEvents checks this so it doesn't
// slam the sequencer shut while the user is mid-edit.
export function csIsAuthorMode() { return csAuthorMode; }

// Author-mode click on a dot → select the keyframe (open detail popover).
// Click on empty lane → add a new keyframe at that frame.
function _authorHandleClick(e) {
  if (!csAuthorMode) return false;
  // Dot selection + drag are handled in the mousedown listener
  // (_authorStartKeyframeDrag). Swallow clicks on dots here so we don't
  // double-open the detail popover.
  if (e.target.closest('.cs-seq-dot')) return true;
  return false;
}

// Map a clientX over the track body to a frame and seek there.
function csSeekToClientX(clientX) {
  const body = document.getElementById('cs-seq-body');
  if (!body || !csData) return;
  const r = body.getBoundingClientRect(), total = Math.max(1, csData.totalFrames || 1);
  csFrame = Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1))) * total;
  if (csFrameSnap > 0) csFrame = Math.min(total, Math.round(csFrame / csFrameSnap) * csFrameSnap);
  csUpdatePlayhead();
}

// Zoom the timeline horizontally.
function csZoomBy(mult, anchorClientX) {
  const scrollx = document.getElementById('cs-seq-scrollx'), body = document.getElementById('cs-seq-body');
  const row = document.querySelector('.cs-seq-scrollrow');
  if (!scrollx || !body || !row || !csData) return;
  const prev = csZoom;
  csZoom = Math.min(16, Math.max(1, csZoom * mult));
  if (Math.abs(csZoom - prev) < 1e-6) return;
  const vw = scrollx.clientWidth || 1;
  const GUT = 62;                                       // bookend gutter column width (each side)
  const bodyW = (z) => Math.max(1, vw * z - 2 * GUT);   // body width at a given zoom
  row.style.width = `${csZoom * 100}%`;                 // row carries the zoom; body is flex:1 between gutters
  // Re-render the ruler so its tick density adapts to the new zoom (30s → 15s → 5s …).
  const _ruler = body.querySelector('.cs-seq-ruler');
  if (_ruler) _ruler.innerHTML = csRulerTicks(Math.max(1, csData.totalFrames || 1), csData.fps || 30);
  if (anchorClientX == null) {
    const total = Math.max(1, csData.totalFrames || 1), frac = Math.min(1, Math.max(0, csFrame / total));
    scrollx.scrollLeft = GUT + frac * bodyW(csZoom) - vw / 2;
  } else {
    const ax = anchorClientX - scrollx.getBoundingClientRect().left;
    const frac = (scrollx.scrollLeft + ax - GUT) / bodyW(prev);
    scrollx.scrollLeft = GUT + frac * bodyW(csZoom) - ax;
  }
}

// Sample every camera shot's eye position across its duration → per-axis polyline segments + ranges.
const CS_CURVE_H = 96, CS_FOV_H = 48, CS_CURVE_VW = 1000, CS_AXES = [['X', '#e06c75'], ['Y', '#7fd88f'], ['Z', '#82aaff']];
function csCameraSamples(beats, totalArg) {
  const total = Math.max(1, totalArg || (csData && csData.totalFrames) || 1), DEG = 180 / Math.PI;
  const shots = (beats || (csData && csData.beats) || []).filter((b) => b.camera && b.camera.length);
  const segs = [];
  const eMin = [Infinity, Infinity, Infinity], eMax = [-Infinity, -Infinity, -Infinity];
  const rMin = [Infinity, Infinity, Infinity], rMax = [-Infinity, -Infinity, -Infinity];
  let fMin = Infinity, fMax = -Infinity;
  // Carry yaw/pitch ACROSS shots (not just within one) so the derived heading doesn't wrap
  // ±360° at a shot boundary — that wrap was the "spike". Also hold the last angle when the
  // look point collapses onto the eye (a degenerate keyframe → atan2 of a zero vector).
  let prevYaw = null, prevPitch = 0;
  for (const shot of shots) {
    const dur = Math.max(1, shot.dur || 1), N = 24, seg = [];
    const smooth = (shot.smooth != null) ? shot.smooth : (shot.camera[0] || {}).mode;
    for (let k = 0; k <= N; k++) {
      const lt = k / N, s = csSampleShot(shot.camera, _csEase(lt, smooth)), eye = s.eye, look = s.look || eye;
      const dx = look[0] - eye[0], dy = look[1] - eye[1], dz = look[2] - eye[2];
      const horiz = Math.hypot(dx, dz);
      let yaw, pitch;
      if (horiz < 1e-3 && Math.abs(dy) < 1e-3) {   // look ≈ eye → keep the previous angle
        yaw = prevYaw != null ? prevYaw : 0; pitch = prevPitch;
      } else {
        yaw = Math.atan2(dx, dz) * DEG;
        if (prevYaw != null) { while (yaw - prevYaw > 180) yaw -= 360; while (yaw - prevYaw < -180) yaw += 360; }
        pitch = Math.atan2(dy, horiz) * DEG;
      }
      prevYaw = yaw; prevPitch = pitch;
      const rot = [pitch, yaw, 0];
      const fov = _csFocalToFov(Number(s.fov) || 350);   // focal length → FOV° for the curve graph
      seg.push({ frame: shot.frame + lt * dur, eye, rot, fov });
      for (let a = 0; a < 3; a++) {
        if (eye[a] < eMin[a]) eMin[a] = eye[a]; if (eye[a] > eMax[a]) eMax[a] = eye[a];
        if (rot[a] < rMin[a]) rMin[a] = rot[a]; if (rot[a] > rMax[a]) rMax[a] = rot[a];
      }
      if (fov < fMin) fMin = fov; if (fov > fMax) fMax = fov;
    }
    segs.push(seg);
  }
  return { segs, eMin, eMax, rMin, rMax, fMin, fMax, total };
}

// SVG of the camera curves.
function csCurvesSvg(beats, totalArg) {
  const { segs, eMin, eMax, rMin, rMax, total } = csCameraSamples(beats, totalArg);
  if (!segs.length) return `<div class="cs-seq-curves" style="height:${CS_CURVE_H}px"><div class="cs-seq-curves-empty">No camera paths in this cutscene</div></div>`;
  const pad = 10;
  // Center each axis on its own midpoint with a MINIMUM span, so a few degrees of
  // mouse-look wobble (or a couple of world units) aren't stretched to fill the whole
  // lane — that normalization was turning smooth paths into sawtooths.
  const EYE_MIN_SPAN = 6, ROT_MIN_SPAN = 45;    // world units / degrees
  const eMid = [0, 1, 2].map((a) => (eMin[a] + eMax[a]) / 2);
  const rMid = [0, 1, 2].map((a) => (rMin[a] + rMax[a]) / 2);
  const eRange = [0, 1, 2].map((a) => Math.max(eMax[a] - eMin[a], EYE_MIN_SPAN));
  const rRange = [0, 1, 2].map((a) => Math.max(rMax[a] - rMin[a], ROT_MIN_SPAN));
  const mapX = (frame) => (frame / total) * CS_CURVE_VW;
  const mapY = (v, mid, rng) => CS_CURVE_H - pad - ((v - (mid - rng / 2)) / rng) * (CS_CURVE_H - 2 * pad);
  let paths = '';
  CS_AXES.forEach(([, color], a) => {
    for (const seg of segs) {
      const ePts = seg.map((p) => `${mapX(p.frame).toFixed(1)},${mapY(p.eye[a], eMid[a], eRange[a]).toFixed(1)}`).join(' ');
      paths += `<polyline points="${ePts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
      const rPts = seg.map((p) => `${mapX(p.frame).toFixed(1)},${mapY(p.rot[a], rMid[a], rRange[a]).toFixed(1)}`).join(' ');
      paths += `<polyline points="${rPts}" fill="none" stroke="${color}" stroke-width="1.3" stroke-dasharray="3 2" stroke-linejoin="round" vector-effect="non-scaling-stroke" opacity="0.8"/>`;
    }
  });
  return `<div class="cs-seq-curves" style="height:${CS_CURVE_H}px"><svg viewBox="0 0 ${CS_CURVE_VW} ${CS_CURVE_H}" preserveAspectRatio="none">${paths}</svg></div>`;
}

// FOV track (amber).
function csFovSvg(beats, totalArg) {
  const { segs, fMin, fMax, total } = csCameraSamples(beats, totalArg);
  if (!segs.length) return '';
  // Center on the midpoint with a minimum span (FOV is decidegrees; 100 = 10°) so a
  // near-constant FOV reads as a calm flat line, not amplified noise.
  const fMid = (fMin + fMax) / 2, rng = Math.max(fMax - fMin, 100);
  const pad = 8;
  const mapX = (frame) => (frame / total) * CS_CURVE_VW;
  const mapY = (v) => CS_FOV_H - pad - ((v - (fMid - rng / 2)) / rng) * (CS_FOV_H - 2 * pad);
  let paths = '';
  for (const seg of segs) {
    const pts = seg.map((p) => `${mapX(p.frame).toFixed(1)},${mapY(p.fov).toFixed(1)}`).join(' ');
    paths += `<polyline points="${pts}" fill="none" stroke="#f7c873" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  }
  return `<div class="cs-seq-curves" style="height:${CS_FOV_H}px"><svg viewBox="0 0 ${CS_CURVE_VW} ${CS_FOV_H}" preserveAspectRatio="none">${paths}</svg></div>`;
}

function csFovLabelHtml(beats, totalArg) {
  const { fMin, fMax } = csCameraSamples(beats, totalArg);
  const range = isFinite(fMin) ? `${(fMin / 8).toFixed(0)}–${(fMax / 8).toFixed(0)}°` : '';
  return `<div class="cs-seq-curve-label" style="height:${CS_FOV_H}px"><div class="cs-seq-curve-legend"><span><i style="background:#f7c873"></i>FOV</span></div><div class="cs-seq-curve-key"><span>${range}</span></div></div>`;
}
function csCurveLabelHtml() {
  const legend = CS_AXES.map(([a, c]) => `<span><i style="background:${c}"></i>${a}</span>`).join('');
  return `<div class="cs-seq-curve-label" style="height:${CS_CURVE_H}px">`
    + `<div class="cs-seq-curve-legend">${legend}</div>`
    + `<div class="cs-seq-curve-key"><span><i></i>pos</span><span><i class="dash"></i>rot</span></div>`
    + `</div>`;
}

// ── Playback engine ───────────────────────────────────────────────────────────
export function csStop() { csPlaying = false; if (csRaf) cancelAnimationFrame(csRaf); csRaf = null; csReflectPlayBtn(); }
// Nudge the playhead by ±1 frame (Skip Previous / Skip Next). Pauses playback first.
function csStepFrame(delta) {
  if (csPlaying) csStop();
  const total = Math.max(1, (csData && csData.totalFrames) || 1);
  csFrame = Math.max(0, Math.min(total, (csFrame | 0) + delta));
  csUpdatePlayhead();
}
function csTogglePlay() { csPlaying ? csStop() : csPlay(); }
function csPlay() {
  if (!csData) return;
  if (csFrame >= csData.totalFrames) csFrame = 0;
  csPlaying = true; csLastT = performance.now(); csReflectPlayBtn();
  const tick = (t) => {
    if (!csPlaying) return;
    csFrame += ((t - csLastT) / 1000) * (csData.fps || 30);
    csLastT = t;
    if (csFrame >= csData.totalFrames) { csFrame = csData.totalFrames; csPlaying = false; }
    csUpdatePlayhead();
    if (csPlaying) csRaf = requestAnimationFrame(tick); else csReflectPlayBtn();
  };
  csRaf = requestAnimationFrame(tick);
}
function csReflectPlayBtn() {
  const b = document.getElementById('cs-seq-play');
  if (b) b.innerHTML = `<span class="material-symbols-outlined">${csPlaying ? 'pause' : 'play_arrow'}</span>`;
}
function csUpdatePlayhead() {
  if (!csData) return;
  const fps = csData.fps || 30, f = csFrame, total = Math.max(1, csData.totalFrames || 1);
  const frac = Math.min(1, Math.max(0, f / total));
  const ph = document.getElementById('cs-seq-playhead'); if (ph) ph.style.left = `${frac * 100}%`;
  if (csPlaying && csZoom > 1) { const sx = document.getElementById('cs-seq-scrollx'); if (sx) sx.scrollLeft = 62 + frac * (sx.scrollWidth - 124) - sx.clientWidth / 2; }   // 62px bookend gutters flank the body
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('cs-seq-frame', Math.round(f));
  set('cs-seq-time', `${(f / fps).toFixed(1)} / ${(total / fps).toFixed(1)}s`);
  // Frame · time pill — floats above the sequencer bar at the playhead's x, ONLY while
  // scrubbing. Fixed-positioned so it escapes the graph's overflow.
  // Lives on document.body — .cs-seq has a backdrop-filter, which would otherwise be the
  // containing block for this position:fixed pill and push its viewport coords off-screen.
  let tip = document.getElementById('cs-seq-ph-tip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'cs-seq-ph-tip'; tip.className = 'cs-seq-ph-tip'; document.body.appendChild(tip); }
  if (csDragging && ph) {
    const phr = ph.getBoundingClientRect();
    const seqTop = csSeqEl ? csSeqEl.getBoundingClientRect().top : phr.top;
    tip.textContent = `f${Math.round(f)} · ${(f / fps).toFixed(2)}s`;
    tip.style.left = `${phr.left + phr.width / 2}px`;
    tip.style.top = `${seqTop - 34}px`;        // float above the sequencer toolbar
    tip.style.display = 'block';
  } else {
    tip.style.display = 'none';
  }
  // Author mode: glide the camera body along the authored path so scrubbing the
  // playhead illustrates the shot movement (no-op while piloting / no keyframes).
  if (csAuthorMode) csDriveCameraToFrame(f);
  // Sticky scene state — last value at/before the playhead.
  let line = '', shot = '—', cam = '', music = '';
  for (const b of csData.beats) {
    if (b.frame > f) break;
    if (b.type === 'dialogue') line = b.text || (b.msgId != null ? `msg ${b.msgId}` : '');
    else if (b.type === 'shot' || (b.type === 'task' && b.camera && b.camera.length)) shot = b.tag || 'shot';
    else if (b.type === 'taskEnd' && b.tag === shot) shot = '—';
    else if (b.type === 'camera') cam = (b.name === 'lock_player') ? 'player locked' : (b.name === 'camera' ? 'camera control' : (b.name || cam));
    else if (b.type === 'music') music = b.name || music;
    else if (b.type === 'end') { shot = '—'; cam = 'released'; }
  }
  // Instantaneous active beats (window contains the playhead) → dot glow + now-playing chips.
  const active = [];
  for (const dot of csDots) dot.el.classList.toggle('active', dot.frame <= f && f < dot.frame + Math.max(dot.span, 1));
  for (const b of csData.beats) { const sp = Math.max(csBeatSpan(b), 1); if (b.frame <= f && f < b.frame + sp) active.push(b); }
  csRenderNow(line, shot, cam, music, active, fps);
  csApplyCamera();
  csUpdateActorVisibility();
  csUpdateActorMotion();
  csUpdateActorAnims();
  csUpdateVfx();
}

// "Now playing" box.
function csRenderNow(line, shot, cam, music, active, fps) {
  const el = document.getElementById('cs-seq-now'); if (!el) return;
  const chips = [];
  if (shot && shot !== '—') chips.push(`<span class="cs-now-chip" style="--cc:#c792ea">shot ${_evtEsc(shot)}</span>`);
  if (cam) chips.push(`<span class="cs-now-chip" style="--cc:#f7c873">${_evtEsc(cam)}</span>`);
  if (music) chips.push(`<span class="cs-now-chip" style="--cc:#ff8fcf">${_evtEsc(music)}</span>`);
  for (const b of active) {
    if (b.type === 'dialogue' || b.type === 'shot' || b.type === 'camera' || b.type === 'music') continue;
    const [lab, color] = CS_BEAT_META[b.type] || [b.type, '#888'];
    const det = csBeatDetail(b, fps);
    chips.push(`<span class="cs-now-chip" style="--cc:${color}">${_evtEsc(lab)}${det ? ': ' + _evtEsc(det) : ''}</span>`);
  }
  el.innerHTML =
    `<div class="cs-now-line">${line ? _evtEsc(line) : '<span class="cs-now-empty">—</span>'}</div>`
    + `<div class="cs-now-chips">${chips.join('')}</div>`;
}

// ── Camera ────────────────────────────────────────────────────────────────────
// Position the viewport's cutscene camera from the active shot's decoded camera route.
function csApplyCamera() {
  // Author mode owns the camera itself: piloting sets cutsceneCamActive, and
  // csDriveCameraToFrame glides it along the authored path on scrub. This retail
  // playback path must NOT run here or it would flip the view off the piloted
  // camera (and strand the fly controls) the instant you touch the timeline.
  if (csAuthorMode) return;
  const zoneRoot = _getZoneRoot();
  if (!csData || !csCamEnabled || !zoneRoot) { cutsceneCamActive = false; return; }
  let shot = null;
  for (const b of csData.beats) {
    if (b.frame > csFrame) break;
    if (b.camera && b.camera.length) shot = b;
    else if (b.type === 'end') shot = null;
  }
  if (!shot) { cutsceneCamActive = false; return; }
  const localT = Math.max(0, Math.min(1, (csFrame - shot.frame) / Math.max(1, shot.dur || 1)));
  const s = csSampleShot(shot.camera, _csEase(localT, (shot.camera[0] || {}).mode));  // route SmoothingType easing
  _csEye.set(s.eye[0], s.eye[1], s.eye[2]); zoneRoot.localToWorld(_csEye);
  _csLook.set(s.look[0], s.look[1], s.look[2]); zoneRoot.localToWorld(_csLook);
  csCamera.position.copy(_csEye);
  csCamera.up.set(0, 1, 0);
  csCamera.lookAt(_csLook);
  // s.fov is the route's FOCAL LENGTH (larger = zoom IN); convert to a three.js vertical FOV
  // angle via 2·atan2(192, focal) so the preview zooms the same direction/amount as the game.
  const fov = _csFocalToFov(s.fov);
  if (Math.abs(csCamera.fov - fov) > 0.01) { csCamera.fov = fov; csCamera.updateProjectionMatrix(); }
  cutsceneCamActive = true;
}

// Catmull-Rom spline through p1→p2 (p0,p3 = neighbours) at u∈[0,1]. Used for Curved
// (interpMode 1) camera routes so the path arcs through its points instead of dog-legging.
function _csCatmull(p0, p1, p2, p3, u) {
  // Centripetal Catmull-Rom (alpha = 0.5): knots spaced by sqrt(distance). Unlike the uniform
  // variant this never loops or overshoots at sharp turns — the camera arcs through its points
  // without swinging past them. Barry-Goldman pyramidal evaluation.
  const knot = (a, b) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])) || 1e-4;
  const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
  const t = t1 + u * (t2 - t1);
  const lerp = (a, b, s) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
  const A1 = lerp(p0, p1, (t - t0) / (t1 - t0));
  const A2 = lerp(p1, p2, (t - t1) / (t2 - t1));
  const A3 = lerp(p2, p3, (t - t2) / (t3 - t2));
  const B1 = lerp(A1, A2, (t - t0) / (t2 - t0));
  const B2 = lerp(A2, A3, (t - t1) / (t3 - t1));
  return lerp(B1, B2, (t - t1) / (t2 - t1));
}

// Sample a shot's keyframes at normalised t. Linear by default; a Curved route (mode 1,
// 3+ points) splines eye/look through its control points. FOV stays linear (avoids overshoot).
function csSampleShot(kfs, t) {
  if (kfs.length === 1 || t <= kfs[0].time) return kfs[0];
  const last = kfs[kfs.length - 1];
  if (t >= last.time) return last;
  let seg = 0;
  for (let i = 0; i < kfs.length - 1; i++) {
    if (t >= kfs[i].time && t <= kfs[i + 1].time) { seg = i; break; }
  }
  const a = kfs[seg], b = kfs[seg + 1];
  const u = (t - a.time) / ((b.time - a.time) || 1);
  // PATH shape is decided by control-point COUNT (client CameraHeader::GetPathMode: >2 → Spline,
  // ==2 → Straight, 1 → Locked) — NOT by the SmoothingType enum (that's the EASING, already applied
  // to `t` before we sample). 3+ points ⇒ chordal Catmull-Rom through eye + look-at; 2 ⇒ straight.
  const curved = kfs.length >= 3;
  if (curved) {
    const p0 = kfs[Math.max(0, seg - 1)], p3 = kfs[Math.min(kfs.length - 1, seg + 2)];
    return {
      eye:  _csCatmull(p0.eye, a.eye, b.eye, p3.eye, u),
      look: _csCatmull(p0.look || p0.eye, a.look || a.eye, b.look || b.eye, p3.look || p3.eye, u),
      fov:  a.fov + (b.fov - a.fov) * u,
      roll: (a.roll || 0) + ((b.roll || 0) - (a.roll || 0)) * u,
    };
  }
  const mix = (p, q) => [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u, p[2] + (q[2] - p[2]) * u];
  return { eye: mix(a.eye, b.eye), look: mix(a.look, b.look), fov: a.fov + (b.fov - a.fov) * u,
           roll: (a.roll || 0) + ((b.roll || 0) - (a.roll || 0)) * u };
}

// ── Letterbox ─────────────────────────────────────────────────────────────────
// Cinematic framing — two independent toggles:
//   csHideUi     — hide the editor chrome (topbar / panels / gizmo tools)
//   csFixedRatio — render the camera at a true 16:9 aspect (framing = the game). The render
//                  loop clears a black surround, so the letterbox bars come for free.
let csHideUi = false, csFixedRatio = false, csCrosshair = false;
// When Fixed Ratio is on, the main render targets THIS WebGL viewport rect (the framed
// area above the sequencer) so what you frame is exactly what the camera captures.
let _csCineViewport = null;
export function csGetCinematicViewport() { return _csCineViewport; }

export function initCsLetterbox(v) {
  v = v || {};
  csHideUi = !!v.hideUi; csFixedRatio = !!v.fixedRatio; csCrosshair = !!v.crosshair;
}

// ── Sequencer resize grip ──────────────────────────────────────────────────────
// Drag the top edge to grow/shrink the timeline. In Fixed Ratio the framed 16:9 view
// above auto-fits because csUpdateLetterbox derives its height from the LIVE sequencer
// size (the ResizeObserver re-runs it on every height change). Height persists per project.
function _applySeqHeight(h) {
  if (!csSeqEl) return 0;
  const maxH = Math.round(window.innerHeight * 0.8), minH = 130;
  h = Math.max(minH, Math.min(maxH, Math.round(h)));
  csSeqEl.classList.add('cs-seq-resized');     // CSS lifts the max-height caps on .cs-seq + .cs-seq-graph
  csSeqEl.style.height = h + 'px';
  return h;
}
function _resetSeqHeight() {                    // double-click → back to auto content height
  if (!csSeqEl) return;
  csSeqEl.classList.remove('cs-seq-resized');
  csSeqEl.style.height = '';
  if (_saveSetting) _saveSetting('csSeqHeight', 0);
  csUpdateLetterbox();
}
function _csInitSeqResizeGrip() {
  const grip = document.getElementById('cs-seq-grip');
  if (!grip || !csSeqEl) return;
  let startY = 0, startH = 0;
  const onMove = (e) => { _applySeqHeight(startH + (startY - e.clientY)); csUpdateLetterbox(); };  // drag UP → taller
  const onUp = (e) => {
    grip.classList.remove('dragging');
    grip.removeEventListener('pointermove', onMove);
    grip.removeEventListener('pointerup', onUp);
    try { grip.releasePointerCapture(e.pointerId); } catch {}
    if (_saveSetting) _saveSetting('csSeqHeight', parseInt(csSeqEl.style.height, 10) || 0);
  };
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startY = e.clientY;
    startH = csSeqEl.getBoundingClientRect().height;
    grip.classList.add('dragging');
    try { grip.setPointerCapture(e.pointerId); } catch {}    // captured events target the grip even over the canvas
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
  });
  grip.addEventListener('dblclick', _resetSeqHeight);
  const savedH = _loadSetting ? +_loadSetting('csSeqHeight', 0) : 0;   // restore a custom height
  if (savedH > 0) _applySeqHeight(savedH);
}

export function csUpdateLetterbox() {
  const seqOpen = !!(csSeqEl && !csSeqEl.hidden);
  // Hide UI — independent DOM visibility.
  const hideUi = csHideUi && seqOpen;
  ['gizmo-tools', 'topbar', 'side-tabs', 'sel-panel']
    .forEach((id) => { const el = document.getElementById(id); if (el) el.style.visibility = hideUi ? 'hidden' : ''; });

  // Fixed ratio — the framed 16:9 rect the camera renders into (else full canvas).
  if (!(seqOpen && csFixedRatio)) { _csCineViewport = null; csUpdateCrosshair(); return; }
  const cv = _renderer.domElement.getBoundingClientRect();
  const seqH = csSeqEl.getBoundingClientRect().height;
  const visH = cv.height - seqH;
  const SCOPE = 16 / 9;                                    // match the game screen
  const cur = cv.width / Math.max(1, visH);
  const barX = cur > SCOPE ? (cv.width - visH * SCOPE) / 2 : 0;
  const barY = cur <= SCOPE ? Math.max(0, (visH - cv.width / SCOPE) / 2) : 0;
  const innerW = cv.width - 2 * barX, innerH = visH - 2 * barY;
  _csCineViewport = { x: barX, y: seqH + barY, w: innerW, h: innerH, aspect: innerW / Math.max(1, innerH) };
  csUpdateCrosshair();
}

// Toggle one of the two cinematic flags: 'hideUi' | 'fixedRatio'.
function csSetCinematic(which) {
  let val;
  if (which === 'hideUi') { val = (csHideUi = !csHideUi); _saveSetting('csHideUi', val); document.getElementById('cs-seq-hideui')?.classList.toggle('active', val); }
  else if (which === 'crosshair') { val = (csCrosshair = !csCrosshair); _saveSetting('csCrosshair', val); document.getElementById('cs-seq-crosshair')?.classList.toggle('active', val); }
  else { val = (csFixedRatio = !csFixedRatio); _saveSetting('csFixedRatio', val); document.getElementById('cs-seq-ratio')?.classList.toggle('active', val); }
  csUpdateLetterbox();
}

// Position + show/hide the framing crosshair over the camera render rect (16:9 cine rect if
// Fixed Ratio is on, else the full canvas). Called from csUpdateLetterbox (covers resize/toggle).
function csUpdateCrosshair() {
  const el = document.getElementById('cs-crosshair');
  if (!el) return;
  const show = csCrosshair && csSeqEl && !csSeqEl.hidden;
  el.style.display = show ? 'block' : 'none';
  if (!show) return;
  const cv = _renderer.domElement.getBoundingClientRect();
  let cx = cv.left + cv.width / 2, cy = cv.top + cv.height / 2;
  if (_csCineViewport) {
    cx = cv.left + _csCineViewport.x + _csCineViewport.w / 2;
    cy = cv.top + (cv.height - (_csCineViewport.y + _csCineViewport.h / 2));   // cine.y is from the bottom
  }
  el.style.left = cx + 'px';
  el.style.top = cy + 'px';
}

// ── Render-loop hooks (called every frame by main.js's animate()) ─────────────
// Update the cutscene camera aspect and the actor outline / name tag.
export function cameraAspectUpdate(w, h) {
  csCamera.aspect = w / h;
  csCamera.updateProjectionMatrix();
}

// Called every render frame from animate(). Updates actor mixers and csVfxSystem.
export function csRenderTick(dt, activeCamera) {
  // Keep csCamera glued to the author-camera rig (fly/gizmo moved it this frame).
  if (csAuthorMode && csAuthorCamRig) csSyncAuthorCamera();
  // Live "Camera: Viewport / Sequencer" readout — cutsceneCamActive = rendering through csCamera.
  if (csSeqEl && !csSeqEl.hidden) {
    const el = document.getElementById('cs-seq-cam-mode');
    if (el) {
      const mode = cutsceneCamActive ? 'Sequencer' : 'Viewport';
      if (el.textContent !== mode) el.textContent = mode;
    }
    // Live camera pose readout — FFXI eye coords + heading/pitch of whichever camera is rendering.
    const posEl = document.getElementById('cs-seq-cam-pos');
    const rotEl = document.getElementById('cs-seq-cam-rot');
    if ((posEl || rotEl) && activeCamera) {
      const zr = _getZoneRoot && _getZoneRoot();
      activeCamera.updateMatrixWorld();
      const eyeW = new THREE.Vector3(); activeCamera.getWorldPosition(eyeW);
      const fwd = new THREE.Vector3(); activeCamera.getWorldDirection(fwd);
      const look = eyeW.clone().addScaledVector(fwd, 100);
      const eye = zr ? zr.worldToLocal(eyeW.clone()) : eyeW.clone();   // display world → FFXI world
      if (zr) zr.worldToLocal(look);
      const dx = look.x - eye.x, dy = look.y - eye.y, dz = look.z - eye.z, DEG = 180 / Math.PI;
      if (posEl) posEl.textContent = `${eye.x.toFixed(0)}, ${eye.y.toFixed(0)}, ${eye.z.toFixed(0)}`;
      if (rotEl) rotEl.textContent = `${Math.round(Math.atan2(dx, dz) * DEG)}° / ${Math.round(Math.atan2(dy, Math.hypot(dx, dz)) * DEG)}°`;
    }
  }
  if (csActors.length) for (const rec of csActors) { if (rec.mixer) rec.mixer.update(dt); }
  if (csVfxSystem && csVfxSystem.emitters.length) { try { csVfxSystem.update(); } catch (e) {} }
  _updateOutline(csActorOutline, !!csSelectedActor);
  // Update the name tag screen position for the selected cutscene actor.
  if (csSelectedActor?.node) {
    const tag = getCsActorTag();
    const wp = new THREE.Vector3();
    csSelectedActor.node.getWorldPosition(wp);
    wp.project(activeCamera);
    const cv = _renderer.domElement.getBoundingClientRect();
    const sx = (wp.x * 0.5 + 0.5) * cv.width + cv.left;
    const sy = (-wp.y * 0.5 + 0.5) * cv.height + cv.top;
    if (wp.z < 1) {
      tag.textContent = csSelectedActor.name;
      tag.style.left = `${sx}px`;
      tag.style.top = `${sy}px`;
      tag.style.display = 'block';
    } else {
      tag.style.display = 'none';
    }
  }
}

// ── Sequencer-camera picture-in-picture ──────────────────────────────────────
// A little live preview of what the sequencer camera sees, bottom-right. main.js's
// render loop calls this each frame with show=true while the camera object is
// selected (its gizmo is attached) and we're NOT piloting — i.e. you clicked the
// camera to peek through it without flying it. Renders _scene through csCamera into
// a scissored corner (the main render is left intact); an HTML overlay frames it.
let _csPipEl = null;

export function csRenderCameraPreview(show) {
  if (!show || !_renderer || !_scene || !csCamera || !csAuthorCamRig) {
    if (_csPipEl) _csPipEl.style.display = 'none';
    return;
  }
  const rect = _renderer.domElement.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  const pipW = Math.round(Math.max(180, Math.min(340, W * 0.26)));
  const pipH = Math.round(pipW * 9 / 16);
  const margin = 14;
  const seqH = (csSeqEl && !csSeqEl.hidden) ? csSeqEl.getBoundingClientRect().height : 0;
  // Anchor the PiP bottom-right. With the 16:9 letterbox on, pin it INSIDE the framed
  // rectangle — the bars are DOM over the canvas, so a corner render outside the frame
  // would be hidden behind a bar. Otherwise sit just above the sequencer.
  const cine = _csCineViewport;
  let glX, glY;
  if (cine && cine.w > 0 && cine.h > 0) {
    glX = Math.round(cine.x + cine.w - pipW - margin);
    glY = Math.round(cine.y + margin);
  } else {
    glX = Math.round(W - pipW - margin);              // WebGL viewport: origin bottom-left
    glY = Math.round(seqH + margin);
  }
  const cssLeft = glX, cssTop = H - (glY + pipH);      // WebGL (bottom-left) → CSS (top-left)

  // Hide the camera body + frustum helper so the lens doesn't render itself.
  const rigVis = csAuthorCamRig.visible;
  const helpVis = csAuthorCamHelper ? csAuthorCamHelper.visible : false;
  csAuthorCamRig.visible = false;
  if (csAuthorCamHelper) csAuthorCamHelper.visible = false;

  const prevAspect = csCamera.aspect;
  csCamera.aspect = pipW / pipH; csCamera.updateProjectionMatrix();
  // Scissor scopes autoClear to the corner box, so the main render survives.
  _renderer.setViewport(glX, glY, pipW, pipH);
  _renderer.setScissor(glX, glY, pipW, pipH);
  _renderer.setScissorTest(true);
  _renderer.render(_scene, csCamera);
  // Restore to the full canvas (don't assume the prior pass left it full).
  _renderer.setScissorTest(false);
  _renderer.setViewport(0, 0, W, H);
  _renderer.setScissor(0, 0, W, H);
  csCamera.aspect = prevAspect; csCamera.updateProjectionMatrix();

  csAuthorCamRig.visible = rigVis;
  if (csAuthorCamHelper) csAuthorCamHelper.visible = helpVis;

  if (!_csPipEl) {
    _csPipEl = document.createElement('div');
    _csPipEl.className = 'cs-cam-pip';
    _csPipEl.innerHTML = '<span class="cs-cam-pip-label">Sequencer Camera</span>';
    document.body.appendChild(_csPipEl);
  }
  _csPipEl.style.display = 'block';
  _csPipEl.style.left = (rect.left + cssLeft) + 'px';
  _csPipEl.style.top = (rect.top + cssTop) + 'px';
  _csPipEl.style.width = pipW + 'px';
  _csPipEl.style.height = pipH + 'px';
}

// ── Pick helpers (called from main.js pointer handler) ────────────────────────
// Returns array of csActors for ray-picking against actor nodes.
export function getCsActors() { return csActors; }
export function getCsActorOutline() { return csActorOutline; }
export function getCsSelectedActor() { return csSelectedActor; }
export function isCsSequencerOpen() { return !!(csSeqEl && !csSeqEl.hidden); }
export { csToggleActorSelection, csClearActorSelection };

// Getter — true when the fixed-ratio cinematic render is active.
export function getCsLetterbox() { return csFixedRatio; }
// Getter for csVfxSystem (read in render loop in main.js).
export function getCsVfxSystem() { return csVfxSystem; }
