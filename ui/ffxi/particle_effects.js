// FFXI particle effect parser — Loxley
// Ports xi_opcodes.py opcode tables and ParticleGeneratorParser.kt header
// parsing for the FFXI Particle Editor.

import { parseSections, parseTexture } from './sections.js';

// ── Opcode name tables (from xi_opcodes.py) ────────────────────────────────

const SEC1 = {
  0x04:'EmissionFrequency', 0x05:'RelativeVelocity', 0x06:'SphericalRadius',
  0x07:'SphericalRadiusVar', 0x08:'Gen.RotationZ', 0x09:'Gen.RotationY',
  0x0A:'GeneratorCull', 0x0B:'Gen.BasePosX', 0x0C:'Gen.BasePosY',
  0x0D:'Gen.BasePosZ', 0x0E:'Gen.RotationX', 0x0F:'Gen.RotationY',
  0x10:'Gen.RotationZ', 0x11:'Association', 0x12:'Gen.VelocityX',
  0x13:'Gen.VelocityY', 0x14:'Gen.VelocityZ',
};

const SEC2 = {
  0x01:'StandardSetup', 0x02:'TranslationVelocity', 0x03:'PosVelVariance',
  0x06:'SphPosVarSimple', 0x07:'SphPosVarMedium', 0x08:'RelativeVelocity',
  0x09:'Rotation', 0x0A:'RotationVariance', 0x0B:'RotationVelocity',
  0x0C:'RotVelVariance', 0x0F:'Scale', 0x10:'ScaleVariance',
  0x11:'SingleScaleVar', 0x12:'ScaleVelocity', 0x13:'ScaleVelVariance',
  0x16:'Color', 0x17:'ColorVariance', 0x18:'UniformColorVar',
  0x19:'ColorTransform', 0x1A:'ColorTransformVar', 0x1D:'SpriteSheet',
  0x1E:'BlendFunc', 0x1F:'SphPosVarFull', 0x30:'DepthBias',
  0x31:'RandomVelocity', 0x32:'HazeOffset',
  0x21:'KF.PosX', 0x22:'KF.PosY', 0x23:'KF.PosZ',
  0x24:'KF.RotX', 0x25:'KF.RotY', 0x26:'KF.RotZ',
  0x27:'KF.ScaleX', 0x28:'KF.ScaleY', 0x29:'KF.ScaleZ',
  0x2A:'KF.ColorR', 0x2B:'KF.ColorG', 0x2C:'KF.ColorB', 0x2D:'KF.ColorA',
  0x2E:'KF.TexCoordU', 0x2F:'KF.TexCoordV',
  0x33:'KF.WeightMesh0', 0x34:'KF.WeightMesh1', 0x35:'KF.WeightMesh2',
  0x36:'KF.WeightMesh3', 0x37:'KF.WeightMesh4',
  0x39:'KeyFrameValue', 0x3A:'RingMesh', 0x3B:'IncrementalRotation',
  0x3C:'OnceChildGenerator', 0x3D:'Oscillation',
  0x3E:'OscAccelX', 0x3F:'OscAccelY', 0x40:'OscAccelZ',
  0x41:'RelVelVariance', 0x42:'GroundProjection', 0x43:'DeferredBlendFunc',
  0x44:'ChildGenerator', 0x45:'ParentPosCopy', 0x46:'ParentVelocity',
  0x47:'ParentRotate', 0x48:'ParentColor', 0x49:'ParentScale',
  0x4A:'ParentTexCoord', 0x4C:'AudioRange',
  0x4E:'FixedPointPosVar', 0x4F:'FixedPointPosVar2',
  0x50:'KF.VelX', 0x51:'KF.VelY', 0x52:'KF.VelZ',
  0x53:'ChildGenerator2', 0x54:'PointListPosition',
  0x55:'SpecularParams', 0x56:'Batching', 0x58:'PointLightParams',
  0x59:'KF.SpecRotX', 0x5A:'KF.SpecRotY', 0x5B:'KF.SpecRotZ',
  0x5C:'KF.SpecColorR', 0x5D:'KF.SpecColorG', 0x5E:'KF.SpecColorB',
  0x5F:'KF.SpecColorA',
  0x60:'KF.ToDColorR', 0x61:'KF.ToDColorG', 0x62:'KF.ToDColorB', 0x63:'KF.ToDColorA',
  0x64:'KF.ToDScaleX', 0x65:'KF.ToDScaleY', 0x66:'KF.ToDScaleZ',
  0x67:'ReverseDisplacement', 0x68:'KF.ToDVolume', 0x69:'KF.VelDampener',
  0x6A:'ChildGenerator3', 0x6B:'PathReference', 0x6C:'KF.PointLightParams',
  0x72:'ProjectionBias',
  0x74:'KF.UVVelX', 0x75:'KF.UVVelY', 0x76:'KF.RotVelX', 0x77:'KF.RotVelY', 0x78:'KF.RotVelZ',
  0x79:'ParentRotate2', 0x7B:'ProgressPosOffset',
  0x82:'CameraShake',
  0x88:'PointLightAttach',
  0x8E:'FootMark',
  0x90:'DaylightColorAdj', 0x91:'DaylightColorSetup',
  0x9B:'ParentPosSnapshot',
};

const SEC3 = {
  0x02:'Position', 0x03:'VelocityAccel', 0x05:'Rotation', 0x06:'VelocityAccel2',
  0x08:'Scale', 0x09:'VelocityAccel3', 0x0B:'ColorTransform',
  0x0C:'ColorTransformMod', 0x0D:'SpriteSheetFrame', 0x0E:'AgeAdvance',
  0x0F:'Prog.PosX', 0x10:'Prog.PosY', 0x11:'Prog.PosZ',
  0x12:'Prog.RotX', 0x13:'Prog.RotY', 0x14:'Prog.RotZ',
  0x15:'Prog.ScaleX', 0x16:'Prog.ScaleY', 0x17:'Prog.ScaleZ',
  0x18:'Prog.ColorR', 0x19:'Prog.ColorG', 0x1A:'Prog.ColorB', 0x1B:'Prog.ColorA',
  0x1C:'Prog.TexU', 0x1D:'Prog.TexV',
  0x25:'ChildGenerator', 0x26:'VelocityRotator',
  0x27:'TexCoordU', 0x28:'TexCoordV',
  0x29:'OscillationX', 0x2A:'OscillationY', 0x2B:'OscillationZ',
  0x2C:'VelocityDampener', 0x2E:'DrawDistance', 0x2F:'VelocityRotation',
  0x33:'ChildGenerator2', 0x34:'PointListPosition',
  0x3C:'Clock.ColorR', 0x3D:'Clock.ColorG', 0x3E:'Clock.ColorB', 0x3F:'Clock.AlphaMul',
  0x40:'Clock.ScaleX', 0x41:'Clock.ScaleY', 0x42:'Clock.ScaleZ',
  0x45:'MoonPhaseSprite', 0x46:'ChildGenerator3',
  0x48:'DoubleRangeDrawDist',
  0x4E:'DayOfWeekColor', 0x4F:'MoonPhaseColor',
  0x53:'Occlusion',
  0x54:'TexU.Scroll', 0x55:'TexV.Scroll',
  0x56:'Rot.X.Add', 0x57:'Rot.Y.Add', 0x58:'Rot.Z.Add',
  0x59:'AngularDistRot',
  0x5F:'CameraShake', 0x60:'ScreenFlash',
  0x69:'DaylightColorApply',
  0x6E:'DoubleRangeWeightMesh',
};

const SEC4 = {
  0x01:'EmitChild', 0x05:'RepeatExpiration',
};

const SEC_NAMES = { 1: SEC1, 2: SEC2, 3: SEC3, 4: SEC4 };
const SEC_LABELS = {
  1: 'Generator Updaters', 2: 'Particle Initializers',
  3: 'Particle Updaters', 4: 'Expiration Handlers',
};

// ── Attach types ────────────────────────────────────────────────────────────
const ATTACH_TYPES = {
  0x0:'None', 0x1:'SourceActor', 0x2:'TargetActor', 0x3:'SrcToTgtBasis',
  0x4:'TgtActorSrcFacing', 0x5:'SrcActorTgtFacing', 0x6:'TgtToSrcBasis',
  0x9:'SourceActorWeapon', 0xA:'ZoneActor0A', 0xB:'ZoneActor0B',
  0xC:'ZoneActor0C', 0xE:'Sun', 0xF:'Moon',
};

const LINKED_DATA_TYPES = {
  0x01:'Actor', 0x0B:'StaticMesh', 0x0E:'SpriteSheet', 0x1D:'WeightedMesh',
  0x22:'Distortion', 0x24:'RingMesh', 0x39:'LensFlare', 0x3D:'Audio',
  0x47:'PointLight', 0x57:'Null',
};

const BLEND_FUNCS = {
  0:'Zero', 1:'One', 2:'SrcColor', 3:'InvSrcColor', 4:'SrcAlpha',
  5:'InvSrcAlpha', 6:'DstAlpha', 7:'InvDstAlpha', 8:'DstColor', 9:'InvDstColor',
};

// ── Parse generator header ──────────────────────────────────────────────────

function parseGeneratorHeader(bytes, dv, sectionStart) {
  // FFXI uses two offset modes:
  //   offsetFromDataStart(X) = sectionStart + 0x10 + X  (after 16-byte header)
  //   offsetFrom(X)          = sectionStart + X          (from section start)
  const ds = sectionStart + 0x10; // data start

  // offsetFromDataStart(0x00) — attach flags
  const attachFlags = dv.getUint16(ds, true);
  const addlFlags = dv.getUint16(ds + 2, true);

  const header = {
    attachType: ATTACH_TYPES[attachFlags & 0x0F] || `0x${(attachFlags & 0x0F).toString(16)}`,
    attachJoint0: (attachFlags & 0x03F0) >>> 4,
    attachJoint1: (attachFlags & 0xFC00) >>> 10,
    attachSourceOriented: !!(addlFlags & 0x0001),
    actorPosScale: (addlFlags & 0x0040) ? 'Source' : (addlFlags & 0x0080) ? 'Target' : 'None',
    actorSizeScale: (addlFlags & 0x0400) ? 'Source' : (addlFlags & 0x0800) ? 'Target' : 'None',
    // offsetFromDataStart(0x10) — scale amounts
    actorPosScaleAmount: dv.getFloat32(ds + 0x10, true),
    actorSizeScaleAmount: dv.getFloat32(ds + 0x14, true),
    // Color multipliers (offsetFromDataStart 0x30/0x40)
    colorR1: dv.getFloat32(ds + 0x20, true),
    colorG1: dv.getFloat32(ds + 0x24, true),
    colorB1: dv.getFloat32(ds + 0x28, true),
    colorR2: dv.getFloat32(ds + 0x30, true),
    colorG2: dv.getFloat32(ds + 0x34, true),
    colorB2: dv.getFloat32(ds + 0x38, true),
    // offsetFrom(0x50) = sectionStart + 0x50
    unkId: dv.getUint32(sectionStart + 0x50, true),
    // offsetFrom(0x74) = sectionStart + 0x74
    emissionVariance: dv.getUint16(sectionStart + 0x74, true),
    framesPerEmission: dv.getUint16(sectionStart + 0x76, true) + 1,
    particlesPerEmission: bytes[sectionStart + 0x78],
    continuousSingleton: !!(bytes[sectionStart + 0x79] & 0x04),
    autoRun: !!(bytes[sectionStart + 0x79] & 0x10),
    batched: !!(bytes[sectionStart + 0x7B] & 0x20),
  };

  // Environment DatId at offsetFrom(0x54)
  const envBytes = bytes.slice(sectionStart + 0x54, sectionStart + 0x58);
  const envId = String.fromCharCode(...envBytes).replace(/\0/g, '').trim();
  if (envId) header.environmentId = envId;

  return header;
}

// ── Walk opcode sub-sections ────────────────────────────────────────────────

function walkOpcodes(dv, bytes, start, sectionNum) {
  const names = SEC_NAMES[sectionNum] || {};
  const ops = [];
  let pos = start;
  for (let safety = 0; safety < 256; safety++) {
    if (pos + 4 > dv.byteLength) break;
    const config = dv.getUint32(pos, true);
    const opc = config & 0xFF;
    const size = (config >> 8) & 0x1F;
    const alloc = config >> 0xD;
    if (opc === 0x00 || size === 0) break;

    const payloadBytes = bytes.slice(pos + 4, pos + size * 4);
    const entry = {
      op: `0x${opc.toString(16).padStart(2, '0')}`,
      name: names[opc] || `op_${opc.toString(16).padStart(2, '0')}`,
      size, alloc,
      hex: Array.from(payloadBytes).map(b => b.toString(16).padStart(2, '0')).join(''),
    };

    // Decode payload as floats where sensible
    if (payloadBytes.length > 0 && payloadBytes.length % 4 === 0) {
      const payDv = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
      const floats = [];
      for (let i = 0; i < payloadBytes.length; i += 4) {
        floats.push(payDv.getFloat32(i, true));
      }
      if (floats.every(f => Math.abs(f) < 1e9 && f === f)) {
        entry.floats = floats.map(f => Math.round(f * 10000) / 10000);
      }
    }

    // Decode specific opcodes with structured data
    if (sectionNum === 2 && opc === 0x01 && payloadBytes.length >= 8) {
      // StandardSetup — particle configuration
      const payDv = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
      const ldtByte = payloadBytes[0];
      entry.decoded = {
        linkedDataType: LINKED_DATA_TYPES[ldtByte] || `0x${ldtByte.toString(16)}`,
      };
      // Texture/mesh ref is a 4-char DatId at offset 8
      if (payloadBytes.length >= 12) {
        const texRef = String.fromCharCode(...payloadBytes.slice(8, 12)).replace(/\0/g, '').trim();
        if (texRef) entry.decoded.textureRef = texRef;
      }
      // Lifetime at offset 20 (y-offset at 16-19 is float)
      if (payloadBytes.length >= 24) {
        entry.decoded.yOffset = payDv.getFloat32(16, true);
        entry.decoded.lifetime = payDv.getFloat32(20, true);
      }
    }

    if (sectionNum === 2 && opc === 0x16 && payloadBytes.length >= 16) {
      // ColorSetup — 4 floats RGBA
      const payDv = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
      entry.decoded = {
        r: payDv.getFloat32(0, true),
        g: payDv.getFloat32(4, true),
        b: payDv.getFloat32(8, true),
        a: payDv.getFloat32(12, true),
      };
    }

    if (sectionNum === 2 && opc === 0x1E && payloadBytes.length >= 8) {
      // BlendFunc
      const payDv = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
      entry.decoded = {
        src: BLEND_FUNCS[payDv.getUint32(0, true)] || `${payDv.getUint32(0, true)}`,
        dst: BLEND_FUNCS[payDv.getUint32(4, true)] || `${payDv.getUint32(4, true)}`,
      };
    }

    // KeyFrame references (many sec2 opcodes 0x21-0x2F, 0x50-0x52, etc.)
    if (sectionNum === 2 && payloadBytes.length >= 8) {
      const maybeRef = String.fromCharCode(...payloadBytes.slice(0, 4)).replace(/\0/g, '').trim();
      if (maybeRef && /^[a-zA-Z0-9_]/.test(maybeRef) && opc >= 0x21 && opc <= 0x97) {
        entry.decoded = entry.decoded || {};
        entry.decoded.keyFrameRef = maybeRef;
      }
    }

    ops.push(entry);
    pos += size * 4;
  }
  return ops;
}

// ── Parse a single generator ────────────────────────────────────────────────

export function parseGenerator(bytes, dv, section) {
  const ss = section.start; // section start (includes 16-byte header)
  const header = parseGeneratorHeader(bytes, dv, ss);

  // Read 4 sub-section offsets at offsetFrom(0x80) = ss + 0x80
  const sections = {};
  if (ss + 0x90 <= dv.byteLength) {
    for (let i = 0; i < 4; i++) {
      const off = dv.getUint32(ss + 0x80 + i * 4, true);
      const secNum = i + 1;
      if (off === 0) { sections[secNum] = { label: SEC_LABELS[secNum], opcodes: [] }; continue; }
      sections[secNum] = {
        label: SEC_LABELS[secNum],
        opcodes: walkOpcodes(dv, bytes, ss + off, secNum),
      };
    }
  }

  return {
    id: section.id,
    start: section.start,
    size: section.size,
    header,
    sections,
  };
}

// ── Parse keyframe section ──────────────────────────────────────────────────

export function parseKeyFrame(bytes, dv, section) {
  const ds = section.dataStart;
  const dataLen = section.size - 0x10;
  const pairs = [];

  // Pairs start at data start — (time, value) float pairs until time=1.0
  for (let off = 0; off + 8 <= dataLen; off += 8) {
    const time = dv.getFloat32(ds + off, true);
    const value = dv.getFloat32(ds + off + 4, true);
    pairs.push({ time, value });
    if (time >= 1.0) break;
  }

  return { id: section.id, start: section.start, pairs };
}

// ── Parse 0x1F ParticleMesh ──────────────────────────────────────────────────

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
  if (version === 0x03) p += 2;

  const strAt = (bytes, p, n) => {
    let s = ''; for (let i = 0; i < n; i++) { const c = bytes[p + i]; if (c === 0) break; s += String.fromCharCode(c); }
    return s.trim();
  };

  const texNames = [];
  const iterations = version === 0x03 ? 4 : numWithTex;
  for (let i = 0; i < iterations; i++) { texNames.push(strAt(bytes, p, 0x10)); p += 0x10; }

  const meshes = [];
  for (let k = 0; k < total; k++) {
    const numVerts = 3 * trisInMesh[k];
    if (numVerts === 0) continue;
    const positions = new Float32Array(numVerts * 3);
    const normals = new Float32Array(numVerts * 3);
    const colors = new Float32Array(numVerts * 4);
    const uvs = new Float32Array(numVerts * 2);
    for (let i = 0; i < numVerts; i++) {
      positions[i*3] = dv.getFloat32(p, true); positions[i*3+1] = dv.getFloat32(p+4, true); positions[i*3+2] = dv.getFloat32(p+8, true); p += 12;
      normals[i*3] = dv.getFloat32(p, true); normals[i*3+1] = dv.getFloat32(p+4, true); normals[i*3+2] = dv.getFloat32(p+8, true); p += 12;
      const b = bytes[p], g = bytes[p+1], r = bytes[p+2], a = bytes[p+3]; p += 4;
      colors[i*4] = r / 255; colors[i*4+1] = g / 255;
      colors[i*4+2] = b / 255; colors[i*4+3] = a / 255;
      uvs[i*2] = dv.getFloat32(p, true); uvs[i*2+1] = dv.getFloat32(p+4, true); p += 8;
    }
    meshes.push({ textureName: k < numWithTex ? texNames[k] : null, numVerts, positions, normals, colors, uvs });
  }
  return { id: section.id, meshes };
}

// ── Parse EffectRoutine (0x07) ──────────────────────────────────────────────

function parseEffectRoutine(bytes, dv, section) {
  const ss = section.start;
  const result = { id: section.id, start: ss, size: section.size, activates: [], stops: [], isLoop: false };

  // Sub-section offsets at 0x10, 0x14, 0x18 from section start
  if (ss + 0x1C > dv.byteLength) return result;
  const sec2Off = dv.getUint32(ss + 0x14, true); // main command list
  const sec3Off = dv.getUint32(ss + 0x18, true); // completion effects

  // Parse sec3 (completion) — opcode 0x01 means loop
  if (sec3Off > 0 && ss + sec3Off < dv.byteLength) {
    const op = bytes[ss + sec3Off];
    if (op === 0x01) result.isLoop = true;
  }

  // Parse sec2 (main command list)
  if (sec2Off > 0) {
    let pos = ss + sec2Off;
    for (let safety = 0; safety < 200; safety++) {
      if (pos + 8 > dv.byteLength) break;
      const opcode = bytes[pos];
      if (opcode === 0x00) break;

      const unkCombo = dv.getUint16(pos + 1, true);
      const numArgs = (unkCombo >>> 5) & 0x1F;
      const delay = dv.getUint16(pos + 4, true);
      const duration = dv.getUint16(pos + 6, true);

      const argsStart = pos + 8;
      const cmdSize = 8 + numArgs * 4;

      if (opcode === 0x02 && numArgs >= 1) {
        // ParticleGeneratorRoutine — arg is a DatId
        const genId = strAt(bytes, argsStart, 4);
        if (genId) result.activates.push({ genId, delay, duration });
      } else if (opcode === 0x2D && numArgs >= 1) {
        // StopParticleGeneratorRoutine
        const genId = strAt(bytes, argsStart, 4);
        if (genId) result.stops.push(genId);
      }

      pos += cmdSize;
    }
  }

  return result;
}

function strAt(bytes, p, n) {
  let s = '';
  for (let i = 0; i < n; i++) { const c = bytes[p + i]; if (c === 0) break; s += String.fromCharCode(c); }
  return s.trim();
}

// ── Parse all effects from a DAT ────────────────────────────────────────────

export function parseAllEffects(datBuffer) {
  const bytes = new Uint8Array(datBuffer);
  const dv = new DataView(datBuffer);
  const allSections = parseSections(dv);

  const generators = [];
  const keyframes = [];
  const textures = [];
  const particleMeshes = [];
  const spriteSheets = [];
  const effectRoutines = [];

  for (const s of allSections) {
    switch (s.typeCode) {
      case 0x05:
        generators.push(parseGenerator(bytes, dv, s));
        break;
      case 0x19:
        keyframes.push(parseKeyFrame(bytes, dv, s));
        break;
      case 0x20:
        const tex = parseTexture(bytes, dv, s);
        if (tex) { tex.sectionId = s.id; textures.push(tex); }
        break;
      case 0x07:
        effectRoutines.push(parseEffectRoutine(bytes, dv, s));
        break;
      case 0x1F: {
        const pm = parseParticleMesh(bytes, dv, s);
        if (pm) particleMeshes.push(pm);
        break;
      }
      case 0x21:
        spriteSheets.push({ id: s.id, start: s.start, size: s.size });
        break;
    }
  }

  return { generators, keyframes, textures, particleMeshes, spriteSheets, effectRoutines, allSections };
}
