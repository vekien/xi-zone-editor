// sfx-playback.js — SFX (sound emitter) playback for the level editor.
// Fetches .spw audio from the bridge backend, decodes to WAV, and plays via HTMLAudioElement.
// Init via initSfxPlayback({ getSelected, setStatus, bridgeOnline, bridgeCall, xi_alert, showErrorBanner }).

let _getSelected = null;
let _setStatus   = null;
let _bridgeOnline = null;
let _bridgeCall   = null;
let _xi_alert   = null;
let _showErrorBanner = null;

const sfxPlayBtn = document.getElementById('sfx-play');
const sfxStopBtn = document.getElementById('sfx-stop');
const sfxNowEl   = document.getElementById('sfx-now');

let _sfxAudio = null;        // reused HTMLAudioElement
let _sfxObjectUrl = null;    // current blob URL (revoked on stop/replace)
let _sfxPlayingId = null;    // soundId of the loaded clip (null = nothing loaded)
let _sfxLoading = false;
let _sfxReq = 0;             // monotonic token — invalidates a superseded in-flight decode

const _sfxLabel = (id) => 'se' + String(id).padStart(6, '0');
function _selectedSound() {
  const sel = _getSelected ? _getSelected() : null;
  return sel && sel.isSound ? sel : null;
}

export function initSfxPlayback({ getSelected, setStatus, bridgeOnline, bridgeCall, xi_alert, showErrorBanner }) {
  _getSelected     = getSelected;
  _setStatus       = setStatus;
  _bridgeOnline    = bridgeOnline;
  _bridgeCall      = bridgeCall;
  _xi_alert      = xi_alert;
  _showErrorBanner = showErrorBanner;

  sfxPlayBtn?.addEventListener('click', () => playSound());
  sfxStopBtn?.addEventListener('click', () => stopSound());
}

export function stopSound() {
  _sfxReq++;                 // any in-flight decode is now stale
  _sfxLoading = false;
  if (_sfxAudio) { try { _sfxAudio.pause(); } catch {} try { _sfxAudio.currentTime = 0; } catch {} }
  if (_sfxObjectUrl) { URL.revokeObjectURL(_sfxObjectUrl); _sfxObjectUrl = null; }
  _sfxPlayingId = null;
  if (sfxNowEl) sfxNowEl.textContent = '';
  updateSfxPlayUI();
}

export async function playSound(p) {
  p = p || _selectedSound();
  if (!p || !p.isSound) { _setStatus('Select a sound emitter to play it.', true); return; }
  const soundId = p.node.userData.effect?.soundId;
  if (soundId == null) { _setStatus('This sound emitter has no sound id to play.', true); return; }
  if (!_bridgeOnline()) { await _xi_alert('Bridge Offline', 'Playing sounds needs the backend — run the editor via `xi gui zone`.'); return; }
  stopSound();               // stop whatever's playing + bump the token
  const myReq = _sfxReq;
  _sfxLoading = true; updateSfxPlayUI();
  if (sfxNowEl) sfxNowEl.textContent = `decoding ${_sfxLabel(soundId)}…`;
  try {
    const r = await _bridgeCall('audio.decodeSfx', { soundId });
    if (myReq !== _sfxReq) return;   // a newer Play/Stop superseded this one
    const bin = atob(r.wavBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    _sfxObjectUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    if (!_sfxAudio) {
      _sfxAudio = new Audio();
      _sfxAudio.onended = () => { _sfxPlayingId = null; if (sfxNowEl) sfxNowEl.textContent = ''; updateSfxPlayUI(); };
      _sfxAudio.onerror = () => { _setStatus('Could not play the decoded audio.', true); _sfxPlayingId = null; updateSfxPlayUI(); };
    }
    _sfxAudio.src = _sfxObjectUrl;
    _sfxPlayingId = soundId;
    await _sfxAudio.play();
    const khz = r.sampleRate ? (r.sampleRate / 1000).toFixed(1) + 'kHz' : '';
    const ch = r.channels === 2 ? 'stereo' : r.channels === 1 ? 'mono' : '';
    if (sfxNowEl) sfxNowEl.textContent = [_sfxLabel(soundId), r.format, khz, ch].filter(Boolean).join(' · ');
    _setStatus(`Playing ${_sfxLabel(soundId)} (${r.format}).`);
  } catch (e) {
    if (myReq !== _sfxReq) return;   // stop/replace already moved on — swallow its error
    if (sfxNowEl) sfxNowEl.textContent = '';
    _showErrorBanner(`Play sound failed: ${e.message}`);
    _setStatus(`Play sound failed: ${e.message}`, true);
  } finally {
    if (myReq === _sfxReq) { _sfxLoading = false; updateSfxPlayUI(); }
  }
}

// Whether Stop Sound should be enabled in a context menu (playing or decoding).
export function isSfxStoppable() { return _sfxPlayingId != null || _sfxLoading; }

export function updateSfxPlayUI() {
  const p = _selectedSound();
  const playing = _sfxPlayingId != null && _sfxAudio && !_sfxAudio.paused;
  if (sfxPlayBtn) {
    sfxPlayBtn.disabled = _sfxLoading || !p;
    sfxPlayBtn.title = p ? `Play "${p.name}" (decodes its .spw)` : 'Select a sound to play it';
  }
  if (sfxStopBtn) sfxStopBtn.disabled = !(playing || _sfxLoading);
}
