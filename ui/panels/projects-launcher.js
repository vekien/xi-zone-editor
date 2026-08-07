// ── Projects launcher + First-run workspace setup ────────────────────────────
// Extracted from main.js. Boot flow:
//   • No workspace configured → setup gate: clone the shared workspaces repo.
//   • Workspace configured     → Projects launcher: pick a category → editor.
//
// Deps are injected via initProjectsLauncher({ ... }) so this module stays
// independent of main.js scope while still driving the full boot / project UX.

import { bridgeCall, bridgeOnline, onBridgeStatus } from '../ffxi/bridge.js';

// ── Workspace config keys ─────────────────────────────────────────────────────
const SETUP_DONE_KEY      = 'xi.workspaceConfigured';
const WORKSPACE_PATH_KEY  = 'xi.workspacePath';
const WORKSPACE_FOLDER_NAME = 'xi-tools-workspaces';

function workspaceConfigured() { return localStorage.getItem(SETUP_DONE_KEY) === '1'; }

// ── Mutable launcher state (exported as a live object so main.js can read by ref) ──
// Main.js reads: launcherState.currentProject, .browseOnly, .projectAwaitingZone,
//                .launcherActive, .setupGateActive
// Main.js writes: launcherState.projectAwaitingZone (set to false in onZoneLoaded)
export const launcherState = {
  currentProject:      null,     // active project (edit) or null (browse / none)
  browseOnly:          false,    // Browse Zones → read-only, View mode forced
  projectAwaitingZone: false,    // in a project but no zone picked yet → View until one loads
  launcherActive:      !workspaceConfigured(),  // true when workspace configured on boot
  setupGateActive:     !workspaceConfigured(),  // true when setup gate should show
};
// Correct initial values: if workspace is configured, launcherActive=true, setupGateActive=false
launcherState.setupGateActive = !workspaceConfigured();
launcherState.launcherActive  = !launcherState.setupGateActive;

// ── Injected deps (set by initProjectsLauncher) ───────────────────────────────
let _deps = null;

// ── Setup-gate state ──────────────────────────────────────────────────────────
let setupBusy = false;

// ── Workspace helpers ─────────────────────────────────────────────────────────
export function workspacePath() { return localStorage.getItem(WORKSPACE_PATH_KEY) || ''; }

// The backend workspace root for a project = <workspace repo>/<project id>.
export function projectRoot(project) {
  const base = workspacePath().replace(/[\\/]+$/, '');
  return (base && project && project.id) ? `${base}/${project.id}` : '';
}

// Point the backend's workspace reads/writes at a project folder ('' = legacy default).
async function setBackendProjectRoot(root) {
  if (!bridgeOnline()) return;
  try { await bridgeCall('workspace.setActiveProject', { root: root || '' }); } catch {}
}

// Per-project last-viewed zone — editor-local (localStorage), NOT committed to the workspace.
const PROJECT_LASTZONE_KEY = 'xi.projectLastZone';
function loadProjectLastZones() {
  try { return JSON.parse(localStorage.getItem(PROJECT_LASTZONE_KEY) || '{}') || {}; }
  catch { return {}; }
}
export function getProjectLastZone(id) { return id ? (loadProjectLastZones()[id] || '') : ''; }
export function setProjectLastZone(id, url) {
  if (!id || !url) return;
  const m = loadProjectLastZones();
  if (m[id] === url) return;
  m[id] = url;
  localStorage.setItem(PROJECT_LASTZONE_KEY, JSON.stringify(m));
}

// Per-user package-zone selection, scoped by project id — editor-local (localStorage),
// NOT committed to the shared workspace. Returns null when never saved (→ default all on).
const PACKAGE_SEL_KEY = 'xi.packageSelections';
function loadPackageSelections() {
  try { return JSON.parse(localStorage.getItem(PACKAGE_SEL_KEY) || '{}') || {}; }
  catch { return {}; }
}
export function getPackageSelection(id) {
  if (!id) return null;
  const v = loadPackageSelections()[id];
  return Array.isArray(v) ? v : null;
}
export function setPackageSelection(id, paths) {
  if (!id) return;
  const m = loadPackageSelections();
  m[id] = paths;
  localStorage.setItem(PACKAGE_SEL_KEY, JSON.stringify(m));
}

// ── Setup gate helpers ────────────────────────────────────────────────────────
function showSetupError(msg) {
  const el = document.getElementById('setup-error');
  if (!el) return;
  if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; }
}

function setSetupCloning(on) {
  setupBusy = on;
  const form = document.getElementById('setup-form');
  const prog = document.getElementById('setup-progress');
  if (form) form.hidden = on;
  if (prog) prog.hidden = !on;
  if (on) { const s = document.getElementById('setup-progress-status'); if (s) s.textContent = 'Setting up folder…'; }
}

function dismissSetupGate() {
  launcherState.setupGateActive = false;
  document.body.classList.remove('setup-gating');
  const ov = document.getElementById('setup-overlay');
  if (ov) ov.style.display = 'none';
}

// ── FFXI path (.env) setup ───────────────────────────────────────────────────
const ENV_DONE_KEY = 'xi.envConfigured';
const ENV_INPUTS = {
  FFXI_DIR: 'env-ffxi',
  FFXI_HD_DIR: 'env-hd',
  FFXI_PIVOT_DIR: 'env-pivot',
  BLENDER_PATH: 'env-blender',
};

function showEnvError(msg) {
  const el = document.getElementById('env-setup-error');
  if (!el) return;
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = msg;
}

function hideEnvSetup() {
  const ov = document.getElementById('env-setup-overlay');
  if (ov) ov.style.display = 'none';
}

function hideAppLoader() {
  const el = document.getElementById('app-loader');
  if (el) el.classList.add('hidden');
}

/** Show workspace setup overlay (first-run / missing workspace). */
export function showSetupGate(message) {
  launcherState.setupGateActive = true;
  launcherState.launcherActive = false;
  document.body.classList.remove('tools-booting');
  document.body.classList.add('setup-gating');
  hideEnvSetup();
  const lov = document.getElementById('projects-overlay');
  if (lov) lov.style.display = 'none';
  const ov = document.getElementById('setup-overlay');
  if (ov) ov.style.display = 'flex';
  hideAppLoader();
  if (message) showSetupError(message);
}

function _isPlaceholderPath(v) {
  if (!v || !String(v).trim()) return true;
  const s = String(v).toLowerCase();
  return s.includes('path\\to') || s.includes('path/to') || s.includes('<')
    || s.includes('your-overlay') || s.includes('your-server');
}

function setEnvTick(key, state, title = '') {
  // state: '' | 'ok' | 'bad'
  const el = document.getElementById(`tick-${key}`);
  if (!el) return;
  el.classList.toggle('on', state === 'ok' || state === 'bad');
  el.classList.toggle('bad', state === 'bad');
  el.hidden = !state;
  el.title = title || '';
  const ico = el.querySelector('.material-symbols-outlined');
  if (ico) ico.textContent = state === 'bad' ? 'cancel' : 'check_circle';
}

let _envValidateTimer = null;
async function validateEnvField(key) {
  const id = ENV_INPUTS[key];
  const inp = id && document.getElementById(id);
  if (!inp) return false;
  const path = inp.value.trim();
  if (!path) {
    setEnvTick(key, '');
    return key !== 'FFXI_DIR';
  }
  if (!bridgeOnline()) {
    setEnvTick(key, '');
    return false;
  }
  try {
    const r = await bridgeCall('env.validate', { key, path });
    if (r?.empty) { setEnvTick(key, ''); return key !== 'FFXI_DIR'; }
    if (r?.valid) { setEnvTick(key, 'ok', r.detail || 'OK'); return true; }
    setEnvTick(key, path ? 'bad' : '', r?.detail || '');
    return false;
  } catch {
    setEnvTick(key, '');
    return false;
  }
}

function scheduleValidateEnvField(key) {
  clearTimeout(_envValidateTimer);
  _envValidateTimer = setTimeout(() => validateEnvField(key), 280);
}

async function openEnvSetup(prefill = {}) {
  const ov = document.getElementById('env-setup-overlay');
  if (!ov) { openProjectsLauncher(); return; }
  document.body.classList.remove('tools-booting');
  showEnvError('');
  // Show the form immediately so a slow/hung env.status never leaves a blank screen.
  ov.style.display = 'flex';
  hideAppLoader();
  let values = { ...prefill };
  try {
    const st = await bridgeCall('env.status', {});
    if (st?.values) values = { ...st.values, ...prefill };
  } catch { /* offline */ }
  for (const [key, id] of Object.entries(ENV_INPUTS)) {
    const inp = document.getElementById(id);
    if (!inp) continue;
    // Only prefill real saved paths — never sample placeholders.
    const v = values[key];
    inp.value = (!_isPlaceholderPath(v) && v) ? v : '';
    setEnvTick(key, '');
  }
  // Suggest Blender in the placeholder only (don't force-fill the field).
  const b = document.getElementById('env-blender');
  if (b && !b.value.trim()) {
    try {
      const d = await bridgeCall('env.detectBlender', {});
      if (d?.path) b.placeholder = d.path;
    } catch { /* ignore */ }
  }
  // Live ticks for anything already filled
  for (const key of Object.keys(ENV_INPUTS)) validateEnvField(key);
}

function _envStatusWithTimeout(ms = 4000) {
  return Promise.race([
    bridgeCall('env.status', {}),
    new Promise((_, rej) => setTimeout(() => rej(new Error('env.status timeout')), ms)),
  ]);
}

/** After workspace setup (or on boot): require FFXI_DIR before projects launcher. */
export async function maybeOpenEnvOrLauncher() {
  document.body.classList.remove('tools-booting');

  // Reopen fast-path: user already completed Game Paths — show projects immediately.
  // Re-verify FFXI in the background; only bounce back to the form if it's missing.
  if (localStorage.getItem(ENV_DONE_KEY) === '1') {
    openProjectsLauncher();
    if (bridgeOnline()) {
      _envStatusWithTimeout(5000).then((st) => {
        if (st?.ffxiOk) return;
        if (st && st.ffxiOk === false) {
          const lov = document.getElementById('projects-overlay');
          if (lov) lov.style.display = 'none';
          launcherState.launcherActive = false;
          openEnvSetup(st.values || {});
        }
      }).catch(() => { /* keep projects UI */ });
    }
    return;
  }

  if (!bridgeOnline()) {
    openProjectsLauncher();
    return;
  }
  try {
    const st = await _envStatusWithTimeout(4000);
    if (st?.ffxiOk) {
      localStorage.setItem(ENV_DONE_KEY, '1');
      openProjectsLauncher();
      return;
    }
  } catch { /* show form */ }
  // Hide projects overlay while configuring paths
  const lov = document.getElementById('projects-overlay');
  if (lov) lov.style.display = 'none';
  launcherState.launcherActive = false;
  await openEnvSetup();
}

async function continueAfterWorkspace() {
  dismissSetupGate();
  await maybeOpenEnvOrLauncher();
}

async function saveEnvSetup() {
  const values = {};
  for (const [key, id] of Object.entries(ENV_INPUTS)) {
    values[key] = (document.getElementById(id)?.value || '').trim();
  }
  if (!values.FFXI_DIR) {
    showEnvError('FFXI directory is required.');
    return;
  }
  if (!bridgeOnline()) {
    showEnvError('Backend offline — wait for XI Tools to finish connecting.');
    return;
  }
  showEnvError('');
  const btn = document.getElementById('env-setup-go');
  if (btn) btn.disabled = true;
  try {
    const r = await bridgeCall('env.save', { values });
    if (!r || !r.ok) {
      showEnvError((r && r.error) || 'Could not save settings.');
      return;
    }
    localStorage.setItem(ENV_DONE_KEY, '1');
    // DLL / DAT fetches must re-resolve against the new FFXI_DIR.
    try { window.invalidateKeyTables?.(); } catch { /* optional */ }
    hideEnvSetup();
    openProjectsLauncher();
  } catch (e) {
    showEnvError(e?.message || 'Save failed.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function browseEnvField(key, kind) {
  const id = ENV_INPUTS[key];
  const inp = id && document.getElementById(id);
  const initial = inp?.value || '';
  try {
    const r = await bridgeCall('env.pickPath', {
      kind: kind || 'folder',
      title: key === 'BLENDER_PATH' ? 'Select blender.exe' : `Select ${key}`,
      initial,
    });
    if (r?.ok && r.path && inp) inp.value = r.path;
  } catch { /* picker unavailable */ }
}

// Append the workspaces folder name to a picked parent (D:\ → D:\xi-tools-workspaces),
// unless the user already selected a folder of that name. Keeps the OS path separator.
function withWorkspaceFolder(raw) {
  const sep = raw.includes('\\') ? '\\' : '/';
  const p = raw.replace(/[\\/]+$/, '');                 // trim trailing separators
  const leaf = p.split(/[\\/]/).pop();
  return (leaf === WORKSPACE_FOLDER_NAME) ? p : p + sep + WORKSPACE_FOLDER_NAME;
}

async function browseWorkspaceFolder() {
  if (!bridgeOnline()) return;            // the native folder dialog lives on the backend
  try {
    const r = await bridgeCall('workspace.pickFolder', {});
    if (r && r.ok && r.path) document.getElementById('setup-path').value = withWorkspaceFolder(r.path);
  } catch { /* picker unavailable — keep the typed path */ }
}

async function skipWorkspaceSetup() {
  if (setupBusy) return;
  const r = await bridgeCall('workspace.skip', {});
  if (!r || !r.ok) { showSetupError((r && r.error) || 'Could not create local workspaces folder.'); return; }
  localStorage.setItem(SETUP_DONE_KEY, '1');
  if (r.path) localStorage.setItem(WORKSPACE_PATH_KEY, r.path);
  await continueAfterWorkspace();
}

async function runWorkspaceSetup() {
  if (setupBusy) return;
  const input = document.getElementById('setup-path');
  const path = (input?.value || '').trim();
  if (!path) { showSetupError('Choose a folder to save your workspaces.'); return; }
  if (!bridgeOnline()) {
    showSetupError("XI Tools backend isn't connected yet. Wait for the XI Tools setup to finish, or restart the app.");
    return;
  }
  showSetupError('');
  setSetupCloning(true);
  const statusEl = document.getElementById('setup-progress-status');
  const onLog = (line) => { if (statusEl && line) statusEl.textContent = line; };
  try {
    const r = await bridgeCall('workspace.setup', { path }, onLog);
    if (!r || !r.ok) { setSetupCloning(false); showSetupError((r && r.error) || 'Workspace setup failed.'); return; }
    localStorage.setItem(SETUP_DONE_KEY, '1');
    if (r.path) localStorage.setItem(WORKSPACE_PATH_KEY, r.path);
    setSetupCloning(false);
    await continueAfterWorkspace();
  } catch (e) {
    setSetupCloning(false);
    showSetupError((e && e.message) ? e.message : 'Workspace setup failed.');
  }
}

// ── Projects launcher ─────────────────────────────────────────────────────────
async function fillLauncherVersion() {
  const el = document.getElementById('projects-version');
  if (!el || el.dataset.filled === '1') return;
  try {
    const r = await bridgeCall('app.version', {});
    if (r && r.version) { el.textContent = `XI Zone Editor v${r.version}`; el.dataset.filled = '1'; }
  } catch { /* bridge not ready yet — onBridgeStatus retries below */ }
}

export function openProjectsLauncher() {
  launcherState.launcherActive = true;
  launcherState.setupGateActive = false;
  document.body.classList.remove('tools-booting', 'setup-gating');
  hideEnvSetup();
  hideAppLoader();
  fillLauncherVersion();
  refreshProjectsList();
  const ov = document.getElementById('projects-overlay');
  if (ov) ov.style.display = 'flex';
  const backBtn = document.getElementById('projects-back-btn');
  if (backBtn) backBtn.style.display = launcherState.currentProject ? '' : 'none';
}

export function closeProjectsLauncher() {
  launcherState.launcherActive = false;
  const ov = document.getElementById('projects-overlay');
  if (ov) ov.style.display = 'none';
}

// Restrict the mode dropdown to View while browsing (no project = no editing).
function applyModeMenuGating() {
  const modeMenu = _deps?.getModeMenu?.();
  if (!modeMenu) return;
  modeMenu.querySelectorAll('button[data-mode]').forEach((b) => {
    b.disabled = launcherState.browseOnly && b.dataset.mode !== 'view';
  });
}

// Browse Zones — read-only exploration, no project. Loads a zone, forces View mode.
async function enterBrowseMode() {
  launcherState.currentProject = null;
  launcherState.browseOnly = true;
  document.title = 'FFXI Zone Editor';
  closeProjectsLauncher();
  applyModeMenuGating();
  await setBackendProjectRoot('');     // legacy default — browse isn't tied to a project
  await _deps.loadProjectSettings();         // browse has no project file → defaults (seeded from localStorage)
  _deps.applyProjectSettings();
  await _deps.loadZone(_deps.loadSetting('lastZone', '') || _deps.getZoneElValue());
  if (_deps.getMode() !== 'view') await _deps.setMode('view');
}

// Open a project for editing. Blank viewport for now (Getting Started lands here next).
async function enterProject(project) {
  launcherState.currentProject = project;
  launcherState.browseOnly = false;
  document.title = `${project.name || project.id} — XI Zone Editor`;
  launcherState.projectAwaitingZone = true;        // View until a zone loads (onZoneLoaded flips to Edit)
  closeProjectsLauncher();
  applyModeMenuGating();
  // Block the viewport with a "Loading Changes" overlay the instant a project is opened; it stays up
  // through the whole open (settings → zone load → change-set replay) and is taken down by
  // refreshZoneState once the replay settles. The no-zone / error paths below take it down themselves.
  _deps.showChangesLoader?.();
  try {
    await setBackendProjectRoot(projectRoot(project));   // reads/writes now hit the project folder
    await _deps.loadProjectSettings();                         // per-project settings (HD mode, publish flags, viewport prefs)
    _deps.applyProjectSettings();
    const zones = await _deps.refreshProjectZones();           // populate Project Zones + learn if any exist
    // Resume the zone we were last on; else open the project's first edited zone.
    const target = getProjectLastZone(project.id) || (zones[0] && zones[0].zone) || '';
    if (target) {
      await _deps.loadZone(target);   // → onZoneLoaded → refreshZoneState replays changes, then hides the overlay
    } else {
      // Genuinely empty project (no zones yet, e.g. just created) → open ready to edit so
      // File ▸ New lands you straight in edit mode (no zone is loaded yet, but the mode is set).
      launcherState.projectAwaitingZone = false;     // we've committed to Edit; no zone-load needed to flip it
      if (_deps.getMode() !== 'edit') await _deps.setMode('edit');
      _deps.setActiveTab('zone');            // land on the Zone list
      showWelcome();
      _deps.hideChangesLoader?.();           // no zone will load → nothing to replay, take the overlay down now
    }
  } catch (e) {
    _deps.hideChangesLoader?.();             // never leave the viewport blocked if the open fails
    throw e;
  }
}

// TODO: once projects track their zones, only show this for empty projects.
function showWelcome() {
  const ov = document.getElementById('welcome-overlay');
  if (ov) ov.style.display = 'flex';
}
function hideWelcome() {
  const ov = document.getElementById('welcome-overlay');
  if (ov) ov.style.display = 'none';
}

// Projects the user created HERE — stored editor-local (never committed), so we can
// separate "mine" from teammates' projects pulled in via git.
const MY_PROJECTS_KEY = 'xi.myProjects';
function loadMyProjects() { try { return JSON.parse(localStorage.getItem(MY_PROJECTS_KEY) || '[]') || []; } catch { return []; } }
function addMyProject(id) {
  if (!id) return;
  const a = loadMyProjects();
  if (!a.includes(id)) { a.push(id); localStorage.setItem(MY_PROJECTS_KEY, JSON.stringify(a)); }
}
function removeMyProject(id) {
  localStorage.setItem(MY_PROJECTS_KEY, JSON.stringify(loadMyProjects().filter((x) => x !== id)));
}

// Stable colour per tag (hash → hue): dark pill, light same-hue label.
function tagColors(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (Math.imul(h, 31) + tag.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { bg: `hsl(${hue} 45% 20%)`, fg: `hsl(${hue} 70% 78%)`, bd: `hsl(${hue} 45% 36%)` };
}

function timeAgo(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const y = Math.floor(mo / 12); return `${y} year${y === 1 ? '' : 's'} ago`;
}

function buildProjCard(p) {
  const card = document.createElement('div');
  card.className = 'proj-item' + (launcherState.currentProject && launcherState.currentProject.id === p.id ? ' active' : '');
  const name = document.createElement('span'); name.className = 'proj-name'; name.textContent = p.name || p.id;
  card.appendChild(name);
  const authors = Array.isArray(p.authors) ? p.authors.join(', ') : (p.authors || '');
  const meta = document.createElement('span'); meta.className = 'proj-meta'; meta.textContent = authors ? `by ${authors}` : p.id;
  card.appendChild(meta);
  if (p.description) { const d = document.createElement('span'); d.className = 'proj-desc'; d.textContent = p.description; card.appendChild(d); }
  const tags = Array.isArray(p.tags) ? p.tags : [];
  if (tags.length) {
    const row = document.createElement('div'); row.className = 'proj-tags';
    for (const t of tags) {
      const pill = document.createElement('span'); pill.className = 'proj-tag'; pill.textContent = t;
      row.appendChild(pill);
    }
    card.appendChild(row);
  }
  const upd = p.lastUpdated || p.created;
  if (upd) {
    const u = document.createElement('span'); u.className = 'proj-updated';
    u.textContent = `Updated ${timeAgo(upd)}`;
    try { u.title = new Date(upd).toLocaleString(); } catch {}
    if (p.id) { const pid = document.createElement('span'); pid.className = 'proj-id'; pid.textContent = ` — ${p.id}`; u.appendChild(pid); }
    card.appendChild(u);
  }
  const folderBtn = document.createElement('button');
  folderBtn.className = 'proj-edit proj-folder';
  folderBtn.title = 'Open project folder';
  folderBtn.innerHTML = '<span class="material-symbols-outlined">folder_data</span>';
  folderBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const r = await bridgeCall('project.openFolder', { path: workspacePath(), id: p.id });
      if (r && r.ok === false && r.error) _deps.setStatus(r.error, true);
    } catch (err) { _deps.setStatus('Could not open project folder', true); }
  });
  card.appendChild(folderBtn);
  const editBtn = document.createElement('button');
  editBtn.className = 'proj-edit';
  editBtn.title = 'Edit project';
  editBtn.innerHTML = '<span class="material-symbols-outlined">edit</span>';
  editBtn.addEventListener('click', (e) => { e.stopPropagation(); openEditProjectModal(p); });
  card.appendChild(editBtn);
  card.addEventListener('click', () => enterProject(p));
  return card;
}

let _allProjects = [];
const projectTagFilter = new Set();

async function refreshProjectsList() {
  const ul = document.getElementById('projects-list');
  if (!ul) return;
  const path = workspacePath();
  if (!bridgeOnline() || !path) { ul.innerHTML = '<div class="projects-empty">Backend offline.</div>'; hideAppLoader(); return; }
  try {
    const r = await bridgeCall('project.list', { path });
    _allProjects = (r && r.projects) || [];
  } catch { ul.innerHTML = '<div class="projects-empty">Could not load projects.</div>'; hideAppLoader(); return; }
  renderTagFilter();
  renderProjectsList();
  hideAppLoader();
}

function renderProjectsList() {
  const ul = document.getElementById('projects-list');
  if (!ul) return;
  if (!_allProjects.length) { ul.innerHTML = '<div class="projects-empty">No projects yet — create one above.</div>'; return; }
  const matches = (p) => projectTagFilter.size === 0
    || (Array.isArray(p.tags) && p.tags.some((t) => projectTagFilter.has(t)));
  const byRecent = (a, b) => (Date.parse(b.lastUpdated || b.created || 0) || 0) - (Date.parse(a.lastUpdated || a.created || 0) || 0);
  const projects = _allProjects.filter(matches).sort(byRecent);
  ul.innerHTML = '';
  if (!projects.length) { ul.innerHTML = '<div class="projects-empty">No projects match the selected tags.</div>'; return; }
  const mineIds = loadMyProjects();
  const mine = projects.filter((p) => mineIds.includes(p.id));
  const team = projects.filter((p) => !mineIds.includes(p.id));
  const addSection = (title, list, withHeader) => {
    if (!list.length) return;
    const sec = document.createElement('div'); sec.className = 'proj-section';
    if (withHeader) { const h = document.createElement('div'); h.className = 'section-title'; h.textContent = title; sec.appendChild(h); }
    const grid = document.createElement('div'); grid.className = 'proj-grid';
    for (const p of list) grid.appendChild(buildProjCard(p));
    sec.appendChild(grid);
    ul.appendChild(sec);
  };
  addSection('My Projects', mine, mine.length > 0);                      // labelled whenever you have any
  if (team.length) {
    addSection('Team Projects', team, mine.length > 0);                  // labelled only alongside My
  } else if (mine.length && projectTagFilter.size === 0) {
    // You have projects but none from teammates — make that explicit (not while filtering).
    const sec = document.createElement('div'); sec.className = 'proj-section';
    const h = document.createElement('div'); h.className = 'section-title'; h.textContent = 'Team Projects'; sec.appendChild(h);
    const empty = document.createElement('div'); empty.className = 'projects-empty'; empty.textContent = 'No remote projects found.';
    sec.appendChild(empty);
    ul.appendChild(sec);
  }
}

// Filter bar: a chip per unique tag; click to toggle. Projects with ANY selected tag show.
function renderTagFilter() {
  const bar = document.getElementById('projects-tag-filter');
  if (!bar) return;
  const allTags = [...new Set(_allProjects.flatMap((p) => (Array.isArray(p.tags) ? p.tags : [])))].sort((a, b) => a.localeCompare(b));
  if (!allTags.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = '';
  bar.innerHTML = '';
  const label = document.createElement('span'); label.className = 'proj-filter-label'; label.textContent = 'Filter';
  bar.appendChild(label);
  for (const t of allTags) {
    const chip = document.createElement('button');
    chip.className = 'proj-filter-tag' + (projectTagFilter.has(t) ? ' active' : '');
    chip.textContent = t;
    chip.addEventListener('click', () => {
      if (projectTagFilter.has(t)) projectTagFilter.delete(t); else projectTagFilter.add(t);
      renderTagFilter();
      renderProjectsList();
    });
    bar.appendChild(chip);
  }
  if (projectTagFilter.size) {
    const clear = document.createElement('button'); clear.className = 'proj-filter-clear'; clear.textContent = 'Clear';
    clear.addEventListener('click', () => { projectTagFilter.clear(); renderTagFilter(); renderProjectsList(); });
    bar.appendChild(clear);
  }
}

function showNpError(msg) {
  const el = document.getElementById('np-error');
  if (!el) return;
  if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; }
}

let _editingProjectId = null;   // null = create, otherwise the project id being edited
function setNpModal(title, btnText) {
  const t = document.getElementById('np-modal-title'); if (t) t.textContent = title;
  const b = document.getElementById('np-create'); if (b) b.textContent = btnText;
}
function clearNpFields() {
  ['np-name', 'np-desc', 'np-authors', 'np-tags'].forEach((id) => { const e = document.getElementById(id); if (e) e.value = ''; });
}
function openNewProjectModal() {
  _editingProjectId = null;
  showNpError('');
  clearNpFields();
  setNpModal('New Project', 'Create Project');
  const ov = document.getElementById('new-project-overlay');
  if (ov) ov.style.display = 'flex';
  document.getElementById('np-name')?.focus();
}
function openEditProjectModal(p) {
  _editingProjectId = p.id;
  showNpError('');
  setNpModal('Edit Project', 'Save Changes');
  document.getElementById('np-name').value = p.name || '';
  document.getElementById('np-desc').value = p.description || '';
  document.getElementById('np-authors').value = Array.isArray(p.authors) ? p.authors.join(', ') : (p.authors || '');
  document.getElementById('np-tags').value = Array.isArray(p.tags) ? p.tags.join(', ') : (p.tags || '');
  const ov = document.getElementById('new-project-overlay');
  if (ov) ov.style.display = 'flex';
  document.getElementById('np-name')?.focus();
}
function closeNewProjectModal() {
  const ov = document.getElementById('new-project-overlay');
  if (ov) ov.style.display = 'none';
  _editingProjectId = null;
}

let _creatingProject = false;
async function submitProjectForm() {
  if (_creatingProject) return;
  const editing = !!_editingProjectId;
  const name = (document.getElementById('np-name')?.value || '').trim();
  if (!name) { showNpError('Project name is required.'); return; }
  const path = workspacePath();
  if (!bridgeOnline() || !path) { showNpError("Backend offline — can't save the project."); return; }
  showNpError('');
  _creatingProject = true;
  const btn = document.getElementById('np-create');
  if (btn) { btn.disabled = true; btn.textContent = editing ? 'Saving...' : 'Creating...'; }
  const body = {
    path, name,
    description: (document.getElementById('np-desc')?.value || '').trim(),
    authors: (document.getElementById('np-authors')?.value || '').trim(),
    tags: (document.getElementById('np-tags')?.value || '').trim(),
  };
  try {
    const r = editing
      ? await bridgeCall('project.update', { ...body, id: _editingProjectId })
      : await bridgeCall('project.create', body);
    if (!r || !r.ok) { showNpError((r && r.error) || 'Could not save the project.'); return; }
    if (!editing && r.project?.id) addMyProject(r.project.id);   // remember we made this one (editor-local)
    clearNpFields();
    closeNewProjectModal();   // also resets _editingProjectId
    if (editing) refreshProjectsList();
    else enterProject(r.project);
  } catch (e) {
    showNpError((e && e.message) ? e.message : 'Could not save the project.');
  } finally {
    _creatingProject = false;
    if (btn) { btn.disabled = false; btn.textContent = editing ? 'Save Changes' : 'Create Project'; }
  }
}

// ── Delete Project ────────────────────────────────────────────────────────────
function dpError(msg) {
  const el = document.getElementById('dp-error');
  if (!el) return;
  if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; }
}
function dpConfirmMsg(msg) {
  const el = document.getElementById('dp-confirm');
  if (!el) return;
  if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; }
}
let _dpConfirmId = null;
function resetDpButton() {
  _dpConfirmId = null;
  dpConfirmMsg('');
  const btn = document.getElementById('dp-delete');
  if (btn) { btn.disabled = false; btn.textContent = 'Delete Project'; btn.classList.remove('confirm'); }
}
async function populateDpSelect() {
  const sel = document.getElementById('dp-select');
  if (!sel) return;
  const path = workspacePath();
  if (!bridgeOnline() || !path) { sel.innerHTML = '<option value="">Backend offline</option>'; return; }
  try {
    const r = await bridgeCall('project.list', { path });
    const projects = (r && r.projects) || [];
    sel.innerHTML = '';
    if (!projects.length) { sel.innerHTML = '<option value="">No projects</option>'; return; }
    for (const p of projects) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name || p.id;
      sel.appendChild(o);
    }
  } catch { sel.innerHTML = '<option value="">Could not load</option>'; }
}
function openDeleteProjectModal() {
  dpError(''); resetDpButton();
  populateDpSelect();
  const ov = document.getElementById('delete-project-overlay');
  if (ov) ov.style.display = 'flex';
}
function closeDeleteProjectModal() {
  const ov = document.getElementById('delete-project-overlay');
  if (ov) ov.style.display = 'none';
  resetDpButton();
}
async function onDpDelete() {
  const sel = document.getElementById('dp-select');
  const id = sel?.value || '';
  if (!id) return;
  const name = sel.options[sel.selectedIndex]?.textContent || id;
  const btn = document.getElementById('dp-delete');
  // First click on a project → ask to confirm.
  if (_dpConfirmId !== id) {
    _dpConfirmId = id;
    dpError('');
    dpConfirmMsg(`Are you sure? Delete "${name}"? Its git history is kept.`);
    if (btn) { btn.textContent = 'Yes, delete'; btn.classList.add('confirm'); }
    return;
  }
  // Second click → delete for real.
  dpError('');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  try {
    const r = await bridgeCall('project.delete', { path: workspacePath(), id });
    if (!r || !r.ok) { dpError((r && r.error) || 'Delete failed.'); resetDpButton(); return; }
    removeMyProject(id);
    const m = loadProjectLastZones(); if (m[id]) { delete m[id]; localStorage.setItem(PROJECT_LASTZONE_KEY, JSON.stringify(m)); }
    closeDeleteProjectModal();   // dismiss on success (was: stay open with a "Deleted…" message)
    refreshProjectsList();       // the launcher behind it reflects the removal
    _deps.setStatus(`Deleted project "${r.name || name}" (recoverable from git history)`);
  } catch (e) {
    dpError((e && e.message) ? e.message : 'Delete failed.');
    resetDpButton();
  }
}

// ── Fallback: workspace missing → revert to first-run setup ──────────────────
export function revertToSetupGate(message) {
  // The configured workspace vanished — wipe config and behave like a fresh install.
  localStorage.removeItem(SETUP_DONE_KEY);
  localStorage.removeItem(WORKSPACE_PATH_KEY);
  setSetupCloning(false);                 // form visible, progress hidden
  showSetupGate(message);
}

// On boot, confirm the configured workspace folder still exists (the user may have
// deleted it). If it's gone, fall back to first-run setup.
export async function verifyWorkspaceOnBoot() {
  if (!workspaceConfigured()) return;
  const path = localStorage.getItem(WORKSPACE_PATH_KEY) || '';
  if (!path) return;                      // no recorded path (legacy) — nothing to verify
  if (!bridgeOnline()) {                  // wait for the socket, then verify once
    const off = onBridgeStatus((online) => { if (online) { off(); verifyWorkspaceOnBoot(); } });
    return;
  }
  try {
    const r = await bridgeCall('workspace.status', { path });
    if (r && !r.exists && !r.isRepo) revertToSetupGate('Your workspace folder is missing — set it up again.');
  } catch { /* bridge hiccup — leave the optimistic launcher up */ }
}

// ── DOM init ──────────────────────────────────────────────────────────────────
function initSetupGate() {
  const ov = document.getElementById('setup-overlay');
  if (!ov) return;
  const input = document.getElementById('setup-path');
  if (input && !input.value) input.value = 'C:/xi-zone-workspaces';
  // Bind once, regardless of gate state — so the gate still works if we later
  // fall back to it (e.g. the workspace folder was deleted out from under us).
  document.getElementById('setup-go')?.addEventListener('click', runWorkspaceSetup);
  document.getElementById('setup-skip')?.addEventListener('click', skipWorkspaceSetup);
  document.getElementById('setup-browse')?.addEventListener('click', browseWorkspaceFolder);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') runWorkspaceSetup(); });

  // Env setup form
  document.getElementById('env-setup-go')?.addEventListener('click', saveEnvSetup);
  document.querySelectorAll('[data-env-browse]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await browseEnvField(btn.dataset.envBrowse, btn.dataset.kind);
      validateEnvField(btn.dataset.envBrowse);
    });
  });
  document.querySelectorAll('[data-env-key]').forEach((inp) => {
    inp.addEventListener('input', () => scheduleValidateEnvField(inp.dataset.envKey));
    inp.addEventListener('change', () => validateEnvField(inp.dataset.envKey));
  });

  // Workspace setup only after XI Tools boot finishes (body.tools-booting hides this).
  // main.js also calls showSetupGate / maybeOpenEnvOrLauncher after boot — this is the
  // immediate paint if boot already finished by the time init runs.
  if (launcherState.setupGateActive && !document.body.classList.contains('tools-booting')) {
    showSetupGate();
  } else {
    ov.style.display = 'none';
  }
}

/**
 * Wire up the projects launcher + setup gate DOM events.
 *
 * @param {object} deps
 * @param {Function} deps.setStatus          - main.js setStatus(msg, isError?)
 * @param {Function} deps.getModeMenu        - () => HTMLElement — the mode dropdown node
 * @param {Function} deps.loadZone           - async (url) => void
 * @param {Function} deps.setMode            - async (mode) => void
 * @param {Function} deps.setActiveTab       - (tabId) => void
 * @param {Function} deps.loadProjectSettings  - async () => void
 * @param {Function} deps.applyProjectSettings - () => void
 * @param {Function} deps.refreshProjectZones  - async () => zones[]
 * @param {Function} deps.getMode            - () => string
 * @param {Function} deps.getZoneElValue     - () => string  (current value of the zone <select>)
 * @param {Function} deps.loadSetting        - (key, default) => value
 */
export function initProjectsLauncher(deps) {
  _deps = deps;

  initSetupGate();

  document.getElementById('projects-btn')?.addEventListener('click', openProjectsLauncher);   // topbar → launcher
  document.getElementById('projects-browse')?.addEventListener('click', enterBrowseMode);
  document.getElementById('projects-new-btn')?.addEventListener('click', openNewProjectModal);
  document.getElementById('np-create')?.addEventListener('click', submitProjectForm);
  document.getElementById('np-close')?.addEventListener('click', closeNewProjectModal);
  const nov = document.getElementById('new-project-overlay');
  nov?.addEventListener('click', (e) => { if (e.target === nov) closeNewProjectModal(); });
  document.getElementById('projects-back-btn')?.addEventListener('click', closeProjectsLauncher);
  document.getElementById('projects-delete-btn')?.addEventListener('click', openDeleteProjectModal);
  document.getElementById('dp-close')?.addEventListener('click', closeDeleteProjectModal);
  document.getElementById('dp-delete')?.addEventListener('click', onDpDelete);
  document.getElementById('dp-select')?.addEventListener('change', resetDpButton);
  const dov = document.getElementById('delete-project-overlay');
  dov?.addEventListener('click', (e) => { if (e.target === dov) closeDeleteProjectModal(); });
  document.getElementById('welcome-got-it')?.addEventListener('click', hideWelcome);
  document.getElementById('welcome-close')?.addEventListener('click', hideWelcome);
  const wov = document.getElementById('welcome-overlay');
  wov?.addEventListener('click', (e) => { if (e.target === wov) hideWelcome(); });
  // The boot version fetch + project list can race the socket — refresh once connected.
  onBridgeStatus((online) => { if (online) { fillLauncherVersion(); if (launcherState.launcherActive) refreshProjectsList(); } });

  // Dev helpers
  window.xiResetSetup = () => {
    localStorage.removeItem(SETUP_DONE_KEY);
    localStorage.removeItem(WORKSPACE_PATH_KEY);
    localStorage.removeItem(ENV_DONE_KEY);
    location.reload();
  };
  window.xiMarkAllProjectsMine = async () => {
    const path = workspacePath();
    if (!bridgeOnline() || !path) { console.warn('[xi] backend offline / no workspace — open the editor via `xi gui zone`'); return; }
    try {
      const r = await bridgeCall('project.list', { path });
      const ids = ((r && r.projects) || []).map((p) => p.id).filter(Boolean);
      ids.forEach(addMyProject);
      if (launcherState.launcherActive) refreshProjectsList();
      console.log(`[xi] marked ${ids.length} project(s) as "My Projects".`);
    } catch (e) { console.warn('[xi] migration failed:', e); }
  };
  window.xiClearMyProjects = () => { localStorage.removeItem(MY_PROJECTS_KEY); if (launcherState.launcherActive) refreshProjectsList(); console.log('[xi] cleared My Projects.'); };
}
