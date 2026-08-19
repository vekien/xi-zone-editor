import { fmtDeg, fmtFourCC, vfxBaseName, hdUrlFor, newGroupId, newHotkeyId, clampSnapValue, formatSnapValue, trsMatrix, hashColor, fileToBase64, publishStats, isPublishCancel, makeLabelTexture, makeSymbolTexture } from './editor/utils.js';
import { STORAGE_PREFIX, ZONE_SETTINGS_KEY, projectSettings, loadSetting, saveSetting, loadProjectSetting, saveProjectSetting, loadProjectSettings, zoneSettingsKey, loadZoneSettings, saveZoneSetting, loadZoneSetting, removeZoneSetting, saveGlbSrcPath, lookupGlbSrcPath, persistEditorSettings, loadEditorSettings } from './editor/settings.js';
// xi level editor — reads an FFXI zone DAT directly in the browser (like xim)
// and renders it with three.js. No pre-baked .glb: ffxi/zone.js ports xi's
// Python parser/decryptor/texture-decoder to JS, so the DAT + FFXiMain.dll key
// tables are fetched and parsed client-side. Each 0x1C placement becomes a named
// node, so the scene graph maps 1:1 to the zone's object list — ideal for editing.

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { parseZone, extractKeyTables, resolveMeshName, resolveTexture, isSkyName } from './ffxi/zone.js';
import { parseEffects, describeSurface, describeEmitter, describePointLight, describeSound, decodeBlend, parseEnvironments } from './ffxi/effects.js';
import { initUndoRedo, pushCommand, undo, redo, clearHistory, updateHistoryButtons, enforceHistoryLimit } from './editor/undo-redo.js';
import { initFlyCamera, flyState, flySpeed, heldKeys, flyClock, WORLD_UP, FLY_SPEED_MIN, FLY_SPEED_MAX, flyUpdate, onFlyLook, endFlyLook, setFlySpeed, setFlyTarget, updateZoomSpeedUi, speedToSlider } from './viewport/fly-camera.js';
import { initLighting, LIGHT_UNIFORMS_GLSL, litRGB_GLSL, applyFog_GLSL, BIAS, NO_BIAS, TH, ambientToColor, diffuseToColor, sunDirDisplay, applyDayColors, applyEnvironment } from './viewport/lighting.js';
import { connectBridge, bridgeOnline, onBridgeStatus, bridgeCall, bridgeCancel, setBridgeUrl, bridgeHttpUrl, exportsUrl, BRIDGE_HTTP_BASE } from './ffxi/bridge.js';
import { runSetupWizard, initSetupSettings } from './panels/setup-wizard.js';

/** Resolves when the Setup panel is done: xi-tools is up (or the user went offline),
 *  and on a fresh install the remaining setup steps have been completed.
 *  Prefer the promise started by the early boot script in index.html so the download
 *  is already underway by the time this (heavy) module finishes loading. */
export const toolsBootPromise = (window.__toolsBootPromise || runSetupWizard()).catch((e) => {
  console.warn('[setup]', e);
  document.body.classList.remove('wiz-active');
  const ov = document.getElementById('wizard-overlay');
  if (ov) ov.style.display = 'none';
  connectBridge();
  return { online: false };
});

import { initDatabaseViewer } from './panels/database-viewer.js';
import { initVersionHistory, openVersionHistory, renderVersionList, restoreVersion, clearVersionHistory, viewVersionLog, viewVersionChanges } from './editor/version-history.js';
import { openConsole, closeConsole } from './editor/backend-log.js';
import { initTooltips } from './core/tooltips.js';
// Faithful FFXI particle engine (ported from the standalone particle editor) — drives
// cutscene VFX + zone effects. parseAllEffects reads a scene-resource DAT.
import {
  initCutscene, initCutsceneScene, initCsLetterbox,
  csCamera, cutsceneCamActive,
  CS_BEAT_META, CS_LANE_ORDER, CS_LANE_LABEL, CS_LANE_OF, csLaneOf,
  csBeatDetail, csBeatSpan,
  csCloseSequencer, csStop,
  csClearActors,
  getCsActors, getCsActorOutline, getCsSelectedActor,
  csToggleActorSelection, csClearActorSelection,
  getCsLetterbox, getCsVfxSystem,
  csUpdateLetterbox, cameraAspectUpdate, csRenderTick, csGetCinematicViewport,
  csInitCameraDeps, csGetAuthorCamRig, csIsCameraPiloting,
  csPositionKeyframeOpen, csAssignMarkerToOpenPositionKf, csOpenPositionKfHasMarker,
  csRefreshOpenKeyframe,
  csRenderCameraPreview,
} from './viewport/cutscene.js';
import {
  initAutoSave, applyAutoSaveMode, scheduleAutoSave, doAutoSave,
} from './editor/auto-save.js';
import { initSfxPlayback, playSound, stopSound, updateSfxPlayUI, isSfxStoppable } from './panels/sfx-playback.js';
import {
  initMarkers, resetMarkerGroup,
  getMarkerGroup, setMarkerGroup,
  MARKER_SCALE, getMarkerTexture, addMarker, addMarkerFromRec,
  addCsMarker, getPinTexture,
  collectMarkerChanges, updateMarkerDetailsPanel as _updateMarkerDetailsPanelImpl,
  setMarkerVisibility as _setMarkerVisibilityImpl,
  pinMarkerToFloor,
} from './objects/markers.js';
import {
  initCopyPaste,
  copySelected, clipboardSummary, pasteFromClipboard, pasteCrossZone,
} from './editor/copy-paste.js';
import {
  initTextPlanes, TEXTPLANE_DEFAULTS, addTextPlane, addTextPlaneFromRec, collectTextPlanes,
  setTextVisibility, rebuildTextBakes, updateTextPlaneDetailsPanel,
  buildTextPlaneNode, buildTextPlaneMesh, buildTextPlaneGlb, renderTextPlaneCanvas,
  regenerateTextPlane, tpText,
} from './objects/text-planes.js';
import {
  initProjectsLauncher, launcherState, openProjectsLauncher,
  workspacePath, projectRoot, getProjectLastZone, setProjectLastZone,
  getPackageSelection, setPackageSelection, revertToSetupGate, verifyWorkspaceOnBoot,
} from './panels/projects-launcher.js';
import {
  initChangesTracker, deletedEntries, addedEntries, changeSeq,
  lastSavedSig, lastSavedHadContent, setLastSavedSig, _changeSig, markSaved,
  markChange, trsChanged, getChanges, collectChanges, hasUnsavedChanges,
  snapshotChanges, snapshotHasContent, dedupePlacementAdds, loadChangesFromJson,
} from './editor/changes-tracker.js';
import {
  initSubAreas, resetSubAreaState, setStripInteractions,
  subAreaGroup, subAreaState, subAreaPlaceholders, stripInteractions,
  loadSubAreas, setSubAreaVisible, setAllSubAreas,
  stripActive, syncStripVisual, toggleStripInteractions,
} from './objects/subarea.js';
import {
  initAssetBrowser,
  cbLoad, cbRender, cbReRender, cbFavList, cbCurrent, cbPopulateZoneFilter,
  loadMusicCatalog, mcRender, mcUnload, mcPlay, mcStop,
  loadSfxCatalog, sfxcRender, sfxcStop,
  loadMobCatalog, mobcRender, buildMobNode, dropMobOnViewport,
  dropSoundOnViewport,
  cbEsc,
  showSfxCategory, showMusicCategory,
} from './panels/asset-browser.js';
import {
  initCollisionUI,
  addCollisionPrimitive, buildCollisionPrimFromRec, createCollisionFromMesh,
  bakeCollisionPrimTris, setCollisionMat, defaultCollisionMat,
  getCollisionGroup, setCollisionGroup, getCollisionMaterial, setCollisionMaterial,
  getCollisionPrimGroup, setCollisionPrimGroup, getCollisionPrimMaterials,
  _rebuildCollisionPrimGeo, COLLISION_TERRAIN_RGB,
} from './objects/collision-ui.js';
import {
  initPublishMode, setMode, getMode, getEditMode, isCleanMode,
  applyModeUI, syncViewFrame, closeModeMenu,
  getModeReplayPending, setModeReplayPending,
  getModeFetchedZone, setModeFetchedZone,
  getSuppressStateFetch, setSuppressStateFetch,
  setActiveVersionLabel,
  modeBtn, modeMenu, viewFrameEl,
} from './editor/publish-mode.js';
import {
  initZoneMusic, initZoneMusicModalListeners, initMusicContextMenuListeners,
  ensureZoneMusic, renderZoneMusic, musicSlotId, onMusicSlotChange, revertMusicChange,
  bgmPlayResume, applyBgmVolume, updateBgmVolIcon, bgmEnsureAudio, playMusicId,
  bgmPause, bgmStop, unloadBgm, updateBgmProgress, updateBgmUI,
  loadAllMusic, refreshZoneMusic, setZoneMusicSlot, openZoneMusicModal,
  showMusicContextMenu, hideMusicContextMenu,
  bgmFmtTime, getBgmAudio,
  setMusicChanges, clearZoneBgmKey,
  musicChanges, musicBaseline, _MUSIC_SLOT_NAME,
} from './panels/zone-music.js';
import {
  initEventsPanel, evtEsc, eventsCutscene,
  invalidateEvents, ensureEventsLoaded,
  openEventDialog, showDialogView, closeEventDialog,
  fetchEventCutscene, renderCutsceneView,
} from './panels/events-panel.js';
import { initCutsceneAuthor, openCutsceneAuthorFrom, resumeAuthor } from './panels/cutscene-author.js';
import {
  initSelection,
  select, lastSelectedEntry, snapshotTRS, reselectAfterEdit, pushSelectionTransformCommand,
  updateSelectionReadout, updateSelectionOutline, updateHoverOutline, updateNormalIndicator,
  updateCollisionArrows, frameScene, clearSelectionOutline, rebuildSelectionOutline,
  selectRange, saveCurrentZoneCamera, restoreZoneCamera,
  onPointerDown, onPointerMovePick, onPointerUp,
  wireNameInput, wireTrsInputs, wireTrsContextMenus, refreshTrsInputs, resetTransform,
  updateDeleteBtn, clearOutline, rebuildOutline, updateOutline, addOutline,
  getSelectionOutline, getHoverOutline, getSelectionOutlineMat, getHoverOutlineMat, getHoverOutlineHullMat,
  rebuildHoverOutline,
} from './core/selection.js';
import {
  initZoneNav, goToZone, setActiveTab, tabForEntry, populateZones, refreshCustomZones,
  renderPinnedZones, updateZoneInfo, updateWindowTitle, populateWeather, fmtTime,
  loadPinnedZones, savePinnedZones, isZonePinned, zoneNameForPath, pinZone, unpinZone,
  removeZoneFromProject, refreshProjectZones, updateZoneSearch, loadZoneSettingsPanel,
} from './core/zone-nav.js';
import {
  initGlbImport, buildGlbNode, importGlbModel, importGlbViaPicker, refreshGlbModel,
  loadGlbWrap, disposeSubtree, inFrontOfCamera, uniquePlacementName, updateGlbDetailsPanel,
  commitPastedItems, buildSourceEffectPreviewNode, glbOriginOf, applyGlbPreview,
  newXiId, newUid, xiName, lightGlbRef, importMeshName, gltfLoader,
  linkGlbOrigin, pastedEffectName, effectSourcePrefix, pickGlbSource,
  glbWorkspaceKey, glbFilePathOf,
} from './core/glb-import.js';
import {
  initObjectList, buildObjectList, openContextMenu, hideRowContextMenu,
  renderHotkeyBar, restoreGroups, restoreCategories, restoreHotkeys,
  restoreVisibilityOverrides, restoreLockOverrides, groupForPlacement, kindOf,
  spawnHotkey, setListedVisibility, setMarkerVisibility, setMobVisibility,
  setSkyVisible, applyWorkspaceViewState, buildViewportContextMenu, getRenderedLists,
  defaultVisibilityFor, visibilityKeyFor, setVisibilityOverride, placementsInGroup,
  autoGroupXiEffects, saveManageGroups, setsHaveState, applyCategoryModal, groundPointAhead,
} from './core/object-list.js';
import {
  initPlayerMarker, refreshPlayerMarker, playerSpawnInfo, spawnWarningMessage, updateSpawnWarning,
  syncFootstepSourceUI, updateMarkerDetailsPanel, updateSoundDetailsPanel,
  updateCollisionDetailsPanel, writeMobSpawns, populateFootstepSourceZones,
} from './core/player-marker.js';
import {
  initZoneEffects, buildRuntimeZoneEffects, buildPlainVfxMeshes, buildSurfaceEffects,
  clearZoneVfxSystem, updateEmittedEffects, addVfxIcon, pickIcon,
  setIconVisible, iconVisible, registerPlacement, addXZoneEffect, applyDisableVfx,
  isLegacyZoneEnvMesh, vfxIconDistFactor, VFX_ICON_MIN, VFX_ICON_FADE_MIN, addPointLightEffect,
  makeParticleMaterial, tuneSurfaceForEditor, makeSpriteTemplate, addParticleMeshes,
  makeParticleInstance, addEmittedEffect, addPlainVfxMesh, addSoundEmitters,
  vfxIconScale, buildXZoneEffectNode, getZoneVfxSystem,
} from './core/zone-effects.js';

const canvas = document.getElementById('view');
const statusEl = document.getElementById('status');
const camValEl = document.getElementById('cam-val');
const fpsEl = document.getElementById('fps-val');
const selectionEl = document.getElementById('selection');
const transformEl = document.getElementById('selection-transform');
const selPanel = document.getElementById('sel-panel');
function _syncSelectionModal(hasSelection) {
  selPanel?.classList.toggle('open', !!hasSelection);
}
const objlistEl = document.getElementById('objlist');
const objcountEl = document.getElementById('objcount');
const vfxlistEl = document.getElementById('vfxlist');
const vfxcountEl = document.getElementById('vfxcount');
const soundlistEl = document.getElementById('soundlist');
const soundcountEl = document.getElementById('soundcount');
const footstepSourceZoneEl = document.getElementById('footstep-source-zone');
const markerlistEl = document.getElementById('markerlist');
const markercountEl = document.getElementById('markercount');
const textlistEl = document.getElementById('textlist');
const textcountEl = document.getElementById('textcount');
const textbakedlistEl = document.getElementById('textbakedlist');
const textbakedcountEl = document.getElementById('textbakedcount');
const textFilterEl = document.getElementById('text-filter');
const skylistEl = document.getElementById('skylist');
const skycountEl = document.getElementById('skycount');
const moblistEl   = document.getElementById('moblist');
const mobcountEl  = document.getElementById('mobcount');
const mobFilterEl = document.getElementById('mob-filter');
const colslistEl  = document.getElementById('colslist');
const colscountEl = document.getElementById('colscount');
const colsFilterEl = document.getElementById('cols-filter');
const markerDetailsPanel = document.getElementById('marker-details');
const soundDetailsPanel = document.getElementById('sound-details');
const sdetId = document.getElementById('sdet-id');
const sdetRepeat = document.getElementById('sdet-repeat');
const sdetPlay = document.getElementById('sdet-play');
const sdetNote = document.getElementById('sdet-note');
const mdetType = document.getElementById('mdet-type');
const mdetName = document.getElementById('mdet-name');
const mdetIcon = document.getElementById('mdet-icon');
const mdetColor = document.getElementById('mdet-color');
const mdetDesc = document.getElementById('mdet-desc');
const mdetCsIcon = document.getElementById('mdet-cs-icon');
const glbDetailsPanel = document.getElementById('glb-details');
const glbShade = document.getElementById('glb-shade');
const glbShadeVal = document.getElementById('glb-shade-val');
const glbShadeRow = document.getElementById('glb-shade-row');
const glbLit = document.getElementById('glb-lit');
const glbOpaque = document.getElementById('glb-opaque');
const glbTwoSided = document.getElementById('glb-two-sided');
const glbUuid = document.getElementById('glb-uuid');
const glbUuidRow = document.getElementById('glb-uuid-row');
const glbName = document.getElementById('glb-name');
const glbFile = document.getElementById('glb-file');
const glbOrigin = document.getElementById('glb-origin');
const glbAdded = document.getElementById('glb-added');
const glbLinkOriginBtn = document.getElementById('glb-link-origin');
// textPlanePanel, tpText, tpSize, tpSizeVal, tpColor, tpPanel — moved to text-planes.js
if (glbUuid) glbUuid.addEventListener('click', () => {
  const id = glbUuid.textContent || '';
  if (id && id !== '—') { navigator.clipboard?.writeText(id); setStatus(`copied id ${id}`); }
});
if (glbFile) glbFile.addEventListener('click', () => {
  const v = glbFile.dataset.path || glbFile.textContent || '';
  if (v && v !== '—') { navigator.clipboard?.writeText(v); setStatus(`copied ${v}`); }
});
if (glbOrigin) glbOrigin.addEventListener('click', () => {
  const src = glbOrigin.dataset.path || '';
  if (src) { navigator.clipboard?.writeText(src); setStatus(`copied path ${src}`); }
});
if (glbLinkOriginBtn) glbLinkOriginBtn.addEventListener('click', linkGlbOrigin);
const collisionDetailsPanel = document.getElementById('collision-details');
const cdetBlockCamera = document.getElementById('cdet-block-camera');
const cdetTerrain = document.getElementById('cdet-terrain');
const cdetSegsRow = document.getElementById('cdet-segs-row');
const cdetSegX = document.getElementById('cdet-seg-x');
const cdetSegY = document.getElementById('cdet-seg-y');
const cdetSegZ = document.getElementById('cdet-seg-z');
const cdetSegXLabel = document.getElementById('cdet-seg-x-label');
const cdetSegXText  = document.getElementById('cdet-seg-x-text');
const cdetSegYLabel = document.getElementById('cdet-seg-y-label');
const cdetSegZLabel = document.getElementById('cdet-seg-z-label');
const filterEl = document.getElementById('filter');
const vfxFilterEl = document.getElementById('vfx-filter');
const soundFilterEl = document.getElementById('sound-filter');
const markerFilterEl = document.getElementById('marker-filter');
const skyFilterEl = document.getElementById('sky-filter');
let CACHE_BUST = Date.now();   // mutable: bump to force a fresh DAT fetch after a disk-side rewrite (Reset)
// bridgeHttpUrl / exportsUrl imported from ffxi/bridge.js — serve game + exports
// over http://127.0.0.1:8777 when the desktop bridge is up.
function gameAssetUrl(relPath) { return bridgeHttpUrl(relPath); }
function datUrl(url, baseDat = false) {
  const path = baseDat ? `${url}.base` : url;
  return `${bridgeHttpUrl(path)}?_=${CACHE_BUST}`;
}
function invalidateKeyTables() { keyTablesPromise = null; }
window.invalidateKeyTables = invalidateKeyTables;
window.bridgeHttpUrl = bridgeHttpUrl;
window.exportsUrl = exportsUrl;


// Pull the active project's settings into the live vars + reflect them in the Settings UI.
// Called after a project's settings load (project open). Render-affecting values (sky,
// disableVfx) are re-read by the subsequent zone (re)build; this primes the state + controls.
function applyProjectSettings() {
  disableVfx            = loadProjectSetting('disableVfx', disableVfx);
  showSkybox            = loadProjectSetting('skybox', showSkybox);
  skyboxScaled          = loadProjectSetting('skyboxScaled', skyboxScaled);
  publishReset          = loadProjectSetting('publishReset', publishReset);
  hdPublishMode         = loadProjectSetting('hdPublishMode', hdPublishMode);
  clearCollisionOnReset = loadProjectSetting('clearCollisionOnReset', clearCollisionOnReset);
  syncProjectSettingsUI();
}
function syncProjectSettingsUI() {
  const check = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
  check('toggle-disable-vfx', disableVfx);
  check('toggle-disable-vfx-pane', disableVfx);
  check('toggle-sky', showSkybox);
  check('toggle-sky-scaled', skyboxScaled);
  check('toggle-publish-reset', publishReset);
  check('toggle-clear-collision', clearCollisionOnReset);
  const hdSel = document.getElementById('hd-publish-mode');
  if (hdSel) hdSel.value = hdPublishMode;
  if (typeof updateHdPublishModeHint === 'function') updateHdPublishModeHint();
}

// ── renderer / scene / camera ───────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// Default viewport backdrop — flat dark gray. Settings → bgColor overrides.
const DEFAULT_BG = 0x151515;
let customBgColor = loadSetting('bgColor', '');  // '' = default gray
function applyBackdrop() {
  scene.background = new THREE.Color(customBgColor || DEFAULT_BG);
}
applyBackdrop();

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 20000);
camera.position.set(40, 30, 40);
initFlyCamera({ camera, canvas, camValEl, loadSetting, saveSetting });

// csCamera and cutsceneCamActive are imported from cutscene.js

// Stable per-zone movement scale (set in frameScene()/focusSelected()). Scroll speed is
// based on this so it stays consistent regardless of where the camera is.
let navScale = 100;
const camTarget = new THREE.Vector3(); // a point ahead of the camera, for frame/focus aiming

// Move/Rotate/Scale gizmo for the selected placement. Keep the selection readout live as
// the transform changes, and record one undo entry per drag.
const transform = new TransformControls(camera, canvas);
// In 16:9 (Fixed Ratio) the camera renders into a sub-rect, so TransformControls' own
// pointer→NDC (which uses the whole canvas) misses the gizmo — making it near-impossible to
// grab. r169 binds `_getPointer` per-instance, so wrap it to remap into the cinematic rect.
if (typeof transform._getPointer === 'function') {
  const _tcGetPointer = transform._getPointer.bind(transform);   // bind in case it's a prototype method
  transform._getPointer = (event) => {
    const p = _tcGetPointer(event);
    const cine = (typeof csGetCinematicViewport === 'function') ? csGetCinematicViewport() : null;
    if (cine && cine.w > 0 && !document.pointerLockElement) {
      const n = clientToNdc(event.clientX, event.clientY);
      p.x = n.x; p.y = n.y;
    }
    return p;
  };
}
const mirroredRotationDelta = new THREE.Quaternion();
const mirroredRotationStartInv = new THREE.Quaternion();
function removeNegativeTranslateArrows() {
  const gizmo = transform._gizmo?.gizmo?.translate;
  if (!gizmo) return;
  const axisIndex = { X: 0, Y: 1, Z: 2 };
  for (const child of [...gizmo.children]) {
    const i = axisIndex[child.name];
    if (i == null || !child.isMesh || !child.geometry) continue;
    child.geometry.computeBoundingBox();
    const box = child.geometry.boundingBox;
    const center = (box.min.getComponent(i) + box.max.getComponent(i)) * 0.5;
    if (center < -0.1) gizmo.remove(child);
  }
}
removeNegativeTranslateArrows();
// Scale gizmo: keep X/Y/Z axis-line handles plus XY/YZ/XZ corner planes. Drop the
// centre uniform cube (XYZ) and floating negative-end handles.
function trimScaleHandles() {
  const axisIndex = { X: 0, Y: 1, Z: 2 };
  const planeHandles = new Set(['XY', 'YZ', 'XZ']);
  for (const part of ['gizmo', 'picker']) {
    const grp = transform._gizmo?.[part]?.scale;
    if (!grp) continue;
    for (const child of [...grp.children]) {
      const ai = axisIndex[child.name];
      if (planeHandles.has(child.name)) continue;
      if (ai == null) { grp.remove(child); continue; }          // uniform (XYZ)
      if (!child.geometry) continue;
      child.geometry.computeBoundingBox();
      const box = child.geometry.boundingBox;
      const center = (box.min.getComponent(ai) + box.max.getComponent(ai)) * 0.5;
      if (center < -0.1) grp.remove(child); // floating negative-end handle/picker
    }
  }
}
trimScaleHandles();
function fixMirroredRotation() {
  // The root scale(-1,1,-1) combined with Rx(180°) gives a net transform of Rz(180°) —
  // det = +1, a pure rotation with no reflection.  TransformControls world-space rotation
  // gizmos therefore need no delta inversion on any axis.  (The old scale(1,1,-1) had
  // det = -1 and required Y/Z correction; that is no longer the case.)
  return;
}
let dragSnapshot = null; // {node, p, q, s} captured at the start of a gizmo drag
let dragSelectionSnapshots = null;
function uniformScaleRatio() {
  if (!dragSnapshot || !transform.object) return 1;
  const axis = transform.axis;
  if (axis === 'X' && dragSnapshot.s.x) return transform.object.scale.x / dragSnapshot.s.x;
  if (axis === 'Y' && dragSnapshot.s.y) return transform.object.scale.y / dragSnapshot.s.y;
  if (axis === 'Z' && dragSnapshot.s.z) return transform.object.scale.z / dragSnapshot.s.z;
  const ratios = [
    dragSnapshot.s.x ? transform.object.scale.x / dragSnapshot.s.x : 1,
    dragSnapshot.s.y ? transform.object.scale.y / dragSnapshot.s.y : 1,
    dragSnapshot.s.z ? transform.object.scale.z / dragSnapshot.s.z : 1,
  ];
  return ratios.reduce((best, r) => Math.abs(r - 1) > Math.abs(best - 1) ? r : best, 1);
}
function enforceUniformScale() {
  if (!scaleUniform || transform.mode !== 'scale' || !dragSnapshot || transform.object !== dragSnapshot.node) return;
  if (selected?.isCollisionPrimitive) return;   // collision prims need independent axis scaling
  const ratio = uniformScaleRatio();
  transform.object.scale.copy(dragSnapshot.s).multiplyScalar(ratio);
}
function applyMultiSelectionDrag() {
  if (!dragSelectionSnapshots || dragSelectionSnapshots.length < 2 || !dragSnapshot || !transform.object) return;
  const active = transform.object;
  const pivotBefore = dragSnapshot.p;
  const pivotNow = active.position;
  if (transform.mode === 'translate') {
    const delta = active.position.clone().sub(pivotBefore);
    for (const snap of dragSelectionSnapshots) {
      if (snap.node === active) continue;
      snap.node.position.copy(snap.p).add(delta);
      snap.node.updateMatrix();
    }
  } else if (transform.mode === 'rotate') {
    const deltaQ = active.quaternion.clone().multiply(dragSnapshot.q.clone().invert());
    for (const snap of dragSelectionSnapshots) {
      if (snap.node === active) continue;
      const offset = snap.p.clone().sub(pivotBefore).applyQuaternion(deltaQ);
      snap.node.position.copy(pivotNow).add(offset);
      snap.node.quaternion.copy(deltaQ).multiply(snap.q);
      snap.node.updateMatrix();
    }
  } else if (transform.mode === 'scale') {
    const ratio = new THREE.Vector3(
      dragSnapshot.s.x ? active.scale.x / dragSnapshot.s.x : 1,
      dragSnapshot.s.y ? active.scale.y / dragSnapshot.s.y : 1,
      dragSnapshot.s.z ? active.scale.z / dragSnapshot.s.z : 1,
    );
    for (const snap of dragSelectionSnapshots) {
      if (snap.node === active) continue;
      const offset = snap.p.clone().sub(pivotBefore).multiply(ratio);
      snap.node.position.copy(pivotNow).add(offset);
      snap.node.scale.copy(snap.s).multiply(ratio);
      snap.node.updateMatrix();
    }
  }
}
// ── live transform HUD ───────────────────────────────────────────────────────
// While a gizmo drag is in progress, float a small readout by the gizmo showing how
// far the active object has moved THIS drag: rotation in degrees (so a 15°/30° snap is
// obvious at a glance), translation distance, or scale factor. TransformControls keeps
// the running rotation in `transform.rotationAngle` (signed radians, already rounded to
// the rotate-snap increment when snapping is active), so we just read and format it.
const transformHud = document.getElementById('transform-hud');
const _hudPos = new THREE.Vector3();

function updateTransformHud() {
  if (!transformHud) return;
  const obj = transform.object;
  if (!dragSnapshot || !obj) { transformHud.hidden = true; return; }
  const axis = transform.axis || '';
  const axisCls = axis === 'X' ? 'x' : axis === 'Y' ? 'y' : axis === 'Z' ? 'z' : '';
  let html = '';
  if (transform.mode === 'rotate') {
    const deg = THREE.MathUtils.radToDeg(transform.rotationAngle || 0);
    const lbl = (!axis || axis === 'E' || axis === 'XYZE') ? 'screen' : axis;
    const sign = deg <= -0.05 ? '−' : deg >= 0.05 ? '+' : '';
    const snapActive = rotateSnap > 0 && (!snapOnShift || shiftHeld);
    html = `<span class="axis ${axisCls}">${lbl}</span>` +
           `<span class="val">${sign}${fmtDeg(deg)}°</span>` +
           (snapActive ? `<span class="snap-tag">⊞ ${rotateSnap}°</span>` : '');
  } else if (transform.mode === 'translate') {
    const dist = obj.position.distanceTo(dragSnapshot.p);
    html = `<span class="axis ${axisCls}">${axis.length === 1 ? axis : 'move'}</span>` +
           `<span class="val">${dist.toFixed(2)}</span>`;
  } else if (transform.mode === 'scale') {
    html = `<span class="axis ${axisCls}">${axis.length === 1 ? axis : 'scale'}</span>` +
           `<span class="val">×${uniformScaleRatio().toFixed(3)}</span>`;
  }
  transformHud.innerHTML = html;
  // Anchor above the gizmo: project the object's world position to screen space.
  obj.getWorldPosition(_hudPos).project(camera);
  if (_hudPos.z > 1) { transformHud.hidden = true; return; }   // gizmo behind the camera
  const r = canvas.getBoundingClientRect();
  transformHud.style.left = `${Math.round(r.left + (_hudPos.x * 0.5 + 0.5) * r.width)}px`;
  transformHud.style.top  = `${Math.round(r.top + (-_hudPos.y * 0.5 + 0.5) * r.height)}px`;
  transformHud.hidden = false;
}

transform.addEventListener('dragging-changed', (e) => {
  // Cutscene author camera: the gizmo moves the rig directly (csRenderTick mirrors
  // it into the render camera). It's not a placement — skip all the undo/markChange
  // machinery, and hide the readout when the drag ends.
  if (csGetAuthorCamRig && transform.object === csGetAuthorCamRig()) {
    if (!e.value && transformHud) transformHud.hidden = true;
    return;
  }
  if (e.value) {
    if (selected) {
      dragSnapshot = snapshotTRS(selected.node);
      dragSelectionSnapshots = [...selectedSet].filter((p) => !isLocked(p)).map((p) => snapshotTRS(p.node));
    }
  } else if (dragSnapshot) {
    const before = dragSelectionSnapshots || [dragSnapshot];
    const after = before.map((s) => snapshotTRS(s.node));
    const moved = after.some((t, i) => !t.node.position.equals(before[i].p) || !t.node.quaternion.equals(before[i].q) || !t.node.scale.equals(before[i].s));
    if (moved) pushSelectionTransformCommand(before, after); // one history entry per drag
    dragSnapshot = null;
    dragSelectionSnapshots = null;
  }
  if (!e.value && transformHud) transformHud.hidden = true;   // drag ended → drop the readout
  if (!e.value && transform.mode === 'scale') {              // rebuild collision geo for new scale
    const targets = selectedSet.size ? [...selectedSet] : selected ? [selected] : [];
    targets.forEach((entry) => {
      if (entry?.isCollisionPrimitive && (entry.collisionType === 'box' || entry.collisionType === 'plane')) {
        entry.subdivSegs = _collisionPrimSegs(entry.collisionType, entry.node.scale);
      }
      _rebuildCollisionPrimGeo(entry);
    });
  }
});
transform.addEventListener('objectChange', () => {
  if (csGetAuthorCamRig && transform.object === csGetAuthorCamRig()) { updateTransformHud(); return; }
  fixMirroredRotation(); enforceUniformScale(); applyMultiSelectionDrag(); updateSelectionReadout(); updateSelectionOutline(); updateTransformHud();
});
scene.add(transform.getHelper ? transform.getHelper() : transform);

// Kill the translate gizmo's "helper" guide lines — the full-length axis line + start/end
// ticks that stretch across the scene while dragging Move. The gizmo re-toggles each child's
// .visible every frame but never touches geometry, so pointing them at an empty geometry
// makes them render nothing for good. (rotate/scale helpers are left intact.) We swap the
// reference rather than dispose() — these geometries may be shared with visible handles.
const EMPTY_GIZMO_GEO = new THREE.BufferGeometry();
transform._gizmo?.helper?.translate?.traverse((child) => {
  if (child.geometry) child.geometry = EMPTY_GIZMO_GEO;
});

const grid = new THREE.GridHelper(2000, 200, 0x444455, 0x2a2a33);
scene.add(grid);
grid.visible = loadSetting('grid', false);

let wireframe = loadSetting('wireframe', false);
let wireColor = loadSetting('wireColor', '#000000');
const _wireframeMat = new THREE.LineBasicMaterial({ color: wireColor, opacity: 0.6, transparent: true });
function _edgeOverlay(mesh, key, flag, mat) {
  if (!mesh.userData[key]) {
    const w = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 1), mat);
    w.name = `${mesh.name || 'mesh'}:${key}`;
    w.userData[flag] = true;
    w.raycast = () => {};
    mesh.add(w);
    mesh.userData[key] = w;
  }
  return mesh.userData[key];
}
function applyWireframe() {
  if (!zoneRoot) return;
  zoneRoot.traverse((o) => {
    if (o.userData?.isWireOverlay) return;
    if (o.isMesh && o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) mat.wireframe = false;
    }
    if (!o.isMesh || !o.geometry) return;
    if (wireframe || o.userData.wireOverlay) _edgeOverlay(o, 'wireOverlay', 'isWireOverlay', _wireframeMat).visible = wireframe;
  });
}

// ── world-origin axis gizmo ──
let originGizmo;
{
  const axisLen = 20, axisR = 0.15;
  const axes = [
    { dir: new THREE.Vector3(1, 0, 0), color: 0xff2222 },
    { dir: new THREE.Vector3(0, 1, 0), color: 0x22ff22 },
    { dir: new THREE.Vector3(0, 0, 1), color: 0x2255ff },
  ];
  originGizmo = new THREE.Group();
  for (const { dir, color } of axes) {
    const geo = new THREE.CylinderGeometry(axisR, axisR, axisLen, 8);
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
    const mesh = new THREE.Mesh(geo, mat);
    // cylinder is Y-up by default; rotate so it points along dir
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    mesh.position.copy(dir.clone().multiplyScalar(axisLen / 2));
    mesh.renderOrder = 999;
    originGizmo.add(mesh);
    // arrowhead
    const coneGeo = new THREE.ConeGeometry(axisR * 2.5, axisR * 8, 8);
    const cone = new THREE.Mesh(coneGeo, mat);
    cone.quaternion.copy(mesh.quaternion);
    cone.position.copy(dir.clone().multiplyScalar(axisLen + axisR * 4));
    cone.renderOrder = 999;
    originGizmo.add(cone);
  }
  // center sphere
  const sphereGeo = new THREE.SphereGeometry(axisR * 2, 8, 8);
  const sphereMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
  const sphere = new THREE.Mesh(sphereGeo, sphereMat);
  sphere.renderOrder = 999;
  originGizmo.add(sphere);
  originGizmo.visible = loadSetting('mapCenter', false);
  scene.add(originGizmo);
}

// ── fly camera (the only camera): WASD move, Q/E down/up, drag to look, scroll forward ──
// Extracted to fly-camera.js; initFlyCamera() is called after camera/canvas are defined.
// flyState.flyLooking / flyState.rightLookMoved are the shared mutable flags used below.

// Drag (left or right) to look around. A left-button press that doesn't move is a click →
// selection (handled in onPointerUp). Right-click always looks around — even over a gizmo
// handle (the gizmo only drags on left-click). Left-click is suppressed over a gizmo axis
// so the press grabs the handle instead of starting a look.
// rightDownX/Y/Time are used by showViewportContextMenu and the fly-look tracker.
// (downX/Y/Time, onGizmo, lastHoverPick are owned by core/selection.js onPointerDown/Move.)
let rightDownX = 0, rightDownY = 0, rightDownTime = 0;
// Capture-phase so it runs BEFORE the object context menu: while a Position keyframe
// is open in the cutscene sequencer, a viewport right-click offers "Add Position Marker".
canvas.addEventListener('contextmenu', maybeAddPositionMarkerMenu, true);
canvas.addEventListener('contextmenu', showViewportContextMenu);

// Pointer (client px) → NDC, honouring the 16:9 cinematic sub-rect when Fixed Ratio is on
// (the camera renders INTO that rect, so NDC must map to it, not the whole canvas). Shared by
// the surface raycast, object selection, and the gizmo so all three agree in every mode.
function clientToNdc(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const cine = (typeof csGetCinematicViewport === 'function') ? csGetCinematicViewport() : null;
  if (cine && cine.w > 0 && cine.h > 0) {
    const left = cine.x, top = r.height - (cine.y + cine.h);   // cine.y is measured from the BOTTOM
    return { x: ((clientX - r.left - left) / cine.w) * 2 - 1,
             y: -((clientY - r.top - top) / cine.h) * 2 + 1 };
  }
  return { x: ((clientX - r.left) / r.width) * 2 - 1,
           y: -((clientY - r.top) / r.height) * 2 + 1 };
}
// The camera actually rendering the viewport (the sequencer camera while it drives the view).
// Mirrors the render loop's activeCamera so raycasts hit exactly what's on screen.
function getActiveViewportCamera() { return cutsceneCamActive ? csCamera : camera; }

// Raycast a screen point to the zone surface; returns the zone-LOCAL (= FFXI) point.
function _surfacePointAtScreen(clientX, clientY) {
  raycaster.setFromCamera(clientToNdc(clientX, clientY), getActiveViewportCamera());
  const hits = raycaster.intersectObject(zoneRoot, true)
    .filter((h) => h.object.parent?.userData?.zoneMesh || placementSet.has(h.object.parent ?? h.object));
  const world = hits.length ? hits[0].point.clone() : raycaster.ray.at(30, new THREE.Vector3());
  const l = zoneRoot.worldToLocal(world);
  return [+l.x.toFixed(3), +l.y.toFixed(3), +l.z.toFixed(3)];
}

function maybeAddPositionMarkerMenu(e) {
  // Only intercept while editing a Position keyframe and a zone is loaded; otherwise
  // fall through to the normal object context menu.
  if (!zoneRoot || typeof csPositionKeyframeOpen !== 'function' || !csPositionKeyframeOpen()) return;
  e.preventDefault();
  e.stopImmediatePropagation();   // block showViewportContextMenu (same target) so no double menu
  flyState.flyLooking = false;
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
  const pos = _surfacePointAtScreen(e.clientX, e.clientY);
  document.getElementById('pos-marker-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'pos-marker-menu';
  menu.className = 'pos-marker-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.innerHTML = `<button type="button"><span class="material-symbols-outlined">location_on</span> Add Position Marker</button>`;
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener('mousedown', onDoc, true); };
  const onDoc = (ev) => { if (!menu.contains(ev.target)) close(); };
  menu.querySelector('button').onclick = () => {
    close();
    // Only auto-assign to the open Position keyframe if it has NO marker yet — adding a new
    // marker must not hijack an actor that's already pointed at one.
    const hadMarker = (typeof csOpenPositionKfHasMarker === 'function') && csOpenPositionKfHasMarker();
    const entry = addCsMarker({ pos });
    if (entry && !hadMarker) csAssignMarkerToOpenPositionKf(entry.name, pos);
    // Refresh the open keyframe modal so its "To marker" dropdown picks up the new option
    // (the auto-assign path already re-renders; this covers the had-a-marker-already case).
    if (entry && typeof csRefreshOpenKeyframe === 'function') csRefreshOpenKeyframe();
  };
  setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
}
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 2) { rightDownX = e.clientX; rightDownY = e.clientY; rightDownTime = performance.now(); flyState.rightLookMoved = false; }
  if (e.button === 2 || (e.button === 0 && !transform.axis)) { flyState.flyLooking = true; canvas.setPointerCapture(e.pointerId); }
});
canvas.addEventListener('pointermove', (e) => {
  lastCanvasPointerClient = { x: e.clientX, y: e.clientY };
  if (flyState.flyLooking && (Math.abs(e.movementX) > 0 || Math.abs(e.movementY) > 0)) onFlyLook(e.movementX, e.movementY);
});
canvas.addEventListener('pointerup', (e) => {
  if (e.button === 0 || e.button === 2) endFlyLook(e.pointerId);
});

// Robust fly-look teardown. Releasing right-click while the cursor is over ANOTHER element
// (asset browser, side panels) used to pop that element's native context menu AND never
// deliver the canvas pointerup — leaving flyLooking stuck (inverted controls, W-to-stop).
// Fix: end the look from WINDOW listeners (release/blur/capture-loss anywhere ends it), and
// swallow the context menu globally whenever the right gesture was a look-drag.
window.addEventListener('pointermove', (e) => {
  // Track right-button drag distance even while the cursor is off-canvas (pointer-captured).
  if (flyState.flyLooking && (e.buttons & 2) && (Math.abs(e.clientX - rightDownX) > 6 || Math.abs(e.clientY - rightDownY) > 6)) flyState.rightLookMoved = true;
});
window.addEventListener('pointerup', (e) => { if (e.button === 0 || e.button === 2) endFlyLook(e.pointerId); }, true);
window.addEventListener('blur', () => endFlyLook());
canvas.addEventListener('lostpointercapture', () => { flyState.flyLooking = false; });
window.addEventListener('contextmenu', (e) => {
  // Suppress the menu (native or any panel's) when the right-click was a look-drag, or we're
  // still mid-look — covers a release that lands outside the canvas. A plain right-click that
  // didn't drag falls through to the element's own contextmenu handler (viewport menu, etc.).
  if (flyState.rightLookMoved || flyState.flyLooking) { e.preventDefault(); e.stopPropagation(); }
  flyState.rightLookMoved = false;
  endFlyLook();
}, true);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const direction = e.deltaY < 0 ? 1 : -1;
  setFlySpeed(flySpeed * Math.pow(1.15, direction));
}, { passive: false });
window.addEventListener('blur', () => heldKeys.clear());

// Shared "amplify texture" gain — FFXI's DXT/paletted textures are low-contrast and
// many submeshes alpha-blend, so they read faint. We inject this multiply into every
// material's fragment shader (see makeMaterial) and drive it from a slider.
const gainUniform = { value: 1.0 };
// xim's real lighting (ports EnvironmentSection.kt): every surface is lit by
//   lit = ambient*vColor + max(0, dot(N, lightDir)) * lightColor * vColor
//   out = vec4(2*lit*tex.rgb, 4*vColor.a*tex.a)
// where ambient/light come from the active weather environment, and the light dir/colour
// is the sun↔moon mix for the time of day. Shared across world + water materials.
// xim terrain lighting = ambient + TWO directional diffuse lights (sun + moon), each
// applied via diffuseLightCalc(N, vColor, light). Both the zone mesh (ZoneDrawer →
// terrain lighting) and the static-mesh water (ParticleDrawer, when lightingEnabled)
// use the very same two-light terrain config. We share these uniform objects across
// every material so a single applyEnvironment() updates the whole scene at once.
const lightUniforms = {
  uAmbient:    { value: new THREE.Color(0.5, 0.5, 0.5) },
  uSunDir:     { value: new THREE.Vector3(0, 1, 0) },
  uSunColor:   { value: new THREE.Color(1, 1, 1) },
  uMoonDir:    { value: new THREE.Vector3(0, -1, 0) },
  uMoonColor:  { value: new THREE.Color(0, 0, 0) },
};
const fogUniforms = {
  uFogColor: { value: new THREE.Color(0, 0, 0) }, uFogNear: { value: 0 }, uFogFar: { value: -1 }, uFogOn: { value: 0 },
};
// xim binds a flat 0x80 grey texture when a mesh has none (texel = 0.5).
const DEFAULT_TEX = (() => {
  const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true; return t;
})();
let environments = new Map();   // weatherId -> { indoors, model:{sun,moon,ambient,fog,...} }
let currentWeather = 'default';
let timeMinutes = 720;          // 0..1439 (12:00 noon)

// Shared GLSL: imported from lighting.js (LIGHT_UNIFORMS_GLSL, litRGB_GLSL, applyFog_GLSL)
// Wire lighting module — getState() is called lazily so waterTints/dayOfWeek/etc. need not
// be defined yet; they will be by the time applyEnvironment/applyDayColors are first invoked.
initLighting({ lightUniforms, fogUniforms, getState: () => ({ environments, currentWeather, userFog, scene, applyBackdrop, timeMinutes, dayOfWeek, waterTints }) });

// ── per-zone state ──────────────────────────────────────────────────────────
let zoneRoot = null;          // root group (holds the FFXI->display correction)
let currentZoneUrl = '';
let subAreasLoadPromise = null;   // resolves when the current zone's building interiors finish registering
let hdDirAvailable = false;   // true when FFXI_HD_DIR is configured in the backend
let ffxiDir = '';             // absolute FFXI_DIR (pristine) — /game/ junction target, for full DAT paths
let ffxiHdDir = '';           // absolute FFXI_HD_DIR — /game-hd/ root, for HD-zone full paths
let hdVariantAvailable = false; // true when THIS zone has a real HD asset-pack DAT (per-zone)
let hdVariantPath = '';         // absolute HD DAT path for the current zone (info only)
let _hdVariantZone = '';        // currentZoneUrl last checked via zone.hdVariant (de-dupes the call)
let zonesData = [];           // zones.json entries — used for Zone ID lookup in zone info
let customZonesData = [];     // custom ROM10 zones discovered via bridge (not in zones.json)
let statusZoneUrl = '';
let placements = [];          // selectable objects { node, name, li }
let skyGroup = null;          // unplaced (skybox/environment) meshes, toggled separately
// markerGroup — moved to markers.js (use getMarkerGroup/setMarkerGroup)
let vfxIconGroup = null;      // editor-only billboard icons marking every VFX generator (nodes are hidden)
let _vfxIconTex = null;
// collisionGroup, collisionMaterial, collisionPrimGroup, collisionPrimMaterials — moved to collision-ui.js
// Use getCollisionGroup/setCollisionGroup, getCollisionMaterial/setCollisionMaterial,
// getCollisionPrimGroup/setCollisionPrimGroup, getCollisionPrimMaterials() from that module.
let navmeshGroup = null;      // server navmesh (walkable polys) overlay, toggled separately
let navmeshMaterial = null;
let navmeshNavFile = null;    // path of the loaded .nav file, for zone info display
let currentCompanionDats = null;  // {event, dialog, npc} DAT paths, fetched per zone
let animatedTextures = [];    // {texture, scroll:[u,v]} — water surfaces scrolled per frame
let emittedEffects = [];      // lightweight auto-run StaticMesh particle emitters
let waterTints = [];          // {uniform, base:[rgba 0..255], dayColors:[[rgba]×8]|null}
// full particle runtime for zone auto-run effects is owned by core/zone-effects.js (_zoneVfxSystem);
// access via getZoneVfxSystem() / reset via clearZoneVfxSystem().
let dayOfWeek = 3;            // DayOfWeek.Wind (xim default); drives water colour (0x4E)
let userFog = loadSetting('fog', true);          // Settings "Fog" toggle (editor convenience; data fog is authentic)
let disableVfx = loadProjectSetting('disableVfx', loadSetting('disableVfx', false));   // project-scoped
let showVfxIcons = loadSetting('showVfxIcons', true);
let showAxisGizmo = loadSetting('showAxisGizmo', true);   // bottom-left X/Y/Z orientation gizmo
let autoSave = loadSetting('autoSave', true);
let saveEveryAction = loadSetting('saveEveryAction', true);
let publishReset = loadProjectSetting('publishReset', loadSetting('publishReset', true));   // project-scoped: Publish resets DAT from pristine first (default on)
// project-scoped HD-on-Publish: 'off' | 'publish' | 'clone'. Migrate the legacy boolean
// `publishHd` (true→'publish', false→'off') so an existing opt-out is preserved.
let hdPublishMode = loadProjectSetting('hdPublishMode',
  loadSetting('hdPublishMode', loadSetting('publishHd', true) ? 'publish' : 'off'));
let clearCollisionOnReset = loadProjectSetting('clearCollisionOnReset', loadSetting('clearCollisionOnReset', false));   // project-scoped: Reset/Publish also wipes the zone's own collision (replace, not append)
let showPlayerMarker = loadSetting('showPlayerMarker', true);   // overlay a "PLAYER" disc at the DB spawn point
let validateSpawn = loadSetting('validateSpawn', true);         // warn on Publish if no collision under the spawn
let playerMarkerGroup = null;   // editor-only "PLAYER" billboard overlay (not a placement, never exported)
let playerSpawn = null;         // { x,y,z,zone,name,charid } last read from chars
let vfxIconSize = Math.max(10, Math.min(80, Math.round(loadSetting('vfxIconSize', 35) / 5) * 5)); // on-screen px, 5px steps (10–80)
let showSkybox = loadProjectSetting('skybox', loadSetting('skybox', false));         // project-scoped
let skyboxScaled = loadProjectSetting('skyboxScaled', loadSetting('skyboxScaled', true)); // project-scoped
let showCollision = loadSetting('collision', false);
let isolateCollision = loadSetting('isolateCollision', false);   // Isolate: show ONLY our authored collision prims
let isolateBaked = loadSetting('isolateBaked', false);           // Baked: show ONLY the collision baked into the DAT
let collisionOpacity = loadSetting('collisionOpacity', 0.45);
let showNavmesh = loadSetting('navmesh', false);
let isolateNavmesh = loadSetting('isolateNavmesh', false);
var overlayBtnsReady = false;
let navmeshOpacity = loadSetting('navmeshOpacity', 0.35);
let showOutline = loadSetting('outline', true);
let showHoverOutline = loadSetting('hoverOutline', true);
let simpleOutline = loadSetting('simpleOutline', false);
let showFrontNormal = loadSetting('frontNormal', true);
let scaleUniform = loadSetting('scaleUniform', true);
let undoLimit = normalizeUndoLimit(loadSetting('undoLimit', 100));
let moveSnap = clampSnapValue(loadSetting('moveSnap', 1), 0, 5, 0.1);
let rotateSnap = clampSnapValue(loadSetting('rotateSnap', 15), 0, 180, 15); // degrees in UI/storage
let scaleSnap = clampSnapValue(loadSetting('scaleSnap', 0.1), 0, 1, 0.1);
let snapOnShift = loadSetting('snapOnShift', true);
let shiftHeld = false;
let selected = null;
const selectedSet = new Set();
let placementGroups = [];  // [{ id, name, color, members: string[] }]
// List CATEGORIES — a visual sectioning of each side-panel list (distinct from groups).
// State lives in `categorySets` (per list kind); see the "List Categories" section below.
// clipboard, clipboardTs — moved to copy-paste.js
let parsed = null;    // parseZone() result for the current zone (meshes, placements, …)
let templates = null; // Map<name, entries[]> built by buildMeshTemplates() — needed for cross-zone paste
// subAreaGroup, subAreaState, subAreaPlaceholders, stripInteractions — moved to subarea.js (imported above)
let footstepSourceZone = '';      // publishable: donor zone for fses 0x3D footstep sound pointers
let hovered = null;
let hoveredIconNode = null;   // VFX/SFX icon currently under the cursor (for mouse-over highlight)
let keyTablesPromise = null;  // FFXiMain.dll key tables, fetched once

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
// XZONE_CLIP_KEY — moved to copy-paste.js
let lastCanvasPointerClient = null;
let copyTransformIncludeScale = loadSetting('copyTransformIncludeScale', false);
let pasteOffset = loadSetting('pasteOffset', false);   // Ctrl+V: nudge the copy vs paste on top of the original             // {x,y} — updated by canvas pointermove for paste-at-cursor

function setStatus(msg, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = statusZoneUrl ? zoneSettingsKey(statusZoneUrl) : msg;
  statusEl.classList.toggle('error', isError);
}

const placementSet = new Set();
function toPlacement(obj) {
  let n = obj;
  while (n) {
    if (n.userData?.vfxNode) return n.userData.vfxNode; // a VFX icon resolves to its (hidden) VFX node
    if (placementSet.has(n)) return n;
    n = n.parent;
  }
  return null;
}
// The xi_init render anchor (the tiny placeholder that keeps a custom zone's render
// structure valid) is PROTECTED: always locked, never deletable, no visibility checkbox,
// hidden by default.
function isInitAnchor(p) { return p?.node?.userData?.placement?.meshId === 'xi_init' || p?.name === 'xi_init'; }
function isLocked(p) { return isInitAnchor(p) || !!p?.node.userData.locked; }
function isWorldPickable(p) {
  if (!p || isLocked(p)) return false;
  if (p.isEffect) return p.node.visible;
  // Collision prims hide via their group's .visible (the Collision toggle / isolate),
  // not the node's — so gate on the group too: can't click collision you can't see.
  if (p.isCollisionPrimitive) return !!(getCollisionPrimGroup() && getCollisionPrimGroup().visible) && p.node.visible;
  // Can't click what you can't see. three.js Raycaster ignores `.visible`, so a
  // node hidden via its visibility checkbox is still a raycast hit — gate it here.
  // Walk ancestors too, so hiding a parent group also blocks the child.
  for (let n = p.node; n; n = n.parent) if (n.visible === false) return false;
  return true;
}

// ── DAT → three.js scene ─────────────────────────────────────────────────────


function buildTextures(texMap) {
  const out = new Map();
  for (const [name, img] of texMap) {
    const tex = new THREE.DataTexture(img.rgba, img.width, img.height, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false; // our decoded pixels are top-origin, like GLTFLoader expects
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false; tex.needsUpdate = true;
    out.set(name, tex);
  }
  return out;
}

// ── time-of-day / weather lighting — extracted to lighting.js ────────────────
// BIAS, NO_BIAS, TH, ambientToColor, diffuseToColor, sunDirDisplay,
// applyDayColors, applyEnvironment are all imported from ./lighting.js.

// FFXI stores texture alpha in a reduced range (~0..64), so the ×4 is essential —
// without it nominally-opaque texels read as ~25% alpha and either vanish (alpha
// test) or turn see-through (blend). discardThreshold is only set for meshes whose
// name starts with "_" (0.375); everything else is fully opaque (alpha ignored).
const WORLD_VERT = `
  varying vec2 vUv; varying vec4 vColor; varying vec3 vN; varying float vDist;
  void main(){
    vUv = uv; vColor = color;
    vN = mat3(modelMatrix) * normal;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;
const WORLD_FRAG = `
  precision highp float;
  uniform sampler2D map; uniform float uGain; uniform float uDiscard;
  ${LIGHT_UNIFORMS_GLSL}
  varying vec2 vUv; varying vec4 vColor; varying vec3 vN; varying float vDist;
  ${litRGB_GLSL}
  ${applyFog_GLSL}
  void main(){
    vec4 tex = texture2D(map, vUv);
    // Editor view: unlit, but keep FFXI's neutral 0x80 vertex colour convention.
    vec4 col = vec4(2.0 * vColor.rgb * tex.rgb * uGain * 1.12, clamp(4.0 * vColor.a * tex.a, 0.0, 1.0));
    if (col.a < uDiscard) discard;
    gl_FragColor = clamp(col, 0.0, 1.0);
  }`;
function makeMaterial(tex, { alphaBlend, discard }) {
  const mat = new THREE.MeshBasicMaterial({
    map: tex || DEFAULT_TEX,
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: alphaBlend,
    depthWrite: !alphaBlend,
    alphaTest: discard ? 1 / 255 : 0,
  });
  // Many FFXI cutout masks use any non-zero texture alpha as visible coverage, while
  // translucent/additive meshes still need their low stored alpha expanded for preview.
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <alphatest_fragment>',
      'diffuseColor.a = clamp(diffuseColor.a * 4.0, 0.0, 1.0);\n#include <alphatest_fragment>'
    );
  };
  return mat;
}

// PARTICLE_VERT/FRAG, makeParticleMaterial, VFX_LABEL, tuneSurfaceForEditor,
// makeSpriteTemplate, addParticleMeshes, makeParticleInstance, addEmittedEffect,
// addPointLightEffect, addPlainVfxMesh, addSoundEmitters, clearZoneVfxSystem,
// isLegacyZoneEnvMesh, buildRuntimeZoneEffects, buildPlainVfxMeshes,
// updateEmittedEffects, buildSurfaceEffects → core/zone-effects.js

// One set of {geometry,material} per (mesh, texture-group), shared across every
// placement that references that mesh — 662 placements, far fewer unique meshes.
// `textures` is the Map of three.js DataTextures (keyed by FFXI texture name).
function buildMeshTemplates(meshes, textures) {
  const templates = new Map();
  const matCache = new Map();
  for (const [name, prims] of meshes) {
    const nameDiscard = name.startsWith('_'); // xim "_"-prefix heuristic (fallback)
    const byTex = new Map();
    for (const prim of prims) {
      const texKey = resolveTexture(prim.textureName, textures);
      // Retail enables alpha-test from the mesh name's first byte ('_'), not the
      // 0x2000 submesh flag. That flag is also used for two-sided meshes such as kasa.
      const discard = nameDiscard;
      const key = `${texKey}|${prim.alphaBlend}|${discard}`;
      if (!byTex.has(key)) byTex.set(key, { texKey, alphaBlend: prim.alphaBlend, discard, prims: [] });
      byTex.get(key).prims.push(prim);
    }
    const entries = [];
    for (const { texKey, alphaBlend, discard, prims: group } of byTex.values()) {
      let n = 0; for (const p of group) n += p.positions.length;
      const pos = new Float32Array(n), nor = new Float32Array(n), uv = new Float32Array((n / 3) * 2), col = new Float32Array((n / 3) * 4);
      let po = 0, uo = 0, co = 0;
      for (const p of group) {
        pos.set(p.positions, po); nor.set(p.normals, po); uv.set(p.uvs, uo);
        for (let i = 0; i < p.colors.length; i += 4) {
          col[co + i] = Math.min(1, p.colors[i] * 2);
          col[co + i + 1] = Math.min(1, p.colors[i + 1] * 2);
          col[co + i + 2] = Math.min(1, p.colors[i + 2] * 2);
          // Cutout zone objects use texture alpha for the mask. Treating vertex alpha as
          // another opacity source makes low-alpha FFXI colours fail alphaTest entirely.
          col[co + i + 3] = discard && !alphaBlend ? 1 : Math.min(1, p.colors[i + 3] * 2);
        }
        po += p.positions.length; uo += p.uvs.length; co += p.colors.length;
      }
      // Old editor view: MeshBasicMaterial is unlit, so bake xim's neutral 0x80 vertex
      // colour convention into geometry colours instead of using the lighting shader.
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
      const matKey = `${texKey}|${alphaBlend}|${discard}`;
      if (!matCache.has(matKey)) matCache.set(matKey, makeMaterial(texKey ? textures.get(texKey) : null, { alphaBlend, discard }));
      entries.push({ geometry: geo, material: matCache.get(matKey), alphaBlend, texKey });
    }
    templates.set(name, entries);
  }
  return templates;
}

function instantiate(templates, name) {
  const group = new THREE.Group();
  for (const { geometry, material, texKey, alphaBlend } of templates.get(name)) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData = { texture: texKey, alphaBlend, mesh: name };
    group.add(mesh);
  }
  return group;
}

async function getKeyTables() {
  if (!keyTablesPromise) {
    // Prefer install root DLL via bridge HTTP (uses current FFXI_DIR).
    const candidates = [
      gameAssetUrl('game/FFXiMain.dll'),
      gameAssetUrl('game/../FFXiMain.dll'),
    ];
    keyTablesPromise = (async () => {
      let lastErr = null;
      for (const url of candidates) {
        try {
          const r = await fetch(url);
          if (!r.ok) { lastErr = new Error(`FFXiMain.dll HTTP ${r.status}`); continue; }
          return extractKeyTables(await r.arrayBuffer());
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error('Could not load FFXiMain.dll — set FFXI_DIR in Game Paths setup');
    })();
  }
  return keyTablesPromise;
}

async function _loadNavmesh(url) {
  const capturedRoot = zoneRoot;
  try {
    const res = await bridgeCall('zone.navmesh', { zone: url });
    if (zoneRoot !== capturedRoot || navmeshGroup) { return; }
    if (!res?.positions?.length) { console.warn('[navmesh] no positions:', res?.error || '(empty)'); return; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(res.positions), 3));
    const mat = new THREE.MeshBasicMaterial({
      color: 0x00cc55, transparent: true, opacity: navmeshOpacity,
      side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    navmeshMaterial = mat;
    const nmesh = new THREE.Mesh(geo, mat);
    nmesh.raycast = () => {};
    navmeshGroup = new THREE.Group(); navmeshGroup.name = 'navmesh';
    navmeshGroup.add(nmesh);
    // Always-on cell-shade wireframe (EdgesGeometry + dark depth-tested lines), like the collision
    // overlay — with the fill writing depth while isolating, only the near surface shows instead of
    // front+back edges x-raying through each other.
    const nwire = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 1),
      new THREE.LineBasicMaterial({ color: 0x0a0a0e, opacity: 0.6, transparent: true }));
    nwire.raycast = () => {};
    navmeshGroup.add(nwire);
    capturedRoot.add(navmeshGroup);
    applyIsolateNavmesh();   // enables the navmesh render layer + respects Production / isolate state
    navmeshNavFile = res.navFile || null;
    updateZoneInfo();
  } catch (_e) { console.warn('[navmesh] load failed:', _e); }
}

// Build (or rebuild) the translucent 0x1C MZB collision overlay from parsed collision
// geometry and attach it to zoneRoot. Factored out of loadZone so a Publish can re-run it
// (reloadCollisionOverlay) without a full zone reload. Honours the current show/opacity
// state. Verts are raw FFXI world coords; the zoneRoot correction negates Y. Not pickable.
function buildCollisionOverlay(collision) {
  if (!collision || !zoneRoot) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(collision.positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(collision.colors, 3));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: collisionOpacity,
    side: THREE.DoubleSide, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,  // sit the wire cleanly on top
  });
  setCollisionMaterial(mat); // so the opacity slider can adjust it live
  const cmesh = new THREE.Mesh(geo, mat);
  cmesh.raycast = () => {}; // overlay only — never intercept clicks
  const _cg = new THREE.Group(); _cg.name = 'collision'; setCollisionGroup(_cg);
  _cg.add(cmesh);
  // Always-on wireframe so the collision shape reads clearly (EdgesGeometry + a
  // depth-tested line material so it's occluded properly).
  const cwire = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo, 1),
    new THREE.LineBasicMaterial({ color: 0x0a0a0e, opacity: 0.6, transparent: true }));
  cwire.raycast = () => {};
  _cg.add(cwire);
  _cg.visible = showCollision;
  zoneRoot.add(_cg);
}

// Re-fetch + re-parse the (just-rewritten) DAT and rebuild ONLY the collision overlay, so
// a Publish reflects the freshly-baked 0x1C without a manual editor refresh. CACHE_BUST is
// bumped by the Publish first, so the fetch gets the new bytes (this user is in-place mode,
// so the served DAT is the published one). Scoped to collision → selection/camera/undo survive.
async function reloadCollisionOverlay() {
  if (!zoneRoot || !currentZoneUrl) return;
  let collision;
  try {
    const [buf, kt] = await Promise.all([
      fetch(datUrl(currentZoneUrl)).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }),
      getKeyTables(),
    ]);
    collision = parseZone(buf, kt).collision;
  } catch (e) { console.error('[publish] collision reload failed', e); return; }
  const _cgOld = getCollisionGroup(); if (_cgOld) { zoneRoot.remove(_cgOld); disposeSubtree(_cgOld); setCollisionGroup(null); setCollisionMaterial(null); }
  buildCollisionOverlay(collision);
}

// Fetch a zone DAT's bytes. With baseDat, fetch the pristine `<dat>.base` backup
// (Base mode); if no backup exists (output-dir mode, where the served DAT is already
// pristine) fall back to the regular DAT so Base still shows the vanilla zone. With hd,
// fetch the HD asset-pack DAT (HD-Zone read-only mode); fall back to the standard bytes
// if this zone has no HD variant so the preview never hard-fails.
async function fetchDatBuffer(url, baseDat, hd) {
  let r;
  if (hd) {
    r = await fetch(datUrl(hdUrlFor(url)));
    if (r.status === 404) r = await fetch(datUrl(url));
  } else if (baseDat) {
    r = await fetch(datUrl(url, true));
    if (r.status === 404) r = await fetch(datUrl(url));
  } else {
    r = await fetch(datUrl(url));
  }
  if (!r.ok) {
    const msg = r.status === 404
      ? `DAT not found: ${url} — check the path is relative to game/ (e.g. ROM/1/41.DAT)`
      : `Failed to fetch ${url}: HTTP ${r.status}`;
    showErrorBanner(msg);
    setStatus(msg, true);
    throw new Error(msg);
  }
  return r.arrayBuffer();
}

// baseDat/hd default from the current mode so switching zones while in Base/HD mode keeps
// showing those bytes; setMode/reloadZoneClean pass them explicitly to override.
async function loadZone(url, { baseDat = (getMode() === 'base'), hd = (getMode() === 'hd') } = {}) {
  // HD preview is per-zone (not every zone has an HD asset). A genuine zone change while
  // in HD mode drops back to Edit so the new zone loads its real standard bytes — the HD
  // toggle (gated on availability) is the way back in. Mode-toggle reloads (_suppressStateFetch)
  // keep HD; only a true navigation resets it. onZoneLoaded() re-applies the mode UI at the end.
  if (hd && !getSuppressStateFetch() && url !== currentZoneUrl) {
    setMode('edit'); hd = false;
  }
  // The cutscene sequencer + its keyframe / event / author modals aren't tied to a zone,
  // so a genuine zone change (not a same-zone mode-toggle reload) would leave them showing
  // stale data — close them FIRST (before saving the camera). csCloseSequencer() exits the
  // sequencer-camera pilot (hands WASD/look + the render back to the free camera), drops the
  // keyframe modal, and clears the cutscene actors/VFX — so we save the free-camera pose.
  if (url !== currentZoneUrl) {
    csCloseSequencer();
    for (const id of ['evt-dialog-modal', 'cs-author-modal', 'cs-create-event-modal', 'evt-zone-peek-modal']) {
      document.getElementById(id)?.classList.remove('open');
    }
  }
  saveCurrentZoneCamera();
  statusZoneUrl = url;
  setStatus(`fetching ${url}…`);
  closeConsole();          // the publish/backend log belongs to the zone we're leaving
  transform.detach();
  clearSelectionOutline();
  clearOutline(getHoverOutline()); hovered = null; hoveredIconNode = null;
  clearHistory();
  if (zoneRoot) { scene.remove(zoneRoot); disposeSubtree(zoneRoot); }
  clearZoneVfxSystem();
  placements = []; placementGroups = []; placementSet.clear(); selectedSet.clear(); deletedEntries.clear(); addedEntries.clear(); skyGroup = null; resetMarkerGroup(); vfxIconGroup = null; setCollisionGroup(null); setCollisionMaterial(null); setCollisionPrimGroup(null); getCollisionPrimMaterials().length = 0; navmeshGroup = null; navmeshMaterial = null; navmeshNavFile = null; currentCompanionDats = null; playerMarkerGroup = null; playerSpawn = null; selected = null; animatedTextures = []; emittedEffects = []; waterTints = []; parsed = null; templates = null; resetSubAreaState(); footstepSourceZone = ''; syncFootstepSourceUI();
  objlistEl.innerHTML = ''; selectionEl.textContent = 'nothing selected';

  let keyTables, datBuf;
  try {
    const [buf, kt] = await Promise.all([
      fetchDatBuffer(url, baseDat, hd),
      getKeyTables(),
    ]);
    datBuf = buf; keyTables = kt;
    setStatus('decrypting + parsing zone…');
    parsed = parseZone(datBuf, keyTables);
  } catch (e) {
    if (!e.message.startsWith('DAT not found') && !e.message.startsWith('Failed to fetch')) {
      showErrorBanner(e.message, { title: 'Parse error', sticky: true });
      setStatus(`failed: ${e.message}`, true);
      console.error(e);
    }
    hideChangesLoader();   // zone never finished loading → don't leave the project-open overlay stuck
    return;
  }

  const { meshes, placements: plc, textures, meshIdToName, collision } = parsed;
  const texMap = buildTextures(textures); // FFXI name -> three.js DataTexture (same keys)
  templates = buildMeshTemplates(meshes, texMap);

  // FFXI is left-handed; convert to display space: 180° about X (quaternion x,y,z,w = 1,0,0,0)
  // + flip both X and Z (scale -1,1,-1).  Net = Rz(180°) = diag(-1,-1,1): negates X and Y,
  // preserves Z.  Negating Y gives Y-up; negating X corrects the east/west (left/right) mirror
  // so the zone matches the in-game orientation.  det = +1 (pure rotation, no winding flip) —
  // fine because all zone materials use THREE.DoubleSide.
  zoneRoot = new THREE.Group();
  zoneRoot.quaternion.set(1, 0, 0, 0);
  zoneRoot.scale.set(-1, 1, -1);
  scene.add(zoneRoot);

  // VFX generators render through the particle path, or as plain mesh markers when disabled.
  const fx = disableVfx ? buildPlainVfxMeshes(datBuf, templates, meshIdToName) : buildRuntimeZoneEffects(datBuf, meshes, templates, texMap, meshIdToName);
  zoneRoot.add(fx.group);

  // Time-of-day / weather environments → populate weather dropdown + apply current tint+fog.
  try { environments = parseEnvironments(datBuf); } catch (e) { environments = new Map(); console.error(e); }
  populateWeather();
  applyEnvironment();

  const placedNames = new Set();
  const nameCounts = new Map();
  for (const p of plc) {
    const resolved = resolveMeshName(p.meshId, meshes);
    if (!resolved) continue;
    placedNames.add(resolved);
    const node = instantiate(templates, resolved);
    // Decompose the TRS into position/quaternion/scale (matrixAutoUpdate stays on) so
    // TransformControls can edit it. The root-correction lives on the parent, so the
    // node's *local* values equal the raw FFXI placement. rotation.order = ZYX matches
    // the game's rotateZYX, so the rot readout stays meaningful after editing.
    node.rotation.order = 'ZYX';
    trsMatrix(p.pos, p.rot, p.scale).decompose(node.position, node.quaternion, node.scale);
    const c = (nameCounts.get(p.meshId) || 0) + 1; nameCounts.set(p.meshId, c);
    node.name = c === 1 ? p.meshId : `${p.meshId}.${String(c).padStart(3, '0')}`;
    node.userData.placement = p;
    zoneRoot.add(node);
    registerPlacement(node);
    // Sub-area placeholder: this object is the "closed building" shell the interior
    // (file_id_link) replaces. Track it so showing that interior hides this shell.
    if (p.fileIdLink) {
      let arr = subAreaPlaceholders.get(p.fileIdLink);
      if (!arr) { arr = []; subAreaPlaceholders.set(p.fileIdLink, arr); }
      arr.push(node);
    }
  }

  // Meshes never referenced by a placement sit at the origin. Two kinds:
  //  - celestial/skybox (sun, moon, stars, clouds): additive sky elements meant to
  //    wrap the camera. As opaque geometry they render as a mottled sphere through
  //    the zone, so blend them and hide by default.
  //  - genuine environment geometry: keep visible + selectable.
  // Sky visibility per zone follows the project's Skybox setting (default off). Re-read it
  // here so each zone build reflects the active project; the Sky toggle still reveals it live.
  showSkybox = loadProjectSetting('skybox', false);
  if (typeof skyToggle !== 'undefined' && skyToggle) skyToggle.checked = showSkybox;
  skyGroup = new THREE.Group(); skyGroup.name = 'skybox';
  for (const name of meshes.keys()) {
    if (placedNames.has(name) || fx.meshNames.has(name)) continue; // fx.meshNames drawn as effects
    const node = instantiate(templates, name); node.name = name;
    if (isSkyName(name)) {
      // Per-element visibility (so the SKY tab can hide individual domes); not
      // viewport-pickable (the huge scaled domes would otherwise hijack every click)
      // — selectable from the SKY list instead.
      node.visible = showSkybox;
      node.traverse((o) => { o.raycast = () => {}; });
      skyGroup.add(node);
      registerPlacement(node, false, true);
    } else {
      zoneRoot.add(node);
      registerPlacement(node);
    }
  }
  if (skyGroup.children.length) {
    // additive blend so the sun/stars read as glows, not solid spheres
    skyGroup.traverse((o) => { if (o.isMesh) {
      o.material.transparent = true; o.material.depthWrite = false;
      o.material.blending = THREE.AdditiveBlending; o.material.needsUpdate = true;
    }});
    skyGroup.visible = true;     // master on/off is per-element node.visible now (showSkybox)
    zoneRoot.add(skyGroup);
  }

  // Player-collision mesh (0x1C MZB) — a translucent debug overlay, off by
  // default, toggled in Settings. Verts are raw FFXI world coords; the zoneRoot
  // correction negates Y so it lines up with everything else. Not pickable.
  if (collision) buildCollisionOverlay(collision);

  // Server navmesh overlay — fetched async, never blocks zone rendering.
  _loadNavmesh(url);

  currentZoneUrl = url;
  saveSetting('lastZone', url);
  // Restore version label for this project+zone from localStorage (null if never set).
  const _savedVer = localStorage.getItem(versionLabelKey(url));
  setActiveVersionLabel(_savedVer != null ? Number(_savedVer) : null);
  if (typeof renderPinnedZones === 'function') renderPinnedZones();
  // Snapshot each effect's as-built visibility BEFORE applying saved overrides, so the
  // override layer can tell "off" apart from the node's natural default (runtime VFX = on).
  for (const p of placements) if (p.isEffect) p.node.userData.defaultVisible = p.node.visible;
  restoreVisibilityOverrides(url);
  restoreLockOverrides(url);
  restoreGroups(url);
  restoreCategories(url);
  restoreHotkeys(url);
  buildObjectList();
  renderHotkeyBar();
  applyWireframe();
  // Reset flat-mode material cache on zone load; re-apply if still active.
  _flatSavedMaterials.clear(); _flatNodeMaterials.clear();
  if (flatMode) applyFlatMode();
  if (!restoreZoneCamera(url)) frameScene();
  updateChangesUI();
  applyClearCollisionPolicy();   // official zones (<400) → force Reset-Collision OFF + disabled
  setStatus(zoneSettingsKey(url));
  // Start interior load BEFORE the change-set replay (in onZoneLoaded→refreshZoneState) and stash
  // its promise so the replay can await it — sub-area object edits only restore once their interior
  // placements are registered.
  subAreasLoadPromise = loadSubAreas();   // discover + spawn this zone's building interiors (async, bridge-gated)
  if (typeof onZoneLoaded === 'function') onZoneLoaded();
  refreshPlayerMarker();   // overlay the player's DB spawn point (async, bridge-gated)
}

// ── Sub-areas — moved to subarea.js ───────────────────────────────────────────
// loadSubAreas, buildSubAreaGroup, renderSubAreaPanel, renderSubAreaParent,
// syncSubAreaBlock, setSubAreaVisible, setAllSubAreas, stripActive, syncStripVisual,
// toggleStripInteractions, frameObject — imported from subarea.js above.
// DOM event listeners (subarea-show/hide/strip) are wired inside initSubAreas().

// labelVFX/SFX/SKY, vfxIconScale, VFX_ICON_* consts, vfxIconDistFactor,
// addVfxIcon, registerPlacement, setIconVisible, iconVisible, pickIcon → core/zone-effects.js
function setListedSoundsVisible(visible) {
  for (const p of placements) { if (!p.isSound || !p.li) continue; setIconVisible(p.node, visible); setVisibilityOverride(p, visible); const cb = p.li.querySelector('input.vis'); if (cb) cb.checked = visible; }
}

// ── object-list module functions moved to core/object-list.js ────────────────
// buildObjectList, openContextMenu, hideRowContextMenu, renderHotkeyBar,
// restoreGroups, restoreCategories, restoreHotkeys, restoreVisibilityOverrides,
// restoreLockOverrides, groupForPlacement, kindOf, spawnHotkey,
// setListedVisibility, setMarkerVisibility, setMobVisibility, setSkyVisible,
// applyWorkspaceViewState — all imported above from core/object-list.js

// Delegated zone-settings change handler (wired once at setup)
document.getElementById('zone-settings')?.addEventListener('change', async (e) => {
  const zid = currentZoneId();
  if (!zid) return;
  const t = e.target;

  if (t.id === 'zs-zonetype') {
    const prev = t._prev ?? t.value;
    t._prev = t.value;
    try {
      await bridgeCall('zone.setZonetype', { zoneId: zid, value: +t.value });
      t._prev = t.value;
    } catch (err) {
      setStatus(`Failed to update zonetype: ${err.message}`, true);
      t.value = prev;
    }
    return;
  }

  if (t.tagName === 'INPUT' && t.dataset.field === 'misc') {
    const allCbs = document.querySelectorAll('#zone-settings input[data-field="misc"]');
    let val = 0;
    allCbs.forEach((c) => { if (c.checked) val |= +c.dataset.bit; });
    try {
      await bridgeCall('zone.setMisc', { zoneId: zid, value: val });
    } catch (err) {
      setStatus(`Failed to update misc: ${err.message}`, true);
      t.checked = !t.checked;
    }
  }
});

// ── setListedVisibility, setMarkerVisibility, setMobVisibility, setSkyVisible — moved to core/object-list.js

function pickViewportContextEntry(e) {
  if (!zoneRoot || !selected) return null;
  const n = clientToNdc(e.clientX, e.clientY);
  pointer.x = n.x; pointer.y = n.y;
  raycaster.setFromCamera(pointer, getActiveViewportCamera());
  const hits = raycaster.intersectObject(zoneRoot, true);
  for (const h of hits) {
    const node = toPlacement(h.object);
    if (!node) continue;
    const p = placements.find((q) => q.node === node) || null;
    if (p && selectedSet.has(p)) return p;
  }
  return null;
}

function showViewportContextMenu(e) {
  // While editing a Position keyframe the capture-phase handler owns the right-click.
  if (typeof csPositionKeyframeOpen === 'function' && csPositionKeyframeOpen()) return;
  if (!selected || performance.now() - rightDownTime > 500 || Math.abs(e.clientX - rightDownX) > 6 || Math.abs(e.clientY - rightDownY) > 6) {
    e.preventDefault();
    return;
  }
  const p = pickViewportContextEntry(e);
  if (!p) { e.preventDefault(); return; }
  flyState.flyLooking = false;
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
  buildViewportContextMenu(p, e);
}

// ── selection ── moved to core/selection.js ───────────────────────────────────


// Delete all selected placements (removes from scene + object list). Undoable.
function deleteSelected() {
  if (!selectedSet.size) return;
  let toDelete = [...selectedSet].filter(e => !isLocked(e));
  // Building-interior objects can only be MOVED this iteration — a delete would misroute to the
  // main zone DAT (the record carries the interior's DAT-local index). Block them explicitly.
  const subBlocked = toDelete.filter(e => e.node?.userData?.placement?.subAreaId != null);
  if (subBlocked.length) {
    toDelete = toDelete.filter(e => e.node?.userData?.placement?.subAreaId == null);
    setStatus(`Deleting sub-room objects isn't supported yet — ${subBlocked.length} skipped`, true);
  }
  if (!toDelete.length) return;
  const states = toDelete.map(e => ({
    entry: e, node: e.node, parent: e.node.parent,
    index: placements.indexOf(e), wasAdded: addedEntries.has(e),
    vfxSprite: e.isEffect && vfxIconGroup ? (vfxIconGroup.children.find(sp => sp.userData.vfxNode === e.node) || null) : null,
  }));

  const remove = () => {
    transform.detach();
    for (const s of states) {
      s.node.parent?.remove(s.node);
      if (s.vfxSprite) vfxIconGroup.remove(s.vfxSprite);
      const i = placements.indexOf(s.entry); if (i >= 0) placements.splice(i, 1);
      placementSet.delete(s.node);
      // Markers and editable text planes round-trip via their OWN arrays (rebuilt from scratch on
      // load), so a deleted one just vanishes from that array — never a tracked placement delete.
      if (!s.entry.isMarker && !s.entry.isTextPlane) {
        markChange(s.entry);
        if (s.wasAdded) addedEntries.delete(s.entry); else deletedEntries.add(s.entry);
      }
      selectedSet.delete(s.entry);
    }
    selected = lastSelectedEntry();
    if (selected && !isLocked(selected)) transform.attach(selected.node); else transform.detach();
    if (!selected) selectionEl.textContent = 'nothing selected';
    rebuildSelectionOutline(); updateSelectionReadout(); updateSelectionOutline();
    updateMarkerDetailsPanel(); updateGlbDetailsPanel(); updateCollisionDetailsPanel(); updateSoundDetailsPanel();
    buildObjectList();
  };
  const restore = () => {
    for (const s of states) {
      s.parent?.add(s.node);
      if (s.vfxSprite && vfxIconGroup) vfxIconGroup.add(s.vfxSprite);
      if (!placements.includes(s.entry)) placements.splice(Math.min(s.index, placements.length), 0, s.entry);
      placementSet.add(s.node);
      if (!s.entry.isMarker && !s.entry.isTextPlane) {
        if (s.wasAdded) addedEntries.add(s.entry); else deletedEntries.delete(s.entry);
      }
    }
    buildObjectList();
    for (const q of selectedSet) q.li?.classList.remove('sel');
    selectedSet.clear();
    for (const s of states) selectedSet.add(s.entry);
    selected = states[states.length - 1].entry;
    if (selected && !isLocked(selected)) transform.attach(selected.node); else transform.detach();
    rebuildSelectionOutline(); updateSelectionReadout(); updateSelectionOutline();
    updateMarkerDetailsPanel(); updateGlbDetailsPanel(); updateCollisionDetailsPanel(); updateSoundDetailsPanel();
  };

  remove();
  pushCommand({ undo: restore, redo: remove });
}

// ── markers ──────────────────────────────────────────────────────────────────
// _markerTexCache + getMarkerTexture — moved to markers.js

// ── collision material model — moved to collision-ui.js ───────────────────────
// COLLISION_TERRAIN_RGB, defaultCollisionMat, setCollisionMat, bakeCollisionPrimTris,
// _rebuildCollisionPrimGeo, addCollisionPrimitive, buildCollisionPrimFromRec,
// createCollisionFromMesh all imported from collision-ui.js above.
async function importCollisionFromOBJ(file) {
  if (!zoneRoot) { setStatus('Load a zone first', true); return; }
  const text = await file.text();
  const faceLines = (text.match(/^f\s/gm) || []).length;
  const ok = confirm(
    `Replace the entire zone collision with "${file.name}"?\n\n`
    + `~${faceLines} face record(s) will be baked directly to the DAT.\n\n`
    + 'This cannot be undone without a zone reset.'
  );
  if (!ok) return;
  setStatus('Replacing collision…');
  let r;
  try {
    r = await bridgeCall('zone.replaceCollision', { zone: currentZoneUrl, objText: text });
  } catch (err) {
    setStatus(`Collision replace failed: ${err.message}`, true);
    return;
  }
  setStatus(`Collision replaced — removed ${r.removed} old mesh(es), baked ${r.added} input tri(s). Reload to verify.`);
}
function importCollisionObjViaPicker() {
  const inp = document.getElementById('obj-file-input');
  if (inp) { inp.value = ''; inp.click(); }
}

// MARKER_SCALE, surfacePointAhead, addMarker, addMarkerFromRec,
// collectMarkerChanges, updateMarkerDetailsPanel — moved to markers.js
// surfacePointAhead remains here because it's also used by collision/spawn raycasting in main.js.
function surfacePointAhead(fallbackDist = 10) {
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = raycaster.intersectObject(zoneRoot, true)
    .filter(h => placementSet.has(h.object.parent ?? h.object) ||
                 h.object.parent?.userData?.zoneMesh || h.object.userData?.zoneMesh);
  if (hits.length) return hits[0].point.clone();
  return raycaster.ray.at(fallbackDist, new THREE.Vector3());
}

// updateMarkerDetailsPanel, updateCollisionDetailsPanel, updateSoundDetailsPanel → core/player-marker.js

sdetRepeat?.addEventListener('change', () => {
  if (!selected?.isSound) return;
  const fx = selected.node.userData.effect; if (!fx) return;
  fx.repeat = sdetRepeat.checked;
  markChange(selected.node);
  updateChangesUI();
  setStatus(`Sound repeat ${fx.repeat ? 'on' : 'off'}.`);
});
sdetPlay?.addEventListener('click', () => { if (selected?.isSound) playSound(selected); });
footstepSourceZoneEl?.addEventListener('change', () => {
  footstepSourceZone = footstepSourceZoneEl.value || '';
  updateChangesUI();
  setStatus(footstepSourceZone
    ? `Footsteps will publish from ${zoneNameForPath(footstepSourceZone)}`
    : 'Footstep source cleared — DAT will be left as-is');
});

// ── PLAYER spawn marker + publish guard ─────────────────────────────────────
// Reads the character's saved position (chars.pos_x/y/z) for the charid in the
// Database panel's spawn bar and shows a billboard "PLAYER" disc at that point,
// in the same zoneRoot-local (raw FFXI world) frame as collision/placements — so
// you can see whether your collision actually sits under where the player lands.
// playerSpawnInfo() classifies the player↔floor gap (ok / void / buried / floating);
// updateSpawnWarning() tints the dot live and applyToGame() warns before writing the DAT.
function currentZoneId() {
  const e = (typeof zonesData !== 'undefined' && zonesData.find((z) => z.path === currentZoneUrl))
         || (typeof customZonesData !== 'undefined' && customZonesData.find((z) => z.path === currentZoneUrl));
  return e ? e.id : null;
}

// populateFootstepSourceZones, syncFootstepSourceUI, dbCredsTop → core/player-marker.js

// writeMobSpawns, makePlayerSprite, ensurePlayerGroup, refreshPlayerMarker → core/player-marker.js

// playerSpawnInfo, spawnWarningMessage, updateSpawnWarning → core/player-marker.js



function restoreDeletedEntry(entry) {
  // Ghost entries (deletes whose target wasn't in the loaded scene) have no real node —
  // reverting just drops the delete from the change-set; nothing to re-add to the scene.
  if (entry.ghost) { deletedEntries.delete(entry); buildObjectList(); return; }
  const parent = entry.node.parent || zoneRoot;
  parent.add(entry.node);
  if (!placements.includes(entry)) placements.push(entry);
  placementSet.add(entry.node);
  deletedEntries.delete(entry);
  // Effects/sounds/sky have no mesh of their own — their vfxIconGroup sprite (dropped when the
  // node was deleted) is their only handle. Recreate it if it's gone so a restored SFX is
  // visible and selectable again.
  if ((entry.node.userData.effect || entry.node.userData.isSkyIcon) && vfxIconGroup &&
      !vfxIconGroup.children.some(sp => sp.userData.vfxNode === entry.node)) {
    addVfxIcon(entry.node);
  }
  buildObjectList();
  select(entry);
}

function revertChange(c) {
  if (c.op === 'add') {
    // Drop the pasted object outright.
    if (transform.object === c.node) transform.detach();
    c.node.parent?.remove(c.node);
    // A sound emitter's only visible handle is its SFX icon (a vfxIconGroup sibling) — drop it too.
    if (c.entry?.isSound && vfxIconGroup) for (const sp of [...vfxIconGroup.children]) if (sp.userData.vfxNode === c.node) vfxIconGroup.remove(sp);
    const i = placements.indexOf(c.entry); if (i >= 0) placements.splice(i, 1);
    placementSet.delete(c.node);
    addedEntries.delete(c.entry);
    selectedSet.delete(c.entry);
    if (selected === c.entry) selected = lastSelectedEntry();
    if (selected && !isLocked(selected)) transform.attach(selected.node); else { transform.detach(); if (!selected) { selectionEl.textContent = 'nothing selected'; clearSelectionOutline(); updateSelectionOutline(); } }
    rebuildSelectionOutline(); updateSelectionReadout(); updateSelectionOutline();
    buildObjectList();
  } else if (c.op === 'delete') {
    restoreDeletedEntry(c.entry);
  } else {
    const o = c.node.userData.original;
    c.node.position.copy(o.p); c.node.quaternion.copy(o.q); c.node.scale.copy(o.s); c.node.updateMatrix();
    reselectAfterEdit(c.node);
  }
  updateChangesUI();
}

// "Remove from Change History" — drop this record from the tracked change-set WITHOUT touching the
// scene: the object stays exactly as it is now, only the tracking is forgotten (so it won't export
// or publish). For phantom/stuck rows, or to bless an edit into the baseline.
function forgetChange(c) {
  // Drop whichever flag produced the row (add/delete are no-ops if absent)...
  if (c.entry) { addedEntries.delete(c.entry); deletedEntries.delete(c.entry); }
  // ...and rebaseline the node's TRS baseline to its current pose so a moved/added object
  // can't reappear as a `modify` once its add/delete flag is gone.
  const o = c.node?.userData?.original;
  if (o) { o.p.copy(c.node.position); o.q.copy(c.node.quaternion); o.s.copy(c.node.scale); }
  updateChangesUI();
}

// The entry + every change derived from it — currently the collision prims built from this object's
// mesh (linked by the source object's xiId, stamped in createCollisionFromMesh). Lets
// "Remove Object" take related changes (e.g. a cube's auto-generated collision) with it.
function relatedEntries(entry) {
  const out = [entry];
  const cid = entry?.node?.userData?.xiId;
  if (cid) {
    for (const p of placements) {
      if (p === entry || !p.isCollisionPrimitive) continue;
      const src = p.node.userData?.sourceXiIds;
      if (Array.isArray(src) && src.includes(cid)) out.push(p);
    }
  }
  return out;
}

// "Remove Object" — make the object cease to exist in the zone AND drop its change record(s),
// including any changes derived from it (collision prims built from this mesh). Reuses the
// canonical multi-delete: an ADD is dropped outright; a pre-existing object becomes a tracked
// DELETE so the next publish removes it. Undoable via Ctrl+Z.
function removeObject(c) {
  if (!c.entry) { forgetChange(c); return; }
  const targets = relatedEntries(c.entry).filter((t) => t && placements.includes(t));
  if (!targets.length) { forgetChange(c); return; }   // nothing in the scene to delete → just drop the record
  select(null);
  for (const t of targets) select(t, true);
  if (!selectedSet.size) { forgetChange(c); return; }   // all targets locked → nothing deletable
  deleteSelected();
  updateChangesUI();
}

// Publish is available whenever a zone is loaded — an EMPTY change-set included.
//
// This used to be gated on "would publishing change anything?", which sounds right but
// left no way to push a revert: publish resets from pristine and re-applies, so a
// contentless publish is exactly how you (a) undo everything and bake that back to the
// DAT, and (b) drop objects baked by an earlier publish. Both were unreachable because
// the button disabled itself the moment the change list emptied. Deciding a publish is
// pointless is the user's call, not ours, and a no-op publish costs a second.
function publishEnabled() {
  return !!currentZoneUrl;
}
function syncPublishState() {
  const qp = document.getElementById('quick-publish');
  if (qp) qp.disabled = !publishEnabled();
}

// "Strip Baked Collision" only makes sense for CUSTOM zones (ID >= 400) that ship with
// template collision. Official zones (ID < 400) already carry their real collision, so wiping
// it on Publish is destructive — force the toggle OFF and HIDE its row entirely for them. The
// user's saved preference is never clobbered: it's restored verbatim whenever a custom zone is
// loaded, and the forced-off state is applied to the live variable only (not persisted).
function applyClearCollisionPolicy() {
  const el = document.getElementById('toggle-clear-collision');
  const zid = currentZoneId();
  // Hide + force-off ONLY for a KNOWN official zone (numeric id < 400). An unresolved id
  // (null — custom zone not yet matched in customZonesData, timing/path) must NOT hide it,
  // or custom zones like 401 lose the checkbox. Custom zones (>= 400) and unknown both show.
  const official = (typeof zid === 'number' && zid < 400);
  clearCollisionOnReset = official ? false : loadProjectSetting('clearCollisionOnReset', false);
  if (el) el.checked = clearCollisionOnReset;
  const row = document.getElementById('row-strip-collision');
  if (row) row.style.display = official ? 'none' : '';
  syncPublishState();
}

function updateChangesUI() {
  if (!changesBadge) return;
  const list = collectChanges();
  const markers = collectMarkerChanges();
  const musicEntries = Object.keys(musicChanges);
  const stripCount = stripActive() ? 1 : 0;
  const footstepCount = footstepSourceZone ? 1 : 0;
  const total = list.length + markers.length + musicEntries.length + stripCount + footstepCount;
  changesBadge.textContent = total;
  changesBadge.classList.toggle('hidden', total === 0);
  if (exportJsonBtn) exportJsonBtn.disabled = total === 0;
  if (exportCmdsBtn) exportCmdsBtn.disabled = total === 0;
  syncPublishState();
  if (overlayBtnsReady) syncOverlayBtns();
  scheduleAutoSave();   // auto-save (no-op unless enabled; debounced + signature-gated)
  if (!changesPanel.classList.contains('open')) return;
  changesList.innerHTML = '';
  if (!total) { changesList.innerHTML = '<div class="empty">No changes yet</div>'; return; }

  const entryType = (c) => {
    const e = c.entry;
    if (e?.isCollisionPrimitive) return 'COLLISION';
    if (e?.isSound) return 'SFX';
    if (e?.isEffect) return 'VFX';
    if (e?.isMarker) return 'MARKER';
    if (e?.isSky) return 'SKY';
    return 'OBJECT';
  };

  const showMain = !cfType || cfType !== 'MARKER';
  const showMarkers = !cfType || cfType === 'MARKER';

  const needle = cfSearch.toLowerCase();
  const filteredList = showMain ? list.filter(c => {
    if (cfType && entryType(c) !== cfType) return false;
    if (cfOp && c.op !== cfOp) return false;
    if (cfSrc === 'internal' && c.op === 'add' && c.sourceZone) return false;
    if (cfSrc === 'external' && !(c.op === 'add' && c.sourceZone)) return false;
    if (needle && !c.name.toLowerCase().includes(needle)) return false;
    return true;
  }) : [];

  const filteredMarkers = showMarkers ? markers.filter(m => !needle || m.name.toLowerCase().includes(needle)) : [];
  // Music slot changes — shown when no Type filter is set (they aren't object/marker types).
  const filteredMusic = (!cfType) ? musicEntries.filter(slot => !needle || _MUSIC_SLOT_NAME[slot].includes(needle)) : [];
  // "Remove sub-areas + zone lines" — a single zone-level entry, shown when unfiltered.
  const showStrip = stripCount && !cfType && (!needle || 'sub-areas zone lines'.includes(needle));
  const showFootsteps = footstepCount && !cfType && (!needle || 'footsteps footstep source sound sfx'.includes(needle));

  if (!filteredList.length && !filteredMarkers.length && !filteredMusic.length && !showStrip && !showFootsteps) {
    changesList.innerHTML = '<div class="empty">No changes match the current filter</div>';
    return;
  }

  if (showStrip) {
    const row = document.createElement('div');
    row.className = 'change-strip-row';
    row.innerHTML = `<span class="tag tag-type">ZONE</span> Remove sub-areas + zone lines `
      + `<button class="change-strip-undo" title="Keep the sub-areas / zone lines (reloads the zone)">restore</button>`;
    row.querySelector('.change-strip-undo')?.addEventListener('click', () => { toggleStripInteractions(); });
    changesList.appendChild(row);
  }

  if (showFootsteps) {
    const row = document.createElement('div');
    row.className = 'change-strip-row';
    row.innerHTML = `<span class="tag tag-type">SFX</span> Footsteps from ${zoneNameForPath(footstepSourceZone)} `
      + `<button class="change-strip-undo" title="Do not copy footstep sound pointers on Publish">clear</button>`;
    row.querySelector('.change-strip-undo')?.addEventListener('click', () => {
      footstepSourceZone = '';
      syncFootstepSourceUI();
      updateChangesUI();
    });
    changesList.appendChild(row);
  }

  if (filteredList.length) {
    const table = document.createElement('table');
    table.className = 'changes-table';
    table.innerHTML = '<thead><tr><th>Object</th><th>Op</th><th>Type</th><th>Source</th><th>Time</th><th></th></tr></thead>';
    const body = document.createElement('tbody');
    const byTs = (a, b) => (b.ts || 0) - (a.ts || 0) || (b.seq || 0) - (a.seq || 0);
    const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    for (const c of [...filteredList].sort(byTs)) {
      const row = document.createElement('tr');
      row.className = c.op === 'delete' ? 'deleted' : '';
      const src = (c.op === 'add' && c.sourceZone)
        ? `<td class="src-dat" title="${c.sourceZone}">${c.sourceZone}</td>`
        : `<td><span class="tag tag-internal">internal</span></td>`;
      row.innerHTML = `<td class="name">${c.name}</td><td><span class="tag tag-op tag-op-${c.op}">${c.op}</span></td>` +
        `<td><span class="tag tag-type">${entryType(c)}</span></td>` +
        src + `<td class="change-time">${fmtTime(c.ts)}</td>` +
        `<td class="row-actions"><button class="row-menu" title="Actions — or right-click the row">⋮</button></td>`;
      row.onclick = () => { if (c.op !== 'delete') { select(c.entry); focusSelected(); } };
      // Right-click the row (or click the ⋮) for the action menu. Three distinct verbs:
      //  • Undo Change             — reverse this edit (re-delete an add, restore a delete, revert a move)
      //  • Remove Object           — delete the object + this change + any change derived from it (its collision)
      //  • Remove from Change History — stop tracking only; the object stays exactly as it is now
      const _rowMenu = (e) => openContextMenu(e, (addItem, addDivider) => {
        addItem('Undo Change', () => revertChange(c), { icon: 'undo' });
        addItem('Remove Object', () => removeObject(c), { icon: 'delete', danger: true, disabled: c.op === 'delete' });
        addDivider();
        addItem('Remove from Change History', () => forgetChange(c), { icon: 'playlist_remove' });
      });
      row.addEventListener('contextmenu', _rowMenu);
      row.querySelector('.row-menu').onclick = (e) => { e.stopPropagation(); _rowMenu(e); };
      body.appendChild(row);
    }
    table.appendChild(body);
    changesList.appendChild(table);
  }

  if (filteredMarkers.length) {
    const head = document.createElement('div');
    head.className = 'section-title';
    head.textContent = `Markers (${filteredMarkers.length})`;
    changesList.appendChild(head);
    const table = document.createElement('table');
    table.className = 'changes-table';
    table.innerHTML = '<thead><tr><th>Name</th><th>Type</th><th>Icon</th><th></th></tr></thead>';
    const body = document.createElement('tbody');
    for (const m of filteredMarkers) {
      const row = document.createElement('tr');
      row.innerHTML = `<td class="name">${m.name}</td><td><span class="tag">${m.type}</span></td>` +
        `<td>${m.icon}.png</td><td><button class="revert">REMOVE</button></td>`;
      row.onclick = () => { select(m.entry); focusSelected(); };
      row.querySelector('.revert').onclick = (e) => {
        e.stopPropagation();
        select(m.entry);
        deleteSelected();
      };
      body.appendChild(row);
    }
    table.appendChild(body);
    changesList.appendChild(table);
  }

  if (filteredMusic.length) {
    const head = document.createElement('div');
    head.className = 'section-title';
    head.textContent = `Music (${filteredMusic.length})`;
    changesList.appendChild(head);
    const table = document.createElement('table');
    table.className = 'changes-table';
    table.innerHTML = '<thead><tr><th>Change</th><th>New track</th><th></th></tr></thead>';
    const body = document.createElement('tbody');
    for (const slot of filteredMusic) {
      const id = musicChanges[slot] || 0;
      const row = document.createElement('tr');
      row.innerHTML = `<td class="name">${_MUSIC_SLOT_NAME[slot]}</td><td>${id ? '#' + id : 'None (silent)'}</td>` +
        `<td class="row-actions"><button class="revert">UNDO</button></td>`;
      row.querySelector('.revert').onclick = () => revertMusicChange(slot);
      body.appendChild(row);
    }
    table.appendChild(body);
    changesList.appendChild(table);
  }
}

// Save a blob to disk. Uses the File System Access API (native Save dialog —
// pick folder + filename) when available; falls back to an auto-download to the
// browser's Downloads folder on browsers that lack it (e.g. Firefox).
async function saveBlob(blob, suggestedName, description, accept) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description, accept }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // user cancelled the dialog
      // Any other failure: fall through to the legacy download below.
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = suggestedName; a.click();
  URL.revokeObjectURL(a.href);
}

async function exportChanges() {
  const data = snapshotChanges();
  if (!snapshotHasContent(data)) { await xi_alert('Export', 'No changes to export.'); return; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  await saveBlob(blob, 'zone-changes.json', 'Zone changes JSON', { 'application/json': ['.json'] });
}

async function exportCommands() {
  const { placements, vfx } = getChanges();
  const plc = placements.filter((c) => c.name);
  if (!plc.length && !vfx.length) { await xi_alert('Export', 'No changes to export.'); return; }
  const zoneVal = document.getElementById('zone').value;
  // Strip the "game/" junction prefix to get a plain ROM/x/y.DAT path for the CLI.
  const datPath = zoneVal.replace(/^game\//, '');
  const zoneName = document.getElementById('zone').selectedOptions?.[0]?.text || datPath;
  const lines = [];
  lines.push(`# xi zone edit commands — ${zoneName}`);
  lines.push(`# Zone: ${datPath}`);
  lines.push('');
  const plcModify = plc.filter((c) => c.op === 'modify');
  const plcAdd    = plc.filter((c) => c.op === 'add');
  const plcDelete = plc.filter((c) => c.op === 'delete');
  const trs3 = (a) => (a || []).map((v) => +v.toFixed(3)).join(' ');
  if (plcModify.length) {
    lines.push(`# Move/rotate/scale placements (${plcModify.length}):`);
    for (const c of plcModify) {
      lines.push(`xi zone object set-placement ${datPath} ${c.name} --pos ${trs3(c.pos)} --rot ${trs3(c.rot)} --scale ${trs3(c.scale)}`);
    }
    lines.push('');
  }
  if (plcAdd.length) {
    const glbAdds      = plcAdd.filter(c =>  c.glb);
    const sameZoneAdds = plcAdd.filter(c => !c.glb && !c.sourceZone);
    const xzoneAdds    = plcAdd.filter(c => !c.glb &&  c.sourceZone);
    if (glbAdds.length) {
      const isAbs = (s) => /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(s || '');   // drive / root / UNC
      const allAbs = glbAdds.every(c => isAbs(c.glb));
      lines.push(allAbs
        ? `# GLB model injects (${glbAdds.length}) — brand-new mesh from a GLB file (absolute paths; runs as-is):`
        : `# GLB model injects (${glbAdds.length}) — brand-new mesh from a GLB file (place the .glb next to where you run this, or edit the path):`);
      for (const c of glbAdds) {
        const shadeArg = (c.lit && c.shade != null && c.shade !== 1) ? ` --shade ${+c.shade.toFixed(2)}` : '';
        const opaqueArg = c.opaque ? ' --no-alpha' : '';
        const twoSidedArg = c.doubleSided ? ' --two-sided' : '';
        const glbArg = /\s/.test(c.glb || '') ? `"${c.glb}"` : c.glb;   // quote paths with spaces
        lines.push(`xi zone object import ${datPath} ${glbArg} --name ${c.name} --pos ${trs3(c.pos)} --rot ${trs3(c.rot)} --scale ${trs3(c.scale)}${shadeArg}${opaqueArg}${twoSidedArg}`);
      }
      lines.push('');
    }
    if (sameZoneAdds.length) {
      lines.push(`# Duplicate placements (${sameZoneAdds.length}) — object clone takes --pos only (rot/scale via object set-placement after):`);
      for (const c of sameZoneAdds) lines.push(`xi zone object clone ${datPath} ${c.name} --pos ${trs3(c.pos)}`);
      lines.push('');
    }
    if (xzoneAdds.length) {
      lines.push(`# Cross-zone copies (${xzoneAdds.length}) — mesh copied from another zone:`);
      for (const c of xzoneAdds) {
        const srcLabel = c.sourceName ? ` # originally: ${c.sourceName}` : '';
        lines.push(`xi zone object clone --from ${c.sourceZone} ${datPath} ${c.name} --pos ${trs3(c.pos)} --rot ${trs3(c.rot)} --scale ${trs3(c.scale)}${srcLabel}`);
      }
      lines.push('');
    }
  }
  if (plcDelete.length) {
    lines.push(`# Delete placements (${plcDelete.length}):`);
    for (const c of plcDelete) lines.push(`xi zone object delete ${datPath} ${c.name}`);
    lines.push('');
  }
  const vfxRemove = vfx.filter((c) => c.op === 'remove' && c.id);
  const vfxModify = vfx.filter((c) => c.op === 'modify' && c.id);
  const vfxAdd    = vfx.filter((c) => c.op === 'add' && (c.id || c.source_id));
  if (vfxRemove.length) {
    lines.push(`# Remove VFX (${vfxRemove.length}):`);
    for (const c of vfxRemove) lines.push(`xi fx delete ${datPath} ${c.id}`);
    lines.push('');
  }
  if (vfxModify.length) {
    lines.push(`# Modify VFX position/scale (${vfxModify.length}):`);
    for (const c of vfxModify) {
      const parts = [`xi fx set ${datPath} ${c.id}`];
      if (c.pos) parts.push(`--pos ${c.pos.join(' ')}`);
      if (c.scale) parts.push(`--scale ${c.scale.join(' ')}`);
      lines.push(parts.join(' '));
    }
    lines.push('');
  }
  const vfxAddSame  = vfxAdd.filter(c => !c.source_dat);
  const vfxAddXZone = vfxAdd.filter(c =>  c.source_dat);
  if (vfxAddSame.length) {
    lines.push(`# Add VFX (${vfxAddSame.length}) — same zone clone:`);
    for (const c of vfxAddSame) {
      const parts = [`xi fx copy ${datPath} ${c.source_id}`];
      if (c.new_id) parts.push(`--name ${c.new_id}`);
      if (c.pos) parts.push(`--pos ${c.pos.join(' ')}`);
      lines.push(parts.join(' '));
    }
    lines.push('');
  }
  if (vfxAddXZone.length) {
    lines.push(`# Add VFX/SFX from other zones (${vfxAddXZone.length}):`);
    for (const c of vfxAddXZone) {
      const srcDat = /\s/.test(c.source_dat) ? `"${c.source_dat}"` : c.source_dat;
      const parts = [`xi fx copy ${datPath} ${c.source_id} --from ${srcDat}`];
      if (c.new_id) parts.push(`--name ${c.new_id}`);
      if (c.pos) parts.push(`--pos ${c.pos.map(v => +v.toFixed(3)).join(' ')}`);
      lines.push(parts.join(' '));
    }
    lines.push('');
  }
  if (!plc.length && !vfx.length) lines.push('# No changes to export.');
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  await saveBlob(blob, 'zone-changes.commands.txt', 'xi zone commands', { 'text/plain': ['.txt'] });
}

// ── draggable modal windows (Changes, Settings) ─────────────────────────────
let zTop = 30;
function bringToFront(modal) { modal.style.zIndex = ++zTop; }

// ── Generic confirm / alert dialog ──────────────────────────────────────────
let _xiDlgResolve = null;
// Render dialog body text: HTML-escape, then turn `backtick` spans into <code>.
// (newlines are preserved by .xi-dlg-msg { white-space: pre-wrap }.)
function dlgBodyHtml(body) {
  const esc = String(body).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return esc.replace(/`([^`]+)`/g, '<code>$1</code>');
}
function showXiDlg({ title, body, okText = 'OK', cancelText = 'Cancel', showCancel = true, info = false, danger = false }) {
  return new Promise(resolve => {
    _xiDlgResolve = resolve;
    const panel = document.getElementById('xi-dialog-panel');
    document.getElementById('xi-dialog-title').textContent = title;
    document.getElementById('xi-dialog-msg').innerHTML = dlgBodyHtml(body);
    const okBtn = document.getElementById('xi-dialog-ok');
    okBtn.textContent = okText;
    okBtn.className = (info && !danger) ? 'nz-create-btn' : 'dz-delete-btn';
    const cancelBtn = document.getElementById('xi-dialog-cancel');
    cancelBtn.textContent = cancelText;
    cancelBtn.style.display = showCancel ? '' : 'none';
    const iconEl = document.getElementById('xi-dialog-icon');
    if (danger) {
      iconEl.className = 'xi-dlg-icon xi-dlg-danger';
      iconEl.innerHTML = '<img src="data:image/png;base64,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">';
    } else {
      iconEl.className = 'xi-dlg-icon' + (info ? ' xi-dlg-info' : '');
      iconEl.textContent = info ? 'i' : '!';
    }
    panel.classList.toggle('xi-danger', danger);
    panel.classList.add('open');
    bringToFront(panel);
    (showCancel ? cancelBtn : okBtn).focus();
  });
}
function xi_confirm(title, body, okText = 'OK', cancelText = 'Cancel') {
  return showXiDlg({ title, body, okText, cancelText, showCancel: true, info: false });
}
function xi_alert(title, body, okText = 'OK') {
  return showXiDlg({ title, body, okText, showCancel: false, info: true });
}
function xi_danger(title, body, okText = 'OK') {
  return showXiDlg({ title, body, okText, showCancel: false, danger: true });
}
// Programmatically close whatever generic dialog is open (resolving its promise).
function dismissXiDlg(v = false) {
  const p = document.getElementById('xi-dialog-panel');
  if (!p?.classList.contains('open')) return;
  p.classList.remove('open');
  if (_xiDlgResolve) { const r = _xiDlgResolve; _xiDlgResolve = null; r(v); }
}

function openModal(modal, anchor) {
  const firstOpen = !modal.dataset.positioned;
  modal.classList.add('open');
  if (firstOpen) { // Start near the button once, then remember any dragged spot.
    const w = modal.offsetWidth;
    const panelW = document.getElementById('panel')?.offsetWidth || 300;
    const editorRight = window.innerWidth - panelW;
    const r = anchor?.getBoundingClientRect();
    const preferredLeft = r ? r.left : Math.round(editorRight / 2 - w / 2);
    const maxLeft = Math.max(12, editorRight - w - 12);
    modal.style.left = Math.min(Math.max(12, preferredLeft), maxLeft) + 'px';
    modal.style.top = (r ? r.bottom + 8 : 56) + 'px';
    modal.dataset.positioned = '1';
  }
  bringToFront(modal);
}
function toggleModal(modal, anchor) { modal.classList.contains('open') ? modal.classList.remove('open') : openModal(modal, anchor); }

// Window-style drag by the title bar.
// Panels with a remembered id (assets-panel, changes-panel, settings-panel) have their
// position saved to localStorage on drop and restored on init.
const REMEMBERED_PANELS = new Set(['assets-panel', 'changes-panel', 'settings-panel']);
function makeDraggable(modal) {
  const bar = modal.querySelector('.modal-bar');
  const posKey = modal.id && REMEMBERED_PANELS.has(modal.id) ? `panelPos_${modal.id}` : null;

  // Restore saved position, clamped to the current viewport.
  if (posKey) {
    const saved = loadSetting(posKey, '');
    if (saved) {
      const [lx, ly] = saved.split(',').map(Number);
      if (!isNaN(lx) && !isNaN(ly)) {
        modal.style.left = Math.min(Math.max(lx, 0), window.innerWidth  - 80) + 'px';
        modal.style.top  = Math.min(Math.max(ly, 0), window.innerHeight - 30) + 'px';
        modal.dataset.positioned = '1';
      }
    }
  }

  let sx, sy, ox, oy, dragging = false;
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.modal-close, .modal-min')) return;
    dragging = true; bar.setPointerCapture(e.pointerId);
    const r = modal.getBoundingClientRect();
    modal.style.left = r.left + 'px'; modal.style.top = r.top + 'px';
    modal.dataset.positioned = '1';
    sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    bringToFront(modal);
  });
  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const nx = Math.min(Math.max(ox + (e.clientX - sx), 0), window.innerWidth - 80);
    const ny = Math.min(Math.max(oy + (e.clientY - sy), 0), window.innerHeight - 30);
    modal.style.left = nx + 'px'; modal.style.top = ny + 'px';
  });
  const end = (e) => {
    if (dragging && posKey) saveSetting(posKey, `${parseInt(modal.style.left)},${parseInt(modal.style.top)}`);
    dragging = false;
    try { bar.releasePointerCapture(e.pointerId); } catch {}
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  modal.addEventListener('pointerdown', () => bringToFront(modal));
}

const settingsBtn = document.getElementById('settings-btn');
const changesPanel = document.getElementById('changes-panel');
const changesBtn = document.getElementById('changes-btn');
const changesBadge = document.getElementById('changes-badge');
const changesList = document.getElementById('changes-list');
const exportCmdsBtn = document.querySelector('[data-action="export-cmds"]');
const exportJsonBtn = document.querySelector('[data-action="export-json"]');
let cfType = '', cfSrc = '', cfOp = '', cfSearch = '';
const settingsPanel = document.getElementById('settings-panel');
const helpPanel = document.getElementById('help-panel');
[changesPanel, settingsPanel, helpPanel, document.getElementById('perf-panel'), document.getElementById('assets-panel'), document.getElementById('database-panel'), document.getElementById('new-zone-panel'), document.getElementById('delete-zone-panel'), document.getElementById('reset-done-panel'), document.getElementById('version-panel'), document.getElementById('xi-dialog-panel'), document.getElementById('evt-dialog-modal'), document.getElementById('evt-zone-peek-modal'), document.getElementById('category-modal'), document.getElementById('manage-groups-modal'), document.getElementById('make-template-panel'), document.getElementById('cs-author-modal'), document.getElementById('cs-create-event-modal')].forEach((m) => m && makeDraggable(m));
{ // "Add to Category" modal
  const catModal = document.getElementById('category-modal');
  const newIn = document.getElementById('cat-new');
  document.getElementById('cat-apply')?.addEventListener('click', applyCategoryModal);
  document.getElementById('cat-cancel')?.addEventListener('click', () => catModal?.classList.remove('open'));
  newIn?.addEventListener('keydown', (e) => {
    e.stopPropagation();   // don't let editor hotkeys fire while typing
    if (e.key === 'Enter') applyCategoryModal();
    else if (e.key === 'Escape') catModal?.classList.remove('open');
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && catModal?.classList.contains('open')) { e.stopPropagation(); catModal.classList.remove('open'); } }, true);
}
{ // "Manage Groups" modal
  const mgModal = document.getElementById('manage-groups-modal');
  const nameIn = document.getElementById('mg-name');
  document.getElementById('mg-save')?.addEventListener('click', saveManageGroups);
  document.getElementById('mg-cancel')?.addEventListener('click', () => mgModal?.classList.remove('open'));
  nameIn?.addEventListener('keydown', (e) => {
    e.stopPropagation();   // don't let editor hotkeys fire while typing
    if (e.key === 'Enter') saveManageGroups();
    else if (e.key === 'Escape') mgModal?.classList.remove('open');
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mgModal?.classList.contains('open')) { e.stopPropagation(); mgModal.classList.remove('open'); } }, true);
}
{ const _dlgClose = (v) => { document.getElementById('xi-dialog-panel').classList.remove('open'); if (_xiDlgResolve) { const r = _xiDlgResolve; _xiDlgResolve = null; r(v); } };
  document.getElementById('xi-dialog-ok')?.addEventListener('click', () => _dlgClose(true));
  document.getElementById('xi-dialog-cancel')?.addEventListener('click', () => _dlgClose(false));
  document.getElementById('xi-dialog-x')?.addEventListener('click', () => _dlgClose(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.getElementById('xi-dialog-panel')?.classList.contains('open')) { e.stopPropagation(); _dlgClose(false); } }, true);
}
document.getElementById('reset-done-ok')?.addEventListener('click', () => document.getElementById('reset-done-panel')?.classList.remove('open'));
document.querySelectorAll('.modal-close').forEach((b) => {
  b.onclick = () => document.getElementById(b.dataset.close).classList.remove('open');
});
// Give every panel modal a title-bar minimize / maximize toggle. Injected here (once) so we
// don't hand-add the button to each modal's markup. Collapses the modal to just its title bar
// (hides every non-bar child — some panels put a filter/status bar outside .modal-body); a
// second click restores it. Applies to modals with a standard .modal-close[data-close] so the
// specialised sub-dialogs (confirm prompt, zone-music, db-edit) are left alone.
document.querySelectorAll('.modal').forEach((modal) => {
  const bar = modal.querySelector(':scope > .modal-bar');
  if (!bar) return;
  const closeBtn = bar.querySelector('.modal-close[data-close]');
  if (!closeBtn || closeBtn.parentElement !== bar) return;
  if (bar.querySelector('.modal-min')) return;                 // never double-inject
  const minBtn = document.createElement('button');
  minBtn.className = 'modal-min';
  minBtn.title = 'Minimize';
  minBtn.innerHTML = '<span class="material-symbols-outlined">remove</span>';
  minBtn.onclick = () => {
    const collapsed = modal.classList.toggle('is-minimized');
    minBtn.querySelector('.material-symbols-outlined').textContent = collapsed ? 'crop_square' : 'remove';
    minBtn.title = collapsed ? 'Maximize' : 'Minimize';
  };
  // Group min + close together at the trailing edge (the bar uses justify-content: space-between).
  const actions = document.createElement('span');
  actions.className = 'modal-bar-actions';
  bar.insertBefore(actions, closeBtn);
  actions.appendChild(minBtn);
  actions.appendChild(closeBtn);
});
if (changesBtn) {
  changesBtn.onclick = () => { toggleModal(changesPanel, changesBtn); updateChangesUI(); };
}
const changesSearchEl = document.getElementById('changes-search');
if (changesSearchEl) changesSearchEl.addEventListener('input', () => { cfSearch = changesSearchEl.value.trim(); updateChangesUI(); });
document.querySelectorAll('[data-cf-type]').forEach(btn => {
  btn.addEventListener('click', () => {
    cfType = btn.dataset.cfType;
    document.querySelectorAll('[data-cf-type]').forEach(b => b.classList.toggle('active', b === btn));
    updateChangesUI();
  });
});
document.querySelectorAll('[data-cf-src]').forEach(btn => {
  btn.addEventListener('click', () => {
    cfSrc = btn.dataset.cfSrc;
    document.querySelectorAll('[data-cf-src]').forEach(b => b.classList.toggle('active', b === btn));
    updateChangesUI();
  });
});
document.querySelectorAll('[data-cf-op]').forEach(btn => {
  btn.addEventListener('click', () => {
    cfOp = btn.dataset.cfOp;
    document.querySelectorAll('[data-cf-op]').forEach(b => b.classList.toggle('active', b === btn));
    updateChangesUI();
  });
});
if (settingsBtn) settingsBtn.onclick = () => toggleModal(settingsPanel, settingsBtn);

// ── Settings nav ─────────────────────────────────────────────────────────────
{
  const snavBtns = document.querySelectorAll('.snav-btn');
  const spanes   = document.querySelectorAll('.spane');
  const _rawPane = loadSetting('settingsPane', 'editor');
  const _paneAliases = { viewport: 'editor', selection: 'editor', transformation: 'editor', navmesh: 'collision' };
  const savedPane = _paneAliases[_rawPane] ?? _rawPane;
  function activatePane(id) {
    snavBtns.forEach((b) => b.classList.toggle('active', b.dataset.spane === id));
    spanes.forEach((p) => p.classList.toggle('active', p.id === 'spane-' + id));
    saveSetting('settingsPane', id);
  }
  snavBtns.forEach((b) => b.addEventListener('click', () => activatePane(b.dataset.spane)));
  activatePane(savedPane);
}

// ── Settings → Setup (workspace, game paths, server + database, desktop icon) ──
// These read and write .env through the bridge, the same as the first-run wizard.
initSetupSettings();

// ── View dropdown menu ────────────────────────────────────────────────────────
const viewBtn = document.getElementById('view-btn');
const viewMenu = document.getElementById('view-menu');
function closeViewMenu() { viewMenu?.classList.remove('open'); }
function openViewMenu() {
  const r = viewBtn.getBoundingClientRect();
  viewMenu.style.left = r.left + 'px';
  viewMenu.style.top = (r.bottom + 6) + 'px';
  viewMenu.classList.add('open');
}
if (viewBtn && viewMenu) {
  viewBtn.onclick = (e) => {
    e.stopPropagation();
    viewMenu.classList.contains('open') ? closeViewMenu() : openViewMenu();
  };
  document.addEventListener('pointerdown', (e) => {
    if (viewMenu.classList.contains('open') && !viewMenu.contains(e.target) && e.target !== viewBtn) closeViewMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeViewMenu(); });
  viewMenu.querySelector('[data-action="grid"]').onclick = () => {
    grid.visible = !grid.visible;
    saveSetting('grid', grid.visible);
    if (gridToggle) gridToggle.checked = grid.visible;
    syncViewToggleBtns();
    closeViewMenu();
  };
  viewMenu.querySelector('[data-action="center"]').onclick = () => {
    originGizmo.visible = !originGizmo.visible;
    saveSetting('mapCenter', originGizmo.visible);
    if (mapCenterToggle) mapCenterToggle.checked = originGizmo.visible;
    syncViewToggleBtns();
    closeViewMenu();
  };
  viewMenu.querySelector('[data-action="sel-outline"]').onclick = () => {
    showOutline = !showOutline;
    saveSetting('outline', showOutline);
    if (outlineToggle) outlineToggle.checked = showOutline;
    updateSelectionOutline();
    syncViewToggleBtns();
    closeViewMenu();
  };
  viewMenu.querySelector('[data-action="hover-outline"]').onclick = () => {
    showHoverOutline = !showHoverOutline;
    saveSetting('hoverOutline', showHoverOutline);
    if (hoverOutlineToggle) hoverOutlineToggle.checked = showHoverOutline;
    if (!showHoverOutline) { hovered = null; clearOutline(getHoverOutline()); }
    updateHoverOutline();
    syncViewToggleBtns();
    closeViewMenu();
  };
  viewMenu.querySelector('[data-action="wireframe"]').onclick = () => {
    wireframe = !wireframe;
    saveSetting('wireframe', wireframe);
    if (wireToggle) wireToggle.checked = wireframe;
    applyWireframe();
    syncViewToggleBtns();
    closeViewMenu();
  };
  viewMenu.querySelector('[data-action="perf"]').onclick = () => {
    toggleModal(perfPanel, viewBtn);
    closeViewMenu();
  };
  viewMenu.querySelector('[data-action="reset-windows"]').onclick = () => {
    resetWindows();
    closeViewMenu();
  };
}

// Cascade every floating window back on-screen from the top-left, XP-style —
// each offset 20px further down-right so stacked/off-screen modals are all reachable.
function resetWindows() {
  const base = 16, step = 20;
  let i = 0;
  document.querySelectorAll('.modal').forEach((modal) => {
    const off = base + (i++) * step;
    // Clamp so a long cascade can't itself march a window off the bottom/right.
    const left = Math.min(off, Math.max(12, window.innerWidth - 80));
    const top  = Math.min(off, Math.max(12, window.innerHeight - 30));
    modal.style.left = left + 'px';
    modal.style.top = top + 'px';
    modal.dataset.positioned = '1';
    modal.style.zIndex = ++zTop;
    // Persist for the panels whose position is remembered across reloads.
    if (modal.id && REMEMBERED_PANELS.has(modal.id)) saveSetting(`panelPos_${modal.id}`, `${left},${top}`);
  });
}

// ── Performance panel ────────────────────────────────────────────────────────
// Live renderer stats, refreshed from the render loop only while the panel is open.
const perfPanel = document.getElementById('perf-panel');
const _perfEls = {
  fps: document.getElementById('perf-fps'), frame: document.getElementById('perf-frame'),
  dc: document.getElementById('perf-dc'), tri: document.getElementById('perf-tri'),
  prog: document.getElementById('perf-prog'), geo: document.getElementById('perf-geo'),
  tex: document.getElementById('perf-tex'), plc: document.getElementById('perf-plc'),
};
const _fmtCount = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : String(n);
function updatePerfPanel() {
  if (!perfPanel || !perfPanel.classList.contains('open')) return;
  const info = renderer.info;
  _perfEls.fps.textContent = String(_fpsLast);
  _perfEls.frame.textContent = _fpsLast ? (1000 / _fpsLast).toFixed(1) + ' ms' : '--';
  _perfEls.dc.textContent = String(_dcLast);
  _perfEls.tri.textContent = _fmtCount(_triLast);
  _perfEls.prog.textContent = String(info.programs ? info.programs.length : 0);
  _perfEls.geo.textContent = String(info.memory.geometries);
  _perfEls.tex.textContent = String(info.memory.textures);
  _perfEls.plc.textContent = String(typeof placements !== 'undefined' ? placements.length : 0);
  _syncCullUI();   // keep the "hiding N" readout live while the panel is open
}

// ── Distance culling (perf) ──────────────────────────────────────────────────
// Hides small/distant placements past a draw distance to cut draw calls on the
// whole-zone vista (the 16k-draw-call case). Big geometry (terrain/buildings) and
// the current selection are always kept. Per-node bounding sphere is cached; static
// placements never move, so the per-frame cost is just a distanceTo per object.
let cullEnabled = loadSetting('distCull', false);
let cullDistPct = clampSnapValue(Number(loadSetting('distCullPct', 60)), 5, 100, 60); // % of zone diagonal
let _cullDiag = 4000;          // world units; recomputed when the placement count changes
let _cullSeenN = -1, _cullCount = 0;
const _camWP = new THREE.Vector3(), _cullTmp = new THREE.Vector3();
const ANG_KEEP = 0.12;         // objects subtending ≥ this (radius/dist) never cull — keeps terrain/buildings
function _cullEligible(p) {
  return p && p.node && !p.isSky && !p.isMarker && !p.isEffect && !p.isSound && !p.isCollisionPrimitive;
}
function _ensureCullData(node) {
  if (node.userData._cullR !== undefined) return;
  const box = new THREE.Box3().setFromObject(node);
  if (box.isEmpty()) { node.userData._cullR = 0; node.userData._cullP = node.getWorldPosition(new THREE.Vector3()); return; }
  const sph = box.getBoundingSphere(new THREE.Sphere());
  node.userData._cullR = sph.radius; node.userData._cullP = sph.center.clone();
}
function _rebuildCullCache() {
  const gbox = new THREE.Box3();
  for (const p of placements) {
    if (!_cullEligible(p)) continue;
    _ensureCullData(p.node);
    const r = p.node.userData._cullR, c = p.node.userData._cullP;
    gbox.expandByPoint(_cullTmp.copy(c).addScalar(r));
    gbox.expandByPoint(_cullTmp.copy(c).addScalar(-r));
  }
  if (!gbox.isEmpty()) _cullDiag = gbox.getSize(_cullTmp).length() || _cullDiag;
}
function uncullAll() {
  for (const p of placements) {
    const n = p?.node;
    if (n && n.userData._distCulled) { n.visible = true; n.userData._distCulled = false; }
  }
  _cullCount = 0;
}
function updateDistanceCull() {
  if (!cullEnabled || !placements.length) return;
  if (_cullSeenN !== placements.length) { _rebuildCullCache(); _cullSeenN = placements.length; }
  const cam = cutsceneCamActive ? csCamera : camera;
  cam.getWorldPosition(_camWP);
  const maxD = (cullDistPct / 100) * _cullDiag;
  let culled = 0;
  for (const p of placements) {
    if (!_cullEligible(p)) continue;
    const node = p.node;
    // Never cull the active selection (you may be editing a far object).
    if (node === selected || selectedSet.has(node)) {
      if (node.userData._distCulled) { node.visible = true; node.userData._distCulled = false; }
      node.userData._cullP = null; node.userData._cullR = undefined; _ensureCullData(node); // refresh moved pos
      continue;
    }
    // Leave user-hidden objects alone (only un-hide what WE culled).
    if (!node.userData._distCulled && !node.visible) continue;
    _ensureCullData(node);
    const r = node.userData._cullR || 0;
    const dist = _camWP.distanceTo(node.userData._cullP);
    const cull = dist > maxD && (r / dist) < ANG_KEEP;
    if (cull) {
      if (node.visible) node.visible = false;
      node.userData._distCulled = true; culled++;
    } else if (node.userData._distCulled) {
      node.visible = true; node.userData._distCulled = false;
    }
  }
  _cullCount = culled;
}

// Cull panel wiring
const _cullEnableEl = document.getElementById('cull-enable');
const _cullDistEl = document.getElementById('cull-dist');
const _cullDistValEl = document.getElementById('cull-dist-val');
const _cullCountEl = document.getElementById('cull-count');
const _cullSliderRow = document.getElementById('cull-slider-row');
function _syncCullUI() {
  if (_cullEnableEl) _cullEnableEl.checked = cullEnabled;
  if (_cullDistEl) _cullDistEl.value = String(cullDistPct);
  if (_cullDistValEl) _cullDistValEl.textContent = cullDistPct + '%';
  if (_cullSliderRow) _cullSliderRow.classList.toggle('disabled', !cullEnabled);
  if (_cullCountEl) _cullCountEl.textContent = cullEnabled ? `hiding ${_cullCount}` : '';
}
if (_cullEnableEl) {
  _cullEnableEl.addEventListener('change', () => {
    cullEnabled = _cullEnableEl.checked;
    saveSetting('distCull', cullEnabled);
    if (cullEnabled) { _cullSeenN = -1; } else { uncullAll(); }
    _syncCullUI();
  });
}
if (_cullDistEl) {
  _cullDistEl.addEventListener('input', () => {
    cullDistPct = Number(_cullDistEl.value);
    saveSetting('distCullPct', cullDistPct);
    _syncCullUI();
  });
}
_syncCullUI();

// ── File dropdown menu (New / Import GLB / Export JSON / Export Commands) ─────
// A lightweight popover, not a draggable modal: clicking anywhere outside closes it.
const fileBtn = document.getElementById('file-btn');
const fileMenu = document.getElementById('file-menu');
const glbFileInput = document.getElementById('glb-file-input');
const jsonFileInput = document.getElementById('json-file-input');
function closeFileMenu() { fileMenu?.classList.remove('open'); }
// Editing actions require an active project + Edit mode. Browsing (View, no project)
// leaves only "Projects" enabled.
function syncFileMenuGating() {
  const editable = (getMode() === 'edit') && !launcherState.browseOnly;
  const inProject = !!launcherState.currentProject && !launcherState.browseOnly;
  const canPublish = editable && publishEnabled();
  fileMenu.querySelectorAll('button[data-action]').forEach((b) => {
    const a = b.dataset.action;
    // Help is always available, regardless of mode / project state.
    if (a === 'help') { b.disabled = false; return; }
    // New + Duplicate are project-level zone actions — usable in View, before/while a zone loads.
    if (a === 'new' || a === 'duplicate') { b.disabled = !inProject; return; }
    if (a === 'apply-game') { b.disabled = !canPublish; return; }   // Publish: needs Edit mode + a loaded zone
    b.disabled = !editable;
  });
  // NavMesh submenu items use ids, not data-action — gate them as edit-only too.
  for (const id of ['navmesh-refresh', 'navmesh-generate']) {
    const b = document.getElementById(id);
    if (b) b.disabled = !editable;
  }
}
function openFileMenu() {
  const r = fileBtn.getBoundingClientRect();
  fileMenu.style.left = r.left + 'px';
  fileMenu.style.top = (r.bottom + 6) + 'px';
  syncFileMenuGating();
  fileMenu.classList.add('open');
}
if (fileBtn && fileMenu) {
  fileBtn.onclick = (e) => {
    e.stopPropagation();
    fileMenu.classList.contains('open') ? closeFileMenu() : openFileMenu();
  };
  // Outside-click / Escape close (the behaviour that distinguishes a menu from a modal).
  document.addEventListener('pointerdown', (e) => {
    if (fileMenu.classList.contains('open') && !fileMenu.contains(e.target) && e.target !== fileBtn) closeFileMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFileMenu(); });
  fileMenu.querySelectorAll('button[data-action]').forEach((b) => {
    b.onclick = () => {
      closeFileMenu();
      switch (b.dataset.action) {
        case 'save':        saveToWorkspace(); break;
        case 'apply-game':     applyToGame(); break;
        case 'reset':          resetZone(); break;
        case 'reset-collision': resetCollision(); break;
        case 'clear-versions': clearVersionHistory(); break;
        case 'version-history': openVersionHistory(); break;
        case 'package-changes': packageChanges(); break;
        case 'new':            openNewZonePanel(); break;
        case 'make-template':  openMakeTemplatePanel(); break;
        case 'duplicate':      openDuplicateZonePanel(); break;
        case 'load':        jsonFileInput?.click(); break;
        case 'import':          importGlbViaPicker(); break;
        case 'import-sound':    document.getElementById('cb-sound-file')?.click(); break;
        case 'import-music':    document.getElementById('cb-music-file')?.click(); break;
        case 'import-col-obj':  importCollisionObjViaPicker(); break;
        case 'export-json': exportChanges(); break;
        case 'export-cmds': exportCommands(); break;
        case 'delete-zone': openDeleteZonePanel(); break;
        case 'help':        toggleModal(helpPanel, fileBtn); break;
      }
    };
  });
}

// Quick-action buttons in the topbar — mirror the matching File-menu items.
document.getElementById('quick-publish')?.addEventListener('click', () => applyToGame());
document.getElementById('quick-glb')?.addEventListener('click', () => importGlbViaPicker());
document.getElementById('quick-sfx')?.addEventListener('click', () => document.getElementById('cb-sound-file')?.click());
document.getElementById('quick-navmesh')?.addEventListener('click', () => document.getElementById('navmesh-generate')?.click());
if (glbFileInput) {
  glbFileInput.onchange = () => {
    const f = glbFileInput.files?.[0];
    glbFileInput.value = '';           // reset so picking the same file again re-fires change
    if (f) importGlbModel(f);
  };
}
if (jsonFileInput) {
  jsonFileInput.onchange = async () => {
    const f = jsonFileInput.files?.[0];
    jsonFileInput.value = '';
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); }
    catch (err) { setStatus(`load: invalid JSON — ${err.message}`, true); return; }
    loadChangesFromJson(data, f.name);
  };
}
{
  const objFileInput = document.getElementById('obj-file-input');
  if (objFileInput) {
    objFileInput.onchange = () => {
      const f = objFileInput.files?.[0];
      objFileInput.value = '';
      if (f) importCollisionFromOBJ(f);
    };
  }
}

// ── New Zone dialog ──────────────────────────────────────────────────────────
{
  const newZonePanel = document.getElementById('new-zone-panel');
  const nzTemplateEl = document.getElementById('nz-template');
  const nzCreateBtn  = document.getElementById('nz-create');
  const nzErrorEl    = document.getElementById('nz-error');

  nzCreateBtn?.addEventListener('click', async () => {
    if (!bridgeOnline()) { setStatus('Create needs the backend — run via `xi gui zone`', true); return; }
    const template = nzTemplateEl?.value || 'desert';
    const name = document.getElementById('nz-name')?.value.trim() || '';

    if (nzErrorEl) { nzErrorEl.textContent = ''; nzErrorEl.hidden = true; }
    nzCreateBtn.disabled = true;
    nzCreateBtn.textContent = 'Creating…';
    try {
      // 1. Save the current zone before switching away
      if (currentZoneUrl && bridgeOnline()) {
        try {
          const snap = snapshotChanges();
          await uploadGlbAssets(snap);
          await bridgeCall('zone.saveChanges', { zone: currentZoneUrl, changes: snap });
        } catch (saveErr) {
          console.warn('[new zone] save-current failed:', saveErr);
        }
      }

      // 2. Create the zone on the backend (copy template + register files + DB migration)
      const params = { template };
      if (name) params.name = name;
      const r = await bridgeCall('zone.new', params);
      if (!r?.datUrl) throw new Error('no datUrl in response');

      // 3. Close panel, refresh zone list, switch to new zone
      newZonePanel.classList.remove('open');
      await refreshCustomZones();
      const selEl = document.getElementById('zone');
      if (selEl) selEl.value = r.datUrl;
      await loadZone(r.datUrl);

      // 4. Auto-publish — initialises the workspace (zone-changes.json + v1 version entry).
      //    Calls zone.export directly with reset:false so the just-copied template is never
      //    deleted (no pristine copy exists in FFXI_DIR for brand-new zones).
      nzCreateBtn.textContent = 'Publishing…';
      try {
        await bridgeCall('zone.export', { zone: r.datUrl, changes: snapshotChanges(), reset: false, debug: false });
      } catch (pubErr) {
        console.warn('[new zone] auto-publish failed:', pubErr);
      }

      // 5. Success toast
      showNewZoneSuccess(r);

    } catch (e) {
      // Surface the error inside the panel (not just the easy-to-miss status bar)
      if (nzErrorEl) { nzErrorEl.textContent = `Error: ${e.message}`; nzErrorEl.hidden = false; }
      newZonePanel.classList.add('open');
      setStatus(`zone creation failed: ${e.message}`, true);
    } finally {
      nzCreateBtn.disabled = false;
      nzCreateBtn.textContent = 'Create';
    }
  });

  window.openNewZonePanel = function openNewZonePanel() {
    closeFileMenu();
    if (newZonePanel && !newZonePanel.classList.contains('open')) {
      newZonePanel.classList.add('open');
      bringToFront(newZonePanel);
      populateTemplates();
      document.getElementById('nz-name')?.focus();
    }
  };

  // Load all templates from the backend and populate the dropdown.
  async function populateTemplates() {
    if (!bridgeOnline() || !nzTemplateEl) return;
    try {
      const r = await bridgeCall('zone.templates', {});
      const templates = r?.templates || [];
      nzTemplateEl.innerHTML = '';
      if (!templates.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.disabled = true;
        opt.textContent = 'No templates — run File ▸ Package Changes ▸ Make Template first';
        nzTemplateEl.appendChild(opt);
        return;
      }
      for (const t of templates) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.label || t.id;
        if (t.description) opt.title = t.description;
        nzTemplateEl.appendChild(opt);
      }
      nzTemplateEl.selectedIndex = 0;
    } catch (e) { console.warn('[new zone] template list failed:', e); }
  }
}

// ── Make Template dialog ─────────────────────────────────────────────────────
{
  const mtPanel    = document.getElementById('make-template-panel');
  const mtCreate   = document.getElementById('mt-create');
  const mtErr      = document.getElementById('mt-error');
  const mtLabel    = document.getElementById('mt-label');
  const mtDesc     = document.getElementById('mt-description');
  const mtZoneInfo = document.getElementById('mt-zone-info');

  async function _populateMtZoneInfo(zid) {
    if (!mtZoneInfo) return;
    const esc = (s) => String(s ?? '—').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const row = (k, v) => `<div class="mt-info-row"><span class="mt-info-k">${esc(k)}</span><span class="mt-info-v">${esc(v)}</span></div>`;
    const name = document.getElementById('zone')?.selectedOptions?.[0]?.text || '—';
    let html = row('Zone ID', zid) + row('Name', name);
    try {
      const _r = await bridgeCall('zone.getSettings', { zoneId: zid });
      const s = (_r && !_r.error) ? _r : null;
      if (!s) throw new Error(_r?.error || 'no data');
      const TYPE_NAMES ={ 1:'City', 2:'Outdoors', 4:'Dungeon', 8:'Signet', 16:'Sanction', 32:'Sigil', 64:'Ionis', 128:'Dynamis', 256:'Instanced' };
      const MISC_NAMES = { 1:'Escape', 2:'Fellow', 4:'Mount', 8:'Mazurka', 16:'Tractor', 32:'Mog Menu', 64:'Costume', 128:'Pet', 256:'Treasure', 512:'AH', 1024:'Yell', 2048:'Trust', 4096:'LoS Player', 8192:'LoS Off', 16384:'Assist' };
      const flagStr = (val, names) => Object.entries(names).filter(([b]) => val & +b).map(([,n]) => n).join(', ') || 'None';
      html += row('Type', flagStr(s.zonetype || 0, TYPE_NAMES));
      html += row('Misc', flagStr(s.misc || 0, MISC_NAMES));
    } catch (err) { console.warn('[zone.getSettings]', err); html += row('Settings', err.message || 'DB unavailable'); }
    mtZoneInfo.innerHTML = html;
  }

  window.openMakeTemplatePanel = function openMakeTemplatePanel() {
    closeFileMenu();
    if (!bridgeOnline()) { setStatus('Make Template needs the backend — run via `xi gui zone`', true); return; }
    const zid = currentZoneId();
    if (!zid) { setStatus('Load a registered zone first — Make Template packages the current zone', true); return; }
    if (zid < 400) { setStatus(`Zone ${zid} is an original FFXI zone — Duplicate it first (File › Duplicate), then make a template from the copy.`, true); return; }
    if (mtErr) { mtErr.textContent = ''; mtErr.hidden = true; }
    if (mtZoneInfo) mtZoneInfo.innerHTML = '<span style="color:#555">Loading…</span>';
    if (mtPanel && !mtPanel.classList.contains('open')) {
      mtPanel.classList.add('open');
      bringToFront(mtPanel);
      mtLabel?.focus();
    }
    _populateMtZoneInfo(zid);
  };

  mtCreate?.addEventListener('click', async () => {
    if (!bridgeOnline()) { setStatus('Make Template needs the backend', true); return; }
    const zid = currentZoneId();
    const setErr = (m) => { if (mtErr) { mtErr.textContent = m; mtErr.hidden = false; } };
    if (!zid) { setErr('No current zone id — load a registered zone.'); return; }
    const label = (mtLabel?.value || '').trim();
    if (!label) { setErr('Enter a name.'); return; }
    if (!confirm(`Create template "${label}" from zone ${zid}?\n\nThis will snapshot the current Published DATs and zone DB settings into a new bundle.`)) return;
    if (mtErr) { mtErr.textContent = ''; mtErr.hidden = true; }
    mtCreate.disabled = true; mtCreate.textContent = 'Working…';
    try {
      const r = await bridgeCall('zone.makeTemplate', { sourceZone: zid, label, description: (mtDesc?.value || '').trim() });
      mtPanel?.classList.remove('open');
      showMakeTemplateSuccess(r, label);
    } catch (e) {
      setErr(`Error: ${e.message}`);
    } finally {
      mtCreate.disabled = false; mtCreate.textContent = 'Make Template';
    }
  });
}

function showMakeTemplateSuccess(r, fallbackLabel) {
  const panel = document.getElementById('mt-success-panel');
  const rows  = document.getElementById('mts-rows');
  const ok    = document.getElementById('mts-ok');
  if (!panel || !rows) return;
  const esc = (s) => String(s ?? '—').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const row = (k, v, mono) => `<div class="zi-row" style="border-bottom:1px solid #2a2a31;padding:4px 0;display:flex;justify-content:space-between;gap:12px;font-size:12px;">
    <span style="color:#8a8a96;flex-shrink:0">${esc(k)}</span>
    <span style="color:#d6dae6;text-align:right;word-break:break-all${mono ? ';font-family:monospace;font-size:11px' : ''}">${esc(v)}</span>
  </div>`;
  const warns = (r?.warnings || []).map(w => `<div style="margin-top:6px;font-size:11px;color:#f0a060">⚠ ${esc(w)}</div>`).join('');
  rows.innerHTML = row('Name', r?.label || fallbackLabel) + row('ID', r?.id) + row('Path', r?.tdir, true) + warns;
  ok?.addEventListener('click', () => panel.classList.remove('open'), { once: true });
  panel.classList.add('open');
  bringToFront(panel);
}

function showNewZoneSuccess(r) {
  const el = document.createElement('div');
  el.className = 'new-zone-toast';
  const zoneName = r.name || `Zone ${r.zoneId}`;
  const templateLabel = (r.template || 'unknown').charAt(0).toUpperCase() + (r.template || '').slice(1);
  const dbOk = r.db && r.db.startsWith('applied');
  const dbMsg = r.db == null    ? null
              : dbOk            ? `✓ DB: ${r.db}`
              : `⚠ DB not applied — run zone-migration.sql from workspace`;
  el.innerHTML = `
    <div class="nzt-title">New Zone Created!</div>
    <div class="nzt-detail">${zoneName} &nbsp;·&nbsp; ${templateLabel} &nbsp;·&nbsp; ID ${r.zoneId}</div>
    ${dbMsg ? `<div class="nzt-db${dbOk ? '' : ' nzt-warn'}">${dbMsg}</div>` : ''}
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 400); }, 6000);
}

// ── Duplicate Zone dialog ────────────────────────────────────────────────────
{
  const panel     = document.getElementById('dupz-panel');
  const nameEl    = document.getElementById('dupz-name');
  const createBtn = document.getElementById('dupz-create');
  createBtn?.addEventListener('click', async () => {
    if (!bridgeOnline()) { setStatus('Duplicate needs the backend — run via `xi gui zone`', true); return; }
    const zoneId = currentZoneId();
    if (!zoneId) { setStatus('Cannot determine current zone ID — load a zone first', true); return; }
    const name = nameEl?.value.trim() || '';
    createBtn.disabled = true;
    createBtn.textContent = 'Duplicating…';
    try {
      const r = await bridgeCall('zone.duplicate', {
        zone: currentZoneUrl,
        sourceZoneId: zoneId,
        name,
      });
      if (!r?.datUrl) throw new Error('no datUrl in response');
      await refreshCustomZones();
      const selEl = document.getElementById('zone');
      if (selEl) selEl.value = r.datUrl;
      panel.classList.remove('open');
      loadZone(r.datUrl);
      setStatus(`Zone ${r.zoneId} "${r.name}" created (duplicated from zone ${r.sourceZoneId})`);
    } catch (e) {
      setStatus(`zone duplicate failed: ${e.message}`, true);
    } finally {
      createBtn.disabled = false;
      createBtn.textContent = 'Duplicate';
    }
  });
  window.openDuplicateZonePanel = function openDuplicateZonePanel() {
    if (!panel) return;
    closeFileMenu();
    if (!panel.classList.contains('open')) {
      const entry = (typeof zonesData !== 'undefined' && zonesData.find((z) => z.path === currentZoneUrl))
                 || (typeof customZonesData !== 'undefined' && customZonesData.find((z) => z.path === currentZoneUrl));
      if (nameEl) nameEl.value = entry?.name ? `${entry.name} (Copy)` : '';
      panel.classList.add('open');
      bringToFront(panel);
      nameEl?.focus();
      nameEl?.select();
    }
  };
}

// ── Delete Zone dialog ───────────────────────────────────────────────────────
{
  const panel       = document.getElementById('delete-zone-panel');
  const confirmDiv  = document.getElementById('dz-confirm');
  const countDiv    = document.getElementById('dz-countdown');
  const zoneIdLabel = document.getElementById('dz-zone-id-label');
  const counterEl   = document.getElementById('dz-counter');
  const confirmBtn  = document.getElementById('dz-confirm-btn');
  const abortBtn    = document.getElementById('dz-abort-btn');
  let _dzTimer = null;

  function _dzReset() {
    clearInterval(_dzTimer); _dzTimer = null;
    confirmDiv?.classList.remove('dz-hidden');
    countDiv?.classList.add('dz-hidden');
  }

  panel?.querySelectorAll('[data-close="delete-zone-panel"]').forEach((b) => {
    b.onclick = () => { panel.classList.remove('open'); _dzReset(); };
  });

  abortBtn?.addEventListener('click', () => { panel.classList.remove('open'); _dzReset(); });

  confirmBtn?.addEventListener('click', () => {
    confirmDiv.classList.add('dz-hidden');
    countDiv.classList.remove('dz-hidden');
    let secs = 10;
    counterEl.textContent = secs;
    _dzTimer = setInterval(async () => {
      secs--;
      counterEl.textContent = secs;
      if (secs > 0) return;
      clearInterval(_dzTimer); _dzTimer = null;
      const zoneEntry = zonesData.find((z) => z.path === currentZoneUrl)
        || customZonesData.find((z) => z.path === currentZoneUrl);
      const zid = zoneEntry?.id;
      panel.classList.remove('open');
      _dzReset();
      try {
        await bridgeCall('zone.delete', { zoneId: zid });
        // Remove from dropdown
        const sel = document.getElementById('zone');
        sel?.querySelector(`option[value="${currentZoneUrl}"]`)?.remove();
        // Load Lower Jeuno
        const lj = zonesData.find((z) => z.path.toUpperCase().endsWith('ROM/1/41.DAT'));
        loadZone(lj?.path || 'game/ROM/1/41.DAT');
      } catch (e) {
        setStatus(`delete failed: ${e.message}`, true);
      }
    }, 1000);
  });

  window.openDeleteZonePanel = function openDeleteZonePanel() {
    const entry = zonesData.find((z) => z.path === currentZoneUrl)
      || customZonesData.find((z) => z.path === currentZoneUrl);
    if (!entry || entry.id < 400) { setStatus('Delete Zone is only available for custom zones (ID 400+)', true); return; }
    _dzReset();
    if (zoneIdLabel) zoneIdLabel.textContent = `${entry.id} — ${entry.name || currentZoneUrl}`;
    panel.classList.add('open');
    bringToFront(panel);
  };
}

// ── Update delete-zone button enabled state on zone change ───────────────────
function updateDeleteZoneBtn() {
  const btn = document.getElementById('menu-delete-zone');
  if (!btn) return;
  const entry = zonesData.find((z) => z.path === currentZoneUrl)
    || customZonesData.find((z) => z.path === currentZoneUrl);
  btn.disabled = !entry || entry.id < 400;
}

function updateMakeTemplateBtn() {
  const btn = document.getElementById('menu-make-template');
  if (!btn) return;
  const zid = currentZoneId();
  const gray = !zid || zid < 400;
  btn.classList.toggle('menu-grayed', gray);
  btn.disabled = gray;
}
updateMakeTemplateBtn();

// New: wipe the level — delete every unlocked placement AND VFX (one undoable command).
async function newLevel() {
  if (!zoneRoot || !placements.length) { setStatus('nothing to clear'); return; }
  const unlocked = placements.filter((e) => !e.node.userData.locked && !e.isSky);
  const lockedCount = placements.length - unlocked.length;
  if (!unlocked.length) { setStatus('nothing to clear (all objects are locked)'); return; }
  const lockNote = lockedCount ? `\n\n${lockedCount} locked object(s) will be kept.` : '';
  if (!await xi_confirm('New Level', `Delete all unlocked objects and VFX from this level?${lockNote}\n\nThey become delete changes you can still Undo or revert from the Changes panel.`, 'Delete All')) return;
  const states = unlocked.map((entry) => ({
    entry, node: entry.node, parent: entry.node.parent, wasAdded: addedEntries.has(entry),
    // Drop the icon sprite too (it's a vfxIconGroup sibling, not a child) — else cleared
    // VFX/SFX leave orphan icons that animate() keeps drawing. Restored on undo.
    vfxSprite: vfxIconGroup ? (vfxIconGroup.children.find(sp => sp.userData.vfxNode === entry.node) || null) : null,
  }));
  const apply = () => {
    select(null);
    transform.detach();
    for (const s of states) {
      s.node.parent?.remove(s.node);
      if (s.vfxSprite) vfxIconGroup.remove(s.vfxSprite);
      const i = placements.indexOf(s.entry); if (i >= 0) placements.splice(i, 1);
      placementSet.delete(s.node);
      // Markers and editable text planes round-trip via their OWN arrays (rebuilt from scratch on
      // load), so a deleted one just vanishes from that array — never a tracked placement delete.
      if (!s.entry.isMarker && !s.entry.isTextPlane) {
        markChange(s.entry);
        if (s.wasAdded) addedEntries.delete(s.entry); else deletedEntries.add(s.entry);
      }
      selectedSet.delete(s.entry);
    }
    selectionEl.textContent = 'nothing selected';
    clearSelectionOutline(); updateSelectionOutline();
    buildObjectList();
  };
  const undo = () => {
    for (const s of states) {
      s.parent?.add(s.node);
      if (s.vfxSprite && vfxIconGroup) vfxIconGroup.add(s.vfxSprite);
      if (!placements.includes(s.entry)) placements.push(s.entry);
      placementSet.add(s.node);
      if (!s.entry.isMarker && !s.entry.isTextPlane) {
        if (s.wasAdded) addedEntries.add(s.entry); else deletedEntries.delete(s.entry);
      }
    }
    buildObjectList();
  };
  apply();
  pushCommand({ undo, redo: apply });
  setStatus(`cleared ${states.length} object(s) / VFX`);
}


// Load: replay a zone-changes.json (the inverse of Export JSON) onto the live scene.
// Best-effort — applies modify/delete/add(same-zone)/add(cross-zone) placements and
// vfx modify/remove, as ONE undoable command. GLB injects can't be replayed (the JSON
// only carries the filename, not the bytes) and are reported as skipped.
// ── gizmo toolbar (Move / Rotate / Scale) ──────────────────────────────────
const toolButtons = {
  translate: document.getElementById('tool-move'),
  rotate: document.getElementById('tool-rotate'),
  scale: document.getElementById('tool-scale'),
  space: document.getElementById('tool-space'),
};
const toolUniformBtn = document.getElementById('tool-uniform');
// Local space: gizmo axes follow the object's orientation (rings rotate with it).
// World space: gizmo axes always align with world X/Y/Z.
// Scale is always local — Three.js world-space scale decomposes incorrectly on
// rotated objects (shear → corrupted quaternion), so we never set it to 'world'.
let gizmoSpace = 'local';
function applyGizmoSpace() {
  transform.space = transform.mode === 'scale' ? 'local' : gizmoSpace;
}
function setGizmoMode(mode) {
  transform.setMode(mode);
  applyGizmoSpace();
  for (const [m, btn] of Object.entries(toolButtons)) {
    if (m === 'space') continue;
    btn?.classList.toggle('active', m === mode);
  }
  syncUniformBtn();
}
// "Uniform" fly-out beside Scale — only shown in scale mode; reflects/toggles scaleUniform.
function syncUniformBtn() {
  if (!toolUniformBtn) return;
  toolUniformBtn.style.display = transform.mode === 'scale' ? '' : 'none';
  toolUniformBtn.classList.toggle('active', scaleUniform);
}
toolUniformBtn?.addEventListener('click', () => {
  scaleUniform = !scaleUniform;
  saveSetting('scaleUniform', scaleUniform);
  if (scaleUniformToggle) scaleUniformToggle.checked = scaleUniform;
  syncUniformBtn();
});
function toggleGizmoSpace() {
  gizmoSpace = gizmoSpace === 'local' ? 'world' : 'local';
  applyGizmoSpace();
  const isLocal = gizmoSpace === 'local';
  toolButtons.space?.classList.toggle('active', isLocal);
  if (toolButtons.space) {
    toolButtons.space.querySelector('span').textContent = isLocal ? 'grid_3x3' : 'language';
    toolButtons.space.childNodes[toolButtons.space.childNodes.length - 1].textContent = isLocal ? 'Local' : 'World';
  }
}
if (toolButtons.space) toolButtons.space.onclick = toggleGizmoSpace;
function applySnapSettings() {
  const active = !snapOnShift || shiftHeld;
  transform.setTranslationSnap(active && moveSnap > 0 ? moveSnap : null);
  transform.setRotationSnap(active && rotateSnap > 0 ? THREE.MathUtils.degToRad(rotateSnap) : null);
  transform.setScaleSnap(active && scaleSnap > 0 ? scaleSnap : null);
}
toolButtons.translate.onclick = () => setGizmoMode('translate');
toolButtons.rotate.onclick = () => setGizmoMode('rotate');
toolButtons.scale.onclick = () => setGizmoMode('scale');
applySnapSettings();
setGizmoMode('translate');

// Frame the camera on the selected object, keeping the current view direction.
function focusSelected() {
  if (!selected) return;
  const box = new THREE.Box3().setFromObject(selected.node);
  let center, radius;
  if (box.isEmpty()) {
    // No 3D mesh (e.g. a sound emitter — just a position + icon): focus its point.
    center = selected.node.getWorldPosition(new THREE.Vector3());
    radius = 5;
  } else {
    center = box.getCenter(new THREE.Vector3());
    radius = Math.max(...box.getSize(new THREE.Vector3()).toArray(), 1) * 0.5;
  }
  navScale = radius; // focusing a small object → finer zoom/scroll; large → coarser
  const dist = radius / Math.tan((camera.fov * Math.PI / 180) / 2) * 1.3 + radius;
  const back = camera.getWorldDirection(new THREE.Vector3()).negate(); // back along current view
  camera.position.copy(center).addScaledVector(back, dist);
  camera.lookAt(center);
  camera.near = Math.max(dist / 1000, 0.05);
  camera.far = Math.max(camera.far, dist * 100);
  camera.updateProjectionMatrix();
}
document.getElementById('tool-focus').onclick = focusSelected;
const _toolDeleteEl = document.getElementById('tool-delete');
if (_toolDeleteEl) _toolDeleteEl.onclick = deleteSelected;
const _undoBtnEl = document.getElementById('undo-btn');
const _redoBtnEl = document.getElementById('redo-btn');
if (_undoBtnEl) _undoBtnEl.onclick = undo;
if (_redoBtnEl) _redoBtnEl.onclick = redo;
// Wire undo-redo module to DOM + shared state (deletedEntries/addedEntries defined above)
initUndoRedo({ undoBtn: _undoBtnEl, redoBtn: _redoBtnEl, onStateChange: updateChangesUI, deletedEntries, addedEntries, getLimit: () => undoLimit });
updateHistoryButtons();

// ── View / Edit mode + backend (WebSocket) bridge ───────────────────────────
// Editor opens in read-only VIEW mode (blue viewport frame, gizmos inert, click-
// select only). EDIT mode enables editing and, the first time it's entered for a
// zone, replays any change-set saved to that zone's workspace (auto-restore). The
// File menu's Save / Apply-to-game run over the bridge — no CLI round-trip.
// Five modes:
//   edit       — editable working copy, your changes shown
//   view       — read-only, your edited changes still shown (blue frame)
//   production — read-only, the released (current on-disk) DAT, NO changes (red frame)
//   base       — read-only, the pristine .base DAT, zero changes ever (orange frame)
//   hd         — read-only, the HD asset-pack DAT for this zone, NO changes (violet frame)
// edit<->view never reloads (changes stay put); crossing into/out of a clean mode
// (production/base/hd) reloads the DAT — production loads the current bytes, base loads
// the .base backup, hd loads the HD sibling — and replays your changes when returning to edit/view.
// modeBtn, modeMenu, viewFrameEl — imported from publish-mode.js above
const appEl = document.getElementById('app');
const viewModeLabelEl = document.getElementById('view-mode-label');
const bridgeStatusEl = document.getElementById('bridge-status');
const errorBannerEl = document.getElementById('error-banner');
const errorBannerMsgEl = document.getElementById('error-banner-msg');
let _errorBannerTimer = null;
function hideErrorBanner() {
  if (!errorBannerEl) return;
  errorBannerEl.classList.remove('show');
  errorBannerEl.hidden = true;
  clearTimeout(_errorBannerTimer);
  _errorBannerTimer = null;
}
function showErrorBanner(msg, { title = 'Something went wrong', sticky = false } = {}) {
  if (!errorBannerEl) { console.error(msg); return; }
  const text = String(msg ?? '');
  if (errorBannerMsgEl) errorBannerMsgEl.textContent = text;
  else errorBannerEl.textContent = text;
  const titleEl = errorBannerEl.querySelector('.error-banner-title');
  if (titleEl) titleEl.textContent = title;
  errorBannerEl.hidden = false;
  errorBannerEl.classList.add('show');
  clearTimeout(_errorBannerTimer);
  // Auto-hide only for short notices; long/sticky errors stay until X is clicked
  // so the user can select and copy the message.
  if (!sticky && text.length < 160) {
    _errorBannerTimer = setTimeout(hideErrorBanner, 12000);
  }
}
document.getElementById('error-banner-close')?.addEventListener('click', (e) => {
  e.stopPropagation();
  hideErrorBanner();
});
// Don't dismiss when clicking the message body (allows text selection / copy).
errorBannerEl?.addEventListener('click', (e) => e.stopPropagation());
// mode, editMode, activeVersionLabel, isCleanMode, modeReplayPending, modeFetchedZone,
// _suppressStateFetch, syncViewFrame, applyModeUI, setMode, closeModeMenu — moved to publish-mode.js.
// Use getMode(), getEditMode(), isCleanMode(), getModeReplayPending()/setModeReplayPending(),
// getModeFetchedZone()/setModeFetchedZone(), getSuppressStateFetch()/setSuppressStateFetch(),
// applyModeUI(), syncViewFrame(), setMode(), closeModeMenu() imported from publish-mode.js above.

// Only Edit mode lets a selection attach the transform gizmo.
const _origAttach = transform.attach.bind(transform);
transform.attach = (node) => (getEditMode() && node ? _origAttach(node) : (transform.detach(), transform));

// Build the same change-set object Export JSON produces (placements + vfx + markers).
// Collapse ONLY a literal same-INSTANCE double-record: two add records carrying the same
// per-instance `uid` AND an identical TRS — i.e. one node that somehow got serialized twice
// (a re-entrancy / double-add artifact). That is the real bug; everything else is a real object.
//
// We DELIBERATELY no longer collapse by xiId+TRS. xiId is a GROUP key shared across copies
// (see newUid), so the old key silently dropped legitimate in-place copies — copy a group,
// paste with offset off, and each pasted mesh lands exactly on its sibling with the same xiId.
// They are distinct objects the user placed on purpose; dropping them lost published meshes
// ("copied a group, it didn't publish all into the map"). Distinct uids now keep them all.
// Records WITHOUT a uid (legacy/pre-fix nodes) are never collapsed — never risk deleting a real
// object to suppress a cosmetic overlap; an accidental overlap is visible and the user can move it.

function versionLabelKey(zoneUrl) {
  return `vh_ver_${launcherState.currentProject?.id || 'browse'}_${zoneUrl || ''}`;
}
function setVersionLabel(n) {
  setActiveVersionLabel(n);
  if (currentZoneUrl) {
    if (n != null) localStorage.setItem(versionLabelKey(currentZoneUrl), String(n));
    else           localStorage.removeItem(versionLabelKey(currentZoneUrl));
  }
}

// VFX/SFX viewport labels: hidden when their Settings toggle is off OR in View mode
// (which is a clean visual preview).
function applyVfxIconVisibility() {
  if (vfxIconGroup) vfxIconGroup.visible = showVfxIcons && getMode() !== 'view';
}

// Reload the pristine DAT without the auto state-fetch clobbering our in-memory
// pending change-set (used by the mode toggle).
async function reloadZoneClean(baseDat = false, hd = false) {
  setSuppressStateFetch(true);
  try { await loadZone(currentZoneUrl, { baseDat, hd }); } finally { setSuppressStateFetch(false); }
}

// Pull this zone's saved change-set from its workspace (once per zone). Stash it to
// replay when Edit is entered; replay immediately if already editing with no local edits.
// "Loading Changes" blocking overlay — shown while a saved change-set replays onto the scene.
// showChangesLoader resolves only AFTER the browser paints the overlay: a change-set with no GLB
// loads replays synchronously, so without waiting for a frame the show+hide would collapse into one
// JS turn and never render.
function showChangesLoader() {
  document.getElementById('changes-loader')?.classList.remove('hidden');
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}
function hideChangesLoader() { document.getElementById('changes-loader')?.classList.add('hidden'); }

async function refreshZoneState() {
  if (!bridgeOnline() || !currentZoneUrl || getModeFetchedZone() === currentZoneUrl) { hideChangesLoader(); return; }
  setModeFetchedZone(currentZoneUrl);
  try {
    const st = await bridgeCall('zone.state', { zone: currentZoneUrl });
    syncPublishState();
    const ch = st && st.changes;
    const savedHasContent = snapshotHasContent(ch);
    const hasViewState = !!(ch && (Object.keys(ch.visibility || {}).length || Object.keys(ch.locks || {}).length)) || _changesHaveCategories(ch);
    if (!savedHasContent && !hasViewState) return;
    // Wait for building interiors to register before replaying — sub-area object modifies resolve
    // against their interior placements, and applying before markSaved avoids an autosave that would
    // drop them. Only awaited when there's actually saved content to restore (no latency on empty zones).
    try { await subAreasLoadPromise; } catch { /* interior load failure is non-fatal for the replay */ }
    if (!isCleanMode() && !snapshotHasContent(snapshotChanges())) {
      // Edit and View both show your saved changes — replay them onto the fresh scene.
      if (savedHasContent) await loadChangesFromJson(ch, '(restored from save)', { recordHistory: false });
      if (hasViewState) applyWorkspaceViewState(ch);
    } else if (isCleanMode()) {
      setModeReplayPending(ch);   // stash to restore when leaving a clean mode (Production/Base)
    }
    const liveSnap = snapshotChanges();
    if (savedHasContent && !snapshotHasContent(liveSnap)) {
      console.warn('[state] saved change-set was non-empty but replay left an empty live snapshot; preserving saved signature to avoid empty autosave overwrite');
      markSaved(ch);
    } else {
      markSaved(liveSnap);   // scene now reflects the workspace — auto-save won't re-write it
    }
  } catch (e) { setModeFetchedZone(''); }  // allow a retry
  finally { hideChangesLoader(); }   // the project-open overlay (shown on click) comes down once the replay settles
}

// Called at the end of loadZone. A genuine zone change forgets the old pending set
// and refetches saved state; a mode-toggle reload (suppressed) keeps the in-memory set.
// updateWindowTitle moved to core/zone-nav.js

function onZoneLoaded() {
  // A project's first real zone just loaded → leave the forced View and start editing.
  if (launcherState.projectAwaitingZone && currentZoneUrl && !launcherState.browseOnly) {
    launcherState.projectAwaitingZone = false;
    if (getMode() !== 'edit') setMode('edit');   // view→edit shares the same bytes, so no reload
  }
  // Remember the zone per-project (editor-local) so reopening the project resumes here.
  if (launcherState.currentProject && !launcherState.browseOnly && currentZoneUrl) setProjectLastZone(launcherState.currentProject.id, currentZoneUrl);
  updateWindowTitle();       // now that a zone is loaded, prepend its name to the title
  applyModeUI();
  syncPublishState();        // Publish stays disabled until there's something to publish
  applyIsolateCollision();   // re-apply the collision layer/camera state to the new zone
  applySkyboxScale();        // re-apply the skybox scaling to the new zone
  try { invalidateEvents(); } catch {}   // drop cached event tree; reload if the EVTS tab is open
  markSaved();               // baseline for auto-save (refreshZoneState updates it after any replay)
  refreshHdVariant();        // per-zone HD-variant check (de-duped; cheap on mode-toggle reloads)
  refreshCompanionDats();    // async fetch of dialog/npc/event DAT paths for zone info display
  if (getSuppressStateFetch()) return;
  setModeReplayPending(null);
  setModeFetchedZone('');
  refreshZoneState();
  refreshProjectZones();   // keep the Project Zones list + active highlight current
}

// Backend status dot + connect.
async function checkHdAvailability() {
  try {
    const r = await bridgeCall('config.info', {});
    hdDirAvailable = !!(r && r.hdDir);
    ffxiDir = (r && r.ffxiDir) || '';
    ffxiHdDir = (r && r.hdDirPath) || '';
  } catch { hdDirAvailable = false; }
  updateZoneInfo();
  _hdVariantZone = '';        // force a re-check now that we know whether an HD dir exists
  refreshHdVariant();
}

// Fetch the companion DAT paths (dialog/npc/event) for the current zone so zone info
// can display them. Runs async after zone load; updates zone info when done.
async function refreshCompanionDats() {
  const url = currentZoneUrl;
  if (!url || !bridgeOnline()) return;
  const zoneEntry = zonesData.find((z) => z.path === url) || customZonesData.find((z) => z.path === url);
  if (!zoneEntry?.id) return;
  try {
    const r = await bridgeCall('zone.companionDats', { zone: url, zoneEntry: { id: zoneEntry.id } });
    if (currentZoneUrl !== url) return;  // zone changed while awaiting
    currentCompanionDats = r && r.ok ? { event: r.event, dialog: r.dialog, npc: r.npc } : null;
  } catch { currentCompanionDats = null; }
  updateZoneInfo();
}

// Per-zone HD check: does the HD asset pack ship a DAT for this zone? Drives the HD-Zone
// mode button (mode menu) and the right-panel "Publish to HD Zone" button. Cached per
// zone — only re-asks the backend when the zone (or HD-dir availability) changes.
async function refreshHdVariant() {
  const url = currentZoneUrl;
  if (!url || !hdDirAvailable || !bridgeOnline()) {
    hdVariantAvailable = false; hdVariantPath = ''; updateHdUI();
    return;
  }
  if (_hdVariantZone === url) return;   // already resolved for this zone
  _hdVariantZone = url;
  try {
    const r = await bridgeCall('zone.hdVariant', { zone: url });
    if (currentZoneUrl !== url) return; // zone changed mid-call — let the newer one win
    hdVariantAvailable = !!(r && r.exists);
    hdVariantPath = (r && r.path) || '';
  } catch { hdVariantAvailable = false; hdVariantPath = ''; _hdVariantZone = ''; }
  updateHdUI();
}

// Reflect HD availability across the UI: the right-panel bar (Publish button vs the
// "No HD Zone Available" label) and the mode-menu HD entry (disabled when unavailable).
function updateHdUI() {
  const hdBar = document.getElementById('zone-hd-bar');
  const hdBtn = document.getElementById('publish-hd-btn');
  const hdLabel = document.getElementById('hd-unavailable-label');
  if (hdBar) {
    const showBar = hdDirAvailable && !!currentZoneUrl;
    hdBar.style.display = showBar ? '' : 'none';
    if (hdBtn) hdBtn.style.display = (showBar && hdVariantAvailable) ? '' : 'none';
    if (hdLabel) hdLabel.style.display = (showBar && !hdVariantAvailable) ? '' : 'none';
  }
  const hdModeBtn = document.querySelector('#mode-menu button[data-mode="hd"]');
  if (hdModeBtn) {
    hdModeBtn.style.display = hdDirAvailable ? '' : 'none';
    hdModeBtn.disabled = !hdVariantAvailable;
    hdModeBtn.title = hdVariantAvailable
      ? 'Read-only — the Ashenbubs HD asset-pack DAT for this zone'
      : 'No HD asset-pack DAT exists for this zone';
  }
}

// Surface a one-time popup when the editor can't reach the backend bridge — either it
// never connected at startup, or an established connection dropped. The editor still
// works read-only without it, but Save/Publish/Navmesh/etc. all need the backend.
let _bridgeEverOnline = false;
let _bridgeOfflineNotified = false;
let _bridgeOfflineTimer = null;
let _bridgeOfflineDlgOpen = false;            // is the shown dialog the offline popup?
function notifyBridgeOffline(wasConnected) {
  if (_bridgeOfflineNotified) return;          // one popup per offline episode
  _bridgeOfflineNotified = true;
  _bridgeOfflineDlgOpen = true;
  xi_danger('Bridge Offline', wasConnected
    ? 'Lost the connection to the XI Tools backend. Save, Publish, Navmesh and other '
      + 'backend actions are unavailable until it reconnects.\n\nIf the server stopped, '
      + 'restart it with `xi gui zone`.'
    : 'The editor could not reach the XI Tools backend. Save, Publish, Navmesh and other '
      + 'backend actions are unavailable.\n\nLaunch the editor via `xi gui zone` so the '
      + 'bridge is available.')
    .finally(() => { _bridgeOfflineDlgOpen = false; });
}

onBridgeStatus((online) => {
  if (bridgeStatusEl) {
    bridgeStatusEl.classList.toggle('off', !online);
    bridgeStatusEl.textContent = online ? 'android_wifi_3_bar' : 'android_wifi_3_bar_off';
    bridgeStatusEl.title = online
      ? 'Connected to Python XI Tools'
      : 'Disconnected from XI Tools — Save / Publish unavailable. Run via `xi gui zone`.';
  }
  if (online) {
    _bridgeEverOnline = true;
    _bridgeOfflineNotified = false;            // re-arm so a later drop notifies again
    clearTimeout(_bridgeOfflineTimer); _bridgeOfflineTimer = null;
    if (_bridgeOfflineDlgOpen) dismissXiDlg();  // reconnected — close the offline popup
    refreshZoneState(); checkHdAvailability();
    return;
  }
  // Offline. Skip file:// — there's no backend by design and the editor never tries.
  if (location.protocol === 'file:') return;
  if (_bridgeEverOnline) {
    notifyBridgeOffline(true);                // an established connection dropped
  } else {
    // Initial load: this listener fires offline synchronously before the socket has had
    // a chance to open. Wait out the bridge's connect-retry budget (~10s) before crying
    // wolf — a normal desktop launch connects in well under a second.
    clearTimeout(_bridgeOfflineTimer);
    _bridgeOfflineTimer = setTimeout(() => { if (!bridgeOnline()) notifyBridgeOffline(false); }, 8000);
  }
});
// toolsBootPromise started at import time (blocks workspace setup until done).


async function uploadGlbAssets(snap) {
  for (const c of (snap.placements || []).filter((c) => c.op === 'add' && c.glb)) {
    // `c.glb` may now be an absolute source path; match + store the workspace copy by
    // the BARE name (c.glbName) so the workspace byte layout is unchanged.
    const bare = c.glbName || c.glb;
    const entry = placements.find((p) => addedEntries.has(p) && p.node.userData?.glbImport?.fileName === bare);
    const f = entry?.node.userData?.glbImport?.file;
    if (!f) { console.warn('[bridge] no bytes to upload for GLB', bare); continue; }
    await bridgeCall('zone.putAsset', { zone: currentZoneUrl, name: bare, bytesBase64: await fileToBase64(f) });
  }
}
async function saveToWorkspace() {
  if (!bridgeOnline()) { setStatus('Save needs the backend — wait for xi-tools bridge to connect', true); return; }
  const snap = snapshotChanges();
  const hasContent = snapshotHasContent(snap);
  if (!hasContent && !lastSavedHadContent) { setStatus('Nothing to save — no changes in this zone.'); return; }
  try {
    await uploadGlbAssets(snap);
    await bridgeCall('zone.saveChanges', { zone: currentZoneUrl, changes: snap });
    setModeFetchedZone(currentZoneUrl);   // we are now the source of truth for this zone
    markSaved(snap);
    refreshProjectZones();              // a freshly-saved zone now appears under Project Zones
    setStatus(hasContent
      ? `Saved ${snap.placements.length} placement / ${snap.vfx.length} VFX / ${snap.markers.length} marker change(s) to workspace`
      : 'Cleared workspace — all changes undone');
  } catch (e) { showErrorBanner(`Save failed: ${e.message}`); setStatus(`Save failed: ${e.message}`, true); }
}

// ── Version History — extracted to version-history.js ────────────────────────
// openVersionHistory, renderVersionList, restoreVersion, clearVersionHistory,
// viewVersionLog, viewVersionChanges are imported at the top of this file.
// initVersionHistory() is called after _changesHaveCategories is defined (below).

// Package Wizard: multi-zone project packager. Lists all zones edited in the active
// project with checkboxes, packages selected zones into a single zip named after the
// project. Persists the tick selection per-user, per-project (see getPackageSelection).
async function packageChanges() {
  if (!bridgeOnline()) { await xi_alert('Bridge Offline', 'Packaging needs the backend — run the editor via `xi gui zone`.'); return; }
  if (!launcherState.currentProject) { setStatus('No project open.', true); return; }

  const overlay    = document.getElementById('pkg-wizard-overlay');
  const selectView = document.getElementById('pkg-wizard-select');
  const progView   = document.getElementById('pkg-wizard-progress');
  const listEl     = document.getElementById('pkg-wizard-zone-list');
  const zipNameEl  = document.getElementById('pkg-wizard-zipname');
  const spinner    = document.getElementById('pkg-wizard-spinner');
  const statusEl   = document.getElementById('pkg-wizard-status');
  const closeBtn   = document.getElementById('pkg-wizard-close');

  const progTitle    = progView.querySelector('.pkg-wizard-title');
  const showSelect   = () => { selectView.style.display = ''; progView.style.display = 'none'; if (progTitle) progTitle.textContent = 'Packaging'; };
  const showProgress = () => { selectView.style.display = 'none'; progView.style.display = ''; };
  const hide         = () => { overlay.style.display = 'none'; };

  // zip filename preview
  const projectName = launcherState.currentProject.name || 'project';
  const zipSlug = projectName.toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim() || 'package';
  zipNameEl.textContent = `→ ${zipSlug}.zip`;

  // load project zones
  let zones = [];
  try {
    const r = await bridgeCall('project.zones', {});
    zones = (r && r.zones) || [];
  } catch (e) {
    setStatus(`Could not list project zones: ${e.message}`, true);
    return;
  }

  // saved selections (per-user, project-scoped); null = never saved → all checked
  const savedArr = getPackageSelection(launcherState.currentProject.id);
  const savedSel = new Set(savedArr || []);

  // render zone list
  listEl.innerHTML = '';
  if (!zones.length) {
    listEl.innerHTML = '<div class="pkg-wizard-empty">No zones with changes in this project.</div>';
  } else {
    for (const z of zones) {
      const path = z.zone || '';
      if (!path) continue;
      const checked = savedArr === null ? true : savedSel.has(path);
      const row = document.createElement('label');
      row.className = 'pkg-wizard-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = path; cb.checked = checked;
      const nameEl = document.createElement('span'); nameEl.className = 'pkg-wizard-name';
      nameEl.textContent = zoneNameForPath(path);
      const romEl = document.createElement('span'); romEl.className = 'pkg-wizard-rom';
      romEl.textContent = path.replace(/^game\//, '');
      const countEl = document.createElement('span'); countEl.className = 'pkg-wizard-count' + (z.total > 0 ? ' has-changes' : '');
      countEl.textContent = `${z.total} change${z.total === 1 ? '' : 's'}`;
      row.append(cb, nameEl, romEl, countEl);
      listEl.appendChild(row);
    }
  }

  // custom-NPC SQL option — shown only when the project has registered custom NPCs
  const npcRow   = document.getElementById('pkg-wizard-npc-row');
  const npcCb     = document.getElementById('pkg-wizard-npcs');
  const npcCountEl = document.getElementById('pkg-wizard-npc-count');
  if (npcRow) {
    npcRow.style.display = 'none';
    try {
      const cn = await bridgeCall('customNpc.list', {});
      const n = (cn && cn.count) || 0;
      if (n > 0) {
        npcRow.style.display = '';
        if (npcCountEl) npcCountEl.textContent = `(${n} NPC${n === 1 ? '' : 's'} → sql/custom_npcs.sql)`;
      }
    } catch { /* bridge offline → hide the option */ }
  }

  // select-all / none
  document.getElementById('pkg-wizard-selall').onclick = () =>
    listEl.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = true; });
  document.getElementById('pkg-wizard-selnone').onclick = () =>
    listEl.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
  document.getElementById('pkg-wizard-cancel').onclick = hide;

  // package button
  document.getElementById('pkg-wizard-go').onclick = async () => {
    const selected = [...listEl.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value);
    if (!selected.length) { await xi_alert('No Zones Selected', 'Tick at least one zone to package.'); return; }

    // persist selection (per-user, editor-local — not committed to the shared project file)
    setPackageSelection(launcherState.currentProject.id, selected);

    showProgress();
    spinner.className = 'navmesh-gen-spinner';
    statusEl.textContent = `Packaging ${selected.length} zone${selected.length === 1 ? '' : 's'}…`;
    closeBtn.style.display = 'none';

    try {
      const includeCustomNpcs = !!(npcRow && npcRow.style.display !== 'none' && npcCb && npcCb.checked);
      const r = await bridgeCall('zone.packageProject', { zones: selected, projectName, includeCustomNpcs });
      const zipName = (r.zip || '').split(/[\\/]/).pop();
      spinner.className = 'navmesh-gen-spinner done';
      if (progTitle) progTitle.textContent = 'Package Ready';
      statusEl.textContent = `${zipName} ready (${r.memberCount || 0} files${r.customNpcSql ? ', incl. custom NPC SQL' : ''})` + (r.opened ? ' — opened in Explorer' : '');
      setStatus(`Packaged ${selected.length} zone(s) → ${r.zip}`);
      closeBtn.style.display = '';
      setTimeout(hide, 4000);
    } catch (e) {
      spinner.className = 'navmesh-gen-spinner error';
      if (progTitle) progTitle.textContent = 'Packaging Failed';
      statusEl.textContent = `Packaging failed: ${e.message}`;
      closeBtn.style.display = '';
      showErrorBanner(`Packaging failed: ${e.message}`);
      setStatus(`Packaging failed: ${e.message}`, true);
    }
  };

  closeBtn.onclick = hide;
  showSelect();
  overlay.style.display = '';
}

// ── Auto-save ────────────────────────────────────────────────────────────────
// applyAutoSaveMode / scheduleAutoSave / doAutoSave — imported from auto-save.js.
// _changeSig / lastSavedSig / markSaved — imported from changes-tracker.js.
// True if a saved change-set carries any list-category state (new per-kind or legacy objs-only).
const _changesHaveCategories = (ch) => setsHaveState(ch?.categorySets) || setsHaveState(ch?.categories ? { objs: ch.categories } : null);
initVersionHistory({
  bridgeCall, bridgeOnline, setStatus, showErrorBanner,
  xi_confirm, xi_alert,
  getCurrentZoneUrl: () => currentZoneUrl,
  getCurrentProject: () => launcherState.currentProject,
  snapshotHasContent,
  changesHaveCategories: _changesHaveCategories,
  isCleanMode,
  setMode,
  reloadZoneClean,
  loadChangesFromJson,
  applyWorkspaceViewState,
  setModeFetchedZone,
  setVersionLabel,
  zoneNameForPath,
  openModal,
  fileBtn,
});
initAutoSave({
  getAutoSave:        () => autoSave,
  getSaveEveryAction: () => saveEveryAction,
  getMode,
  bridgeOnline,
  snapshotChanges,
  snapshotHasContent,
  uploadGlbAssets,
  bridgeCall,
  showErrorBanner,
  getCurrentZoneUrl:  () => currentZoneUrl,
  changeSig:          _changeSig,
  getLastSavedSig:    () => lastSavedSig,
  getLastSavedHadContent: () => lastSavedHadContent,
  setLastSavedSig:    (s, hasContent) => { setLastSavedSig(s, hasContent); },
  setModeFetchedZone,
});

// ── sfx-playback init ─────────────────────────────────────────────────────────
initSfxPlayback({
  getSelected:     () => selected,
  setStatus,
  bridgeOnline,
  bridgeCall,
  xi_alert,
  showErrorBanner,
});

// ── glb-import init ───────────────────────────────────────────────────────────
initGlbImport({
  getScene:                () => scene,
  getCamera:               () => camera,
  getZoneRoot:             () => zoneRoot,
  getPlacements:           () => placements,
  getPlacementSet:         () => placementSet,
  getSelectedSet:          () => selectedSet,
  getTransform:            () => transform,
  getSelected:             () => selected,
  getCurrentZoneUrl:       () => currentZoneUrl,
  getLauncherState:        () => launcherState,
  datUrl,
  getKeyTables,
  buildTextures,
  buildMeshTemplates,
  addPointLightEffect,
  isLegacyZoneEnvMesh,
  tuneSurfaceForEditor,
  makeParticleMaterial,
  buildObjectList,
  updateChangesUI,
  updateTextPlaneDetailsPanel,
  setStatus,
  focusSelected,
  isLocked,
  xi_alert,
  setActiveTab,
  select,
  lastSelectedEntry,
  rebuildSelectionOutline,
  updateSelectionOutline,
  updateSelectionReadout,
  clearSelectionOutline,
});

// ── collision-ui init ─────────────────────────────────────────────────────────
initCollisionUI({
  getZoneRoot:          () => zoneRoot,
  getEditMode,
  getShowCollision:     () => showCollision,
  getCollisionOpacity:  () => collisionOpacity,
  getPlacements:        () => placements,
  getPlacementSet:      () => placementSet,
  getAddedEntries:      () => addedEntries,
  getSelected:          () => selected,
  getRaycaster:         () => raycaster,
  getCamera:            () => camera,
  newXiId,
  markChange,
  setStatus,
  buildObjectList,
  updateChangesUI,
  select,
  updateCollisionDetailsPanel,
  setActiveTab,
  tabForEntry,
});

// ── publish-mode init ─────────────────────────────────────────────────────────
initPublishMode({
  getCanvas:            () => canvas,
  getTransform:         () => transform,
  getSelected:          () => selected,
  isLocked,
  hdVariantAvailable:   () => hdVariantAvailable,
  setStatus,
  snapshotChanges,
  snapshotHasContent,
  loadChangesFromJson,
  applyWorkspaceViewState,
  reloadZoneClean,
  markSaved,
  applyVfxIconVisibility,
  applyIsolateCollision,
  applyIsolateNavmesh,
});

// ── markers init ──────────────────────────────────────────────────────────────
initMarkers({
  getZoneRoot:          () => zoneRoot,
  getPlacementSet:      () => placementSet,
  getPlacements:        () => placements,
  getSurfacePointAhead: surfacePointAhead,
  buildObjectList,
  select,
  pushCommand,
  setStatus,
  getEditMode,
});

// ── copy-paste init ───────────────────────────────────────────────────────────
initCopyPaste({
  getSelected:              () => selected,
  getSelectedSet:           () => selectedSet,
  getPlacements:            () => placements,
  getZoneRoot:              () => zoneRoot,
  getAddedEntries:          () => addedEntries,
  getPlacementSet:          () => placementSet,
  getCollisionPrimGroup:    getCollisionPrimGroup,
  setCollisionPrimGroup:    setCollisionPrimGroup,
  getCollisionPrimMaterials: getCollisionPrimMaterials,
  getTemplates:             () => templates,
  getParsed:                () => parsed,
  getCurrentZoneUrl:        () => currentZoneUrl,
  getMode,
  getPasteOffset:           () => pasteOffset,
  getShowCollision:         () => showCollision,
  getLastCanvasPointerClient: () => lastCanvasPointerClient,
  getCanvas:                () => canvas,
  getCamera:                () => camera,
  getRaycaster:             () => raycaster,
  pushCommand,
  markChange,
  setStatus,
  buildObjectList,
  select,
  selectNull:               () => select(null),
  lastSelectedEntry,
  isLocked,
  getTransform:             () => transform,
  getSelectionEl:           () => selectionEl,
  clearSelectionOutline,
  rebuildSelectionOutline,
  updateSelectionOutline,
  updateSelectionReadout,
  setActiveTab,
  updateChangesUI,
  autoGroupXiEffects,
  uniquePlacementName,
  xiName,
  lightGlbRef,
  newXiId,
  newUid,
  instantiate,
  buildMeshTemplates,
  buildTextures,
  parseZone,
  getKeyTables,
  datUrl,
  resolveMeshName,
  groundPointAhead,
  trsMatrix,
  setCollisionMat,
  defaultCollisionMat,
  buildSourceEffectPreviewNode,
  pastedEffectName,
  effectSourcePrefix,
  registerPlacement,
  setIconVisible,
  addXZoneEffect,
  commitAddedSound,
  buildMobNode,
  bridgeOnline,
  // marker helpers (for cross-zone marker paste)
  getMarkerGroup,
  setMarkerGroup,
  getMarkerTexture,
  getPinTexture,
  MARKER_SCALE,
});

// openConsole / closeConsole / viewVersionLog / viewVersionChanges — imported from backend-log.js / version-history.js


// Run one zone.export over the bridge, streaming the backend log into `con` under a labelled
// section header ("━━ Publish: Standard Zone ━━"). `zoneUrl` is game/ (standard) or game-hd/
// (HD sibling); `hd` skips the shared version snapshot so the standard leg owns the version
// trail. Returns the backend result; throws on failure (caller owns con.done()). The change-set
// goes over as JSON — elided as <<json>> in the echo since it can be huge. reset comes from
// Settings → "Reset DAT before Publish":
//   on  → reset to pristine .base first, then inject — clean/idempotent.
//   off → apply onto the current DAT (matches `xi zone import-json`), accumulating.
async function runPublishLeg(zoneUrl, snap, con, { hd = false, label = 'Standard Zone', onStart = null } = {}) {
  con.log(`━━ Publish: ${label} ━━`);
  con.log(`${publishReset ? 'reset from pristine, then apply changes' : 'apply onto current DAT (no reset)'}…`);
  con.log('→ xi tools command: zone.export <<json>>');
  con.log('─'.repeat(60) + '\n');
  const params = { zone: zoneUrl, changes: snap, reset: publishReset, clearCollision: clearCollisionOnReset, debug: true, skipVersion: hd };
  return bridgeCall('zone.export', params, con.log, onStart);
}


async function applyToGame() {
  if (!bridgeOnline()) { setStatus('Publish needs the backend — run the editor via `xi gui zone`', true); return; }
  // Re-bake every editable text plane into a fresh hidden GLB (removing any prior bakes) so the
  // published meshes always match the current signs. Must run BEFORE the snapshot is taken.
  await rebuildTextBakes();
  const snap = snapshotChanges();
  // A contentless publish is a real operation, not a no-op, so it is never blocked:
  // with "Reset DAT before Publish" on it reverts the game DAT to pristine, which is
  // how you undo everything and push that (previously you had to publish a dummy edit).
  // With reset off it applies nothing — harmless. "Reset Collision on Publish" likewise
  // wipes collision on its own (e.g. clearing a new map's template collision).
  if (!snapshotHasContent(snap) && !clearCollisionOnReset) {
    setStatus(publishReset ? 'No changes — publishing reverts the DAT to pristine.'
                           : 'No changes — publishing will apply nothing.');
  }
  // Spawn guard — the player's DB spawn must sit a small gap above a collision floor.
  // None under it → falls/crashes; at/below → crashes; too far above → stuck in mid-air.
  if (validateSpawn) {
    try { await refreshPlayerMarker(); } catch {}
    const info = playerSpawnInfo();
    const msg = spawnWarningMessage(info);
    if (msg) {
      const p = playerSpawn;
      const ok = await xi_confirm('Player Spawn Check',
        `${msg}\n\n` +
        `Spawn: x ${p.x.toFixed(1)}, z ${p.z.toFixed(1)}, y ${p.y.toFixed(1)} (charid ${p.charid}).\n` +
        `Adjust via Database → Set Spawn, or move the collision under the player.`,
        'Publish Anyway');
      if (!ok) { setStatus(`Publish cancelled — ${info.status} player spawn.`, true); return; }
    }
  }
  // Project setting "On Publish → HD" decides what happens to the HD asset-pack DAT, but only
  // when this zone actually has one. 'publish' mirrors the same change-set (keeps HD textures);
  // 'clone' copies the just-published standard DAT byte-for-byte over the HD DAT (mirror). Both
  // run sequentially after the standard leg, streaming into the same console pane.
  const hdMode = hdVariantAvailable ? hdPublishMode : 'off';
  const alsoHd = hdMode === 'publish';
  const alsoClone = hdMode === 'clone';
  const hdActive = alsoHd || alsoClone;
  const name = (currentZoneUrl || '').split(/[\\/]/).pop();
  const con = openConsole('Publish → ' + name);
  setStatus('Publishing to game…');

  // ── Stop button: cancel the in-flight publish leg ──
  // Stopping mid-write can leave the DAT reverted/partial, so confirm with a clear warning
  // first. On confirm, send a cancel for the active leg's request id — the backend trips its
  // cooperative checkpoint and the leg's bridgeCall rejects with a PublishCancelled error.
  let activePublishId = null;
  let publishStopped = false;
  con.onStop(async () => {
    if (publishStopped) return;
    const ok = await showXiDlg({
      title: 'Stop Publish?',
      body: 'Stopping mid-publish can leave the map broken. Republish or reset to fix it.\n\n'
        + 'Stop the publish now?',
      okText: 'Stop Publish',
      cancelText: 'Keep Publishing',
      showCancel: true,
      danger: true,
    });
    if (!ok || publishStopped) return;
    publishStopped = true;
    con.log('\n⏹ Stop requested — cancelling at the next checkpoint…');
    bridgeCancel(activePublishId);
  });
  // Record the active leg's request id; if a Stop was already confirmed before this leg
  // started (e.g. during the GLB upload), cancel it the moment it registers.
  const trackLeg = (id) => { activePublishId = id; if (publishStopped) bridgeCancel(id); };

  // Upload browser-picked GLBs once — both legs read them from the shared workspace.
  try { await uploadGlbAssets(snap); }
  catch (e) { con.done('✗ Upload failed: ' + e.message, false); setStatus(`Publish failed: ${e.message}`, true); return; }

  // ── Standard leg ──
  let stdR;
  try {
    stdR = await runPublishLeg(currentZoneUrl, snap, con, { label: 'Standard Zone', onStart: trackLeg });
  } catch (e) {
    if (isPublishCancel(publishStopped, e)) {
      con.done('⏹ Publish cancelled — the zone DAT may be in a bad/partial state. '
        + 'Publish again with “Reset DAT before Publish” on to restore it.', false);
      setStatus('Publish cancelled — DAT may be in a bad state.', true);
      return;
    }
    con.done('✗ Publish failed: ' + e.message, false);
    setStatus(`Publish failed: ${e.message}`, true);
    return;   // standard failed → don't proceed to HD
  }
  CACHE_BUST = Date.now();   // publish rewrote the DAT → bust the browser cache so a
                             // Production/HD-mode reload shows the new bytes
  // Placed mobs are DB spawns (not DAT objects) — write them after the bake.
  await writeMobSpawns(snap, con);
  const { out, stats } = publishStats(stdR);
  const verLine = (stdR && stdR.version && stdR.version.version) ? `\n- Version v${stdR.version.version}` : '';
  con.log(`✓ Published → ${out}\n- ${stats}${verLine}\n`);
  // Building-interior (sub-room) DATs written this publish get their own line each.
  if (stdR && Array.isArray(stdR.subAreas)) {
    for (const s of stdR.subAreas) {
      con.log(s.error
        ? `  ✗ SubRoom ${s.dat} — ${s.error}`
        : `  ↳ SubRoom ${s.dat} — ${s.modified || 0} modified${s.skipped ? `, ${s.skipped} skipped` : ''}`);
    }
  }
  // Reflect the just-written standard DAT without a manual refresh: rebuild the collision
  // overlay + reload the navmesh (CACHE_BUST bumped above). Scoped — scene/selection/undo survive.
  try { await reloadCollisionOverlay(); } catch (e) { console.error('[publish] collision reload', e); }
  reloadNavmesh();
  refreshPlayerMarker();

  // ── HD leg (sequential, after standard) ──
  let hdOk = true;
  if (alsoHd && !publishStopped) {
    con.log('');   // blank spacer between sections
    try {
      const hdR = await runPublishLeg(hdUrlFor(currentZoneUrl), snap, con, { hd: true, label: 'HD Zone', onStart: trackLeg });
      CACHE_BUST = Date.now();
      const hd = publishStats(hdR);
      con.log(`✓ Published → ${hd.out}\n- ${hd.stats}\n`);
    } catch (e) {
      if (isPublishCancel(publishStopped, e)) {
        con.done('⏹ HD publish cancelled — Standard zone is published, but the HD DAT may be in a '
          + 'bad/partial state. Publish to HD again (Reset on) to restore it.', false);
        setStatus('HD publish cancelled — HD DAT may be in a bad state.', true);
        return;
      }
      hdOk = false; con.log(`✗ HD publish failed: ${e.message}\n`);
    }
  } else if (alsoClone && !publishStopped) {
    // Clone-to-HD: straight file copy of the just-published standard DAT over the HD DAT.
    con.log('');
    con.log('━━ Publish: HD Zone (clone) ━━');
    con.log('copy the just-published standard DAT byte-for-byte over the HD DAT…\n');
    try {
      const cl = await bridgeCall('zone.cloneToHd', { zone: currentZoneUrl });
      if (!cl || !cl.ok) throw new Error((cl && cl.error) || 'clone failed');
      CACHE_BUST = Date.now();
      con.log(`✓ Cloned → ${cl.dst}\n- ${(cl.bytes || 0).toLocaleString()} bytes copied from the standard zone\n`);
    } catch (e) {
      hdOk = false; con.log(`✗ HD clone failed: ${e.message}\n`);
    }
  }

  const hdWord = alsoClone ? 'HD (cloned)' : 'HD';
  const hdFailWord = alsoClone ? 'HD clone' : 'HD';
  const hdNote = hdActive ? (hdOk ? ` + ${hdWord}` : ` (${hdFailWord} failed)`) : '';
  con.done(hdActive
    ? (hdOk ? `✓ Publish complete — Standard + ${hdWord}` : `⚠ Standard published; ${hdFailWord} failed`)
    : '✓ Publish complete', !hdActive || hdOk);
  setStatus(`Published → ${out} (${stats})${hdNote}`);
  // The zone now has a published `.edited` mirror — UNLESS we just baked an empty change-set
  // (a reset-to-pristine), which leaves it un-edited. Keep Publish state in sync so a follow-up
  // removal stays publishable.
  syncPublishState();
  // Persist the full publish log (both legs) into the standard leg's version-history entry.
  if (stdR && stdR.version && stdR.version.version) {
    setVersionLabel(stdR.version.version);
    try { await bridgeCall('zone.versionSaveLog', { zone: currentZoneUrl, version: stdR.version.version, log: con.text() }); }
    catch (logErr) { console.warn('[publish] save log failed', logErr); }
  }
}

// Manual "Publish to HD Zone" (right-panel button) — mirror the current change-set to this
// zone's HD asset-pack DAT only, independent of the Settings auto-publish toggle.
async function publishHdOnly() {
  if (!bridgeOnline()) { setStatus('Publish needs the backend — run the editor via `xi gui zone`', true); return; }
  if (!hdVariantAvailable) { setStatus('No HD asset-pack DAT exists for this zone.', true); return; }
  const snap = snapshotChanges();
  // Same as applyToGame: an empty change-set is allowed through — with reset on it
  // reverts the HD DAT to pristine, which is a legitimate thing to want to publish.
  if (!snapshotHasContent(snap) && !clearCollisionOnReset) {
    setStatus(publishReset ? 'No changes — publishing reverts the HD DAT to pristine.'
                           : 'No changes — publishing will apply nothing.');
  }
  const name = (currentZoneUrl || '').split(/[\\/]/).pop();
  const con = openConsole('Publish HD → ' + name);
  setStatus('Publishing to HD zone…');
  let activePublishId = null;
  let publishStopped = false;
  con.onStop(async () => {
    if (publishStopped) return;
    const ok = await showXiDlg({
      title: 'Stop Publish?',
      body: 'Stopping mid-publish can leave the map broken. Republish or reset to fix it.\n\n'
        + 'Stop the publish now?',
      okText: 'Stop Publish',
      cancelText: 'Keep Publishing',
      showCancel: true,
      danger: true,
    });
    if (!ok || publishStopped) return;
    publishStopped = true;
    con.log('\n⏹ Stop requested — cancelling at the next checkpoint…');
    bridgeCancel(activePublishId);
  });
  try {
    await uploadGlbAssets(snap);
    const r = await runPublishLeg(hdUrlFor(currentZoneUrl), snap, con, { hd: true, label: 'HD Zone', onStart: (id) => { activePublishId = id; if (publishStopped) bridgeCancel(id); } });
    CACHE_BUST = Date.now();
    const { out, stats } = publishStats(r);
    con.done(`✓ Published → ${out}\n- ${stats}`);
    setStatus(`Published → HD ${out} (${stats})`);
  } catch (e) {
    if (isPublishCancel(publishStopped, e)) {
      con.done('⏹ HD publish cancelled — the HD zone DAT may be in a bad/partial state. '
        + 'Publish to HD again (Reset on) to restore it.', false);
      setStatus('HD publish cancelled — HD DAT may be in a bad state.', true);
      return;
    }
    con.done('✗ HD publish failed: ' + e.message, false); setStatus(`HD publish failed: ${e.message}`, true);
  }
}

// File > Reset — `xi zone reset` on the current zone: restore the DAT from its pristine
// .base backup AND clear this zone's pending edits, then reload the scene clean.
async function resetZone() {
  if (!bridgeOnline()) { setStatus('Reset needs the backend — run the editor via `xi gui zone`', true); return; }
  const url = currentZoneUrl;
  if (!await xi_confirm('Reset Zone',
    'Runs `xi zone reset` — restores the DAT from its .base backup AND clears your '
    + 'pending edits (placements, deletes, the change-set) for this zone.\n\n'
    + 'This cannot be undone. Continue?', 'Reset')) return;
  setStatus('Resetting zone…');
  try {
    const r = await bridgeCall('zone.reset', { zone: url, clearCollision: clearCollisionOnReset });
    CACHE_BUST = Date.now();      // Reset rewrote the DAT on disk → bypass the browser cache
    await reloadZoneClean(url);   // reload the pristine DAT with the change-set cleared
    select(null);                 // force-deselect everything + close the selection-details modals
    setStatus(`Reset → ${(r && r.message) || 'pristine baseline'}`);
    showResetDone((r && r.message) || 'Zone restored to its pristine baseline.');
  } catch (e) { setStatus(`Reset failed: ${e.message}`, true); }
}

// File > Reset Collision — remove all user-placed collision primitives without touching
// the zone's original MZB collision or any other placements.
async function resetCollision() {
  const prims = placements.filter(e => e.isCollisionPrimitive);
  if (!prims.length) { setStatus('No user-placed collision primitives to remove.'); return; }
  if (!await xi_confirm('Remove Collision Primitives',
    `Remove all ${prims.length} user-placed collision primitive${prims.length === 1 ? '' : 's'}?\n\n`
    + 'This removes only the boxes and planes you added — the zone\'s original collision mesh is not affected.\n\n'
    + 'This cannot be undone. Continue?', 'Remove'
  )) return;

  for (const e of prims) {
    e.node.parent?.remove(e.node);
    const i = placements.indexOf(e); if (i >= 0) placements.splice(i, 1);
    placementSet.delete(e.node);
    addedEntries.delete(e);
    selectedSet.delete(e);
  }
  selected = lastSelectedEntry();
  if (selected && !isLocked(selected)) transform.attach(selected.node);
  else {
    transform.detach();
    if (!selected) { selectionEl.textContent = 'nothing selected'; clearSelectionOutline(); updateSelectionOutline(); }
  }
  rebuildSelectionOutline(); updateSelectionReadout(); updateSelectionOutline();
  updateMarkerDetailsPanel(); updateGlbDetailsPanel(); updateCollisionDetailsPanel(); updateSoundDetailsPanel();
  clearHistory();
  buildObjectList();
  updateChangesUI();
  setStatus(`Removed ${prims.length} collision primitive${prims.length === 1 ? '' : 's'}.`);
}

// Success popup after a Reset completes — a centred modal like the New Zone dialog.
function showResetDone(msg) {
  const panel = document.getElementById('reset-done-panel');
  if (!panel) return;
  const msgEl = document.getElementById('reset-done-msg');
  if (msgEl) msgEl.textContent = msg;
  panel.classList.add('open');
  bringToFront(panel);
  document.getElementById('reset-done-ok')?.focus();
}

// Shortcuts: F focus, 1/2/3 move/rotate/scale, X toggle local/world space, Del delete, Ctrl+Z/Y undo/redo, Esc deselect.
window.addEventListener('keyup', (e) => heldKeys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => { heldKeys.clear(); shiftHeld = false; applySnapSettings(); });
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') { shiftHeld = false; applySnapSettings(); }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift' && !shiftHeld) { shiftHeld = true; applySnapSettings(); }
  const k = e.key.toLowerCase();
  // Ctrl+S must be caught before any early returns so Chrome's save-page doesn't fire.
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); saveToWorkspace(); return; }
  // Allow Ctrl+C/V even when the zone SELECT has focus (zone switch leaves it focused).
  const isCopyPaste = (e.ctrlKey || e.metaKey) && (k === 'c' || k === 'v');
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.target.tagName === 'SELECT' && !isCopyPaste) return;
  // WASD/QE drive the fly camera — don't fire gizmo shortcuts for those.
  heldKeys.add(k);
  if ('wasdqe'.includes(k)) return;
  // View mode is read-only: allow focus + deselect, block all editing shortcuts.
  if (!getEditMode()) {
    if (k === 'f') focusSelected();
    else if (e.key === 'Escape') select(null);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'c') { if (window.getSelection()?.toString().length) return; e.preventDefault(); copySelected(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'v') { e.preventDefault(); Promise.resolve(pasteFromClipboard()).catch(e => setStatus(`paste error: ${e.message}`, true)); }
  else if (k === '1') setGizmoMode('translate');
  else if (k === '2') setGizmoMode('rotate');
  else if (k === '3') setGizmoMode('scale');
  else if (k === 'x') toggleGizmoSpace();
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
  else if (k === 'f') focusSelected();
  else if (e.key === 'Escape') select(null);
});

// ── time-of-day / weather UI ────────────────────────────────────────────────
// fmtTime and populateWeather moved to core/zone-nav.js
{
  const weatherEl = document.getElementById('weather');
  const timeEl = document.getElementById('time'), timeVal = document.getElementById('time-val');
  const dayEl = document.getElementById('day');
  if (weatherEl) weatherEl.onchange = (e) => { currentWeather = e.target.value; applyEnvironment(); };
  if (timeEl) {
    timeEl.value = timeMinutes; if (timeVal) timeVal.textContent = fmtTime(timeMinutes);
    timeEl.oninput = (e) => { timeMinutes = parseInt(e.target.value, 10); if (timeVal) timeVal.textContent = fmtTime(timeMinutes); applyEnvironment(); };
  }
  if (dayEl) { dayEl.value = String(dayOfWeek); dayEl.onchange = (e) => { dayOfWeek = parseInt(e.target.value, 10); applyDayColors(); }; }
}

// ── UI wiring ───────────────────────────────────────────────────────────────
const zoneEl = document.getElementById('zone');
zoneEl.onchange = async (e) => {
  const nextZone = e.target.value;
  if (currentZoneUrl && nextZone !== currentZoneUrl && hasUnsavedChanges()) {
    const ok = await xi_confirm('Unsaved Changes', 'You have unsaved changes. Continue and discard them?', 'Discard');
    if (!ok) { zoneEl.value = currentZoneUrl; return; }
  }
  loadZone(nextZone);
};
const customDatEl = document.getElementById('custom-dat');
document.getElementById('custom-dat-load').addEventListener('click', async () => {
  let path = customDatEl.value.trim().replace(/\\/g, '/');
  if (!path) return;
  if (!/\.dat$/i.test(path)) path += '.DAT';
  if (!path.startsWith('game/')) path = 'game/' + path;
  if (currentZoneUrl && hasUnsavedChanges()) {
    const ok = await xi_confirm('Unsaved Changes', 'You have unsaved changes. Continue and discard them?', 'Discard');
    if (!ok) return;
  }
  zoneEl.value = '';
  loadZone(path);
});
customDatEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('custom-dat-load').click(); });
// Right-panel "Publish to HD Zone" — manually mirror the current change-set to this
// zone's HD asset-pack DAT (independent of the Settings auto-publish toggle).
document.getElementById('publish-hd-btn')?.addEventListener('click', () => publishHdOnly());
const zoneSearchEl = document.getElementById('zone-search');
const zoneSearchResultsEl = document.getElementById('zone-search-results');

// goToZone moved to core/zone-nav.js

// ── Pinned zones / project zones / zone search / tabs moved to core/zone-nav.js ──
if (zoneSearchEl) {
  zoneSearchEl.addEventListener('input', updateZoneSearch);
  zoneSearchEl.addEventListener('keydown', (e) => { e.stopPropagation(); });
}
filterEl.oninput = buildObjectList;
if (vfxFilterEl) vfxFilterEl.oninput = buildObjectList;
if (soundFilterEl) soundFilterEl.oninput = buildObjectList;
if (markerFilterEl) markerFilterEl.oninput = buildObjectList;
if (textFilterEl) textFilterEl.oninput = buildObjectList;
if (skyFilterEl) skyFilterEl.oninput = buildObjectList;
if (mobFilterEl)  mobFilterEl.oninput  = buildObjectList;
if (colsFilterEl) colsFilterEl.oninput = buildObjectList;

// ── Right-side tabs — setActiveTab, tabForEntry moved to core/zone-nav.js ──
{
  const sideTabsEl = document.getElementById('side-tabs');
  if (sideTabsEl) sideTabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.side-tab');
    if (b) setActiveTab(b.dataset.tab);
  });
}

// Wire the cutscene module with its dependencies now that all globals are available.
initCutscene({
  scene, camera, renderer, gltfLoader,
  getZoneRoot: () => zoneRoot,
  getCurrentZoneUrl: () => currentZoneUrl,
  currentZoneId,
  resumeAuthor, openAuthorFrom: openCutsceneAuthorFrom,
  pushCommand,
  bridgeCall, bridgeOnline,
  disposeSubtree, clearOutline, rebuildOutline, updateOutline,
  get hoverOutlineMat() { return getHoverOutlineMat(); },
  setStatus,
  saveSetting, loadSetting,
  evtEsc,
  eventsCutscene,
  // Placed markers → {name, pos:[FFXI x,y,z]} for the cutscene Position track's dropdown.
  getMarkers: () => {
    const mg = getMarkerGroup();
    if (!mg || !zoneRoot) return [];
    const out = [], wp = new THREE.Vector3();
    for (const s of mg.children) {
      if (!s.userData || s.userData.markerCsIcon == null && s.userData.markerIcon == null) continue;
      s.getWorldPosition(wp);
      const f = zoneRoot.worldToLocal(wp.clone());
      out.push({ name: s.name || 'marker', pos: [+f.x.toFixed(3), +f.y.toFixed(3), +f.z.toFixed(3)] });
    }
    return out;
  },
  // Picking a "To marker" for an actor → select that marker sprite in the viewport (gizmo + highlight).
  selectMarkerByName: (name) => {
    const m = placements.find((p) => p.isMarker && p.name === name);
    if (m) select(m);
  },
});
initCsLetterbox({
  hideUi:     loadSetting('csHideUi', false),
  fixedRatio: loadSetting('csFixedRatio', false),
  crosshair:  loadSetting('csCrosshair', false),
});
initCutsceneScene();   // adds csActorOutline to scene + wires DOM event listeners

// Cutscene author camera: let "pilot" retarget the fly controls at the camera rig,
// and let the pilot button hand the gizmo to the rig.
csInitCameraDeps({
  setFlyTarget,
  onCameraSelect: (rig) => { if (rig) transform.attach(rig); else if (transform.object === csGetAuthorCamRig()) transform.detach(); },
});
// Click the author-camera body in the viewport → attach the Move/Rotate gizmo to it.
// Capture phase + stopImmediatePropagation so this pre-empts fly-look + placement
// selection for that click (and the paired pointerup, which would otherwise
// select(null) → transform.detach() the rig). Only while open and NOT piloting.
let _camGizmoClick = false;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || transform.axis) return;
  if (csIsCameraPiloting()) return;
  const rig = csGetAuthorCamRig && csGetAuthorCamRig();
  if (!rig || !rig.parent || !rig.visible) return;
  raycaster.setFromCamera(clientToNdc(e.clientX, e.clientY), getActiveViewportCamera());
  if (raycaster.intersectObject(rig, true).length) {
    transform.attach(rig);
    if (transform.mode === 'scale') transform.setMode('translate');   // cameras don't scale
    _camGizmoClick = true;
    e.stopImmediatePropagation();
    e.preventDefault();
  }
}, true);
canvas.addEventListener('pointerup', (e) => {
  if (_camGizmoClick) { _camGizmoClick = false; e.stopImmediatePropagation(); e.preventDefault(); }
}, true);

// Wire sub-area module
initSubAreas({
  getZoneRoot:        () => zoneRoot,
  getParsed:          () => parsed,
  bridgeCall, bridgeOnline,
  parseZone, getKeyTables, buildMeshTemplates, buildTextures,
  instantiate, trsMatrix, isSkyName, datUrl, resolveMeshName,
  updateChangesUI, setStatus, goToZone, xi_confirm,
  getCamera:          () => camera,
  setNavScale:        (v) => { navScale = v; },
  getCurrentZoneUrl:  () => currentZoneUrl,
  registerPlacement, buildObjectList, uniquePlacementName,
});

// Wire text-planes module
initTextPlanes({
  getZoneRoot:           () => zoneRoot,
  getSelected:           () => selected,
  placements, placementSet, addedEntries,
  pushCommand, markChange, updateChangesUI, buildObjectList,
  setActiveTab, select, focusSelected, setStatus,
  getEditMode,
  inFrontOfCamera, trsMatrix, uniquePlacementName, newXiId, xiName,
  disposeSubtree, rebuildSelectionOutline, updateSelectionOutline,
  loadGlbWrap,
});

// Wire events panel module
initEventsPanel({
  getCurrentZoneUrl:   () => currentZoneUrl,
  currentZoneId,
  getPanelEl:          () => document.getElementById('panel'),
  getZonesData:        () => zonesData,
  getCustomZonesData:  () => customZonesData,
  openModal,
  openContextMenu,
  fetchEventCutscene,
  renderCutsceneView,
  loadZone,
});

// Wire cutscene author modal — button is in the Events pane header (#cs-author-btn).
initCutsceneAuthor({
  getCurrentZoneUrl: () => currentZoneUrl,
  currentZoneId,
  // Owner-dropdown source: reuse the zone.events actor tree if it's loaded, else fetch on demand.
  fetchActorList: async () => {
    try {
      const { bridgeCall, bridgeOnline } = await import('./ffxi/bridge.js');
      if (!bridgeOnline() || !currentZoneUrl) return [];
      const r = await bridgeCall('zone.events', { zone: currentZoneUrl, zoneId: currentZoneId() });
      return (r && r.actors) || [];
    } catch { return []; }
  },
});

const fogToggle = document.getElementById('toggle-fog');
const gridToggle = document.getElementById('toggle-grid');
const mapCenterToggle = document.getElementById('toggle-map-center');
const wireToggle     = document.getElementById('toggle-wire');
const skyToggle = document.getElementById('toggle-sky');
const collisionToggle = document.getElementById('toggle-collision');
const isolateCollisionToggle = document.getElementById('toggle-isolate-collision');
const isolateBakedToggle = document.getElementById('toggle-isolate-baked');
const isolateNavmeshToggle = document.getElementById('toggle-isolate-navmesh');
const collisionOpacityInput = document.getElementById('collision-opacity');
const collisionOpacityValue = document.getElementById('collision-opacity-value');
const navmeshToggle = document.getElementById('toggle-navmesh');
const navmeshOpacityInput = document.getElementById('navmesh-opacity');
const navmeshOpacityValue = document.getElementById('navmesh-opacity-value');

// Isolate Collision Mesh: render ONLY the collision mesh, hiding everything else in the
// viewport WITHOUT touching any node.visible / list-checkbox state. Done with a render
// layer — the collision mesh is put on layer 1 (in addition to 0) and the camera is
// switched to render only layer 1. No-op when the zone has no collision (avoids blanking).
const COLLISION_LAYER = 1;
function hasCustomCollisionPrims() {
  return placements.some((p) => p.isCollisionPrimitive);
}

function normalizeUndoLimit(value) {
  if (value === '' || value == null) return 100;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(0, n) : 100;
}
function hasBakedCollisionOverlay() {
  return !!getCollisionGroup();
}
function applyIsolateCollision() {
  // Production/Base are clean previews of the DAT — suppress the collision debug
  // overlay (and the isolate camera) regardless of the toggles; restored on exit.
  // Two independent isolate modes share the COLLISION_LAYER + isolate camera:
  //   Isolate (isolateCollision) -> ONLY the authored prims (collisionPrimGroup)
  //   Baked   (isolateBaked)     -> ONLY the DAT-baked collision (collisionGroup)
  // A group goes on the isolate layer only when ITS mode is active, so the isolate
  // camera (which renders only COLLISION_LAYER) shows exactly that group.
  const overlaysAllowed = !isCleanMode();
  const isoCustom = isolateCollision && overlaysAllowed && hasCustomCollisionPrims();
  const isoBaked  = isolateBaked && overlaysAllowed && hasBakedCollisionOverlay();
  const baseVisible = showCollision && overlaysAllowed;
  // Baked collision (from the DAT)
  const _cg = getCollisionGroup();
  if (_cg) {
    if (isoBaked) _cg.traverse((o) => o.layers.enable(COLLISION_LAYER));
    else _cg.traverse((o) => o.layers.disable(COLLISION_LAYER));
    _cg.visible = baseVisible || isoBaked;
  }
  // Authored collision prims (ours)
  const _cpg = getCollisionPrimGroup();
  if (_cpg) {
    if (isoCustom) _cpg.traverse((o) => o.layers.enable(COLLISION_LAYER));
    else _cpg.traverse((o) => o.layers.disable(COLLISION_LAYER));
    _cpg.visible = baseVisible || isoCustom;
  }
  // While isolating baked collision, the fill writes depth so it reads as a solid surface
  // (near side only, no x-ray); a transparent overlay otherwise.
  const _cm = getCollisionMaterial(); if (_cm) _cm.depthWrite = isoBaked;
  applyIsolateCamera();
}

// Navmesh isolate mirrors collision isolate: the navmesh goes on its own render layer and
// the camera renders only the isolated overlay layer(s). The camera decision lives here so
// both isolates can be active together (shows both overlays, hides the base scene).
const NAVMESH_LAYER = 2;
function applyIsolateCamera() {
  const overlaysAllowed = !isCleanMode();
  const isoCol = ((isolateCollision && hasCustomCollisionPrims()) || (isolateBaked && hasBakedCollisionOverlay())) && overlaysAllowed;
  const isoNav = isolateNavmesh && overlaysAllowed && !!navmeshGroup;
  if (!isoCol && !isoNav) { camera.layers.set(0); return; }   // normal: render the base scene
  camera.layers.set(isoCol ? COLLISION_LAYER : NAVMESH_LAYER); // isolate: render only overlay layer(s)
  if (isoCol && isoNav) camera.layers.enable(NAVMESH_LAYER);
}
// While isolating, the camera renders ONLY the overlay layer (COLLISION/NAVMESH), so the
// editing overlays (gizmo, selection + hover outlines) — which default to layer 0 — would
// vanish. Mirror them onto the overlay layers each frame so a selected collision prim still
// shows its outline + is editable via the gizmo. Cheap (a few dozen objects) and only when
// isolating. Re-applied every frame because TransformControls / rebuildOutline recreate
// their child objects (resetting layers to 0). See applyIsolateCamera.
function syncIsolateEditLayers() {
  const iso = (isolateCollision || isolateBaked || isolateNavmesh) && !isCleanMode();
  if (!iso) return;
  const onto = (root) => { if (root && typeof root.traverse === 'function') root.traverse((o) => { o.layers.enable(COLLISION_LAYER); o.layers.enable(NAVMESH_LAYER); }); };
  // The gizmo's scene object is the helper (TransformControls itself isn't an Object3D in
  // this three.js build); fall back to transform for older builds.
  onto(transform.getHelper ? transform.getHelper() : transform);   // Move/Rotate/Scale gizmo
  onto(getSelectionOutline());   // orange selection outline
  onto(getHoverOutline());       // white hover outline
}

function applyIsolateNavmesh() {
  const isolating = isolateNavmesh && !isCleanMode();
  if (navmeshGroup) navmeshGroup.traverse((o) => o.layers.enable(NAVMESH_LAYER));
  // Mirror collision isolate: while isolating, the fill writes depth and is pushed behind the
  // wireframe so only the near surface shows; as a normal floor overlay it's pulled forward (-1)
  // to win the z-fight with the floor it sits on.
  if (navmeshMaterial) {
    navmeshMaterial.depthWrite = isolating;
    navmeshMaterial.polygonOffsetFactor = isolating ? 1 : -1;
    navmeshMaterial.polygonOffsetUnits = isolating ? 1 : -1;
  }
  applyNavmeshVisibility();
  applyIsolateCamera();
}

// Navmesh overlay follows the same clean-mode rule as collision: hidden in the clean
// preview (Production/Base). Force-visible while isolating, just like collision.
function applyNavmeshVisibility() {
  if (navmeshGroup) navmeshGroup.visible = (showNavmesh || isolateNavmesh) && !isCleanMode();
}
const outlineToggle = document.getElementById('toggle-outline');
const simpleOutlineToggle = document.getElementById('toggle-simple-outline');
const hoverOutlineToggle = document.getElementById('toggle-hover-outline');
const frontNormalToggle = document.getElementById('toggle-front-normal');
const scaleUniformToggle = document.getElementById('toggle-scale-uniform');
const undoLimitInput = document.getElementById('undo-limit');
const disableVfxToggle = document.getElementById('toggle-disable-vfx');
const moveSnapInput = document.getElementById('snap-move');
const rotateSnapInput = document.getElementById('snap-rotate');
const scaleSnapInput = document.getElementById('snap-scale');
const moveSnapValue = document.getElementById('snap-move-value');
const rotateSnapValue = document.getElementById('snap-rotate-value');
const scaleSnapValue = document.getElementById('snap-scale-value');
if (fogToggle) { fogToggle.checked = userFog; fogToggle.onchange = (e) => { userFog = e.target.checked; saveSetting('fog', userFog); applyEnvironment(); }; }
const gridBtn = document.getElementById('tool-grid');
const worldCenterBtn = document.getElementById('tool-world-center');
function syncViewToggleBtns() {
  gridBtn?.classList.toggle('active', grid.visible);
  worldCenterBtn?.classList.toggle('active', originGizmo.visible);
  viewMenu?.querySelector('[data-action="grid"]')?.classList.toggle('active', grid.visible);
  viewMenu?.querySelector('[data-action="center"]')?.classList.toggle('active', originGizmo.visible);
  viewMenu?.querySelector('[data-action="sel-outline"]')?.classList.toggle('active', showOutline);
  viewMenu?.querySelector('[data-action="hover-outline"]')?.classList.toggle('active', showHoverOutline);
  viewMenu?.querySelector('[data-action="wireframe"]')?.classList.toggle('active', wireframe);
}
if (gridToggle) { gridToggle.checked = grid.visible; gridToggle.onchange = (e) => { grid.visible = e.target.checked; saveSetting('grid', grid.visible); syncViewToggleBtns(); }; }
if (mapCenterToggle) { mapCenterToggle.checked = originGizmo.visible; mapCenterToggle.onchange = (e) => { originGizmo.visible = e.target.checked; saveSetting('mapCenter', originGizmo.visible); syncViewToggleBtns(); }; }
if (undoLimitInput) {
  undoLimitInput.value = String(undoLimit);
  undoLimitInput.addEventListener('change', () => {
    undoLimit = normalizeUndoLimit(undoLimitInput.value);
    undoLimitInput.value = String(undoLimit);
    saveSetting('undoLimit', undoLimit);
    enforceHistoryLimit();
  });
}
gridBtn?.addEventListener('click', () => {
  grid.visible = !grid.visible;
  saveSetting('grid', grid.visible);
  if (gridToggle) gridToggle.checked = grid.visible;
  syncViewToggleBtns();
});
worldCenterBtn?.addEventListener('click', () => {
  originGizmo.visible = !originGizmo.visible;
  saveSetting('mapCenter', originGizmo.visible);
  if (mapCenterToggle) mapCenterToggle.checked = originGizmo.visible;
  syncViewToggleBtns();
});
syncViewToggleBtns();
if (wireToggle) { wireToggle.checked = wireframe; wireToggle.onchange = (e) => { wireframe = e.target.checked; saveSetting('wireframe', wireframe); applyWireframe(); syncViewToggleBtns(); }; }
const wireColorEl = document.getElementById('wire-color');
if (wireColorEl) {
  wireColorEl.value = wireColor;
  wireColorEl.oninput = (e) => { wireColor = e.target.value; _wireframeMat.color.set(wireColor); saveSetting('wireColor', wireColor); };
}
const bgColorEl = document.getElementById('bg-color');
const bgResetEl = document.getElementById('bg-reset');
if (bgColorEl) {
  bgColorEl.value = customBgColor || '#151515';
  bgColorEl.oninput = (e) => { customBgColor = e.target.value; saveSetting('bgColor', customBgColor); applyBackdrop(); };
}
if (bgResetEl) {
  bgResetEl.onclick = () => {
    customBgColor = '';
    saveSetting('bgColor', '');
    applyBackdrop();
    if (bgColorEl) bgColorEl.value = '#151515';
  };
}
if (skyToggle) { skyToggle.checked = showSkybox; skyToggle.onchange = (e) => { showSkybox = e.target.checked; saveProjectSetting('skybox', showSkybox); setSkyVisible(showSkybox); }; }
const skyScaledToggle = document.getElementById('toggle-sky-scaled');
if (skyScaledToggle) { skyScaledToggle.checked = skyboxScaled; skyScaledToggle.onchange = (e) => { skyboxScaled = e.target.checked; saveProjectSetting('skyboxScaled', skyboxScaled); applySkyboxScale(); }; }

// Scale the skybox meshes (sun/moon/stars/clouds) up so they wrap the zone like a real
// skybox. Sized relative to the zone extent when measurable (sky radius → ~2.5× the zone
// radius), with a large fixed fallback otherwise. Off → native scale.
function applySkyboxScale() {
  if (!skyGroup) return;
  skyGroup.scale.setScalar(1);
  if (!skyboxScaled) return;
  skyGroup.updateMatrixWorld(true);
  let factor = 12;
  const skyBox = new THREE.Box3().setFromObject(skyGroup);
  const zoneBox = new THREE.Box3();
  for (const p of placements) { if (!p.isEffect && !p.isMarker && !p.isSky) zoneBox.expandByObject(p.node); }
  if (!skyBox.isEmpty() && !zoneBox.isEmpty()) {
    const skyR = skyBox.getBoundingSphere(new THREE.Sphere()).radius || 1;
    const zoneR = zoneBox.getBoundingSphere(new THREE.Sphere()).radius || skyR;
    factor = Math.max(2, Math.min(300, (zoneR * 2.5) / skyR));
  }
  skyGroup.scale.setScalar(factor);
}
// Isolate is meaningless without the collision overlay — turning collision viewing OFF
// auto-clears Isolate Collision (unchecks its toggle + deactivates its button).
function clearCollisionIsolateIfHidden() {
  if (!showCollision && isolateCollision) {
    isolateCollision = false;
    saveSetting('isolateCollision', isolateCollision);
    if (isolateCollisionToggle) isolateCollisionToggle.checked = false;
  }
  if (!showCollision && isolateBaked) {
    isolateBaked = false;
    saveSetting('isolateBaked', isolateBaked);
    if (isolateBakedToggle) isolateBakedToggle.checked = false;
  }
}
function clearNavmeshIsolateIfHidden() {
  if (!showNavmesh && isolateNavmesh) {
    isolateNavmesh = false;
    saveSetting('isolateNavmesh', isolateNavmesh);
    if (isolateNavmeshToggle) isolateNavmeshToggle.checked = false;
  }
}
if (collisionToggle) { collisionToggle.checked = showCollision; collisionToggle.onchange = (e) => { showCollision = e.target.checked; saveSetting('collision', showCollision); clearCollisionIsolateIfHidden(); applyIsolateCollision(); syncOverlayBtns(); }; }

const toolCollisionBtn = document.getElementById('tool-collision');
const toolNavmeshBtn   = document.getElementById('tool-navmesh');
const toolColIsolateBtn = document.getElementById('tool-col-isolate');
const toolColBakedBtn = document.getElementById('tool-col-baked');
const toolNavIsolateBtn = document.getElementById('tool-nav-isolate');
function syncOverlayBtns() {
  const customAvailable = showCollision && hasCustomCollisionPrims();
  const bakedAvailable = showCollision && hasBakedCollisionOverlay();
  let isolateStateChanged = false;
  if (!customAvailable && isolateCollision) {
    isolateCollision = false;
    saveSetting('isolateCollision', isolateCollision);
    if (isolateCollisionToggle) isolateCollisionToggle.checked = false;
    isolateStateChanged = true;
  }
  if (!bakedAvailable && isolateBaked) {
    isolateBaked = false;
    saveSetting('isolateBaked', isolateBaked);
    if (isolateBakedToggle) isolateBakedToggle.checked = false;
    isolateStateChanged = true;
  }
  toolCollisionBtn?.classList.toggle('active', showCollision);
  toolNavmeshBtn?.classList.toggle('active', showNavmesh);
  toolColIsolateBtn?.classList.toggle('active', isolateCollision && customAvailable);
  if (toolColIsolateBtn) {
    toolColIsolateBtn.style.display = showCollision ? '' : 'none';
    toolColIsolateBtn.disabled = !customAvailable;
    toolColIsolateBtn.title = customAvailable
      ? 'Isolate custom collision — show only your authored collision prims, hide everything else'
      : 'No custom collision primitives in this zone';
  }
  toolColBakedBtn?.classList.toggle('active', isolateBaked && bakedAvailable);
  if (toolColBakedBtn) {
    toolColBakedBtn.style.display = showCollision ? '' : 'none';
    toolColBakedBtn.disabled = !bakedAvailable;
    toolColBakedBtn.title = bakedAvailable
      ? 'Isolate baked collision — show only the collision baked into the game DAT right now, hide everything else'
      : 'No baked collision overlay in this zone';
  }
  if (isolateCollisionToggle) isolateCollisionToggle.disabled = !customAvailable;
  if (isolateBakedToggle) isolateBakedToggle.disabled = !bakedAvailable;
  toolNavIsolateBtn?.classList.toggle('active', isolateNavmesh);
  if (toolNavIsolateBtn) toolNavIsolateBtn.style.display = showNavmesh ? '' : 'none';
  if (isolateStateChanged) applyIsolateCollision();
}
overlayBtnsReady = true;
syncOverlayBtns();
toolCollisionBtn?.addEventListener('click', () => {
  showCollision = !showCollision;
  saveSetting('collision', showCollision);
  if (collisionToggle) collisionToggle.checked = showCollision;
  clearCollisionIsolateIfHidden();
  applyIsolateCollision();
  syncOverlayBtns();
});
toolNavmeshBtn?.addEventListener('click', () => {
  showNavmesh = !showNavmesh;
  saveSetting('navmesh', showNavmesh);
  if (navmeshToggle) navmeshToggle.checked = showNavmesh;
  clearNavmeshIsolateIfHidden();
  applyIsolateNavmesh();
  applyNavmeshVisibility();
  syncOverlayBtns();
});
toolColIsolateBtn?.addEventListener('click', () => {
  if (toolColIsolateBtn.disabled) return;
  isolateCollision = !isolateCollision;
  saveSetting('isolateCollision', isolateCollision);
  if (isolateCollisionToggle) isolateCollisionToggle.checked = isolateCollision;
  applyIsolateCollision();
  syncOverlayBtns();
});
toolColBakedBtn?.addEventListener('click', () => {
  if (toolColBakedBtn.disabled) return;
  isolateBaked = !isolateBaked;
  saveSetting('isolateBaked', isolateBaked);
  if (isolateBakedToggle) isolateBakedToggle.checked = isolateBaked;
  applyIsolateCollision();
  syncOverlayBtns();
});
toolNavIsolateBtn?.addEventListener('click', () => {
  isolateNavmesh = !isolateNavmesh;
  saveSetting('isolateNavmesh', isolateNavmesh);
  if (isolateNavmeshToggle) isolateNavmeshToggle.checked = isolateNavmesh;
  applyIsolateNavmesh();
  syncOverlayBtns();
});
// ── Flat mode ─────────────────────────────────────────────────────────────────
// Replaces every zone-mesh material with a solid random colour (no texture) to
// make object boundaries obvious for layout work. Colour is name-hashed so it
// stays stable across toggles.
let flatMode = false;
const _flatSavedMaterials = new Map(); // node.uuid → [original materials]
const _flatNodeMaterials  = new Map(); // node.uuid → [flat MeshBasicMaterial]


function applyFlatMode() {
  const toolFlatBtn = document.getElementById('tool-flat');
  toolFlatBtn?.classList.toggle('active', flatMode);
  if (!zoneRoot) return;
  zoneRoot.traverse((node) => {
    if (!node.isMesh || !node.material) return;
    // Skip overlays (collision, navmesh, wireframe, sky)
    const grpName = node.parent?.name || node.name || '';
    if (!grpName || grpName === 'navmesh' || grpName === 'skybox') return;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    if (flatMode) {
      if (_flatSavedMaterials.has(node.uuid)) return; // already swapped
      _flatSavedMaterials.set(node.uuid, mats);
      const color = hashColor(grpName);
      const flat = mats.map(() => new THREE.MeshBasicMaterial({ color, vertexColors: false, side: THREE.DoubleSide }));
      _flatNodeMaterials.set(node.uuid, flat);
      node.material = flat.length === 1 ? flat[0] : flat;
    } else {
      const orig = _flatSavedMaterials.get(node.uuid);
      if (!orig) return;
      const flat = _flatNodeMaterials.get(node.uuid) || [];
      flat.forEach((m) => m.dispose());
      node.material = orig.length === 1 ? orig[0] : orig;
      _flatSavedMaterials.delete(node.uuid);
      _flatNodeMaterials.delete(node.uuid);
    }
  });
  if (!flatMode) { _flatSavedMaterials.clear(); _flatNodeMaterials.clear(); }
}

const toolFlatBtn = document.getElementById('tool-flat');
toolFlatBtn?.addEventListener('click', () => {
  flatMode = !flatMode;
  applyFlatMode();
});

if (isolateCollisionToggle) { isolateCollisionToggle.checked = isolateCollision; isolateCollisionToggle.onchange = (e) => { if (e.target.checked && !hasCustomCollisionPrims()) { e.target.checked = false; return; } isolateCollision = e.target.checked; saveSetting('isolateCollision', isolateCollision); applyIsolateCollision(); syncOverlayBtns(); }; }
if (isolateBakedToggle) { isolateBakedToggle.checked = isolateBaked; isolateBakedToggle.onchange = (e) => { if (e.target.checked && !hasBakedCollisionOverlay()) { e.target.checked = false; return; } isolateBaked = e.target.checked; saveSetting('isolateBaked', isolateBaked); applyIsolateCollision(); syncOverlayBtns(); }; }
if (isolateNavmeshToggle) { isolateNavmeshToggle.checked = isolateNavmesh; isolateNavmeshToggle.onchange = (e) => { isolateNavmesh = e.target.checked; saveSetting('isolateNavmesh', isolateNavmesh); applyIsolateNavmesh(); syncOverlayBtns(); }; }
if (collisionOpacityInput) {
  const setCollisionOpacityUi = (v) => { collisionOpacityInput.value = String(v); if (collisionOpacityValue) collisionOpacityValue.textContent = Math.round(v * 100) + '%'; };
  setCollisionOpacityUi(collisionOpacity);
  collisionOpacityInput.oninput = (e) => {
    collisionOpacity = Math.min(1, Math.max(0.05, Number(e.target.value) || 0.45));
    setCollisionOpacityUi(collisionOpacity);
    saveSetting('collisionOpacity', collisionOpacity);
    const _cm2 = getCollisionMaterial(); if (_cm2) _cm2.opacity = collisionOpacity;
    for (const m of getCollisionPrimMaterials()) m.opacity = collisionOpacity;
  };
}
// When the bridge (re)connects after a zone is already loaded, fetch its navmesh.
onBridgeStatus((isOnline) => {
  if (isOnline && currentZoneUrl && !navmeshGroup) _loadNavmesh(currentZoneUrl);
  if (isOnline) refreshCustomZones();
});

if (navmeshToggle) { navmeshToggle.checked = showNavmesh; navmeshToggle.onchange = (e) => { showNavmesh = e.target.checked; saveSetting('navmesh', showNavmesh); clearNavmeshIsolateIfHidden(); applyIsolateNavmesh(); applyNavmeshVisibility(); syncOverlayBtns(); }; }
if (navmeshOpacityInput) {
  const setNavmeshOpacityUi = (v) => { navmeshOpacityInput.value = String(v); if (navmeshOpacityValue) navmeshOpacityValue.textContent = Math.round(v * 100) + '%'; };
  setNavmeshOpacityUi(navmeshOpacity);
  navmeshOpacityInput.oninput = (e) => {
    navmeshOpacity = Math.min(1, Math.max(0.05, Number(e.target.value) || 0.35));
    setNavmeshOpacityUi(navmeshOpacity);
    saveSetting('navmeshOpacity', navmeshOpacity);
    if (navmeshMaterial) navmeshMaterial.opacity = navmeshOpacity;
  };
}

// Navmesh Refresh — drop the existing overlay and reload from disk.
function reloadNavmesh() {
  if (!currentZoneUrl) return;
  if (navmeshGroup && zoneRoot) { zoneRoot.remove(navmeshGroup); disposeSubtree(navmeshGroup); }
  navmeshGroup = null; navmeshMaterial = null;
  _loadNavmesh(currentZoneUrl);
}

// Navmesh Generate — bake a new .nav via the bridge, then reload.
const _nmGenOverlay  = document.getElementById('navmesh-gen-overlay');
const _nmGenSpinner  = _nmGenOverlay?.querySelector('.navmesh-gen-spinner');
const _nmGenStatus   = document.getElementById('navmesh-gen-status');
const _nmGenClose    = document.getElementById('navmesh-gen-close');

function showNavmeshGenModal(msg) {
  if (!_nmGenOverlay) return;
  _nmGenSpinner?.classList.remove('done', 'error');
  if (_nmGenStatus) _nmGenStatus.textContent = msg || 'Building collision geometry…';
  if (_nmGenClose) _nmGenClose.style.display = 'none';
  _nmGenOverlay.style.display = 'flex';
}
function finishNavmeshGenModal(ok, msg) {
  if (_nmGenSpinner) { _nmGenSpinner.classList.remove('done', 'error'); _nmGenSpinner.classList.add(ok ? 'done' : 'error'); }
  if (_nmGenStatus) _nmGenStatus.textContent = msg;
  if (_nmGenClose) _nmGenClose.style.display = '';
}
if (_nmGenClose) {
  _nmGenClose.onclick = () => { if (_nmGenOverlay) _nmGenOverlay.style.display = 'none'; };
}

const navmeshRefreshBtn  = document.getElementById('navmesh-refresh');
const navmeshGenerateBtn = document.getElementById('navmesh-generate');

if (navmeshRefreshBtn) {
  navmeshRefreshBtn.onclick = () => { closeFileMenu(); if (currentZoneUrl) reloadNavmesh(); };
}
if (navmeshGenerateBtn) {
  navmeshGenerateBtn.onclick = async () => {
    closeFileMenu();
    if (!currentZoneUrl) return;
    if (!bridgeOnline()) { await xi_alert('Bridge Offline', 'Start the editor server first (xi gui zone).'); return; }
    navmeshGenerateBtn.disabled = true;
    showNavmeshGenModal('Building navmesh from collision geometry…');
    try {
      const res = await bridgeCall('zone.navmesh.generate', { zone: currentZoneUrl });
      finishNavmeshGenModal(true,
        `Done — ${res.nTris?.toLocaleString() ?? '?'} tris → ${res.nTiles ?? '?'} tiles\n${res.navFile ?? ''}`);
      showNavmesh = true;
      saveSetting('navmesh', true);
      if (navmeshToggle) navmeshToggle.checked = true;
      reloadNavmesh();
    } catch (e) {
      finishNavmeshGenModal(false, `Error: ${e.message}`);
    } finally {
      navmeshGenerateBtn.disabled = false;
    }
  };
}

if (outlineToggle) { outlineToggle.checked = showOutline; outlineToggle.onchange = (e) => { showOutline = e.target.checked; saveSetting('outline', showOutline); updateSelectionOutline(); }; }
if (simpleOutlineToggle) {
  simpleOutlineToggle.checked = simpleOutline;
  simpleOutlineToggle.onchange = (e) => {
    simpleOutline = e.target.checked;
    saveSetting('simpleOutline', simpleOutline);
    rebuildSelectionOutline();
    if (hovered) rebuildOutline(getHoverOutline(), getHoverOutlineMat(), hovered.node);
    updateSelectionOutline();
    updateHoverOutline();
  };
}
if (hoverOutlineToggle) { hoverOutlineToggle.checked = showHoverOutline; hoverOutlineToggle.onchange = (e) => { showHoverOutline = e.target.checked; saveSetting('hoverOutline', showHoverOutline); if (!showHoverOutline) { hovered = null; clearOutline(getHoverOutline()); } updateHoverOutline(); }; }
if (frontNormalToggle) { frontNormalToggle.checked = showFrontNormal; frontNormalToggle.onchange = (e) => { showFrontNormal = e.target.checked; saveSetting('frontNormal', showFrontNormal); updateNormalIndicator(); updateCollisionArrows(); }; }
{ const t = document.getElementById('toggle-paste-offset'); if (t) { t.checked = pasteOffset; t.onchange = (e) => { pasteOffset = e.target.checked; saveSetting('pasteOffset', pasteOffset); }; } }
if (scaleUniformToggle) { scaleUniformToggle.checked = scaleUniform; scaleUniformToggle.onchange = (e) => { scaleUniform = e.target.checked; saveSetting('scaleUniform', scaleUniform); syncUniformBtn(); }; }

function wireSnapInput(input, valueEl, value, min, max, step, setValue) {
  if (!input) return;
  const setUi = (v) => {
    input.value = String(v);
    if (valueEl) valueEl.textContent = formatSnapValue(v);
  };
  setUi(value);
  input.title = '0 disables snapping';
  input.oninput = (e) => {
    const next = clampSnapValue(e.target.value, min, max, step);
    setUi(next);
    setValue(next);
    applySnapSettings();
  };
}
wireSnapInput(moveSnapInput, moveSnapValue, moveSnap, 0, 5, 0.1, (v) => { moveSnap = v; saveSetting('moveSnap', moveSnap); });
wireSnapInput(rotateSnapInput, rotateSnapValue, rotateSnap, 0, 180, 15, (v) => { rotateSnap = v; saveSetting('rotateSnap', rotateSnap); });
wireSnapInput(scaleSnapInput, scaleSnapValue, scaleSnap, 0, 1, 0.1, (v) => { scaleSnap = v; saveSetting('scaleSnap', scaleSnap); });
const snapOnShiftToggle = document.getElementById('toggle-snap-on-shift');
if (snapOnShiftToggle) {
  snapOnShiftToggle.checked = snapOnShift;
  snapOnShiftToggle.onchange = (e) => { snapOnShift = e.target.checked; saveSetting('snapOnShift', snapOnShift); applySnapSettings(); };
}
const copyTransformScaleToggle = document.getElementById('toggle-copy-transform-scale');
if (copyTransformScaleToggle) {
  copyTransformScaleToggle.checked = copyTransformIncludeScale;
  copyTransformScaleToggle.onchange = (e) => { copyTransformIncludeScale = e.target.checked; saveSetting('copyTransformIncludeScale', copyTransformIncludeScale); };
}
const clearCollisionToggle = document.getElementById('toggle-clear-collision');
if (clearCollisionToggle) {
  clearCollisionToggle.checked = clearCollisionOnReset;
  clearCollisionToggle.onchange = (e) => { clearCollisionOnReset = e.target.checked; saveProjectSetting('clearCollisionOnReset', clearCollisionOnReset); syncPublishState(); };
}
const showPlayerToggle = document.getElementById('toggle-show-player');
if (showPlayerToggle) {
  showPlayerToggle.checked = showPlayerMarker;
  showPlayerToggle.onchange = (e) => { showPlayerMarker = e.target.checked; saveSetting('showPlayerMarker', showPlayerMarker); refreshPlayerMarker(); };
}
const validateSpawnToggle = document.getElementById('toggle-validate-spawn');
if (validateSpawnToggle) {
  validateSpawnToggle.checked = validateSpawn;
  validateSpawnToggle.onchange = (e) => { validateSpawn = e.target.checked; saveSetting('validateSpawn', validateSpawn); };
}
const publishResetToggle = document.getElementById('toggle-publish-reset');
if (publishResetToggle) {
  publishResetToggle.checked = publishReset;
  publishResetToggle.onchange = (e) => { publishReset = e.target.checked; saveProjectSetting('publishReset', publishReset); };
}
// HD-on-Publish mode (project-scoped): off / publish changes / clone standard over HD.
const HD_PUBLISH_HINTS = {
  off:     'Publishing only updates the standard zone. The HD zone is left untouched.',
  publish: 'After publishing the standard zone, the same change-set is applied to the HD DAT — its high-res textures are kept.',
  clone:   'After publishing the standard zone, its DAT is copied byte-for-byte over the HD DAT (a straight file copy). The HD zone becomes an exact mirror of the standard one — its HD textures are replaced. Best for new / custom maps that have no real HD assets.',
};
function updateHdPublishModeHint() {
  const hint = document.getElementById('hd-publish-mode-hint');
  if (hint) hint.textContent = HD_PUBLISH_HINTS[hdPublishMode] || '';
}
const hdPublishModeSel = document.getElementById('hd-publish-mode');
if (hdPublishModeSel) {
  hdPublishModeSel.value = hdPublishMode;
  updateHdPublishModeHint();
  hdPublishModeSel.onchange = (e) => { hdPublishMode = e.target.value; saveProjectSetting('hdPublishMode', hdPublishMode); updateHdPublishModeHint(); };
}
[
  ['dev-zone-min',  'devZoneMin',  400],
  ['dev-zone-max',  'devZoneMax',  499],
  ['dev-model-min', 'devModelMin', 20000],
  ['dev-model-max', 'devModelMax', 29999],
  ['dev-bgm-min',   'devBgmMin',  200],
  ['dev-bgm-max',   'devBgmMax',  299],
  ['dev-rom-path',  'devRomPath',  2],
].forEach(([id, key, def]) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = String(loadSetting(key, def));
  el.onchange = (e) => {
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v) && v >= 0) saveSetting(key, v);
    else e.target.value = String(loadSetting(key, def));
  };
});
document.getElementById('obj-show')?.addEventListener('click', () => setListedVisibility(false, true));
document.getElementById('obj-hide')?.addEventListener('click', () => setListedVisibility(false, false));
document.getElementById('vfx-show')?.addEventListener('click', () => setListedVisibility(true, true));
document.getElementById('vfx-hide')?.addEventListener('click', () => setListedVisibility(true, false));
document.getElementById('sound-show')?.addEventListener('click', () => setListedSoundsVisible(true));
document.getElementById('sound-hide')?.addEventListener('click', () => setListedSoundsVisible(false));

// ── Cross-zone effect copy (VFX / SFX) ────────────────────────────────────────
// Copying a VFX generator or sound emitter from another zone is done via the normal
// copy + paste flow: paste records the change-set {op:'add', source_id, source_dat, pos}
// and apply_changes splices the generator (+ its deps) cross-DAT at Publish, mirroring
// `xi fx copy`. The two helpers below build the editor-side placeholder node for that.

// Build (but don't register) the placeholder node for a cross-zone effect copy. The editor
// has no real particle sim — an effect is a hidden Group represented by a billboard icon — so
// buildXZoneEffectNode, addXZoneEffect → core/zone-effects.js

// ── SFX playback — moved to sfx-playback.js ──────────────────────────────────
// playSound, stopSound, updateSfxPlayUI are imported from sfx-playback.js.
// initSfxPlayback() is called below in the init section.

// ── Zone BGM — extracted to zone-music.js ─────────────────────────────────
// initZoneMusic() and initZoneMusicModalListeners() / initMusicContextMenuListeners()
// are called below in the init section after setStatus / xi_alert are available.
document.getElementById('sky-show')?.addEventListener('click', () => setSkyVisible(true));
document.getElementById('sky-hide')?.addEventListener('click', () => setSkyVisible(false));
document.getElementById('mob-show')?.addEventListener('click', () => setMobVisibility(true));
document.getElementById('mob-hide')?.addEventListener('click', () => setMobVisibility(false));
document.getElementById('cols-add-box')?.addEventListener('click', () => addCollisionPrimitive('box'));
document.getElementById('cols-add-plane')?.addEventListener('click', () => addCollisionPrimitive('plane'));
document.getElementById('marker-add')?.addEventListener('click', () => addMarker('flag'));
document.getElementById('marker-show')?.addEventListener('click', () => setMarkerVisibility(true));
document.getElementById('marker-hide')?.addEventListener('click', () => setMarkerVisibility(false));
document.getElementById('text-add')?.addEventListener('click', () => addTextPlane());
document.getElementById('text-show')?.addEventListener('click', () => setTextVisibility(true));
document.getElementById('text-hide')?.addEventListener('click', () => setTextVisibility(false));

if (mdetType) {
  mdetType.onchange = () => {
    if (!selected?.isMarker) return;
    selected.node.userData.markerType = mdetType.value;
    updateChangesUI();
  };
}
if (mdetName) {
  const applyRename = () => {
    if (!selected?.isMarker || !mdetName.value.trim()) return;
    selected.name = mdetName.value.trim();
    selected.node.name = selected.name;
    buildObjectList();
    updateChangesUI();
  };
  mdetName.onblur = applyRename;
  mdetName.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); applyRename(); } };
}
if (mdetColor) {
  mdetColor.oninput = () => {
    if (!selected?.isMarker) return;
    const col = mdetColor.value;
    selected.node.userData.markerColor = col;
    const glyph = selected.node.userData.markerCsIcon || 'flag';
    selected.node.material.map = getPinTexture(col, glyph);
    selected.node.material.needsUpdate = true;
    updateChangesUI();
  };
  // On confirm the native colour picker leaves the <input> focused, so the WASD keydown
  // handler bails on it (e.target is an INPUT) and camera piloting appears frozen until you
  // click elsewhere. Release focus back to the body when the colour is committed.
  mdetColor.onchange = () => mdetColor.blur();
}
if (mdetCsIcon) {
  mdetCsIcon.onchange = () => {
    if (!selected?.isMarker) return;
    const glyph = mdetCsIcon.value;
    selected.node.userData.markerCsIcon = glyph;
    delete selected.node.userData.markerIcon;
    selected.node.material.map = getPinTexture(selected.node.userData.markerColor || '#42d9c8', glyph);
    selected.node.material.needsUpdate = true;
    updateChangesUI();
  };
}
if (mdetDesc) {
  mdetDesc.onchange = () => {
    if (!selected?.isMarker) return;
    selected.node.userData.markerDesc = mdetDesc.value;
    updateChangesUI();
  };
}
{
  const pinBtn = document.getElementById('mdet-pin-floor');
  if (pinBtn) pinBtn.onclick = () => {
    if (!selected?.isMarker) return;
    const node = selected.node;
    const oldY = node.position.y;
    const newY = pinMarkerToFloor(selected);
    if (newY == null) { setStatus('no floor found under this marker', true); return; }
    if (Math.abs(newY - oldY) < 1e-4) { setStatus(`${selected.name} is already on the floor`); return; }
    pushCommand({
      undo: () => { node.position.y = oldY; updateChangesUI(); },
      redo: () => { node.position.y = newY; updateChangesUI(); },
    });
    updateChangesUI();
    setStatus(`pinned ${selected.name} to floor (y ${oldY.toFixed(3)} → ${newY.toFixed(3)})`);
  };
}

if (cdetBlockCamera) {
  cdetBlockCamera.onchange = () => {
    if (!selected?.isCollisionPrimitive) return;
    const m = selected.node.userData.collisionMat || defaultCollisionMat(selected.collisionType || 'box');
    // Block Camera ON = the camera is blocked = hitWall clear (wall:false). Terrain is preserved.
    setCollisionMat(selected.node, { wall: !cdetBlockCamera.checked, terrain: m.terrain });
    updateCollisionArrows();
    updateChangesUI();
  };
}
if (cdetTerrain) {
  cdetTerrain.onchange = () => {
    if (!selected?.isCollisionPrimitive) return;
    const m = selected.node.userData.collisionMat || defaultCollisionMat(selected.collisionType || 'box');
    setCollisionMat(selected.node, { wall: m.wall, terrain: parseInt(cdetTerrain.value, 10) });
    updateChangesUI();
  };
}
function applyManualSegs() {
  if (!selected?.isCollisionPrimitive) return;
  const type = selected.collisionType;
  if (type !== 'box' && type !== 'plane' && type !== 'mesh') return;
  const clamp = (v) => Math.min(64, Math.max(1, parseInt(v) || 1));
  const x = clamp(cdetSegX?.value);
  const y = clamp(cdetSegY?.value);
  const z = clamp(cdetSegZ?.value);
  selected.subdivSegs = { x, y, z };
  _rebuildCollisionPrimGeo(selected);
  updateChangesUI();
}
if (cdetSegX) cdetSegX.onchange = applyManualSegs;
if (cdetSegY) cdetSegY.onchange = applyManualSegs;
if (cdetSegZ) cdetSegZ.onchange = applyManualSegs;

if (glbLit) glbLit.onchange = () => {
  const g = selected?.node?.userData?.glbImport; if (!g) return;
  g.lit = glbLit.checked;
  if (glbShadeRow) glbShadeRow.style.display = g.lit ? '' : 'none';
  applyGlbPreview(selected.node);
  updateChangesUI();
};
if (glbShade) glbShade.oninput = () => {
  const g = selected?.node?.userData?.glbImport; if (!g) return;
  const n = parseFloat(glbShade.value);
  const v = Math.max(0, Math.min(2, Number.isNaN(n) ? 1 : n));   // keep 0 (don't let `|| 1` snap it back)
  g.shade = v;
  if (glbShadeVal) glbShadeVal.textContent = v.toFixed(2);
  applyGlbPreview(selected.node);
  updateChangesUI();
};
if (glbOpaque) glbOpaque.onchange = () => {
  const g = selected?.node?.userData?.glbImport; if (!g) return;
  g.opaque = glbOpaque.checked;
  applyGlbPreview(selected.node);
  updateChangesUI();
};
// Two-sided is a publish-only flag (0x2000): editor already renders double-sided, so no
// preview change — it just rides into the change-set and the apply-changes GLB inject.
if (glbTwoSided) glbTwoSided.onchange = () => {
  const g = selected?.node?.userData?.glbImport; if (!g) return;
  g.doubleSided = glbTwoSided.checked;
  updateChangesUI();
};
// Text-plane inspector — each edit re-bakes the GLB (debounced while typing).
// tpText/tpSize/tpColor/tpPanel oninput handlers — wired inside initTextPlanes() (text-planes.js)
const disableVfxPaneToggle = document.getElementById('toggle-disable-vfx-pane');
if (disableVfxToggle) disableVfxToggle.checked = disableVfx;
if (disableVfxPaneToggle) disableVfxPaneToggle.checked = disableVfx;
// applyDisableVfx → core/zone-effects.js
disableVfxToggle?.addEventListener('change', (e) => applyDisableVfx(e.target.checked));
disableVfxPaneToggle?.addEventListener('change', (e) => applyDisableVfx(e.target.checked));
const vfxIconsToggle = document.getElementById('toggle-vfx-icons');
if (vfxIconsToggle) vfxIconsToggle.checked = showVfxIcons;
vfxIconsToggle?.addEventListener('change', (e) => {
  showVfxIcons = e.target.checked;
  saveSetting('showVfxIcons', showVfxIcons);
  applyVfxIconVisibility();
});
const axisGizmoToggle = document.getElementById('toggle-axis-gizmo');
if (axisGizmoToggle) axisGizmoToggle.checked = showAxisGizmo;
axisGizmoToggle?.addEventListener('change', (e) => {
  showAxisGizmo = e.target.checked;
  saveSetting('showAxisGizmo', showAxisGizmo);   // render loop reads the flag each frame
});
// Auto-save settings
const autoSaveToggle = document.getElementById('toggle-autosave');
const autoSaveActionToggle = document.getElementById('toggle-autosave-action');
if (autoSaveToggle) { autoSaveToggle.checked = autoSave; autoSaveToggle.onchange = (e) => { autoSave = e.target.checked; saveSetting('autoSave', autoSave); applyAutoSaveMode(); }; }
if (autoSaveActionToggle) { autoSaveActionToggle.checked = saveEveryAction; autoSaveActionToggle.onchange = (e) => { saveEveryAction = e.target.checked; saveSetting('saveEveryAction', saveEveryAction); applyAutoSaveMode(); }; }
applyAutoSaveMode();
// Publish Cutscenes to Pivot — cutscene-author.js reads the setting live at publish time.
const publishPivotToggle = document.getElementById('toggle-publish-pivot');
if (publishPivotToggle) {
  publishPivotToggle.checked = loadSetting('publishCutscenesToPivot', true);
  publishPivotToggle.onchange = (e) => saveSetting('publishCutscenesToPivot', e.target.checked);
}
const vfxIconSizeSlider = document.getElementById('vfx-icon-size');
const vfxIconSizeVal = document.getElementById('vfx-icon-size-val');
if (vfxIconSizeSlider) vfxIconSizeSlider.value = String(vfxIconSize);
if (vfxIconSizeVal) vfxIconSizeVal.textContent = vfxIconSize + 'px';
vfxIconSizeSlider?.addEventListener('input', (e) => {
  vfxIconSize = Math.max(10, Math.min(80, Math.round((Number(e.target.value) || 35) / 5) * 5));   // snap to 5px
  saveSetting('vfxIconSize', vfxIconSize);
  if (vfxIconSizeVal) vfxIconSizeVal.textContent = vfxIconSize + 'px';
});
updateZoomSpeedUi();

// ── object-list module init ───────────────────────────────────────────────────
initObjectList({
  getCurrentZoneUrl:        () => currentZoneUrl,
  getPlacements:            () => placements,
  getPlacementGroups:       () => placementGroups,
  setPlacementGroups:       (v) => { placementGroups = v; },
  getPlacementSet:          () => placementSet,
  getSelectedSet:           () => selectedSet,
  getSelected:              () => selected,
  getCamera:                () => camera,
  getRaycaster:             () => raycaster,
  getZoneRoot:              () => zoneRoot,
  getTemplates:             () => templates,
  getEditMode,
  isInitAnchor,
  isLocked,
  transform,
  setStatus,
  openModal,
  select,
  selectRange,
  deleteSelected,
  updateSelectionOutline,
  rebuildSelectionOutline,
  updateSelectionReadout,
  setIconVisible,
  iconVisible,
  playSound,
  stopSound,
  isSfxStoppable,
  updateGlbDetailsPanel,
  refreshGlbModel,
  createCollisionFromMesh,
  copySelected,
  clipboardSummary,
  pasteFromClipboard,
  snapshotTRS,
  pushSelectionTransformCommand,
  getCopyTransformIncludeScale: () => copyTransformIncludeScale,
  commitPastedItems,
  lightGlbRef,
  xiName,
  uniquePlacementName,
  instantiate,
  setMarkerVisibilityImpl: _setMarkerVisibilityImpl,
  updateZoneInfo,
  loadZoneSettingsPanel,
  get tpText() { return tpText; },
  getEl: (id) => document.getElementById(id),
});

// ── player-marker module init ─────────────────────────────────────────────────
initPlayerMarker({
  getSelected:             () => selected,
  getZoneRoot:             () => zoneRoot,
  getPlacements:           () => placements,
  getZonesData:            () => zonesData,
  getCustomZonesData:      () => customZonesData,
  getAddedEntries:         () => addedEntries,
  getFootstepSourceZone:   () => footstepSourceZone,
  getPlayerMarkerGroup:    () => playerMarkerGroup,
  setPlayerMarkerGroup:    (v) => { playerMarkerGroup = v; },
  getPlayerSpawn:          () => playerSpawn,
  setPlayerSpawn:          (v) => { playerSpawn = v; },
  getShowPlayerMarker:     () => showPlayerMarker,
  currentZoneId,
  getCollisionPrimGroup,
  getCollisionGroup,
  defaultCollisionMat,
  collisionPrimSegs:       (type, scale) => { try { return _collisionPrimSegs(type, scale); } catch { return { x: 1, y: 1, z: 1 }; } },
  updateMarkerDetailsPanelImpl: _updateMarkerDetailsPanelImpl,
  setStatus,
  getEl:                   (id) => document.getElementById(id),
});

// ── zone-effects module init ──────────────────────────────────────────────────
initZoneEffects({
  getScene:              () => scene,
  getCamera:             () => camera,
  getRenderer:           () => renderer,
  getZoneRoot:           () => zoneRoot,
  getPlacements:         () => placements,
  getPlacementSet:       () => placementSet,
  getAddedEntries:       () => addedEntries,
  getVfxIconGroup:       () => vfxIconGroup,
  setVfxIconGroup:       (v) => { vfxIconGroup = v; },
  getShowVfxIcons:       () => showVfxIcons,
  getVfxIconSize:        () => vfxIconSize,
  getEmittedEffects:     () => emittedEffects,
  getAnimatedTextures:   () => animatedTextures,
  getWaterTints:         () => waterTints,
  getDefaultTex:         () => DEFAULT_TEX,
  getGainUniform:        () => gainUniform,
  getLightUniforms:      () => lightUniforms,
  getFogUniforms:        () => fogUniforms,
  getLightUniformsGlsl:  () => LIGHT_UNIFORMS_GLSL,
  getLitRGBGlsl:         () => litRGB_GLSL,
  resolveTexture,
  applyDayColors,
  setDisableVfx:         (v) => { disableVfx = v; },
  saveProjectSetting,
  getCurrentZoneUrl:     () => currentZoneUrl,
  loadZone:              (...a) => loadZone(...a),
  markChange,
  buildObjectList,
  select,
  updateChangesUI,
  setStatus,
  getEl:                 (id) => document.getElementById(id),
  getCanvas:             () => canvas,
});

// ── zone-nav module init ──────────────────────────────────────────────────────
initZoneNav({
  loadZone,
  hasUnsavedChanges,
  xi_confirm,
  openContextMenu,
  ensureEventsLoaded,
  populateFootstepSourceZones,
  updateHdUI,
  updateMakeTemplateBtn,
  ensureZoneMusic,
  applyClearCollisionPolicy: () => applyClearCollisionPolicy?.(),
  getCurrentZoneUrl:       () => currentZoneUrl,
  currentZoneId,
  getZonesData:            () => zonesData,
  setZonesData:            (v) => { zonesData = v; },
  getCustomZonesData:      () => customZonesData,
  setCustomZonesData:      (v) => { customZonesData = v; },
  getParsed:               () => parsed,
  getCurrentCompanionDats: () => currentCompanionDats,
  getNavmeshNavFile:       () => navmeshNavFile,
  getNavmeshGroup:         () => navmeshGroup,
  getFfxiDir:              () => ffxiDir,
  getFfxiHdDir:            () => ffxiHdDir,
  getMode,
  getLauncherState:        () => launcherState,
  getEnvironments:         () => environments,
  setCurrentWeather:       (v) => { currentWeather = v; },
  get updateDeleteZoneBtn() { return updateDeleteZoneBtn; },
});
renderPinnedZones();
setActiveTab(loadSetting('activeTab', 'objs'));

// ── selection module init ────────────────────────────────────────────────────
initSelection({
  scene,
  camera,
  canvas,
  transform,
  flyState,
  clientToNdc,
  getActiveCamera:        getActiveViewportCamera,
  get csCamera() { return csCamera; },
  get cutsceneCamActive() { return cutsceneCamActive; },
  selectionEl,
  transformEl,
  syncSelectionModal:     _syncSelectionModal,
  toolDeleteLabel:        document.getElementById('tool-delete-label'),
  getSelected:            () => selected,
  setSelected:            (p) => { selected = p; },
  getSelectedSet:         () => selectedSet,
  getHovered:             () => hovered,
  setHovered:             (p) => { hovered = p; },
  getHoveredIconNode:     () => hoveredIconNode,
  setHoveredIconNode:     (n) => { hoveredIconNode = n; },
  getPlacements:          () => placements,
  getZoneRoot:            () => zoneRoot,
  getCurrentZoneUrl:      () => currentZoneUrl,
  setNavScale:            (v) => { navScale = v; },
  getShowOutline:         () => showOutline,
  getShowHoverOutline:    () => showHoverOutline,
  getShowFrontNormal:     () => showFrontNormal,
  getSimpleOutline:       () => simpleOutline,
  getLists:               () => getRenderedLists(),
  isLocked,
  isInitAnchor,
  isWorldPickable,
  groupForPlacement,
  placementsInGroup,
  toPlacement,
  pickIcon,
  tabForEntry,
  setActiveTab,
  openContextMenu,
  updateSpawnWarning,
  updateMarkerDetailsPanel,
  updateGlbDetailsPanel,
  updateCollisionDetailsPanel,
  updateSoundDetailsPanel,
  updateSfxPlayUI,
  updateChangesUI,
  buildObjectList,
  markChange,
  pushCommand,
  saveZoneSetting,
  loadZoneSetting,
  getCsActors,
  getCsLetterbox,
  getCsCinematicViewport: csGetCinematicViewport,   // non-null only while Fixed Ratio (16:9) is live
  csToggleActorSelection,
  csClearActorSelection,
  getMode,
});

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMovePick);
canvas.addEventListener('pointerup', onPointerUp);

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w || canvas.height !== h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    cameraAspectUpdate(w, h);
    if (typeof syncViewFrame === 'function') syncViewFrame();
  }
}
window.addEventListener('resize', resize);

let fpsFrames = 0, fpsElapsed = 0;
let _dcLast = 0, _triLast = 0, _fpsLast = 0;   // perf panel: last main-scene render stats
let lastCameraSave = 0;
const _cineClearTmp = new THREE.Color();        // scratch for save/restore of the clear colour in cinematic render

// ── Orientation axis gizmo (bottom-left) ─────────────────────────────────────
// A small X/Y/Z indicator overlaid each frame, mirroring the camera's orientation so
// "which way is up" is always obvious. Y-up setup: X = red (left/right), Y = green
// (up/down), Z = blue (depth). Rendered as a second mini-scene into a corner viewport.
const axisGizmoScene = new THREE.Scene();
const axisGizmoCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.01, 10);
const AXIS_GIZMO_PX = 96;            // on-screen size of the gizmo box (CSS px)
const _gizmoFullSize = new THREE.Vector2();
function makeAxisLabel(letter, cssColor) {
  const px = 96;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const ctx = c.getContext('2d');
  ctx.fillStyle = cssColor;
  ctx.font = `bold ${Math.round(px * 0.72)}px "Roboto Mono", ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, px / 2, px * 0.55);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  sp.scale.setScalar(0.6);
  return sp;
}
(function buildAxisGizmo() {
  const axes = [
    { v: [1, 0, 0], hex: 0xff4d4d, css: '#ff8080', letter: 'X' },   // right / left
    { v: [0, 1, 0], hex: 0x4ad66b, css: '#7fe890', letter: 'Y' },   // up / down
    { v: [0, 0, 1], hex: 0x4d8dff, css: '#86b2ff', letter: 'Z' },   // depth
  ];
  for (const a of axes) {
    const dir = new THREE.Vector3(...a.v).normalize();
    axisGizmoScene.add(new THREE.ArrowHelper(dir, new THREE.Vector3(0, 0, 0), 1.05, a.hex, 0.34, 0.22));
    const label = makeAxisLabel(a.letter, a.css);
    label.position.copy(dir).multiplyScalar(1.45);
    axisGizmoScene.add(label);
  }
})();
// Overlay the gizmo into a small bottom-left viewport, oriented to match the main camera.
function renderAxisGizmo() {
  if (!showAxisGizmo) return;
  axisGizmoCam.position.set(0, 0, 1).applyQuaternion(camera.quaternion).multiplyScalar(3.2);
  axisGizmoCam.quaternion.copy(camera.quaternion);
  axisGizmoCam.updateMatrixWorld();
  const pad = 12;
  renderer.getSize(_gizmoFullSize);
  renderer.autoClear = false;                                     // overlay — keep the drawn scene
  renderer.setScissorTest(true);
  renderer.setViewport(pad, pad, AXIS_GIZMO_PX, AXIS_GIZMO_PX);    // x from left, y from bottom
  renderer.setScissor(pad, pad, AXIS_GIZMO_PX, AXIS_GIZMO_PX);
  renderer.clearDepth();                                          // fresh depth so it isn't occluded
  renderer.render(axisGizmoScene, axisGizmoCam);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, _gizmoFullSize.x, _gizmoFullSize.y);
  renderer.setScissor(0, 0, _gizmoFullSize.x, _gizmoFullSize.y);
  renderer.autoClear = true;
}

const FRAME_MS = 1000 / 60;   // cap the editor at 60 fps (skip extra frames on 120/144Hz displays)
let _lastFrameT = 0;
function animate() {
  requestAnimationFrame(animate);
  const _now = performance.now();
  if (_now - _lastFrameT < FRAME_MS) return;            // too soon since last render — skip
  _lastFrameT = _now - ((_now - _lastFrameT) % FRAME_MS); // keep the remainder so we don't drift slow
  resize();
  const dt = flyClock.getDelta();
  if (fpsEl) {
    fpsFrames++;
    fpsElapsed += dt;
    if (fpsElapsed >= 0.5) {
      _fpsLast = Math.round(fpsFrames / fpsElapsed);
      fpsEl.textContent = String(_fpsLast);
      fpsFrames = 0; fpsElapsed = 0;
      updatePerfPanel();   // refresh the Performance panel (no-op unless open)
    }
  }
  flyUpdate(dt);
  // scroll water UVs (xim's TextureCoordinateUpdater: += amount per frame @ ~30fps)
  if (animatedTextures.length) {
    const frames = dt * 30;
    for (const a of animatedTextures) { a.uniform.value.x += a.scroll[0] * frames; a.uniform.value.y += a.scroll[1] * frames; }
  }
  const activeCamera = cutsceneCamActive ? csCamera : camera;
  // NOTE: the transform gizmo stays on the viewport `camera` (never csCamera). Pointing it at
  // the cutscene camera made TransformControls scale the gizmo to that camera — and when the
  // cutscene camera sits on the gizmo's object (e.g. the camera rig) it blew up to a
  // full-screen crosshair. Object editing always uses the viewport camera anyway.
  if (emittedEffects.length) updateEmittedEffects(dt * 30);
  const zoneVfx = getZoneVfxSystem();
  if (zoneVfx && zoneVfx.emitters.length) { zoneVfx.camera = activeCamera; try { zoneVfx.update(); } catch (e) {} }

  csRenderTick(dt, activeCamera);   // cutscene NPC anims + VFX + actor outline/tag
  for (const p of placements) { if (p.isMob && p.node.userData.mobMixer) p.node.userData.mobMixer.update(dt); }   // placed-mob idle anims
  if (vfxIconGroup && vfxIconGroup.visible) {
    const sc = vfxIconScale();
    const _wp = new THREE.Vector3();
    for (const sp of vfxIconGroup.children) {
      if (sp.userData.vfxNode) sp.position.copy(sp.userData.vfxNode.position);
      sp.getWorldPosition(_wp);
      const f = vfxIconDistFactor(_wp);          // 1 (near) → VFX_ICON_MIN (far)
      const a = sp.userData.aspect || 1;
      const hov = sp.userData.vfxNode === hoveredIconNode;   // mouse-over highlight
      const s = sc * f * (hov ? 1.25 : 1);
      sp.scale.set(s * a, s, 1);
      // Fade far icons too: remap the size factor onto opacity (hovered = full).
      const fadeT = (1 - f) / (1 - VFX_ICON_MIN);  // 0 near → 1 far
      sp.material.opacity = hov ? 1 : 1 - fadeT * (1 - VFX_ICON_FADE_MIN);
    }
  }
  updateDistanceCull();   // perf: hide small/distant placements past the draw distance (no-op unless enabled)
  updateSelectionOutline();
  updateHoverOutline();
  // csActorOutline + selected actor name tag are updated inside csRenderTick()
  syncIsolateEditLayers();   // keep gizmo + outlines visible while isolating (overlay-layer camera)
  const now = performance.now();
  if (now - lastCameraSave > 1000) { saveCurrentZoneCamera(); lastCameraSave = now; }
  // 16:9 letterbox on → render the active camera INTO the framed rectangle (above the
  // sequencer, inside the bars) at that aspect, so the framing is WYSIWYG with the game.
  // Otherwise render the full canvas at the full aspect.
  const _cine = (typeof csGetCinematicViewport === 'function') ? csGetCinematicViewport() : null;
  if (_cine && _cine.w > 0 && _cine.h > 0) {
    if (Math.abs(activeCamera.aspect - _cine.aspect) > 1e-4) { activeCamera.aspect = _cine.aspect; activeCamera.updateProjectionMatrix(); }
    const _W = canvas.clientWidth, _H = canvas.clientHeight;
    // Clear the whole canvas black first so the framed 16:9 render isn't ringed by stale
    // pixels when the black-bars overlay is off. Then render the scene INTO the framed rect.
    const _prevHex = renderer.getClearColor(_cineClearTmp).getHex(), _prevAlpha = renderer.getClearAlpha();
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, _W, _H);
    renderer.setClearColor(0x000000, 1); renderer.clear(true, true, false);
    renderer.setViewport(_cine.x, _cine.y, _cine.w, _cine.h);
    renderer.setScissor(_cine.x, _cine.y, _cine.w, _cine.h);
    renderer.setScissorTest(true);
    renderer.render(scene, activeCamera);
    renderer.setScissorTest(false);
    renderer.setClearColor(_prevHex, _prevAlpha);
    renderer.setViewport(0, 0, _W, _H);
    renderer.setScissor(0, 0, _W, _H);
  } else {
    const _fullA = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    if (Math.abs(activeCamera.aspect - _fullA) > 1e-4) { activeCamera.aspect = _fullA; activeCamera.updateProjectionMatrix(); }
    renderer.render(scene, activeCamera);
  }
  _dcLast = renderer.info.render.calls; _triLast = renderer.info.render.triangles;  // capture before the gizmo render overwrites info
  renderAxisGizmo();   // X/Y/Z orientation indicator, overlaid in the bottom-left corner
  // Sequencer-camera picture-in-picture: while the camera object is selected (gizmo
  // on it) and we're not piloting, peek through it in the bottom-right corner.
  const _pipShow = !!(csGetAuthorCamRig && transform.object === csGetAuthorCamRig() && !csIsCameraPiloting());
  if (_pipShow) {
    const _gv = transform.visible; transform.visible = false;   // don't draw the gizmo into the PiP
    csRenderCameraPreview(true);
    transform.visible = _gv;
  } else {
    csRenderCameraPreview(false);
  }
}
animate();

// refreshCustomZones and populateZones moved to core/zone-nav.js

// ── Projects launcher boot (after the Setup panel is done) ──────────────────
toolsBootPromise.then((boot) => {
  // The wizard owns every gate now, so by this point the screen is ours.
  document.body.classList.remove('wiz-active');
  initProjectsLauncher({
    setStatus,
    getModeMenu:           () => document.getElementById('mode-menu'),
    loadZone,
    setMode,
    setActiveTab,
    loadProjectSettings,
    applyProjectSettings,
    refreshProjectZones,
    getMode,
    getZoneElValue:        () => zoneEl?.value || '',
    loadSetting,
    showChangesLoader, hideChangesLoader,
    bridgeReady:           !!boot?.online,
  });
  // Setup is finished (or was already done) — go straight to the launcher.
  (async () => {
    try {
      openProjectsLauncher();
    } catch (e) {
      console.warn('[boot] launcher open failed', e);
      document.getElementById('app-loader')?.classList.add('hidden');
    }
    verifyWorkspaceOnBoot();
    populateZones();
  })();
}).catch((e) => {
  console.warn('[boot] setup promise rejected', e);
  document.body.classList.remove('wiz-active');
  document.getElementById('app-loader')?.classList.add('hidden');
  try { openProjectsLauncher(); } catch { /* ignore */ }
});

// ── Changes tracker — extracted to changes-tracker.js ────────────────────────
initChangesTracker({
  getPlacements:              () => placements,
  getPlacementSet:            () => placementSet,
  getZoneRoot:                () => zoneRoot,
  getVfxIconGroup:            () => vfxIconGroup,
  getParsed:                  () => parsed,
  getTemplates:               () => templates,
  getTransform:               () => transform,
  getSelectionEl:             () => selectionEl,
  getCurrentZoneUrl:          () => currentZoneUrl,
  getMusicChanges:            () => musicChanges,
  setMusicChanges,
  clearZoneBgmKey,
  renderZoneMusic,
  getFootstepSourceZone:      () => footstepSourceZone,
  setFootstepSourceZone:      (v) => { footstepSourceZone = v; },
  getStripInteractions:       () => stripInteractions,
  glbOriginOf,
  setStatus,
  xi_confirm,
  trsMatrix,
  addVfxIcon,
  setIconVisible,
  xiName,
  uniquePlacementName,
  instantiate,
  buildMeshTemplates,
  buildTextures,
  getKeyTables,
  parseZone,
  datUrl,
  resolveMeshName,
  buildGlbNode,
  buildSourceEffectPreviewNode,
  pastedEffectName,
  buildXZoneEffectNode,
  _buildCollisionPrimFromRec: buildCollisionPrimFromRec,
  addMarkerFromRec,
  addTextPlaneFromRec,
  select,
  pushCommand,
  buildObjectList,
  updateChangesUI,
  applyIsolateCollision,
  clearSelectionOutline,
  updateSelectionOutline,
  updateSelectionReadout,
  restoreLockOverrides,
  restoreVisibilityOverrides,
  autoGroupXiEffects,
  syncFootstepSourceUI,
  setStripInteractions,
  syncStripVisual,
  collectMarkerChanges,
  bakeCollisionPrimTris,
  visibilityKeyFor,
  iconVisible,
  defaultVisibilityFor,
  collectTextPlanes,
});

// ── Asset Browser — extracted to asset-browser.js ───────────────────────────
// initAssetBrowser is called after all main.js state is set up (see below near dropAssetOnViewport).

// ── Database Viewer — extracted to database-viewer.js ────────────────────────
initDatabaseViewer({
  bridgeCall, bridgeOnline, loadSetting, saveSetting,
  toggleModal, xi_alert, xi_confirm,
  refreshPlayerMarker,
});

// ── Zone Music — extracted to zone-music.js ───────────────────────────────
initZoneMusic({
  getZoneUrl: () => currentZoneUrl,
  currentZoneId,
  setStatus,
  xi_alert,
  showErrorBanner,
  updateChangesUI,
});
initZoneMusicModalListeners(() => currentZoneUrl, currentZoneId);
initMusicContextMenuListeners();
initTooltips();   // instant, styled tooltips app-wide (hijacks existing title="" attrs)

async function dropAssetOnViewport(asset, clientX, clientY) {
  if (!parsed?.meshes || !zoneRoot) { setStatus('drop: no zone loaded', true); return; }

  // Raycast at the pixel where the user dropped (cine-aware for 16:9)
  raycaster.setFromCamera(clientToNdc(clientX, clientY), getActiveViewportCamera());
  const hits = raycaster.intersectObject(zoneRoot, true)
    .filter(h => placementSet.has(h.object.parent ?? h.object) || h.object.parent?.userData?.zoneMesh);
  let hitPoint = hits.length ? hits[0].point.clone() : null;
  if (!hitPoint) {
    const originW = zoneRoot.localToWorld(new THREE.Vector3());
    const dist = Math.min(Math.max(camera.position.distanceTo(originW), 10), 500);
    hitPoint = raycaster.ray.at(dist, new THREE.Vector3());
  }

  const meshId      = asset.sample_mesh;
  const srcZoneUrl  = `game/${asset.sample_dat}`;
  const srcZoneName = asset.sample_zone;

  let tmplMap = templates;
  let resolvedId = resolveMeshName(meshId, parsed.meshes);

  if (!resolvedId) {
    setStatus(`fetching mesh from ${srcZoneName || srcZoneUrl}…`);
    try {
      const [srcBuf, srcKt] = await Promise.all([
        fetch(datUrl(srcZoneUrl)).then(r2 => { if (!r2.ok) throw new Error(`HTTP ${r2.status}`); return r2.arrayBuffer(); }),
        getKeyTables(),
      ]);
      const srcParsed = parseZone(srcBuf, srcKt);
      resolvedId = resolveMeshName(meshId, srcParsed.meshes);
      if (!resolvedId) { setStatus(`drop: mesh "${meshId}" not found in ${srcZoneName || srcZoneUrl}`, true); return; }
      tmplMap = buildMeshTemplates(srcParsed.meshes, buildTextures(srcParsed.textures));
    } catch (e) {
      setStatus(`drop: could not fetch source zone — ${e.message}`, true);
      return;
    }
  }

  const node = instantiate(tmplMap, resolvedId);
  node.rotation.order = 'ZYX';
  const localHit = zoneRoot.worldToLocal(hitPoint.clone());
  node.position.copy(localHit);
  node.quaternion.identity();
  node.scale.set(1, 1, 1);
  node.updateMatrix();

  const displayBase = xiName(meshId);
  node.name = uniquePlacementName(displayBase);
  node.userData = {
    placement: { meshId },
    addName: meshId,
    xiId: newXiId(),   // stable per-instance identity so reload/dedup/Remove never hinge on the display name
    sourceZone: srcZoneUrl.replace(/^game\//, ''),
    sourceName: meshId,
  };
  node.userData.original = { p: node.position.clone(), q: node.quaternion.clone(), s: node.scale.clone() };

  const entry = { node, name: node.name, isEffect: false };
  commitPastedItems([{ node, entry, parent: zoneRoot }], `placed ${meshId} from ${srcZoneName || 'asset browser'}`);
}

// ── Spell VFX preview (asset browser → viewport) ──────────────────────────────
// Drag/click a spell from the asset browser's Spells list → resolve its effect DAT + 0x07
// routine schedule (zone.spellVfx) → play it looping at the drop point via SpellRoutinePlayer.
// These are TRANSIENT previews to test the particle engine — never tracked as placements or
// published. Cleared on zone change or via the HUD's Clear button.

// World point under a screen pixel (raycast against placed zone geometry, else a sensible
// distance along the ray) — shared by drop and click-to-spawn. Mirrors dropAssetOnViewport.
function _viewportWorldPoint(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const nx = ((clientX - r.left) / r.width) * 2 - 1;
  const ny = -((clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera({ x: nx, y: ny }, camera);
  const hits = raycaster.intersectObject(zoneRoot, true)
    .filter(h => placementSet.has(h.object.parent ?? h.object) || h.object.parent?.userData?.zoneMesh);
  if (hits.length) return hits[0].point.clone();
  const originW = zoneRoot.localToWorld(new THREE.Vector3());
  const dist = Math.min(Math.max(camera.position.distanceTo(originW), 10), 500);
  return raycaster.ray.at(dist, new THREE.Vector3());
}


// Add a brand-new sound emitter with full undo/redo. Unlike commitPastedItems this also
// creates/removes the emitter's SFX icon (its only visible handle), so undo leaves no orphan.
function commitAddedSound(node, entry, statusMsg) {
  const iconsFor = () => (vfxIconGroup ? [...vfxIconGroup.children].filter(sp => sp.userData.vfxNode === node) : []);
  const add = () => {
    select(null);
    zoneRoot.add(node);
    if (!placements.includes(entry)) placements.push(entry);
    placementSet.add(node);
    addedEntries.add(entry);
    if (!iconsFor().length) addVfxIcon(node);
    markChange(node);
    buildObjectList();
    updateChangesUI();
    select(entry);
  };
  const remove = () => {
    if (transform.object === node) transform.detach();
    node.parent?.remove(node);
    for (const sp of iconsFor()) vfxIconGroup.remove(sp);
    const i = placements.indexOf(entry); if (i >= 0) placements.splice(i, 1);
    placementSet.delete(node);
    addedEntries.delete(entry);
    selectedSet.delete(entry);
    selected = lastSelectedEntry();
    if (selected && !isLocked(selected)) transform.attach(selected.node); else transform.detach();
    rebuildSelectionOutline(); updateSelectionReadout(); updateSelectionOutline();
    buildObjectList();
    updateChangesUI();
  };
  add();
  pushCommand({ undo: remove, redo: add });
  setStatus(statusMsg);
}

// ── Initialise asset browser (extracted to asset-browser.js) ─────────────────
initAssetBrowser({
  getScene:    () => scene,
  getZoneRoot: () => zoneRoot,
  camera,
  canvas,
  setStatus,
  selectNode:  (p) => select(p),
  buildGlbNode: null,  // kept in main.js; not needed by asset-browser.js
  commitAdded: async (asset, clientX, clientY) => { await dropAssetOnViewport(asset, clientX, clientY); },
  commitAddedSound: (node, entry, statusMsg) => { commitAddedSound(node, entry, statusMsg); },
  raycaster,
  placementSet,
  gltfLoader,
  setActiveTab,
  toggleModal,
  loadSetting,
  saveSetting,
  xi_alert,
  xi_confirm,
  showMusicContextMenu,
  showErrorBanner,
  bgmFmtTime,
  getBgmAudio,
  updateBgmUI,
  uniquePlacementName,
  newXiId,
  xiName,
  commitPastedItems: commitPastedItems,
  getEditMode,
  select,
  getPlacements:    () => placements,
  getAddedEntries:  () => addedEntries,
  buildObjectList,
  updateChangesUI,
  markChange,
  addVfxIcon,
  getVfxIconGroup:  () => vfxIconGroup,
  rebuildSelectionOutline,
  updateSelectionReadout,
  updateSelectionOutline,
  lastSelectedEntry,
  isLocked,
  transform,
  selectedSet,
  getCurrentZoneId:   () => currentZoneId(),
  getCurrentZoneUrl:  () => currentZoneUrl,
  getCurrentZoneName: () => {
    const e = zonesData.find((z) => z.path === currentZoneUrl)
           || customZonesData.find((z) => z.path === currentZoneUrl);
    return e ? (e.name || '') : '';
  },
});

// debug handle
window.__ed = { THREE, scene, camera, gainUniform, renderer, transform, lightUniforms, fogUniforms, environments: () => environments, applyEnvironment,
  renderOnce: () => { resize(); renderer.render(scene, camera); },
  flyUpdate, onFlyLook, getChanges, exportChanges,
  get placements() { return placements; }, get skyGroup() { return skyGroup; } };
