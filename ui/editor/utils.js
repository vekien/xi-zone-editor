// utils.js — shared utility functions for the level editor
// Imported as an ES module by main.js.
import * as THREE from 'three';

// ── Formatting ────────────────────────────────────────────────────────────────

// Integer when on a snap stop, else 1 decimal place.
export function fmtDeg(d) {
  const a = Math.abs(d), r = Math.round(a);
  return Math.abs(a - r) < 0.05 ? String(r) : a.toFixed(1);
}

// Cross-zone copied effects use FourCC scheme x<role2><index> (e.g. xfd1).
// Display as xi_<role2><index> so the origin is obvious in the UI.
export function fmtFourCC(id) { return /^x[a-zA-Z]{2}[0-9A-Za-z]$/.test(id) ? `xi_${id.slice(1)}` : id; }

// VFX base name (the readable label before the " [secId]" suffix and any ".NNN" dup tail) —
// e.g. "light glow [sec05].001" → "light glow", "point light [sec01]" → "point light".
export function vfxBaseName(p) { return (p.name || '').replace(/\s*\[[^\]]*\][\s\S]*$/, '').trim(); }

// Map a standard zone URL to its HD asset-pack sibling (served from FFXI_HD_DIR at /game-hd/).
export function hdUrlFor(url) { return (url || '').replace(/^game\//, 'game-hd/'); }

// ── ID generators ─────────────────────────────────────────────────────────────

export function newGroupId() { return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
export function newHotkeyId() { return 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

// ── Snap helpers ──────────────────────────────────────────────────────────────

export function clampSnapValue(value, min, max, step) {
  const n = Math.min(max, Math.max(min, Number(value) || 0));
  return Math.round(n / step) * step;
}
export function formatSnapValue(value) {
  if (value <= 0) return 'Off';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// ── Math / THREE ──────────────────────────────────────────────────────────────

// Column-major TRS = translate · rotateZYX · scale, matching xi's trs_matrix /
// xim's Matrix4f.rotateZYXInPlace (so placements land exactly where the game puts them).
export function trsMatrix(pos, rot, scale) {
  const [px, py, pz] = pos, [rx, ry, rz] = rot, [sx, sy, sz] = scale;
  const sinx = Math.sin(rx), siny = Math.sin(ry), sinz = Math.sin(rz);
  const cosx = Math.cos(rx), cosy = Math.cos(ry), cosz = Math.cos(rz);
  const c0 = [cosy * cosz, cosy * sinz, -siny];
  const c1 = [sinx * siny * cosz - cosx * sinz, sinx * siny * sinz + cosx * cosz, sinx * cosy];
  const c2 = [cosx * siny * cosz + sinx * sinz, cosx * siny * sinz - sinx * cosz, cosx * cosy];
  return new THREE.Matrix4().fromArray([
    c0[0] * sx, c0[1] * sx, c0[2] * sx, 0,
    c1[0] * sy, c1[1] * sy, c1[2] * sy, 0,
    c2[0] * sz, c2[1] * sz, c2[2] * sz, 0,
    px, py, pz, 1,
  ]);
}

export function hashColor(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  // spread bits across hue, keep saturation+lightness comfortable
  const hue = (h & 0xff) / 255;
  const sat = 0.55 + ((h >> 8 & 0xff) / 255) * 0.3;
  const lit = 0.45 + ((h >> 16 & 0xff) / 255) * 0.2;
  return new THREE.Color().setHSL(hue, sat, lit);
}

// ── File / browser helpers ────────────────────────────────────────────────────

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',', 2)[1] || '');
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

// ── Publish helpers ───────────────────────────────────────────────────────────

// Format a zone.export result into a one-line stats string + the output path.
export function publishStats(r) {
  const p = (r && r.placements) || {};
  const v = (r && r.vfx) || {};
  const f = (r && r.footsteps) || {};
  const extra = [p.meshes_removed ? `${p.meshes_removed} mesh-rm` : '',
                 p.textures_removed ? `${p.textures_removed} tex-rm` : '',
                 p.collision_tris ? `${p.collision_tris} col-tris` : '',
                 f.copied ? `${f.copied} footstep-sfx` : '',
                 v.removed ? `${v.removed} vfx-rm` : '',
                 v.added ? `${v.added} vfx-add` : '',
                 v.skipped ? `${v.skipped} vfx-skip` : ''].filter(Boolean).join(', ');
  const out = (r && r.output) || 'game DAT';
  const stats = `${p.modified || 0} mod, ${p.added || 0} add, ${p.deleted || 0} del${extra ? ', ' + extra : ''}`;
  return { out, stats };
}

// True when a publish-leg error is the backend honouring our Stop request (PublishCancelled)
// rather than a real failure — drives the "cancelled / bad state" messaging instead of "failed".
export function isPublishCancel(stopped, err) {
  return stopped || /cancell?ed/i.test(err && err.message || '');
}

// ── Canvas / texture helpers ──────────────────────────────────────────────────

// CSS-style billboard labels for VFX / SFX emitters, drawn to a canvas (no PNG) so
// new types are a one-liner. Cached per (text, colours). Returns {texture, aspect};
// aspect (width/height) lets the sprite render as a rounded pill, not a square.
const _labelTexCache = new Map();
let _labelMeasureCtx = null;
export function makeLabelTexture(text, bg, fg) {
  const key = `${text}|${bg}|${fg}`;
  const hit = _labelTexCache.get(key);
  if (hit) return hit;
  const SS = 2;                                  // supersample for crisp text
  const PAD = 10 * SS;                           // even 10px padding around the text
  const STROKE = 2 * SS;
  const FONT = 14 * SS;
  const font = `700 ${FONT}px Roboto, Arial, sans-serif`;
  // Measure the actual INK box (not the advance width — its side-bearings would make
  // the left/right padding uneven). Sizing to the ink box gives a true even PAD all round.
  const mctx = (_labelMeasureCtx ||= document.createElement('canvas').getContext('2d'));
  mctx.font = font;
  const m = mctx.measureText(text);
  const bl = m.actualBoundingBoxLeft ?? 0;
  const br = m.actualBoundingBoxRight ?? m.width;
  const asc = m.actualBoundingBoxAscent || FONT * 0.72;
  const desc = m.actualBoundingBoxDescent || 0;
  const inkW = Math.ceil(bl + br), inkH = Math.ceil(asc + desc);
  const cw = inkW + (PAD + STROKE) * 2, ch = inkH + (PAD + STROKE) * 2;
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const g = cv.getContext('2d');
  const x = STROKE, y = STROKE, w = cw - STROKE * 2, h = ch - STROKE * 2;
  const r = 5 * SS;                              // rounded corners
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
  g.fillStyle = bg; g.fill();
  g.lineWidth = STROKE; g.strokeStyle = 'rgba(0,0,0,0.4)'; g.stroke();
  g.fillStyle = fg;
  g.font = font;
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  // Offset the draw origin by the ink box's left/top bearings so the glyphs land
  // exactly PAD from each edge.
  g.fillText(text, STROKE + PAD + bl, STROKE + PAD + asc);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  const out = { texture: tex, aspect: cw / ch };
  _labelTexCache.set(key, out);
  return out;
}

// Renders a Material Symbol glyph into a rounded-square canvas texture.
// Relies on Chrome applying the font's 'liga' feature in fillText (works in all
// Chromium-based browsers; falls back to literal text in others).
export function makeSymbolTexture(symbol, bg, fg) {
  const key = `sym|${symbol}|${bg}|${fg}`;
  const hit = _labelTexCache.get(key);
  if (hit) return hit;
  const SS = 2, SZ = 26 * SS, PAD = 5 * SS, STROKE = 2 * SS;
  const side = SZ + (PAD + STROKE) * 2;
  const cv = document.createElement('canvas');
  cv.width = side; cv.height = side;
  const g = cv.getContext('2d');
  const x = STROKE, y = STROKE, w = side - STROKE * 2, h = side - STROKE * 2, r = 6 * SS;
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r); g.closePath();
  g.fillStyle = bg; g.fill();
  g.lineWidth = STROKE; g.strokeStyle = 'rgba(0,0,0,0.4)'; g.stroke();
  g.fillStyle = fg;
  g.font = `normal normal 400 ${SZ}px "Material Symbols Outlined"`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(symbol, side / 2, side / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  const out = { texture: tex, aspect: 1 };
  _labelTexCache.set(key, out);
  return out;
}
