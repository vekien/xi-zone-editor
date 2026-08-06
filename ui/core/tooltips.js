// ── core/tooltips.js ──────────────────────────────────────────────────────────
// Lightweight, instant, theme-styled tooltips — a native replacement for the
// browser's slow (~1s) native title bubble. No dependencies.
//
// It works app-wide by HIJACKING existing `title="…"` attributes: on hover it
// stashes the title into `data-tip`, strips the attribute (killing the native
// bubble), and shows a styled tooltip near the element (clamped on-screen).
// So every element that already has a title gets a nice tooltip for free — and
// code that later re-assigns `.title` (dynamic labels) is picked up on next hover.
//
// Call initTooltips() once at startup. Opt an element out with `data-no-tip`.

let _tipEl = null;
let _shownFor = null;      // element whose tooltip is currently visible
let _pending = null;       // { node, text } waiting on the show-delay
let _timer = null;
let _delay = 60;           // ms before showing — imperceptible, avoids flicker on mouse transit

function _ensureEl() {
  if (_tipEl) return _tipEl;
  _tipEl = document.createElement('div');
  _tipEl.className = 'app-tooltip';
  _tipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(_tipEl);
  return _tipEl;
}

// Find the nearest ancestor carrying a tooltip; migrate a live `title` into
// `data-tip` (so the native bubble never fires) and return its text.
function _resolve(target) {
  let n = target;
  while (n && n.nodeType === 1 && n !== document.body) {
    if (n.hasAttribute && n.hasAttribute('data-no-tip')) return null;
    if (n.getAttribute) {
      const live = n.getAttribute('title');
      if (live != null && live !== '') { n.dataset.tip = live; n.removeAttribute('title'); }
      const text = n.dataset ? n.dataset.tip : null;
      if (text) return { node: n, text };
    }
    n = n.parentElement;
  }
  return null;
}

function _position(node) {
  const el = _tipEl;
  const r = node.getBoundingClientRect();
  const gap = 8;
  // Measure with left/top reset so offsetWidth/Height are accurate.
  el.style.left = '-9999px';
  el.style.top = '0px';
  const tw = el.offsetWidth, th = el.offsetHeight;
  let below = false;
  let top = r.top - th - gap;                 // prefer above
  if (top < 4) { top = r.bottom + gap; below = true; }   // flip below if no headroom
  let left = r.left + r.width / 2 - tw / 2;    // centre on the anchor
  left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));   // clamp to viewport
  el.style.left = Math.round(left) + 'px';
  el.style.top = Math.round(top) + 'px';
  el.classList.toggle('below', below);
}

function _show(node, text) {
  const el = _ensureEl();
  el.textContent = text;
  _position(node);
  el.classList.add('show');
  _shownFor = node;
}

function _hide() {
  clearTimeout(_timer); _timer = null; _pending = null;
  if (_tipEl) _tipEl.classList.remove('show');
  _shownFor = null;
}

function _onOver(e) {
  const hit = _resolve(e.target);
  if (!hit) return;                       // nothing tip-worthy in the ancestry
  if (hit.node === _shownFor) return;     // already showing this one
  clearTimeout(_timer);
  _pending = hit;
  _timer = setTimeout(() => {
    if (_pending) { _show(_pending.node, _pending.text); _pending = null; }
  }, _delay);
}

function _onOut(e) {
  const node = (_pending && _pending.node) || _shownFor;
  // Still inside the anchored element (moved onto a child)? keep it.
  if (node && node.contains && node.contains(e.relatedTarget)) return;
  if (node) _hide();
}

export function initTooltips(opts = {}) {
  if (typeof opts.delay === 'number') _delay = opts.delay;
  document.addEventListener('mouseover', _onOver, true);
  document.addEventListener('mouseout', _onOut, true);
  // Never let a tooltip linger through interaction / navigation.
  document.addEventListener('mousedown', _hide, true);
  document.addEventListener('wheel', _hide, true);
  window.addEventListener('scroll', _hide, true);
  document.addEventListener('keydown', _hide, true);
  window.addEventListener('blur', _hide);
}
