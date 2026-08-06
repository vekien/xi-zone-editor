// undo-redo.js — command history for the level editor
// init(deps) must be called before any other export is used.

const history = [];
let histIndex = -1; // index of the last applied command

let _undoBtn = null;
let _redoBtn = null;
let _onStateChange = null; // () => void  called after every history mutation
let _deletedEntries = null;
let _addedEntries = null;
let _getLimit = () => 100;

export function initUndoRedo({ undoBtn, redoBtn, onStateChange, deletedEntries, addedEntries, getLimit }) {
  _undoBtn = undoBtn;
  _redoBtn = redoBtn;
  _onStateChange = onStateChange;
  _deletedEntries = deletedEntries;
  _addedEntries = addedEntries;
  if (getLimit) _getLimit = getLimit;
}

export function pushCommand(cmd) {
  history.length = histIndex + 1; // drop any redo-future
  history.push(cmd); histIndex++;
  pruneHistoryToLimit();
  updateHistoryButtons(); if (_onStateChange) _onStateChange();
}

function historyLimit() {
  const n = Math.floor(Number(_getLimit()));
  return Number.isFinite(n) ? Math.max(0, n) : 100;
}

function pruneHistoryToLimit() {
  const overflow = history.length - historyLimit();
  if (overflow <= 0) return false;
  history.splice(0, overflow);
  histIndex = Math.max(-1, histIndex - overflow);
  return true;
}

export function enforceHistoryLimit(notify = true) {
  if (!pruneHistoryToLimit()) return;
  updateHistoryButtons();
  if (notify && _onStateChange) _onStateChange();
}

export function undo() {
  if (histIndex < 0) return;
  history[histIndex].undo(); histIndex--;
  updateHistoryButtons(); if (_onStateChange) _onStateChange();
}

export function redo() {
  if (histIndex >= history.length - 1) return;
  histIndex++;
  history[histIndex].redo();
  updateHistoryButtons(); if (_onStateChange) _onStateChange();
}

export function clearHistory() {
  clearUndoHistory(false);
  if (_deletedEntries) _deletedEntries.clear();
  if (_addedEntries) _addedEntries.clear();
  if (_onStateChange) _onStateChange();
}

export function clearUndoHistory(notify = true) {
  history.length = 0; histIndex = -1;
  updateHistoryButtons();
  if (notify && _onStateChange) _onStateChange();
}

export function updateHistoryButtons() {
  if (_undoBtn) _undoBtn.disabled = histIndex < 0;
  if (_redoBtn) _redoBtn.disabled = histIndex >= history.length - 1;
}
