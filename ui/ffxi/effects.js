// FFXI zone effects — Phase 1 parsers (verbatim port of xim's particle code).
//
// Zones drive water/fountain/sparkle effects with 0x05 ParticleGenerators that, on load,
// auto-run (genFlags & 0x10). Each generator emits particles whose geometry comes from a
// linked 0x1F ParticleMesh or 0x21 SpriteSheet (resolved by DatId). This module only
// PARSES those three section types into structured data; the emit/update/render runtime
// is Phase 2/3.
//
// Ports: ParticleGeneratorParser.kt, ParticleMeshSection.kt, SpriteSheetSection.kt,
//        StandardParticleSetup (ParticleInitializers.kt), LinkedDataType.

import { parseSections } from './zone.js';

// LinkedDataType (ParticleGeneratorSettings.kt) — what a generator's particles draw.
export const LinkedDataType = {
  0x01: 'Actor', 0x0B: 'StaticMesh', 0x0E: 'SpriteSheet', 0x1D: 'WeightedMesh',
  0x22: 'Distortion', 0x24: 'RingMesh', 0x39: 'LensFlare', 0x3D: 'Audio',
  0x47: 'PointLight', 0x57: 'Null',
};

const strAt = (bytes, p, n) => {
  let s = '';
  for (let i = 0; i < n; i++) { const c = bytes[p + i]; if (c === 0) break; s += String.fromCharCode(c); }
  return s.trim();
};

// ── 0x1F ParticleMesh ───────────────────────────────────────────────────────
function parseParticleMesh(bytes, dv, section) {
  const ds = section.dataStart;
  let p = ds;
  const version = dv.getUint32(p, true); p += 4;
  if (version !== 0x3 && version !== 0x6 && version !== 0x5) return null;

  const numWithTex = bytes[p++];
  const numWithoutTex = bytes[p++];
  const total = numWithTex + numWithoutTex;
  const _numTriangles = dv.getUint16(p, true); p += 2;

  const triArraySize = total <= 3 ? 3 : total <= 4 ? 4 : total <= 7 ? 7 : total <= 8 ? 8
    : total <= 11 ? 11 : total <= 12 ? 12 : 15;
  const trisInMesh = [];
  for (let i = 0; i < triArraySize; i++) { trisInMesh.push(dv.getUint16(p, true)); p += 2; }
  if (version === 0x03) p += 2; // expectZero u16

  const texNames = [];
  const iterations = version === 0x03 ? 4 : numWithTex;
  for (let i = 0; i < iterations; i++) { texNames.push(strAt(bytes, p, 0x10)); p += 0x10; }

  const colorScale = 2; // zone resource → vertex colours doubled (ParserContext note)
  const meshes = [];
  for (let k = 0; k < total; k++) {
    const numVerts = 3 * trisInMesh[k];
    const positions = new Float32Array(numVerts * 3);
    const normals = new Float32Array(numVerts * 3);
    const colors = new Float32Array(numVerts * 4);
    const uvs = new Float32Array(numVerts * 2);
    for (let i = 0; i < numVerts; i++) {
      positions[i * 3] = dv.getFloat32(p, true); positions[i * 3 + 1] = dv.getFloat32(p + 4, true); positions[i * 3 + 2] = dv.getFloat32(p + 8, true); p += 12;
      normals[i * 3] = dv.getFloat32(p, true); normals[i * 3 + 1] = dv.getFloat32(p + 4, true); normals[i * 3 + 2] = dv.getFloat32(p + 8, true); p += 12;
      const b = bytes[p], g = bytes[p + 1], r = bytes[p + 2], a = bytes[p + 3]; p += 4; // BGRA
      colors[i * 4] = Math.min(1, (r / 255) * colorScale); colors[i * 4 + 1] = Math.min(1, (g / 255) * colorScale);
      colors[i * 4 + 2] = Math.min(1, (b / 255) * colorScale); colors[i * 4 + 3] = Math.min(1, (a / 255) * colorScale);
      uvs[i * 2] = dv.getFloat32(p, true); uvs[i * 2 + 1] = dv.getFloat32(p + 4, true); p += 8;
    }
    meshes.push({ textureName: k < numWithTex ? texNames[k] : null, numVerts, positions, normals, colors, uvs });
  }
  return { id: section.id, meshes };
}

// ── 0x21 SpriteSheet ────────────────────────────────────────────────────────
function parseSpriteSheet(bytes, dv, section) {
  const ds = section.dataStart;
  let p = ds;
  const unkFlag = dv.getUint16(p, true); p += 2;
  const numMesh = dv.getUint16(p, true); p += 2;
  const lensFlare = bytes[p++] === 1;
  p += 2; // two u8
  const normalizationFlag = bytes[p++];
  const norm = (unkFlag === 1 && normalizationFlag === 0) ? 1 / 256 : 1;
  const textureName = strAt(bytes, p, 0x10); p += 0x10;

  const frames = [];
  const offsets = [];
  for (let i = 0; i < numMesh; i++) {
    p += 2; // unk1 (0x01)
    const numQuads = bytes[p++];
    p += 1; // unk2
    if (lensFlare) { offsets.push(dv.getFloat32(p, true)); p += 16; }
    const numVerts = 6 * numQuads;
    const positions = new Float32Array(numVerts * 3);
    const colors = new Float32Array(numVerts * 4);
    const uvs = new Float32Array(numVerts * 2);
    for (let j = 0; j < numVerts; j++) {
      positions[j * 3] = dv.getFloat32(p, true); positions[j * 3 + 1] = dv.getFloat32(p + 4, true); positions[j * 3 + 2] = dv.getFloat32(p + 8, true); p += 12;
      colors[j * 4] = bytes[p] / 255; colors[j * 4 + 1] = bytes[p + 1] / 255; colors[j * 4 + 2] = bytes[p + 2] / 255; colors[j * 4 + 3] = bytes[p + 3] / 255; p += 4; // RGBA
      uvs[j * 2] = dv.getFloat32(p, true) * norm; uvs[j * 2 + 1] = dv.getFloat32(p + 4, true) * norm; p += 8;
    }
    frames.push({ numVerts, positions, colors, uvs });
  }
  return { id: section.id, textureName, frames, offsets, lensFlare };
}

// ── 0x05 ParticleGenerator ──────────────────────────────────────────────────
// Generic opcode walk — each opcode self-sizes, so we can capture the full structure
// even for opcodes whose payload we haven't decoded yet (those come in Phase 2).
function walkOpcodes(dv, start, end) {
  const ops = [];
  let p = start;
  while (p + 4 <= end) {
    const cfg = dv.getUint32(p, true);
    const opcode = cfg & 0xFF;
    const size = (cfg >>> 8) & 0x1F; // dwords
    const allocationOffset = cfg >>> 13;
    if (opcode === 0x00) break;
    if (size === 0) break;
    const args = [];
    for (let i = 0; i < size - 1; i++) args.push(dv.getUint32(p + 4 + i * 4, true));
    ops.push({ opcode, size, allocationOffset, pos: p, args });
    p += size * 4;
  }
  return ops;
}

// StandardParticleSetup (0x01) — the core per-particle config: what mesh/sprite it draws
// (linkedDataType + linkedDataId), base position, lifespan (0 → infinite "singleton",
// e.g. the sea), and billboard/render flags.
function parseStandardSetup(bytes, dv, op) {
  let p = op.pos + 4; // skip the opcode config dword
  const billboardFlags = dv.getUint16(p, true); p += 2;
  const renderStateFlags = dv.getUint16(p, true); p += 2;
  p += 4; // expect32 0,0
  const linkedDataId = strAt(bytes, p, 0x4); p += 4;
  p += 4; // expectFloat ~0
  const basePosition = [dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)]; p += 12;
  p += 1; // alloc size u8
  const linkedTypeRaw = bytes[p++];
  const maxLifeSpan = dv.getUint16(p, true); p += 2;
  const lifeSpanVariance = dv.getUint16(p, true); p += 2;
  return {
    billboardFlags, renderStateFlags,
    linkedDataId, linkedDataType: LinkedDataType[linkedTypeRaw] || 'Unknown',
    basePosition,
    maxLifeSpan: maxLifeSpan === 0 ? Infinity : maxLifeSpan, // 0 = singleton (sea, etc.)
    lifeSpanVariance,
    singleton: maxLifeSpan === 0,
  };
}

function parseGenerator(bytes, dv, section) {
  const s = section.start;
  const attachFlags = dv.getUint16(s + 0x10, true); // dataStart = s+0x10
  const emissionVariance = dv.getUint16(s + 0x74, true);
  const framesPerEmission = dv.getUint16(s + 0x76, true) + 1;
  const particlesPerEmission = bytes[s + 0x78];
  const genFlags = bytes[s + 0x79];
  const autoRun = (genFlags & 0x10) !== 0;
  const continuousSingleton = (genFlags & 0x04) !== 0;
  const offs = [dv.getUint32(s + 0x80, true), dv.getUint32(s + 0x84, true), dv.getUint32(s + 0x88, true), dv.getUint32(s + 0x8C, true)];
  const end = s + section.size;
  const sections = offs.map((o) => (o ? walkOpcodes(dv, s + o, end) : []));

  // decode the universal 0x01 setup (in section 2) to learn what this generator draws
  let config = null;
  const setupOp = sections[1].find((o) => o.opcode === 0x01);
  if (setupOp) config = parseStandardSetup(bytes, dv, setupOp);

  return {
    id: section.id, sourceOffset: section.start, autoRun, continuousSingleton,
    attachType: attachFlags & 0x0F,
    framesPerEmission, particlesPerEmission, emissionVariance,
    sections, config,
  };
}

// ── surface effects (Phase 2a) ──────────────────────────────────────────────
// A "surface" generator binds an existing 0x2E mesh and renders it with a transform
// + blend + scrolling UV (water, tinted columns), WITHOUT emitting particles. Emitted
// effects (fountain spray/foam — they carry a 0x02 translation velocity) are Phase 2b.
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
const bits2float = (u) => { _u32[0] = u >>> 0; return _f32[0]; };
const findOp = (ops, code) => ops.find((o) => o.opcode === code);

// BlendFuncInitializer (0x1e): p0 byte selects the blend equation.
export function decodeBlend(blendVal) {
  if (blendVal == null) return { blendFunc: 'Src_One_Add' }; // Particle.kt default
  const p0 = blendVal & 0xFF;
  const high = (p0 >> 4) & 0b1101;
  const low = p0 & 0x0F;
  if (high & 0x01) return { blendFunc: 'One_Zero' };
  switch (low) {
    case 0x1: case 0x2: return { blendFunc: 'Src_One_RevSub' };
    case 0x4: return { blendFunc: 'Src_InvSrc_Add' };
    case 0x6: return { blendFunc: 'Zero_InvSrc_Add' };
    case 0x8: return { blendFunc: 'Src_One_Add' };
    default: return { blendFunc: 'Src_One_Add' };
  }
}

export function describeSurface(gen) {
  const c = gen.config;
  if (!c || c.linkedDataType !== 'StaticMesh') return null;
  const sec2 = gen.sections[1], sec3 = gen.sections[2];
  const sectionId = gen.id;  // 4-char FourCC — used to identify this generator in apply-changes
  if (findOp(sec2, 0x02)) return { hasEmission: true }; // translation velocity → emitted (Phase 2b)
  const rotOp = findOp(sec2, 0x09), sclOp = findOp(sec2, 0x0F), blendOp = findOp(sec2, 0x1E);
  const colOp = findOp(sec2, 0x16); // ColorSetup (RGBA) — tints the surface (esp. untextured water)
  const uvx = findOp(sec3, 0x27), uvy = findOp(sec3, 0x28);
  const cu = colOp ? colOp.args[0] >>> 0 : 0xFFFFFFFF;
  // 0x4E DayOfWeekColorUpdater: zero32 then 8 RGBA (one per elemental day). This is what
  // gives FFXI water its colour — getColor() = baseColor.modulate(dayColor, 2). Search all
  // op sections (updaters don't live in a fixed one).
  let dayColors = null;
  for (const sec of gen.sections) {
    const op = findOp(sec, 0x4E);
    if (op && op.args.length >= 9) {
      dayColors = [];
      for (let i = 1; i <= 8; i++) { const dw = op.args[i] >>> 0; dayColors.push([dw & 0xFF, (dw >>> 8) & 0xFF, (dw >>> 16) & 0xFF, (dw >>> 24) & 0xFF]); }
      break;
    }
  }
  return {
    dayColors,
    hasEmission: false,
    meshLink: c.linkedDataId,
    position: c.basePosition,
    rotation: rotOp ? rotOp.args.slice(0, 3).map(bits2float) : [0, 0, 0],
    scale: sclOp ? sclOp.args.slice(0, 3).map(bits2float) : [1, 1, 1],
    uvScroll: (uvx || uvy) ? [uvx ? bits2float(uvx.args[0]) : 0, uvy ? bits2float(uvy.args[0]) : 0] : null,
    blend: blendOp ? (blendOp.args[0] & 0xFFFF) : null,
    color: [cu & 0xFF, (cu >>> 8) & 0xFF, (cu >>> 16) & 0xFF, (cu >>> 24) & 0xFF], // RGBA 0..255 (textureFactor)
    ignoreTextureAlpha: (c.renderStateFlags & 0x1000) !== 0, // forces texel.a = 0.5 (xim StandardParticleSetup)
    lightingEnabled: (c.renderStateFlags & 0x0001) !== 0,    // xim Particle.config.lightingEnabled
    fogEnabled: (c.renderStateFlags & 0x0200) === 0,         // bit set DISABLES fog (xim)
    depthMask: (c.billboardFlags & 0x1000) !== 0,
    specular: (c.renderStateFlags & 0x0100) !== 0,           // xim Particle.config.specular (cubemap reflection)
    sectionId,                                               // 4-char FourCC for apply-changes write-back
    sourceOffset: gen.sourceOffset,
  };
}

// ── generator-driven object animation ──────────────────────────────────────
// A 0x1C placement whose BlockID (+0x34) names a generator is never drawn by the client's
// normal pass (ZoneRenderer::SetRenderTypes → RenderType 0); the generator draws the linked
// 0x2E mesh itself, at StandardSetup's base position, with sec2 0x09 as its rotation and the
// motion opcodes animating it. Rabao's windmill blades are the model case: f001 → de_fusya02,
// Rotation = the placement's yaw, RotationVelocity z = 0.0122 rad per 60 Hz frame, and a sec3
// RotationUpdater (0x05) integrating it. Describe that motion so the editor can play it on the
// placed object (core/zone-animations.js) and carry it with a copy (import-json `anim`).
export function describeObjectAnimation(gen) {
  const c = gen.config;
  if (!c || c.linkedDataType !== 'StaticMesh') return null;
  const sec2 = gen.sections[1], sec3 = gen.sections[2];
  const rotOp = findOp(sec2, 0x09), velOp = findOp(sec2, 0x0B), sclOp = findOp(sec2, 0x0F);
  // Only a RotationUpdater turns the velocity into motion; a velocity without one is inert.
  const spins = !!(velOp && findOp(sec3, 0x05));
  const rotVelocity = spins ? velOp.args.slice(0, 3).map(bits2float) : [0, 0, 0];
  return {
    sectionId: gen.id,
    sourceOffset: gen.sourceOffset,
    meshLink: c.linkedDataId,
    autoRun: gen.autoRun,
    position: c.basePosition,
    rotation: rotOp ? rotOp.args.slice(0, 3).map(bits2float) : [0, 0, 0],
    scale: sclOp ? sclOp.args.slice(0, 3).map(bits2float) : [1, 1, 1],
    rotVelocity,                                                  // radians per effect frame (60 Hz)
    rotationOrder: (c.billboardFlags & 0x0200) ? 'ZYX' : 'XYZ',   // xim StandardParticleSetup bit 0x200
    spins,
  };
}

export function describeEmitter(gen) {
  const c = gen.config;
  if (!c || (c.linkedDataType !== 'StaticMesh' && c.linkedDataType !== 'SpriteSheet' && c.linkedDataType !== 'LensFlare')) return null;
  const sec2 = gen.sections[1], sec3 = gen.sections[2];
  const velOp = findOp(sec2, 0x02);
  const rotOp = findOp(sec2, 0x09), sclOp = findOp(sec2, 0x0F), blendOp = findOp(sec2, 0x1E);
  const colOp = findOp(sec2, 0x16);
  const uvx = findOp(sec3, 0x27), uvy = findOp(sec3, 0x28);
  const cu = colOp ? colOp.args[0] >>> 0 : 0xFFFFFFFF;
  const alpha = (cu >>> 24) & 0xFF;
  const life = Number.isFinite(c.maxLifeSpan) ? c.maxLifeSpan : 180;
  return {
    type: c.linkedDataType,
    meshLink: c.linkedDataId,
    sectionId: gen.id,
    sourceOffset: gen.sourceOffset,
    position: c.basePosition,
    velocity: velOp ? velOp.args.slice(0, 3).map(bits2float) : [0, 0, 0],
    rotation: rotOp ? rotOp.args.slice(0, 3).map(bits2float) : [0, 0, 0],
    scale: sclOp ? sclOp.args.slice(0, 3).map(bits2float) : [1, 1, 1],
    uvScroll: (uvx || uvy) ? [uvx ? bits2float(uvx.args[0]) : 0, uvy ? bits2float(uvy.args[0]) : 0] : null,
    blend: blendOp ? (blendOp.args[0] & 0xFFFF) : null,
    // Some zone particles keyframe alpha from a 0 base value. Until keyframe curves are
    // fully evaluated, keep them visible in the editor rather than rendering nothing.
    color: [cu & 0xFF, (cu >>> 8) & 0xFF, (cu >>> 16) & 0xFF, alpha || 255],
    ignoreTextureAlpha: (c.renderStateFlags & 0x1000) !== 0,
    lightingEnabled: (c.renderStateFlags & 0x0001) !== 0,
    fogEnabled: (c.renderStateFlags & 0x0200) === 0,
    depthMask: (c.billboardFlags & 0x1000) !== 0,
    billboard: (c.billboardFlags & 0x40C1) !== 0 || c.linkedDataType === 'SpriteSheet' || c.linkedDataType === 'LensFlare',
    specular: (c.renderStateFlags & 0x0100) !== 0,
    maxLifeSpan: Math.max(1, life),
    framesPerEmission: Number.isFinite(gen.framesPerEmission) ? Math.max(1, gen.framesPerEmission) : life,
    particlesPerEmission: gen.continuousSingleton ? 1 : gen.particlesPerEmission + 1,
    continuousSingleton: gen.continuousSingleton,
  };
}

// Audio emitter: a generator whose linked-data type is Audio (0x3D). Its linkedDataId is
// the soundId; FFXI maps it to sound/win/se/se<NNN>/se<NNNNNN>.spw (folder = id/1000 padded
// to 3, file = id padded to 6 — see xim SoundEffectSection.soundIdToFolderAndFile). The
// generator's basePosition is where the sound plays from.
export function describeSound(gen) {
  const c = gen.config;
  if (!c || c.linkedDataType !== 'Audio') return null;
  const soundId = (c.linkedDataId >>> 0);
  const folder = String(Math.floor(soundId / 1000)).padStart(3, '0');
  const file = String(soundId).padStart(6, '0');
  return { sectionId: gen.id, sourceOffset: gen.sourceOffset, position: c.basePosition, soundId, file: `se${folder}/se${file}.spw` };
}

export function describePointLight(gen) {
  const c = gen.config;
  if (!c || c.linkedDataType !== 'PointLight') return null;
  const sec2 = gen.sections[1];
  const colOp = findOp(sec2, 0x16), lightOp = findOp(sec2, 0x58);
  const cu = colOp ? colOp.args[0] >>> 0 : 0xFFFFFFFF;
  return {
    sectionId: gen.id,
    sourceOffset: gen.sourceOffset,
    position: c.basePosition,
    color: [cu & 0xFF, (cu >>> 8) & 0xFF, (cu >>> 16) & 0xFF, ((cu >>> 24) & 0xFF) || 255],
    range: lightOp ? bits2float(lightOp.args[0]) : 20,
  };
}

// ── environments (0x2F) — time-of-day / weather lighting ────────────────────
const WEATHER_IDS = new Set(['fine', 'suny', 'clod', 'mist', 'dryw', 'heat', 'rain', 'squl',
  'dust', 'sand', 'wind', 'stom', 'snow', 'bliz', 'thdr', 'bolt', 'aura', 'ligt', 'fogd', 'dark']);

// LightConfig (EnvironmentSection.kt): sun/moon/ambient/fog RGBA + fogEnd/Start + diffuseMult.
function readLightConfig(bytes, dv, p) {
  const rgba = (o) => [bytes[p + o], bytes[p + o + 1], bytes[p + o + 2], bytes[p + o + 3]];
  return {
    sun: rgba(0), moon: rgba(4), ambient: rgba(8), fog: rgba(12),
    fogEnd: dv.getFloat32(p + 16, true), fogStart: dv.getFloat32(p + 20, true), diffuseMult: dv.getFloat32(p + 24, true),
  };
}

function parseEnvironment(bytes, dv, section) {
  // EnvironmentSection.kt layout: +0x0 indoorFlag, +0x4/+0x8 zero, +0xC modelLighting
  // (LightConfig, 28 bytes), +0x28 zero, +0x2C terrainLighting (LightConfig, 28 bytes).
  const ds = section.dataStart;
  const indoors = dv.getUint32(ds, true) === 1;
  return {
    indoors,
    model: readLightConfig(bytes, dv, ds + 0x0C),
    terrain: readLightConfig(bytes, dv, ds + 0x2C),
  };
}

// Map weatherId → environment by walking the 0x01(dir)/0x00(end) tree.
export function parseEnvironments(datBuffer) {
  const bytes = new Uint8Array(datBuffer);
  const dv = new DataView(bytes.buffer);
  const sections = parseSections(dv);
  const stack = [];
  const out = new Map();
  for (const s of sections) {
    if (s.typeCode === 0x01) stack.push(s.id);          // S01 directory (push)
    else if (s.typeCode === 0x00) stack.pop();          // S00 end (pop)
    else if (s.typeCode === 0x2F) {
      // Main outdoor environments live under the "weat" dir; "ev01" etc are indoor/event.
      if (!stack.includes('weat')) continue;
      const weather = [...stack].reverse().find((id) => WEATHER_IDS.has(id)) || 'default';
      if (!out.has(weather)) out.set(weather, parseEnvironment(bytes, dv, s));
    }
  }
  return out;
}

// ── top-level ─────────────────────────────────────────────────────────────────
export function parseEffects(datBuffer) {
  const bytes = new Uint8Array(datBuffer);
  const dv = new DataView(bytes.buffer);
  const sections = parseSections(dv);

  const generators = [];
  const particleMeshes = new Map();
  const spriteSheets = new Map();

  for (const sec of sections) {
    if (sec.typeCode === 0x05) generators.push(parseGenerator(bytes, dv, sec));
    else if (sec.typeCode === 0x1F) { const m = parseParticleMesh(bytes, dv, sec); if (m) particleMeshes.set(m.id, m); }
    else if (sec.typeCode === 0x21) { const s = parseSpriteSheet(bytes, dv, sec); if (s) spriteSheets.set(s.id, s); }
  }
  return { generators, particleMeshes, spriteSheets };
}
