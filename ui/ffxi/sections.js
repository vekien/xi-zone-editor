// FFXI DAT section parser and texture decoder — Loxley
// Shared by the level editor and particle editor.

export class Reader {
  constructor(view, pos = 0) { this.dv = view; this.pos = pos; }
  u8()  { return this.dv.getUint8(this.pos++); }
  u16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i32() { const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  str(n) {
    let s = '';
    for (let i = 0; i < n; i++) { const c = this.dv.getUint8(this.pos + i); if (c === 0) break; s += String.fromCharCode(c); }
    this.pos += n; return s.trim();
  }
}

const align16 = (v) => (v + 0xF) & ~0xF;

export function parseSections(dv) {
  const sections = [];
  let pos = 0;
  while (pos + 16 <= dv.byteLength) {
    const meta = dv.getUint32(pos + 4, true);
    const typeCode = meta & 0x7F;
    const size = ((meta >>> 7) & 0xFFFFF) * 0x10;
    if (size <= 0) break;
    let id = '';
    for (let i = 0; i < 4; i++) { const c = dv.getUint8(pos + i); if (c) id += String.fromCharCode(c); }
    id = id.trim();
    sections.push({ id, typeCode, start: pos, size, dataStart: pos + 0x10 });
    pos = align16(pos + size);
  }
  return sections;
}

// Type code names
export const TYPE_NAMES = {
  0x00:'END', 0x01:'HDR', 0x05:'Particle', 0x06:'Route', 0x07:'EffectRoutine',
  0x19:'KeyFrame', 0x1C:'ZoneDef', 0x1F:'ParticleMesh', 0x20:'Texture',
  0x21:'SpriteSheet', 0x25:'WeightedMesh', 0x29:'Skeleton', 0x2A:'Mesh',
  0x2B:'Animation', 0x2E:'ZoneMesh', 0x2F:'Environment', 0x3D:'Sound',
  0x45:'Info', 0x54:'WeaponTrace', 0x5D:'BumpMap', 0x5E:'Blur',
};

// ── Texture decoding ───────────────────────────────────────────────────────

export function parseTexture(bytes, dv, section) {
  const ds = section.dataStart;
  const texType = bytes[ds];
  const name = String.fromCharCode(...bytes.slice(ds + 1, ds + 17)).replace(/\0.*/, '').trim();
  const width = dv.getUint32(ds + 21, true);
  const height = dv.getUint32(ds + 25, true);
  const bpp = dv.getUint16(ds + 31, true);

  if (texType === 0xA1) {
    // DXT texture
    const dxtOff = ds + 17 + dv.getUint32(ds + 17, true);
    const magic = String.fromCharCode(...bytes.slice(dxtOff, dxtOff + 4));
    const dxtLen = dv.getUint32(dxtOff + 4, true);
    const dxtData = bytes.slice(dxtOff + 12, dxtOff + 12 + dxtLen);
    let rgba;
    if (magic === '1TXD') rgba = decodeDxt1(dxtData, width, height);
    else if (magic === '3TXD') rgba = decodeDxt3(dxtData, width, height);
    else return null;
    return { name, width, height, texType, dxtType: magic, rgba };
  } else if (texType === 0xB1 || texType === 0x91 || texType === 0x81) {
    // Paletted texture (0x81 = older 8-bit-paletted variant in prototype/beta zones;
    // same dynamic headerSize layout, so the palOff math below resolves identically).
    const headerSize = dv.getUint32(ds + 17, true);
    const palOff = ds + 17 + headerSize;
    // Last dword of the BITMAPINFOHEADER is bits-per-palette-entry: 0x20 = 32-bit
    // BGRA (1024 bytes), 0x10 = 16-bit A1R5G5B5 (512). Prototype zones use the
    // narrow form for a few textures; reading it as 32-bit scrambles the colours
    // and shifts the pixels by 512 bytes. Retail is always 32-bit.
    const paletteBits = dv.getUint32(ds + 17 + 36, true);
    const narrow = paletteBits === 0x10;
    const palette = [];
    for (let i = 0; i < 256; i++) {
      if (narrow) {
        const v = dv.getUint16(palOff + i * 2, true);
        const f = (c) => ((c * 255 / 31) | 0);
        palette.push({
          b: f(v & 0x1F), g: f((v >>> 5) & 0x1F), r: f((v >>> 10) & 0x1F),
          a: (v >>> 15) & 1 ? 0xFF : 0x00,
        });
      } else {
        const po = palOff + i * 4;
        palette.push({ b: bytes[po], g: bytes[po+1], r: bytes[po+2], a: bytes[po+3] });
      }
    }
    const pixOff = palOff + (narrow ? 512 : 1024);
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const idx = bytes[pixOff + i];
      const c = palette[idx];
      rgba[i*4] = c.r; rgba[i*4+1] = c.g; rgba[i*4+2] = c.b;
      rgba[i*4+3] = c.a;
    }
    return { name, width, height, texType, palette, rgba };
  }
  return null;
}

function decodeDxt1(data, w, h) {
  const rgba = new Uint8Array(w * h * 4);
  let bp = 0;
  for (let y1 = 0; y1 < h; y1 += 4) for (let x1 = 0; x1 < w; x1 += 4) {
    const c0 = data[bp] | (data[bp+1] << 8); bp += 2;
    const c1 = data[bp] | (data[bp+1] << 8); bp += 2;
    const r0 = ((c0>>11)&31)*255/31|0, g0 = ((c0>>5)&63)*255/63|0, b0 = (c0&31)*255/31|0;
    const r1 = ((c1>>11)&31)*255/31|0, g1 = ((c1>>5)&63)*255/63|0, b1 = (c1&31)*255/31|0;
    const lut = [
      [r0,g0,b0,255], [r1,g1,b1,255],
      c0>c1 ? [(2*r0+r1)/3|0,(2*g0+g1)/3|0,(2*b0+b1)/3|0,255] : [(r0+r1)>>1,(g0+g1)>>1,(b0+b1)>>1,255],
      c0>c1 ? [(r0+2*r1)/3|0,(g0+2*g1)/3|0,(b0+2*b1)/3|0,255] : [0,0,0,0],
    ];
    const bits = readU32BE(data, bp); bp += 4;
    let count = 15;
    for (let y = y1; y < y1 + 4; y++) for (let x = x1 + 3; x >= x1; x--) {
      const ci = (bits >>> (2 * count)) & 3;
      count--;
      if (x < w && y < h) {
        const o = (y*w+x)*4;
        rgba[o]=lut[ci][0]; rgba[o+1]=lut[ci][1]; rgba[o+2]=lut[ci][2]; rgba[o+3]=lut[ci][3];
      }
    }
  }
  return rgba;
}

function decodeDxt3(data, w, h) {
  const rgba = new Uint8Array(w * h * 4);
  let bp = 0;
  for (let y1 = 0; y1 < h; y1 += 4) for (let x1 = 0; x1 < w; x1 += 4) {
    const alphaBits = (BigInt(readU32LE(data, bp)) << 32n) | BigInt(readU32LE(data, bp + 4)); bp += 8;
    const c0 = data[bp]|(data[bp+1]<<8); bp += 2;
    const c1 = data[bp]|(data[bp+1]<<8); bp += 2;
    const r0 = ((c0>>11)&31)*255/31|0, g0 = ((c0>>5)&63)*255/63|0, b0 = (c0&31)*255/31|0;
    const r1 = ((c1>>11)&31)*255/31|0, g1 = ((c1>>5)&63)*255/63|0, b1 = (c1&31)*255/31|0;
    const lut = [
      [r0,g0,b0], [r1,g1,b1],
      [(2*r0+r1)/3|0,(2*g0+g1)/3|0,(2*b0+b1)/3|0],
      [(r0+2*r1)/3|0,(g0+2*g1)/3|0,(b0+2*b1)/3|0],
    ];
    const bits = readU32BE(data, bp); bp += 4;
    let count = 15;
    for (let y = y1; y < y1 + 4; y++) for (let x = x1 + 3; x >= x1; x--) {
      const ci = (bits >>> (2 * count)) & 3;
      const a4 = Number((alphaBits >> BigInt(4 * count)) & 0xFn);
      count--;
      if (x < w && y < h) {
        const o = (y*w+x)*4;
        rgba[o]=lut[ci][0]; rgba[o+1]=lut[ci][1]; rgba[o+2]=lut[ci][2]; rgba[o+3]=(a4*255/16)|0;
      }
    }
  }
  return rgba;
}

function readU32LE(data, p) {
  return (data[p] | (data[p+1] << 8) | (data[p+2] << 16) | (data[p+3] << 24)) >>> 0;
}

function readU32BE(data, p) {
  return ((data[p] << 24) | (data[p+1] << 16) | (data[p+2] << 8) | data[p+3]) >>> 0;
}
