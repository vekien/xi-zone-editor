// tools-boot.js — ensure xi-tools is installed/updated, then start its bridge.
//
// Pure logic: every bit of rendering goes through the `view` the caller supplies, so
// this step can live inside the setup wizard instead of owning a modal of its own.
// Resolves once the WebSocket is online, or the user explicitly continues offline.

function isTauri() {
  return !!(window.__TAURI__ || window.__TAURI_INTERNALS__);
}

async function invoke(cmd, args = {}) {
  if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke(cmd, args);
  // Browser / vite dev: no shell to talk to. Pretend tools are present and let the
  // bridge connection attempt decide whether anything is actually listening.
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
 * @param {{
 *   line: (text:string)=>void,               // headline status
 *   meta: (text:string)=>void,               // version / path subtitle
 *   bar: (pct:number)=>void,
 *   log: (text:string, opts?:{error?:boolean})=>void,
 *   icon?: (name:string)=>void,
 *   choose: (opts:Array<{key:string,label:string,primary?:boolean}>)=>Promise<string>,
 *   clearChoices: ()=>void,
 * }} view
 * @returns {Promise<{online:boolean}>}
 */
export async function runToolsBoot(bridge, view) {
  view.clearChoices();

  const finishOffline = () => ({ online: false });

  const rememberUrl = (url) => {
    if (!url) return;
    bridge.setBridgeUrl(url);
    try { localStorage.setItem('xi.bridgeUrl', url); } catch { /* private mode */ }
  };

  const finishOnline = async (url) => {
    view.clearChoices();
    rememberUrl(url);
    view.line('Ensuring Python and starting the bridge…');
    view.meta('First run may download Python 3.12');
    view.bar(80);

    let startErr = null;
    try {
      rememberUrl(await invoke('bridge_start'));
      view.log('Bridge process started.');
    } catch (e) {
      startErr = String(e?.message || e);
      view.log(startErr, { error: true });
    }

    if (!startErr) {
      bridge.connectBridge();
      view.line('Connecting to the bridge…');
      const ok = await waitForBridge(bridge, 25000);
      view.bar(100);
      if (ok) {
        view.icon?.('check_circle');
        view.line('Backend ready.');
        return { online: true };
      }
      view.log('WebSocket did not open on ws://127.0.0.1:8777/ws after the process started.',
        { error: true });
    }
    view.bar(100);
    view.line('The backend could not be started.');
    return recover('Retry', () => runToolsBoot(bridge, view));
  };

  // Every failure path offers the same three ways out; keeping it in one place stops
  // the branches drifting apart (they previously each rebuilt the button set by hand).
  const recover = async (actionLabel, primary) => {
    const key = await view.choose([
      { key: 'action', label: actionLabel, primary: true },
      { key: 'local', label: 'Use local folder…' },
      { key: 'skip', label: 'Continue offline' },
    ]);
    if (key === 'action') return primary();
    if (key === 'local') return pickLocalTools();
    return finishOffline();
  };

  const pickLocalTools = async () => {
    view.clearChoices();
    view.line('Choose your local xi-tools folder…');
    try {
      const path = await invoke('pick_tools_folder');
      if (!path) {
        view.line('No folder selected.');
        return recover('Retry download', doInstall);
      }
      view.line('Validating local xi-tools…');
      const st = await invoke('tools_set_local_path', { path });
      view.log(`Using local xi-tools: ${st.toolsDir}`);
      view.meta(`Local checkout · ${st.toolsDir}`);
      view.bar(70);
      return finishOnline(st.bridgeUrl);
    } catch (e) {
      view.log(String(e?.message || e), { error: true });
      view.line('That folder could not be used.');
      return recover('Retry download', doInstall);
    }
  };

  const doInstall = async () => {
    view.clearChoices();
    view.line('Downloading the latest xi-tools release…');
    view.bar(15);
    view.log('Fetching latest release from github.com/vekien/xi-tools …');
    try {
      const st = await invoke('tools_install_or_update');
      view.bar(65);
      view.log(`Installed xi-tools v${st.localVersion || st.latestVersion || '?'}`.trim());
      view.meta(`v${st.localVersion || '?'} · ${st.toolsDir || ''}`);
      return finishOnline(st.bridgeUrl);
    } catch (e) {
      view.line('Download failed.');
      view.log(String(e?.message || e), { error: true });
      return recover('Retry download', doInstall);
    }
  };

  try {
    // Browser / vite dev: no Tauri shell, so just try whatever bridge is listening.
    if (!isTauri()) {
      view.line('Connecting to the local xi-tools bridge…');
      view.bar(40);
      return await finishOnline(null);
    }

    view.line('Checking xi-tools…');
    view.bar(10);

    let status;
    try {
      status = await invoke('tools_status');
    } catch (e) {
      view.line('Could not check the xi-tools status.');
      view.log(String(e?.message || e), { error: true });
      return await recover('Download xi-tools', () => runToolsBoot(bridge, view));
    }

    if (status.error) view.log(status.error);
    view.meta([
      status.usingLocalOverride ? 'Local checkout' : null,
      status.localVersion && status.localVersion !== '0.0.0'
        ? `Installed v${status.localVersion}`
        : (status.installed ? 'Installed' : 'Not installed'),
      status.latestVersion && !status.usingLocalOverride ? `Latest v${status.latestVersion}` : null,
      status.toolsDir || null,
    ].filter(Boolean).join(' · '));

    if (status.installed && status.usingLocalOverride) {
      view.line('Using your local xi-tools checkout.');
      view.bar(55);
      return await finishOnline(status.bridgeUrl);
    }

    if (!status.installed) {
      view.line('xi-tools is required. Downloading the latest release…');
      return await doInstall();
    }

    if (status.updateAvailable && status.latestVersion) {
      view.line(`An update is available: v${status.localVersion} → v${status.latestVersion}.`);
      const key = await view.choose([
        { key: 'update', label: 'Update now', primary: true },
        { key: 'keep', label: 'Keep current version' },
      ]);
      return key === 'update'
        ? await doInstall()
        : await finishOnline(status.bridgeUrl);
    }

    view.line(`xi-tools v${status.localVersion} is up to date.`);
    view.bar(55);
    return await finishOnline(status.bridgeUrl);
  } catch (e) {
    view.log(String(e?.message || e), { error: true });
    view.line('Something went wrong starting the backend.');
    return await recover('Retry', () => runToolsBoot(bridge, view));
  }
}
