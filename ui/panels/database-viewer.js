// database-viewer.js — DB viewer side panel for the level editor
// Call initDatabaseViewer(deps) once after the DOM is ready.

let _bridgeCall = null;
let _bridgeOnline = null;
let _loadSetting = null;
let _saveSetting = null;
let _toggleModal = null;
let _xi_alert = null;
let _xi_confirm = null;
let _refreshPlayerMarker = null;

export function initDatabaseViewer({
  bridgeCall, bridgeOnline, loadSetting, saveSetting,
  toggleModal, xi_alert, xi_confirm, refreshPlayerMarker,
}) {
  _bridgeCall = bridgeCall;
  _bridgeOnline = bridgeOnline;
  _loadSetting = loadSetting;
  _saveSetting = saveSetting;
  _toggleModal = toggleModal;
  _xi_alert = xi_alert;
  _xi_confirm = xi_confirm;
  _refreshPlayerMarker = refreshPlayerMarker;

  _init();
}

function _init() {
  const databaseBtn   = document.getElementById('database-btn');
  const databasePanel = document.getElementById('database-panel');
  const dbTablesList  = document.getElementById('db-tables-list');
  const dbGrid        = document.getElementById('db-grid');
  const dbStatusBar   = document.getElementById('db-statusbar');
  const dbStatusText  = document.getElementById('db-status-text');
  const dbPrevBtn     = document.getElementById('db-prev');
  const dbNextBtn     = document.getElementById('db-next');
  const dbLastBtn     = document.getElementById('db-last');
  const dbCtxMenu     = document.getElementById('db-ctx-menu');
  const dbCtxEditBtn  = document.getElementById('db-ctx-edit');
  const dbEditOverlay = document.getElementById('db-edit-overlay');
  const dbEditTitle   = document.getElementById('db-edit-title');
  const dbEditFields  = document.getElementById('db-edit-fields');
  const dbEditSaveBtn = document.getElementById('db-edit-save');
  const dbEditCancelBtn = document.getElementById('db-edit-cancel');
  const dbEditCloseBtn  = document.getElementById('db-edit-close');
  const dbTableSearch = document.getElementById('db-table-search');

  let dbPage      = 0;
  let dbTotal     = 0;
  let dbPageSize  = 50;
  let dbTable     = '';
  let dbCurrentColumns     = [];
  let dbCurrentRows        = [];
  let dbCurrentPrimaryKeys = [];
  let dbEditPk             = {};

  function dbUpdatePager() {
    const lastPage = dbTotal > 0 ? Math.ceil(dbTotal / dbPageSize) - 1 : 0;
    const from = dbTotal === 0 ? 0 : dbPage * dbPageSize + 1;
    const to   = Math.min((dbPage + 1) * dbPageSize, dbTotal);
    dbStatusText.textContent = dbTotal > 0
      ? `${from}–${to} of ${dbTotal.toLocaleString()}`
      : '0 rows';
    if (dbPrevBtn) dbPrevBtn.disabled = dbPage <= 0;
    if (dbNextBtn) dbNextBtn.disabled = to >= dbTotal;
    if (dbLastBtn) dbLastBtn.disabled = dbPage >= lastPage || dbTotal === 0;
  }

  // Persist user-resized panel dimensions.
  const dbSavedW = _loadSetting('dbPanelW', '');
  const dbSavedH = _loadSetting('dbPanelH', '');
  if (dbSavedW) databasePanel.style.width  = dbSavedW;
  if (dbSavedH) databasePanel.style.height = dbSavedH;
  new ResizeObserver(() => {
    if (databasePanel.offsetWidth > 0) {
      _saveSetting('dbPanelW', databasePanel.offsetWidth  + 'px');
      _saveSetting('dbPanelH', databasePanel.offsetHeight + 'px');
    }
  }).observe(databasePanel);

  function dbCreds() {
    return {
      host:     _loadSetting('db.host',     '127.0.0.1'),
      port:     parseInt(_loadSetting('db.port', '3306'), 10),
      user:     _loadSetting('db.user',     'root'),
      password: _loadSetting('db.password', 'xi'),
      database: _loadSetting('db.database', 'tpzdb'),
    };
  }

  function dbEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  async function dbLoadTables() {
    dbTablesList.innerHTML = '<div class="db-msg">Loading…</div>';
    dbGrid.innerHTML = '<div class="db-msg">Select a table</div>';
    dbTotal = 0; dbPage = 0; dbTable = '';
    dbUpdatePager();
    if (dbTableSearch) dbTableSearch.value = '';
    if (!_bridgeOnline()) {
      dbTablesList.innerHTML = '<div class="db-msg">Bridge offline — run via `xi gui zone`</div>';
      return;
    }
    try {
      const r = await _bridgeCall('db.tables', dbCreds());
      if (!r?.tables?.length) {
        dbTablesList.innerHTML = '<div class="db-msg">No tables found</div>';
        return;
      }
      dbTablesList.innerHTML = r.tables
        .map((t) => `<button class="db-table-item" data-table="${dbEsc(t)}">${dbEsc(t)}</button>`)
        .join('');
      for (const btn of dbTablesList.querySelectorAll('.db-table-item')) {
        btn.addEventListener('click', () => dbQueryTable(btn.dataset.table, btn));
      }
    } catch (e) {
      dbTablesList.innerHTML = `<div class="db-msg">Error: ${dbEsc(e.message)}</div>`;
    }
  }

  async function dbQueryTable(table, btn, page = 0) {
    if (btn) {
      for (const b of dbTablesList.querySelectorAll('.db-table-item')) b.classList.remove('active');
      btn.classList.add('active');
      dbTable = table;
    }
    dbPage = page;
    dbGrid.innerHTML = '<div class="db-msg">Loading…</div>';
    try {
      const offset = dbPage * dbPageSize;
      const r = await _bridgeCall('db.query', { ...dbCreds(), table: dbTable, limit: dbPageSize, offset });
      dbTotal = r?.total ?? 0;
      dbCurrentColumns     = r?.columns     ?? [];
      dbCurrentRows        = r?.rows        ?? [];
      dbCurrentPrimaryKeys = r?.primary_keys ?? [];
      if (!dbCurrentColumns.length) {
        dbGrid.innerHTML = '<div class="db-msg">No data</div>';
        dbTotal = 0; dbUpdatePager();
        return;
      }
      let html = '<table><thead><tr>' +
        dbCurrentColumns.map((c) => `<th>${dbEsc(c)}</th>`).join('') +
        '</tr></thead><tbody>';
      dbCurrentRows.forEach((row, idx) => {
        html += `<tr data-row-idx="${idx}">` + row.map((v) =>
          v === null
            ? '<td class="db-null">NULL</td>'
            : `<td title="${dbEsc(v)}">${dbEsc(v)}</td>`
        ).join('') + '</tr>';
      });
      html += '</tbody></table>';
      dbGrid.innerHTML = html;
      dbUpdatePager();
    } catch (e) {
      dbGrid.innerHTML = `<div class="db-msg">Error: ${dbEsc(e.message)}</div>`;
    }
  }

  dbPrevBtn?.addEventListener('click', () => dbQueryTable(dbTable, null, dbPage - 1));
  dbNextBtn?.addEventListener('click', () => dbQueryTable(dbTable, null, dbPage + 1));
  dbLastBtn?.addEventListener('click', () => dbQueryTable(dbTable, null, Math.ceil(dbTotal / dbPageSize) - 1));

  // ── Raw SQL query bar ────────────────────────────────────────────────────
  const dbQueryInput = document.getElementById('db-query-input');
  const dbQueryRun   = document.getElementById('db-query-run');

  async function dbRunQuery() {
    const sql = dbQueryInput?.value.trim();
    if (!sql || !_bridgeOnline()) return;
    dbGrid.innerHTML = '<div class="db-msg">Running…</div>';
    dbCurrentColumns = []; dbCurrentRows = []; dbCurrentPrimaryKeys = [];
    dbTotal = 0; dbPage = 0;
    dbUpdatePager();
    dbQueryRun.disabled = true;
    try {
      const r = await _bridgeCall('db.exec', { ...dbCreds(), sql });
      dbCurrentColumns     = r?.columns      ?? [];
      dbCurrentRows        = r?.rows         ?? [];
      dbCurrentPrimaryKeys = [];

      if (r?.affected !== undefined) {
        dbGrid.innerHTML = `<div class="db-msg">${r.affected.toLocaleString()} row(s) affected</div>`;
        dbStatusText.textContent = `${r.affected.toLocaleString()} affected`;
        return;
      }

      if (!dbCurrentColumns.length) {
        dbGrid.innerHTML = '<div class="db-msg">No results</div>';
        dbStatusText.textContent = '0 rows';
        return;
      }

      let html = '<table><thead><tr>' +
        dbCurrentColumns.map((c) => `<th>${dbEsc(c)}</th>`).join('') +
        '</tr></thead><tbody>';
      dbCurrentRows.forEach((row, idx) => {
        html += `<tr data-row-idx="${idx}">` + row.map((v) =>
          v === null ? '<td class="db-null">NULL</td>' : `<td title="${dbEsc(v)}">${dbEsc(v)}</td>`
        ).join('') + '</tr>';
      });
      html += '</tbody></table>';
      dbGrid.innerHTML = html;

      const truncated = r?.truncated;
      dbTotal = dbCurrentRows.length;
      dbStatusText.textContent = `${dbTotal.toLocaleString()} row(s)${truncated ? ' — truncated' : ''}`;
      if (dbPrevBtn) dbPrevBtn.disabled = true;
      if (dbNextBtn) dbNextBtn.disabled = true;
      if (dbLastBtn) dbLastBtn.disabled = true;
    } catch (e) {
      dbGrid.innerHTML = `<div class="db-error">Error: ${dbEsc(e.message)}</div>`;
    } finally {
      dbQueryRun.disabled = false;
    }
  }

  dbQueryRun?.addEventListener('click', dbRunQuery);

  const dbTableRefresh = document.getElementById('db-table-refresh');
  dbTableRefresh?.addEventListener('click', () => {
    if (dbTable) dbQueryTable(dbTable, null, dbPage);
  });

  dbQueryInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); dbRunQuery(); }
  });

  // ── Set Spawn Point ─────────────────────────────────────────────────────
  const dbSpawnBtn = document.getElementById('db-set-spawn');
  async function dbSetSpawn() {
    if (!_bridgeOnline()) return;
    const id = parseInt(document.getElementById('db-spawn-id')?.value, 10);
    if (!Number.isFinite(id)) {
      dbStatusText.textContent = 'Spawn: invalid character ID';
      return;
    }
    const x = parseFloat(document.getElementById('db-spawn-x')?.value) || 0;
    const z = parseFloat(document.getElementById('db-spawn-z')?.value) || 0;
    const y = parseFloat(document.getElementById('db-spawn-y')?.value) || 0;
    dbSpawnBtn.disabled = true;
    dbCurrentColumns = []; dbCurrentRows = []; dbCurrentPrimaryKeys = [];
    dbTotal = 0; dbPage = 0; dbUpdatePager();
    dbGrid.innerHTML = '<div class="db-msg">Setting spawn…</div>';
    try {
      const r = await _bridgeCall('db.update', {
        ...dbCreds(),
        table: 'chars',
        pk: { charid: id },
        updates: { pos_x: x, pos_y: y, pos_z: z },
      });
      const matched  = r?.matched  ?? 0;
      const affected = r?.affected ?? 0;
      const sql = r?.sql || `UPDATE chars SET pos_x = ${x}, pos_y = ${y}, pos_z = ${z} WHERE charid = ${id} LIMIT 1`;
      let result;
      if (!matched)      result = `No char with charid ${id}`;
      else if (affected) result = `OK — char ${id} moved to x ${x}, z ${z}, y ${y}`;
      else               result = `OK — char ${id} already at x ${x}, z ${z}, y ${y} (no change)`;
      dbGrid.innerHTML =
        '<table><thead><tr><th>SQL</th><th>Results</th></tr></thead><tbody>' +
        `<tr><td title="${dbEsc(sql)}">${dbEsc(sql)}</td><td title="${dbEsc(result)}">${dbEsc(result)}</td></tr>` +
        '</tbody></table>';
      dbStatusText.textContent = matched ? 'Spawn set' : 'Char not found';
      if (matched) _refreshPlayerMarker();   // position changed → move the PLAYER overlay
    } catch (e) {
      dbGrid.innerHTML = `<div class="db-error">Error: ${dbEsc(e.message)}</div>`;
      dbStatusText.textContent = 'Spawn error';
    } finally {
      dbSpawnBtn.disabled = false;
    }
  }
  dbSpawnBtn?.addEventListener('click', dbSetSpawn);

  // ── Force Offline (clear login session after a crash) ────────────────────
  const dbForceBtn = document.getElementById('db-force-offline');
  async function dbForceOffline() {
    if (!_bridgeOnline()) return;
    const id = parseInt(document.getElementById('db-spawn-id')?.value, 10);
    if (!Number.isFinite(id)) {
      dbStatusText.textContent = 'Force offline: invalid character ID';
      return;
    }
    dbForceBtn.disabled = true;
    dbCurrentColumns = []; dbCurrentRows = []; dbCurrentPrimaryKeys = [];
    dbTotal = 0; dbPage = 0; dbUpdatePager();
    dbGrid.innerHTML = '<div class="db-msg">Forcing offline…</div>';
    const sql = `DELETE FROM accounts_sessions WHERE charid = ${id}`;
    try {
      const r = await _bridgeCall('db.exec', { ...dbCreds(), sql });
      const n = r?.affected ?? 0;
      const result = n
        ? `OK — cleared ${n} session(s) for char ${id}. You can log back in.`
        : `No active session for char ${id} (already offline).`;
      dbGrid.innerHTML =
        '<table><thead><tr><th>SQL</th><th>Results</th></tr></thead><tbody>' +
        `<tr><td title="${dbEsc(sql)}">${dbEsc(sql)}</td><td title="${dbEsc(result)}">${dbEsc(result)}</td></tr>` +
        '</tbody></table>';
      dbStatusText.textContent = n ? 'Forced offline' : 'No session';
    } catch (e) {
      dbGrid.innerHTML = `<div class="db-error">Error: ${dbEsc(e.message)}</div>`;
      dbStatusText.textContent = 'Force offline error';
    } finally {
      dbForceBtn.disabled = false;
    }
  }
  dbForceBtn?.addEventListener('click', dbForceOffline);

  // ── Reset Spawn (warp a stuck char to a safe spot in Southern San d'Oria) ──
  // Coordinates = Southern San d'Oria Home Point #1 (verified safe ground), zone 230.
  const SAFE_SPAWN = { zone: 230, x: -85.554, y: 1, z: -64.554, rot: 45, label: "Southern San d'Oria (Home Point #1)" };
  const dbResetBtn = document.getElementById('db-reset-spawn');
  async function dbResetSpawn() {
    if (!_bridgeOnline()) return;
    const id = parseInt(document.getElementById('db-spawn-id')?.value, 10);
    if (!Number.isFinite(id)) {
      dbStatusText.textContent = 'Reset spawn: invalid character ID';
      return;
    }
    const ok = await _xi_confirm(
      'Reset Spawn',
      `Move character ${id} to a safe spot in ${SAFE_SPAWN.label}?\n\n` +
      `This sets their zone to Southern San d'Oria (230) and position to x ${SAFE_SPAWN.x}, ` +
      `y ${SAFE_SPAWN.y}, z ${SAFE_SPAWN.z}. It takes effect on next login — make sure the ` +
      `character is logged out first (use Force Offline if they're stuck online).`,
      'Reset Spawn');
    if (!ok) return;
    dbResetBtn.disabled = true;
    dbCurrentColumns = []; dbCurrentRows = []; dbCurrentPrimaryKeys = [];
    dbTotal = 0; dbPage = 0; dbUpdatePager();
    dbGrid.innerHTML = '<div class="db-msg">Resetting spawn…</div>';
    try {
      const r = await _bridgeCall('db.update', {
        ...dbCreds(),
        table: 'chars',
        pk: { charid: id },
        updates: { pos_zone: SAFE_SPAWN.zone, pos_rot: SAFE_SPAWN.rot,
                   pos_x: SAFE_SPAWN.x, pos_y: SAFE_SPAWN.y, pos_z: SAFE_SPAWN.z, moghouse: 0 },
      });
      const matched  = r?.matched  ?? 0;
      const affected = r?.affected ?? 0;
      const sql = r?.sql || `UPDATE chars SET pos_zone = ${SAFE_SPAWN.zone}, pos_rot = ${SAFE_SPAWN.rot}, pos_x = ${SAFE_SPAWN.x}, pos_y = ${SAFE_SPAWN.y}, pos_z = ${SAFE_SPAWN.z}, moghouse = 0 WHERE charid = ${id} LIMIT 1`;
      let result;
      if (!matched)      result = `No char with charid ${id}`;
      else if (affected) result = `OK — char ${id} reset to ${SAFE_SPAWN.label}. Log in to appear there.`;
      else               result = `OK — char ${id} already at the safe spot (no change).`;
      dbGrid.innerHTML =
        '<table><thead><tr><th>SQL</th><th>Results</th></tr></thead><tbody>' +
        `<tr><td title="${dbEsc(sql)}">${dbEsc(sql)}</td><td title="${dbEsc(result)}">${dbEsc(result)}</td></tr>` +
        '</tbody></table>';
      dbStatusText.textContent = matched ? 'Spawn reset' : 'Char not found';
      if (matched) _refreshPlayerMarker();   // position changed → move the PLAYER overlay
    } catch (e) {
      dbGrid.innerHTML = `<div class="db-error">Error: ${dbEsc(e.message)}</div>`;
      dbStatusText.textContent = 'Reset spawn error';
    } finally {
      dbResetBtn.disabled = false;
    }
  }
  dbResetBtn?.addEventListener('click', dbResetSpawn);

  // ── Context menu ──────────────────────────────────────────────────────────
  dbGrid.addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('tbody tr');
    if (!tr || !dbCurrentColumns.length) return;
    e.preventDefault();
    const idx = parseInt(tr.dataset.rowIdx, 10);
    if (isNaN(idx)) return;
    // Position menu; clamp so it doesn't go off-screen
    dbCtxMenu.style.display = '';
    const mx = Math.min(e.pageX, window.innerWidth  - dbCtxMenu.offsetWidth  - 8);
    const my = Math.min(e.pageY, window.innerHeight - dbCtxMenu.offsetHeight - 8);
    dbCtxMenu.style.left = mx + 'px';
    dbCtxMenu.style.top  = my + 'px';
    dbCtxMenu.dataset.rowIdx = idx;
  });

  document.addEventListener('click', () => { if (dbCtxMenu) dbCtxMenu.style.display = 'none'; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dbCtxMenu.style.display = 'none'; });

  dbCtxEditBtn?.addEventListener('click', () => {
    const idx = parseInt(dbCtxMenu.dataset.rowIdx, 10);
    dbCtxMenu.style.display = 'none';
    if (!isNaN(idx)) dbOpenEditForm(idx);
  });

  // ── Edit form ─────────────────────────────────────────────────────────────
  function dbOpenEditForm(rowIdx) {
    const row = dbCurrentRows[rowIdx];
    if (!row) return;
    if (dbEditTitle) dbEditTitle.textContent = `Edit — ${dbTable}`;
    dbEditFields.innerHTML = '';

    // Build PK map from original values (used for WHERE in UPDATE)
    dbEditPk = {};
    if (dbCurrentPrimaryKeys.length > 0) {
      for (const pkCol of dbCurrentPrimaryKeys) {
        const ci = dbCurrentColumns.indexOf(pkCol);
        if (ci >= 0) dbEditPk[pkCol] = row[ci]; // null or string
      }
    } else {
      // No PK known — use all columns for WHERE
      dbCurrentColumns.forEach((col, ci) => { dbEditPk[col] = row[ci]; });
    }

    for (let i = 0; i < dbCurrentColumns.length; i++) {
      const col = dbCurrentColumns[i];
      const val = row[i];
      const isPk = dbCurrentPrimaryKeys.includes(col);
      const div = document.createElement('div');
      div.className = 'db-edit-field';
      const label = document.createElement('label');
      label.className = 'db-edit-label' + (isPk ? ' db-edit-pk' : '');
      label.textContent = col + (isPk ? ' ↑' : '');
      label.title = isPk ? col + ' (primary key)' : col;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'db-edit-input';
      input.dataset.col    = col;
      input.dataset.isNull = val === null ? '1' : '0';
      input.dataset.original = val ?? '';
      if (val !== null) input.value = val;
      else input.placeholder = 'NULL';
      div.appendChild(label);
      div.appendChild(input);
      dbEditFields.appendChild(div);
    }
    dbEditOverlay.style.display = '';
    // Focus first non-PK input
    const firstEditable = dbEditFields.querySelector(
      `.db-edit-input:not([data-col="${dbCurrentPrimaryKeys[0]}"])`
    ) ?? dbEditFields.querySelector('.db-edit-input');
    firstEditable?.focus();
  }

  function dbCloseEditForm() {
    if (dbEditOverlay) dbEditOverlay.style.display = 'none';
    dbEditPk = {};
  }

  dbEditCancelBtn?.addEventListener('click', dbCloseEditForm);
  dbEditCloseBtn?.addEventListener('click',  dbCloseEditForm);

  dbEditSaveBtn?.addEventListener('click', async () => {
    const inputs = dbEditFields.querySelectorAll('.db-edit-input');
    const updates = {};
    for (const inp of inputs) {
      const col     = inp.dataset.col;
      const wasNull = inp.dataset.isNull === '1';
      const newVal  = (inp.value === '' && wasNull) ? null : inp.value;
      // Only send columns the user actually edited. Re-writing untouched cells
      // corrupts blob columns (e.g. zone_weather.weather), whose value is shown
      // as an unrenderable byte-repr string that overflows the column on save.
      const changed = wasNull ? (newVal !== null) : (inp.value !== inp.dataset.original);
      if (!changed) continue;
      updates[col] = newVal;
    }
    if (Object.keys(updates).length === 0) { dbCloseEditForm(); return; }
    dbEditSaveBtn.disabled = true;
    dbEditSaveBtn.textContent = 'Saving…';
    try {
      await _bridgeCall('db.update', { ...dbCreds(), table: dbTable, pk: dbEditPk, updates });
      dbCloseEditForm();
      dbQueryTable(dbTable, null, dbPage);
    } catch (e) {
      await _xi_alert('Save Failed', e.message);
    } finally {
      dbEditSaveBtn.disabled = false;
      dbEditSaveBtn.textContent = 'Save';
    }
  });

  dbTableSearch?.addEventListener('input', () => {
    const q = dbTableSearch.value.trim().toLowerCase();
    for (const btn of dbTablesList.querySelectorAll('.db-table-item')) {
      btn.style.display = (!q || btn.dataset.table.toLowerCase().includes(q)) ? '' : 'none';
    }
  });

  if (databaseBtn) databaseBtn.onclick = () => {
    // Clear any oversized saved dimensions on first open after a resize reset.
    _toggleModal(databasePanel, databaseBtn);
    if (databasePanel?.classList.contains('open')) dbLoadTables();
  };
}
