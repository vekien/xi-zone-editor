// FFXI particle runtime — Loxley
// Accurate particle system for the FFXI Particle Editor.
// Reads parsed opcode data from effects.js and creates typed initializers/updaters.

import * as THREE from 'three';

const PI = Math.PI;
const MAX_PARTICLES = 300;

// ── Utility ────────────────────────────────────────────────────────────────

function rand() { return Math.random() * 2 - 1; }
function posRand(max) { return Math.random() * max; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

let WHITE_TEXTURE = null;

function whiteTexture() {
  if (!WHITE_TEXTURE) {
    WHITE_TEXTURE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    WHITE_TEXTURE.needsUpdate = true;
    WHITE_TEXTURE.colorSpace = THREE.NoColorSpace;
  }
  return WHITE_TEXTURE;
}

function ensureColorAttribute(geo) {
  if (geo.getAttribute('color')) return;
  const pos = geo.getAttribute('position');
  if (!pos) return;
  const colors = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) colors.set([1, 1, 1, 1], i * 4);
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
}

function buildXimParticleMaterial(texture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTexture: { value: texture || whiteTexture() },
      uParticleColor: { value: new THREE.Vector4(1, 1, 1, 1) },
      uAlphaTest: { value: 0.015 },
    },
    vertexShader: `
      attribute vec4 color;
      varying vec2 vUv;
      varying vec4 vColor;
      void main() {
        vUv = uv;
        vColor = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uTexture;
      uniform vec4 uParticleColor;
      uniform float uAlphaTest;
      varying vec2 vUv;
      varying vec4 vColor;
      void main() {
        vec4 texel = texture2D(uTexture, vUv);
        vec4 stage0 = 2.0 * (vColor * texel);
        vec4 outColor = vec4(2.0 * stage0.rgb * uParticleColor.rgb, 4.0 * stage0.a * uParticleColor.a);
        float contribution = max(max(outColor.r, outColor.g), outColor.b);
        outColor.a *= smoothstep(0.015, 0.12, contribution);
        if (outColor.a < uAlphaTest) discard;
        gl_FragColor = outColor;
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneFactor,
    toneMapped: false,
  });
}

/** Shift hue of an RGBA array in-place (degrees 0-360) */
function hueShiftRGB(c, deg) {
  const r = c[0], g = c[1], b = c[2];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  h = (h + deg / 360) % 1; if (h < 0) h += 1;
  if (s === 0) return;
  const hue2rgb = (p, q, t) => { if (t<0) t+=1; if (t>1) t-=1; if (t<1/6) return p+(q-p)*6*t; if (t<1/2) return q; if (t<2/3) return p+(q-p)*(2/3-t)*6; return p; };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  c[0] = hue2rgb(p, q, h + 1/3);
  c[1] = hue2rgb(p, q, h);
  c[2] = hue2rgb(p, q, h - 1/3);
}

/** Decode hex string from opcode into bytes + DataView */
function readPayload(op) {
  const hex = op.hex || '';
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  const dv = new DataView(bytes.buffer);
  return { bytes, dv, len: bytes.length };
}

/** Read a signed 16-bit value from DataView */
function getInt16(dv, off) { return dv.getInt16(off, true); }

// ── KeyFrame interpolation ─────────────────────────────────────────────────

class KeyFrameData {
  constructor(pairs) { this.pairs = pairs; } // [{time, value}]

  getValue(progress, initialOverride) {
    const p = this.pairs;
    if (p.length === 0) return 0;
    if (progress >= 1) return p[p.length - 1].value;

    let nextIdx = p.findIndex(e => e.time > progress);
    if (nextIdx < 0) nextIdx = p.length - 1;
    const prevIdx = Math.max(0, nextIdx - 1);

    const next = p[nextIdx];
    const prev = p[prevIdx];
    const prevVal = (prevIdx === 0 && initialOverride != null) ? initialOverride : prev.value;
    if (next.time === prev.time) return prevVal;

    const t = (progress - prev.time) / (next.time - prev.time);
    return (1 - t) * prevVal + t * next.value;
  }
}

function buildKeyFrameMap(keyframes) {
  const m = {};
  for (const kf of keyframes) m[kf.id] = new KeyFrameData(kf.pairs);
  return m;
}

// ── Dynamic particle data ──────────────────────────────────────────────────

class PositionTransform {
  constructor() {
    this.velocity = new THREE.Vector3();
    this.relativeVelocity = new THREE.Vector3();
    this.velocityRotation = new THREE.Vector3();
    this.dampeningFactor = null;
  }
}
class RotationTransform {
  constructor() { this.velocity = new THREE.Vector3(); }
}
class ScaleTransform {
  constructor() { this.velocity = new THREE.Vector3(); }
}
class ColorTransformData {
  constructor(r, g, b, a) { this.r = r; this.g = g; this.b = b; this.a = a; }
  copy() { return new ColorTransformData(this.r, this.g, this.b, this.a); }
}
class KeyFrameRef {
  constructor(id, numCycles) {
    this.id = id;
    this.numCycles = numCycles;
    this.initialValueOverride = null;
  }
}
class ChildEmitterState {
  constructor(childGenData, kfMap, overrides) {
    const sec2 = childGenData.sections?.[2]?.opcodes || [];
    const sec3 = childGenData.sections?.[3]?.opcodes || [];
    this.initializers = buildSec2Initializers(sec2, kfMap);
    this.updaters = buildSec3Updaters(sec3, kfMap);
    this.header = childGenData.header;
    this.framesPerEmission = this.header.framesPerEmission || 1;
    this.emissionVariance = this.header.emissionVariance || 0;
    this.particlesPerEmission = (this.header.particlesPerEmission || 0) + 1;
    this.continuousSingleton = this.header.continuousSingleton;
    this.framesUntilNext = 0;
    this.totalEmitted = 0;
    this.overrides = overrides; // share parent emitter's overrides
  }
}

// ── Particle ───────────────────────────────────────────────────────────────

class Particle {
  constructor() { this.reset(); }

  reset() {
    this.alive = false;
    this.age = 0;
    this.maxAge = Infinity;

    this.position = new THREE.Vector3();
    this.initialPosition = new THREE.Vector3();
    this.rotation = new THREE.Vector3();
    this.scale = new THREE.Vector3(1, 1, 1);
    this.negateRotationY = false;

    this.color = new Float32Array([1, 1, 1, 1]);
    this.colorMultiplier = new Float32Array([1, 1, 1, 1]);
    this.alphaOverride = null;

    this.billboardType = 'None';
    this.blendFunc = 'Src_One_Add';
    this.basePosition = new THREE.Vector3();
    this.followGenerator = true;
    this.depthMask = false;
    this.scaleBeforeRotate = false;
    this.rotationOrder = 'XYZ';
    this.linkedDataType = 'StaticMesh';

    this.dynamic = {};
    this.children = [];  // child particles from child generators
    this.parentOffset = new THREE.Vector3(); // world offset inherited from parent
    this.previousPosition = new THREE.Vector3();
    this.lastMovement = new THREE.Vector3();
    this.texCoordTranslate = [0, 0];
  }

  getProgress() { return this.maxAge === Infinity ? 0 : clamp(this.age / this.maxAge, 0, 1); }

  allocate(offset, data) { this.dynamic[offset] = data; return data; }
  getDynamic(offset) { return this.dynamic[offset]; }
  getDynamicByType(type) {
    for (const v of Object.values(this.dynamic)) { if (v instanceof type) return v; }
    return null;
  }

  getTotalVelocity(transform) {
    if (!transform) transform = this.getDynamicByType(PositionTransform);
    if (!transform) return new THREE.Vector3();
    const vel = new THREE.Vector3().copy(transform.velocity).add(transform.relativeVelocity);
    if (transform.velocityRotation.lengthSq() > 1e-14) {
      const m = new THREE.Matrix4().makeRotationFromEuler(
        new THREE.Euler(transform.velocityRotation.x, transform.velocityRotation.y, transform.velocityRotation.z, 'ZYX'));
      vel.applyMatrix4(m);
    }
    return vel;
  }

  getColor() {
    return [
      clamp(this.color[0] * this.colorMultiplier[0], 0, 2),
      clamp(this.color[1] * this.colorMultiplier[1], 0, 2),
      clamp(this.color[2] * this.colorMultiplier[2], 0, 2),
      clamp(this.color[3] * this.colorMultiplier[3], 0, 2),
    ];
  }
}

// ── Spherical position offset ──────────────────────────────────────────────

function sphOffset(baseRadius, radiusVar, sx, sy, sz, rotZ, rotY, tilt, tiltVar, rotDiv, totalEmitted) {
  const phi = rotDiv <= 1
    ? Math.random() * 2 * PI
    : PI + (2 * PI / rotDiv) * (totalEmitted % rotDiv);

  const rnd = radiusVar === 0 ? 0 : Math.pow(posRand(1), 1 / 3);
  const r = baseRadius + radiusVar * rnd;
  const tiltAngle = tilt + tiltVar * rand();

  const m = new THREE.Matrix4();
  const t = new THREE.Matrix4();
  m.makeRotationY(rotY);
  t.makeRotationZ(rotZ); m.multiply(t);
  t.makeScale(sx || 1, sy || 1, sz || 1); m.multiply(t);
  t.makeRotationY(phi); m.multiply(t);
  t.makeRotationZ(tiltAngle); m.multiply(t);
  t.makeTranslation(r, 0, 0); m.multiply(t);

  return new THREE.Vector3().setFromMatrixPosition(m);
}

// ══════════════════════════════════════════════════════════════════════════════
// Sec2 Initializer builders
// ══════════════════════════════════════════════════════════════════════════════

function buildSec2Initializers(opcodes, kfMap, genMap, overrides) {
  const inits = [];
  for (const op of (opcodes || [])) {
    const fn = buildSec2Init(parseInt(op.op, 16), op, kfMap, genMap, overrides);
    if (fn) inits.push(fn);
  }
  return inits;
}

function buildSec2Init(opc, op, kfMap, genMap, overrides) {
  const { bytes, dv, len } = readPayload(op);
  const alloc = op.alloc;

  switch (opc) {
    case 0x01: return initStandardSetup(bytes, dv, len);
    case 0x02: return initTranslationVelocity(alloc, dv);
    case 0x03: return initVelocityVariance(alloc, dv);
    case 0x06: return initSphPosSimple(dv);
    case 0x07: return initSphPosMedium(dv, len);
    case 0x08: return initRelativeVelocity(alloc, dv);
    case 0x09: return initRotation(dv);
    case 0x0A: return initRotationVariance(dv);
    case 0x0B: return initRotationVelocity(alloc, dv);
    case 0x0C: return initVelocityVariance(alloc, dv); // rotation vel variance
    case 0x0F: return initScale(dv);
    case 0x10: return initScaleVariance(dv);
    case 0x11: return initSingleScaleVariance(dv);
    case 0x12: return initScaleVelocity(alloc, dv);
    case 0x13: return initVelocityVariance(alloc, dv); // scale vel variance
    case 0x16: return initColor(bytes, len);
    case 0x17: return initColorVariance(bytes, len);
    case 0x18: return initUniformColorVariance(bytes, dv, len);
    case 0x19: return initColorTransform(alloc, dv);
    case 0x1A: return initColorTransformVariance(alloc, dv);
    case 0x1E: return initBlendFunc(bytes);
    case 0x1F: return initSphPosFull(bytes, dv, len);
    case 0x31: return initRandomVelocity(alloc, dv);
    case 0x3B: return initIncrementalRotation(dv);
    case 0x44: return initChildGenerator(alloc, bytes, kfMap, genMap, overrides);
    case 0x53: return initChildGenerator(alloc, bytes, kfMap, genMap, overrides); // ChildGenerator2
    case 0x6A: return initChildGenerator(alloc, bytes, kfMap, genMap, overrides); // ChildGenerator3
    case 0x67: return initReverseDisplacement(alloc, dv);
    default:
      // KeyFrame value setups
      if (isKeyFrameInit(opc)) return initKeyFrameValue(alloc, bytes, kfMap);
      return null;
  }
}

const KF_INIT_OPS = new Set([
  0x21,0x22,0x23, 0x24,0x25,0x26, 0x27,0x28,0x29,
  0x2A,0x2B,0x2C,0x2D, 0x2E,0x2F,
  0x33,0x34,0x35,0x36,0x37, 0x39,
  0x50,0x51,0x52,
  0x69, 0x74,0x75, 0x76,0x77,0x78,
]);
function isKeyFrameInit(opc) { return KF_INIT_OPS.has(opc); }

// ── StandardSetup (0x01) ──

function initStandardSetup(bytes, dv, len) {
  if (len < 30) return null;
  // Payload layout (expect32 reads ONE u32):
  //  0-1:  billboardFlags (u16)
  //  2-3:  renderStateFlags (u16)
  //  4-7:  zero (u32)
  //  8-11: linkedDataId (4 chars)
  // 12-15: zero float
  // 16-27: basePosition (3 × f32)
  // 28:    allocSize (u8)
  // 29:    linkedDataType (u8)
  // 30-31: maxLifeSpan (u16)
  // 32-33: lifeSpanVariance (u16)
  // 34-35: unused (u16)
  // 36-43: two expect32 checks
  const bbFlags = dv.getUint16(0, true);
  const rsFlags = dv.getUint16(2, true);

  let billboardType = 'None';
  if ((bbFlags & 0x00C0) === 0xC0) billboardType = 'Camera';
  else if ((bbFlags & 0x0081) === 0x81) billboardType = 'Movement';
  else if (bbFlags & 0x0080) billboardType = 'MovementHorizontal';
  else if (bbFlags & 0x0040) billboardType = 'Movement';
  else if (bbFlags & 0x4000) billboardType = 'XZ';
  else if (bbFlags & 0x0001) billboardType = 'XYZ';

  const scaleBeforeRotate = !!(bbFlags & 0x0002);
  const rotationOrder = (bbFlags & 0x0200) ? 'ZYX' : 'XYZ';
  const depthMask = !!(bbFlags & 0x1000);
  const followGenerator = !(rsFlags & 0x0080);

  const basePos = len >= 28
    ? new THREE.Vector3(dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true))
    : new THREE.Vector3();

  const LDT = {0x01:'Actor',0x0B:'StaticMesh',0x0E:'SpriteSheet',0x1D:'WeightedMesh',
    0x22:'Distortion',0x24:'RingMesh',0x39:'LensFlare',0x3D:'Audio',0x47:'PointLight',0x57:'Null'};
  const linkedDataType = len >= 30 ? (LDT[bytes[29]] || 'StaticMesh') : 'StaticMesh';

  let maxLifeSpan = len >= 32 ? dv.getUint16(30, true) : 0;
  const lifeSpanVar = len >= 34 ? dv.getUint16(32, true) : 0;
  if (maxLifeSpan === 0) maxLifeSpan = Infinity;

  // linkedDataId at offset 8-11 (DatId string)
  let linkedDataId = '';
  if (len >= 12) {
    linkedDataId = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).replace(/\0/g, '').trim();
  }

  const init = (p) => {
    p.billboardType = billboardType;
    p.scaleBeforeRotate = scaleBeforeRotate;
    p.rotationOrder = rotationOrder;
    p.depthMask = depthMask;
    p.followGenerator = followGenerator;
    p.linkedDataType = linkedDataType;
    p.basePosition.copy(basePos);
    p.maxAge = maxLifeSpan === Infinity ? Infinity : maxLifeSpan + posRand(lifeSpanVar);
  };
  init._linkedDataId = linkedDataId;
  init._linkedDataType = linkedDataType;
  return init;
}

// ── Velocity/Position ──

function initTranslationVelocity(alloc, dv) {
  const vx = dv.getFloat32(0, true), vy = dv.getFloat32(4, true), vz = dv.getFloat32(8, true);
  return (p) => { p.allocate(alloc, new PositionTransform()).velocity.set(vx, vy, vz); };
}

function initVelocityVariance(alloc, dv) {
  const vx = dv.getFloat32(0, true), vy = dv.getFloat32(4, true), vz = dv.getFloat32(8, true);
  return (p) => {
    const t = p.getDynamic(alloc);
    if (t) { t.velocity.x += vx * rand(); t.velocity.y += vy * rand(); t.velocity.z += vz * rand(); }
  };
}

function initRelativeVelocity(alloc, dv) {
  const vel = dv.getFloat32(0, true);
  return (p) => {
    const t = p.getDynamic(alloc);
    if (!t || p.initialPosition.lengthSq() === 0) return;
    t.relativeVelocity.copy(p.initialPosition.clone().normalize().multiplyScalar(vel));
  };
}

function initRandomVelocity(alloc, dv) {
  const val = dv.getFloat32(0, true);
  return (p) => {
    const t = p.getDynamic(alloc);
    if (t) { const r = val * rand(); t.velocity.set(r, r, r); }
  };
}

function initReverseDisplacement(alloc, dv) {
  return (p) => {
    const t = p.getDynamic(alloc);
    if (!(t instanceof PositionTransform)) return;
    p.position.add(p.getTotalVelocity(t).multiplyScalar(p.maxAge));
    t.velocity.multiplyScalar(-1);
    t.relativeVelocity.multiplyScalar(-1);
  };
}

// ── Spherical position variance ──

function initSphPosSimple(dv) {
  const rv = dv.getFloat32(0, true), br = dv.getFloat32(4, true);
  return (p, e) => { p.initialPosition.add(sphOffset(br, rv, 1, 1, 1, 0, 0, 0, PI, 1, e?.totalEmitted)); };
}

function initSphPosMedium(dv, len) {
  const rv = dv.getFloat32(0, true), br = dv.getFloat32(4, true);
  const sx = len >= 12 ? dv.getFloat32(8, true) : 1;
  const sy = len >= 16 ? dv.getFloat32(12, true) : 1;
  const sz = len >= 20 ? dv.getFloat32(16, true) : 1;
  const yRot = len >= 28 ? dv.getFloat32(24, true) : 0;
  return (p, e) => { p.initialPosition.add(sphOffset(br, rv, sx, sy, sz, 0, yRot, 0, PI, 1, e?.totalEmitted)); };
}

function initSphPosFull(bytes, dv, len) {
  const rv = dv.getFloat32(0, true), br = dv.getFloat32(4, true);
  const sx = dv.getFloat32(8, true), sy = dv.getFloat32(12, true), sz = dv.getFloat32(16, true);
  const rZ = dv.getFloat32(20, true), rY = dv.getFloat32(24, true);
  const tilt = dv.getFloat32(28, true), tiltVar = dv.getFloat32(32, true);
  const rotDiv = len >= 44 ? 1 + dv.getUint32(40, true) : 1;
  return (p, e) => { p.initialPosition.add(sphOffset(br, rv, sx, sy, sz, rZ, rY, tilt, tiltVar, rotDiv, e?.totalEmitted)); };
}

// ── Rotation ──

function initRotation(dv) {
  const rx = dv.getFloat32(0, true), ry = dv.getFloat32(4, true), rz = dv.getFloat32(8, true);
  return (p) => { p.rotation.set(rx, ry, rz); };
}

function initRotationVariance(dv) {
  const vx = dv.getFloat32(0, true), vy = dv.getFloat32(4, true), vz = dv.getFloat32(8, true);
  return (p) => { p.rotation.x += vx * rand(); p.rotation.y += vy * rand(); p.rotation.z += vz * rand(); };
}

function initRotationVelocity(alloc, dv) {
  const vx = dv.getFloat32(0, true), vy = dv.getFloat32(4, true), vz = dv.getFloat32(8, true);
  return (p) => { p.allocate(alloc, new RotationTransform()).velocity.set(vx, vy, vz); };
}

function initIncrementalRotation(dv) {
  const rx = dv.getFloat32(0, true), ry = dv.getFloat32(4, true), rz = dv.getFloat32(8, true);
  return (p, e) => {
    const n = 1 + (e?.totalEmitted || 0);
    p.rotation.x += rx * n; p.rotation.y += ry * n; p.rotation.z += rz * n;
    p.negateRotationY = true;
  };
}

// ── Scale ──

function initScale(dv) {
  const sx = dv.getFloat32(0, true), sy = dv.getFloat32(4, true), sz = dv.getFloat32(8, true);
  return (p) => { p.scale.set(sx, sy, sz); };
}

function initScaleVariance(dv) {
  const vx = dv.getFloat32(0, true), vy = dv.getFloat32(4, true), vz = dv.getFloat32(8, true);
  return (p) => { p.scale.x += vx * posRand(1); p.scale.y += vy * posRand(1); p.scale.z += vz * posRand(1); };
}

function initSingleScaleVariance(dv) {
  const v = dv.getFloat32(0, true);
  return (p) => { const r = posRand(v); p.scale.x += r; p.scale.y += r; p.scale.z += r; };
}

function initScaleVelocity(alloc, dv) {
  const vx = dv.getFloat32(0, true), vy = dv.getFloat32(4, true), vz = dv.getFloat32(8, true);
  return (p) => { p.allocate(alloc, new ScaleTransform()).velocity.set(vx, vy, vz); };
}

// ── Color ──

function initColor(bytes, len) {
  if (len < 4) return null;
  let r, g, b, a;
  if (len >= 16) {
    // 4 float32 RGBA
    const dv = new DataView(bytes.buffer);
    r = dv.getFloat32(0, true); g = dv.getFloat32(4, true);
    b = dv.getFloat32(8, true); a = dv.getFloat32(12, true);
    // Validate — if values look like byte-range nonsense, fall back
    if ([r,g,b,a].some(v => isNaN(v) || Math.abs(v) > 100)) {
      r = bytes[0] / 255; g = bytes[1] / 255; b = bytes[2] / 255; a = bytes[3] / 255;
    }
  } else {
    // 4 bytes RGBA (0-255) → float /255
    r = bytes[0] / 255; g = bytes[1] / 255; b = bytes[2] / 255; a = bytes[3] / 255;
  }
  return (p) => { p.color[0] = r; p.color[1] = g; p.color[2] = b; p.color[3] = a; };
}

function initColorVariance(bytes, len) {
  if (len < 4) return null;
  let vr, vg, vb, va;
  if (len >= 16) {
    const dv = new DataView(bytes.buffer);
    vr = dv.getFloat32(0, true); vg = dv.getFloat32(4, true);
    vb = dv.getFloat32(8, true); va = dv.getFloat32(12, true);
    if ([vr,vg,vb,va].some(v => isNaN(v) || Math.abs(v) > 100)) {
      vr = bytes[0] / 255; vg = bytes[1] / 255; vb = bytes[2] / 255; va = bytes[3] / 255;
    }
  } else {
    vr = bytes[0] / 255; vg = bytes[1] / 255; vb = bytes[2] / 255; va = bytes[3] / 255;
  }
  return (p) => {
    p.color[0] += vr * posRand(1); p.color[1] += vg * posRand(1);
    p.color[2] += vb * posRand(1); p.color[3] += va * posRand(1);
  };
}

function initUniformColorVariance(bytes, dv, len) {
  if (len < 4) return null;
  const v = (dv.getUint32(0, true) & 0xFF) / 255;
  return (p) => {
    const f = v * posRand(1);
    p.color[0] += f; p.color[1] += f; p.color[2] += f; p.color[3] += f;
  };
}

function initColorTransform(alloc, dv) {
  const r = getInt16(dv, 0), g = getInt16(dv, 2), b = getInt16(dv, 4), a = getInt16(dv, 6);
  return (p) => { p.allocate(alloc, new ColorTransformData(r, g, b, a)); };
}

function initColorTransformVariance(alloc, dv) {
  const vr = getInt16(dv, 0), vg = getInt16(dv, 2), vb = getInt16(dv, 4), va = getInt16(dv, 6);
  return (p) => {
    const ct = p.getDynamic(alloc);
    if (ct instanceof ColorTransformData) {
      ct.r += Math.round(posRand(1) * vr);
      ct.g += Math.round(posRand(1) * vg);
      ct.b += Math.round(posRand(1) * vb);
      ct.a += Math.round(posRand(1) * va);
    }
  };
}

// ── BlendFunc (0x1E) ──

function initBlendFunc(bytes) {
  if (bytes.length < 4) return null;
  const p0 = bytes[0], p1 = bytes[1];
  let alphaOverride = null;
  if (p0 & 0x20) alphaOverride = Math.min(p1 * 2, 0xFF);

  const high = (p0 >>> 4) & 0b1101;
  const low = p0 & 0x0F;

  let blendFunc;
  if (high & 0x01) blendFunc = 'One_Zero';
  else {
    switch (low) {
      case 0x1: case 0x2: blendFunc = 'Src_One_RevSub'; break;
      case 0x4: blendFunc = 'Src_InvSrc_Add'; break;
      case 0x6: blendFunc = 'Zero_InvSrc_Add'; break;
      case 0x8: default: blendFunc = 'Src_One_Add'; break;
    }
  }
  return (p) => { p.blendFunc = blendFunc; p.alphaOverride = alphaOverride; };
}

// ── KeyFrame value setup ──

function initKeyFrameValue(alloc, bytes, kfMap) {
  // payload: 4 bytes zero, 4 bytes DatId, 4 bytes config
  if (bytes.length < 12) return null;
  const id = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]).replace(/\0/g, '').trim();
  const dv = new DataView(bytes.buffer);
  const config = dv.getUint32(8, true);
  const numCycles = Math.max(1, (config & 0xFFFF) >>> 5);

  return (p) => { p.allocate(alloc, new KeyFrameRef(id, numCycles)); };
}

// ── Child generator setup (0x44) ──

function initChildGenerator(alloc, bytes, kfMap, genMap, overrides) {
  if (bytes.length < 8) return null;
  const childId = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]).replace(/\0/g, '').trim();
  if (!childId) return null;

  return (p, emitter) => {
    const map = genMap || emitter?.genMap;
    const childGen = map?.[childId];
    if (!childGen) return;
    const childState = new ChildEmitterState(childGen, kfMap, overrides || emitter?.overrides);
    childState.childGenId = childId;
    // Find the child generator's linked texture ID from its StandardSetup
    const childSetup = childState.initializers.find(fn => fn._linkedDataId !== undefined);
    childState.linkedDataId = childSetup?._linkedDataId || '';
    p.allocate(alloc, childState);
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Sec3 Updater builders
// ══════════════════════════════════════════════════════════════════════════════

function buildSec3Updaters(opcodes, kfMap) {
  const ups = [];
  for (const op of (opcodes || [])) {
    const fn = buildSec3Upd(parseInt(op.op, 16), op, kfMap);
    if (fn) ups.push(fn);
  }
  return ups;
}

function buildSec3Upd(opc, op, kfMap) {
  const { bytes, dv, len } = readPayload(op);
  const alloc = op.alloc;

  switch (opc) {
    // Position/Velocity
    case 0x02: return updPosition(alloc);
    case 0x03: return updVelocityAccel(alloc, dv);
    case 0x06: return updVelocityAccel(alloc, dv); // rotation accel
    case 0x09: return updVelocityAccel(alloc, dv); // scale accel

    // Rotation
    case 0x05: return updRotation(alloc);

    // Scale
    case 0x08: return updScale(alloc);

    // Color
    case 0x0B: return updColorTransform(alloc);
    case 0x0C: return updColorTransformMod(alloc, dv);

    // Progress-based value updaters
    case 0x0F: return updProgress(alloc, kfMap, null, (p, v) => { p.position.x = v; });
    case 0x10: return updProgress(alloc, kfMap, null, (p, v) => { p.position.y = v; });
    case 0x11: return updProgress(alloc, kfMap, null, (p, v) => { p.position.z = v; });
    case 0x12: return updProgress(alloc, kfMap, p => p.rotation.x / PI, (p, v) => { p.rotation.x = v * PI; });
    case 0x13: return updProgress(alloc, kfMap, p => p.rotation.y / PI, (p, v) => { p.rotation.y = v * PI; });
    case 0x14: return updProgress(alloc, kfMap, p => p.rotation.z / PI, (p, v) => { p.rotation.z = v * PI; });
    case 0x15: return updProgress(alloc, kfMap, p => p.scale.x, (p, v) => { p.scale.x = v; });
    case 0x16: return updProgress(alloc, kfMap, p => p.scale.y, (p, v) => { p.scale.y = v; });
    case 0x17: return updProgress(alloc, kfMap, p => p.scale.z, (p, v) => { p.scale.z = v; });
    case 0x18: return updProgress(alloc, kfMap, p => p.color[0], (p, v) => { p.color[0] = v; });
    case 0x19: return updProgress(alloc, kfMap, p => p.color[1], (p, v) => { p.color[1] = v; });
    case 0x1A: return updProgress(alloc, kfMap, p => p.color[2], (p, v) => { p.color[2] = v; });
    case 0x1B: return updProgress(alloc, kfMap, p => p.color[3], (p, v) => { p.color[3] = v; });
    case 0x1C: return updProgress(alloc, kfMap, null, (p, v) => { p.texCoordTranslate[0] = v; });
    case 0x1D: return updProgress(alloc, kfMap, null, (p, v) => { p.texCoordTranslate[1] = v; });

    // Texture coordinate scroll
    case 0x27: return updTexCoord(0, dv);
    case 0x28: return updTexCoord(1, dv);

    // Velocity dampener
    case 0x2C: return updVelocityDampener(alloc, dv);

    // Velocity rotation updater
    case 0x2F: return updVelocityRotation(alloc);

    // Velocity rotator
    case 0x26: return updVelocityRotator(alloc, dv);

    // Progress-based velocity integration
    case 0x54: return updProgressIntegrate(alloc, kfMap, null, (p, v) => { p.texCoordTranslate[0] += v; });
    case 0x55: return updProgressIntegrate(alloc, kfMap, null, (p, v) => { p.texCoordTranslate[1] += v; });
    case 0x56: return updProgressIntegrate(alloc, kfMap, null, (p, v) => { p.rotation.x += v * PI; });
    case 0x57: return updProgressIntegrate(alloc, kfMap, null, (p, v) => { p.rotation.y += v * PI; });
    case 0x58: return updProgressIntegrate(alloc, kfMap, null, (p, v) => { p.rotation.z += v * PI; });

    // Child generator updaters
    case 0x25: return updChildGeneratorBasic(alloc);
    case 0x33: return updChildGeneratorBasic(alloc); // ChildGeneratorUpdater (billboard=None)

    // Dampener via progress
    case 0x44: return updProgress(alloc, kfMap, null, (p, v) => {
      const pt = p.getDynamicByType(PositionTransform);
      if (pt) pt.dampeningFactor = v;
    });

    default:
      return null;
  }
}

// ── Position updater ──

function updPosition(alloc) {
  return (dt, p) => {
    const t = p.getDynamic(alloc);
    if (!t) return;
    const vel = p.getTotalVelocity(t);
    p.position.x += vel.x * dt;
    p.position.y += vel.y * dt;
    p.position.z += vel.z * dt;
  };
}

// ── Velocity accelerator ──

function updVelocityAccel(alloc, dv) {
  const ax = dv.getFloat32(0, true), ay = dv.getFloat32(4, true), az = dv.getFloat32(8, true);
  return (dt, p) => {
    const t = p.getDynamic(alloc);
    if (t) { t.velocity.x += ax * dt; t.velocity.y += ay * dt; t.velocity.z += az * dt; }
  };
}

// ── Rotation updater ──

function updRotation(alloc) {
  return (dt, p) => {
    const t = p.getDynamic(alloc);
    if (t) { p.rotation.x += t.velocity.x * dt; p.rotation.y += t.velocity.y * dt; p.rotation.z += t.velocity.z * dt; }
  };
}

// ── Scale updater ──

function updScale(alloc) {
  return (dt, p) => {
    const t = p.getDynamic(alloc);
    if (t) { p.scale.x += t.velocity.x * dt; p.scale.y += t.velocity.y * dt; p.scale.z += t.velocity.z * dt; }
  };
}

// ── Color transform applier ──

function updColorTransform(alloc) {
  return (dt, p) => {
    const ct = p.getDynamic(alloc);
    if (!(ct instanceof ColorTransformData)) return;
    // (value >> 7) → Color(int) → /255 → * 0.5 * dt
    const scale = 0.5 * dt / 255;
    p.color[0] += (ct.r >> 7) * scale;
    p.color[1] += (ct.g >> 7) * scale;
    p.color[2] += (ct.b >> 7) * scale;
    p.color[3] += (ct.a >> 7) * scale;
  };
}

// ── Color transform modifier ──

function updColorTransformMod(alloc, dv) {
  const mr = getInt16(dv, 0), mg = getInt16(dv, 2), mb = getInt16(dv, 4), ma = getInt16(dv, 6);
  return (dt, p) => {
    const ct = p.getDynamic(alloc);
    if (!(ct instanceof ColorTransformData)) return;
    const rate = dt / 30;
    ct.r += Math.floor(mr * rate);
    ct.g += Math.floor(mg * rate);
    ct.b += Math.floor(mb * rate);
    ct.a += Math.floor(ma * rate);
  };
}

// ── Progress value updater (keyframe-driven) ──

function updProgress(alloc, kfMap, initFn, updateFn) {
  return (dt, p) => {
    const ref = p.getDynamic(alloc);
    if (!(ref instanceof KeyFrameRef)) return;
    const kf = kfMap[ref.id];
    if (!kf) return;

    if (initFn && ref.initialValueOverride == null) {
      ref.initialValueOverride = initFn(p);
    }

    const progress = (ref.numCycles * p.getProgress()) % 1;
    const value = kf.getValue(progress, ref.initialValueOverride);
    updateFn(p, value);
  };
}

function updProgressIntegrate(alloc, kfMap, initFn, updateFn) {
  return (dt, p) => {
    const ref = p.getDynamic(alloc);
    if (!(ref instanceof KeyFrameRef)) return;
    const kf = kfMap[ref.id];
    if (!kf) return;

    if (initFn && ref.initialValueOverride == null) {
      ref.initialValueOverride = initFn(p);
    }

    const progress = (ref.numCycles * p.getProgress()) % 1;
    const value = kf.getValue(progress, ref.initialValueOverride);
    updateFn(p, value * dt);
  };
}

// ── Texture coordinate updater ──

function updTexCoord(axis, dv) {
  const amount = dv.getFloat32(0, true);
  return (dt, p) => { p.texCoordTranslate[axis] += amount * dt; };
}

// ── Velocity dampener ──

function updVelocityDampener(alloc, dv) {
  const dampen = dv.getFloat32(0, true);
  return (dt, p) => {
    const t = p.getDynamic(alloc);
    if (!(t instanceof PositionTransform || t instanceof RotationTransform || t instanceof ScaleTransform)) return;
    const factor = t.dampeningFactor ?? dampen;
    const f = Math.pow(factor, dt);
    t.velocity.multiplyScalar(f);
    if (t.relativeVelocity) t.relativeVelocity.multiplyScalar(f);
  };
}

// ── Child generator basic updater ──

function updChildGeneratorBasic(alloc) {
  return (dt, p) => {
    const cs = p.getDynamic(alloc);
    if (!(cs instanceof ChildEmitterState)) return;

    // Update existing children
    for (const child of p.children) {
      if (!child.alive) continue;
      child.age += dt;
      if (child.age >= child.maxAge) { child.alive = false; continue; }
      child.colorMultiplier[0] = 1; child.colorMultiplier[1] = 1;
      child.colorMultiplier[2] = 1; child.colorMultiplier[3] = 1;
      for (const upd of cs.updaters) upd(dt, child);
      child.lastMovement.copy(child.position).sub(child.previousPosition);
      child.previousPosition.copy(child.position);
    }

    // Remove dead children
    p.children = p.children.filter(c => c.alive);

    // Emit new children
    cs.framesUntilNext -= dt;
    while (cs.framesUntilNext <= 0) {
      if (cs.continuousSingleton && p.children.length > 0) break;
      const rateDiv = Math.max(0.01, cs.overrides?.emissionRate ?? 1);
      cs.framesUntilNext += (cs.framesPerEmission + posRand(cs.emissionVariance)) / rateDiv;

      const count = cs.continuousSingleton ? 1 : cs.particlesPerEmission;
      for (let i = 0; i < count; i++) {
        const child = new Particle();
        child.alive = true;
        for (const init of cs.initializers) init(child, cs);

        // Apply overrides
        const ov = cs.overrides || {};
        if (ov.lifetime && ov.lifetime !== 1 && child.maxAge !== Infinity) child.maxAge *= ov.lifetime;
        if (ov.speed && ov.speed !== 1) {
          const pt = child.getDynamicByType(PositionTransform);
          if (pt) { pt.velocity.multiplyScalar(ov.speed); pt.relativeVelocity.multiplyScalar(ov.speed); }
        }
        if (ov.scale && ov.scale !== 1) child.scale.multiplyScalar(ov.scale);

        // Tag child with generator info for rendering
        child._childGenId = cs.childGenId;
        child._childLinkedDataId = cs.linkedDataId;

        // Child inherits parent's world position as an offset (not baked into initialPosition)
        child.parentOffset.copy(p.basePosition).add(p.initialPosition).add(p.position);

        p.children.push(child);
        cs.totalEmitted++;
        if (cs.continuousSingleton) break;
        if (p.children.length >= MAX_PARTICLES) break;
      }
    }
  };
}

// ── Velocity rotation updater ──

function updVelocityRotation(alloc) {
  return (dt, p) => {
    const t = p.getDynamic(alloc);
    if (!t) return;
    const mag = t.velocity.length() + (t.relativeVelocity ? t.relativeVelocity.length() : 0);
    t.velocity.set(mag, 0, 0);
    if (t.relativeVelocity) t.relativeVelocity.set(0, 0, 0);
    t.velocityRotation.copy(p.rotation);
  };
}

// ── Velocity rotator ──

function updVelocityRotator(alloc, dv) {
  const rx = dv.getFloat32(0, true), ry = dv.getFloat32(4, true), rz = dv.getFloat32(8, true);
  return (dt, p) => {
    const t = p.getDynamic(alloc);
    if (!t) return;
    t.velocityRotation.x += rx * 0.5 * dt;
    t.velocityRotation.y += ry * 0.5 * dt;
    t.velocityRotation.z += rz * 0.5 * dt;
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Emitter (ParticleGenerator)
// ══════════════════════════════════════════════════════════════════════════════

export class ParticleEmitter {
  constructor(genData, effectsData, scene, camera, parent = null) {
    this.gen = genData;
    this.header = genData.header;
    this.scene = scene;
    this._camera = camera;
    this.enabled = true;

    // Build keyframe map
    this.kfMap = buildKeyFrameMap(effectsData.keyframes || []);

    // Build generator map for child generator lookups
    this.genMap = {};
    for (const g of (effectsData.generators || [])) this.genMap[g.id] = g;

    // Build typed initializers + updaters from opcodes
    const sec2 = genData.sections?.[2]?.opcodes || [];
    const sec3 = genData.sections?.[3]?.opcodes || [];
    this.initializers = buildSec2Initializers(sec2, this.kfMap, this.genMap);
    this.updaters = buildSec3Updaters(sec3, this.kfMap);

    // Emission params (from header)
    this.framesPerEmission = this.header.framesPerEmission || 1;
    this.emissionVariance = this.header.emissionVariance || 0;
    this.particlesPerEmission = (this.header.particlesPerEmission || 0) + 1; // FFXI adds 1 to stored value
    this.continuousSingleton = this.header.continuousSingleton;
    this.autoRun = this.header.autoRun;

    // For preview: force non-autoRun generators to emit
    if (!this.autoRun && this.framesPerEmission <= 1) {
      this.framesPerEmission = 3; // emit every 3 frames
    }

    // Timing
    this.lifetime = 0;
    this.framesUntilNext = 0;
    this.totalEmitted = 0;
    // Emission gate. A 0x07 EffectRoutine (spell player) sets this false to STOP spawning new
    // particles while letting live ones finish their lifespan (mirrors C++ stopEmitting()).
    this.emitting = true;

    // Editor overrides (multipliers, 1.0 = no change)
    this.overrides = {
      emissionRate: 1.0,    // multiplier on emission frequency
      lifetime: 1.0,        // multiplier on particle lifetime
      speed: 1.0,           // multiplier on velocity
      scale: 1.0,           // multiplier on particle scale
      spread: 1.0,          // multiplier on position spread
      colorR: 1.0,          // color multiplier R
      colorG: 1.0,          // color multiplier G
      colorB: 1.0,          // color multiplier B
      colorA: 1.0,          // alpha multiplier
      hue: 0,               // hue shift in degrees (0-360)
    };

    // Extract linked data ID from StandardSetup initializer
    const setupInit = this.initializers.find(fn => fn._linkedDataId !== undefined);
    this.linkedDataId = setupInit?._linkedDataId || '';
    this.linkedDataType = setupInit?._linkedDataType || 'StaticMesh';

    // Skip truly non-renderable types
    const SKIP_TYPES = new Set(['PointLight', 'Audio', 'LensFlare', 'Null']);
    if (SKIP_TYPES.has(this.linkedDataType)) {
      this.enabled = false;
    }
    this.isDistortion = (this.linkedDataType === 'Distortion');
    // Distortion particles are tracked for post-processing, not rendered as meshes
    this.distortionParticles = []; // [{x, y, scale, alpha}] in screen space

    // Particle pool
    this.particles = [];
    for (let i = 0; i < MAX_PARTICLES; i++) this.particles.push(new Particle());

    // Resolve particle mesh + texture via linkedDataId → ParticleMesh → texture name
    const resolved = this._resolveMeshAndTexture(effectsData);
    this.texture = resolved.texture;
    this.geo = resolved.geo;
    this.rawTex = resolved.rawTex; // for editor preview
    this.mat = this._buildMaterial();

    // Three.js mesh pool
    this.meshPool = [];
    this.meshGroup = new THREE.Group();
    if (parent) {
      // Caller (e.g. the level editor's zoneRoot) already owns the FFXI→display transform;
      // no extra rotation needed.  Dispose uses meshGroup.parent, not this.scene.
      parent.add(this.meshGroup);
    } else {
      // Standalone particle editor: apply -90° X to match three.js Y-up from FFXI space.
      this.meshGroup.rotation.x = -Math.PI / 2;
      this.scene.add(this.meshGroup);
    }

    // Child particle rendering (separate geo/texture per child generator)
    this.childMeshPools = {}; // genId → { pool, geo, mat }
    this._effectsData = effectsData;
  }

  _resolveMeshAndTexture(effectsData) {
    const textures = effectsData.textures || [];
    const particleMeshes = effectsData.particleMeshes || [];

    let geo = null;
    let texture = null;
    let texName = null;

    // 1. Find the ParticleMesh section matching linkedDataId
    if (this.linkedDataId) {
      const pm = particleMeshes.find(p => p.id === this.linkedDataId);
      if (pm?.meshes?.[0]) {
        const m = pm.meshes[0];
        geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3));
        if (m.colors) geo.setAttribute('color', new THREE.Float32BufferAttribute(m.colors, 4));
        if (m.uvs) geo.setAttribute('uv', new THREE.Float32BufferAttribute(m.uvs, 2));
        geo.computeBoundingSphere();
        texName = m.textureName;
      }
    }

    // 2. Find texture: by ParticleMesh textureName, then by linkedDataId, then fallback
    if (texName) {
      texture = textures.find(t => t.name === texName || t.sectionId === texName);
    }
    if (!texture && this.linkedDataId) {
      texture = textures.find(t => t.sectionId === this.linkedDataId);
      if (!texture) texture = textures.find(t => t.name === this.linkedDataId);
    }
    // Fallback: first texture that looks like a particle effect texture (not weapon)
    if (!texture) {
      texture = textures.find(t => t.rgba && t.name?.startsWith('eff'));
      if (!texture) texture = textures.find(t => t.rgba);
    }

    let rawTex = null;
    let threeTex = null;
    if (texture?.rgba) {
      rawTex = { rgba: texture.rgba, width: texture.width, height: texture.height, name: texture.name };
      threeTex = new THREE.DataTexture(texture.rgba, texture.width, texture.height, THREE.RGBAFormat);
      threeTex.needsUpdate = true;
      threeTex.magFilter = THREE.LinearFilter;
      threeTex.minFilter = THREE.LinearFilter;
      threeTex.wrapS = THREE.RepeatWrapping;
      threeTex.wrapT = THREE.RepeatWrapping;
      threeTex.colorSpace = THREE.NoColorSpace;
    }

    if (!geo) geo = new THREE.PlaneGeometry(3, 3);
    ensureColorAttribute(geo);

    return { geo, texture: threeTex, rawTex };
  }

  _buildMaterial() {
    return buildXimParticleMaterial(this.texture);
  }

  _emitParticle() {
    let p = null;
    for (const c of this.particles) if (!c.alive) { p = c; break; }
    if (!p) return null;

    p.reset();
    p.alive = true;

    // Apply all initializers in order
    for (const init of this.initializers) init(p, this);

    // Apply editor overrides
    const ov = this.overrides;
    if (ov.lifetime !== 1 && p.maxAge !== Infinity) p.maxAge *= ov.lifetime;
    if (ov.spread !== 1) p.initialPosition.multiplyScalar(ov.spread);

    // Velocity override
    if (ov.speed !== 1) {
      const pt = p.getDynamicByType(PositionTransform);
      if (pt) { pt.velocity.multiplyScalar(ov.speed); pt.relativeVelocity.multiplyScalar(ov.speed); }
    }

    // Scale override
    if (ov.scale !== 1) p.scale.multiplyScalar(ov.scale);

    // Color override
    p.color[0] *= ov.colorR;
    p.color[1] *= ov.colorG;
    p.color[2] *= ov.colorB;
    p.color[3] *= ov.colorA;

    this.totalEmitted++;
    return p;
  }

  // Editor visibility / pause. When off, particles freeze (no age/emit) so toggling a
  // weather VFX off and back on restores the same sky/singleton instead of leaving it dead.
  setActive(on) {
    if (on) {
      this.enabled = true;
      this.emitting = true;
      // continuousSingleton may have finished while we were inactive — force a fresh emit.
      if (this.continuousSingleton && this.aliveCount() === 0) this.framesUntilNext = 0;
    } else {
      this.enabled = false;
    }
  }

  update(dt) {
    if (!this.enabled || dt <= 0 || dt > 1) return;

    const FPS = 60;
    const elapsedFrames = dt * FPS;
    this.lifetime += elapsedFrames;

    // ── Emit ──
    this.framesUntilNext -= elapsedFrames;
    let aliveCount = this.particles.filter(p => p.alive).length;
    // continuousSingleton keeps exactly one particle alive; when it dies, emit again
    // immediately rather than waiting on framesPerEmission (which may be huge).
    if (this.continuousSingleton && aliveCount === 0 && this.emitting) {
      this.framesUntilNext = Math.min(this.framesUntilNext, 0);
    }

    while (this.emitting && this.framesUntilNext <= 0) {
      if (this.continuousSingleton && aliveCount > 0) break;

      const rateDiv = Math.max(0.01, this.overrides.emissionRate);
      this.framesUntilNext += (this.framesPerEmission + posRand(this.emissionVariance)) / rateDiv;

      const count = this.continuousSingleton ? 1 : this.particlesPerEmission;
      for (let i = 0; i < count; i++) {
        this._emitParticle();
        if (this.continuousSingleton) break;
      }
      aliveCount = this.particles.filter(p => p.alive).length;
      if (this.continuousSingleton) break;
    }

    // ── Update alive particles ──
    let meshIdx = 0;
    if (this.isDistortion) this.distortionParticles = [];

    for (const p of this.particles) {
      if (!p.alive) continue;

      // Store previous position for movement billboard
      p.previousPosition.copy(p.position);

      // Reset per-frame multiplier
      p.colorMultiplier[0] = 1; p.colorMultiplier[1] = 1;
      p.colorMultiplier[2] = 1; p.colorMultiplier[3] = 1;

      // Advance age
      p.age += elapsedFrames;
      if (p.age >= p.maxAge) { p.alive = false; continue; }

      // Apply all updaters
      for (const upd of this.updaters) {
        upd(elapsedFrames, p);
      }

      // Track movement for billboard
      p.lastMovement.copy(p.position).sub(p.previousPosition);

      // Distortion particles: collect for post-processing, skip mesh rendering
      if (this.isDistortion) {
        const worldPos = new THREE.Vector3().copy(p.basePosition).add(p.initialPosition).add(p.position);
        // Apply FFXI coordinate transform
        const transformed = worldPos.clone().applyEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
        const c = p.getColor();
        this.distortionParticles.push({
          worldPos: transformed,
          scale: Math.max(p.scale.x, p.scale.y) * 0.5,
          alpha: clamp(c[3], 0, 1),
        });
        continue; // don't render as mesh
      }

      // ── Render parent particle ──
      meshIdx = this._renderParticle(p, this.meshPool, this.geo, this.mat, meshIdx);

      // ── Render child particles ──
      for (const child of p.children) {
        if (!child.alive) continue;
        // Find or create the child mesh pool for this child's generator
        const childPool = this._getChildPool(child);
        if (!childPool) continue;
        childPool._idx = this._renderParticle(child, childPool.pool, childPool.geo, childPool.mat, childPool._idx || 0);
      }
    }

    // Hide unused meshes
    for (let i = meshIdx; i < this.meshPool.length; i++) this.meshPool[i].visible = false;

    // Hide unused child meshes
    for (const cp of Object.values(this.childMeshPools)) {
      for (let i = (cp._idx || 0); i < cp.pool.length; i++) cp.pool[i].visible = false;
      cp._idx = 0;
    }
  }

  // Stop spawning new particles; live ones keep updating until they age out. Used by the
  // spell EffectRoutine player to close a generator's emit window without a hard cut.
  stopEmitting() { this.emitting = false; }

  // Number of currently-live particles (parent only) — lets the routine player know when an
  // emitter has fully drained and can be disposed.
  aliveCount() {
    let n = 0;
    for (const p of this.particles) if (p.alive) n++;
    return n;
  }

  _renderParticle(p, pool, geo, baseMat, meshIdx) {
    while (pool.length <= meshIdx) {
      const m = new THREE.Mesh(geo, baseMat.clone());
      this.meshGroup.add(m);
      pool.push(m);
    }

    const mesh = pool[meshIdx];
    mesh.visible = true;

    // World position = parentOffset + basePosition + initialPosition + position
    mesh.position.copy(p.parentOffset).add(p.basePosition).add(p.initialPosition).add(p.position);

    this._applyBillboard(mesh, p);

    mesh.scale.set(
      Math.max(0.001, Math.abs(p.scale.x)),
      Math.max(0.001, Math.abs(p.scale.y)),
      Math.max(0.001, Math.abs(p.scale.z || p.scale.x)),
    );

    const c = p.getColor();
    if (this.overrides.hue) hueShiftRGB(c, this.overrides.hue);
    const alphaVal = p.alphaOverride != null ? (p.alphaOverride / 255) : clamp(c[3], 0, 1);
    if (mesh.material.uniforms?.uParticleColor) {
      mesh.material.uniforms.uParticleColor.value.set(clamp(c[0], 0, 1), clamp(c[1], 0, 1), clamp(c[2], 0, 1), alphaVal);
    }
    this._applyBlendState(mesh.material, p.blendFunc, p.depthMask);

    return meshIdx + 1;
  }

  _getChildPool(childParticle) {
    const key = childParticle._childGenId || 'default';
    if (this.childMeshPools[key]) return this.childMeshPools[key];

    const textures = this._effectsData?.textures || [];
    const linkedId = childParticle._childLinkedDataId || '';

    // Resolve texture by child generator's linked data ID
    let tex = null;
    if (linkedId) {
      tex = textures.find(t => t.sectionId === linkedId);
      if (!tex) tex = textures.find(t => t.name?.includes(linkedId));
    }
    if (!tex) tex = textures.find(t => t.rgba && t.name?.startsWith('eff'));

    let threeTex = null;
    if (tex?.rgba) {
      threeTex = new THREE.DataTexture(tex.rgba, tex.width, tex.height, THREE.RGBAFormat);
      threeTex.needsUpdate = true;
      threeTex.magFilter = THREE.LinearFilter;
      threeTex.minFilter = THREE.LinearFilter;
      threeTex.wrapS = THREE.RepeatWrapping;
      threeTex.wrapT = THREE.RepeatWrapping;
      threeTex.colorSpace = THREE.NoColorSpace;
    }

    const geo = new THREE.PlaneGeometry(1, 1);
    ensureColorAttribute(geo);
    const mat = buildXimParticleMaterial(threeTex);

    const pool = { pool: [], geo, mat, _idx: 0 };
    this.childMeshPools[key] = pool;
    return pool;
  }

  _applyBillboard(mesh, p) {
    const cam = this._camera;
    switch (p.billboardType) {
      case 'XYZ':
      case 'Camera':
        // Face camera
        mesh.quaternion.copy(cam.quaternion);
        break;
      case 'XZ':
        // Only rotate around Y to face camera
        mesh.quaternion.copy(cam.quaternion);
        // Zero out X and Z rotation
        mesh.rotation.x = 0;
        mesh.rotation.z = 0;
        break;
      case 'Movement':
      case 'MovementHorizontal': {
        const dir = p.lastMovement.clone();
        if (p.billboardType === 'MovementHorizontal') dir.y = 0;
        if (dir.lengthSq() > 1e-10) {
          dir.normalize();
          const up = new THREE.Vector3(0, 1, 0);
          const right = new THREE.Vector3().crossVectors(up, dir).normalize();
          const correctedUp = new THREE.Vector3().crossVectors(dir, right);
          const m = new THREE.Matrix4().makeBasis(right, correctedUp, dir);
          mesh.quaternion.setFromRotationMatrix(m);
        } else {
          mesh.quaternion.copy(cam.quaternion);
        }
        break;
      }
      case 'None':
      default: {
        // Apply particle rotation directly
        const rx = p.rotation.x;
        const ry = p.negateRotationY ? -p.rotation.y : p.rotation.y;
        const rz = p.rotation.z;
        if (p.rotationOrder === 'ZYX') {
          mesh.rotation.set(rx, ry, rz, 'ZYX');
        } else {
          mesh.rotation.set(rx, ry, rz, 'XYZ');
        }
        break;
      }
    }

    // For billboard types that also have rotation, apply it additively
    if (p.billboardType !== 'None' && p.rotation.lengthSq() > 1e-10) {
      const rotQ = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(p.rotation.x, p.rotation.y, p.rotation.z, p.rotationOrder === 'ZYX' ? 'ZYX' : 'XYZ'));
      mesh.quaternion.multiply(rotQ);
    }
  }

  _applyBlendState(material, func, depthMask) {
    const stateKey = `${func}:${depthMask ? 1 : 0}`;
    if (material.userData._ximBlendState === stateKey) return;
    material.userData._ximBlendState = stateKey;

    material.transparent = func !== 'One_Zero';
    material.blending = func === 'One_Zero' ? THREE.NoBlending : THREE.CustomBlending;
    material.blendEquation = THREE.AddEquation;
    material.blendSrc = THREE.SrcAlphaFactor;
    material.blendDst = THREE.OneFactor;
    material.depthWrite = depthMask;
    if (material.uniforms?.uAlphaTest) material.uniforms.uAlphaTest.value = func === 'One_Zero' ? 0 : 0.015;

    switch (func) {
      case 'One_Zero':
        material.blendSrc = THREE.OneFactor;
        material.blendDst = THREE.ZeroFactor;
        break;
      case 'Src_InvSrc_Add':
        material.blendSrc = THREE.SrcAlphaFactor;
        material.blendDst = THREE.OneMinusSrcAlphaFactor;
        break;
      case 'Src_One_RevSub':
        material.blendEquation = THREE.ReverseSubtractEquation;
        material.blendSrc = THREE.SrcAlphaFactor;
        material.blendDst = THREE.OneFactor;
        break;
      case 'Zero_InvSrc_Add':
        material.blendSrc = THREE.ZeroFactor;
        material.blendDst = THREE.OneMinusSrcAlphaFactor;
        break;
      case 'Src_One_Add':
      default:
        material.blendSrc = THREE.SrcAlphaFactor;
        material.blendDst = THREE.OneFactor;
        break;
    }
    material.needsUpdate = true;
  }

  dispose() {
    if (this.meshGroup) {
      (this.meshGroup.parent || this.scene).remove(this.meshGroup);
      for (const m of this.meshPool) { m.geometry.dispose(); m.material.dispose(); }
      for (const cp of Object.values(this.childMeshPools)) {
        for (const m of cp.pool) { m.geometry.dispose(); m.material.dispose(); }
        cp.geo.dispose();
        cp.mat.dispose();
      }
    }
    if (this.texture) this.texture.dispose();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Particle System Manager
// ══════════════════════════════════════════════════════════════════════════════

export class ParticleSystem {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.emitters = [];
    this.clock = new THREE.Clock();
    this.weaponBounds = null;
  }

  loadFromEffects(effects) {
    this.clear();
    for (const gen of effects.generators) {
      if (!gen.header.autoRun && !gen.header.continuousSingleton) continue;
      const e = new ParticleEmitter(gen, effects, this.scene, this.camera);
      this.emitters.push(e);
    }
  }

  loadAll(effects) {
    this.clear();
    for (const gen of effects.generators) {
      const e = new ParticleEmitter(gen, effects, this.scene, this.camera);
      this.emitters.push(e);
    }
  }

  update() {
    const dt = this.clock.getDelta();
    for (const e of this.emitters) e.update(dt);
  }

  getDistortionParticles() {
    const all = [];
    for (const e of this.emitters) {
      if (e.isDistortion && e.enabled) all.push(...e.distortionParticles);
    }
    return all;
  }

  clear() {
    for (const e of this.emitters) e.dispose();
    this.emitters = [];
  }
}
