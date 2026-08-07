// setup-wizard.js — the Setup panel shown before the editor opens.
//
// One framed window with a stepper, replacing the three separate overlays this used to
// be (an xi-tools card, a workspace card, a game-paths card), each with its own size,
// styling and independent decision about whether to appear.
//
// The xi-tools step runs on EVERY launch — it is how updates are offered. Everything
// after it runs only until setup is marked complete; afterwards the same fields are
// editable under Settings → Setup.

import { bridgeCall, bridgeOnline, connectBridge, setBridgeUrl, onBridgeStatus } from '../ffxi/bridge.js';
import { runToolsBoot } from '../js/tools-boot.js';

const SETUP_DONE_KEY = 'xi.setupComplete';
export const WORKSPACE_PATH_KEY = 'xi.workspacePath';
const WORKSPACE_FOLDER_NAME = 'xi-tools-workspaces';

export function setupComplete() { return localStorage.getItem(SETUP_DONE_KEY) === '1'; }
export function markSetupIncomplete() { localStorage.removeItem(SETUP_DONE_KEY); }

/** Env keys owned by each step, so a step saves only its own fields. */
const STEP_ENV_KEYS = {
  paths: ['FFXI_DIR', 'FFXI_HD_DIR', 'FFXI_PIVOT_DIR'],
  server: ['XI_SERVER_DIR', 'XI_DB_HOST', 'XI_DB_PORT', 'XI_DB_USER', 'XI_DB_PASSWORD', 'XI_DB_NAME'],
};

const STEPS = [
  {
    id: 'tools', label: 'XI Tools', note: 'Checked every launch',
    title: 'XI Tools', sub: 'The editor runs on the xi-tools backend. This checks it is installed and up to date, then starts it.',
  },
  {
    id: 'workspace', label: 'Workspace', note: 'Where edits are saved',
    title: 'Choose a workspace', sub: 'Where your zone edits are stored on disk.',
  },
  {
    id: 'paths', label: 'Game paths', note: 'FFXI install',
    title: 'Point at your game', sub: 'The editor reads zone data straight out of the FFXI DAT files.',
  },
  {
    id: 'server', label: 'Server & database', note: 'Optional',
    title: 'Connect your server', sub: 'Link a local LandSandBoat / CatsEyeXI server so the editor can read its live data.',
  },
  {
    id: 'shortcut', label: 'Desktop icon', note: 'Optional',
    title: 'Add a shortcut', sub: 'Put XI Zone Editor on your Desktop for quick access.',
  },
  {
    id: 'done', label: 'Finish', note: '',
    title: 'Setup complete', sub: '',
  },
];

/** Steps after the always-on xi-tools check. */
const FLOW = ['workspace', 'paths', 'server', 'shortcut', 'done'];

const $ = (id) => document.getElementById(id);
const stepMeta = (id) => STEPS.find((s) => s.id === id);

let _navResolve = null;          // resolves the footer Back/Skip/Next promise
let _state = {};                 // per-run step outcomes, for the summary
let _shortcut = { supported: true, exists: false, path: '' };

// ── Shell helpers ────────────────────────────────────────────────────────────

function showOverlay(on) {
  const ov = $('wizard-overlay');
  if (ov) ov.style.display = on ? 'flex' : 'none';
  document.body.classList.toggle('wiz-active', on);
  if (on) $('app-loader')?.classList.add('hidden');
}

function renderSteps(currentId) {
  const host = $('wiz-steps');
  if (!host) return;
  const order = STEPS.map((s) => s.id);
  const curIdx = order.indexOf(currentId);
  host.innerHTML = STEPS.map((s, i) => {
    const outcome = _state[s.id];
    const done = i < curIdx && outcome !== 'skipped';
    const skipped = i < curIdx && outcome === 'skipped';
    const cls = ['wiz-step',
      s.id === currentId ? 'is-current' : '',
      done ? 'is-done' : '',
      skipped ? 'is-skipped' : ''].filter(Boolean).join(' ');
    const num = done
      ? '<span class="material-symbols-outlined">check</span>'
      : (skipped ? '<span class="material-symbols-outlined">remove</span>' : String(i + 1));
    return `<li class="${cls}">
      <span class="wiz-step-num">${num}</span>
      <span>
        <span class="wiz-step-label">${s.label}</span>
        ${s.note ? `<span class="wiz-step-note">${skipped ? 'Skipped' : s.note}</span>` : ''}
      </span>
    </li>`;
  }).join('');
}

function showPane(id) {
  document.querySelectorAll('#wizard-overlay .wiz-pane').forEach((el) => {
    el.classList.toggle('active', el.dataset.pane === id);
  });
  const meta = stepMeta(id);
  if (meta) {
    $('wiz-title').textContent = meta.title;
    $('wiz-sub').textContent = meta.sub;
  }
  renderSteps(id);
  setMsg('');
}

function setMsg(text, isError = false) {
  const el = $('wiz-msg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('is-error', !!isError && !!text);
}

/** Configure the footer and wait for the user to pick a direction. */
function nav({ back = false, skip = false, next = true, nextLabel = 'Next', skipLabel = 'Skip' }) {
  const b = $('wiz-back'), s = $('wiz-skip'), n = $('wiz-next');
  b.style.display = back ? '' : 'none';
  s.style.display = skip ? '' : 'none';
  n.style.display = next ? '' : 'none';
  s.textContent = skipLabel;
  n.textContent = nextLabel;
  b.disabled = s.disabled = n.disabled = false;
  return new Promise((resolve) => { _navResolve = resolve; });
}

function busy(on, label) {
  const n = $('wiz-next');
  if (n) { n.disabled = on; if (label && on) n.textContent = label; }
  $('wiz-back').disabled = on;
  $('wiz-skip').disabled = on;
}

// ── xi-tools step view ───────────────────────────────────────────────────────

function toolsView() {
  const log = $('wiz-tools-log');
  return {
    line: (t) => { $('wiz-tools-line').textContent = t; },
    meta: (t) => { $('wiz-tools-meta').textContent = t || ''; },
    bar: (pct) => { $('wiz-tools-bar').style.width = `${Math.max(0, Math.min(100, pct))}%`; },
    icon: (name) => { $('wiz-tools-ico').textContent = name; },
    log: (t, { error = false } = {}) => {
      if (!log) return;
      log.hidden = false;
      if (error) log.classList.add('is-error');
      log.textContent = (log.textContent ? `${log.textContent}\n` : '') + t;
      log.scrollTop = log.scrollHeight;
    },
    clearChoices: () => { $('wiz-tools-btns').innerHTML = ''; },
    choose: (opts) => new Promise((resolve) => {
      const host = $('wiz-tools-btns');
      host.innerHTML = '';
      for (const o of opts) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `wiz-btn ${o.primary ? 'primary' : 'ghost'}`;
        btn.textContent = o.label;
        btn.addEventListener('click', () => { host.innerHTML = ''; resolve(o.key); });
        host.appendChild(btn);
      }
    }),
  };
}

// ── Env field plumbing ───────────────────────────────────────────────────────

const envInputs = () => [...document.querySelectorAll('#wizard-overlay [data-env-key]')];
const envInput = (key) => document.querySelector(`#wizard-overlay [data-env-key="${key}"]`);

function setTick(key, state, detail) {
  const el = document.querySelector(`#wizard-overlay [data-tick="${key}"]`);
  if (!el) return;
  el.classList.toggle('on', state === 'ok' || state === 'bad');
  el.classList.toggle('bad', state === 'bad');
  el.title = detail || '';
  const icon = el.querySelector('.material-symbols-outlined');
  if (icon) icon.textContent = state === 'bad' ? 'error' : 'check_circle';
}

const _validateTimers = {};
async function validateEnvField(key) {
  const inp = envInput(key);
  if (!inp) return;
  const path = (inp.value || '').trim();
  if (!path) { setTick(key, ''); return; }
  if (!bridgeOnline()) return;
  try {
    const r = await bridgeCall('env.validate', { key, path });
    setTick(key, r?.valid ? 'ok' : 'bad', r?.detail || '');
  } catch { setTick(key, ''); }
}
function scheduleValidate(key) {
  clearTimeout(_validateTimers[key]);
  _validateTimers[key] = setTimeout(() => validateEnvField(key), 350);
}

async function loadEnvValues() {
  if (!bridgeOnline()) return null;
  let st = null;
  try { st = await bridgeCall('env.status', {}); } catch { return null; }
  const vals = (st && st.values) || {};
  for (const inp of envInputs()) {
    const v = vals[inp.dataset.envKey];
    if (v) inp.value = v;
  }
  for (const key of Object.keys(vals)) if (vals[key]) validateEnvField(key);
  return st;
}

function collectEnv(keys) {
  const out = {};
  for (const key of keys) out[key] = (envInput(key)?.value || '').trim();
  return out;
}

async function saveEnv(keys) {
  if (!bridgeOnline()) {
    setMsg('The XI Tools backend is not connected — settings cannot be saved yet.', true);
    return false;
  }
  try {
    const r = await bridgeCall('env.save', { values: collectEnv(keys) });
    if (!r || !r.ok) { setMsg((r && r.error) || 'Could not save these settings.', true); return false; }
    return true;
  } catch (e) {
    setMsg(e?.message || 'Could not save these settings.', true);
    return false;
  }
}

// ── Step: workspace ──────────────────────────────────────────────────────────

/** Append the conventional folder name unless the user already picked it. */
function withWorkspaceFolder(raw) {
  if (!raw) return raw;
  const sep = raw.includes('\\') ? '\\' : '/';
  const p = raw.replace(/[\\/]+$/, '');
  return p.split(/[\\/]/).pop() === WORKSPACE_FOLDER_NAME ? p : p + sep + WORKSPACE_FOLDER_NAME;
}

async function enterWorkspace() {
  const inp = $('wiz-ws-path');
  if (inp && !inp.value) inp.value = localStorage.getItem(WORKSPACE_PATH_KEY) || '';
}

async function commitWorkspace() {
  const path = ($('wiz-ws-path')?.value || '').trim();
  if (!path) { setMsg('Choose a folder, or press Skip to use the default location.', true); return false; }
  if (!bridgeOnline()) { setMsg('The XI Tools backend is not connected yet.', true); return false; }
  busy(true, 'Setting up…');
  try {
    const r = await bridgeCall('workspace.setup', { path }, (line) => { if (line) setMsg(line); });
    if (!r || !r.ok) { setMsg((r && r.error) || 'Workspace setup failed.', true); return false; }
    localStorage.setItem(WORKSPACE_PATH_KEY, r.path || path);
    _state.workspaceSummary = r.path || path;
    return true;
  } catch (e) {
    setMsg(e?.message || 'Workspace setup failed.', true);
    return false;
  } finally {
    busy(false);
    $('wiz-next').textContent = 'Next';
  }
}

async function skipWorkspace() {
  if (!bridgeOnline()) return true;
  try {
    const r = await bridgeCall('workspace.skip', {});
    if (r && r.ok && r.path) {
      localStorage.setItem(WORKSPACE_PATH_KEY, r.path);
      _state.workspaceSummary = r.path;
    }
  } catch { /* default folder will be created on first save */ }
  return true;
}

// ── Step: server + database ──────────────────────────────────────────────────

/** Pull host/user/password/etc out of a checkout's network.lua into the DB fields. */
async function autofillFromServer(path) {
  if (!bridgeOnline() || !path) return;
  try {
    const r = await bridgeCall('env.serverCreds', { path });
    if (!r || !r.ok || !r.values) return;
    for (const [key, val] of Object.entries(r.values)) {
      const inp = envInput(key);
      // Don't overwrite something the user typed themselves.
      if (inp && val && !inp.value.trim()) inp.value = val;
    }
    setMsg(`Read the database login from ${r.path}`);
  } catch { /* best-effort pre-fill */ }
}

async function testDbConnection() {
  const out = $('wiz-db-result');
  if (!bridgeOnline()) {
    out.textContent = 'Backend not connected.';
    out.className = 'wiz-test-result bad';
    return;
  }
  const btn = $('wiz-db-test');
  btn.disabled = true;
  out.textContent = 'Connecting…';
  out.className = 'wiz-test-result';
  try {
    const r = await bridgeCall('env.testDb', {
      host: ($('wiz-db-host').value || '').trim(),
      port: ($('wiz-db-port').value || '').trim(),
      user: ($('wiz-db-user').value || '').trim(),
      password: $('wiz-db-pass').value || '',
      database: ($('wiz-db-name').value || '').trim(),
    });
    if (r && r.ok) {
      out.textContent = `Connected to ${r.database} on ${r.host} — MariaDB ${r.version}, ${r.npcRows.toLocaleString()} NPCs.`;
      out.className = 'wiz-test-result ok';
    } else {
      out.textContent = (r && r.error) || 'Could not connect.';
      out.className = 'wiz-test-result bad';
    }
  } catch (e) {
    out.textContent = e?.message || 'Could not connect.';
    out.className = 'wiz-test-result bad';
  } finally {
    btn.disabled = false;
  }
}

// ── Step: desktop shortcut ───────────────────────────────────────────────────

async function tauriInvoke(cmd, args = {}) {
  if (!window.__TAURI__?.core?.invoke) return null;
  return window.__TAURI__.core.invoke(cmd, args);
}

async function enterShortcut() {
  const sub = $('wiz-shortcut-sub');
  const btn = $('wiz-shortcut-btn');
  try {
    _shortcut = (await tauriInvoke('desktop_shortcut_status')) || { supported: false };
  } catch { _shortcut = { supported: false }; }

  if (!_shortcut.supported) {
    sub.textContent = 'Desktop shortcuts are only available in the Windows desktop app.';
    btn.disabled = true;
    return;
  }
  if (_shortcut.exists) {
    sub.textContent = `Already on your Desktop — ${_shortcut.path}`;
    btn.textContent = 'Create again';
  } else {
    sub.textContent = 'Creates "XI Zone Editor" on your Desktop.';
    btn.textContent = 'Create';
  }
  btn.disabled = false;
}

async function createShortcut() {
  const btn = $('wiz-shortcut-btn');
  const sub = $('wiz-shortcut-sub');
  btn.disabled = true;
  try {
    const r = await tauriInvoke('create_desktop_shortcut');
    _shortcut = r || _shortcut;
    sub.textContent = `Created — ${_shortcut.path}`;
    btn.textContent = 'Create again';
    _state.shortcutMade = true;
    setMsg('');
  } catch (e) {
    setMsg(String(e?.message || e || 'Could not create the shortcut.'), true);
  } finally {
    btn.disabled = false;
  }
}

// ── Step: done ───────────────────────────────────────────────────────────────

function renderSummary(st) {
  const vals = (st && st.values) || {};
  const row = (label, value, muted) =>
    `<dt>${label}</dt><dd class="${muted ? 'muted' : ''}">${value}</dd>`;
  const or = (v, fallback) => (v ? v : fallback);
  const dash = 'Not set';

  const dbLine = vals.XI_SERVER_DIR
    ? or(`${vals.XI_DB_USER || 'root'}@${vals.XI_DB_HOST || '127.0.0.1'}/${vals.XI_DB_NAME || 'tpzdb'}`, dash)
    : dash;

  $('wiz-summary').innerHTML = [
    row('Workspace', or(_state.workspaceSummary || localStorage.getItem(WORKSPACE_PATH_KEY), dash),
      !(_state.workspaceSummary || localStorage.getItem(WORKSPACE_PATH_KEY))),
    row('FFXI install', or(vals.FFXI_DIR, dash), !vals.FFXI_DIR),
    row('HD DATs', or(vals.FFXI_HD_DIR, dash), !vals.FFXI_HD_DIR),
    row('Pivot DATs', or(vals.FFXI_PIVOT_DIR, dash), !vals.FFXI_PIVOT_DIR),
    row('Server folder', or(vals.XI_SERVER_DIR, dash), !vals.XI_SERVER_DIR),
    row('Database', dbLine, dbLine === dash),
    row('Desktop icon', _shortcut.exists ? 'Created' : 'Not created', !_shortcut.exists),
  ].join('');
}

// ── Step driver ──────────────────────────────────────────────────────────────

async function enterStep(id) {
  showPane(id);
  if (id === 'workspace') await enterWorkspace();
  if (id === 'paths' || id === 'server') await loadEnvValues();
  if (id === 'shortcut') await enterShortcut();
  if (id === 'done') renderSummary(await (bridgeOnline() ? bridgeCall('env.status', {}).catch(() => null) : null));
}

async function commitStep(id) {
  if (id === 'workspace') return commitWorkspace();
  if (id === 'paths') {
    if (!(envInput('FFXI_DIR')?.value || '').trim()) {
      setMsg('The FFXI install folder is required.', true);
      return false;
    }
    return saveEnv(STEP_ENV_KEYS.paths);
  }
  if (id === 'server') return saveEnv(STEP_ENV_KEYS.server);
  return true;
}

function navOptionsFor(id, index) {
  const back = index > 0;
  if (id === 'workspace') return { back, skip: true, skipLabel: 'Use default folder' };
  if (id === 'paths') return { back, skip: false };
  if (id === 'server') return { back, skip: true, skipLabel: 'Skip for now' };
  if (id === 'shortcut') return { back, skip: true, skipLabel: 'No thanks' };
  if (id === 'done') return { back, skip: false, nextLabel: 'Open the editor' };
  return { back, skip: false };
}

async function runFlow() {
  let i = 0;
  while (i < FLOW.length) {
    const id = FLOW[i];
    await enterStep(id);
    const action = await nav(navOptionsFor(id, i));

    if (action === 'back') { i = Math.max(0, i - 1); continue; }
    if (action === 'skip') {
      if (id === 'workspace') await skipWorkspace();
      _state[id] = 'skipped';
      i++;
      continue;
    }
    if (await commitStep(id)) { _state[id] = 'done'; i++; }
  }
}

// ── Public entry ─────────────────────────────────────────────────────────────

let _wired = false;
function wireOnce() {
  if (_wired) return;
  _wired = true;

  $('wiz-back')?.addEventListener('click', () => _navResolve?.('back'));
  $('wiz-skip')?.addEventListener('click', () => _navResolve?.('skip'));
  $('wiz-next')?.addEventListener('click', () => _navResolve?.('next'));

  $('wiz-ws-browse')?.addEventListener('click', async () => {
    if (!bridgeOnline()) return;
    try {
      const r = await bridgeCall('workspace.pickFolder', {});
      if (r && r.ok && r.path) $('wiz-ws-path').value = withWorkspaceFolder(r.path);
    } catch { /* picker unavailable — the typed path still works */ }
  });

  document.querySelectorAll('#wizard-overlay [data-env-browse]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.envBrowse;
      const inp = envInput(key);
      if (!bridgeOnline() || !inp) return;
      try {
        const r = await bridgeCall('env.pickPath', {
          kind: btn.dataset.kind || 'folder',
          title: 'Select path',
          initial: inp.value || '',
        });
        if (r && r.ok && r.path) {
          inp.value = r.path;
          validateEnvField(key);
          if (key === 'XI_SERVER_DIR') await autofillFromServer(r.path);
        }
      } catch { /* keep whatever is typed */ }
    });
  });

  envInputs().forEach((inp) => {
    const key = inp.dataset.envKey;
    if (!document.querySelector(`#wizard-overlay [data-tick="${key}"]`)) return;
    inp.addEventListener('input', () => scheduleValidate(key));
    inp.addEventListener('change', () => {
      validateEnvField(key);
      if (key === 'XI_SERVER_DIR') autofillFromServer(inp.value.trim());
    });
  });

  $('wiz-db-test')?.addEventListener('click', testDbConnection);
  $('wiz-shortcut-btn')?.addEventListener('click', createShortcut);

  bridgeCall('app.version', {}).then((r) => {
    if (r?.version) $('wiz-version').textContent = `v${r.version}`;
  }).catch(() => { /* shown blank until the bridge is up */ });
}

/**
 * Run the setup panel. Always performs the xi-tools check; runs the remaining steps
 * only on a fresh install. Resolves `{ online }` once the editor may open.
 */
export async function runSetupWizard() {
  wireOnce();
  _state = {};
  showOverlay(true);

  // xi-tools: always. This is the update path, not just first-run.
  showPane('tools');
  $('wiz-back').style.display = 'none';
  $('wiz-skip').style.display = 'none';
  $('wiz-next').style.display = 'none';

  let boot = { online: false };
  try {
    boot = await runToolsBoot(
      { setBridgeUrl, connectBridge, bridgeOnline, onBridgeStatus },
      toolsView(),
    );
  } catch (e) {
    console.warn('[setup] tools boot failed', e);
    connectBridge();
  }
  _state.tools = 'done';

  if (setupComplete()) {
    showOverlay(false);
    return boot;
  }

  // A fresh install with no backend can't save anything the remaining steps collect.
  if (!boot.online) {
    showPane('tools');
    setMsg('Setup needs the XI Tools backend. You can continue offline, but the editor will be read-only.', true);
    const key = await nav({ back: false, skip: true, next: false, skipLabel: 'Continue offline' });
    if (key === 'skip') { showOverlay(false); return boot; }
  }

  await runFlow();
  localStorage.setItem(SETUP_DONE_KEY, '1');
  showOverlay(false);
  return boot;
}

/** Reopen the wizard at the workspace step (used when the folder goes missing). */
export async function reopenWorkspaceSetup(message) {
  wireOnce();
  _state = {};
  showOverlay(true);
  await enterStep('workspace');
  if (message) setMsg(message, true);
  while (true) {
    const action = await nav({ back: false, skip: true, skipLabel: 'Use default folder' });
    if (action === 'skip') { await skipWorkspace(); break; }
    if (await commitWorkspace()) break;
  }
  showOverlay(false);
}

// ── Settings → Setup panes ───────────────────────────────────────────────────
// The same fields as the wizard, reachable after setup. They read and write the same
// .env through the same bridge calls, so there is one source of truth rather than a
// separate copy in localStorage that silently disagrees.

const setInput = (key) => document.querySelector(`#settings-panel [data-setenv="${key}"]`);
const setInputs = () => [...document.querySelectorAll('#settings-panel [data-setenv]')];

function setState(target, text, kind = '') {
  const el = typeof target === 'string'
    ? (document.getElementById(target) || document.querySelector(`#settings-panel [data-setenv-state="${target}"]`))
    : target;
  if (!el) return;
  el.textContent = text || '';
  el.className = `set-env-state${kind ? ' ' + kind : ''}`;
}

async function validateSettingsField(key) {
  const inp = setInput(key);
  if (!inp) return;
  const path = (inp.value || '').trim();
  if (!path) { setState(key, ''); return; }
  if (!bridgeOnline()) { setState(key, 'Backend offline', 'bad'); return; }
  try {
    const r = await bridgeCall('env.validate', { key, path });
    setState(key, r?.detail || (r?.valid ? 'OK' : 'Not found'), r?.valid ? 'ok' : 'bad');
  } catch { setState(key, ''); }
}

async function loadSettingsValues() {
  if (!bridgeOnline()) return;
  let st;
  try { st = await bridgeCall('env.status', {}); } catch { return; }
  const vals = (st && st.values) || {};
  for (const inp of setInputs()) {
    const v = vals[inp.dataset.setenv];
    inp.value = v || '';
  }
  for (const inp of setInputs()) if (inp.value) validateSettingsField(inp.dataset.setenv);

  const ws = document.getElementById('set-ws-path');
  if (ws) ws.value = localStorage.getItem(WORKSPACE_PATH_KEY) || '';

  // Say where the effective database login actually comes from — otherwise blank
  // fields look broken when they are in fact deferring to network.lua.
  const db = st?.db;
  if (db) {
    setState('set-db-msg', db.source === 'network.lua'
      ? `Using ${db.user}@${db.host}/${db.database} from ${db.luaPath}`
      : (db.source === 'override'
        ? `Using the values below (overriding network.lua).`
        : `No server checkout set — falling back to ${db.user}@${db.host}/${db.database}.`));
  }
}

async function refreshShortcutPane() {
  const msg = document.getElementById('set-shortcut-msg');
  const btn = document.getElementById('set-shortcut-btn');
  if (!msg || !btn) return;
  try { _shortcut = (await tauriInvoke('desktop_shortcut_status')) || { supported: false }; }
  catch { _shortcut = { supported: false }; }
  if (!_shortcut.supported) {
    msg.textContent = 'Desktop shortcuts are only available in the Windows desktop app.';
    btn.disabled = true;
    return;
  }
  msg.textContent = _shortcut.exists
    ? `Shortcut exists — ${_shortcut.path}`
    : 'No Desktop shortcut yet.';
  btn.textContent = _shortcut.exists ? 'Recreate shortcut' : 'Create Desktop shortcut';
  btn.disabled = false;
}

/** Wire Settings → Setup. Call once, after the settings DOM exists. */
export function initSetupSettings() {
  document.querySelectorAll('#settings-panel [data-setenv-browse]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.setenvBrowse;
      const inp = setInput(key);
      if (!bridgeOnline() || !inp) return;
      try {
        const r = await bridgeCall('env.pickPath', {
          kind: btn.dataset.kind || 'folder', title: 'Select path', initial: inp.value || '',
        });
        if (r && r.ok && r.path) {
          inp.value = r.path;
          validateSettingsField(key);
          if (key === 'XI_SERVER_DIR') {
            const c = await bridgeCall('env.serverCreds', { path: r.path }).catch(() => null);
            if (c && c.ok && c.values) {
              for (const [k, v] of Object.entries(c.values)) {
                const target = setInput(k);
                if (target && v && !target.value.trim()) target.value = v;
              }
              setState('set-db-msg', `Read the database login from ${c.path}`, 'ok');
            }
          }
        }
      } catch { /* keep the typed value */ }
    });
  });

  setInputs().forEach((inp) => {
    inp.addEventListener('change', () => {
      if (document.querySelector(`#settings-panel [data-setenv-state="${inp.dataset.setenv}"]`)) {
        validateSettingsField(inp.dataset.setenv);
      }
    });
  });

  document.getElementById('set-paths-save')?.addEventListener('click', async () => {
    if (!bridgeOnline()) { setState('set-paths-msg', 'Backend offline.', 'bad'); return; }
    const values = {};
    for (const key of STEP_ENV_KEYS.paths) values[key] = (setInput(key)?.value || '').trim();
    if (!values.FFXI_DIR) { setState('set-paths-msg', 'The FFXI folder is required.', 'bad'); return; }
    try {
      const r = await bridgeCall('env.save', { values });
      setState('set-paths-msg', r?.ok ? 'Saved.' : (r?.error || 'Could not save.'), r?.ok ? 'ok' : 'bad');
    } catch (e) { setState('set-paths-msg', e?.message || 'Could not save.', 'bad'); }
  });

  document.getElementById('set-db-save')?.addEventListener('click', async () => {
    if (!bridgeOnline()) { setState('set-db-msg', 'Backend offline.', 'bad'); return; }
    const values = {};
    for (const key of STEP_ENV_KEYS.server) values[key] = (setInput(key)?.value || '').trim();
    try {
      const r = await bridgeCall('env.save', { values });
      setState('set-db-msg', r?.ok ? 'Saved.' : (r?.error || 'Could not save.'), r?.ok ? 'ok' : 'bad');
    } catch (e) { setState('set-db-msg', e?.message || 'Could not save.', 'bad'); }
  });

  document.getElementById('set-db-test')?.addEventListener('click', async () => {
    if (!bridgeOnline()) { setState('set-db-msg', 'Backend offline.', 'bad'); return; }
    setState('set-db-msg', 'Connecting…');
    try {
      const r = await bridgeCall('env.testDb', {
        host: (setInput('XI_DB_HOST')?.value || '').trim(),
        port: (setInput('XI_DB_PORT')?.value || '').trim(),
        user: (setInput('XI_DB_USER')?.value || '').trim(),
        password: setInput('XI_DB_PASSWORD')?.value || '',
        database: (setInput('XI_DB_NAME')?.value || '').trim(),
      });
      setState('set-db-msg',
        r?.ok ? `Connected to ${r.database} on ${r.host} — MariaDB ${r.version}, ${r.npcRows.toLocaleString()} NPCs.`
              : (r?.error || 'Could not connect.'),
        r?.ok ? 'ok' : 'bad');
    } catch (e) { setState('set-db-msg', e?.message || 'Could not connect.', 'bad'); }
  });

  document.getElementById('set-ws-browse')?.addEventListener('click', async () => {
    if (!bridgeOnline()) return;
    try {
      const r = await bridgeCall('workspace.pickFolder', {});
      if (r && r.ok && r.path) document.getElementById('set-ws-path').value = withWorkspaceFolder(r.path);
    } catch { /* picker unavailable */ }
  });

  document.getElementById('set-ws-apply')?.addEventListener('click', async () => {
    const path = (document.getElementById('set-ws-path')?.value || '').trim();
    if (!path) { setState('set-ws-msg', 'Choose a folder first.', 'bad'); return; }
    if (!bridgeOnline()) { setState('set-ws-msg', 'Backend offline.', 'bad'); return; }
    setState('set-ws-msg', 'Setting up…');
    try {
      const r = await bridgeCall('workspace.setup', { path });
      if (!r || !r.ok) { setState('set-ws-msg', (r && r.error) || 'Could not set that folder.', 'bad'); return; }
      localStorage.setItem(WORKSPACE_PATH_KEY, r.path || path);
      // Projects, zone lists and change-sets are all read relative to the workspace, so
      // switching it mid-session would leave half the UI pointing at the old folder.
      setState('set-ws-msg', 'Saved — reload the editor for it to take effect.', 'ok');
    } catch (e) { setState('set-ws-msg', e?.message || 'Could not set that folder.', 'bad'); }
  });

  document.getElementById('set-shortcut-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('set-shortcut-btn');
    btn.disabled = true;
    try {
      _shortcut = (await tauriInvoke('create_desktop_shortcut')) || _shortcut;
      setState('set-shortcut-msg', `Created — ${_shortcut.path}`, 'ok');
    } catch (e) {
      setState('set-shortcut-msg', String(e?.message || e || 'Could not create the shortcut.'), 'bad');
    } finally { btn.disabled = false; await refreshShortcutPane(); }
  });

  // Values are fetched when the panel opens rather than at boot: .env can change from
  // the wizard, another window, or by hand, and stale fields here would overwrite it.
  document.getElementById('settings-btn')?.addEventListener('click', () => {
    loadSettingsValues();
    refreshShortcutPane();
  });
  onBridgeStatus((online) => {
    if (online && document.getElementById('settings-panel')?.classList.contains('open')) {
      loadSettingsValues();
    }
  });
}

// Dev helper: wipe setup state and start over.
window.xiResetSetup = () => {
  localStorage.removeItem(SETUP_DONE_KEY);
  localStorage.removeItem(WORKSPACE_PATH_KEY);
  localStorage.removeItem('xi.workspaceConfigured');
  localStorage.removeItem('xi.envConfigured');
  location.reload();
};
