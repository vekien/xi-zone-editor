// ── core/zone-effects.js ─────────────────────────────────────────────────────
// Zone VFX system: particle shaders, surface/runtime/plain effect builders,
// VFX icon billboard system, sound emitters, cross-zone effect injection,
// and the disable-VFX toggle.
// Extracted from main.js. Call initZoneEffects(refs) once at startup.

import * as THREE from 'three';
import { fmtFourCC, trsMatrix, makeSymbolTexture } from '../editor/utils.js';
import { isSkyName } from '../ffxi/zone.js';
import { parseEffects, describeSurface, describeEmitter, describePointLight, describeSound, decodeBlend } from '../ffxi/effects.js';
import { parseAllEffects } from '../ffxi/particle_effects.js';
import { ParticleSystem, ParticleEmitter } from '../ffxi/particle_runtime.js';

let _R = {};
export function initZoneEffects(refs) { _R = refs; }

// ── Module-level VFX runtime state (module-owned; main.js reads via getters) ─
let _zoneVfxSystem = null;
export function getZoneVfxSystem() { return _zoneVfxSystem; }

// vfxIconGroup / emittedEffects / animatedTextures / waterTints live in main.js
// and are accessed via _R.getVfxIconGroup() / _R.setVfxIconGroup() etc.
// (main.js keeps them so the render loop / undo-redo code need no refs.)

// ── Particle shaders ──────────────────────────────────────────────────────────
const PARTICLE_VERT = `
  varying vec2 vUv; varying vec4 vColor; varying vec3 vN; varying float vDist;
  void main(){
    vUv = uv; vColor = color;
    vN = mat3(modelMatrix) * normal;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const PARTICLE_FRAG = `
  precision highp float;
  uniform sampler2D map; uniform vec2 uTranslate; uniform vec4 uTexFactor;
  uniform float uIgnoreAlpha; uniform float uDiscard; uniform float uGain; uniform float uLighting;
  uniform float uFog; uniform float uFogBlack;
  ${_R.LIGHT_UNIFORMS_GLSL || ''}
  varying vec2 vUv; varying vec4 vColor; varying vec3 vN; varying float vDist;
  ${_R.litRGB_GLSL || ''}
  void main(){
    vec4 texel = texture2D(map, uTranslate + vUv);
    if (uIgnoreAlpha > 0.0) texel.a = 0.5;
    vec4 fc = (uLighting > 0.5) ? vec4(litColor(vColor, vN), vColor.a) : vColor;
    vec4 s0 = 2.0 * (fc * texel);
    vec4 col = vec4(2.0 * s0.rgb * uTexFactor.rgb * uGain, 4.0 * s0.a * uTexFactor.a);
    if (col.a < uDiscard) discard;
    col = clamp(col, 0.0, 1.0);
    if (uFog > 0.5 && uFogOn > 0.5) {
      float f = clamp((uFogFar - vDist) / (uFogFar - uFogNear), 0.0, 1.0);
      vec3 fc2 = (uFogBlack > 0.5) ? vec3(0.0) : uFogColor;
      col.rgb = mix(fc2, col.rgb, f);
    }
    gl_FragColor = col;
  }`;

export function makeParticleMaterial(map, texFactor, opts) {
  const LIGHT_UNIFORMS_GLSL = _R.getLightUniformsGlsl();
  const litRGB_GLSL = _R.getLitRGBGlsl();
  const vert = `
  varying vec2 vUv; varying vec4 vColor; varying vec3 vN; varying float vDist;
  void main(){
    vUv = uv; vColor = color;
    vN = mat3(modelMatrix) * normal;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
  const frag = `
  precision highp float;
  uniform sampler2D map; uniform vec2 uTranslate; uniform vec4 uTexFactor;
  uniform float uIgnoreAlpha; uniform float uDiscard; uniform float uGain; uniform float uLighting;
  uniform float uFog; uniform float uFogBlack;
  ${LIGHT_UNIFORMS_GLSL}
  varying vec2 vUv; varying vec4 vColor; varying vec3 vN; varying float vDist;
  ${litRGB_GLSL}
  void main(){
    vec4 texel = texture2D(map, uTranslate + vUv);
    if (uIgnoreAlpha > 0.0) texel.a = 0.5;
    vec4 fc = (uLighting > 0.5) ? vec4(litColor(vColor, vN), vColor.a) : vColor;
    vec4 s0 = 2.0 * (fc * texel);
    vec4 col = vec4(2.0 * s0.rgb * uTexFactor.rgb * uGain, 4.0 * s0.a * uTexFactor.a);
    if (col.a < uDiscard) discard;
    col = clamp(col, 0.0, 1.0);
    if (uFog > 0.5 && uFogOn > 0.5) {
      float f = clamp((uFogFar - vDist) / (uFogFar - uFogNear), 0.0, 1.0);
      vec3 fc2 = (uFogBlack > 0.5) ? vec3(0.0) : uFogColor;
      col.rgb = mix(fc2, col.rgb, f);
    }
    gl_FragColor = col;
  }`;
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: frag, vertexColors: true,
    side: THREE.DoubleSide, transparent: opts.blendFunc !== 'One_Zero', depthWrite: opts.depthMask,
    uniforms: {
      map: { value: map || _R.getDefaultTex() },
      uTranslate: { value: new THREE.Vector2(0, 0) },
      uTexFactor: { value: new THREE.Vector4(texFactor[0] / 255, texFactor[1] / 255, texFactor[2] / 255, texFactor[3] / 255) },
      uIgnoreAlpha: { value: opts.ignoreAlpha ? 1 : 0 },
      uDiscard: { value: opts.discard },
      uGain: _R.getGainUniform(),
      uLighting: { value: opts.lightingEnabled ? 1 : 0 },
      uFog: { value: opts.fogEnabled ? 1 : 0 },
      uFogBlack: { value: opts.blendFunc === 'Src_One_Add' ? 1 : 0 },
      ..._R.getLightUniforms(), ..._R.getFogUniforms(),
    },
  });
  mat.depthTest = true;
  switch (opts.blendFunc) {
    case 'One_Zero':
      mat.blending = THREE.NoBlending;
      break;
    case 'Src_InvSrc_Add':
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.SrcAlphaFactor;
      mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      break;
    case 'Src_One_RevSub':
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.ReverseSubtractEquation;
      mat.blendSrc = THREE.SrcAlphaFactor;
      mat.blendDst = THREE.OneFactor;
      break;
    case 'Zero_InvSrc_Add':
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.ZeroFactor;
      mat.blendDst = THREE.OneMinusSrcAlphaFactor;
      break;
    case 'Src_One_Add':
    default:
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.SrcAlphaFactor;
      mat.blendDst = THREE.OneFactor;
      break;
  }
  return mat;
}

// ── VFX name labels ───────────────────────────────────────────────────────────
const VFX_LABEL = { suimen: 'fountain water', tamadai: 'fountain basin', lowsea: 'sea', '2lowsea': 'sea',
  lowcol: 'water column', '5window': 'window', sphere: 'glow sphere', sibjun3: 'fountain spray',
  sibj: 'fountain spray', awan: 'bubbles', ligh: 'light glow', fire: 'fire' };

// ── Surface tuning ────────────────────────────────────────────────────────────
export function tuneSurfaceForEditor(name, surf, blendFunc) {
  const n = name.toLowerCase();
  if (n === 'lowsea' || n === '2lowsea') {
    return {
      blendFunc: 'Src_One_Add',
      depthMask: false,
      fogEnabled: false,
      color: n === '2lowsea' ? [190, 190, 190, 130] : [210, 210, 210, 150],
      renderBias: n === '2lowsea' ? 20 : 21,
    };
  }
  if (n === 'lowcol') {
    return {
      blendFunc: 'Src_InvSrc_Add',
      depthMask: false,
      fogEnabled: false,
      color: [45, 110, 190, surf.depthMask ? 12 : 18],
      renderBias: surf.depthMask ? 30 : 31,
    };
  }
  return { blendFunc, depthMask: surf.depthMask, fogEnabled: surf.fogEnabled, color: surf.color, renderBias: 0 };
}

// ── Sprite/particle mesh helpers ──────────────────────────────────────────────
export function makeSpriteTemplate(sprite) {
  if (!sprite?.frames?.length) return null;
  return { frames: sprite.frames.map((frame) => {
    const geo = new THREE.BufferGeometry();
    const normals = new Float32Array(frame.positions.length);
    geo.setAttribute('position', new THREE.BufferAttribute(frame.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(frame.uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(frame.colors, 4));
    return [{ geometry: geo, texKey: sprite.textureName }];
  }) };
}

export function addParticleMeshes(group, entries, effect, opts, renderOrder) {
  const frame = new THREE.Group();
  for (const { geometry, texKey } of entries) {
    const resolved = texKey ? _R.resolveTexture(texKey, opts.texMap) : null;
    const mat = makeParticleMaterial(resolved ? opts.texMap.get(resolved) : null, effect.color, opts);
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.renderOrder = renderOrder;
    frame.add(mesh);
    if (effect.uvScroll) _R.getAnimatedTextures().push({ uniform: mat.uniforms.uTranslate, scroll: effect.uvScroll });
  }
  group.add(frame);
  return frame;
}

export function makeParticleInstance(source, effect, opts, renderOrder) {
  const group = new THREE.Group();
  group.rotation.order = 'ZYX';
  group.rotation.set(effect.rotation[0], effect.rotation[1], effect.rotation[2]);
  group.scale.set(effect.scale[0], effect.scale[1], effect.scale[2]);
  group.userData.billboard = effect.billboard;
  group.userData.baseRotation = effect.rotation;
  if (source.frames) {
    group.userData.frames = source.frames.map((entries, i) => {
      const frame = addParticleMeshes(group, entries, effect, opts, renderOrder);
      frame.visible = i === 0;
      return frame;
    });
  } else {
    addParticleMeshes(group, source, effect, opts, renderOrder);
  }
  return group;
}

export function addEmittedEffect(root, entries, effect, opts, renderOrder) {
  const maxAlive = effect.continuousSingleton ? 1 : Math.min(32, Math.max(1, Math.ceil(effect.maxLifeSpan / effect.framesPerEmission) * effect.particlesPerEmission));
  const particles = [];
  for (let i = 0; i < maxAlive; i++) {
    const node = makeParticleInstance(entries, effect, opts, renderOrder);
    const age = effect.continuousSingleton ? 0 : (i / maxAlive) * effect.maxLifeSpan;
    particles.push({ node, age });
    root.add(node);
  }
  _R.getEmittedEffects().push({ effect, particles });
}

export function addPointLightEffect(root, effect) {
  const color = new THREE.Color(effect.color[0] / 255, effect.color[1] / 255, effect.color[2] / 255);
  const light = new THREE.PointLight(color, 1.5, effect.range || 20, 2);
  root.add(light);
  const geo = new THREE.SphereGeometry(0.35, 12, 8);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending });
  const marker = new THREE.Mesh(geo, mat);
  marker.renderOrder = 12000;
  root.add(marker);
}

export function addPlainVfxMesh(root, entries, renderOrder) {
  const mat = new THREE.MeshBasicMaterial({ color: 0x777777, side: THREE.DoubleSide });
  for (const { geometry } of entries) {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.renderOrder = renderOrder;
    root.add(mesh);
  }
}

export function addSoundEmitters(group, effects, counts) {
  for (const gen of effects.generators) {
    if (!gen.autoRun) continue;
    const snd = describeSound(gen);
    if (!snd) continue;
    const node = new THREE.Group();
    node.rotation.order = 'ZYX';
    trsMatrix(snd.position, [0, 0, 0], [1, 1, 1]).decompose(node.position, node.quaternion, node.scale);
    const label = `sound ${snd.file} [${snd.sectionId}]`;
    const c = (counts.get(label) || 0) + 1; counts.set(label, c);
    node.name = c === 1 ? label : `${label}.${String(c).padStart(3, '0')}`;
    node.userData.effect = { sectionId: snd.sectionId, sound: true, soundId: snd.soundId, soundFile: snd.file };
    group.add(node);
    registerPlacement(node, true);
  }
}

// ── Public builders ───────────────────────────────────────────────────────────
export function clearZoneVfxSystem() {
  if (_zoneVfxSystem) {
    try { _zoneVfxSystem.clear(); } catch {}
  }
  _zoneVfxSystem = null;
}

export function isLegacyZoneEnvMesh(name) {
  const n = (name || '').toLowerCase();
  return isSkyName(n) || n === 'lowsea' || n === '2lowsea' || n === 'lowcol'
    || n.startsWith('5window') || n.startsWith('rnp') || n.startsWith('rr');
}

export function buildRuntimeZoneEffects(datBuf, meshes, templates, texMap, meshIdToName) {
  const scene = _R.getScene();
  const group = new THREE.Group(); group.name = 'effects';
  const meshNames = new Set();
  const counts = new Map();
  let runtimeEffects, simpleEffects;
  try {
    runtimeEffects = parseAllEffects(datBuf);
    simpleEffects = parseEffects(datBuf);
  } catch (e) {
    console.error('effects parse failed', e);
    return { group, meshNames };
  }

  _zoneVfxSystem = new ParticleSystem(scene, _R.getCamera());
  const simpleByKey = new Map();
  for (const gen of simpleEffects.generators) simpleByKey.set(`${gen.id}@${gen.sourceOffset}`, gen);

  for (const gen of runtimeEffects.generators || []) {
    const hdr = gen.header || {};
    if (!hdr.autoRun && !hdr.continuousSingleton) continue;
    const simple = simpleByKey.get(`${gen.id}@${gen.start}`) || null;
    const snd = simple ? describeSound(simple) : null;
    if (snd) continue;
    const light = simple ? describePointLight(simple) : null;
    if (light) {
      const node = new THREE.Group();
      node.rotation.order = 'ZYX';
      trsMatrix(light.position, [0, 0, 0], [1, 1, 1]).decompose(node.position, node.quaternion, node.scale);
      const label = `point light [${fmtFourCC(light.sectionId)}]`;
      const c = (counts.get(label) || 0) + 1; counts.set(label, c);
      node.name = c === 1 ? label : `${label}.${String(c).padStart(3, '0')}`;
      node.userData.effect = { mesh: 'point light', sectionId: light.sectionId, sourceOffset: light.sourceOffset, lighting: true, fog: false, builder: 'runtime·light' };
      addPointLightEffect(node, light);
      group.add(node);
      registerPlacement(node, true);
      node.visible = true;
      setIconVisible(node, true);
      continue;
    }

    const root = new THREE.Group();
    root.rotation.order = 'ZYX';
    let labelName = gen.id;
    let effectMesh = gen.id;
    let basePos = [0, 0, 0];
    let isSkyFx = false;
    const surf = simple ? describeSurface(simple) : null;
    const emitter = simple ? describeEmitter(simple) : null;
    const desc = (surf && !surf.hasEmission) ? { type: 'StaticMesh', meshLink: surf.meshLink, position: surf.position, sectionId: surf.sectionId, sourceOffset: surf.sourceOffset }
      : emitter;
    if (desc) {
      basePos = desc.position || [0, 0, 0];
      const nm = desc.type === 'StaticMesh' ? meshIdToName.get(desc.meshLink) : desc.meshLink;
      if (nm) {
        labelName = VFX_LABEL[nm] || nm;
        effectMesh = nm;
        isSkyFx = isSkyName(nm);
        if (desc.type === 'StaticMesh' && !isSkyFx) meshNames.add(nm);
      }
    }
    if (isSkyFx || isLegacyZoneEnvMesh(effectMesh)) continue;
    root.position.set(basePos[0] || 0, basePos[1] || 0, basePos[2] || 0);
    const label = `${labelName} [${gen.id}]`;
    const c = (counts.get(label) || 0) + 1; counts.set(label, c);
    root.name = c === 1 ? label : `${label}.${String(c).padStart(3, '0')}`;
    root.userData.effect = { mesh: effectMesh, sectionId: gen.id, sourceOffset: gen.start, builder: 'runtime' };
    try {
      const em = new ParticleEmitter(gen, runtimeEffects, scene, _R.getCamera(), root);
      em.meshGroup.position.set(-(basePos[0] || 0), -(basePos[1] || 0), -(basePos[2] || 0));
      root.userData.vfxEmitter = em;
      _zoneVfxSystem.emitters.push(em);
      group.add(root);
      registerPlacement(root, true);
      root.visible = true;
      setIconVisible(root, true);
    } catch (e) {
      console.warn('[zone vfx] emitter build failed', gen.id, e);
    }
  }

  const legacy = buildSurfaceEffects(datBuf, meshes, templates, texMap, meshIdToName);
  for (const ch of legacy.group.children) group.add(ch);
  for (const nm of legacy.meshNames) meshNames.add(nm);

  addSoundEmitters(group, simpleEffects, counts);
  return { group, meshNames };
}

export function buildPlainVfxMeshes(datBuf, templates, meshIdToName) {
  const group = new THREE.Group(); group.name = 'plain-effects';
  const meshNames = new Set();
  const counts = new Map();
  let effects;
  try { effects = parseEffects(datBuf); } catch (e) { console.error('effects parse failed', e); return { group, meshNames }; }

  let order = 10000;
  for (const gen of effects.generators) {
    if (!gen.autoRun) continue;
    const surf = describeSurface(gen);
    const emitter = describeEmitter(gen);
    const effect = surf && !surf.hasEmission ? { ...surf, type: 'StaticMesh' } : emitter;
    if (!effect) continue;
    const name = effect.type === 'StaticMesh' ? meshIdToName.get(effect.meshLink) : effect.meshLink;
    if (!name || isSkyName(name)) continue;
    const entries = effect.type === 'StaticMesh' ? templates.get(name) : makeSpriteTemplate(effects.spriteSheets.get(effect.meshLink))?.frames?.[0];
    if (!entries) continue;

    const node = new THREE.Group();
    node.renderOrder = order++;
    node.rotation.order = 'ZYX';
    trsMatrix(effect.position, effect.rotation || [0, 0, 0], effect.scale || [1, 1, 1]).decompose(node.position, node.quaternion, node.scale);
    const label = `plain ${VFX_LABEL[name] || name} [${fmtFourCC(effect.sectionId)}]`;
    const c = (counts.get(label) || 0) + 1; counts.set(label, c);
    node.name = c === 1 ? label : `${label}.${String(c).padStart(3, '0')}`;
    node.userData.effect = { mesh: name, sectionId: effect.sectionId, plain: true, builder: 'plain' };
    addPlainVfxMesh(node, entries, node.renderOrder);
    group.add(node);
    registerPlacement(node, true);
    if (effect.type === 'StaticMesh') meshNames.add(name);
  }
  addSoundEmitters(group, effects, counts);
  return { group, meshNames };
}

export function updateEmittedEffects(frames) {
  const camera = _R.getCamera();
  const camWorldPos = camera.getWorldPosition(new THREE.Vector3());
  for (const emitter of _R.getEmittedEffects()) {
    const { effect, particles } = emitter;
    for (const p of particles) {
      if (!effect.continuousSingleton) p.age = (p.age + frames) % effect.maxLifeSpan;
      const t = effect.continuousSingleton ? 0 : p.age;
      p.node.position.set(effect.velocity[0] * t, effect.velocity[1] * t, effect.velocity[2] * t);
      if (p.node.userData.billboard) {
        const camLocal = p.node.parent.worldToLocal(camWorldPos.clone());
        const dx = camLocal.x - p.node.position.x;
        const dz = camLocal.z - p.node.position.z;
        const base = p.node.userData.baseRotation;
        p.node.rotation.set(base[0], Math.atan2(dx, dz) + base[1], base[2]);
      }
      const frameNodes = p.node.userData.frames;
      if (frameNodes?.length) {
        const frame = Math.floor(t / 3) % frameNodes.length;
        for (let i = 0; i < frameNodes.length; i++) frameNodes[i].visible = i === frame;
      }
    }
  }
}

export function buildSurfaceEffects(datBuf, meshes, templates, texMap, meshIdToName) {
  const group = new THREE.Group(); group.name = 'effects';
  const meshNames = new Set();
  const counts = new Map();
  let effects;
  try { effects = parseEffects(datBuf); } catch (e) { console.error('effects parse failed', e); return { group, meshNames }; }

  let effectOrder = 0;
  for (const gen of effects.generators) {
    if (!gen.autoRun) continue;
    const surf = describeSurface(gen);
    if (!surf || surf.hasEmission) continue;
    const name = meshIdToName.get(surf.meshLink);
    if (!name || isSkyName(name) || !templates.has(name)) continue;
    if (!isLegacyZoneEnvMesh(name)) continue;
    const b = decodeBlend(surf.blend);
    const tuned = tuneSurfaceForEditor(name, surf, b.blendFunc);
    const discard = tuned.blendFunc === 'One_Zero' ? 0 : (name.startsWith('_') ? 0.375 : (tuned.depthMask ? 0.01 : 0));
    const opts = { blendFunc: tuned.blendFunc, depthMask: tuned.depthMask,
      ignoreAlpha: surf.ignoreTextureAlpha, discard, lightingEnabled: surf.lightingEnabled, fogEnabled: tuned.fogEnabled };

    const node = new THREE.Group();
    node.renderOrder = 10000 + tuned.renderBias + effectOrder++;
    for (const { geometry, texKey } of templates.get(name)) {
      const mat = makeParticleMaterial(texKey ? texMap.get(texKey) : null, tuned.color, opts);
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.renderOrder = node.renderOrder;
      node.add(mesh);
      if (surf.uvScroll) _R.getAnimatedTextures().push({ uniform: mat.uniforms.uTranslate, scroll: surf.uvScroll });
      _R.getWaterTints().push({ uniform: mat.uniforms.uTexFactor, base: tuned.color, dayColors: surf.dayColors });
    }
    node.rotation.order = 'ZYX';
    trsMatrix(surf.position, surf.rotation, surf.scale).decompose(node.position, node.quaternion, node.scale);
    const label = `${VFX_LABEL[name] || name} [${fmtFourCC(surf.sectionId)}]`;
    const c = (counts.get(label) || 0) + 1; counts.set(label, c);
    node.name = c === 1 ? label : `${label}.${String(c).padStart(3, '0')}`;
    node.userData.effect = { mesh: name, sectionId: surf.sectionId, sourceOffset: surf.sourceOffset, specular: surf.specular, lighting: surf.lightingEnabled, fog: surf.fogEnabled, builder: 'surface' };
    group.add(node);
    registerPlacement(node, true);
    meshNames.add(name);
  }

  for (const gen of effects.generators) {
    if (!gen.autoRun) continue;
    const effect = describeEmitter(gen);
    if (!effect) continue;
    const name = effect.type === 'StaticMesh' ? meshIdToName.get(effect.meshLink) : effect.meshLink;
    if (!name || isSkyName(name)) continue;
    if (!isLegacyZoneEnvMesh(name)) continue;
    const entries = effect.type === 'StaticMesh' ? templates.get(name) : makeSpriteTemplate(effects.spriteSheets.get(effect.meshLink));
    if (!entries) continue;
    const b = decodeBlend(effect.blend);
    const opts = { blendFunc: b.blendFunc, depthMask: effect.depthMask, texMap,
      ignoreAlpha: effect.ignoreTextureAlpha, discard: effect.depthMask ? 0.01 : 0,
      lightingEnabled: effect.lightingEnabled, fogEnabled: effect.fogEnabled };
    const node = new THREE.Group();
    node.renderOrder = 11000 + effectOrder++;
    node.rotation.order = 'ZYX';
    trsMatrix(effect.position, [0, 0, 0], [1, 1, 1]).decompose(node.position, node.quaternion, node.scale);
    const label = `${VFX_LABEL[name] || name} [${fmtFourCC(effect.sectionId)}]`;
    const c = (counts.get(label) || 0) + 1; counts.set(label, c);
    node.name = c === 1 ? label : `${label}.${String(c).padStart(3, '0')}`;
    node.userData.effect = { mesh: name, sectionId: effect.sectionId, sourceOffset: effect.sourceOffset, specular: effect.specular, lighting: effect.lightingEnabled, fog: effect.fogEnabled, builder: 'emitter' };
    addEmittedEffect(node, entries, effect, opts, node.renderOrder);
    group.add(node);
    registerPlacement(node, true);
    if (effect.type === 'StaticMesh') meshNames.add(name);
  }

  _R.applyDayColors();
  addSoundEmitters(group, effects, counts);
  return { group, meshNames };
}

// ── VFX icon billboard system ─────────────────────────────────────────────────
const labelVFX = () => makeSymbolTexture('electric_bolt', '#ffd23f', '#161616');
const labelSFX = () => makeSymbolTexture('sound_detection_loud_sound', '#3b82f6', '#ffffff');
const labelSKY = () => makeSymbolTexture('clear_day', '#b3e5fc', '#0d47a1');

export function vfxIconScale() {
  const renderer = _R.getRenderer();
  const camera = _R.getCamera();
  const h = renderer.domElement.clientHeight || 1;
  const f = 1 / Math.tan(THREE.MathUtils.degToRad(camera.fov || 60) / 2);
  return 2 * _R.getVfxIconSize() / (f * h);
}

const VFX_ICON_NEAR = 8, VFX_ICON_FAR = 90;
export const VFX_ICON_MIN = 0.3;
export const VFX_ICON_FADE_MIN = 0.4;

export function vfxIconDistFactor(worldPos) {
  const camera = _R.getCamera();
  const d = camera.position.distanceTo(worldPos);
  const t = Math.min(1, Math.max(0, (d - VFX_ICON_NEAR) / (VFX_ICON_FAR - VFX_ICON_NEAR)));
  return 1 - t * (1 - VFX_ICON_MIN);
}

export function addVfxIcon(node) {
  const zoneRoot = _R.getZoneRoot();
  if (!zoneRoot) return;
  let vfxIconGroup = _R.getVfxIconGroup();
  if (!vfxIconGroup) {
    vfxIconGroup = new THREE.Group();
    vfxIconGroup.name = '__vfx_icons';
    vfxIconGroup.visible = _R.getShowVfxIcons();
    zoneRoot.add(vfxIconGroup);
    _R.setVfxIconGroup(vfxIconGroup);
  }
  const { texture, aspect } = node.userData.isSkyIcon ? labelSKY()
    : node.userData.effect?.sound ? labelSFX()
    : labelVFX();
  const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false });
  const sprite = new THREE.Sprite(mat);
  const s = vfxIconScale();
  sprite.userData.aspect = aspect;
  sprite.scale.set(s * aspect, s, 1);
  sprite.renderOrder = 13000;
  sprite.position.copy(node.position);
  sprite.userData.vfxNode = node;
  sprite.visible = node.userData.effect?.sound ? true : node.visible;
  vfxIconGroup.add(sprite);
}

// `isUnplaced`: geometry present in the DAT that no placement record references.
// The editor draws it at the origin so you can see what the zone ships, but the
// client never spawns it — flagged so the list can separate it from real objects.
export function registerPlacement(node, isEffect = false, isSky = false, isUnplaced = false) {
  const placements = _R.getPlacements();
  const placementSet = _R.getPlacementSet();
  placementSet.add(node);
  if (isEffect) { node.visible = false; addVfxIcon(node); }
  if (isSky) { node.userData.isSkyIcon = true; addVfxIcon(node); }
  node.userData.original = { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() };
  if (isUnplaced) node.userData.isUnplaced = true;
  placements.push({ node, name: node.name || '(unnamed)', isEffect, isSky, isUnplaced,
                    isSound: !!node.userData.effect?.sound });
}

export function setIconVisible(node, vis) { const g = _R.getVfxIconGroup(); if (g) for (const sp of g.children) if (sp.userData.vfxNode === node) sp.visible = vis; }
export function iconVisible(node) { const g = _R.getVfxIconGroup(); if (g) for (const sp of g.children) if (sp.userData.vfxNode === node) return sp.visible; return true; }

// Visibility for a VFX placement: node + icon + particle emitter pause/resume.
// Without pausing the emitter, continuousSingleton weather (sky domes, fog sheets)
// ages out while hidden and never re-emits — sky stays gone until zone reload.
export function setEffectNodeVisible(node, vis) {
  if (!node) return;
  node.visible = !!vis;
  setIconVisible(node, !!vis);
  const em = node.userData?.vfxEmitter;
  if (em && typeof em.setActive === 'function') em.setActive(!!vis);
}

export function pickIcon(e) {
  const camera = _R.getCamera();
  const canvas = _R.getCanvas();
  const placements = _R.getPlacements();
  const vfxIconGroup = _R.getVfxIconGroup();
  if (!vfxIconGroup || !vfxIconGroup.visible) return null;
  const r = canvas.getBoundingClientRect();
  const cx = e.clientX - r.left, cy = e.clientY - r.top;
  let bestNode = null, bestD = Infinity;
  const v = new THREE.Vector3();
  for (const sp of vfxIconGroup.children) {
    if (!sp.visible || !sp.userData.vfxNode) continue;
    sp.getWorldPosition(v);
    const px = vfxIconScale() * vfxIconDistFactor(v);
    const a = sp.userData.aspect || 1;
    const halfX = px * a / 2 + 3, halfY = px / 2 + 3;
    v.project(camera);
    if (v.z < -1 || v.z > 1) continue;
    const sx = (v.x * 0.5 + 0.5) * r.width, sy = (-v.y * 0.5 + 0.5) * r.height;
    const dx = sx - cx, dy = sy - cy;
    if (Math.abs(dx) <= halfX && Math.abs(dy) <= halfY) { const d = dx * dx + dy * dy; if (d < bestD) { bestD = d; bestNode = sp.userData.vfxNode; } }
  }
  return bestNode ? (placements.find((q) => q.node === bestNode) || null) : null;
}

// ── Cross-zone effect injection ───────────────────────────────────────────────
export function buildXZoneEffectNode(eff, isSoundGen, pos, displayName) {
  const placements = _R.getPlacements();
  const node = new THREE.Group();
  node.rotation.order = 'ZYX';
  node.position.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
  const baseName = displayName || `${eff.label} [${eff.id}]`;
  const n = placements.filter(p => p.name === baseName || p.name.startsWith(baseName + '.')).length;
  node.name = n === 0 ? baseName : `${baseName}.${String(n + 1).padStart(3, '0')}`;
  node.userData.effect = { sectionId: eff.id, sourceOffset: eff.sourceOffset ?? null, mesh: eff.mesh ?? null, sound: isSoundGen, soundId: eff.soundId ?? null, soundFile: eff.soundFile ?? null };
  node.userData.original = { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() };
  return node;
}

export function addXZoneEffect(eff, isSoundGen, zoneDatRel, posOverride) {
  const zoneRoot = _R.getZoneRoot();
  const addedEntries = _R.getAddedEntries();
  if (!zoneRoot) { _R.setStatus('No zone loaded.', true); return; }
  const pos = Array.isArray(posOverride)
    ? posOverride
    : [eff.pos?.[0] ?? 0, eff.pos?.[1] ?? 0, eff.pos?.[2] ?? 0];
  const node = buildXZoneEffectNode(eff, isSoundGen, pos);
  zoneRoot.add(node);
  registerPlacement(node, true);
  node.visible = true;
  setIconVisible(node, true);
  const placements = _R.getPlacements();
  const entry = placements[placements.length - 1];
  entry.sourceDat = zoneDatRel;
  entry.sourceId  = eff.id;
  entry.sourceOffset = eff.sourceOffset ?? null;
  addedEntries.add(entry);
  _R.markChange(node);
  _R.buildObjectList();
  _R.select(entry);
  _R.updateChangesUI();
  _R.setStatus(`Added ${eff.label} [${eff.id}] from ${zoneDatRel} — Publish to bake into DAT`);
  return entry;
}

// ── Disable VFX toggle ────────────────────────────────────────────────────────
export function applyDisableVfx(on) {
  _R.setDisableVfx(on);
  const disableVfxToggle = _R.getEl('toggle-disable-vfx');
  const disableVfxPaneToggle = _R.getEl('toggle-disable-vfx-pane');
  if (disableVfxToggle) disableVfxToggle.checked = on;
  if (disableVfxPaneToggle) disableVfxPaneToggle.checked = on;
  _R.saveProjectSetting('disableVfx', on);
  // Rebuild the CURRENTLY-loaded zone. Never the `#zone` dropdown value — it
  // drifts (project/custom/HD zones may not be an option, so it falls back to a
  // stale default or ''), which reloaded the wrong zone or wiped the scene.
  const url = _R.getCurrentZoneUrl?.() || _R.getEl('zone')?.value;
  if (url) _R.loadZone(url);
}
