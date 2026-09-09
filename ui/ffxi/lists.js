// One door for `lists/*.json` — the copy baked into this build, or a newer one
// downloaded from xi-tools.
//
// xi-tools authors the lists (`xi mv update`) and publishes them with a manifest
// of sha256s. This app ships a copy of both, and on boot asks the shell to
// replace any list whose contents have moved (src-tauri/src/lists.rs).
// `loadList('zones.json')` is what makes those downloads visible: it reads the
// downloaded copy when there is one and falls back to the baked file otherwise.
//
// Callers read their list once, when they first need it, so a file replaced
// during the boot sync is picked up by anything that reads it afterwards — but
// not by data already parsed. That is why the notice asks for a reload rather
// than trying to be clever about it.
//
// Ported from xi-model-viewer's ui/js/lists.js, against the same manifest.

function isTauri() {
  return !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
}

async function invoke(cmd, args = {}) {
  if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke(cmd, args);
  return null;   // browser / vite dev — only the baked lists exist
}

/** Names present in the download folder, resolved once per session. */
let downloadedPromise = null;

/**
 * The set of list names the app should read from the download folder rather than
 * the bundle. Empty when nothing has been downloaded, which is the normal case
 * for a fresh install.
 *
 * One status call, not a probe per list: `loadList` is called from several
 * places and a miss is the common path.
 */
function downloaded() {
  downloadedPromise ??= (async () => {
    try {
      if (!isTauri()) return new Set();
      const st = await invoke('lists_status');
      return new Set((st?.files || []).filter((f) => f.source === 'downloaded').map((f) => f.name));
    } catch {
      return new Set();
    }
  })();
  return downloadedPromise;
}

/**
 * Parsed `lists/<name>`, downloaded copy first, baked copy otherwise.
 *
 * Throws like the `fetch` it replaces when the baked list is missing too, so
 * callers that report that keep reporting it. A downloaded file that will not
 * parse falls back rather than failing the caller: downloads are verified by
 * hash before they replace anything, so this is the belt to that braces.
 */
export async function loadList(name) {
  if ((await downloaded()).has(name)) {
    try {
      const text = await invoke('lists_read', { name });
      if (text) return JSON.parse(text);
    } catch { /* fall through to the baked copy */ }
  }
  const res = await fetch(`lists/${name}`);
  if (!res.ok) throw new Error(`${res.status} lists/${name}`);
  return res.json();
}

/**
 * `loadList`, but `null` instead of throwing when the list is missing.
 * For callers that treat an absent list as "nothing to show".
 */
export async function loadListOrNull(name) {
  try {
    return await loadList(name);
  } catch {
    return null;
  }
}

/**
 * Boot sync: replace any list xi-tools has moved on from.
 *
 * Resolves to `{ files, bytes }` worth telling the user about, or null when
 * there was nothing to do — including every failure path, since being offline or
 * behind a proxy must not surface as an error anyone has to deal with. The shell
 * gives the check ten seconds and then gives up quietly.
 *
 * The session's source is pinned *before* the sync runs, so a download landing
 * mid-boot cannot change what this session reads. That is the point: the zone
 * dropdown built at second three and a panel opened at second thirty then show
 * the same data, and the reload in the notice is what actually switches over.
 */
export async function updateListsOnBoot() {
  try {
    if (!isTauri()) return null;
    await downloaded();
    const done = await invoke('lists_update');
    if (!done?.updated?.length) return null;
    return { files: done.updated, bytes: done.bytes || 0, error: done.error || null };
  } catch {
    return null;
  }
}

/** Disk-only status for the Settings › DAT Lists pane. Null when unavailable. */
export async function listsStatus() {
  try {
    if (!isTauri()) return null;
    return await invoke('lists_status');
  } catch {
    return null;
  }
}

/** The one network action on the DAT Lists pane. Throws only if the IPC itself does. */
export async function listsUpdate() {
  if (!isTauri()) throw new Error('List updates are only available in the desktop app');
  return invoke('lists_update');
}
