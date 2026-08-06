// lighting.js — FFXI lighting uniforms, GLSL snippets, and environment application
// initLighting(deps) must be called before applyEnvironment / applyDayColors are used.

import * as THREE from 'three';

// ── GLSL shared fragments ────────────────────────────────────────────────────
export const LIGHT_UNIFORMS_GLSL = `
  uniform vec3 uAmbient;
  uniform vec3 uSunDir;  uniform vec3 uSunColor;
  uniform vec3 uMoonDir; uniform vec3 uMoonColor;
  uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar; uniform float uFogOn;`;
// xim: litFragColor = clamp(vColor*ambient + diffuseLightCalc(sun) + diffuseLightCalc(moon))
// diffuseLightCalc(N, vColor, light) = vColor * clamp(dot(N, light.dir),0,1) * light.color
export const litRGB_GLSL = `
  vec3 litColor(vec4 vc, vec3 nrm) {
    vec3 n = normalize(nrm);
    vec3 amb = vc.rgb * uAmbient;
    vec3 df0 = vc.rgb * clamp(dot(n, uSunDir),  0.0, 1.0) * uSunColor;
    vec3 df1 = vc.rgb * clamp(dot(n, uMoonDir), 0.0, 1.0) * uMoonColor;
    return clamp(amb + df0 + df1, 0.0, 1.0);
  }`;
export const applyFog_GLSL = `
  vec3 applyFog(vec3 rgb, float dist) {
    if (uFogOn < 0.5) return rgb;
    float f = clamp((uFogFar - dist) / (uFogFar - uFogNear), 0.0, 1.0);
    return mix(uFogColor, rgb, f);
  }`;

// ── Lighting bias constants (EnvironmentLighting port) ───────────────────────
export const BIAS = [1.4, 1.36, 1.45], NO_BIAS = [1, 1, 1], TH = 0xCC; // bias threshold 0xCC

// ── Module-level refs set by initLighting ───────────────────────────────────
let _lightUniforms = null;
let _fogUniforms = null;
// getState() returns the dynamic zone context — set by initLighting.
// Expected shape: { environments, currentWeather, userFog, scene, applyBackdrop, timeMinutes, dayOfWeek, waterTints }
let _getState = null;

export function initLighting({ lightUniforms, fogUniforms, getState }) {
  _lightUniforms = lightUniforms;
  _fogUniforms = fogUniforms;
  _getState = getState;
}

// ── Pure colour helpers ──────────────────────────────────────────────────────
export function ambientToColor(c) { // ByteColor → Color, clamp 0.5 (EnvironmentLighting.ambientToColor)
  const bias = (c[0] < TH && c[1] < TH && c[2] < TH) ? BIAS : NO_BIAS;
  return [Math.min(0.5, bias[0] * c[0] / 510), Math.min(0.5, bias[1] * c[1] / 510), Math.min(0.5, bias[2] * c[2] / 510)];
}
export function diffuseToColor(c, inten) { // (EnvironmentLighting.diffuseToColor)
  const d = [c[0] / 255 * inten, c[1] / 255 * inten, c[2] / 255 * inten];
  const thf = TH / 0xFF;
  const bias = (d[0] < thf && d[1] < thf && d[2] < thf) ? BIAS : NO_BIAS;
  return [Math.min(1, d[0] * bias[0]), Math.min(1, d[1] * bias[1]), Math.min(1, d[2] * bias[2])];
}
// getDirectionOfSunDiffuseLight(todSec) = normalize(sin a, cos a, 0), a = todSec·0.5π/21600.
// moonDir = -sunDir. Convert FFXI→display by root correction = diag(-1,-1,1): negate both
// X and Y, so dot(N_display, dir_display) == dot(N_ffxi, dir_ffxi).
export function sunDirDisplay() {
  const { timeMinutes } = _getState();
  const ang = (timeMinutes * 60) * (0.5 * Math.PI / 21600);
  return new THREE.Vector3(-Math.sin(ang), -Math.cos(ang), 0).normalize();
}

// Water/effect textureFactor = getColor() = baseColor.modulate(dayColor, 2) (Particle.getColor):
// per channel clamp(2 · dayColor · baseColor). No 0x4E op → plain base colour.
export function applyDayColors() {
  const { waterTints, dayOfWeek } = _getState();
  for (const t of waterTints) {
    const b = t.base, u = t.uniform.value;
    if (t.dayColors) {
      const d = t.dayColors[dayOfWeek];
      u.set(Math.min(1, 2 * (d[0] / 255) * (b[0] / 255)), Math.min(1, 2 * (d[1] / 255) * (b[1] / 255)),
            Math.min(1, 2 * (d[2] / 255) * (b[2] / 255)), Math.min(1, 2 * (d[3] / 255) * (b[3] / 255)));
    } else {
      u.set(b[0] / 255, b[1] / 255, b[2] / 255, b[3] / 255);
    }
  }
}

export function applyEnvironment() {
  const { environments, currentWeather, userFog, scene, applyBackdrop } = _getState();
  // Editor lighting: keep zones bright and readable. The DAT weather/fog path is useful
  // for renderer research, but it makes level editing muddy and hides water detail.
  _lightUniforms.uAmbient.value.setRGB(1.0, 1.0, 1.0);
  _lightUniforms.uSunDir.value.set(0.35, 0.9, 0.25).normalize();
  _lightUniforms.uMoonDir.value.set(-0.35, -0.9, -0.25).normalize();
  _lightUniforms.uSunColor.value.setRGB(0.0, 0.0, 0.0);
  _lightUniforms.uMoonColor.value.setRGB(0.0, 0.0, 0.0);
  _fogUniforms.uFogOn.value = 0;
  applyBackdrop();
  return;

  const env = environments.get(currentWeather) || environments.values().next().value;
  if (!env) {
    _lightUniforms.uAmbient.value.setRGB(0.5, 0.5, 0.5);
    _lightUniforms.uSunColor.value.setRGB(0.5, 0.5, 0.5);
    _lightUniforms.uMoonColor.value.setRGB(0, 0, 0);
    _lightUniforms.uSunDir.value.set(0, 1, 0); _lightUniforms.uMoonDir.value.set(0, -1, 0);
    _fogUniforms.uFogOn.value = 0; scene.background = new THREE.Color(0x0e0e12); return;
  }
  const m = env.terrain || env.model;
  const amb = ambientToColor(m.ambient);
  const sun = diffuseToColor(m.sun, m.diffuseMult);
  const moon = diffuseToColor(m.moon, m.diffuseMult);

  _lightUniforms.uAmbient.value.setRGB(amb[0], amb[1], amb[2]);
  if (env.indoors) {
    // Indoor: single light from moonLightColor direction (getDirectionOfIndoorDiffuseLight).
    const mc = m.moon;
    const s2b = (v) => (v > 127 ? v - 256 : v) / 128;
    const idir = new THREE.Vector3(s2b(mc[0]), -s2b(mc[1]), s2b(mc[2]));
    if (idir.lengthSq() < 1e-6) idir.set(0, -1, 0); else idir.normalize().multiplyScalar(-1);
    _lightUniforms.uSunDir.value.copy(idir);
    _lightUniforms.uSunColor.value.setRGB(sun[0], sun[1], sun[2]);
    _lightUniforms.uMoonColor.value.setRGB(0, 0, 0);
    _lightUniforms.uMoonDir.value.set(0, -1, 0);
  } else {
    const sd = sunDirDisplay();
    _lightUniforms.uSunDir.value.copy(sd);
    _lightUniforms.uMoonDir.value.copy(sd.clone().multiplyScalar(-1));
    _lightUniforms.uSunColor.value.setRGB(sun[0], sun[1], sun[2]);
    _lightUniforms.uMoonColor.value.setRGB(moon[0], moon[1], moon[2]);
  }

  // FogParams(near=fogStart, far=fogEnd). noOpFog far = -1.
  if (userFog && m.fogEnd > 0 && m.fogEnd > m.fogStart) {
    _fogUniforms.uFogOn.value = 1;
    _fogUniforms.uFogColor.value.setRGB(m.fog[0] / 255, m.fog[1] / 255, m.fog[2] / 255);
    _fogUniforms.uFogNear.value = m.fogStart; _fogUniforms.uFogFar.value = m.fogEnd;
    scene.background = _fogUniforms.uFogColor.value.clone();
  } else {
    _fogUniforms.uFogOn.value = 0;
    // No fog → approximate sky from ambient + the brighter of sun/moon (whichever points up-ish).
    const up = Math.max(0, _lightUniforms.uSunDir.value.y) ? sun : moon;
    scene.background = new THREE.Color(
      Math.min(1, amb[0] + up[0] * 0.5), Math.min(1, amb[1] + up[1] * 0.5), Math.min(1, amb[2] + up[2] * 0.5));
  }
}
