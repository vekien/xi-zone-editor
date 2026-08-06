// Audio helper — tries local .wav exports first before falling back to bridge decode.
// Checking D:\xi-tools\exports\audio\music\sound\{musicId}.wav first is faster than
// decoding from DAT, and allows pre-exported audio to be used for quick auditions.

import { bridgeCall, exportsUrl } from './bridge.js';

// Try to load a music file: first checks for a .wav export, then falls back to bridge decode.
// Returns { ok: true, wavBase64, duration?, ... } on success, or throws on failure.
export async function decodeBgmWithExportFallback(musicId) {
  const wavUrl = exportsUrl(`audio/music/sound/${musicId}.wav`);

  // Try the exported .wav first.
  try {
    const resp = await fetch(wavUrl, { cache: 'no-store' });
    if (resp.ok) {
      const arrayBuffer = await resp.arrayBuffer();
      const wavBase64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
      // Extract duration from WAV header if possible (this is a simplified approach;
      // more robust parsing would read the format chunk and calculate from byte rate).
      return { ok: true, wavBase64, format: 'wav (exported)', duration: null };
    }
  } catch (e) {
    // Fetch failed (file not found, network error, etc.) — fall through to bridge.
  }

  // Fall back to the bridge decoder (DAT extract).
  const result = await bridgeCall('audio.decodeBgm', { musicId });
  return result;
}

// Same for SFX.
export async function decodeSfxWithExportFallback(soundId) {
  const wavUrl = exportsUrl(`audio/music/sound/${soundId}.wav`);

  try {
    const resp = await fetch(wavUrl, { cache: 'no-store' });
    if (resp.ok) {
      const arrayBuffer = await resp.arrayBuffer();
      const wavBase64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
      return { ok: true, wavBase64, format: 'wav (exported)', duration: null };
    }
  } catch (e) {
    // Fall through to bridge.
  }

  const result = await bridgeCall('audio.decodeSfx', { soundId });
  return result;
}
