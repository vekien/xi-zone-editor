// setup-wizard.js — boot splash + first-run Setup wizard.
//
// Every launch: a minimal splash runs the xi-tools check/download (same code path).
// First run only: after the splash, the framed wizard collects workspace / paths /
// server / shortcut. Once setup is marked complete, the splash hands off straight
// to the projects launcher. Settings → Setup edits the same fields later.

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

/** Wizard steps only — tools boot is the splash, not a stepper entry. */
const STEPS = [
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
    title: 'Connect your server', sub: 'Link a local LandSandBoat server so the editor can read its live data.',
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

const FLOW = STEPS.map((s) => s.id);

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

/** Splash = minimal centered boot UI; wizard = framed stepper for first-run. */
function setSplashMode(on) {
  $('wizard-overlay')?.classList.toggle('wiz-splash', on);
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
    detail: (t) => { const el = $('wiz-tools-detail'); if (el) el.textContent = t || ''; },
    bar: (pct) => { $('wiz-tools-bar').style.width = `${Math.max(0, Math.min(100, pct))}%`; },
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

/** Compact connection banner under the DB form. */
function setDbBanner(state, text) {
  const el = $('wiz-db-result');
  if (!el) return;
  if (!state) {
    el.hidden = true;
    el.className = 'wiz-db-banner';
    el.textContent = '';
    return;
  }
  const icons = { ok: 'check_circle', bad: 'error', pending: 'progress_activity' };
  el.hidden = false;
  el.className = `wiz-db-banner ${state}`;
  el.innerHTML = `<span class="material-symbols-outlined">${icons[state] || 'info'}</span><span>${text}</span>`;
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
  if (!bridgeOnline()) {
    setDbBanner('bad', 'Backend not connected.');
    return;
  }
  const btn = $('wiz-db-test');
  btn.disabled = true;
  setDbBanner('pending', 'Connecting…');
  try {
    const r = await bridgeCall('env.testDb', {
      host: ($('wiz-db-host').value || '').trim(),
      port: ($('wiz-db-port').value || '').trim(),
      user: ($('wiz-db-user').value || '').trim(),
      password: $('wiz-db-pass').value || '',
      database: ($('wiz-db-name').value || '').trim(),
    });
    if (r && r.ok) {
      setDbBanner('ok', 'Connection confirmed');
    } else {
      setDbBanner('bad', (r && r.error) || 'Could not connect.');
    }
  } catch (e) {
    setDbBanner('bad', e?.message || 'Could not connect.');
  } finally {
    btn.disabled = false;
  }
}

// ── Step: desktop shortcut ───────────────────────────────────────────────────

async function tauriInvoke(cmd, args = {}) {
  if (!window.__TAURI__?.core?.invoke) return null;
  return window.__TAURI__.core.invoke(cmd, args);
}

/** Dialog titles per env field — a picker labelled "Select path" tells you nothing. */
const BROWSE_TITLES = {
  FFXI_DIR:       'Select your FINAL FANTASY XI folder',
  FFXI_HD_DIR:    'Select your HD DAT pack folder',
  FFXI_PIVOT_DIR: 'Select your pivot / override DATs folder',
  XI_SERVER_DIR:  'Select your LSB server folder',
};

/**
 * Pick a folder, preferring the desktop shell's dialog.
 *
 * Tauri's rfd picker is the modern Explorer one — address bar, left nav, search. The
 * bridge fallback shells out to PowerShell's FolderBrowserDialog, which on .NET
 * Framework is still the cramped SHBrowseForFolder tree; it is only reached in a plain
 * browser / `npm run dev`, where there is no shell to ask.
 *
 * @returns {Promise<string>} chosen path, or '' if cancelled/unavailable
 */
async function pickFolder({ initial = '', title = 'Select folder' } = {}) {
  if (window.__TAURI__?.core?.invoke) {
    try {
      return (await tauriInvoke('pick_folder', { initial, title })) || '';
    } catch { /* fall through to the bridge */ }
  }
  if (!bridgeOnline()) return '';
  try {
    const r = await bridgeCall('env.pickPath', { kind: 'folder', title, initial });
    return (r && r.ok && r.path) ? r.path : '';
  } catch { return ''; }
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
    ? or(`${vals.XI_DB_USER || 'root'}@${vals.XI_DB_HOST || '127.0.0.1'}/${vals.XI_DB_NAME || 'xidb'}`, dash)
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
  if (id === 'server') setDbBanner(null);
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
  if (id === 'workspace') return { back, skip: true, skipLabel: 'Skip' };
  if (id === 'paths') return { back, skip: false };
  if (id === 'server') return { back, skip: true, skipLabel: 'Skip' };
  if (id === 'shortcut') return { back, skip: true, skipLabel: 'Skip' };
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
    const path = await pickFolder({
      initial: $('wiz-ws-path')?.value || '',
      title: 'Choose where to save your zone edits',
    });
    if (path) $('wiz-ws-path').value = withWorkspaceFolder(path);
  });

  document.querySelectorAll('#wizard-overlay [data-env-browse]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.envBrowse;
      const inp = envInput(key);
      if (!inp) return;
      const path = await pickFolder({
        initial: inp.value || '',
        title: BROWSE_TITLES[key] || 'Select folder',
      });
      if (!path) return;                       // cancelled — keep whatever is typed
      inp.value = path;
      validateEnvField(key);
      if (key === 'XI_SERVER_DIR') await autofillFromServer(path);
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

/** Let the browser paint the wizard before any heavy work (download / GitHub check). */
function waitForPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // One more macrotask so layout + composite finish before we block on IPC.
        setTimeout(resolve, 0);
      });
    });
  });
}

// Single flight: the early boot script and main.js both call this; only one run.
let _setupRun = null;

/**
 * Boot entry. Always runs the xi-tools splash; then either opens the projects
 * launcher (setup already done) or the first-run wizard. Resolves `{ online }`.
 *
 * The splash is already in the HTML (tools pane active, body.wiz-active, wiz-splash)
 * so the user sees it on first paint. Download/status only start after a paint yield.
 */
export function runSetupWizard() {
  if (_setupRun) return _setupRun;
  _setupRun = (async () => {
    wireOnce();
    _state = {};
    showOverlay(true);
    setSplashMode(true);

    // Show the tools pane without driving the wizard stepper (tools is not a step).
    document.querySelectorAll('#wizard-overlay .wiz-pane').forEach((el) => {
      el.classList.toggle('active', el.dataset.pane === 'tools');
    });
    $('wiz-back').style.display = 'none';
    $('wiz-skip').style.display = 'none';
    $('wiz-next').style.display = 'none';
    $('wiz-tools-line').textContent = 'Checking xi-tools…';
    $('wiz-tools-meta').textContent = '';

    await waitForPaint();

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

    // Returning user → splash dismisses; main.js opens the projects launcher.
    if (setupComplete()) {
      showOverlay(false);
      return boot;
    }

    // First run: flip splash → wizard chrome and walk the remaining steps.
    setSplashMode(false);

    if (!boot.online) {
      // Stay on splash-looking tools content inside the wizard shell so they can bail.
      document.querySelectorAll('#wizard-overlay .wiz-pane').forEach((el) => {
        el.classList.toggle('active', el.dataset.pane === 'tools');
      });
      $('wiz-title').textContent = 'Backend required';
      $('wiz-sub').textContent = 'Setup needs XI Tools. You can continue offline, but the editor will be read-only.';
      setMsg('Continue offline to skip setup for now.', true);
      const key = await nav({ back: false, skip: true, next: false, skipLabel: 'Skip' });
      if (key === 'skip') { showOverlay(false); return boot; }
    }

    await runFlow();
    localStorage.setItem(SETUP_DONE_KEY, '1');
    showOverlay(false);
    return boot;
  })();
  return _setupRun;
}

/** Reopen the wizard at the workspace step (used when the folder goes missing). */
export async function reopenWorkspaceSetup(message) {
  wireOnce();
  _state = {};
  showOverlay(true);
  setSplashMode(false);
  await enterStep('workspace');
  if (message) setMsg(message, true);
  while (true) {
    const action = await nav({ back: false, skip: true, skipLabel: 'Skip' });
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
      if (!inp) return;
      const path = await pickFolder({
        initial: inp.value || '',
        title: BROWSE_TITLES[key] || 'Select folder',
      });
      if (!path) return;                       // cancelled — keep the typed value
      inp.value = path;
      validateSettingsField(key);
      if (key === 'XI_SERVER_DIR') {
        const c = await bridgeCall('env.serverCreds', { path }).catch(() => null);
        if (c && c.ok && c.values) {
          for (const [k, v] of Object.entries(c.values)) {
            const target = setInput(k);
            if (target && v && !target.value.trim()) target.value = v;
          }
          setState('set-db-msg', `Read the database login from ${c.path}`, 'ok');
        }
      }
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
        r?.ok ? 'Connection confirmed' : (r?.error || 'Could not connect.'),
        r?.ok ? 'ok' : 'bad');
    } catch (e) { setState('set-db-msg', e?.message || 'Could not connect.', 'bad'); }
  });

  document.getElementById('set-ws-browse')?.addEventListener('click', async () => {
    const path = await pickFolder({
      initial: document.getElementById('set-ws-path')?.value || '',
      title: 'Choose where to save your zone edits',
    });
    if (path) document.getElementById('set-ws-path').value = withWorkspaceFolder(path);
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
