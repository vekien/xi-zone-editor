// backend-log.js — floating backend-log console popup for the level editor
// Streams a bridge op's stdout/stderr into a floating window in real time.
// No init() needed — pure DOM, no external state dependencies.

// ── Live backend-log console popup ──────────────────────────────────────────
// Returns { log, text, onStop, done } to drive the popup. A combined std+HD
// publish runs the two legs sequentially into this one pane, each under its own
// "━━ Publish: … ━━" section header (see applyToGame in main.js).
export function openConsole(title) {
  let el = document.getElementById('console-modal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'console-modal';
    el.className = 'console-modal';
    el.innerHTML =
      '<div class="cm-head"><span class="cm-title"></span>' +
      '<button class="cm-stop" title="Stop this operation"><span class="material-symbols-outlined">stop_circle</span></button>' +
      '<button class="cm-copy" title="Copy full log to clipboard"><span class="material-symbols-outlined">folder_copy</span></button>' +
      '<button class="cm-close" title="Close"><span class="material-symbols-outlined">close</span></button></div>' +
      '<div class="cm-loading"><div class="cm-loading-bar"></div></div>' +
      '<pre class="cm-body"></pre>';
    document.body.appendChild(el);
    el.querySelector('.cm-close').onclick = () => { el.style.display = 'none'; };
    el.querySelector('.cm-copy').onclick = () => {
      try { navigator.clipboard.writeText(el.querySelector('.cm-body').textContent); } catch {}
    };
  }
  el.querySelector('.cm-title').textContent = title || 'Backend log';
  const stopBtn = el.querySelector('.cm-stop');
  stopBtn.style.display = 'none';   // hidden until a cancellable op wires onStop()
  stopBtn.onclick = null;
  const body = el.querySelector('.cm-body');
  body.textContent = '';
  el.style.display = 'flex';
  el.classList.remove('cm-done', 'cm-fail');
  el.classList.add('cm-running');         // start the pulsing-blue progress bar
  // Colour each line by its leading [tag] — matches the CLI prefixes [debug +…s], [texture], [object].
  const tagClass = { debug: 'cm-debug', texture: 'cm-texture', object: 'cm-object' };
  const append = (line) => {
    let text = (line == null ? '' : String(line)).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (text.endsWith('\n')) text = text.slice(0, -1);
    for (const piece of text.split('\n')) {
      const span = document.createElement('span');
      const m = /^\s*\[([a-z]+)/.exec(piece);
      if (m && tagClass[m[1]]) span.className = tagClass[m[1]];
      span.textContent = piece + '\n';
      body.appendChild(span);
    }
    body.scrollTop = body.scrollHeight;   // follow the tail
  };
  return {
    log: append,
    text: () => body.textContent,                  // full accumulated log (for saving to version history)
    // Show the Stop button and wire its click. Pass null to hide it again (e.g. once the
    // op moves past the point it can be cancelled). The handler owns the confirm prompt.
    onStop: (handler) => {
      stopBtn.style.display = handler ? '' : 'none';
      stopBtn.onclick = handler || null;
    },
    done: (summary, ok = true) => {
      el.classList.remove('cm-running');           // stop the pulse
      el.classList.add(ok ? 'cm-done' : 'cm-fail'); // solid green (or red on failure)
      stopBtn.style.display = 'none';              // op finished — nothing left to stop
      stopBtn.onclick = null;
      if (summary) append('\n' + summary);
    },
  };
}

// Hide the backend-log popup (e.g. on zone change — its output is for the old zone).
export function closeConsole() {
  const el = document.getElementById('console-modal');
  if (el) el.style.display = 'none';
}
