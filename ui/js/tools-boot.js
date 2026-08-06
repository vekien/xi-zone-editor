// Boot modal: ensure xi-tools is installed/updated, then start the bridge.
// Resolves only after the WebSocket is online, or the user explicitly continues offline.

const $ = (sel, el = document) => el.querySelector(sel);

function isTauri() {
  return !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
}

async function invoke(cmd, args = {}) {
  if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke(cmd, args);
  if (cmd === 'tools_status') {
    return {
      installed: true,
      localVersion: 'dev',
      latestVersion: null,
      updateAvailable: false,
      toolsDir: '',
      bridgeUrl: 'ws://127.0.0.1:8777/ws',
      bridgeRunning: true,
      error: null,
    };
  }
  if (cmd === 'bridge_start' || cmd === 'bridge_url') return 'ws://127.0.0.1:8777/ws';
  if (cmd === 'tools_install_or_update') throw new Error('Install only available in the desktop app');
  return null;
}

function ensureModal() {
  let root = document.getElementById('tools-boot-modal');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'tools-boot-modal';
  root.className = 'tools-boot-modal';
  root.innerHTML = `
    <div class="tools-boot-card">
      <div class="tools-boot-ico"><span class="material-symbols-outlined">inventory_2</span></div>
      <h2 class="tools-boot-title">XI Tools</h2>
      <p class="tools-boot-sub" id="tools-boot-sub">Checking for the xi-tools backend…</p>
      <div class="tools-boot-meta" id="tools-boot-meta"></div>
      <div class="tools-boot-bar"><div class="tools-boot-bar-fill" id="tools-boot-bar"></div></div>
      <div class="tools-boot-actions">
        <button type="button" class="tools-boot-btn primary" id="tools-boot-action" hidden>Download</button>
        <button type="button" class="tools-boot-btn" id="tools-boot-local" hidden>Use local folder…</button>
        <button type="button" class="tools-boot-btn" id="tools-boot-retry" hidden>Retry</button>
        <button type="button" class="tools-boot-btn ghost" id="tools-boot-skip" hidden>Continue offline</button>
      </div>
      <pre class="tools-boot-log" id="tools-boot-log" hidden></pre>
    </div>`;
  document.body.appendChild(root);
  return root;
}

function setSub(t) { const el = $('#tools-boot-sub'); if (el) el.textContent = t; }
function setMeta(t) { const el = $('#tools-boot-meta'); if (el) el.textContent = t; }
function setBar(pct) {
  const el = $('#tools-boot-bar');
  if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}
function logLine(t, { error = false } = {}) {
  const el = $('#tools-boot-log');
  if (!el) return;
  el.hidden = false;
  if (error) el.classList.add('is-error');
  el.textContent = (el.textContent ? `${el.textContent}\n` : '') + t;
  el.scrollTop = el.scrollHeight;
}
function logError(t) {
  const el = $('#tools-boot-log');
  if (el) el.classList.add('is-error');
  logLine(t, { error: true });
  setSub('Bridge failed to start');
}
function hideModal() {
  const root = document.getElementById('tools-boot-modal');
  if (root) root.classList.add('hidden');
}
function showActions({ action, retry, skip, local, actionLabel, skipLabel, localLabel } = {}) {
  const actionBtn = $('#tools-boot-action');
  const retryBtn = $('#tools-boot-retry');
  const skipBtn = $('#tools-boot-skip');
  const localBtn = $('#tools-boot-local');
  if (actionBtn) {
    actionBtn.hidden = !action;
    if (actionLabel) actionBtn.textContent = actionLabel;
  }
  if (retryBtn) retryBtn.hidden = !retry;
  if (localBtn) {
    localBtn.hidden = !local;
    if (localLabel) localBtn.textContent = localLabel;
  }
  if (skipBtn) {
    skipBtn.hidden = !skip;
    if (skipLabel) skipBtn.textContent = skipLabel;
  }
}

function waitForBridge(bridge, ms = 20000) {
  return new Promise((resolve) => {
    if (bridge.bridgeOnline?.()) { resolve(true); return; }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      unsub?.();
      resolve(ok);
    };
    const unsub = bridge.onBridgeStatus?.((on) => { if (on) finish(true); });
    const poll = setInterval(() => {
      bridge.connectBridge?.();
      if (bridge.bridgeOnline?.()) finish(true);
    }, 250);
    const timer = setTimeout(() => finish(false), ms);
    bridge.connectBridge?.();
  });
}

/**
 * @param {{
 *   setBridgeUrl: (u:string)=>void,
 *   connectBridge: ()=>void,
 *   bridgeOnline: ()=>boolean,
 *   onBridgeStatus?: (fn:(on:boolean)=>void)=>()=>void,
 * }} bridge
 * @returns {Promise<{online:boolean}>}
 */
export async function runToolsBoot(bridge) {
  // Keep workspace setup hidden until tools boot finishes.
  document.body.classList.add('tools-booting');
  const setupOv = document.getElementById('setup-overlay');
  if (setupOv) setupOv.style.display = 'none';

  const root = ensureModal();
  root.classList.remove('hidden');
  showActions({});

  const finishOffline = () => {
    document.body.classList.remove('tools-booting');
    hideModal();
    return { online: false };
  };

  const finishOnline = async (url) => {
    showActions({});
    if (url) {
      bridge.setBridgeUrl(url);
      try { localStorage.setItem('xi.bridgeUrl', url); } catch { /* ignore */ }
    }
    setSub('Ensuring Python and starting bridge… (first run may download Python 3.12)');
    setBar(80);
    let startErr = null;
    try {
      const u = await invoke('bridge_start');
      if (u) {
        bridge.setBridgeUrl(u);
        try { localStorage.setItem('xi.bridgeUrl', u); } catch { /* ignore */ }
      }
      logLine('Bridge process started.');
    } catch (e) {
      startErr = String(e?.message || e);
      logError(startErr);
    }
    if (!startErr) {
      bridge.connectBridge();
      setSub('Connecting to bridge…');
      const ok = await waitForBridge(bridge, 25000);
      setBar(100);
      if (ok) {
        setSub('Backend ready.');
        document.body.classList.remove('tools-booting');
        setTimeout(hideModal, 300);
        return { online: true };
      }
      logError('WebSocket did not open on ws://127.0.0.1:8777/ws after the process started.');
    }
    setBar(100);
    showActions({
      action: true,
      retry: true,
      local: true,
      skip: true,
      actionLabel: 'Retry',
      localLabel: 'Use local folder…',
      skipLabel: 'Continue offline',
    });
    return new Promise((resolve) => {
      $('#tools-boot-action').onclick = () => runToolsBoot(bridge).then(resolve);
      $('#tools-boot-retry').onclick = () => runToolsBoot(bridge).then(resolve);
      $('#tools-boot-local').onclick = () => pickLocalTools().then(resolve);
      $('#tools-boot-skip').onclick = () => resolve(finishOffline());
    });
  };

  const pickLocalTools = async () => {
    showActions({});
    setSub('Choose your local xi-tools folder…');
    try {
      const path = await invoke('pick_tools_folder');
      if (!path) {
        setSub('No folder selected.');
        showActions({
          action: true,
          local: true,
          skip: true,
          actionLabel: 'Retry download',
          localLabel: 'Use local folder…',
          skipLabel: 'Continue offline',
        });
        return new Promise((resolve) => {
          $('#tools-boot-action').onclick = () => doInstall().then(resolve);
          $('#tools-boot-local').onclick = () => pickLocalTools().then(resolve);
          $('#tools-boot-skip').onclick = () => resolve(finishOffline());
        });
      }
      setSub('Validating local xi-tools…');
      const st = await invoke('tools_set_local_path', { path });
      logLine(`Using local xi-tools: ${st.toolsDir}`);
      setMeta(`Local · ${st.toolsDir}`);
      setBar(70);
      return finishOnline(st.bridgeUrl);
    } catch (e) {
      logError(String(e?.message || e));
      showActions({
        action: true,
        local: true,
        skip: true,
        actionLabel: 'Retry download',
        localLabel: 'Use local folder…',
        skipLabel: 'Continue offline',
      });
      return new Promise((resolve) => {
        $('#tools-boot-action').onclick = () => doInstall().then(resolve);
        $('#tools-boot-local').onclick = () => pickLocalTools().then(resolve);
        $('#tools-boot-skip').onclick = () => resolve(finishOffline());
      });
    }
  };

  const doInstall = async () => {
    showActions({});
    setSub('Downloading xi-tools release…');
    setBar(15);
    logLine('Fetching latest release from github.com/vekien/xi-tools …');
    try {
      const st = await invoke('tools_install_or_update');
      setBar(65);
      logLine(`Installed xi-tools v${st.localVersion || st.latestVersion || '?'}`.trim());
      setMeta(`v${st.localVersion || '?'} · ${st.toolsDir || ''}`);
      return finishOnline(st.bridgeUrl);
    } catch (e) {
      setSub('Download failed — use a local copy?');
      logError(String(e?.message || e));
      showActions({
        action: true,
        local: true,
        skip: true,
        actionLabel: 'Retry download',
        localLabel: 'Use local folder…',
        skipLabel: 'Continue offline',
      });
      return new Promise((resolve) => {
        $('#tools-boot-action').onclick = () => doInstall().then(resolve);
        $('#tools-boot-local').onclick = () => pickLocalTools().then(resolve);
        $('#tools-boot-skip').onclick = () => resolve(finishOffline());
      });
    }
  };

  // Browser / non-Tauri: still try local bridge, but allow offline.
  if (!isTauri()) {
    setSub('Connecting to local xi-tools bridge…');
    setBar(40);
    return finishOnline(null);
  }

  setSub('Checking xi-tools…');
  setBar(10);
  let status;
  try {
    status = await invoke('tools_status');
  } catch (e) {
    setSub('Could not check tools status.');
    logLine(String(e?.message || e));
    showActions({
      action: true,
      local: true,
      skip: true,
      actionLabel: 'Download xi-tools',
      localLabel: 'Use local folder…',
      skipLabel: 'Continue offline',
    });
    return new Promise((resolve) => {
      $('#tools-boot-action').onclick = () => doInstall().then(resolve);
      $('#tools-boot-local').onclick = () => pickLocalTools().then(resolve);
      $('#tools-boot-skip').onclick = () => resolve(finishOffline());
    });
  }

  if (status.error) logLine(status.error);
  setMeta([
    status.usingLocalOverride ? 'Local checkout' : null,
    status.localVersion && status.localVersion !== '0.0.0' ? `Installed: v${status.localVersion}` : (status.installed ? 'Installed' : 'Not installed'),
    status.latestVersion && !status.usingLocalOverride ? `Latest: v${status.latestVersion}` : null,
    status.toolsDir || null,
  ].filter(Boolean).join(' · '));

  // Already pointing at a valid local/downloaded install → just start the bridge.
  if (status.installed && status.usingLocalOverride) {
    setSub('Using local xi-tools checkout.');
    setBar(55);
    return finishOnline(status.bridgeUrl);
  }

  // Not installed → offer download or local folder (auto-try download first).
  if (!status.installed) {
    setSub('xi-tools is required for Save / Publish and workspaces. Download the latest release?');
    showActions({
      action: true,
      local: true,
      skip: true,
      actionLabel: 'Download xi-tools',
      localLabel: 'Use local folder…',
      skipLabel: 'Continue offline',
    });
    // Auto-start download; on failure the UI offers a local folder.
    return doInstall();
  }

  if (status.updateAvailable && status.latestVersion) {
    setSub(`Update available (v${status.localVersion} → v${status.latestVersion}).`);
    showActions({
      action: true,
      skip: true,
      actionLabel: 'Update now',
      skipLabel: 'Use installed version',
    });
    return new Promise((resolve) => {
      $('#tools-boot-action').onclick = () => doInstall().then(resolve);
      $('#tools-boot-skip').onclick = () => finishOnline(status.bridgeUrl).then(resolve);
    });
  }

  setSub(`xi-tools v${status.localVersion} is up to date.`);
  setBar(55);
  return finishOnline(status.bridgeUrl);
}
