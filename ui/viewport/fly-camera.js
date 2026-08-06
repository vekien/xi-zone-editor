// fly-camera.js — WASD fly camera for the level editor
// initFlyCamera(deps) must be called before flyUpdate / setFlySpeed etc. are used.

import * as THREE from 'three';

export const WORLD_UP = new THREE.Vector3(0, 1, 0);
export const flyClock = new THREE.Clock();
export const heldKeys = new Set();

export const FLY_SPEED_MIN = 1, FLY_SPEED_MAX = 500;

// Shared mutable state — both fly-camera.js and main.js (event listeners) reference this object.
// main.js should use flyState.flyLooking / flyState.rightLookMoved in its inline listeners.
export const flyState = {
  flyLooking: false,
  rightLookMoved: false,
};

let _camera = null;        // the editor free camera (default fly target)
let _flyTarget = null;     // what WASD/look currently drives — free camera, or a piloted object
let _canvas = null;
let _camValEl = null;
let _saveSetting = null;

// Retarget the fly controls at another Object3D (e.g. the cutscene author camera
// while "piloting" it). Pass null to hand control back to the editor free camera.
// getWorldDirection / rotateOnWorldAxis / rotateX / position work on any Object3D.
export function setFlyTarget(obj) { _flyTarget = obj || null; }
export function getFlyTarget() { return _flyTarget || _camera; }

// Current fly speed (world units/sec). Initialised by initFlyCamera once loadSetting is available.
export let flySpeed = 50;

export function initFlyCamera({ camera, canvas, camValEl, loadSetting, saveSetting }) {
  _camera = camera;
  _canvas = canvas;
  _camValEl = camValEl;
  _saveSetting = saveSetting;
  flySpeed = Math.min(FLY_SPEED_MAX, Math.max(FLY_SPEED_MIN, loadSetting('zoomSpeed', 50)));
}

export function speedToSlider(v) { return Math.round(1 + (v - FLY_SPEED_MIN) / (FLY_SPEED_MAX - FLY_SPEED_MIN) * 99); }

export function updateZoomSpeedUi() {
  if (_camValEl) _camValEl.textContent = Math.round(flySpeed);
  const el = document.getElementById('move-speed'), lbl = document.getElementById('move-val');
  if (el) el.value = speedToSlider(flySpeed);
  if (lbl) lbl.textContent = el ? el.value : String(Math.round(flySpeed));
}

export function setFlySpeed(v) {
  flySpeed = Math.min(FLY_SPEED_MAX, Math.max(FLY_SPEED_MIN, v));
  if (_saveSetting) _saveSetting('zoomSpeed', flySpeed);
  updateZoomSpeedUi();
}

export function flyUpdate(dt) {
  const target = _flyTarget || _camera;
  const move = new THREE.Vector3();
  const fwd = target.getWorldDirection(new THREE.Vector3());
  const right = new THREE.Vector3().crossVectors(fwd, WORLD_UP).normalize();
  if (heldKeys.has('w')) move.add(fwd);
  if (heldKeys.has('s')) move.sub(fwd);
  if (heldKeys.has('d')) move.add(right);
  if (heldKeys.has('a')) move.sub(right);
  if (heldKeys.has('e')) move.add(WORLD_UP);
  if (heldKeys.has('q')) move.sub(WORLD_UP);
  if (move.lengthSq() > 0) {
    const speed = flySpeed * (heldKeys.has('shift') ? 3 : 1) * dt; // Shift = 3× boost
    target.position.addScaledVector(move.normalize(), speed);
  }
}

export function onFlyLook(dx, dy) {
  const sens = 0.0026;
  const target = _flyTarget || _camera;
  target.rotateOnWorldAxis(WORLD_UP, -dx * sens); // yaw (roll-free)
  target.rotateX(-dy * sens);                     // pitch (local)
}

export function endFlyLook(pointerId) {
  if (!flyState.flyLooking) return;
  flyState.flyLooking = false;
  if (pointerId != null) { try { _canvas.releasePointerCapture(pointerId); } catch {} }
}
