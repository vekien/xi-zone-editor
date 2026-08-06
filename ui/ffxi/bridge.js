// WebSocket bridge to the xi-tools backend (`xi bridge`).
//
// In the Tauri shell the bridge runs on a fixed local port (default
// ws://127.0.0.1:8777/ws). In plain browser/dev mode we fall back to
// same-origin `/ws` (legacy) then the fixed local URL.
//
// Protocol: JSON { id, method, params } out, { id, ok, result | error } back;
// streamed log lines arrive as { id, type:'log', line }.
//
// Graceful fallback: when there's no backend, the socket never opens,
// `bridgeOnline()` stays false, and callers fall back to download-based export.

let ws = null;
let online = false;
let everConnected = false;
let attempts = 0;
let nextId = 1;
const pending = new Map();
const statusListeners = new Set();

const MAX_ATTEMPTS = 8;
const RETRY_MS = 2000;
const CALL_TIMEOUT_MS = 120000;
const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:8777/ws';
export const BRIDGE_HTTP_BASE = 'http://127.0.0.1:8777';
const PING_MS = 20000;

/** Static files served by the bridge: /game/, /game-hd/, /exports/. */
export function bridgeHttpUrl(relPath) {
  const rel = String(relPath || '').replace(/^\/+/, '');
  // Desktop app always uses the bridge HTTP port (junctions are optional/legacy).
  const desktop = typeof window !== 'undefined' && !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
  if (online || desktop) return `${BRIDGE_HTTP_BASE}/${rel}`;
  return `/${rel}`;
}

/**
 * Asset Browser data (manifests / sprites / png thumbs) is bundled under
 * ``ui/public/exports/assets`` and served by Vite/Tauri.
 * Pre-decoded audio WAVs and anything else still come from xi-tools via the bridge.
 */
export function exportsUrl(relPath) {
  let rel = String(relPath || '').replace(/^\/+/, '').replace(/^exports\//i, '');
  // Bundled UI static files
  if (rel.startsWith('assets/')) {
    // import.meta.env.BASE_URL is './' in our vite config
    const base = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || './';
    const prefix = base.endsWith('/') ? base : `${base}/`;
    return `${prefix}exports/${rel}`;
  }
  // Audio cache etc. → bridge → <xi-tools>/exports
  return bridgeHttpUrl(`exports/${rel}`);
}

let _forcedUrl = null;
let _pingTimer = null;

export function setBridgeUrl(url) {
  _forcedUrl = url || null;
}

function resolveBridgeUrl() {
  if (_forcedUrl) return _forcedUrl;
  try {
    const saved = localStorage.getItem('xi.bridgeUrl');
    if (saved) return saved;
  } catch { /* ignore */ }
  // Tauri / standalone always uses the local bridge process.
  if (typeof window !== 'undefined' && (window.__TAURI__ || window.__TAURI_INTERNALS__)) {
    return DEFAULT_BRIDGE_URL;
  }
  if (typeof location !== 'undefined' && location.protocol !== 'file:') {
    // Dev: prefer explicit bridge; same-origin only if not vite (5174).
    if (location.port === '5174' || location.port === '5173') return DEFAULT_BRIDGE_URL;
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }
  return DEFAULT_BRIDGE_URL;
}

function setOnline(v) {
  if (online === v) return;
  online = v;
  for (const fn of statusListeners) { try { fn(v); } catch {} }
  if (v) startPing();
  else stopPing();
}

function startPing() {
  stopPing();
  _pingTimer = setInterval(() => {
    if (!online) return;
    bridgeCall('bridge.ping', {}).catch(() => {});
  }, PING_MS);
}

function stopPing() {
  if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
}

export function bridgeOnline() { return online; }

export function onBridgeStatus(fn) {
  statusListeners.add(fn);
  try { fn(online); } catch {}
  return () => statusListeners.delete(fn);
}

export function connectBridge() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const url = resolveBridgeUrl();
  let sock;
  try { sock = new WebSocket(url); } catch { scheduleRetry(); return; }
  ws = sock;
  sock.onopen = () => { everConnected = true; attempts = 0; setOnline(true); };
  sock.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'log') {
      if (p.bump) p.bump();
      if (p.onLog) { try { p.onLog(msg.line); } catch {} }
      return;
    }
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'bridge error'));
  };
  sock.onerror = () => {};
  sock.onclose = () => {
    if (ws === sock) ws = null;
    setOnline(false);
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('bridge disconnected')); }
    pending.clear();
    scheduleRetry();
  };
}

function scheduleRetry() {
  attempts++;
  if (!everConnected && attempts >= MAX_ATTEMPTS) return;
  setTimeout(connectBridge, RETRY_MS);
}

export function bridgeCall(method, params = {}, onLog = null, onStart = null) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error('bridge offline')); return; }
    const id = nextId++;
    const arm = () => setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`bridge timeout: ${method}`)); }
    }, CALL_TIMEOUT_MS);
    const entry = { resolve, reject, timer: arm(), onLog };
    entry.bump = () => { clearTimeout(entry.timer); entry.timer = arm(); };
    pending.set(id, entry);
    try {
      ws.send(JSON.stringify({ id, method, params }));
      if (onStart) { try { onStart(id); } catch {} }
    } catch (e) { pending.delete(id); clearTimeout(entry.timer); reject(e); }
  });
}

export function bridgeCancel(id) {
  if (id == null || !ws || ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(JSON.stringify({ id: 0, method: '__cancel__', params: { cancelId: id } })); return true; }
  catch { return false; }
}
