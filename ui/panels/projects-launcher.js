// ── Projects launcher + First-run workspace setup ────────────────────────────
// Extracted from main.js. Boot flow:
//   • No workspace configured → setup gate: clone the shared workspaces repo.
//   • Workspace configured     → Projects launcher: pick a category → editor.
//
// Deps are injected via initProjectsLauncher({ ... }) so this module stays
// independent of main.js scope while still driving the full boot / project UX.

import { bridgeCall, bridgeOnline, onBridgeStatus } from '../ffxi/bridge.js';
import { reopenWorkspaceSetup } from './setup-wizard.js';

// ── Workspace config keys ─────────────────────────────────────────────────────
// Setup completion lives in setup-wizard.js; the launcher only needs the folder.
const WORKSPACE_PATH_KEY  = 'xi.workspacePath';

// ── Mutable launcher state (exported as a live object so main.js can read by ref) ──
// Main.js reads: launcherState.currentProject, .browseOnly, .projectAwaitingZone,
//                .launcherActive
// Main.js writes: launcherState.projectAwaitingZone (set to false in onZoneLoaded)
export const launcherState = {
  currentProject:      null,     // active project (edit) or null (browse / none)
  browseOnly:          false,    // Browse Zones → read-only, View mode forced
  projectAwaitingZone: false,    // in a project but no zone picked yet → View until one loads
  launcherActive:      true,     // the launcher is the first screen after setup
  // Retained because core/zone-nav.js gates auto-load on it. Setup is now a separate
  // overlay that resolves before the launcher exists, so it is never true here.
  setupGateActive:     false,
};

// ── Injected deps (set by initProjectsLauncher) ───────────────────────────────
let _deps = null;

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

// The boot loader is dismissed by whoever opens the first real screen.
function hideAppLoader() {
  const el = document.getElementById('app-loader');
  if (el) el.classList.add('hidden');
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
  document.body.classList.remove('wiz-active');
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

// ── Fallback: workspace missing → back to the Setup panel ───────────────────
export async function revertToSetupGate(message) {
  // The configured workspace vanished — clear it and reopen the wizard's workspace
  // step so the user can point at a new folder without redoing the whole setup.
  localStorage.removeItem(WORKSPACE_PATH_KEY);
  const ov = document.getElementById('projects-overlay');
  if (ov) ov.style.display = 'none';
  launcherState.launcherActive = false;
  await reopenWorkspaceSetup(message);
  openProjectsLauncher();
}

// On boot, confirm the configured workspace folder still exists (the user may have
// deleted it). If it's gone, ask for a new one.
export async function verifyWorkspaceOnBoot() {
  const path = localStorage.getItem(WORKSPACE_PATH_KEY) || '';
  if (!path) return;                      // nothing recorded yet — nothing to verify
  if (!bridgeOnline()) {                  // wait for the socket, then verify once
    const off = onBridgeStatus((online) => { if (online) { off(); verifyWorkspaceOnBoot(); } });
    return;
  }
  try {
    const r = await bridgeCall('workspace.status', { path });
    if (r && !r.exists && !r.isRepo) revertToSetupGate('Your workspace folder is missing — choose it again.');
  } catch { /* bridge hiccup — leave the optimistic launcher up */ }
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

  // Dev helpers (xiResetSetup lives in setup-wizard.js — it owns the setup keys)
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
