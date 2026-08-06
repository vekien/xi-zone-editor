// settings.js — localStorage / project / zone settings helpers
// Extracted from main.js. Import these instead of duplicating.

import { bridgeOnline, onBridgeStatus, bridgeCall } from '../ffxi/bridge.js';
import { launcherState } from '../panels/projects-launcher.js';

export const STORAGE_PREFIX = 'xi.leveleditor.';
export const ZONE_SETTINGS_KEY = 'zone_settings';

// ── Global localStorage helpers ────────────────────────────────────────────
export function loadSetting(key, fallback) {
  const value = localStorage.getItem(STORAGE_PREFIX + key);
  if (value == null) return fallback;
  if (typeof fallback === 'boolean') return value === 'true';
  if (typeof fallback === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return value;
}
export function saveSetting(key, value) {
  localStorage.setItem(STORAGE_PREFIX + key, String(value));
}

// ── Project settings (per-project, saved to <project>/project_settings.json) ──
// A handful of settings are project-scoped, not global: the HD publish mode, the
// publish-reset flags, and a few viewport prefs that differ per map. They live in the
// open project's workspace folder (so they travel with the project), with the matching
// localStorage value kept as a cross-project default seed. Layering: project file wins,
// else the legacy/user localStorage value, else the hard default.
export let projectSettings = {};            // loaded from the backend when a project opens
export function loadProjectSetting(key, fallback) {
  const v = projectSettings[key];
  return (v === undefined || v === null) ? fallback : v;
}
let _projectSaveTimer = null;
export function saveProjectSetting(key, value) {
  projectSettings[key] = value;
  saveSetting(key, value);           // mirror to localStorage as the default seed for new projects
  if (typeof launcherState.currentProject === 'undefined' || !launcherState.currentProject || !bridgeOnline()) return;
  clearTimeout(_projectSaveTimer);
  _projectSaveTimer = setTimeout(() => {
    bridgeCall('project.saveSettings', { data: projectSettings }).catch(() => {});
  }, 300);
}
export async function loadProjectSettings() {
  projectSettings = {};
  if (!bridgeOnline()) return;
  try {
    const r = await bridgeCall('project.loadSettings', {});
    if (r && r.ok && r.settings && typeof r.settings === 'object') projectSettings = r.settings;
  } catch { /* bridge not ready — keep defaults */ }
}

// ── Zone settings (per-zone, stored in localStorage + mirrored to editor.json) ──
export function zoneSettingsKey(url) {
  return (url || '').replace(/^game\//, '');
}
export function loadZoneSettings() {
  try { return JSON.parse(localStorage.getItem(ZONE_SETTINGS_KEY) || '{}') || {}; }
  catch { return {}; }
}
export function saveZoneSetting(url, key, value) {
  const zoneKey = zoneSettingsKey(url);
  if (!zoneKey) return;
  const settings = loadZoneSettings();
  settings[zoneKey] = { ...(settings[zoneKey] || {}), [key]: value };
  localStorage.setItem(ZONE_SETTINGS_KEY, JSON.stringify(settings));
  persistEditorSettings();
}
export function loadZoneSetting(url, key) {
  return loadZoneSettings()[zoneSettingsKey(url)]?.[key];
}
// GLB source paths: per-zone map of { fileName → absPath } stored in editor.json (local machine
// only — the absolute path is user-specific and never goes into the shared zone-changes.json).
export function saveGlbSrcPath(zoneUrl, fileName, absPath) {
  const existing = loadZoneSetting(zoneUrl, 'glbSrc') || {};
  existing[fileName] = absPath;
  saveZoneSetting(zoneUrl, 'glbSrc', existing);
}
export function lookupGlbSrcPath(zoneUrl, fileName) {
  return (loadZoneSetting(zoneUrl, 'glbSrc') || {})[fileName] || null;
}
export function removeZoneSetting(url, key) {
  const zoneKey = zoneSettingsKey(url);
  if (!zoneKey) return;
  const settings = loadZoneSettings();
  if (!settings[zoneKey]) return;
  delete settings[zoneKey][key];
  if (Object.keys(settings[zoneKey]).length === 0) delete settings[zoneKey];
  localStorage.setItem(ZONE_SETTINGS_KEY, JSON.stringify(settings));
  persistEditorSettings();
}

// Per-zone view-state (locks, categorySets, visibility overrides) lives in localStorage
// as the live store, mirrored to a durable editor.json on the backend. The file is the
// portable copy; localStorage wins on conflict. Debounced so rapid edits collapse to one write.
let _editorSaveTimer = null;
export function persistEditorSettings() {
  if (!bridgeOnline()) return;
  clearTimeout(_editorSaveTimer);
  _editorSaveTimer = setTimeout(() => {
    bridgeCall('editor.saveSettings', { data: loadZoneSettings() }).catch(() => {});
  }, 400);
}
let _editorSettingsLoaded = false;
export async function loadEditorSettings() {
  if (_editorSettingsLoaded || !bridgeOnline()) return;
  try {
    const r = await bridgeCall('editor.loadSettings', {});
    if (r && r.ok && r.settings && typeof r.settings === 'object') {
      const local = loadZoneSettings();
      localStorage.setItem(ZONE_SETTINGS_KEY, JSON.stringify({ ...r.settings, ...local }));
      _editorSettingsLoaded = true;
    }
  } catch { /* bridge not ready — retried on the next status change */ }
}
onBridgeStatus((online) => { if (online) loadEditorSettings(); });
